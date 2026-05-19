pub mod scanner;
pub mod util;
pub mod work_queue;
pub mod draft_edits;
pub mod apply_edits;
pub mod tag_schema;
pub mod write_args;
pub mod apply_log;
pub mod exiftool_config;
pub mod settings;
pub mod batch_audit_log;
pub mod batch_job;
pub mod openai_describe;
pub mod describe_log;
pub mod geocode_cache;
pub mod geocode;
pub mod normalise;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use work_queue::WorkQueue;

// ── Shared state ──────────────────────────────────────────────────────────────

pub struct ScanState {
    running:      Mutex<bool>,
    running_cvar: Condvar,
    cancelled:    Mutex<Option<Arc<AtomicBool>>>,
}

impl ScanState {
    pub fn new() -> Self {
        Self {
            running:      Mutex::new(false),
            running_cvar: Condvar::new(),
            cancelled:    Mutex::new(None),
        }
    }

    /// Mark a scan as no longer running.  The cancellation flag is intentionally
    /// left in place: workers from this scan may still be draining their queues,
    /// and a `stop_scan` arriving in that window must still be able to signal
    /// them.  The next `start_scan` overwrites the flag with its own.
    pub fn mark_finished(&self) {
        *self.running.lock().unwrap() = false;
        self.running_cvar.notify_all();
    }

    /// Mark a scan as running.  Caller must verify it is not already running first.
    pub fn mark_running(&self) {
        *self.running.lock().unwrap() = true;
    }

    /// Wait up to `timeout` for `running` to become false.
    /// Returns true if it became false (or was already), false on timeout.
    pub fn wait_until_finished(&self, timeout: Duration) -> bool {
        let running = self.running.lock().unwrap();
        let (_running, wait_res) = self.running_cvar
            .wait_timeout_while(running, timeout, |r| *r)
            .unwrap();
        !wait_res.timed_out()
    }

    /// Install a cancellation flag for the new scan and return a clone.
    pub fn install_cancellation(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        *self.cancelled.lock().unwrap() = Some(flag.clone());
        flag
    }

    /// Signal cancellation if a flag is currently installed.
    /// Returns true if a flag was set.
    pub fn signal_cancellation(&self) -> bool {
        if let Some(flag) = self.cancelled.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

impl Default for ScanState {
    fn default() -> Self { Self::new() }
}

/// Holds both the thumbnail and image metadata queues so both can be prioritised.
/// Cheap to clone: the inner state is shared via `Arc<Mutex<...>>`.
#[derive(Clone)]
pub struct ActiveQueues {
    thumbnails:     Arc<Mutex<Option<Arc<WorkQueue>>>>,
    image_metadata: Arc<Mutex<Option<Arc<WorkQueue>>>>,
}

impl ActiveQueues {
    pub fn new() -> Self {
        Self {
            thumbnails:     Arc::new(Mutex::new(None)),
            image_metadata: Arc::new(Mutex::new(None)),
        }
    }

    /// Replace the currently-installed queues with new ones (used by start_scan).
    pub fn install(&self, thumbs: Arc<WorkQueue>, metadata: Arc<WorkQueue>) {
        *self.thumbnails.lock().unwrap() = Some(thumbs);
        *self.image_metadata.lock().unwrap() = Some(metadata);
    }

    /// Clear the queue slots, but only if the currently-installed queues are
    /// the same Arc instances as `mine_thumbs`/`mine_metadata`.  A newer scan
    /// may have already swapped in its own queues, in which case we must not
    /// nil them out.
    pub fn clear_if_mine(&self, mine_thumbs: &Arc<WorkQueue>, mine_metadata: &Arc<WorkQueue>) {
        let mut t = self.thumbnails.lock().unwrap();
        if t.as_ref().map_or(false, |q| Arc::ptr_eq(q, mine_thumbs)) {
            *t = None;
        }
        drop(t);
        let mut m = self.image_metadata.lock().unwrap();
        if m.as_ref().map_or(false, |q| Arc::ptr_eq(q, mine_metadata)) {
            *m = None;
        }
    }

    pub fn thumbnails(&self) -> Option<Arc<WorkQueue>> {
        self.thumbnails.lock().unwrap().clone()
    }

    pub fn image_metadata(&self) -> Option<Arc<WorkQueue>> {
        self.image_metadata.lock().unwrap().clone()
    }
}

impl Default for ActiveQueues {
    fn default() -> Self { Self::new() }
}

/// Cancellation flag for an in-flight apply_draft_edits_cmd.  Set by
/// cancel_apply_edits; checked by the apply loop between files so a cancel
/// takes effect at the next per-file boundary (never mid-write).
pub struct ApplyEditsState {
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

impl ApplyEditsState {
    pub fn new() -> Self {
        Self { cancelled: Mutex::new(None) }
    }

    pub fn install(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        *self.cancelled.lock().unwrap() = Some(flag.clone());
        flag
    }

    pub fn clear(&self) {
        *self.cancelled.lock().unwrap() = None;
    }

    pub fn signal_cancel(&self) -> bool {
        if let Some(flag) = self.cancelled.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

impl Default for ApplyEditsState {
    fn default() -> Self { Self::new() }
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
    scan_id: u64,
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
    thumbnail: Option<String>,
}

/// Emitted by apply_draft_edits_cmd after each file is processed.
///
/// `tag_outcomes` carries the per-tag verification result so the frontend
/// can surface Coerced (yellow accept-or-revert) and Mismatch entries to the
/// user without re-querying the backend.
#[derive(Clone, Serialize)]
struct ApplyEditsProgressPayload {
    current: usize,
    total: usize,
    relative_path: String,
    applied: bool,
    error: Option<String>,
    fresh_metadata: Option<std::collections::HashMap<String, scanner::Variant>>,
    tag_outcomes: Vec<apply_edits::TagOutcome>,
}

/// Emitted by apply_draft_edits_cmd before the first file is processed,
/// so the frontend can show the modal with an accurate total upfront.
#[derive(Clone, Serialize)]
struct ApplyEditsStartedPayload {
    total: usize,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn log_to_console(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[JS] {}", message),
        "warn"  => log::warn!("[JS] {}", message),
        _       => log::info!("[JS] {}", message),
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
    if !scan_state.wait_until_finished(Duration::from_secs(1)) {
        log::error!("[start_scan] Previous scan did not finish in time");
        return Err("A scan is already in progress and could not be stopped".into());
    }
    scan_state.mark_running();

    let cancellation_flag = scan_state.install_cancellation();

    // Hand a cloned ActiveQueues to the worker thread.  The clone shares the
    // same inner Arc<Mutex<...>> slots, so install/clear_if_mine see the live
    // state observed by stop_scan and prioritize_queues.
    let queues_for_thread  = (*active_queues).clone();
    let app_clone          = app.clone();
    let cancel_clone       = cancellation_flag.clone();

    std::thread::spawn(move || {
        let root = std::path::PathBuf::from(&folder_path);

        if !root.is_dir() {
            let _ = app_clone.emit("scan_error", ScanErrorPayload {
                scan_id,
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
        queues_for_thread.install(thumb_queue.clone(), image_metadata_queue.clone());

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
                                log::debug!("[metadata] Emitting batch of {} results (timeout flush)", batch_results.len());
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
                            log::debug!("[metadata] Read {} results, first has {} fields",
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
                            log::error!("[metadata] Error reading metadata: {}", error_msg);
                            
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
                        log::debug!("[metadata] Emitting batch of {} results", batch_results.len());
                        let _ = app.emit("image_metadata_ready", ImageMetadataReadyPayload {
                            scan_id,
                            results: std::mem::take(&mut batch_results),
                        });
                        last_emit = std::time::Instant::now();
                    }
                }
                
                // Emit any remaining results
                if !batch_results.is_empty() {
                    log::debug!("[metadata] Emitting final batch of {} results", batch_results.len());
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
                            let thumbnail = scanner::thumbnail_for(&abs);
                            batch.push(ThumbnailResult {
                                relative_path: rel_path,
                                thumbnail,
                            });
                            
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
        
        let app_walk_err = app_clone.clone();
        let walk_handle = std::thread::spawn(move || {
            scanner::scan_folder(
                &root,
                cancel_walk,
                |photo| {
                    image_metadata_queue_walk.push(photo.relative_path.clone());
                    thumb_queue_walk.push(photo.relative_path.clone());
                    photo_queue_clone.lock().unwrap().push(photo);
                },
                |err| {
                    log::warn!("[walk] error: {} ({:?})", err.message, err.path);
                    let _ = app_walk_err.emit("worker_error", WorkerErrorPayload {
                        scan_id,
                        worker_type: "scanner".to_string(),
                        error_message: err.message,
                        affected_files: err.path.into_iter().collect(),
                    });
                },
            );
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
                } else {
                    drop(queue); // Release lock even if queue is empty
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

        // Clear the queue slots — but only if a newer scan hasn't already
        // installed its own queues here.  Without this guard, a fast
        // folder-switch can null out the new scan's queues and break
        // prioritize_queues / stop_scan for it.
        queues_for_thread.clear_if_mine(&thumb_queue, &image_metadata_queue);
    });

    Ok(())
}

#[tauri::command]
fn stop_scan(
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    scan_state.signal_cancellation();
    if let Some(q) = active_queues.thumbnails() { q.abort(); }
    if let Some(q) = active_queues.image_metadata() { q.abort(); }
    Ok(())
}

#[tauri::command]
fn prioritize_queues(
    visible_paths: Vec<String>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    if let Some(q) = active_queues.thumbnails() { q.prioritize(&visible_paths); }
    if let Some(q) = active_queues.image_metadata() { q.prioritize(&visible_paths); }
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
fn load_draft_edits(folder_path: String) -> Result<draft_edits::DraftEditsPayload, String> {
    draft_edits::load_draft_edits(&folder_path)
}

/// Look up schema info for a single tag.  Returns `Ok(None)` when the registry
/// is built but the tag is unknown; returns `Err` only when the registry
/// itself could not be built.
#[tauri::command]
fn get_tag_info(tag: String) -> Result<Option<tag_schema::TagInfo>, String> {
    let registry = tag_schema::get_registry().map_err(|e| e.to_string())?;
    Ok(registry.lookup(&tag).cloned())
}

/// Eagerly warms the tag-schema registry so the first `get_tag_info` call is
/// instant.  Called once at startup; the front-end blocks its UI until this
/// resolves so editors never see a missing-schema flash.
#[tauri::command]
fn preload_schema() -> Result<(), String> {
    tag_schema::get_registry().map(|_| ()).map_err(|e| e.to_string())
}

/// Returns the writable `Group:Name` keys in the schema registry, sorted.
/// Used by the "Add New Property" dialog for autocomplete — listing
/// read-only tags would only let the user pick a key that ExifTool would
/// then refuse to write.
#[tauri::command]
fn list_schema_tags() -> Result<Vec<String>, String> {
    let registry = tag_schema::get_registry().map_err(|e| e.to_string())?;
    Ok(registry
        .all_writable()
        .map(|(k, _)| k.to_owned())
        .collect())
}

#[tauri::command]
fn save_draft_edits(folder_path: String, data: draft_edits::DraftEditsPayload) -> Result<(), String> {
    draft_edits::save_draft_edits(&folder_path, data)
}

/// Typed-shape save (Phase 3b/4).  Frontend editors that carry Variant
/// values (BagEditor, …) call this instead of `save_draft_edits` so list
/// and object values round-trip into the v2 JSONL without flattening
/// through the legacy string view.  The legacy command stays available
/// for existing callers and tests.
#[tauri::command]
fn save_draft_edits_typed(folder_path: String, data: draft_edits::TypedDraftEdits) -> Result<(), String> {
    draft_edits::save_typed_draft_edits(&folder_path, &data)
}

#[tauri::command]
fn load_draft_edits_typed(folder_path: String) -> Result<draft_edits::TypedDraftEdits, String> {
    draft_edits::load_typed_draft_edits(&folder_path)
}

/// Apply draft edits for the specified files.
///
/// Processes files one at a time so the operation can be cancelled at a clean
/// boundary and so the on-disk draft store stays in sync as we go (crash safety).
/// Emits `apply_edits_started` once with the total, and `apply_edits_progress`
/// after each file with the outcome (including fresh metadata for the UI to
/// update incrementally).
#[tauri::command]
fn apply_draft_edits_cmd(
    folder_path: String,
    rel_paths: Vec<String>,
    app: AppHandle,
    apply_state: State<'_, ApplyEditsState>,
) -> Result<apply_edits::ApplyEditsResult, String> {
    let cancel_flag = apply_state.install();

    // Load typed drafts directly — preserves Variant::List / Object shapes
    // that the BagEditor and friends produce.  The legacy string view loses
    // list-ness, so going through it here would re-introduce the
    // keywords-CSV corruption.
    let mut all_drafts = draft_edits::load_typed_draft_edits(&folder_path).unwrap_or_default();

    let total = rel_paths.iter()
        .filter(|p| all_drafts.get(p.as_str()).map_or(false, |e| !e.is_empty()))
        .count();

    let _ = app.emit("apply_edits_started", ApplyEditsStartedPayload { total });

    let mut applied = Vec::new();
    let mut failed = Vec::new();
    let mut fresh_metadata = std::collections::HashMap::new();
    let mut current = 0usize;

    for rel_path in &rel_paths {
        if cancel_flag.load(Ordering::Relaxed) {
            log::info!("[apply_edits] Cancelled at {}/{}", current, total);
            break;
        }

        let edits = match all_drafts.get(rel_path.as_str()) {
            Some(e) if !e.is_empty() => e.clone(),
            _ => continue,
        };

        current += 1;

        let outcome = apply_edits::apply_single_file_typed(&folder_path, rel_path, &edits);
        let was_applied = outcome.error.is_none();

        // Persist incrementally.  Phase 8.1: prune only the per-tag drafts
        // whose outcomes are conclusively safe to drop (Match / DeleteOk).
        // Coerced and Mismatch entries stay so the user can accept-or-revert
        // (Coerced) or fix the underlying problem (Mismatch).  Previously the
        // whole file's draft map was wiped on success, which hid Coerced from
        // the user the moment exiftool returned a normalised value.
        if !outcome.tags_to_clear.is_empty() {
            if let Some(file_drafts) = all_drafts.get_mut(rel_path.as_str()) {
                for tag in &outcome.tags_to_clear {
                    file_drafts.remove(tag);
                }
                if file_drafts.is_empty() {
                    all_drafts.remove(rel_path.as_str());
                }
                if let Err(e) = draft_edits::save_typed_draft_edits(&folder_path, &all_drafts) {
                    log::warn!("[apply_edits] Warning: failed to persist draft removal for {}: {}", rel_path, e);
                }
            }
        }

        let _ = app.emit("apply_edits_progress", ApplyEditsProgressPayload {
            current,
            total,
            relative_path: rel_path.clone(),
            applied: was_applied,
            error: outcome.error.clone(),
            fresh_metadata: outcome.fresh_metadata.clone(),
            tag_outcomes: outcome.outcomes.clone(),
        });

        if let Some(meta) = outcome.fresh_metadata {
            fresh_metadata.insert(rel_path.clone(), meta);
        }
        match outcome.error {
            None => applied.push(rel_path.clone()),
            Some(reason) => failed.push(apply_edits::FailedFile {
                relative_path: rel_path.clone(),
                reason,
            }),
        }
    }

    apply_state.clear();

    Ok(apply_edits::ApplyEditsResult { applied, failed, fresh_metadata })
}

/// Request cancellation of an in-flight apply_draft_edits_cmd. The current
/// file completes (so writes are never torn); subsequent files are skipped.
#[tauri::command]
fn cancel_apply_edits(apply_state: State<'_, ApplyEditsState>) -> Result<(), String> {
    apply_state.signal_cancel();
    Ok(())
}

/// Locate the per-user app-data directory for settings/log files.  Uses
/// tauri's `path()` resolver so the location follows OS conventions
/// (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
/// `$XDG_CONFIG_HOME` on Linux).
fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {}", e))
}

#[tauri::command]
fn load_settings_cmd(app: AppHandle) -> Result<settings::Settings, String> {
    let dir = app_data_dir(&app)?;
    settings::load_settings(&dir)
}

#[tauri::command]
fn save_settings_cmd(app: AppHandle, settings_data: settings::Settings) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    settings::save_settings(&dir, &settings_data)
}

/// Returns the static list of vision models we recommend for image
/// description, so the Settings dropdown stays in sync with the backend's
/// pricing/cost-estimation knowledge.
#[tauri::command]
fn list_recommended_models() -> Vec<String> {
    settings::RECOMMENDED_MODELS.iter().map(|s| s.to_string()).collect()
}

/// Ballpark USD cost of describing a single typical image with `model`.
/// Drives the per-model cost label in the Settings dropdown so users see
/// the scale before they pick. Returns an error for unknown models so the
/// caller can decide between "(price unknown)" and a hard failure.
#[tauri::command]
fn estimate_per_image_cost_cmd(model: String) -> Result<f64, String> {
    openai_describe::estimate_typical_cost_per_image(&model)
        .ok_or_else(|| format!("no pricing entry for model {}", model))
}

// ── AI image-description commands ─────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct DescribeEstimateStartedPayload { total: usize }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DescribeEstimateProgressPayload {
    current: usize,
    total: usize,
    relative_path: String,
    input_tokens: u32,
    expected_cost_usd: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DescribeEstimateCompletePayload {
    total_input_tokens: u64,
    predicted_cost_usd: f64,
    upper_bound_cost_usd: f64,
    model: String,
}

#[derive(Clone, Serialize)]
struct DescribeEstimateErrorPayload { relative_path: String, message: String }

// `describe_retry` event surface deferred: reqwest_retry doesn't expose a
// per-attempt hook, so retries are visible in logs but not in the UI for
// V1. Adding a custom middleware that emits events is the natural follow-up
// (see docs/IMAGE_ANALYSIS.md "Rate-limit visibility" bullet).

// `describe_started`, `describe_progress`, `describe_complete` are emitted
// through `batch_job::BatchProgressEmitter` — the wire shape lives there.
// Only the per-job summary (token usage / cost) is describe-specific:

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    total_input_tokens: u32,
    total_cached_tokens: u32,
    total_output_tokens: u32,
    predicted_cost_usd: f64,
    actual_cost_usd: f64,
}

/// Build a fresh OpenAI client using the stored settings. Fails fast if the
/// API key is empty so the caller can show a "Settings → API key" hint.
fn make_openai_client(app: &AppHandle) -> Result<(openai_describe::OpenAiClient, settings::Settings), String> {
    let dir = app_data_dir(app)?;
    let s = settings::load_settings(&dir)?;
    if s.openai_api_key.trim().is_empty() {
        return Err("OpenAI API key is not configured. Open Settings to enter your key.".into());
    }
    let client = openai_describe::OpenAiClient::new(
        openai_describe::DEFAULT_BASE_URL,
        s.openai_api_key.clone(),
        3,
    );
    Ok((client, s))
}

/// Resolve a relative path under `folder_path` to an absolute path,
/// matching how scanner.rs walks the tree (forward-slash relative paths).
fn resolve_rel(folder_path: &str, rel: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(folder_path)
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// Preflight cost estimation phase.  Calls `/responses/input_tokens` once
/// per image; emits a progress event after each.  Hard-fails on any error
/// — no local-math fallback (V1 design decision).  Honours the
/// DescribeState cancellation flag at each image boundary.
#[tauri::command]
async fn estimate_describe_cost_cmd(
    folder_path: String,
    rel_paths: Vec<String>,
    app: AppHandle,
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    let cancel_flag = describe_state.install();
    let (client, s) = make_openai_client(&app)?;
    let pricing = openai_describe::pricing_for(&s.openai_model)
        .ok_or_else(|| format!("no pricing entry for model {}", s.openai_model))?;

    let total = rel_paths.len();
    log::info!(
        "[describe] estimate starting model={} total={}",
        s.openai_model, total
    );
    let _ = app.emit("describe_estimate_started", DescribeEstimateStartedPayload { total });

    let mut total_input_tokens: u64 = 0;
    let mut current = 0usize;
    for rel in &rel_paths {
        if cancel_flag.load(Ordering::Relaxed) {
            describe_state.clear();
            return Err("Cancelled by user".into());
        }
        current += 1;
        let abs = resolve_rel(&folder_path, rel);
        let bytes = openai_describe::load_and_downscale_image(&abs)
            .map_err(|e| {
                let _ = app.emit("describe_estimate_error",
                    DescribeEstimateErrorPayload { relative_path: rel.clone(), message: e.clone() });
                format!("{}: {}", rel, e)
            })?;
        let n = openai_describe::count_input_tokens(&client, &s.openai_model, &bytes)
            .await
            .map_err(|e| {
                let _ = app.emit("describe_estimate_error",
                    DescribeEstimateErrorPayload { relative_path: rel.clone(), message: e.clone() });
                format!("{}: {}", rel, e)
            })?;
        total_input_tokens += n as u64;
        let expected_cost = (n as f64 / 1_000_000.0) * pricing.input_per_1m
            + (openai_describe::EXPECTED_OUTPUT_TOKENS as f64 / 1_000_000.0) * pricing.output_per_1m;
        let _ = app.emit("describe_estimate_progress", DescribeEstimateProgressPayload {
            current, total, relative_path: rel.clone(),
            input_tokens: n, expected_cost_usd: expected_cost,
        });
    }

    let predicted_cost = (total_input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m
        + ((openai_describe::EXPECTED_OUTPUT_TOKENS as u64 * total as u64) as f64 / 1_000_000.0)
            * pricing.output_per_1m;
    let upper_bound = (total_input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m
        + ((openai_describe::MAX_OUTPUT_TOKENS as u64 * total as u64) as f64 / 1_000_000.0)
            * pricing.output_per_1m;
    log::info!(
        "[describe] estimate complete total_input_tokens={} predicted_cost_usd={:.6} upper_bound_cost_usd={:.6}",
        total_input_tokens, predicted_cost, upper_bound
    );
    let _ = app.emit("describe_estimate_complete", DescribeEstimateCompletePayload {
        total_input_tokens, predicted_cost_usd: predicted_cost,
        upper_bound_cost_usd: upper_bound, model: s.openai_model.clone(),
    });
    // The cancel flag installed for this estimate run is dropped: the user
    // is now in the awaiting-confirm phase. If they confirm, the
    // `describe_images_cmd` handler will install a fresh flag for the run
    // loop; if they cancel from the dialog before confirming, the dialog
    // simply closes — there's no in-flight work to signal.
    describe_state.clear();
    Ok(())
}

/// Predicted-cost recomputation used for the audit log; cheap, no
/// allocations.
fn predicted_cost(model_p: &openai_describe::ModelPricing, total_input: u64, n_images: u64) -> f64 {
    (total_input as f64 / 1_000_000.0) * model_p.input_per_1m
        + ((openai_describe::EXPECTED_OUTPUT_TOKENS as u64 * n_images) as f64 / 1_000_000.0)
            * model_p.output_per_1m
}

/// Main describe loop.  Sequential, per-image draft persistence,
/// cancellable between images.  Emits `describe_started`, per-image
/// `describe_progress`, optional `describe_retry`, then `describe_complete`
/// with the aggregate usage summary.
#[tauri::command]
async fn describe_images_cmd(
    folder_path: String,
    rel_paths: Vec<String>,
    app: AppHandle,
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    let cancel_flag = describe_state.install();
    let (client, s) = make_openai_client(&app)?;
    let pricing = openai_describe::pricing_for(&s.openai_model)
        .ok_or_else(|| format!("no pricing entry for model {}", s.openai_model))?;

    let total = rel_paths.len();
    log::info!(
        "[describe] starting describe model={} prompt_version={} total={}",
        s.openai_model, openai_describe::PROMPT_VERSION, total
    );
    let emitter = batch_job::BatchProgressEmitter::new(&app, "describe");
    emitter.started(total);

    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<batch_job::BatchFailureRow> = Vec::new();
    let mut log_errors: Vec<describe_log::DescribeLogError> = Vec::new();
    let mut aggregate = openai_describe::UsageStats::default();
    let mut total_input_for_predicted: u64 = 0;
    let mut current = 0usize;

    for rel in &rel_paths {
        if cancel_flag.load(Ordering::Relaxed) {
            log::info!("[describe] Cancelled at {}/{}", current, total);
            break;
        }
        current += 1;
        log::info!("[describe] ({}/{}) starting {}", current, total, rel);

        // Decode locally first so a corrupt file is reported without
        // incurring an API call.
        let abs = resolve_rel(&folder_path, rel);
        let bytes = match openai_describe::load_and_downscale_image(&abs) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("[describe] ({}/{}) decode failed for {}: {}", current, total, rel, e);
                let kind = batch_job::BatchFailureKind::Decode;
                emitter.progress(current, total, rel, kind.as_wire(), Some(&e), None);
                failed.push(batch_job::BatchFailureRow {
                    relative_path: rel.clone(), kind, detail: e.clone(),
                });
                log_errors.push(describe_log::DescribeLogError {
                    relative_path: rel.clone(), kind, detail: e,
                });
                continue;
            }
        };

        match openai_describe::describe_one(&client, &s.openai_model, &bytes).await {
            Ok((output, usage)) => {
                aggregate.add(&usage);
                total_input_for_predicted += usage.input_tokens as u64;

                let edits = openai_describe::compose_draft_edits(
                    &s.openai_model, &output, chrono::Utc::now(),
                );
                log::info!(
                    "[describe] ({}/{}) ok {} input_tokens={} output_tokens={} tags={}",
                    current, total, rel, usage.input_tokens, usage.output_tokens, edits.len()
                );
                emitter.progress(current, total, rel, "ok", None, Some(&edits));
                succeeded.push(rel.clone());
            }
            Err(e) => {
                let kind = e.kind();
                let detail = e.detail();
                log::warn!(
                    "[describe] ({}/{}) failed {} kind={} detail={}",
                    current, total, rel, kind, detail
                );
                emitter.progress(current, total, rel, kind.as_wire(), Some(&detail), None);
                failed.push(batch_job::BatchFailureRow {
                    relative_path: rel.clone(), kind, detail: detail.clone(),
                });
                log_errors.push(describe_log::DescribeLogError {
                    relative_path: rel.clone(), kind, detail,
                });
            }
        }
    }

    log::info!(
        "[describe] finished succeeded={} failed={} total_input_tokens={} total_output_tokens={}",
        succeeded.len(), failed.len(), aggregate.input_tokens, aggregate.output_tokens
    );

    let predicted = predicted_cost(&pricing, total_input_for_predicted, succeeded.len() as u64);
    let actual = aggregate.cost(&pricing);

    let usage_summary = UsageSummary {
        total_input_tokens: aggregate.input_tokens,
        total_cached_tokens: aggregate.cached_input_tokens,
        total_output_tokens: aggregate.output_tokens,
        predicted_cost_usd: predicted,
        actual_cost_usd: actual,
    };

    // Audit log — best-effort, never fails the command.
    if let Ok(dir) = app_data_dir(&app) {
        let entry = describe_log::DescribeLogEntry {
            ts: chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            model: s.openai_model.clone(),
            prompt_version: openai_describe::PROMPT_VERSION.to_string(),
            n_images: total,
            n_succeeded: succeeded.len(),
            n_failed: failed.len(),
            total_input_tokens: aggregate.input_tokens,
            total_cached_tokens: aggregate.cached_input_tokens,
            total_output_tokens: aggregate.output_tokens,
            predicted_cost_usd: predicted,
            actual_cost_usd: actual,
            errors: log_errors,
        };
        if let Err(e) = describe_log::append(&dir, &entry) {
            log::warn!("[describe] Audit-log append failed: {}", e);
        }
    }

    describe_state.clear();
    emitter.complete(&succeeded, &failed, &usage_summary);
    Ok(())
}

#[tauri::command]
fn cancel_describe_cmd(describe_state: State<'_, openai_describe::DescribeState>) -> Result<(), String> {
    describe_state.signal_cancel();
    Ok(())
}

// ── Metadata-normalisation commands ──────────────────────────────────────────
//
// See `docs/NORMALISE_METADATA_PLAN.md` §8. Run command walks the
// supplied items through `normalise::process_image`, emits per-item
// progress events, and accumulates a `NormaliseSummary`. v1 has no AI
// dispatch and so no estimate phase — see plan §7.

/// Normalise metadata for a batch of images.
#[tauri::command]
async fn normalise_metadata_cmd(
    folder_path: String,
    items: Vec<normalise::NormaliseRequestItem>,
    enabled_groups: Vec<normalise::NormaliseGroup>,
    app: AppHandle,
    normalise_state: State<'_, normalise::NormaliseState>,
) -> Result<(), String> {
    let _ = folder_path; // resolution happens client-side
    let cancel_flag = normalise_state.install();
    let total = items.len();
    log::info!("[normalise] starting total={} groups={:?}", total, enabled_groups);

    let emitter = batch_job::BatchProgressEmitter::new(&app, "normalise");
    emitter.started(total);

    let mut succeeded: Vec<String> = Vec::new();
    let failed: Vec<batch_job::BatchFailureRow> = Vec::new();
    let mut summary = normalise::NormaliseSummary::default();
    let mut current = 0usize;

    for item in &items {
        if cancel_flag.load(Ordering::Relaxed) {
            log::info!("[normalise] cancelled at {}/{}", current, total);
            break;
        }
        current += 1;
        let rel = item.rel_path.clone();
        // v2 AI client wiring lands in a follow-up commit; for now no
        // AI client is supplied — Group B falls back to primary-or-
        // longest, Group C case-3 is a no-op.
        let (edits, stats) = normalise::process_image(item, &enabled_groups, None).await;
        summary.accumulate(&stats);
        let all_noop = edits.is_empty();
        if all_noop {
            summary.n_skipped_all_normalised += 1;
            emitter.progress(current, total, &rel, "ok", None, None);
        } else {
            emitter.progress(current, total, &rel, "ok", None, Some(&edits));
        }
        succeeded.push(rel);
    }
    summary.n_succeeded = succeeded.len() as u32;
    summary.n_failed = failed.len() as u32;

    log::info!(
        "[normalise] finished succeeded={} failed={} groups_normalised_total={}",
        summary.n_succeeded, summary.n_failed, summary.n_groups_normalised_total,
    );

    normalise_state.clear();
    emitter.complete(&succeeded, &failed, &summary);
    Ok(())
}

#[tauri::command]
fn cancel_normalise_cmd(normalise_state: State<'_, normalise::NormaliseState>) -> Result<(), String> {
    normalise_state.signal_cancel();
    Ok(())
}

// ── Reverse-geocoding commands ────────────────────────────────────────────────

/// One image's GPS, supplied by the frontend so the front end owns the
/// "draft vs. metadata" precedence rule (see docs/REVERSE_GEOCODE_PLAN.md
/// §2). The backend never reads the typed-draft store — it just trusts
/// the resolved lat/lon. `lat`/`lon` are `null` when the image has no
// `GeocodeRequestItem` and `GeocodeSummary` moved into `geocode.rs`
// alongside the batch runner that owns them — see `geocode::{
// GeocodeRequestItem, GeocodeSummary}`.
use geocode::{GeocodeRequestItem, GeocodeSummary};

/// Reverse-geocode a batch of images.
///
/// Tauri wiring around `geocode::run_geocode_batch`: installs the
/// cancellation flag, loads/saves the on-disk cache, and adapts the
/// shared `BatchProgressEmitter` to the runner's `GeocodeEventSink`
/// trait. The actual loop, per-host rate limiting, mid-pipeline cancel
/// handling and `cache_io` synthesis live in `geocode.rs` so they can
/// be exercised from integration tests without a Tauri runtime.
#[tauri::command]
async fn geocode_images_cmd(
    folder_path: String,
    items: Vec<GeocodeRequestItem>,
    app: AppHandle,
    geocode_state: State<'_, geocode::GeocodeState>,
) -> Result<(), String> {
    let _ = folder_path; // resolution happens client-side; included for symmetry with describe.
    let cancel_flag = geocode_state.install();
    let client = geocode::GeocodeClient::new();
    let app_data = app_data_dir(&app).ok();
    let mut cache = match &app_data {
        Some(dir) => geocode_cache::load(dir),
        None => geocode_cache::GeocodeCacheFile::default_v1(),
    };

    log::info!("[geocode] starting total={}", items.len());

    let sink = TauriGeocodeSink {
        emitter: batch_job::BatchProgressEmitter::new(&app, "geocode"),
    };

    let outcome = geocode::run_geocode_batch(
        &items,
        &client,
        &mut cache,
        &cancel_flag,
        &sink,
        |c| match &app_data {
            // No app_data_dir → don't try to persist. The batch loop's
            // typed-draft emissions still landed in the frontend store;
            // we just can't memoise this batch's results across
            // restarts.
            Some(dir) => geocode_cache::save(dir, c),
            None => Ok(()),
        },
    )
    .await;

    log::info!(
        "[geocode] finished succeeded={} failed={} no_gps={} from_cache={} from_nominatim={} from_overpass={}",
        outcome.succeeded.len(),
        outcome.summary.n_failed,
        outcome.summary.n_no_gps,
        outcome.summary.n_succeeded_from_cache,
        outcome.summary.n_succeeded_from_nominatim,
        outcome.summary.n_succeeded_from_overpass,
    );

    geocode_state.clear();
    Ok(())
}

/// Bridge from the runner's sink trait to the Tauri event emitter.
/// Kept inline at the call site (rather than in `batch_job.rs`)
/// because the sink trait is per-job — describe will get its own when
/// its loop is similarly extracted.
struct TauriGeocodeSink<'a> {
    emitter: batch_job::BatchProgressEmitter<'a>,
}

impl<'a> geocode::GeocodeEventSink for TauriGeocodeSink<'a> {
    fn started(&self, total: usize) {
        self.emitter.started(total);
    }
    fn progress(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&std::collections::HashMap<String, draft_edits::DraftEdit>>,
    ) {
        self.emitter
            .progress(current, total, relative_path, status, error, edits);
    }
    fn complete(
        &self,
        succeeded: &[String],
        failed: &[batch_job::BatchFailureRow],
        summary: &GeocodeSummary,
    ) {
        self.emitter.complete(succeeded, failed, summary);
    }
}

#[tauri::command]
fn cancel_geocode_cmd(geocode_state: State<'_, geocode::GeocodeState>) -> Result<(), String> {
    geocode_state.signal_cancel();
    Ok(())
}

fn clear_running(app: &AppHandle) {
    if let Some(state) = app.try_state::<ScanState>() {
        state.mark_finished();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_finished_keeps_cancellation_flag_so_late_stop_scan_can_signal_workers() {
        // After scan_complete the workers may still be draining for several seconds.
        // A stop_scan arriving in that window must still be able to flip the
        // cancellation flag so the workers exit promptly.
        let state = ScanState::new();
        let flag = Arc::new(AtomicBool::new(false));
        *state.cancelled.lock().unwrap() = Some(flag.clone());
        *state.running.lock().unwrap() = true;

        state.mark_finished();

        // running is cleared so a new scan can begin, but the flag is still
        // reachable via stop_scan -> signal_cancellation.
        assert_eq!(*state.running.lock().unwrap(), false);
        assert!(state.signal_cancellation(), "cancellation flag should still be installed");
        assert!(flag.load(Ordering::Relaxed), "workers should now see the cancellation");
    }

    #[test]
    fn signal_cancellation_returns_false_when_no_flag_installed() {
        let state = ScanState::new();
        assert!(!state.signal_cancellation());
    }

    #[test]
    fn wait_until_finished_returns_immediately_when_not_running() {
        let state = ScanState::new();
        let start = std::time::Instant::now();
        assert!(state.wait_until_finished(Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_millis(20));
    }

    #[test]
    fn wait_until_finished_wakes_promptly_when_mark_finished_called() {
        // The old implementation polled every 50ms.  This test proves the new
        // condvar-based wait wakes immediately, not on a polling tick.
        let state = Arc::new(ScanState::new());
        state.mark_running();

        let waker = state.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            waker.mark_finished();
        });

        let start = std::time::Instant::now();
        assert!(state.wait_until_finished(Duration::from_secs(5)));
        let elapsed = start.elapsed();

        // Wake-up should be tight — well under the old 50ms polling interval.
        assert!(elapsed < Duration::from_millis(45),
            "wait_until_finished took {elapsed:?}, expected immediate wake");
        assert!(elapsed >= Duration::from_millis(15));
    }

    // ── ActiveQueues race-condition tests ─────────────────────────────────────

    #[test]
    fn clear_if_mine_clears_when_my_queues_are_still_installed() {
        let aq = ActiveQueues::new();
        let thumbs = Arc::new(WorkQueue::new(vec![]));
        let metadata = Arc::new(WorkQueue::new(vec![]));
        aq.install(thumbs.clone(), metadata.clone());

        aq.clear_if_mine(&thumbs, &metadata);

        assert!(aq.thumbnails().is_none());
        assert!(aq.image_metadata().is_none());
    }

    #[test]
    fn clear_if_mine_leaves_a_newer_scans_queues_alone() {
        // Reproduce the race: scan A finishes its workers and goes to clean up,
        // but scan B has already installed its own queues into ActiveQueues.
        // The cleanup must not nil out scan B's queues.
        let aq = ActiveQueues::new();
        let scan_a_thumbs = Arc::new(WorkQueue::new(vec![]));
        let scan_a_metadata = Arc::new(WorkQueue::new(vec![]));
        aq.install(scan_a_thumbs.clone(), scan_a_metadata.clone());

        // Scan B starts and replaces the slots.
        let scan_b_thumbs = Arc::new(WorkQueue::new(vec![]));
        let scan_b_metadata = Arc::new(WorkQueue::new(vec![]));
        aq.install(scan_b_thumbs.clone(), scan_b_metadata.clone());

        // Scan A's late cleanup must not clobber scan B.
        aq.clear_if_mine(&scan_a_thumbs, &scan_a_metadata);

        let installed_thumbs = aq.thumbnails().expect("scan B's thumb queue must still be installed");
        let installed_metadata = aq.image_metadata().expect("scan B's metadata queue must still be installed");
        assert!(Arc::ptr_eq(&installed_thumbs, &scan_b_thumbs));
        assert!(Arc::ptr_eq(&installed_metadata, &scan_b_metadata));
    }

    #[test]
    fn clear_if_mine_handles_partial_overlap() {
        // Defensive: only one of the two slots matches mine.  Clear that one,
        // leave the other.
        let aq = ActiveQueues::new();
        let mine_thumbs = Arc::new(WorkQueue::new(vec![]));
        let mine_metadata = Arc::new(WorkQueue::new(vec![]));
        let other_metadata = Arc::new(WorkQueue::new(vec![]));
        aq.install(mine_thumbs.clone(), other_metadata.clone());

        aq.clear_if_mine(&mine_thumbs, &mine_metadata);

        assert!(aq.thumbnails().is_none(), "mine_thumbs should have been cleared");
        let installed = aq.image_metadata().expect("other_metadata must remain");
        assert!(Arc::ptr_eq(&installed, &other_metadata));
    }

    #[test]
    fn wait_until_finished_times_out_when_scan_never_finishes() {
        let state = ScanState::new();
        state.mark_running();
        let start = std::time::Instant::now();
        assert!(!state.wait_until_finished(Duration::from_millis(50)));
        assert!(start.elapsed() >= Duration::from_millis(50));
    }
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanState::new())
        .manage(ActiveQueues::new())
        .manage(ApplyEditsState::new())
        .manage(openai_describe::DescribeState::default())
        .manage(geocode::GeocodeState::default())
        .manage(normalise::NormaliseState::default())
        .invoke_handler(tauri::generate_handler![
            log_to_console,
            get_cli_folder,
            pick_folder,
            start_scan,
            stop_scan,
            prioritize_queues,
            show_in_explorer,
            set_window_title,
            load_draft_edits,
            save_draft_edits,
            save_draft_edits_typed,
            load_draft_edits_typed,
            apply_draft_edits_cmd,
            cancel_apply_edits,
            get_tag_info,
            preload_schema,
            list_schema_tags,
            load_settings_cmd,
            save_settings_cmd,
            list_recommended_models,
            estimate_per_image_cost_cmd,
            estimate_describe_cost_cmd,
            describe_images_cmd,
            cancel_describe_cmd,
            geocode_images_cmd,
            cancel_geocode_cmd,
            normalise_metadata_cmd,
            cancel_normalise_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
