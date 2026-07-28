pub mod apply_batch;
pub mod apply_edits;
pub mod apply_log;
#[cfg(all(test, feature = "integration"))]
mod apply_perf_experiment;
pub mod batch_audit_log;
pub mod batch_job;
pub mod commands;
pub mod country_code;
pub mod describe_log;
pub mod draft_edits;
pub mod draft_reconciliation;
pub mod exiftool_config;
pub mod geocode;
pub mod geocode_cache;
mod image_orientation;
pub mod known_ids;
pub mod metadata_draft_target;
pub mod metadata_occurrence;
pub mod metadata_value;
mod metadata_verification;
pub(crate) mod metadata_write_execution;
pub mod normalise;
pub mod openai_describe;
pub mod openai_http;
pub mod openai_normalise;
mod openai_request;
pub mod scanner;
pub mod settings;
pub mod tag_schema;
pub mod util;
pub mod work_queue;
pub mod write_args;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static STARTUP_INSTANT: OnceLock<Instant> = OnceLock::new();

fn wall_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn since_startup_ms() -> u128 {
    STARTUP_INSTANT
        .get()
        .map(|t| t.elapsed().as_millis())
        .unwrap_or(0)
}
use tauri::{AppHandle, Emitter, Manager, State};
use work_queue::WorkQueue;

// ── Shared state ──────────────────────────────────────────────────────────────

pub struct ScanState {
    running: Mutex<bool>,
    running_cvar: Condvar,
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

impl ScanState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(false),
            running_cvar: Condvar::new(),
            cancelled: Mutex::new(None),
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
        let (_running, wait_res) = self
            .running_cvar
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
    fn default() -> Self {
        Self::new()
    }
}

/// Holds both the thumbnail and image metadata queues so both can be prioritised.
/// Cheap to clone: the inner state is shared via `Arc<Mutex<...>>`.
#[derive(Clone)]
pub struct ActiveQueues {
    thumbnails: Arc<Mutex<Option<Arc<WorkQueue>>>>,
    file_metadata: Arc<Mutex<Option<Arc<WorkQueue>>>>,
}

impl ActiveQueues {
    pub fn new() -> Self {
        Self {
            thumbnails: Arc::new(Mutex::new(None)),
            file_metadata: Arc::new(Mutex::new(None)),
        }
    }

    /// Replace the currently-installed queues with new ones (used by start_scan).
    pub fn install(&self, thumbs: Arc<WorkQueue>, metadata: Arc<WorkQueue>) {
        *self.thumbnails.lock().unwrap() = Some(thumbs);
        *self.file_metadata.lock().unwrap() = Some(metadata);
    }

    /// Clear the queue slots, but only if the currently-installed queues are
    /// the same Arc instances as `mine_thumbs`/`mine_metadata`.  A newer scan
    /// may have already swapped in its own queues, in which case we must not
    /// nil them out.
    pub fn clear_if_mine(&self, mine_thumbs: &Arc<WorkQueue>, mine_metadata: &Arc<WorkQueue>) {
        let mut t = self.thumbnails.lock().unwrap();
        if t.as_ref().is_some_and(|q| Arc::ptr_eq(q, mine_thumbs)) {
            *t = None;
        }
        drop(t);
        let mut m = self.file_metadata.lock().unwrap();
        if m.as_ref().is_some_and(|q| Arc::ptr_eq(q, mine_metadata)) {
            *m = None;
        }
    }

    pub fn thumbnails(&self) -> Option<Arc<WorkQueue>> {
        self.thumbnails.lock().unwrap().clone()
    }

    pub fn file_metadata(&self) -> Option<Arc<WorkQueue>> {
        self.file_metadata.lock().unwrap().clone()
    }
}

impl Default for ActiveQueues {
    fn default() -> Self {
        Self::new()
    }
}

// ── Event payloads ────────────────────────────────────────────────────────────

/// Emitted in batches as the directory walk finds files.
#[derive(Clone, Serialize)]
struct FileFoundPayload {
    scan_id: u64,
    files: Vec<scanner::FileInfo>,
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
struct ApplicationErrorPayload {
    scan_id: u64,
    severity: String,
    error_type: String, // "metadata", "thumbnail", "scanner"
    error_message: String,
    affected_files: Vec<String>, // relative paths of files that failed
}

/// Emitted when a batch of Image metadata (EXIF etc) has been read.
#[derive(Clone, Serialize)]
struct FileMetadataReadyPayload {
    scan_id: u64,
    results: Vec<scanner::FileMetadata>,
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

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn log_to_console(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[JS] {}", message),
        "warn" => log::warn!("[JS] {}", message),
        _ => log::info!("[JS] {}", message),
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
///    Walks the directory tree. For each image file found, emits `file_found`
///    immediately so the frontend can add it to the list. Also feeds the file
///    into the image metadata queue and thumbnail queue right away.
///    Emits `scan_complete` (no payload) when the walk finishes.
///
///  Phase 2 — Image Metadata (thread pool, starts alongside phase 1):
///    Reads EXIF data per file and emits `file_metadata_ready`.
///
///  Phase 3 — thumbnail generation (thread pool, starts alongside phase 1):
///    Generates thumbnails and emits `thumbnail_ready`.
///    Supports priority reordering via `prioritize_queues`.
fn effective_scan_concurrency(
    configured_metadata: u16,
    configured_thumbnails: u16,
    slow_mode: bool,
) -> (usize, usize) {
    if slow_mode {
        (1, 1)
    } else {
        (
            usize::from(configured_metadata),
            usize::from(configured_thumbnails),
        )
    }
}

#[tauri::command]
fn start_scan(
    scan_id: u64,
    folder_path: String,
    app: AppHandle,
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    let app_settings = settings::load_settings(&commands::shared::app_data_dir(&app)?)?;
    let configured_metadata_workers = usize::from(app_settings.metadata_scan_concurrency);
    let configured_thumbnail_workers = usize::from(app_settings.thumbnail_concurrency);
    let metadata_batch_size = usize::from(app_settings.metadata_scan_batch_size);

    if !scan_state.wait_until_finished(Duration::from_secs(1)) {
        log::error!("[start_scan] Previous scan did not finish in time");
        return Err("A scan is already in progress and could not be stopped".into());
    }
    scan_state.mark_running();

    let cancellation_flag = scan_state.install_cancellation();

    // Hand a cloned ActiveQueues to the worker thread.  The clone shares the
    // same inner Arc<Mutex<...>> slots, so install/clear_if_mine see the live
    // state observed by stop_scan and prioritize_queues.
    let queues_for_thread = (*active_queues).clone();
    let app_clone = app.clone();
    let cancel_clone = cancellation_flag.clone();

    std::thread::spawn(move || {
        let root = std::path::PathBuf::from(&folder_path);

        if !root.is_dir() {
            let _ = app_clone.emit(
                "scan_error",
                ScanErrorPayload {
                    scan_id,
                    message: format!("{} is not a directory", folder_path),
                },
            );
            clear_running(&app_clone);
            return;
        }

        // In slow-mode (MEDIA_LIBRARY_SLOW_MODE=1) use a single worker per pool
        // so the artificial per-file delays in scanner.rs are clearly visible.
        let slow_mode = std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok();
        let (metadata_workers, thumbnail_workers) = effective_scan_concurrency(
            app_settings.metadata_scan_concurrency,
            app_settings.thumbnail_concurrency,
            slow_mode,
        );
        log::info!(
            "[scan] starting scan_id={} metadata_concurrency={} metadata_batch_size={} thumbnail_concurrency={} configured_metadata_concurrency={} configured_thumbnail_concurrency={} slow_mode={}",
            scan_id,
            metadata_workers,
            metadata_batch_size,
            thumbnail_workers,
            configured_metadata_workers,
            configured_thumbnail_workers,
            slow_mode
        );

        // Shared queues fed by the walk, drained by worker pools.
        let thumb_queue = Arc::new(WorkQueue::new(vec![]));
        let file_metadata_queue = Arc::new(WorkQueue::new(vec![]));

        // Install the queues so prioritize_queues can reach them.
        queues_for_thread.install(thumb_queue.clone(), file_metadata_queue.clone());

        let root_arc = Arc::new(root.clone());

        // ── Phase 2: Image Metadata workers ───────────────────────────────
        let metadata_handles: Vec<_> = (0..metadata_workers)
            .map(|_| {
                let queue = file_metadata_queue.clone();
                let app = app_clone.clone();
                let root = root_arc.clone();
                let cancelled = cancel_clone.clone();
                let batch_size = metadata_batch_size;
                std::thread::spawn(move || {
                    let mut batch_results = Vec::new();
                    let mut last_emit = std::time::Instant::now();
                    let emit_interval = std::time::Duration::from_millis(500);

                    while !cancelled.load(Ordering::Relaxed) {
                        let rel_paths = match queue.pop_batch_timeout(batch_size, emit_interval) {
                            crate::work_queue::PopResult::Items(items) => items,
                            crate::work_queue::PopResult::Timeout => {
                                if !batch_results.is_empty() {
                                    log::debug!(
                                        "[metadata] Emitting batch of {} results (timeout flush)",
                                        batch_results.len()
                                    );
                                    let _ = app.emit(
                                        "file_metadata_ready",
                                        FileMetadataReadyPayload {
                                            scan_id,
                                            results: std::mem::take(&mut batch_results),
                                        },
                                    );
                                    last_emit = std::time::Instant::now();
                                }
                                continue;
                            }
                            crate::work_queue::PopResult::Done => break,
                        };

                        let abs_paths: Vec<_> = rel_paths
                            .iter()
                            .map(|p| root.join(p.replace('/', std::path::MAIN_SEPARATOR_STR)))
                            .collect();

                        match scanner::read_file_metadata_batch(&rel_paths, &abs_paths) {
                            Ok(outcome) => {
                                log::debug!(
                                    "[metadata] Read {} successes and {} failures",
                                    outcome.results.len(),
                                    outcome.failures.len()
                                );

                                batch_results.extend(outcome.results);

                                let grouped_failures =
                                    scanner::group_metadata_failures(&outcome.failures);
                                for (error_msg, affected) in grouped_failures {
                                    let _ = app.emit(
                                        "worker_error",
                                        ApplicationErrorPayload {
                                            scan_id,
                                            severity: "error".to_string(),
                                            error_type: "metadata".to_string(),
                                            error_message: error_msg,
                                            affected_files: affected,
                                        },
                                    );
                                }
                            }
                            Err(error_msg) => {
                                log::error!("[metadata] Error reading metadata: {}", error_msg);

                                // Emit error to UI
                                let _ = app.emit(
                                    "worker_error",
                                    ApplicationErrorPayload {
                                        scan_id,
                                        severity: "error".to_string(),
                                        error_type: "metadata".to_string(),
                                        error_message: error_msg,
                                        affected_files: rel_paths.clone(),
                                    },
                                );
                            }
                        }

                        // Emit batch if enough time has elapsed
                        if last_emit.elapsed() >= emit_interval && !batch_results.is_empty() {
                            log::debug!(
                                "[metadata] Emitting batch of {} results",
                                batch_results.len()
                            );
                            let _ = app.emit(
                                "file_metadata_ready",
                                FileMetadataReadyPayload {
                                    scan_id,
                                    results: std::mem::take(&mut batch_results),
                                },
                            );
                            last_emit = std::time::Instant::now();
                        }
                    }

                    // Emit any remaining results
                    if !batch_results.is_empty() {
                        log::debug!(
                            "[metadata] Emitting final batch of {} results",
                            batch_results.len()
                        );
                        let _ = app.emit(
                            "file_metadata_ready",
                            FileMetadataReadyPayload {
                                scan_id,
                                results: batch_results,
                            },
                        );
                    }
                })
            })
            .collect();
        // ── Phase 3: thumbnail workers ────────────────────────────────────
        // All thumbnail producers send results through one channel. A single
        // emitter batches both extracted image thumbnails and immediate
        // audio/video placeholders before notifying the frontend.
        let (thumbnail_result_tx, thumbnail_result_rx) = mpsc::channel::<ThumbnailResult>();
        let thumbnail_emitter = {
            let app = app_clone.clone();
            std::thread::spawn(move || {
                let mut batch = Vec::with_capacity(50);
                let emit_interval = std::time::Duration::from_millis(500);

                loop {
                    match thumbnail_result_rx.recv_timeout(emit_interval) {
                        Ok(result) => batch.push(result),
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if !batch.is_empty() {
                                let _ = app.emit(
                                    "thumbnail_ready",
                                    ThumbnailReadyPayload {
                                        scan_id,
                                        results: std::mem::take(&mut batch),
                                    },
                                );
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            if !batch.is_empty() {
                                let _ = app.emit(
                                    "thumbnail_ready",
                                    ThumbnailReadyPayload {
                                        scan_id,
                                        results: batch,
                                    },
                                );
                            }
                            break;
                        }
                    }
                }
            })
        };

        let thumb_handles: Vec<_> = (0..thumbnail_workers)
            .map(|_| {
                let queue = thumb_queue.clone();
                let root = root_arc.clone();
                let cancelled = cancel_clone.clone();
                let result_tx = thumbnail_result_tx.clone();
                std::thread::spawn(move || {
                    while let Some(rel_path) = queue.pop() {
                        if cancelled.load(Ordering::Relaxed) {
                            break;
                        }

                        let abs = root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                        let _ = result_tx.send(ThumbnailResult {
                            relative_path: rel_path,
                            thumbnail: scanner::thumbnail_for(&abs),
                        });
                    }
                })
            })
            .collect();
        // ── Phase 1: streaming directory walk ─────────────────────────────
        // Run the directory walk in a separate thread so we can implement
        // timeout-based flushing even when the walk is slow.
        let file_queue = Arc::new(Mutex::new(Vec::new()));
        let file_queue_clone = file_queue.clone();
        let walk_complete = Arc::new(AtomicBool::new(false));
        let walk_complete_clone = walk_complete.clone();
        let cancel_walk = cancel_clone.clone();
        let file_metadata_queue_walk = file_metadata_queue.clone();
        let thumb_queue_walk = thumb_queue.clone();

        let thumbnail_result_tx_walk = thumbnail_result_tx.clone();
        let app_walk_err = app_clone.clone();
        let walk_handle = std::thread::spawn(move || {
            scanner::scan_folder(
                &root,
                cancel_walk,
                |file| {
                    file_metadata_queue_walk.push(file.relative_path.clone());
                    match file.media_kind {
                        scanner::MediaKind::Image => {
                            thumb_queue_walk.push(file.relative_path.clone());
                        }
                        scanner::MediaKind::Audio | scanner::MediaKind::Video => {
                            let _ = thumbnail_result_tx_walk.send(ThumbnailResult {
                                relative_path: file.relative_path.clone(),
                                thumbnail: scanner::placeholder_thumbnail(file.media_kind)
                                    .map(str::to_owned),
                            });
                        }
                    }
                    file_queue_clone.lock().unwrap().push(file);
                },
                |err| {
                    log::warn!("[walk] error: {} ({:?})", err.message, err.path);
                    let _ = app_walk_err.emit(
                        "worker_error",
                        ApplicationErrorPayload {
                            scan_id,
                            severity: "error".to_string(),
                            error_type: "scanner".to_string(),
                            error_message: err.message,
                            affected_files: err.path.into_iter().collect(),
                        },
                    );
                },
            );
            walk_complete_clone.store(true, Ordering::Relaxed);
        });

        // Flush thread: periodically emit batches even if no new files arrive
        let file_queue_flush = file_queue.clone();
        let app_flush = app_clone.clone();
        let walk_complete_flush = walk_complete.clone();
        let flush_handle = std::thread::spawn(move || {
            let emit_interval = std::time::Duration::from_millis(500);

            loop {
                std::thread::sleep(emit_interval);

                let mut queue = file_queue_flush.lock().unwrap();
                if !queue.is_empty() {
                    let batch = std::mem::take(&mut *queue);
                    drop(queue); // Release lock before emitting

                    let _ = app_flush.emit(
                        "file_found",
                        FileFoundPayload {
                            scan_id,
                            files: batch,
                        },
                    );
                } else {
                    drop(queue); // Release lock even if queue is empty
                }

                // Check if walk is complete
                if walk_complete_flush.load(Ordering::Relaxed) {
                    // One final flush
                    let mut queue = file_queue_flush.lock().unwrap();
                    if !queue.is_empty() {
                        let batch = std::mem::take(&mut *queue);
                        drop(queue);
                        let _ = app_flush.emit(
                            "file_found",
                            FileFoundPayload {
                                scan_id,
                                files: batch,
                            },
                        );
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
        file_metadata_queue.finish();
        thumb_queue.finish();

        // Wait for all workers to finish.
        for h in metadata_handles {
            let _ = h.join();
        }
        for h in thumb_handles {
            let _ = h.join();
        }
        drop(thumbnail_result_tx);
        let _ = thumbnail_emitter.join();
        // Clear the queue slots — but only if a newer scan hasn't already
        // installed its own queues here.  Without this guard, a fast
        // folder-switch can null out the new scan's queues and break
        // prioritize_queues / stop_scan for it.
        queues_for_thread.clear_if_mine(&thumb_queue, &file_metadata_queue);
    });

    Ok(())
}

#[tauri::command]
fn stop_scan(
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    scan_state.signal_cancellation();
    if let Some(q) = active_queues.thumbnails() {
        q.abort();
    }
    if let Some(q) = active_queues.file_metadata() {
        q.abort();
    }
    Ok(())
}

#[tauri::command]
fn prioritize_queues(
    visible_paths: Vec<String>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    if let Some(q) = active_queues.thumbnails() {
        q.prioritize(&visible_paths);
    }
    if let Some(q) = active_queues.file_metadata() {
        q.prioritize(&visible_paths);
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

/// Look up schema info for a single tag.  Returns `Ok(None)` when the registry
/// is built but the tag is unknown; returns `Err` only when the registry
/// itself could not be built.
#[tauri::command]
fn get_tag_info(id: tag_schema::SchemaDefinitionId) -> Result<Option<tag_schema::TagInfo>, String> {
    let registry = tag_schema::get_registry().map_err(|e| e.to_string())?;
    Ok(registry.lookup(&id).cloned())
}

/// Look up a deduplicated batch of exact schema definitions.
#[tauri::command]
fn get_tag_infos(
    ids: Vec<tag_schema::SchemaDefinitionId>,
) -> Result<Vec<tag_schema::TagInfo>, String> {
    let registry = tag_schema::get_registry().map_err(|e| e.to_string())?;
    Ok(registry.lookup_exact_batch(ids))
}

/// Eagerly warms the tag-schema registry so the first `get_tag_info` call is
/// instant.  Called once at startup; the front-end blocks its UI until this
/// resolves so editors never see a missing-schema flash.
#[tauri::command]
fn preload_schema() -> Result<(), String> {
    log::info!(
        "[startup] preload_schema enter +{}ms wall={}ms",
        since_startup_ms(),
        wall_ms()
    );
    let t = Instant::now();
    let r = tag_schema::get_registry()
        .map(|_| ())
        .map_err(|e| e.to_string());
    log::info!(
        "[startup] preload_schema exit took={}ms +{}ms wall={}ms",
        t.elapsed().as_millis(),
        since_startup_ms(),
        wall_ms()
    );
    r
}

/// Returns exact definitions supported by the metadata write pipeline.
/// Iteration is deterministic by `SchemaDefinitionId` as guaranteed by the underlying `BTreeMap`.
/// Used by the "Add New Property" dialog for autocomplete.
#[tauri::command]
fn list_writable_schema_definitions() -> Result<Vec<tag_schema::TagInfo>, String> {
    let registry = tag_schema::get_registry().map_err(|e| e.to_string())?;
    Ok(registry.all_supported_writable().cloned().collect())
}

// Target-aware draft persistence and apply are the sole metadata-editing boundary.
#[tauri::command]
fn save_metadata_draft_edits(
    folder_path: String,
    data: draft_edits::MetadataTargetDraftsByFile,
    app: AppHandle,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<(), String> {
    let app_data_dir = commands::shared::app_data_dir(&app)?;
    draft_edits::save_metadata_draft_edits(&app_data_dir, &folder_path, &data, &repository_state)
}

#[tauri::command]
fn load_metadata_draft_edits(
    folder_path: String,
    app: AppHandle,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<draft_edits::MetadataTargetDraftsByFile, String> {
    let app_data_dir = commands::shared::app_data_dir(&app)?;
    draft_edits::load_metadata_draft_edits(&app_data_dir, &folder_path, &repository_state)
}

/// Production occurrence-aware metadata apply.
#[tauri::command]
async fn apply_metadata_draft_edits_cmd(
    folder_path: String,
    rel_paths: Vec<String>,
    app: AppHandle,
    apply_state: State<'_, apply_batch::ApplyEditsState>,
) -> Result<apply_batch::MetadataApplyResult, String> {
    let app_settings = settings::load_settings(&commands::shared::app_data_dir(&app)?)?;
    let batch_size = usize::from(app_settings.metadata_apply_batch_size);
    let write_concurrency = usize::from(app_settings.metadata_apply_concurrency);
    log::info!(
        "[apply_edits] starting batch_size={} write_concurrency={} requested={}",
        batch_size,
        write_concurrency,
        rel_paths.len()
    );
    apply_batch::run_apply_edits_command(&apply_state, move |cancel_flag| {
        tauri::async_runtime::spawn_blocking(move || {
            apply_batch::run_apply_metadata_draft_edits_blocking(
                folder_path,
                rel_paths,
                app,
                cancel_flag,
                batch_size,
                write_concurrency,
            )
        })
    })
    .await
}

#[tauri::command]
fn cancel_apply_edits(apply_state: State<'_, apply_batch::ApplyEditsState>) -> Result<(), String> {
    apply_state.signal_cancel();
    Ok(())
}

fn clear_running(app: &AppHandle) {
    if let Some(state) = app.try_state::<ScanState>() {
        state.mark_finished();
    }
}

#[allow(clippy::items_after_test_module)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_concurrency_uses_configured_worker_counts() {
        assert_eq!(effective_scan_concurrency(3, 12, false), (3, 12));
    }

    #[test]
    fn slow_mode_overrides_configured_scan_concurrency() {
        assert_eq!(effective_scan_concurrency(16, 16, true), (1, 1));
    }

    fn command_target_schema() -> tag_schema::SchemaDefinitionId {
        tag_schema::SchemaDefinitionId {
            table: "Exif::Main".to_owned(),
            tag_id: "282".to_owned(),
            index: Some(0),
        }
    }

    fn command_target_edit(value: metadata_value::MetadataValue) -> draft_edits::MetadataDraftEdit {
        draft_edits::MetadataDraftEdit {
            value: Some(value),
            intent: draft_edits::EditIntent::Set,
        }
    }

    fn command_target_existing(path: &str, group1: &str) -> draft_edits::MetadataTargetDraftEntry {
        draft_edits::MetadataTargetDraftEntry {
            target: metadata_draft_target::MetadataDraftTarget::ExistingOccurrence {
                occurrence_id: metadata_occurrence::MetadataOccurrenceId {
                    document: Some("Doc1".to_owned()),
                    path: path.to_owned(),
                    runtime_tag_id: "282".to_owned(),
                    tag_id_scope: metadata_occurrence::RuntimeTagIdScope {
                        table: "Exif::Main".to_owned(),
                        tag_id: "282".to_owned(),
                        index: None,
                    },
                    copy: 2,
                },
                schema_id: command_target_schema(),
                write_target: metadata_occurrence::MetadataWriteTarget {
                    group1: group1.to_owned(),
                    group7: "ID-282".to_owned(),
                    tag_name: "XResolution".to_owned(),
                },
            },
            edit: command_target_edit(metadata_value::MetadataValue::Struct(
                std::collections::BTreeMap::from([(
                    "nested".to_owned(),
                    metadata_value::MetadataValue::List {
                        list_kind: metadata_value::ListKind::Seq,
                        items: vec![metadata_value::MetadataValue::Text("one".to_owned())],
                    },
                )]),
            )),
        }
    }

    fn command_target_new() -> draft_edits::MetadataTargetDraftEntry {
        draft_edits::MetadataTargetDraftEntry {
            target: metadata_draft_target::MetadataDraftTarget::NewProperty {
                schema_id: command_target_schema(),
                write_target: metadata_occurrence::MetadataWriteTarget {
                    group1: "IFD0".to_owned(),
                    group7: "ID-282".to_owned(),
                    tag_name: "XResolution".to_owned(),
                },
            },
            edit: command_target_edit(metadata_value::MetadataValue::Null),
        }
    }

    #[test]
    fn target_commands_round_trip_exact_target_aware_wire_shape() {
        let dir = tempfile::tempdir().unwrap();
        let folder_path = dir.path().to_string_lossy().into_owned();
        let ifd0 = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let ifd1 = command_target_existing("JPEG-APP1-IFD1", "IFD1");
        let created = command_target_new();
        let data = std::collections::HashMap::from([(
            "folder/file.jpg".to_owned(),
            vec![ifd0, ifd1, created],
        )]);

        std::fs::create_dir(dir.path().join("folder")).unwrap();
        std::fs::write(dir.path().join("folder/file.jpg"), b"photo").unwrap();
        let state = draft_edits::DraftRepositoryState::default();
        draft_edits::save_metadata_draft_edits(dir.path(), &folder_path, &data, &state).unwrap();
        let loaded =
            draft_edits::load_metadata_draft_edits(dir.path(), &folder_path, &state).unwrap();

        assert_eq!(loaded, data);
        let bytes =
            std::fs::read_to_string(dir.path().join("MediaLibraryTargetDraftEdits.jsonl")).unwrap();
        let line: serde_json::Value = serde_json::from_str(bytes.lines().nth(1).unwrap()).unwrap();
        assert_eq!(line["schema_version"], 6);
        assert!(
            line["photo_path"]
                .as_str()
                .unwrap()
                .ends_with("folder\\file.jpg")
                || line["photo_path"]
                    .as_str()
                    .unwrap()
                    .ends_with("folder/file.jpg")
        );
        let edits = line["edits"].as_array().unwrap();
        assert_eq!(edits.len(), 3);
        assert!(edits.iter().all(|entry| {
            entry.as_object().is_some_and(|object| {
                object.len() == 2
                    && object.contains_key("target")
                    && object.contains_key("edit")
                    && !object.contains_key("slot")
            })
        }));
    }

    #[test]
    fn target_commands_and_jsonl_preserve_proto_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let folder_path = dir.path().to_string_lossy().into_owned();
        let data = std::collections::HashMap::from([(
            "__proto__".to_owned(),
            vec![command_target_existing("JPEG-APP1-IFD0", "IFD0")],
        )]);

        std::fs::write(dir.path().join("__proto__"), b"photo").unwrap();
        let state = draft_edits::DraftRepositoryState::default();
        draft_edits::save_metadata_draft_edits(dir.path(), &folder_path, &data, &state).unwrap();
        let loaded =
            draft_edits::load_metadata_draft_edits(dir.path(), &folder_path, &state).unwrap();

        assert_eq!(loaded, data);
        assert_eq!(loaded["__proto__"].len(), 1);
        let bytes =
            std::fs::read_to_string(dir.path().join("MediaLibraryTargetDraftEdits.jsonl")).unwrap();
        let line: serde_json::Value = serde_json::from_str(bytes.lines().nth(1).unwrap()).unwrap();
        assert_eq!(line["schema_version"], 6);
        assert!(line["photo_path"].as_str().unwrap().ends_with("__proto__"));
    }

    #[test]
    fn target_save_command_rejects_duplicate_slots_before_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let folder_path = dir.path().to_string_lossy().into_owned();
        let draft_path = dir.path().join("MediaLibraryTargetDraftEdits.jsonl");
        let original = b"existing bytes survive\n";
        std::fs::write(&draft_path, original).unwrap();
        let entry = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let data =
            std::collections::HashMap::from([("file.jpg".to_owned(), vec![entry.clone(), entry])]);

        std::fs::write(dir.path().join("file.jpg"), b"photo").unwrap();
        let state = draft_edits::DraftRepositoryState::default();
        let error = draft_edits::save_metadata_draft_edits(dir.path(), &folder_path, &data, &state)
            .unwrap_err();

        assert!(error.contains("Duplicate metadata draft slot"), "{error}");
        assert_eq!(std::fs::read(draft_path).unwrap(), original);
    }

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
        assert!(!(*state.running.lock().unwrap()));
        assert!(
            state.signal_cancellation(),
            "cancellation flag should still be installed"
        );
        assert!(
            flag.load(Ordering::Relaxed),
            "workers should now see the cancellation"
        );
    }

    #[test]
    fn signal_cancellation_returns_false_when_no_flag_installed() {
        let state = ScanState::new();
        assert!(!state.signal_cancellation());
    }

    #[test]
    fn metadata_ready_payload_serializes_authoritative_occurrences_and_schema_projection() {
        use crate::metadata_occurrence::{
            MetadataOccurrence, MetadataOccurrenceId, MetadataOccurrences, MetadataWriteTarget,
        };
        use crate::metadata_value::MetadataValue;
        use crate::tag_schema::{SchemaDefinitionId, TagInfo, TagKind};

        let schema_id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "282".into(),
            index: None,
        };
        let tag_info = TagInfo {
            id: schema_id.clone(),
            group: "IFD0".into(),
            name: "XResolution".into(),
            writable: true,
            kind: TagKind::Rational,
            description: Some("X resolution".into()),
            storage_count: Some("1".into()),
        };
        let occurrence = |path: &str, copy: u32, group1: &str| MetadataOccurrence {
            id: MetadataOccurrenceId {
                document: None,
                path: path.into(),
                runtime_tag_id: "282".into(),
                tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                    table: "Exif::Main".into(),
                    tag_id: "282".into(),
                    index: None,
                },
                copy,
            },
            schema_id: schema_id.clone(),
            value: MetadataValue::Integer(300),
            tag_info: Some(tag_info.clone()),
            observed_selector: Some(crate::metadata_occurrence::MetadataObservedSelector {
                group1: group1.into(),
                group7: "ID-282".into(),
                tag_name: "XResolution".into(),
            }),
            write_target: Some(MetadataWriteTarget {
                group1: group1.into(),
                group7: "ID-282".into(),
                tag_name: "XResolution".into(),
            }),
        };
        let result = scanner::FileMetadata {
            relative_path: "file.jpg".into(),
            occurrences: MetadataOccurrences(vec![
                occurrence("JPEG-APP1-IFD0", 0, "IFD0"),
                occurrence("JPEG-APP1-IFD1", 2, "IFD1"),
            ]),
        };

        let json = serde_json::to_value(FileMetadataReadyPayload {
            scan_id: 7,
            results: vec![result],
        })
        .unwrap();
        let result = json["results"][0].as_object().unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(
            result
                .keys()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["occurrences", "relative_path"])
        );
        assert_eq!(result["occurrences"].as_array().unwrap().len(), 2);
        assert_eq!(result["occurrences"][1]["id"]["copy"], 2);
        assert_eq!(result["occurrences"][0]["tag_info"]["id"]["tag_id"], "282");
        assert_eq!(result["occurrences"][0]["value"]["kind"], "Integer");
        assert_eq!(result["occurrences"][0]["write_target"]["group1"], "IFD0");
        assert!(!result.contains_key("metadata"));
    }

    #[test]
    fn metadata_ready_failed_placeholder_serializes_empty_occurrences_only() {
        let result = scanner::FileMetadata {
            relative_path: "failed.jpg".into(),
            occurrences: crate::metadata_occurrence::MetadataOccurrences::default(),
        };
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 2);
        assert_eq!(json["occurrences"], serde_json::json!([]));
        assert!(json.get("metadata").is_none());
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

        // Wake-up should be prompt. Windows CI/dev machines can schedule
        // the helper thread late, so avoid making this a sub-50ms
        // scheduler benchmark.
        assert!(
            elapsed < Duration::from_millis(150),
            "wait_until_finished took {elapsed:?}, expected immediate wake"
        );
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
        assert!(aq.file_metadata().is_none());
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

        let installed_thumbs = aq
            .thumbnails()
            .expect("scan B's thumb queue must still be installed");
        let installed_metadata = aq
            .file_metadata()
            .expect("scan B's metadata queue must still be installed");
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

        assert!(
            aq.thumbnails().is_none(),
            "mine_thumbs should have been cleared"
        );
        let installed = aq.file_metadata().expect("other_metadata must remain");
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

    #[test]
    fn app_builder_registers_central_metadata_persistence_state() {
        let source = include_str!("lib.rs");
        assert!(source.contains(".manage(draft_edits::DraftRepositoryState::default())"));
        assert!(source.contains(".manage(apply_log::ApplyLogState::default())"));
    }
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTUP_INSTANT.set(Instant::now()).ok();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        chrono::Utc::now().format("%Y-%m-%d][%H:%M:%S%.3f"),
                        record.target(),
                        record.level(),
                        message
                    ))
                })
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("medialibrary".into()),
                    }),
                ])
                .max_file_size(10 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(ScanState::new())
        .manage(ActiveQueues::new())
        .manage(apply_batch::ApplyEditsState::new())
        .manage(openai_describe::DescribeState::default())
        .manage(draft_edits::DraftRepositoryState::default())
        .manage(apply_log::ApplyLogState::default())
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
            save_metadata_draft_edits,
            load_metadata_draft_edits,
            apply_metadata_draft_edits_cmd,
            cancel_apply_edits,
            get_tag_info,
            get_tag_infos,
            preload_schema,
            list_writable_schema_definitions,
            commands::settings::load_settings_cmd,
            commands::settings::save_settings_cmd,
            commands::settings::list_recommended_models,
            commands::settings::estimate_per_image_cost_cmd,
            commands::settings::estimate_per_image_normalise_cost_cmd,
            commands::settings::estimate_per_image_location_normalise_cost_cmd,
            commands::describe::estimate_describe_cost_cmd,
            commands::describe::describe_images_cmd,
            commands::describe::cancel_describe_cmd,
            commands::geocode::geocode_images_cmd,
            commands::geocode::cancel_geocode_cmd,
            commands::normalise::normalise_metadata_cmd,
            commands::normalise::cancel_normalise_cmd,
            commands::normalise::estimate_normalise_cost_cmd
        ])
        .setup(|_app| {
            log::info!(
                "[startup] tauri setup() callback fired +{}ms wall={}ms",
                since_startup_ms(),
                wall_ms()
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
