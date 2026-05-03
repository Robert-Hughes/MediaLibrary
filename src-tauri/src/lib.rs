mod scanner;
mod thumbnail_queue;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use thumbnail_queue::ThumbnailQueue;

// ── Shared state ─────────────────────────────────────────────────────────────

/// Tracks whether a scan is currently running so we can reject concurrent requests.
struct ScanState(Mutex<bool>);

/// The active thumbnail queue, shared between the worker threads and the
/// `prioritize_thumbnails` command. Replaced each time a new scan starts.
struct ActiveQueue(Arc<Mutex<Option<Arc<ThumbnailQueue>>>>);

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct ScanProgressPayload {
    found_so_far: usize,
}

#[derive(Clone, Serialize)]
struct ScanCompletePayload {
    photos: Vec<scanner::PhotoInfo>,
}

#[derive(Clone, Serialize)]
struct ScanErrorPayload {
    message: String,
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
/// Phase 1 — fast file discovery:
///   Emits `scan_progress` as files are found, then `scan_complete` with the
///   full list (no thumbnails).
///
/// Phase 2 — priority-queue thumbnail generation:
///   Builds a `ThumbnailQueue` from the photo list and stores it in
///   `ActiveQueue` so `prioritize_thumbnails` can reorder it at any time.
///   A fixed-size thread pool drains the queue, emitting `thumbnail_ready`
///   per photo.
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

    // Clear any queue left over from a previous scan.
    *active_queue.0.lock().unwrap() = None;

    let app_clone = app.clone();
    // Clone the Arc so the thread can install the new queue.
    let active_queue_arc = active_queue.0.clone();

    std::thread::spawn(move || {
        let root = std::path::PathBuf::from(&folder_path);

        if !root.is_dir() {
            let _ = app_clone.emit(
                "scan_error",
                ScanErrorPayload {
                    message: format!("{} is not a directory", folder_path),
                },
            );
            clear_running(&app_clone);
            return;
        }

        // ── Phase 1: fast file discovery ──────────────────────────────────

        let app_progress = app_clone.clone();
        let photos = scanner::scan_folder(&root, move |found_so_far| {
            let _ = app_progress.emit("scan_progress", ScanProgressPayload { found_so_far });
        });

        let _ = app_clone.emit("scan_complete", ScanCompletePayload { photos: photos.clone() });

        // ── Phase 2: priority-queue thumbnail generation ──────────────────

        let paths: Vec<String> = photos
            .iter()
            .map(|p| p.relative_path.clone())
            .collect();

        let queue = Arc::new(ThumbnailQueue::new(paths));

        // Install the queue so prioritize_thumbnails can reach it.
        *active_queue_arc.lock().unwrap() = Some(queue.clone());

        // Spawn one worker thread per logical CPU, capped at 8 to avoid
        // thrashing on I/O-bound thumbnail work.
        let num_workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8);

        let app_thumbs = app_clone.clone();
        let root_arc = Arc::new(root);

        let handles: Vec<_> = (0..num_workers)
            .map(|_| {
                let queue = queue.clone();
                let app = app_thumbs.clone();
                let root = root_arc.clone();

                std::thread::spawn(move || {
                    while let Some(rel_path) = queue.pop() {
                        let abs_path = root.join(
                            rel_path.replace('/', std::path::MAIN_SEPARATOR_STR),
                        );
                        if let Some(thumbnail) = scanner::thumbnail_for(&abs_path) {
                            let _ = app.emit(
                                "thumbnail_ready",
                                ThumbnailReadyPayload {
                                    relative_path: rel_path,
                                    thumbnail,
                                },
                            );
                        }
                    }
                })
            })
            .collect();

        for h in handles {
            let _ = h.join();
        }

        // All thumbnails done — clear the queue reference and release the lock.
        *active_queue_arc.lock().unwrap() = None;
        clear_running(&app_clone);
    });

    Ok(())
}

/// Reorder the thumbnail queue so that `visible_paths` are processed next.
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

/// Set the native window title.
#[tauri::command]
async fn set_window_title(title: String, app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?
        .set_title(&title)
        .map_err(|e| e.to_string())
}

/// Read an image file and return it as a base64-encoded data URI.
/// Used by the gallery view to display full-resolution images.
#[tauri::command]
async fn load_image(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    // Detect MIME type from extension for the data URI.
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
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
