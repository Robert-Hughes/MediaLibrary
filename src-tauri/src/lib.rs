mod scanner;
mod thumbnail_queue;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use thumbnail_queue::ThumbnailQueue;

// ── Shared state ──────────────────────────────────────────────────────────────

struct ScanState(Mutex<bool>);
struct ActiveQueue(Arc<Mutex<Option<Arc<ThumbnailQueue>>>>);

// ── Event payloads ────────────────────────────────────────────────────────────

/// Emitted once per file as the directory walk finds it.
#[derive(Clone, Serialize)]
struct PhotoFoundPayload {
    photo: scanner::PhotoInfo,
}

/// Emitted when the directory walk is complete (no payload needed).
#[derive(Clone, Serialize)]
struct ScanCompletePayload {}

#[derive(Clone, Serialize)]
struct ScanErrorPayload {
    message: String,
}

/// Emitted per file when EXIF metadata has been read.
#[derive(Clone, Serialize)]
struct MetadataReadyPayload {
    relative_path: String,
    date_taken: Option<String>,
    camera_model: Option<String>,
}

#[derive(Clone, Serialize)]
struct ThumbnailReadyPayload {
    relative_path: String,
    thumbnail: String,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

/// Start a background scan of `folder_path`.
///
/// Three concurrent phases, all starting as soon as files are discovered:
///
///  Phase 1 — streaming file discovery (single thread):
///    Walks the directory tree. For each image file found, emits `photo_found`
///    immediately so the frontend can add it to the list. Also feeds the file
///    into the EXIF queue and thumbnail queue right away.
///    Emits `scan_complete` (no payload) when the walk finishes.
///
///  Phase 2 — EXIF metadata (thread pool, starts alongside phase 1):
///    Reads EXIF data per file and emits `metadata_ready`.
///
///  Phase 3 — thumbnail generation (thread pool, starts alongside phase 1):
///    Generates thumbnails and emits `thumbnail_ready`.
///    Supports priority reordering via `prioritize_thumbnails`.
#[tauri::command]
async fn start_scan(
    folder_path: String,
    app: AppHandle,
    scan_state: State<'_, ScanState>,
    active_queue: State<'_, ActiveQueue>,
) -> Result<(), String> {
    {
        let mut running = scan_state.0.lock().unwrap();
        if *running {
            return Err("A scan is already in progress".into());
        }
        *running = true;
    }

    *active_queue.0.lock().unwrap() = None;

    let active_queue_arc = active_queue.0.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let root = std::path::PathBuf::from(&folder_path);

        if !root.is_dir() {
            let _ = app_clone.emit("scan_error", ScanErrorPayload {
                message: format!("{} is not a directory", folder_path),
            });
            clear_running(&app_clone);
            return;
        }

        let num_workers = std::thread::available_parallelism()
            .map(|n| n.get()).unwrap_or(4).min(8);

        // Shared queues fed by the walk, drained by worker pools.
        let thumb_queue = Arc::new(ThumbnailQueue::new(vec![]));
        let exif_queue  = Arc::new(ThumbnailQueue::new(vec![]));

        // Install the thumbnail queue so prioritize_thumbnails can reach it.
        *active_queue_arc.lock().unwrap() = Some(thumb_queue.clone());

        let root_arc = Arc::new(root.clone());

        // ── Phase 2: EXIF workers ─────────────────────────────────────────
        let exif_handles: Vec<_> = (0..num_workers).map(|_| {
            let queue = exif_queue.clone();
            let app   = app_clone.clone();
            let root  = root_arc.clone();
            std::thread::spawn(move || {
                while let Some(rel_path) = queue.pop() {
                    let abs = root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let info = scanner::read_exif(&rel_path, &abs);
                    let _ = app.emit("metadata_ready", MetadataReadyPayload {
                        relative_path: info.relative_path,
                        date_taken:    info.date_taken,
                        camera_model:  info.camera_model,
                    });
                }
            })
        }).collect();

        // ── Phase 3: thumbnail workers ────────────────────────────────────
        let thumb_handles: Vec<_> = (0..num_workers).map(|_| {
            let queue = thumb_queue.clone();
            let app   = app_clone.clone();
            let root  = root_arc.clone();
            std::thread::spawn(move || {
                while let Some(rel_path) = queue.pop() {
                    let abs = root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    if let Some(thumbnail) = scanner::thumbnail_for(&abs) {
                        let _ = app.emit("thumbnail_ready", ThumbnailReadyPayload {
                            relative_path: rel_path,
                            thumbnail,
                        });
                    }
                }
            })
        }).collect();

        // ── Phase 1: streaming directory walk ─────────────────────────────
        let app_walk = app_clone.clone();
        scanner::scan_folder(&root, |photo| {
            // Feed queues before emitting so workers can start immediately.
            exif_queue.push(photo.relative_path.clone());
            thumb_queue.push(photo.relative_path.clone());
            let _ = app_walk.emit("photo_found", PhotoFoundPayload { photo });
        });

        let _ = app_clone.emit("scan_complete", ScanCompletePayload {});

        // Signal workers that no more items are coming.
        exif_queue.finish();
        thumb_queue.finish();

        // Wait for all workers to finish.
        for h in exif_handles  { let _ = h.join(); }
        for h in thumb_handles { let _ = h.join(); }

        *active_queue_arc.lock().unwrap() = None;
        clear_running(&app_clone);
    });

    Ok(())
}

#[tauri::command]
async fn prioritize_thumbnails(
    visible_paths: Vec<String>,
    active_queue: State<'_, ActiveQueue>,
) -> Result<(), String> {
    if let Some(queue) = active_queue.0.lock().unwrap().as_ref() {
        queue.prioritize(&visible_paths);
    }
    Ok(())
}

#[tauri::command]
async fn set_window_title(title: String, app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?
        .set_title(&title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_image(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let ext = std::path::Path::new(&path)
        .extension().and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png"          => "image/png",
        "gif"          => "image/gif",
        "bmp"          => "image/bmp",
        "webp"         => "image/webp",
        "tiff" | "tif" => "image/tiff",
        _              => "image/jpeg",
    };
    Ok(format!("data:{mime};base64,{b64}"))
}

fn clear_running(app: &AppHandle) {
    if let Some(state) = app.try_state::<ScanState>() {
        *state.0.lock().unwrap() = false;
    }
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanState(Mutex::new(false)))
        .manage(ActiveQueue(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            start_scan,
            prioritize_thumbnails,
            set_window_title,
            load_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
