mod scanner;
mod thumbnail_queue;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use thumbnail_queue::ThumbnailQueue;

// ── Shared state ──────────────────────────────────────────────────────────────

struct ScanState {
    running:   Mutex<bool>,
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

/// Holds both the thumbnail and image metadata queues so both can be prioritised.
struct ActiveQueues {
    thumbnails:     Arc<Mutex<Option<Arc<ThumbnailQueue>>>>,
    image_metadata: Arc<Mutex<Option<Arc<ThumbnailQueue>>>>,
}
/// Monotonically increasing scan ID — incremented each time start_scan is called.
struct ScanCounter(Mutex<u64>);

// ── Event payloads ────────────────────────────────────────────────────────────

/// Emitted once per file as the directory walk finds it.
#[derive(Clone, Serialize)]
struct PhotoFoundPayload {
    scan_id: u64,
    photo: scanner::PhotoInfo,
}

/// Emitted when the directory walk is complete (no payload needed).
#[derive(Clone, Serialize)]
struct ScanCompletePayload {
    scan_id: u64,
}

#[derive(Clone, Serialize)]
struct ScanErrorPayload {
    message: String,
}

/// Emitted per file when Image metadata (EXIF etc) has been read.
#[derive(Clone, Serialize)]
struct ImageMetadataReadyPayload {
    scan_id: u64,
    relative_path: String,
    date_taken: Option<String>,
    camera_model: Option<String>,
}

#[derive(Clone, Serialize)]
struct ThumbnailReadyPayload {
    scan_id: u64,
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
///    into the image metadata queue and thumbnail queue right away.
///    Emits `scan_complete` (no payload) when the walk finishes.
///
///  Phase 2 — Image Metadata (thread pool, starts alongside phase 1):
///    Reads EXIF data per file and emits `image_metadata_ready`.
///
///  Phase 3 — thumbnail generation (thread pool, starts alongside phase 1):
///    Generates thumbnails and emits `thumbnail_ready`.
///    Supports priority reordering via `prioritize_queues`.
#[tauri::command]
fn start_scan(
    folder_path: String,
    app: AppHandle,
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
    scan_counter: State<'_, ScanCounter>,
) -> Result<u64, String> {
    {
        let mut running = scan_state.running.lock().unwrap();
        let mut attempts = 0;
        while *running && attempts < 20 {
            drop(running);
            std::thread::sleep(std::time::Duration::from_millis(50));
            running = scan_state.running.lock().unwrap();
            attempts += 1;
        }
        if *running {
            return Err("A scan is already in progress and could not be stopped".into());
        }
        *running = true;
    }

    let scan_id = {
        let mut counter = scan_counter.0.lock().unwrap();
        *counter += 1;
        *counter
    };

    let cancellation_flag = Arc::new(AtomicBool::new(false));
    *scan_state.cancelled.lock().unwrap() = Some(cancellation_flag.clone());

    // Reset queues for the new scan.
    {
        *active_queues.thumbnails.lock().unwrap() = None;
        *active_queues.image_metadata.lock().unwrap() = None;
    }

    let thumbnails_arc     = active_queues.thumbnails.clone();
    let image_metadata_arc = active_queues.image_metadata.clone();
    let app_clone          = app.clone();
    let cancel_clone       = cancellation_flag.clone();

    std::thread::spawn(move || {
        let root = std::path::PathBuf::from(&folder_path);

        if !root.is_dir() {
            let _ = app_clone.emit("scan_error", ScanErrorPayload {
                message: format!("{} is not a directory", folder_path),
            });
            clear_running(&app_clone);
            return;
        }

        // In slow-mode (MEDIA_LIBRARY_SLOW_MODE=1) use a single worker per pool
        // so the artificial per-file delays in scanner.rs are clearly visible.
        let slow_mode = std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok();
        let num_workers = if slow_mode {
            1
        } else {
            std::thread::available_parallelism()
                .map(|n| n.get()).unwrap_or(4).min(8)
        };

        // Shared queues fed by the walk, drained by worker pools.
        let thumb_queue          = Arc::new(ThumbnailQueue::new(vec![]));
        let image_metadata_queue = Arc::new(ThumbnailQueue::new(vec![]));

        // Install the queues so prioritize_queues can reach them.
        {
            *thumbnails_arc.lock().unwrap() = Some(thumb_queue.clone());
            *image_metadata_arc.lock().unwrap() = Some(image_metadata_queue.clone());
        }

        let root_arc = Arc::new(root.clone());

        // ── Phase 2: Image Metadata workers ───────────────────────────────
        let metadata_handles: Vec<_> = (0..num_workers).map(|_| {
            let queue = image_metadata_queue.clone();
            let app   = app_clone.clone();
            let root  = root_arc.clone();
            let cancelled = cancel_clone.clone();
            std::thread::spawn(move || {
                while let Some(rel_path) = queue.pop() {
                    if cancelled.load(Ordering::Relaxed) { break; }
                    let abs = root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let info = scanner::read_exif(&rel_path, &abs);
                    let _ = app.emit("image_metadata_ready", ImageMetadataReadyPayload {
                        scan_id,
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
            let cancelled = cancel_clone.clone();
            std::thread::spawn(move || {
                while let Some(rel_path) = queue.pop() {
                    if cancelled.load(Ordering::Relaxed) { break; }
                    let abs = root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    if let Some(thumbnail) = scanner::thumbnail_for(&abs) {
                        let _ = app.emit("thumbnail_ready", ThumbnailReadyPayload {
                            scan_id,
                            relative_path: rel_path,
                            thumbnail,
                        });
                    }
                }
            })
        }).collect();

        // ── Phase 1: streaming directory walk ─────────────────────────────
        let app_walk = app_clone.clone();
        scanner::scan_folder(&root, cancel_clone, |photo| {
            image_metadata_queue.push(photo.relative_path.clone());
            thumb_queue.push(photo.relative_path.clone());
            let _ = app_walk.emit("photo_found", PhotoFoundPayload { scan_id, photo });
        });

        let _ = app_clone.emit("scan_complete", ScanCompletePayload { scan_id });

        // Signal workers that no more items are coming.
        image_metadata_queue.finish();
        thumb_queue.finish();

        // Wait for all workers to finish.
        for h in metadata_handles { let _ = h.join(); }
        for h in thumb_handles    { let _ = h.join(); }

        // Clear queues after they're finished.
        {
            *thumbnails_arc.lock().unwrap() = None;
            *image_metadata_arc.lock().unwrap() = None;
        }
        clear_running(&app_clone);
    });

    Ok(scan_id)
}

#[tauri::command]
fn stop_scan(
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    if let Some(flag) = scan_state.cancelled.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
    if let Some(q) = active_queues.thumbnails.lock().unwrap().as_ref() {
        q.abort();
    }
    if let Some(q) = active_queues.image_metadata.lock().unwrap().as_ref() {
        q.abort();
    }
    Ok(())
}

#[tauri::command]
fn prioritize_queues(
    visible_paths: Vec<String>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    if let Some(queue) = active_queues.thumbnails.lock().unwrap().as_ref() {
        queue.prioritize(&visible_paths);
    }
    if let Some(queue) = active_queues.image_metadata.lock().unwrap().as_ref() {
        queue.prioritize(&visible_paths);
    }
    Ok(())
}

#[tauri::command]
fn set_window_title(title: String, app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?
        .set_title(&title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_image(path: String) -> Result<String, String> {
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
        *state.running.lock().unwrap() = false;
        *state.cancelled.lock().unwrap() = None;
    }
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanState {
            running:   Mutex::new(false),
            cancelled: Mutex::new(None),
        })
        .manage(ActiveQueues {
            thumbnails:     Arc::new(Mutex::new(None)),
            image_metadata: Arc::new(Mutex::new(None)),
        })
        .manage(ScanCounter(Mutex::new(0)))
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            start_scan,
            stop_scan,
            prioritize_queues,
            set_window_title,
            load_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
