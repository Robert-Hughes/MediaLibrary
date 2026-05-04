mod scanner;
mod work_queue;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use work_queue::WorkQueue;

// ── Shared state ──────────────────────────────────────────────────────────────

struct ScanState {
    running:   Mutex<bool>,
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

/// Holds both the thumbnail and image metadata queues so both can be prioritised.
struct ActiveQueues {
    thumbnails:     Arc<Mutex<Option<Arc<WorkQueue>>>>,
    image_metadata: Arc<Mutex<Option<Arc<WorkQueue>>>>,
}

// ── Event payloads ────────────────────────────────────────────────────────────

/// Emitted in batches as the directory walk finds files.
#[derive(Clone, Serialize)]
struct PhotoFoundPayload {
    scan_id: u64,
    photos: Vec<scanner::PhotoInfo>,
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

/// Emitted when a worker encounters an error (e.g., ExifTool not found, thumbnail generation failed)
#[derive(Clone, Serialize)]
struct WorkerErrorPayload {
    scan_id: u64,
    worker_type: String, // "metadata", "thumbnail", "scanner"
    error_message: String,
    affected_files: Vec<String>, // relative paths of files that failed
}

/// Emitted when a batch of Image metadata (EXIF etc) has been read.
#[derive(Clone, Serialize)]
struct ImageMetadataReadyPayload {
    scan_id: u64,
    results: Vec<ImageMetadataResult>,
}

#[derive(Clone, Serialize)]
struct ImageMetadataResult {
    relative_path: String,
    metadata: std::collections::HashMap<String, scanner::Variant>,
}

#[derive(Clone, Serialize)]
struct ThumbnailReadyPayload {
    scan_id: u64,
    results: Vec<ThumbnailResult>,
}

#[derive(Clone, Serialize)]
struct ThumbnailResult {
    relative_path: String,
    thumbnail: String,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn log_to_console(level: String, message: String) {
    match level.as_str() {
        "log" => eprintln!("[JS LOG] {}", message),
        "info" => eprintln!("[JS INFO] {}", message),
        "warn" => eprintln!("[JS WARN] {}", message),
        "error" => eprintln!("[JS ERROR] {}", message),
        _ => eprintln!("[JS] {}", message),
    }
}

#[tauri::command]
fn get_cli_folder() -> Option<String> {
    std::env::args().nth(1)
}

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
    scan_id: u64,
    folder_path: String,
    app: AppHandle,
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
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
            eprintln!("[start_scan] ERROR: Previous scan did not finish in time");
            return Err("A scan is already in progress and could not be stopped".into());
        }
        *running = true;
    }

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

        // We cap metadata workers even more strictly because they spawn processes.
        let metadata_workers = num_workers.min(4);

        // Shared queues fed by the walk, drained by worker pools.
        let thumb_queue          = Arc::new(WorkQueue::new(vec![]));
        let image_metadata_queue = Arc::new(WorkQueue::new(vec![]));

        // Install the queues so prioritize_queues can reach them.
        {
            *thumbnails_arc.lock().unwrap() = Some(thumb_queue.clone());
            *image_metadata_arc.lock().unwrap() = Some(image_metadata_queue.clone());
        }

        let root_arc = Arc::new(root.clone());

        // ── Phase 2: Image Metadata workers ───────────────────────────────
        let metadata_handles: Vec<_> = (0..metadata_workers).map(|_| {
            let queue = image_metadata_queue.clone();
            let app   = app_clone.clone();
            let root  = root_arc.clone();
            let cancelled = cancel_clone.clone();
            std::thread::spawn(move || {
                let mut batch_results = Vec::new();
                let mut last_emit = std::time::Instant::now();
                let emit_interval = std::time::Duration::from_millis(500);
                
                while !cancelled.load(Ordering::Relaxed) {
                    let rel_paths = match queue.pop_batch_timeout(20, emit_interval) {
                        crate::work_queue::PopResult::Items(items) => items,
                        crate::work_queue::PopResult::Timeout => {
                            if !batch_results.is_empty() {
                                eprintln!("[metadata] Emitting batch of {} results (timeout)", batch_results.len());
                                let _ = app.emit("image_metadata_ready", ImageMetadataReadyPayload {
                                    scan_id,
                                    results: std::mem::take(&mut batch_results),
                                });
                                last_emit = std::time::Instant::now();
                            }
                            continue;
                        }
                        crate::work_queue::PopResult::Done => break,
                    };

                    let abs_paths: Vec<_> = rel_paths.iter().map(|p| {
                        root.join(p.replace('/', std::path::MAIN_SEPARATOR_STR))
                    }).collect();

                    match scanner::read_image_metadata_batch(&rel_paths, &abs_paths) {
                        Ok(results) => {
                            eprintln!("[metadata] Read {} results, first has {} fields", 
                                results.len(), 
                                results.first().map(|r| r.metadata.len()).unwrap_or(0));
                            
                            for info in results {
                                batch_results.push(ImageMetadataResult {
                                    relative_path: info.relative_path,
                                    metadata: info.metadata,
                                });
                            }
                        }
                        Err(error_msg) => {
                            eprintln!("[metadata] Error reading metadata: {}", error_msg);
                            
                            // Emit error to UI
                            let _ = app.emit("worker_error", WorkerErrorPayload {
                                scan_id,
                                worker_type: "metadata".to_string(),
                                error_message: error_msg,
                                affected_files: rel_paths.clone(),
                            });
                            
                            // Send empty metadata for failed files so UI shows "failed" instead of spinner
                            for rel_path in rel_paths {
                                let mut error_metadata = std::collections::HashMap::new();
                                error_metadata.insert("_error".to_string(), scanner::Variant::String("Failed to load metadata".to_string()));
                                
                                batch_results.push(ImageMetadataResult {
                                    relative_path: rel_path,
                                    metadata: error_metadata,
                                });
                            }
                        }
                    }
                    
                    // Emit batch if enough time has elapsed
                    if last_emit.elapsed() >= emit_interval && !batch_results.is_empty() {
                        eprintln!("[metadata] Emitting batch of {} results", batch_results.len());
                        let _ = app.emit("image_metadata_ready", ImageMetadataReadyPayload {
                            scan_id,
                            results: std::mem::take(&mut batch_results),
                        });
                        last_emit = std::time::Instant::now();
                    }
                }
                
                // Emit any remaining results
                if !batch_results.is_empty() {
                    eprintln!("[metadata] Emitting final batch of {} results", batch_results.len());
                    let _ = app.emit("image_metadata_ready", ImageMetadataReadyPayload {
                        scan_id,
                        results: batch_results,
                    });
                }
            })
        }).collect();

        // ── Phase 3: thumbnail workers ────────────────────────────────────
        // Batch thumbnails by time (emit every 500ms) to keep UI responsive
        let thumb_handles: Vec<_> = (0..num_workers).map(|_| {
            let queue = thumb_queue.clone();
            let app   = app_clone.clone();
            let root  = root_arc.clone();
            let cancelled = cancel_clone.clone();
            std::thread::spawn(move || {
                let mut batch = Vec::with_capacity(50);
                let mut last_emit = std::time::Instant::now();
                let emit_interval = std::time::Duration::from_millis(500);
                
                loop {
                    match queue.pop_timeout(emit_interval) {
                        crate::work_queue::PopResult::Items(rel_path) => {
                            if cancelled.load(Ordering::Relaxed) { break; }
                            
                            let abs = root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                            if let Some(thumbnail) = scanner::thumbnail_for(&abs) {
                                batch.push(ThumbnailResult {
                                    relative_path: rel_path,
                                    thumbnail,
                                });
                            }
                            
                            // Emit batch if enough time has elapsed
                            if last_emit.elapsed() >= emit_interval && !batch.is_empty() {
                                let _ = app.emit("thumbnail_ready", ThumbnailReadyPayload {
                                    scan_id,
                                    results: std::mem::take(&mut batch),
                                });
                                last_emit = std::time::Instant::now();
                            }
                        }
                        crate::work_queue::PopResult::Timeout => {
                            if !batch.is_empty() {
                                let _ = app.emit("thumbnail_ready", ThumbnailReadyPayload {
                                    scan_id,
                                    results: std::mem::take(&mut batch),
                                });
                                last_emit = std::time::Instant::now();
                            }
                        }
                        crate::work_queue::PopResult::Done => {
                            if !batch.is_empty() {
                                let _ = app.emit("thumbnail_ready", ThumbnailReadyPayload {
                                    scan_id,
                                    results: std::mem::take(&mut batch),
                                });
                            }
                            break;
                        }
                    }
                }
            })
        }).collect();

        // ── Phase 1: streaming directory walk ─────────────────────────────
        // Run the directory walk in a separate thread so we can implement
        // timeout-based flushing even when the walk is slow.
        let photo_queue = Arc::new(Mutex::new(Vec::new()));
        let photo_queue_clone = photo_queue.clone();
        let walk_complete = Arc::new(AtomicBool::new(false));
        let walk_complete_clone = walk_complete.clone();
        let cancel_walk = cancel_clone.clone();
        let image_metadata_queue_walk = image_metadata_queue.clone();
        let thumb_queue_walk = thumb_queue.clone();
        
        let walk_handle = std::thread::spawn(move || {
            scanner::scan_folder(&root, cancel_walk, |photo| {
                image_metadata_queue_walk.push(photo.relative_path.clone());
                thumb_queue_walk.push(photo.relative_path.clone());
                photo_queue_clone.lock().unwrap().push(photo);
            });
            walk_complete_clone.store(true, Ordering::Relaxed);
        });
        
        // Flush thread: periodically emit batches even if no new photos arrive
        let photo_queue_flush = photo_queue.clone();
        let app_flush = app_clone.clone();
        let walk_complete_flush = walk_complete.clone();
        let flush_handle = std::thread::spawn(move || {
            let emit_interval = std::time::Duration::from_millis(500);
            
            loop {
                std::thread::sleep(emit_interval);
                
                let mut queue = photo_queue_flush.lock().unwrap();
                if !queue.is_empty() {
                    let batch = std::mem::take(&mut *queue);
                    drop(queue); // Release lock before emitting
                    
                    let _ = app_flush.emit("photo_found", PhotoFoundPayload { 
                        scan_id, 
                        photos: batch
                    });
                }
                
                // Check if walk is complete
                if walk_complete_flush.load(Ordering::Relaxed) {
                    // One final flush
                    let mut queue = photo_queue_flush.lock().unwrap();
                    if !queue.is_empty() {
                        let batch = std::mem::take(&mut *queue);
                        drop(queue);
                        let _ = app_flush.emit("photo_found", PhotoFoundPayload { 
                            scan_id, 
                            photos: batch
                        });
                    }
                    break;
                }
            }
        });
        
        // Wait for walk to complete
        walk_handle.join().unwrap();
        flush_handle.join().unwrap();

        let _ = app_clone.emit("scan_complete", ScanCompletePayload { scan_id });

        // Clear running flag immediately so a new scan can start.
        // Workers can continue processing in the background.
        clear_running(&app_clone);

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
    });

    Ok(())
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
fn show_in_explorer(folder: String, relative_path: String) -> Result<(), String> {
    let mut path = std::path::PathBuf::from(folder);
    for component in relative_path.split(['/', '\\']) {
        if !component.is_empty() {
            path.push(component);
        }
    }

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, explorer /select,"path" is the syntax.
        // We pass it as a single argument to ensure the comma and path are joined.
        let path_str = path.to_string_lossy().replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path_str))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(parent) = path.parent() {
             std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
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
        .invoke_handler(tauri::generate_handler![
            log_to_console,
            get_cli_folder,
            pick_folder,
            start_scan,
            stop_scan,
            prioritize_queues,
            show_in_explorer,
            set_window_title,
            load_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
