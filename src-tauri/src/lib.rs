pub mod apply_batch;
pub mod apply_edits;
pub mod apply_log;
#[cfg(all(test, feature = "integration"))]
mod apply_perf_experiment;
pub mod batch_audit_log;
pub mod batch_job;
mod bulk_metadata;
pub mod commands;
pub mod country_code;
pub mod describe_log;
pub mod draft_edits;
pub mod draft_reconciliation;
pub mod draft_repository;
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
mod recycle;
pub mod scanner;
pub mod search_service;
pub mod session;
mod session_commands;
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
use session_commands::*;
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

/// Emitted when the directory walk is complete (no payload needed).
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

pub(crate) fn emit_frontend_event<S: Serialize + Clone>(
    app: &AppHandle,
    event: &str,
    payload: S,
) -> Result<(), String> {
    app.emit(event, payload).map_err(|error| {
        log::error!("[frontend-event] failed to emit event={event}: {error}");
        error.to_string()
    })
}

fn commit_session_metadata(app: &AppHandle, session_id: u64, results: Vec<scanner::FileMetadata>) {
    if let Err(error) = app
        .state::<session::MediaLibrarySessionState>()
        .commit_metadata_results(session_id, results)
    {
        log::debug!("[session-metadata] discarded stale results: {error}");
    }
}

fn commit_session_thumbnails(app: &AppHandle, session_id: u64, results: Vec<ThumbnailResult>) {
    let results = results
        .into_iter()
        .map(|result| (result.relative_path, result.thumbnail))
        .collect();
    if let Err(error) = app
        .state::<session::MediaLibrarySessionState>()
        .commit_thumbnail_results(session_id, results)
    {
        log::debug!("[session-thumbnails] discarded stale results: {error}");
    }
}

#[tauri::command]
fn get_media_library_thumbnails(
    session_id: u64,
    cache_keys: Vec<String>,
    session: State<'_, session::MediaLibrarySessionState>,
) -> Result<Vec<session::MediaLibraryThumbnailPayload>, String> {
    session.thumbnail_payloads(session_id, &cache_keys)
}

fn record_session_issue(
    app: &AppHandle,
    session_id: u64,
    severity: &str,
    error_type: &str,
    error_message: String,
    affected_files: Vec<String>,
) {
    if let Err(error) = app.state::<session::MediaLibrarySessionState>().add_issue(
        session_id,
        severity.to_owned(),
        error_type.to_owned(),
        error_message,
        affected_files,
    ) {
        log::debug!("[session-issue] discarded stale issue: {error}");
    }
}

#[tauri::command]
fn get_media_library_session_snapshot(
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> session::MediaLibrarySessionSnapshot {
    session_state.snapshot()
}

#[tauri::command]
fn search_media_library_session(
    request: search_service::MediaLibrarySearchRequest,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<search_service::MediaLibrarySearchResult, String> {
    session_state.search().submit(request)
}

#[tauri::command]
fn dismiss_media_library_session_issue(
    issue_id: u64,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<(), String> {
    session_state.dismiss_issue(issue_id);
    Ok(())
}

#[tauri::command]
fn record_media_library_session_issue(
    session_id: u64,
    severity: String,
    error_type: String,
    error_message: String,
    affected_files: Vec<String>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionIssueAdded, String> {
    session_state.add_issue(
        session_id,
        severity,
        error_type,
        error_message,
        affected_files,
    )
}

#[tauri::command]
fn open_media_library_session(
    folder_path: String,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    stop_scan_impl(&scan_state, &active_queues);
    let opening = session_state.begin_open(folder_path.clone());
    let session_id = opening
        .session_id
        .ok_or_else(|| "Rust opened a session without an identity".to_string())?;
    let app_data_dir = match commands::shared::app_data_dir(&app) {
        Ok(path) => path,
        Err(error) => return session_state.fail_session(session_id, "session-open", error),
    };
    let drafts =
        draft_repository::load_metadata_draft_edits(&app_data_dir, &folder_path, &repository_state);
    session_state.install_draft_load_result(session_id, drafts)
}

#[tauri::command]
fn close_media_library_session(
    session_id: u64,
    session_state: State<'_, session::MediaLibrarySessionState>,
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    session_state.begin_close(session_id)?;
    stop_scan_impl(&scan_state, &active_queues);
    session_state.finish_close(session_id)
}
/// Start a background scan of `folder_path`.
///
/// Three concurrent phases, all starting as soon as files are discovered:
///
///  Phase 1 — streaming file discovery (single thread):
///    Walks the directory tree. Discovered files are committed to the Rust
///    session in bounded batches before a revisioned delta is emitted. The
///    authoritative session snapshot records when discovery has finished.
///
///  Phase 2 — Image Metadata (thread pool, starts alongside phase 1):
///    Reads EXIF data per file and commits revisioned metadata deltas.
///
///  Phase 3 — thumbnail generation (thread pool, starts alongside phase 1):
///    Generates thumbnails and commits revisioned thumbnail deltas.
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
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<(), String> {
    let current_session = session_state.snapshot();
    if current_session.session_id != Some(scan_id)
        || current_session.folder.as_deref() != Some(folder_path.as_str())
        || current_session.lifecycle != session::MediaLibrarySessionLifecycle::Opening
    {
        return Err("The requested scan does not match the active media-library session".into());
    }
    let fail_start = |error: String| -> Result<(), String> {
        session_state
            .fail_session(scan_id, "scan", error)
            .map(|_| ())
    };
    let root = std::path::PathBuf::from(&folder_path);
    if !root.is_dir() {
        return fail_start(format!("{} is not a directory", folder_path));
    }
    let app_data_dir = match commands::shared::app_data_dir(&app) {
        Ok(path) => path,
        Err(error) => return fail_start(error),
    };
    let app_settings = match settings::load_settings(&app_data_dir) {
        Ok(settings) => settings,
        Err(error) => return fail_start(error),
    };
    let configured_metadata_workers = usize::from(app_settings.metadata_scan_concurrency);
    let configured_thumbnail_workers = usize::from(app_settings.thumbnail_concurrency);
    let metadata_batch_size = usize::from(app_settings.metadata_scan_batch_size);

    if !scan_state.wait_until_finished(Duration::from_secs(1)) {
        log::error!("[start_scan] Previous scan did not finish in time");
        return fail_start("A scan is already in progress and could not be stopped".into());
    }
    scan_state.mark_running();

    let cancellation_flag = scan_state.install_cancellation();

    // Hand a cloned ActiveQueues to the worker thread.  The clone shares the
    // same inner Arc<Mutex<...>> slots, so install/clear_if_mine see the live
    // state observed by stop_scan and prioritize_queues.
    let queues_for_thread = (*active_queues).clone();
    let app_clone = app.clone();
    let cancel_clone = cancellation_flag.clone();

    session_state.mark_loaded(scan_id, &folder_path)?;

    std::thread::spawn(move || {
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
                                    commit_session_metadata(
                                        &app,
                                        scan_id,
                                        std::mem::take(&mut batch_results),
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
                                    record_session_issue(
                                        &app, scan_id, "error", "metadata", error_msg, affected,
                                    );
                                }
                            }
                            Err(error_msg) => {
                                log::error!("[metadata] Error reading metadata: {}", error_msg);

                                record_session_issue(
                                    &app,
                                    scan_id,
                                    "error",
                                    "metadata",
                                    error_msg,
                                    rel_paths.clone(),
                                );
                            }
                        }

                        // Emit batch if enough time has elapsed
                        if last_emit.elapsed() >= emit_interval && !batch_results.is_empty() {
                            log::debug!(
                                "[metadata] Emitting batch of {} results",
                                batch_results.len()
                            );
                            commit_session_metadata(
                                &app,
                                scan_id,
                                std::mem::take(&mut batch_results),
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
                        commit_session_metadata(&app, scan_id, batch_results);
                    }
                })
            })
            .collect();
        // ── Phase 3: thumbnail workers ────────────────────────────────────
        // Every supported media path is resolved by the same thumbnail dispatcher.
        // A single emitter batches real image thumbnails and non-image placeholders
        // before notifying the frontend.
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
                                commit_session_thumbnails(
                                    &app,
                                    scan_id,
                                    std::mem::take(&mut batch),
                                );
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            if !batch.is_empty() {
                                commit_session_thumbnails(&app, scan_id, batch);
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
                            thumbnail: scanner::thumbnail_for_media(&abs),
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

        let app_walk_err = app_clone.clone();
        let walk_handle = std::thread::spawn(move || {
            scanner::scan_folder(
                &root,
                cancel_walk,
                |file| {
                    file_metadata_queue_walk.push(file.relative_path.clone());
                    thumb_queue_walk.push(file.relative_path.clone());
                    file_queue_clone.lock().unwrap().push(file);
                },
                |err| {
                    log::warn!("[walk] error: {} ({:?})", err.message, err.path);
                    record_session_issue(
                        &app_walk_err,
                        scan_id,
                        "error",
                        "scanner",
                        err.message,
                        err.path.into_iter().collect(),
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

                    match app_flush
                        .state::<session::MediaLibrarySessionState>()
                        .add_files(scan_id, batch)
                    {
                        Ok(_) => {}
                        Err(error) => {
                            log::debug!("[file-discovery] discarded stale batch: {error}")
                        }
                    }
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
                        match app_flush
                            .state::<session::MediaLibrarySessionState>()
                            .add_files(scan_id, batch)
                        {
                            Ok(_) => {}
                            Err(error) => {
                                log::debug!("[file-discovery] discarded stale final batch: {error}")
                            }
                        }
                    }
                    break;
                }
            }
        });

        // Wait for walk to complete
        walk_handle.join().unwrap();
        flush_handle.join().unwrap();

        let _ = app_clone
            .state::<session::MediaLibrarySessionState>()
            .finish_discovery(scan_id);
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

fn stop_scan_impl(scan_state: &ScanState, active_queues: &ActiveQueues) {
    scan_state.signal_cancellation();
    if let Some(q) = active_queues.thumbnails() {
        q.abort();
    }
    if let Some(q) = active_queues.file_metadata() {
        q.abort();
    }
}

#[tauri::command]
fn stop_scan(
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<(), String> {
    stop_scan_impl(&scan_state, &active_queues);
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
fn recycle_media_files(
    folder: String,
    relative_paths: Vec<String>,
    app: AppHandle,
    active_queues: State<'_, ActiveQueues>,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<recycle::RecycleFilesResult, String> {
    log::info!(
        "[recycle] command folder={folder} requested={} paths={relative_paths:?}",
        relative_paths.len()
    );
    let result = match recycle::recycle_files_with(&folder, relative_paths, |path| {
        trash::delete(path).map_err(|error| error.to_string())
    }) {
        Ok(result) => result,
        Err(error) => {
            log::error!(
                "[recycle] aborted before any file was touched folder={folder} error={error}"
            );
            return Err(error);
        }
    };
    let recycled_paths: Vec<String> = result
        .results
        .iter()
        .filter(|item| item.recycled)
        .map(|item| item.relative_path.clone())
        .collect();
    for item in result.results.iter().filter(|item| !item.recycled) {
        log::warn!(
            "[recycle] failed relative_path={} error={}",
            item.relative_path,
            item.error.as_deref().unwrap_or("unknown error")
        );
    }
    log::info!(
        "[recycle] result recycled={} failed={} requested={}",
        recycled_paths.len(),
        result.results.len() - recycled_paths.len(),
        result.results.len()
    );
    if let Some(queue) = active_queues.thumbnails() {
        let pending_before = queue.len();
        queue.remove_paths(&recycled_paths);
        log::info!(
            "[recycle] thumbnail queue removed_requested={} pending={pending_before}->{}",
            recycled_paths.len(),
            queue.len()
        );
    }
    if let Some(queue) = active_queues.file_metadata() {
        let pending_before = queue.len();
        queue.remove_paths(&recycled_paths);
        log::info!(
            "[recycle] metadata queue removed_requested={} pending={pending_before}->{}",
            recycled_paths.len(),
            queue.len()
        );
    }
    if !recycled_paths.is_empty() {
        let (active_session_id, active_folder, draft_paths) = session_state.inspect(|active| {
            let draft_paths = recycled_paths
                .iter()
                .filter(|path| active.drafts.contains_key(path.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            (active.session_id, active.folder.clone(), draft_paths)
        });
        let session_id = match active_session_id {
            Some(session_id) => session_id,
            None => {
                log::error!("[recycle] no active media-library session to update");
                return Err("No active media-library session".to_string());
            }
        };
        if active_folder.as_deref() != Some(folder.as_str()) {
            log::error!(
                "[recycle] session folder changed session_folder={:?} command_folder={folder}",
                active_folder
            );
            return Err(
                "The media-library session changed before recycled drafts were removed".into(),
            );
        }
        let draft_mutations = draft_paths
            .into_iter()
            .map(|relative_path| draft_repository::MetadataDraftRowMutation {
                relative_path,
                entries: Vec::new(),
            })
            .collect::<Vec<_>>();
        if !draft_mutations.is_empty() {
            let draft_paths: Vec<&str> = draft_mutations
                .iter()
                .map(|mutation| mutation.relative_path.as_str())
                .collect();
            let app_data_dir = commands::shared::app_data_dir(&app)?;
            if let Err(error) = draft_repository::apply_row_mutations(
                &app_data_dir,
                &folder,
                &draft_mutations,
                &repository_state,
            ) {
                log::error!(
                    "[recycle] draft repository mutation failed paths={draft_paths:?} error={error}"
                );
                let _ = session_state.mark_draft_save_failed(session_id, error.clone());
                return Err(error);
            }
            log::info!(
                "[recycle] draft rows cleared count={} paths={draft_paths:?}",
                draft_mutations.len()
            );
        }
        if let Err(error) = session_state.remove_files(session_id, &recycled_paths) {
            log::error!(
                "[recycle] session remove_files failed paths={recycled_paths:?} error={error}"
            );
            return Err(error);
        }
    } else {
        log::info!("[recycle] nothing was recycled; no state stores to update");
    }
    Ok(result)
}

#[tauri::command]
fn show_in_explorer(folder: String, relative_path: String) -> Result<(), String> {
    let mut path = std::path::PathBuf::from(folder);
    for component in relative_path.split('/') {
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
        .set_title(&display_window_title(&title))
        .map_err(|e| e.to_string())
}

fn display_window_title(title: &str) -> String {
    if cfg!(debug_assertions) {
        format!("{title} (DEBUG)")
    } else {
        title.to_owned()
    }
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
    Ok(registry.schema_writable_transport_set().cloned().collect())
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
    fn draft_mutations_are_rejected_while_apply_is_running() {
        let state = session::MediaLibrarySessionState::new();
        let opening = state.begin_open("C:/photos".into());
        let session_id = opening.session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(Default::default()))
            .unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();

        assert!(ensure_session_draft_mutation_allowed(&state.snapshot()).is_ok());
        state
            .begin_apply_operation(session_id, "apply-1".into(), None)
            .unwrap();
        assert_eq!(
            ensure_session_draft_mutation_allowed(&state.snapshot()).unwrap_err(),
            "Drafts cannot be changed while metadata apply is running"
        );

        state
            .fail_apply_operation(session_id, "apply-1", "stopped".into())
            .unwrap();
        assert!(ensure_session_draft_mutation_allowed(&state.snapshot()).is_ok());
    }

    #[test]
    fn normalise_schema_allowlist_uses_the_confirmed_group_snapshot() {
        let description = tag_schema::SchemaDefinitionId {
            table: "XMP::dc".to_owned(),
            tag_id: "description".to_owned(),
            index: None,
        };
        assert!(is_normalise_schema(
            &description,
            &[normalise::NormaliseGroup::Description],
        ));
        assert!(!is_normalise_schema(
            &description,
            &[normalise::NormaliseGroup::Title],
        ));
    }

    #[test]
    fn normalise_schema_allowlist_rejects_indexed_variants() {
        let indexed = tag_schema::SchemaDefinitionId {
            table: "XMP::dc".to_owned(),
            tag_id: "description".to_owned(),
            index: Some(0),
        };
        assert!(!is_normalise_schema(
            &indexed,
            &[normalise::NormaliseGroup::Description],
        ));
    }

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

    fn command_target_occurrence(
        path: &str,
        group1: &str,
    ) -> metadata_occurrence::MetadataOccurrence {
        let entry = command_target_existing(path, group1);
        let metadata_draft_target::MetadataDraftTarget::ExistingOccurrence {
            occurrence_id,
            schema_id,
            write_target,
        } = entry.target
        else {
            panic!("expected ExistingOccurrence target");
        };
        metadata_occurrence::MetadataOccurrence {
            id: occurrence_id,
            schema_id: schema_id.clone(),
            value: metadata_value::MetadataValue::Text("300".to_owned()),
            tag_info: Some(tag_schema::TagInfo {
                id: schema_id,
                group0: Some("EXIF".to_owned()),
                group: group1.to_owned(),
                name: "XResolution".to_owned(),
                writable: true,
                kind: tag_schema::TagKind::Text,
                description: None,
                storage_count: None,
            }),
            observed_selector: None,
            write_target: Some(write_target),
        }
    }

    fn command_target_snapshot(
        occurrences: Vec<metadata_occurrence::MetadataOccurrence>,
        drafts: Vec<draft_edits::MetadataTargetDraftEntry>,
    ) -> session::MediaLibrarySessionSnapshot {
        session::MediaLibrarySessionSnapshot {
            session_id: Some(7),
            revision: 1,
            lifecycle: session::MediaLibrarySessionLifecycle::Loaded,
            folder: Some("/files".to_owned()),
            files: Vec::new(),
            discovery_running: false,
            issues: Vec::new(),
            metadata: vec![session::MediaLibrarySessionFileMetadata {
                relative_path: "target.jpg".to_owned(),
                state: session::MediaLibrarySessionMetadataState::Ready {
                    occurrences: metadata_occurrence::MetadataOccurrences(occurrences),
                },
            }],
            thumbnails: Vec::new(),
            drafts: if drafts.is_empty() {
                Default::default()
            } else {
                std::collections::HashMap::from([("target.jpg".to_owned(), drafts)])
            },
            draft_persistence: session::MediaLibrarySessionDraftPersistenceState::Ready,
            apply_operation: None,
            verification_outcomes: Default::default(),
            batch_operations: Default::default(),
        }
    }

    #[test]
    fn new_property_validation_uses_authoritative_destination_occupancy() {
        let schema = tag_schema::SchemaDefinitionId {
            table: "GPS::Main".to_owned(),
            tag_id: "2".to_owned(),
            index: None,
        };
        let registry = tag_schema::get_registry().unwrap();
        let info = registry.lookup(&schema).unwrap().clone();
        let target = metadata_draft_target::MetadataDraftTarget::from_new_property(&info).unwrap();
        let write_target = target.write_target().unwrap().clone();
        let occurrence = |group1: &str| metadata_occurrence::MetadataOccurrence {
            id: metadata_occurrence::MetadataOccurrenceId {
                document: None,
                path: format!("JPEG-APP1-{group1}"),
                runtime_tag_id: "2".to_owned(),
                tag_id_scope: metadata_occurrence::RuntimeTagIdScope {
                    table: schema.table.clone(),
                    tag_id: schema.tag_id.clone(),
                    index: None,
                },
                copy: 0,
            },
            schema_id: schema.clone(),
            value: metadata_value::MetadataValue::Real(1.0),
            tag_info: Some(info.clone()),
            observed_selector: Some(metadata_occurrence::MetadataObservedSelector {
                group1: group1.to_owned(),
                group7: write_target.group7.clone(),
                tag_name: write_target.tag_name.clone(),
            }),
            write_target: Some(metadata_occurrence::MetadataWriteTarget {
                group1: group1.to_owned(),
                group7: write_target.group7.clone(),
                tag_name: write_target.tag_name.clone(),
            }),
        };
        let distinct = occurrence("CustomGPS");
        let distinct_snapshot = command_target_snapshot(vec![distinct], Vec::new());
        validate_exact_session_draft_target(&distinct_snapshot, "target.jpg", &target).unwrap();

        let occupied = occurrence(&write_target.group1);
        let occupied_snapshot = command_target_snapshot(vec![occupied], Vec::new());
        assert!(
            validate_exact_session_draft_target(&occupied_snapshot, "target.jpg", &target)
                .unwrap_err()
                .contains("already present")
        );

        let pending = draft_edits::MetadataTargetDraftEntry {
            target: metadata_draft_target::MetadataDraftTarget::NewProperty {
                schema_id: command_target_schema(),
                write_target,
            },
            edit: command_target_edit(metadata_value::MetadataValue::Null),
        };
        let pending_snapshot = command_target_snapshot(Vec::new(), vec![pending]);
        assert!(
            validate_exact_session_draft_target(&pending_snapshot, "target.jpg", &target)
                .unwrap_err()
                .contains("pending draft")
        );
    }

    #[test]
    fn multi_target_discard_removes_only_requested_exact_slots() {
        let ifd0 = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let ifd1 = command_target_existing("JPEG-APP1-IFD1", "IFD1");
        let created = command_target_new();
        let entries = vec![ifd0.clone(), ifd1.clone(), created.clone()];

        let remaining = discard_exact_session_draft_targets(
            &entries,
            &[ifd0.target.clone(), created.target.clone()],
        )
        .expect("requested slots should be removed");

        assert_eq!(remaining, vec![ifd1]);
    }
    #[test]
    fn multi_target_discard_is_a_noop_for_empty_or_missing_targets() {
        let existing = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let missing = command_target_existing("JPEG-APP1-IFD1", "IFD1");

        assert!(
            discard_exact_session_draft_targets(std::slice::from_ref(&existing), &[]).is_none()
        );
        assert!(discard_exact_session_draft_targets(
            std::slice::from_ref(&existing),
            &[missing.target],
        )
        .is_none());
    }

    #[test]
    fn new_property_replacement_moves_the_exact_entry_and_preserves_the_edit() {
        let original = command_target_new();
        let mut replacement_target = original.target.clone();
        let metadata_draft_target::MetadataDraftTarget::NewProperty { write_target, .. } =
            &mut replacement_target
        else {
            panic!("expected NewProperty target");
        };
        write_target.group1 = "XMP".to_owned();

        let replaced = replace_exact_new_property_session_draft(
            std::slice::from_ref(&original),
            &original.target,
            &replacement_target,
            &original.edit,
        )
        .unwrap()
        .expect("a different destination should move the draft");

        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].target, replacement_target);
        assert_eq!(replaced[0].edit, original.edit);
    }

    #[test]
    fn new_property_replacement_rejects_stale_original_and_schema_changes() {
        let original = command_target_new();
        let stale_edit =
            command_target_edit(metadata_value::MetadataValue::Text("changed".to_owned()));
        let stale_error = replace_exact_new_property_session_draft(
            std::slice::from_ref(&original),
            &original.target,
            &original.target,
            &stale_edit,
        )
        .unwrap_err();
        assert!(stale_error.contains("changed or disappeared"));

        let mut changed_schema = original.target.clone();
        let metadata_draft_target::MetadataDraftTarget::NewProperty { schema_id, .. } =
            &mut changed_schema
        else {
            panic!("expected NewProperty target");
        };
        schema_id.tag_id = "283".to_owned();
        let schema_error = replace_exact_new_property_session_draft(
            std::slice::from_ref(&original),
            &original.target,
            &changed_schema,
            &original.edit,
        )
        .unwrap_err();
        assert!(schema_error.contains("exact schema"));
    }

    #[test]
    fn exact_target_removal_stages_existing_delete_and_cancels_new_property() {
        let existing = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let created = command_target_new();
        let planned = plan_exact_session_target_removals(
            std::slice::from_ref(&created),
            &[existing.target.clone(), created.target.clone()],
        )
        .unwrap()
        .expect("the exact targets should change the draft row");

        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].target, existing.target);
        assert_eq!(planned[0].edit.intent, draft_edits::EditIntent::Delete);
        assert_eq!(planned[0].edit.value, None);
    }

    #[test]
    fn exact_target_removal_preview_reports_authoritative_counts() {
        let existing = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let created = command_target_new();
        let mut already_deleted = command_target_existing("JPEG-APP1-IFD1", "IFD1");
        already_deleted.edit = draft_edits::MetadataDraftEdit {
            intent: draft_edits::EditIntent::Delete,
            value: None,
        };
        let preview = preview_exact_session_target_removals(
            &[created.clone(), already_deleted.clone()],
            &[existing.target, created.target, already_deleted.target],
        )
        .unwrap();

        assert_eq!(preview.existing_fields_to_delete, 1);
        assert_eq!(preview.staged_creations_to_cancel, 1);
        assert_eq!(preview.no_op_targets, 1);
        assert_eq!(preview.affected_count, 2);
    }

    #[test]
    fn exact_target_removal_rejects_duplicate_and_stale_slots_atomically() {
        let existing = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let duplicate_error = plan_exact_session_target_removals(
            &[],
            &[existing.target.clone(), existing.target.clone()],
        )
        .unwrap_err();
        assert!(duplicate_error.contains("same logical target slot"));

        let mut stale_owner = existing.clone();
        let metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { write_target, .. } =
            &mut stale_owner.target
        else {
            panic!("expected ExistingOccurrence target");
        };
        write_target.group1 = "IFD1".to_owned();
        let stale_error = plan_exact_session_target_removals(
            std::slice::from_ref(&stale_owner),
            std::slice::from_ref(&existing.target),
        )
        .unwrap_err();
        assert!(stale_error.contains("stale complete target"));
    }

    #[test]
    fn schema_removal_deletes_all_authoritative_occurrences_and_cancels_creation() {
        let occurrences = metadata_occurrence::MetadataOccurrences(vec![
            command_target_occurrence("JPEG-APP1-IFD0", "IFD0"),
            command_target_occurrence("JPEG-APP1-IFD1", "IFD1"),
        ]);
        let created = command_target_new();
        let planned = plan_session_schema_removal(
            &occurrences,
            std::slice::from_ref(&created),
            &command_target_schema(),
        )
        .unwrap()
        .expect("existing occurrences and a staged creation should change the row");

        assert_eq!(planned.len(), 2);
        assert!(planned.iter().all(|entry| {
            entry.target.is_existing_occurrence()
                && entry.edit.intent == draft_edits::EditIntent::Delete
                && entry.edit.value.is_none()
        }));
    }

    #[test]
    fn schema_removal_is_noop_when_absent_and_rejects_stale_existing_owner() {
        let empty = metadata_occurrence::MetadataOccurrences(Vec::new());
        assert!(
            plan_session_schema_removal(&empty, &[], &command_target_schema())
                .unwrap()
                .is_none()
        );

        let stale = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let error = plan_session_schema_removal(
            &empty,
            std::slice::from_ref(&stale),
            &command_target_schema(),
        )
        .unwrap_err();
        assert!(error.contains("exact authoritative occurrence is missing"));
    }

    #[test]
    fn gps_planner_resolves_semantic_edits_and_rejects_invalid_batches() {
        let schema = tag_schema::SchemaDefinitionId {
            table: "GPS::Main".to_owned(),
            tag_id: "2".to_owned(),
            index: None,
        };
        let occurrence = metadata_occurrence::MetadataOccurrence {
            id: metadata_occurrence::MetadataOccurrenceId {
                document: None,
                path: "JPEG-APP1-GPS".to_owned(),
                runtime_tag_id: "2".to_owned(),
                tag_id_scope: metadata_occurrence::RuntimeTagIdScope {
                    table: "GPS::Main".to_owned(),
                    tag_id: "2".to_owned(),
                    index: None,
                },
                copy: 0,
            },
            schema_id: schema.clone(),
            value: metadata_value::MetadataValue::Real(1.0),
            tag_info: Some(tag_schema::TagInfo {
                id: schema.clone(),
                group0: Some("EXIF".to_owned()),
                group: "GPS".to_owned(),
                name: "GPSLatitude".to_owned(),
                writable: true,
                kind: tag_schema::TagKind::Real,
                description: None,
                storage_count: None,
            }),
            observed_selector: None,
            write_target: Some(metadata_occurrence::MetadataWriteTarget {
                group1: "GPS".to_owned(),
                group7: "ID-2".to_owned(),
                tag_name: "GPSLatitude".to_owned(),
            }),
        };
        let target =
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(&occurrence)
                .unwrap();
        let incoming = draft_edits::SchemaMetadataEdit {
            schema_id: schema,
            edit: command_target_edit(metadata_value::MetadataValue::Real(-0.0)),
        };
        let snapshot = session::MediaLibrarySessionSnapshot {
            session_id: Some(7),
            revision: 1,
            lifecycle: session::MediaLibrarySessionLifecycle::Loaded,
            folder: Some("/files".to_owned()),
            files: Vec::new(),
            discovery_running: false,
            issues: Vec::new(),
            metadata: vec![session::MediaLibrarySessionFileMetadata {
                relative_path: "gps.jpg".to_owned(),
                state: session::MediaLibrarySessionMetadataState::Ready {
                    occurrences: metadata_occurrence::MetadataOccurrences(vec![occurrence]),
                },
            }],
            thumbnails: Vec::new(),
            drafts: Default::default(),
            draft_persistence: session::MediaLibrarySessionDraftPersistenceState::Ready,
            apply_operation: None,
            verification_outcomes: Default::default(),
            batch_operations: Default::default(),
        };

        let planned =
            plan_session_gps_drafts(&snapshot, "gps.jpg", std::slice::from_ref(&incoming)).unwrap();
        assert_eq!(planned[0].target, target);
        assert_eq!(planned[0].edit, incoming.edit);
        assert!(matches!(
            planned[0].edit.value,
            Some(metadata_value::MetadataValue::Real(value)) if value == 0.0 && value.is_sign_negative()
        ));

        let duplicate =
            plan_session_gps_drafts(&snapshot, "gps.jpg", &[incoming.clone(), incoming.clone()])
                .unwrap_err();
        assert!(duplicate.contains("same exact schema"));

        let non_gps_entry = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let non_gps = draft_edits::SchemaMetadataEdit {
            schema_id: non_gps_entry.target.schema_id().clone(),
            edit: non_gps_entry.edit,
        };
        let error = plan_session_gps_drafts(&snapshot, "gps.jpg", &[non_gps]).unwrap_err();
        assert!(error.contains("only exact GPS"));
    }

    #[test]
    fn target_commands_round_trip_exact_target_aware_sqlite_rows() {
        let dir = tempfile::tempdir().unwrap();
        let folder_path = dir.path().to_string_lossy().into_owned();
        let ifd0 = command_target_existing("JPEG-APP1-IFD0", "IFD0");
        let ifd1 = command_target_existing("JPEG-APP1-IFD1", "IFD1");
        let created = command_target_new();
        let entries = vec![ifd0, ifd1, created];

        std::fs::create_dir(dir.path().join("folder")).unwrap();
        std::fs::write(dir.path().join("folder/file.jpg"), b"photo").unwrap();
        let state = draft_edits::DraftRepositoryState::default();
        draft_repository::apply_row_mutations(
            dir.path(),
            &folder_path,
            &[draft_repository::MetadataDraftRowMutation {
                relative_path: "folder/file.jpg".to_owned(),
                entries: entries.clone(),
            }],
            &state,
        )
        .unwrap();
        let loaded =
            draft_repository::load_metadata_draft_edits(dir.path(), &folder_path, &state).unwrap();

        assert_eq!(loaded["folder/file.jpg"], entries);
        assert!(draft_repository::database_file_path(dir.path()).exists());
    }

    #[test]
    fn target_commands_and_sqlite_preserve_proto_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let folder_path = dir.path().to_string_lossy().into_owned();
        let entries = vec![command_target_existing("JPEG-APP1-IFD0", "IFD0")];

        std::fs::write(dir.path().join("__proto__"), b"photo").unwrap();
        let state = draft_edits::DraftRepositoryState::default();
        draft_repository::apply_row_mutations(
            dir.path(),
            &folder_path,
            &[draft_repository::MetadataDraftRowMutation {
                relative_path: "__proto__".to_owned(),
                entries: entries.clone(),
            }],
            &state,
        )
        .unwrap();
        let loaded =
            draft_repository::load_metadata_draft_edits(dir.path(), &folder_path, &state).unwrap();

        assert_eq!(loaded["__proto__"], entries);
        assert_eq!(loaded["__proto__"].len(), 1);
    }

    #[test]
    fn target_save_command_rejects_duplicate_slots_without_inserting_a_row() {
        let dir = tempfile::tempdir().unwrap();
        let folder_path = dir.path().to_string_lossy().into_owned();
        let entry = command_target_existing("JPEG-APP1-IFD0", "IFD0");

        std::fs::write(dir.path().join("file.jpg"), b"photo").unwrap();
        let state = draft_edits::DraftRepositoryState::default();
        let error = draft_repository::apply_row_mutations(
            dir.path(),
            &folder_path,
            &[draft_repository::MetadataDraftRowMutation {
                relative_path: "file.jpg".to_owned(),
                entries: vec![entry.clone(), entry],
            }],
            &state,
        )
        .unwrap_err();

        assert!(error.contains("Duplicate metadata draft slot"), "{error}");
        assert!(
            draft_repository::load_metadata_draft_edits(dir.path(), &folder_path, &state,)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn mark_finished_keeps_cancellation_flag_so_late_stop_scan_can_signal_workers() {
        // After discovery completes the workers may still be draining for several seconds.
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
            group0: Some("EXIF".into()),
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

        let json = serde_json::to_value(session::MediaLibrarySessionMetadataChanged {
            session_id: 7,
            revision: 3,
            entries: vec![session::MediaLibrarySessionFileMetadata {
                relative_path: result.relative_path,
                state: session::MediaLibrarySessionMetadataState::Ready {
                    occurrences: result.occurrences,
                },
            }],
        })
        .unwrap();
        let entry = json["entries"][0].as_object().unwrap();
        assert_eq!(entry.len(), 2);
        assert_eq!(entry["relative_path"], "file.jpg");
        let state = entry["state"].as_object().unwrap();
        assert_eq!(state["status"], "ready");
        assert_eq!(state["occurrences"].as_array().unwrap().len(), 2);
        assert_eq!(state["occurrences"].as_array().unwrap().len(), 2);
        assert_eq!(state["occurrences"][1]["id"]["copy"], 2);
        assert_eq!(state["occurrences"][0]["tag_info"]["id"]["tag_id"], "282");
        assert_eq!(state["occurrences"][0]["value"]["kind"], "Integer");
        assert_eq!(state["occurrences"][0]["write_target"]["group1"], "IFD0");
        assert!(!state.contains_key("metadata"));
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
        // condvar-based wait wakes immediately, not on a polling tick. The wake
        // latency is measured from a timestamp recorded inside the waker thread
        // right before mark_finished, so the helper thread's own scheduling
        // delay cannot flake the promptness assertion.
        let state = Arc::new(ScanState::new());
        state.mark_running();

        let waker = state.clone();
        let waker_ts = Arc::new(Mutex::new(None::<Instant>));
        let waker_ts_clone = waker_ts.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            *waker_ts_clone.lock().unwrap() = Some(Instant::now());
            waker.mark_finished();
        });

        let start = std::time::Instant::now();
        assert!(state.wait_until_finished(Duration::from_secs(5)));
        let elapsed = start.elapsed();
        let mark_finished_at = waker_ts
            .lock()
            .unwrap()
            .expect("waker thread must have recorded its timestamp");
        let wake_latency = mark_finished_at.elapsed();

        // The wait must block until mark_finished is observed; a regression
        // that returned immediately while running would miss this bound. The
        // waker sleeps 20ms first, so the bound is safe under scheduler load.
        assert!(
            elapsed >= Duration::from_millis(15),
            "wait_until_finished returned without waiting: {elapsed:?}"
        );
        // A condvar notify wakes in microseconds; a reverted 50ms poll loop
        // would add up to one poll tick. Only the wake itself is timed, so a
        // late-scheduled waker thread cannot flake this assertion.
        assert!(
            wake_latency < Duration::from_millis(150),
            "wait_until_finished took {wake_latency:?} after mark_finished, expected immediate wake"
        );
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

    #[test]
    fn debug_window_titles_are_visibly_marked() {
        let title = display_window_title("Media Library");
        if cfg!(debug_assertions) {
            assert_eq!(title, "Media Library (DEBUG)");
        } else {
            assert_eq!(title, "Media Library");
        }
    }
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTUP_INSTANT.set(Instant::now()).ok();
    let (session_event_tx, session_event_rx) = std::sync::mpsc::channel();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        chrono::Local::now().format("%Y-%m-%d][%H:%M:%S%.3f"),
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
        .manage(session::MediaLibrarySessionState::with_event_channel(
            session_event_tx,
            session_event_rx,
        ))
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
            get_media_library_session_snapshot,
            search_media_library_session,
            get_media_library_thumbnails,
            dismiss_media_library_session_issue,
            record_media_library_session_issue,
            open_media_library_session,
            close_media_library_session,
            start_scan,
            stop_scan,
            prioritize_queues,
            recycle_media_files,
            show_in_explorer,
            set_window_title,
            set_media_library_session_draft,
            discard_media_library_session_draft,
            discard_media_library_session_drafts,
            resolve_media_library_session_verification_outcome,
            dismiss_media_library_session_verification_outcomes,
            replace_media_library_session_new_property_draft,
            preview_media_library_session_metadata_target_removals,
            remove_media_library_session_metadata_targets,
            remove_media_library_session_metadata_field_from_files,
            remove_media_library_session_metadata_fields,
            preview_media_library_session_gps_drafts,
            stage_media_library_session_gps_drafts,
            stage_media_library_session_describe_drafts,
            stage_media_library_session_geocode_drafts,
            stage_media_library_session_normalise_drafts,
            preview_media_library_session_bulk_drafts,
            stage_media_library_session_bulk_drafts,
            apply_metadata_draft_edits_cmd,
            cancel_apply_edits,
            dismiss_media_library_session_apply_operation,
            dismiss_media_library_session_batch_operation,
            get_tag_info,
            get_tag_infos,
            preload_schema,
            list_writable_schema_definitions,
            commands::settings::load_settings_cmd,
            commands::settings::save_settings_cmd,
            commands::settings::list_recommended_models,
            commands::settings::estimate_per_image_cost_cmd,
            commands::settings::estimate_per_file_normalise_cost_cmd,
            commands::settings::estimate_per_file_location_normalise_cost_cmd,
            commands::describe::estimate_describe_cost_cmd,
            commands::describe::describe_images_cmd,
            commands::describe::cancel_describe_cmd,
            commands::geocode::prepare_geocode_files_cmd,
            commands::geocode::geocode_files_cmd,
            commands::geocode::cancel_geocode_cmd,
            commands::normalise::normalise_metadata_cmd,
            commands::normalise::cancel_normalise_cmd,
            commands::normalise::estimate_normalise_cost_cmd
        ])
        .setup(|app| {
            {
                let session = app.state::<session::MediaLibrarySessionState>();
                session.search().install_app_handle(app.handle().clone());
                if let Some(receiver) = session.take_event_receiver() {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || session::drain_session_events(receiver, handle));
                }
            }
            app.get_webview_window("main")
                .expect("main window should exist during setup")
                .set_title(&display_window_title("Media Library"))?;
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
