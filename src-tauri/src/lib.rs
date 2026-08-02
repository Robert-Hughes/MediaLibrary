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
pub mod session;
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

// â”€â”€ Shared state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Event payloads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Emitted when the directory walk is complete (no payload needed).
#[derive(Clone, Serialize)]
struct ThumbnailResult {
    relative_path: String,
    thumbnail: Option<String>,
}

// â”€â”€ Commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

fn emit_session_snapshot(
    app: &AppHandle,
    snapshot: &session::MediaLibrarySessionSnapshot,
) -> Result<(), String> {
    app.emit(session::SESSION_CHANGED_EVENT, snapshot.clone())
        .map_err(|error| error.to_string())
}

fn commit_session_metadata(app: &AppHandle, session_id: u64, results: Vec<scanner::FileMetadata>) {
    match app
        .state::<session::MediaLibrarySessionState>()
        .commit_metadata_results(session_id, results)
    {
        Ok(delta) => {
            if delta.entries.is_empty() {
                return;
            }
            if let Err(error) = app.emit("media_library_session_metadata_changed", delta) {
                log::error!("[session-metadata] failed to emit delta: {error}");
            }
        }
        Err(error) => log::debug!("[session-metadata] discarded stale results: {error}"),
    }
}

fn commit_session_thumbnails(app: &AppHandle, session_id: u64, results: Vec<ThumbnailResult>) {
    let results = results
        .into_iter()
        .map(|result| (result.relative_path, result.thumbnail))
        .collect();
    match app
        .state::<session::MediaLibrarySessionState>()
        .commit_thumbnail_results(session_id, results)
    {
        Ok(delta) => {
            if delta.entries.is_empty() {
                return;
            }
            if let Err(error) = app.emit(session::SESSION_THUMBNAILS_CHANGED_EVENT, delta) {
                log::error!("[session-thumbnails] failed to emit delta: {error}");
            }
        }
        Err(error) => log::debug!("[session-thumbnails] discarded stale results: {error}"),
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
    match app.state::<session::MediaLibrarySessionState>().add_issue(
        session_id,
        severity.to_owned(),
        error_type.to_owned(),
        error_message,
        affected_files,
    ) {
        Ok(snapshot) => {
            if let Err(error) = emit_session_snapshot(app, &snapshot) {
                log::error!("[session-issue] failed to emit snapshot: {error}");
            }
        }
        Err(error) => log::debug!("[session-issue] discarded stale issue: {error}"),
    }
}

#[tauri::command]
fn get_media_library_session_snapshot(
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> session::MediaLibrarySessionSnapshot {
    session_state.snapshot()
}

#[tauri::command]
fn dismiss_media_library_session_issue(
    issue_id: u64,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.dismiss_issue(issue_id);
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn record_media_library_session_issue(
    session_id: u64,
    severity: String,
    error_type: String,
    error_message: String,
    affected_files: Vec<String>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.add_issue(
        session_id,
        severity,
        error_type,
        error_message,
        affected_files,
    )?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
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
        Err(error) => {
            let failed = session_state.fail_session(session_id, "session-open", error)?;
            emit_session_snapshot(&app, &failed)?;
            return Ok(failed);
        }
    };
    let drafts =
        draft_repository::load_metadata_draft_edits(&app_data_dir, &folder_path, &repository_state);
    let snapshot = session_state.install_draft_load_result(session_id, drafts)?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn close_media_library_session(
    session_id: u64,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    scan_state: State<'_, ScanState>,
    active_queues: State<'_, ActiveQueues>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let closing = session_state.begin_close(session_id)?;
    emit_session_snapshot(&app, &closing)?;
    stop_scan_impl(&scan_state, &active_queues);
    let idle = session_state.finish_close(session_id)?;
    emit_session_snapshot(&app, &idle)?;
    Ok(idle)
}
/// Start a background scan of `folder_path`.
///
/// Three concurrent phases, all starting as soon as files are discovered:
///
///  Phase 1 â€” streaming file discovery (single thread):
///    Walks the directory tree. Discovered files are committed to the Rust
///    session in bounded batches before a revisioned delta is emitted. The
///    authoritative session snapshot records when discovery has finished.
///
///  Phase 2 â€” Image Metadata (thread pool, starts alongside phase 1):
///    Reads EXIF data per file and commits revisioned metadata deltas.
///
///  Phase 3 â€” thumbnail generation (thread pool, starts alongside phase 1):
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
        let failed = session_state.fail_session(scan_id, "scan", error)?;
        emit_session_snapshot(&app, &failed)
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

    let loaded = session_state.mark_loaded(scan_id, &folder_path)?;
    emit_session_snapshot(&app, &loaded)?;

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

        // â”€â”€ Phase 2: Image Metadata workers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // â”€â”€ Phase 3: thumbnail workers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                            thumbnail: scanner::thumbnail_for(&abs),
                        });
                    }
                })
            })
            .collect();
        // â”€â”€ Phase 1: streaming directory walk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                        Ok(delta) => {
                            let _ = app_flush.emit(session::SESSION_FILES_ADDED_EVENT, delta);
                        }
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
                            Ok(delta) => {
                                let _ = app_flush.emit(session::SESSION_FILES_ADDED_EVENT, delta);
                            }
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

        if let Ok(snapshot) = app_clone
            .state::<session::MediaLibrarySessionState>()
            .finish_discovery(scan_id)
        {
            let _ = emit_session_snapshot(&app_clone, &snapshot);
        }
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
        // Clear the queue slots â€” but only if a newer scan hasn't already
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
    let result = recycle::recycle_files_with(&folder, relative_paths, |path| {
        trash::delete(path).map_err(|error| error.to_string())
    })?;
    let recycled_paths: Vec<String> = result
        .results
        .iter()
        .filter(|item| item.recycled)
        .map(|item| item.relative_path.clone())
        .collect();
    if let Some(queue) = active_queues.thumbnails() {
        queue.remove_paths(&recycled_paths);
    }
    if let Some(queue) = active_queues.file_metadata() {
        queue.remove_paths(&recycled_paths);
    }
    if !recycled_paths.is_empty() {
        let active = session_state.snapshot();
        let session_id = active
            .session_id
            .ok_or_else(|| "No active media-library session".to_string())?;
        if active.folder.as_deref() != Some(folder.as_str()) {
            return Err(
                "The media-library session changed before recycled drafts were removed".into(),
            );
        }
        let draft_mutations = recycled_paths
            .iter()
            .filter(|path| active.drafts.contains_key(path.as_str()))
            .map(|relative_path| draft_repository::MetadataDraftRowMutation {
                relative_path: relative_path.clone(),
                entries: Vec::new(),
            })
            .collect::<Vec<_>>();
        if !draft_mutations.is_empty() {
            let app_data_dir = commands::shared::app_data_dir(&app)?;
            if let Err(error) = draft_repository::apply_row_mutations(
                &app_data_dir,
                &folder,
                &draft_mutations,
                &repository_state,
            ) {
                if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone())
                {
                    let _ = emit_session_snapshot(&app, &failed);
                }
                return Err(error);
            }
        }
        let snapshot = session_state.remove_files(session_id, &recycled_paths)?;
        emit_session_snapshot(&app, &snapshot)?;
    }
    Ok(result)
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

fn validate_exact_session_draft_target(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    target: &metadata_draft_target::MetadataDraftTarget,
) -> Result<(), String> {
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    match target {
        metadata_draft_target::MetadataDraftTarget::ExistingOccurrence {
            occurrence_id, ..
        } => {
            let mut matches = occurrences
                .0
                .iter()
                .filter(|occurrence| &occurrence.id == occurrence_id);
            let occurrence = matches
                .next()
                .ok_or_else(|| "The exact metadata occurrence no longer exists".to_string())?;
            if matches.next().is_some() {
                return Err("The exact metadata occurrence ID is duplicated".into());
            }
            target
                .validate_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())
        }
        metadata_draft_target::MetadataDraftTarget::NewProperty {
            schema_id,
            write_target,
        } => {
            let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
            let info = registry
                .lookup(schema_id)
                .ok_or_else(|| "The selected metadata schema is unknown".to_string())?;
            target
                .validate_new_property(info)
                .map_err(|error| error.to_string())?;
            for occurrence in &occurrences.0 {
                if occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| {
                        selector.group1 == write_target.group1
                            && selector.group7 == write_target.group7
                            && selector.tag_name == write_target.tag_name
                    })
                    || occurrence.write_target.as_ref() == Some(write_target)
                {
                    return Err(
                        "The complete ExifTool destination is already present in the file".into(),
                    );
                }
                if occurrence.observed_selector.is_none() && &occurrence.schema_id == schema_id {
                    return Err(
                        "A same-schema occurrence has no safely identifiable destination".into(),
                    );
                }
            }
            if snapshot
                .drafts
                .get(relative_path)
                .into_iter()
                .flatten()
                .any(|entry| {
                    entry.target != *target && entry.target.write_target() == Some(write_target)
                })
            {
                return Err(
                    "Another pending draft already uses the intended complete selector".into(),
                );
            }
            Ok(())
        }
    }
}

fn ensure_session_target_has_no_pending_verification(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    target: &metadata_draft_target::MetadataDraftTarget,
) -> Result<(), String> {
    let pending = snapshot
        .verification_outcomes
        .get(relative_path)
        .into_iter()
        .flatten()
        .any(|outcome| {
            let current = match &outcome.draft_reconciliation {
                apply_edits::MetadataDraftReconciliation::Replace { target } => target,
                _ => &outcome.target,
            };
            current == target
        });
    if pending {
        Err("Resolve the verification outcome for this destination before editing it".into())
    } else {
        Ok(())
    }
}

fn persist_exact_session_draft_row(
    app: &AppHandle,
    repository_state: &draft_edits::DraftRepositoryState,
    folder: &str,
    relative_path: String,
    entries: Vec<draft_edits::MetadataTargetDraftEntry>,
) -> Result<(), String> {
    let app_data_dir = commands::shared::app_data_dir(app)?;
    draft_repository::apply_row_mutations(
        &app_data_dir,
        folder,
        &[draft_repository::MetadataDraftRowMutation {
            relative_path,
            entries,
        }],
        repository_state,
    )
}

fn ensure_session_draft_mutation_allowed(
    snapshot: &session::MediaLibrarySessionSnapshot,
) -> Result<(), String> {
    if !matches!(
        snapshot.draft_persistence,
        session::MediaLibrarySessionDraftPersistenceState::Ready
    ) {
        return Err("Draft persistence is not ready".into());
    }
    if snapshot.apply_operation.as_ref().is_some_and(|operation| {
        matches!(
            operation.state,
            session::MediaLibraryApplyOperationState::Running
        )
    }) {
        return Err("Drafts cannot be changed while metadata apply is running".into());
    }
    Ok(())
}

#[tauri::command]
fn set_media_library_session_draft(
    session_id: u64,
    relative_path: String,
    target: metadata_draft_target::MetadataDraftTarget,
    edit: draft_edits::MetadataDraftEdit,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the draft was saved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    if target.is_new_property() {
        ensure_session_target_has_no_pending_verification(&snapshot, &relative_path, &target)?;
    }
    validate_exact_session_draft_target(&snapshot, &relative_path, &target)?;
    let mut entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let slot = target.slot();
    let replacement = draft_edits::MetadataTargetDraftEntry { target, edit };
    if let Some(existing) = entries.iter_mut().find(|entry| entry.target.slot() == slot) {
        *existing = replacement;
    } else {
        entries.push(replacement);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
fn discard_media_library_session_draft(
    session_id: u64,
    relative_path: String,
    target: metadata_draft_target::MetadataDraftTarget,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the draft was discarded".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let slot = target.slot();
    let mut entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    entries.retain(|entry| entry.target.slot() != slot);
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
fn resolve_media_library_session_verification_outcome(
    session_id: u64,
    relative_path: String,
    current_target: metadata_draft_target::MetadataDraftTarget,
    discard_draft: bool,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before verification was resolved".into());
    }
    let pending = snapshot
        .verification_outcomes
        .get(&relative_path)
        .is_some_and(|outcomes| {
            outcomes.iter().any(|outcome| {
                let target = match &outcome.draft_reconciliation {
                    apply_edits::MetadataDraftReconciliation::Replace { target } => target,
                    _ => &outcome.target,
                };
                target == &current_target
            })
        });
    if !pending {
        return Err("The verification outcome is no longer pending".into());
    }

    let persisted_entries = if discard_draft {
        ensure_session_draft_mutation_allowed(&snapshot)?;
        let slot = current_target.slot();
        let mut entries = snapshot
            .drafts
            .get(&relative_path)
            .cloned()
            .unwrap_or_default();
        let previous_len = entries.len();
        entries.retain(|entry| entry.target.slot() != slot);
        if entries.len() == previous_len {
            return Err("The verification draft is no longer pending".into());
        }
        let folder = snapshot
            .folder
            .as_deref()
            .ok_or_else(|| "The active media-library session has no folder".to_string())?;
        if let Err(error) = persist_exact_session_draft_row(
            &app,
            &repository_state,
            folder,
            relative_path.clone(),
            entries.clone(),
        ) {
            if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
                let _ = emit_session_snapshot(&app, &failed);
            }
            return Err(error);
        }
        Some(entries)
    } else {
        None
    };

    let committed = session_state.resolve_verification_outcome(
        session_id,
        &relative_path,
        &current_target,
        persisted_entries,
    )?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
fn dismiss_media_library_session_verification_outcomes(
    session_id: u64,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.dismiss_all_verification_outcomes(session_id)?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
}

fn discard_exact_session_draft_targets(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    targets: &[metadata_draft_target::MetadataDraftTarget],
) -> Option<Vec<draft_edits::MetadataTargetDraftEntry>> {
    if targets.is_empty() {
        return None;
    }
    let slots = targets
        .iter()
        .map(metadata_draft_target::MetadataDraftTarget::slot)
        .collect::<std::collections::HashSet<_>>();
    let remaining = entries
        .iter()
        .filter(|entry| !slots.contains(&entry.target.slot()))
        .cloned()
        .collect::<Vec<_>>();
    (remaining.len() != entries.len()).then_some(remaining)
}

#[tauri::command]
fn discard_media_library_session_drafts(
    session_id: u64,
    relative_path: String,
    targets: Vec<metadata_draft_target::MetadataDraftTarget>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the drafts were discarded".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let Some(entries) = discard_exact_session_draft_targets(&current_entries, &targets) else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

fn replace_exact_new_property_session_draft(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    original_target: &metadata_draft_target::MetadataDraftTarget,
    replacement_target: &metadata_draft_target::MetadataDraftTarget,
    original_edit: &draft_edits::MetadataDraftEdit,
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    let (
        metadata_draft_target::MetadataDraftTarget::NewProperty {
            schema_id: original_schema,
            ..
        },
        metadata_draft_target::MetadataDraftTarget::NewProperty {
            schema_id: replacement_schema,
            ..
        },
    ) = (original_target, replacement_target)
    else {
        return Err("Only NewProperty drafts can be moved".into());
    };
    if original_schema != replacement_schema {
        return Err("The replacement destination changed the exact schema".into());
    }
    let original_slot = original_target.slot();
    let original_entry = entries
        .iter()
        .find(|entry| entry.target.slot() == original_slot)
        .ok_or_else(|| "The original draft changed or disappeared".to_string())?;
    if &original_entry.target != original_target || &original_entry.edit != original_edit {
        return Err("The original draft changed or disappeared".into());
    }
    if original_target == replacement_target {
        return Ok(None);
    }
    let replacement_slot = replacement_target.slot();
    if entries.iter().any(|entry| {
        entry.target.slot() == replacement_slot && entry.target.slot() != original_slot
    }) {
        return Err("Another pending draft already uses the replacement destination".into());
    }
    let mut replaced = entries
        .iter()
        .filter(|entry| entry.target.slot() != original_slot)
        .cloned()
        .collect::<Vec<_>>();
    replaced.push(draft_edits::MetadataTargetDraftEntry {
        target: replacement_target.clone(),
        edit: original_edit.clone(),
    });
    Ok(Some(replaced))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn replace_media_library_session_new_property_draft(
    session_id: u64,
    relative_path: String,
    original_target: metadata_draft_target::MetadataDraftTarget,
    replacement_target: metadata_draft_target::MetadataDraftTarget,
    original_edit: draft_edits::MetadataDraftEdit,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the draft was moved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    ensure_session_target_has_no_pending_verification(&snapshot, &relative_path, &original_target)?;
    validate_exact_session_draft_target(&snapshot, &relative_path, &replacement_target)?;
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let Some(entries) = replace_exact_new_property_session_draft(
        &current_entries,
        &original_target,
        &replacement_target,
        &original_edit,
    )?
    else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

fn plan_exact_session_target_removals(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    targets: &[metadata_draft_target::MetadataDraftTarget],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if targets.is_empty() {
        return Err("At least one exact metadata target is required".into());
    }
    let mut requested_slots = std::collections::HashSet::new();
    for target in targets {
        if !requested_slots.insert(target.slot()) {
            return Err(
                "The removal request contains the same logical target slot more than once".into(),
            );
        }
    }

    let delete_edit = draft_edits::MetadataDraftEdit {
        value: None,
        intent: draft_edits::EditIntent::Delete,
    };
    let mut planned = entries.to_vec();
    for target in targets {
        let slot = target.slot();
        let owner_index = planned.iter().position(|entry| entry.target.slot() == slot);
        match target {
            metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                let index = owner_index.ok_or_else(|| {
                    "The selected New Property target no longer has an exact stored draft"
                        .to_string()
                })?;
                if planned[index].target != *target {
                    return Err(
                        "A stale complete target owns the selected New Property slot".into(),
                    );
                }
                planned.remove(index);
            }
            metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                if let Some(index) = owner_index {
                    if planned[index].target != *target {
                        return Err(
                            "A stale complete target owns the selected occurrence slot".into()
                        );
                    }
                    if planned[index].edit == delete_edit {
                        continue;
                    }
                    planned[index].edit = delete_edit.clone();
                } else {
                    planned.push(draft_edits::MetadataTargetDraftEntry {
                        target: target.clone(),
                        edit: delete_edit.clone(),
                    });
                }
            }
        }
    }

    Ok((planned != entries).then_some(planned))
}

fn preview_exact_session_target_removals(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    targets: &[metadata_draft_target::MetadataDraftTarget],
) -> Result<draft_edits::MetadataRemovalPreview, String> {
    plan_exact_session_target_removals(entries, targets)?;
    let delete_edit = draft_edits::MetadataDraftEdit {
        value: None,
        intent: draft_edits::EditIntent::Delete,
    };
    let mut existing_fields_to_delete = 0;
    let mut staged_creations_to_cancel = 0;
    let mut no_op_targets = 0;
    for target in targets {
        match target {
            metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                staged_creations_to_cancel += 1;
            }
            metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                let owner = entries
                    .iter()
                    .find(|entry| entry.target.slot() == target.slot());
                if owner.is_some_and(|entry| entry.edit == delete_edit) {
                    no_op_targets += 1;
                } else {
                    existing_fields_to_delete += 1;
                }
            }
        }
    }
    Ok(draft_edits::MetadataRemovalPreview {
        existing_fields_to_delete,
        staged_creations_to_cancel,
        no_op_targets,
        affected_count: existing_fields_to_delete + staged_creations_to_cancel,
    })
}

#[tauri::command]
fn preview_media_library_session_metadata_target_removals(
    session_id: u64,
    relative_path: String,
    targets: Vec<metadata_draft_target::MetadataDraftTarget>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<draft_edits::MetadataRemovalPreview, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err(
            "The media-library session changed before metadata removal was previewed".into(),
        );
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    for target in &targets {
        validate_exact_session_draft_target(&snapshot, &relative_path, target)?;
    }
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    preview_exact_session_target_removals(&current_entries, &targets)
}

#[tauri::command]
fn remove_media_library_session_metadata_targets(
    session_id: u64,
    relative_path: String,
    targets: Vec<metadata_draft_target::MetadataDraftTarget>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before metadata was removed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    for target in &targets {
        validate_exact_session_draft_target(&snapshot, &relative_path, target)?;
    }
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let Some(entries) = plan_exact_session_target_removals(&current_entries, &targets)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

fn plan_session_schema_removal(
    occurrences: &metadata_occurrence::MetadataOccurrences,
    entries: &[draft_edits::MetadataTargetDraftEntry],
    schema_id: &tag_schema::SchemaDefinitionId,
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    let mut targets = Vec::new();
    let mut authoritative_slots = std::collections::HashSet::new();
    for occurrence in occurrences
        .iter()
        .filter(|occurrence| &occurrence.schema_id == schema_id)
    {
        let target =
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| {
                    format!("The selected occurrence cannot be removed safely: {error}")
                })?;
        if !authoritative_slots.insert(target.slot()) {
            return Err(
                "Several authoritative occurrences resolve to the same exact target slot".into(),
            );
        }
        targets.push(target);
    }
    for entry in entries
        .iter()
        .filter(|entry| entry.target.schema_id() == schema_id)
    {
        match &entry.target {
            metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                targets.push(entry.target.clone());
            }
            metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. }
                if !authoritative_slots.contains(&entry.target.slot()) =>
            {
                return Err(
                    "An ExistingOccurrence draft owns the selected schema, but its exact authoritative occurrence is missing"
                        .into(),
                );
            }
            _ => {}
        }
    }
    if targets.is_empty() {
        return Ok(None);
    }
    plan_exact_session_target_removals(entries, &targets)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn remove_media_library_session_metadata_field_from_files(
    session_id: u64,
    schema_id: tag_schema::SchemaDefinitionId,
    relative_paths: Vec<String>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before metadata was removed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    if relative_paths.is_empty() {
        return Err("At least one selected file is required".into());
    }
    let mut seen = std::collections::HashSet::new();
    if let Some(duplicate) = relative_paths
        .iter()
        .find(|path| !seen.insert(path.as_str()))
    {
        return Err(format!(
            "The selected file list contains '{duplicate}' more than once"
        ));
    }

    let mut mutations = Vec::new();
    let mut committed_rows = Vec::new();
    for relative_path in &relative_paths {
        let metadata = snapshot
            .metadata
            .iter()
            .find(|entry| entry.relative_path == *relative_path)
            .ok_or_else(|| {
                format!("Authoritative metadata is unavailable for '{relative_path}'")
            })?;
        let occurrences = match &metadata.state {
            session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
            session::MediaLibrarySessionMetadataState::Loading => {
                return Err(format!(
                    "Authoritative metadata occurrences are still loading for '{relative_path}'"
                ));
            }
            session::MediaLibrarySessionMetadataState::Failed { error } => {
                return Err(format!(
                    "Metadata could not be loaded for '{relative_path}': {error}"
                ));
            }
        };
        let current_entries = snapshot
            .drafts
            .get(relative_path)
            .cloned()
            .unwrap_or_default();
        let Some(entries) = plan_session_schema_removal(occurrences, &current_entries, &schema_id)
            .map_err(|error| format!("Cannot remove metadata from '{relative_path}': {error}"))?
        else {
            continue;
        };
        mutations.push(draft_repository::MetadataDraftRowMutation {
            relative_path: relative_path.clone(),
            entries: entries.clone(),
        });
        committed_rows.push((relative_path.clone(), entries));
    }
    if mutations.is_empty() {
        return Ok(snapshot);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let app_data_dir = commands::shared::app_data_dir(&app)?;
    if let Err(error) =
        draft_repository::apply_row_mutations(&app_data_dir, folder, &mutations, &repository_state)
    {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_rows(session_id, committed_rows)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
fn remove_media_library_session_metadata_fields(
    session_id: u64,
    relative_path: String,
    schema_ids: Vec<tag_schema::SchemaDefinitionId>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before metadata was removed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    if schema_ids.is_empty() {
        return Err("At least one exact metadata schema is required".into());
    }
    for (index, schema_id) in schema_ids.iter().enumerate() {
        if schema_ids[..index].contains(schema_id) {
            return Err("The removal request contains the same exact schema more than once".into());
        }
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| format!("Authoritative metadata is unavailable for '{relative_path}'"))?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into());
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!("Metadata could not be loaded: {error}"));
        }
    };
    let original_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let mut entries = original_entries.clone();
    for schema_id in &schema_ids {
        if let Some(next) = plan_session_schema_removal(occurrences, &entries, schema_id)
            .map_err(|error| format!("Cannot remove metadata from '{relative_path}': {error}"))?
        {
            entries = next;
        }
    }
    if entries == original_entries {
        return Ok(snapshot);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

fn is_gps_coordinate_schema(id: &tag_schema::SchemaDefinitionId) -> bool {
    id.table == "GPS::Main"
        && id.index.is_none()
        && matches!(id.tag_id.as_str(), "1" | "2" | "3" | "4" | "5" | "6")
}

fn plan_session_gps_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<Vec<draft_edits::MetadataTargetDraftEntry>, String> {
    if edits.is_empty() {
        return Err("A GPS edit must contain at least one field".into());
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let stored = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    let mut schemas = std::collections::HashSet::new();
    let mut slots = std::collections::HashSet::new();
    let mut selectors = std::collections::HashSet::new();
    let mut incoming = Vec::with_capacity(edits.len());

    for requested in edits {
        if !schemas.insert(requested.schema_id.clone()) {
            return Err("The GPS batch contains the same exact schema more than once".into());
        }
        if !is_gps_coordinate_schema(&requested.schema_id) {
            return Err("This action accepts only exact GPS coordinate-group schemas".into());
        }
        let matching_occurrences = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == requested.schema_id)
            .collect::<Vec<_>>();
        if matching_occurrences.len() > 1 {
            return Err("Several authoritative occurrences share this exact GPS schema".into());
        }
        let target = if let Some(occurrence) = matching_occurrences.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            let matching_drafts = stored
                .iter()
                .filter(|entry| entry.target.schema_id() == &requested.schema_id)
                .collect::<Vec<_>>();
            if matching_drafts
                .iter()
                .any(|entry| entry.target.is_existing_occurrence())
            {
                return Err(
                    "A staged GPS occurrence draft no longer has its authoritative occurrence"
                        .into(),
                );
            }
            if matching_drafts.len() > 1 {
                return Err("Several staged GPS destinations share this exact schema".into());
            }
            if let Some(entry) = matching_drafts.first() {
                entry.target.clone()
            } else {
                let info = registry
                    .lookup(&requested.schema_id)
                    .ok_or_else(|| "The exact GPS schema is unavailable".to_string())?;
                metadata_draft_target::MetadataDraftTarget::from_new_property(info)
                    .map_err(|error| error.to_string())?
            }
        };
        validate_exact_session_draft_target(snapshot, relative_path, &target)?;
        if !slots.insert(target.slot()) {
            return Err("The GPS batch contains the same exact target slot more than once".into());
        }
        if !selectors.insert(target.write_target().cloned()) {
            return Err("Two incoming GPS targets resolve to the same ExifTool destination".into());
        }
        incoming.push(draft_edits::MetadataTargetDraftEntry {
            target,
            edit: requested.edit.clone(),
        });
    }

    Ok(incoming)
}

fn merge_session_gps_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    incoming: &[draft_edits::MetadataTargetDraftEntry],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    for entry in incoming {
        let slot = entry.target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot
                && stored.target.write_target() == entry.target.write_target()
        }) {
            return Err("Another exact draft target uses the captured GPS selector".into());
        }
        if let Some(existing) = planned
            .iter_mut()
            .find(|stored| stored.target.slot() == slot)
        {
            if existing.target != entry.target {
                return Err(
                    "The exact GPS target slot is owned by a different complete target snapshot"
                        .into(),
                );
            }
            *existing = entry.clone();
        } else {
            planned.push(entry.clone());
        }
    }
    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}

#[tauri::command]
fn preview_media_library_session_gps_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<Vec<draft_edits::MetadataTargetDraftEntry>, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the GPS edit was previewed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let entries = plan_session_gps_drafts(&snapshot, &relative_path, &edits)?;
    merge_session_gps_drafts(&snapshot, &relative_path, &entries)?;
    Ok(entries)
}

#[tauri::command]
fn stage_media_library_session_gps_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the GPS drafts were saved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let entries = plan_session_gps_drafts(&snapshot, &relative_path, &edits)?;
    let Some(planned) = merge_session_gps_drafts(&snapshot, &relative_path, &entries)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

fn is_describe_schema(id: &tag_schema::SchemaDefinitionId) -> bool {
    id.table == "UserDefined::mlib"
        && id.index.is_none()
        && matches!(
            id.tag_id.as_str(),
            "AIDescription"
                | "AIInterpretation"
                | "AITags"
                | "AIObjects"
                | "AIOcrText"
                | "AIModel"
                | "AIPromptVersion"
                | "AIGeneratedAt"
        )
}

fn selector_matches_write_target(
    selector: &metadata_occurrence::MetadataObservedSelector,
    target: &metadata_occurrence::MetadataWriteTarget,
) -> bool {
    selector.group1.eq_ignore_ascii_case(&target.group1)
        && selector.group7.eq_ignore_ascii_case(&target.group7)
        && selector.tag_name.eq_ignore_ascii_case(&target.tag_name)
}

fn plan_session_describe_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if edits.is_empty() {
        return Ok(None);
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();

    for generated in edits {
        if !seen.insert(generated.schema_id.clone()) {
            return Err("The generated batch contains the same exact schema more than once".into());
        }
        if !is_describe_schema(&generated.schema_id) {
            return Err("AI description is not allowed to generate this exact schema".into());
        }
        if generated.edit.intent != draft_edits::EditIntent::Set || generated.edit.value.is_none() {
            return Err("AI description supports only Set edits with semantic values".into());
        }
        let info = registry
            .lookup(&generated.schema_id)
            .ok_or_else(|| "The exact generated metadata schema is unavailable".to_string())?;
        let new_target = metadata_draft_target::MetadataDraftTarget::from_new_property(info)
            .map_err(|error| error.to_string())?;
        let destination = new_target
            .write_target()
            .ok_or_else(|| "The generated metadata destination is unavailable".to_string())?;
        let same_schema = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == generated.schema_id)
            .collect::<Vec<_>>();
        let at_destination = same_schema
            .iter()
            .copied()
            .filter(|occurrence| {
                occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| selector_matches_write_target(selector, destination))
            })
            .collect::<Vec<_>>();
        if at_destination.is_empty()
            && same_schema
                .iter()
                .any(|occurrence| occurrence.observed_selector.is_none())
        {
            return Err(
                "An authoritative generated-metadata occurrence has no physical selector".into(),
            );
        }
        if at_destination.len() > 1 {
            return Err(
                "The generated schema resolves to multiple occurrences at its destination".into(),
            );
        }
        let target = if let Some(occurrence) = at_destination.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            new_target
        };
        let slot = target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot && stored.target.write_target() == target.write_target()
        }) {
            return Err("Another exact draft target owns the generated destination".into());
        }
        let replacement = draft_edits::MetadataTargetDraftEntry {
            target: target.clone(),
            edit: generated.edit.clone(),
        };
        if let Some(existing) = planned.iter_mut().find(|entry| entry.target.slot() == slot) {
            if existing.target != target {
                return Err("A stale complete target owns the generated metadata slot".into());
            }
            *existing = replacement;
        } else {
            planned.push(replacement);
        }
    }

    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}

fn is_geocode_schema(id: &tag_schema::SchemaDefinitionId) -> bool {
    id.table == "UserDefined::mlib"
        && id.index.is_none()
        && matches!(
            id.tag_id.as_str(),
            "ReverseGeocodeGeocodeJSON" | "ReverseGeocodeJSONv2"
        )
}

fn is_normalise_schema(
    id: &tag_schema::SchemaDefinitionId,
    enabled_groups: &[normalise::NormaliseGroup],
) -> bool {
    if id.index.is_some() {
        return false;
    }
    enabled_groups.iter().any(|group| match group {
        normalise::NormaliseGroup::Keywords => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::Lightroom", "hierarchicalSubject")
                | ("XMP::dc", "subject")
                | ("IPTC::ApplicationRecord", "25")
        ),
        normalise::NormaliseGroup::Description => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "description") | ("Exif::Main", "270") | ("IPTC::ApplicationRecord", "120")
        ),
        normalise::NormaliseGroup::Title => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "title") | ("IPTC::ApplicationRecord", "5")
        ),
        normalise::NormaliseGroup::Headline => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::photoshop", "Headline") | ("IPTC::ApplicationRecord", "105")
        ),
        normalise::NormaliseGroup::Creator => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "creator") | ("Exif::Main", "315") | ("IPTC::ApplicationRecord", "80")
        ),
        normalise::NormaliseGroup::Copyright => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "rights") | ("Exif::Main", "33432") | ("IPTC::ApplicationRecord", "116")
        ),
        normalise::NormaliseGroup::IptcUtf8 => {
            id.table == "IPTC::EnvelopeRecord" && id.tag_id == "90"
        }
        normalise::NormaliseGroup::Location => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::iptcExt", "LocationCreated")
                | ("XMP::iptcCore", "Location")
                | ("IPTC::ApplicationRecord", "92")
                | ("XMP::photoshop", "City")
                | ("IPTC::ApplicationRecord", "90")
                | ("XMP::photoshop", "State")
                | ("IPTC::ApplicationRecord", "95")
                | ("XMP::photoshop", "Country")
                | ("IPTC::ApplicationRecord", "101")
                | ("XMP::iptcCore", "CountryCode")
                | ("IPTC::ApplicationRecord", "100")
        ),
        normalise::NormaliseGroup::Dates => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("Exif::Main", "36867")
                | ("XMP::photoshop", "DateCreated")
                | ("IPTC::ApplicationRecord", "55")
                | ("IPTC::ApplicationRecord", "60")
                | ("Exif::Main", "36868")
                | ("XMP::xmp", "CreateDate")
                | ("IPTC::ApplicationRecord", "62")
                | ("IPTC::ApplicationRecord", "63")
        ),
    })
}

fn plan_session_geocode_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if edits.is_empty() {
        return Ok(None);
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();

    for generated in edits {
        if !seen.insert(generated.schema_id.clone()) {
            return Err("The generated batch contains the same exact schema more than once".into());
        }
        if !is_geocode_schema(&generated.schema_id) {
            return Err("Reverse geocoding is not allowed to generate this exact schema".into());
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set if generated.edit.value.is_some() => {}
            draft_edits::EditIntent::Delete if generated.edit.value.is_none() => {}
            _ => return Err("Reverse geocoding received an invalid semantic edit".into()),
        }
        let info = registry
            .lookup(&generated.schema_id)
            .ok_or_else(|| "The exact generated metadata schema is unavailable".to_string())?;
        let new_target = metadata_draft_target::MetadataDraftTarget::from_new_property(info)
            .map_err(|error| error.to_string())?;
        let destination = new_target
            .write_target()
            .ok_or_else(|| "The generated metadata destination is unavailable".to_string())?;
        let same_schema = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == generated.schema_id)
            .collect::<Vec<_>>();
        let at_destination = same_schema
            .iter()
            .copied()
            .filter(|occurrence| {
                occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| selector_matches_write_target(selector, destination))
            })
            .collect::<Vec<_>>();
        if at_destination.is_empty()
            && same_schema
                .iter()
                .any(|occurrence| occurrence.observed_selector.is_none())
        {
            return Err(
                "An authoritative generated-metadata occurrence has no physical selector".into(),
            );
        }
        if at_destination.len() > 1 {
            return Err(
                "The generated schema resolves to multiple occurrences at its destination".into(),
            );
        }
        let target = if let Some(occurrence) = at_destination.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            new_target
        };
        let slot = target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot && stored.target.write_target() == target.write_target()
        }) {
            return Err("Another exact draft target owns the generated destination".into());
        }
        let owner_index = planned.iter().position(|entry| entry.target.slot() == slot);
        if let Some(index) = owner_index {
            if planned[index].target != target {
                return Err("A stale complete target owns the generated metadata slot".into());
            }
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set => {
                let replacement = draft_edits::MetadataTargetDraftEntry {
                    target: target.clone(),
                    edit: generated.edit.clone(),
                };
                if let Some(index) = owner_index {
                    planned[index] = replacement;
                } else {
                    planned.push(replacement);
                }
            }
            draft_edits::EditIntent::Delete => match target {
                metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                    let replacement = draft_edits::MetadataTargetDraftEntry {
                        target: target.clone(),
                        edit: generated.edit.clone(),
                    };
                    if let Some(index) = owner_index {
                        planned[index] = replacement;
                    } else {
                        planned.push(replacement);
                    }
                }
                metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                    if let Some(index) = owner_index {
                        planned.remove(index);
                    }
                }
            },
            draft_edits::EditIntent::ListAdd | draft_edits::EditIntent::ListRemove => {
                return Err("Reverse geocoding received an unsupported list edit".into())
            }
        }
    }

    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}
fn plan_session_normalise_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
    enabled_groups: &[normalise::NormaliseGroup],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if edits.is_empty() {
        return Ok(None);
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();

    for generated in edits {
        if !seen.insert(generated.schema_id.clone()) {
            return Err("The generated batch contains the same exact schema more than once".into());
        }
        if !is_normalise_schema(&generated.schema_id, enabled_groups) {
            return Err(
                "Metadata normalisation is not allowed to generate this exact schema".into(),
            );
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set if generated.edit.value.is_some() => {}
            draft_edits::EditIntent::Delete if generated.edit.value.is_none() => {}
            _ => return Err("Metadata normalisation received an invalid semantic edit".into()),
        }
        let info = registry
            .lookup(&generated.schema_id)
            .ok_or_else(|| "The exact generated metadata schema is unavailable".to_string())?;
        let new_target = metadata_draft_target::MetadataDraftTarget::from_new_property(info)
            .map_err(|error| error.to_string())?;
        let destination = new_target
            .write_target()
            .ok_or_else(|| "The generated metadata destination is unavailable".to_string())?;
        let same_schema = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == generated.schema_id)
            .collect::<Vec<_>>();
        let at_destination = same_schema
            .iter()
            .copied()
            .filter(|occurrence| {
                occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| selector_matches_write_target(selector, destination))
            })
            .collect::<Vec<_>>();
        if at_destination.is_empty()
            && same_schema
                .iter()
                .any(|occurrence| occurrence.observed_selector.is_none())
        {
            return Err(
                "An authoritative generated-metadata occurrence has no physical selector".into(),
            );
        }
        if at_destination.len() > 1 {
            return Err(
                "The generated schema resolves to multiple occurrences at its destination".into(),
            );
        }
        let target = if let Some(occurrence) = at_destination.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            new_target
        };
        let slot = target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot && stored.target.write_target() == target.write_target()
        }) {
            return Err("Another exact draft target owns the generated destination".into());
        }
        let owner_index = planned.iter().position(|entry| entry.target.slot() == slot);
        if let Some(index) = owner_index {
            if planned[index].target != target {
                return Err("A stale complete target owns the generated metadata slot".into());
            }
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set => {
                let replacement = draft_edits::MetadataTargetDraftEntry {
                    target: target.clone(),
                    edit: generated.edit.clone(),
                };
                if let Some(index) = owner_index {
                    planned[index] = replacement;
                } else {
                    planned.push(replacement);
                }
            }
            draft_edits::EditIntent::Delete => match target {
                metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                    let replacement = draft_edits::MetadataTargetDraftEntry {
                        target: target.clone(),
                        edit: generated.edit.clone(),
                    };
                    if let Some(index) = owner_index {
                        planned[index] = replacement;
                    } else {
                        planned.push(replacement);
                    }
                }
                metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                    if let Some(index) = owner_index {
                        planned.remove(index);
                    }
                }
            },
            draft_edits::EditIntent::ListAdd | draft_edits::EditIntent::ListRemove => {
                return Err("Metadata normalisation received an unsupported list edit".into())
            }
        }
    }

    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}

pub(crate) fn stage_batch_generated_metadata_drafts(
    app: &AppHandle,
    session_id: u64,
    operation_id: &str,
    producer: &batch_job::GeneratedDraftProducer,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<bool, String> {
    if edits.is_empty() {
        return Ok(false);
    }
    let session_state = app.state::<session::MediaLibrarySessionState>();
    let repository_state = app.state::<draft_edits::DraftRepositoryState>();
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before generated drafts were saved".into());
    }
    let operation_is_current = snapshot
        .batch_operations
        .get(producer.kind())
        .is_some_and(|operation| operation.operation_id == operation_id);
    if !operation_is_current {
        return Err("The generated-metadata batch operation identity changed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let planned = match producer {
        batch_job::GeneratedDraftProducer::Describe => {
            plan_session_describe_drafts(&snapshot, relative_path, edits)?
        }
        batch_job::GeneratedDraftProducer::Geocode => {
            plan_session_geocode_drafts(&snapshot, relative_path, edits)?
        }
        batch_job::GeneratedDraftProducer::Normalise { enabled_groups } => {
            plan_session_normalise_drafts(&snapshot, relative_path, edits, enabled_groups)?
        }
    };
    let Some(planned) = planned else {
        return Ok(false);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        app,
        &repository_state,
        folder,
        relative_path.to_owned(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(app, &failed);
        }
        return Err(error);
    }
    let committed =
        session_state.commit_draft_row(session_id, relative_path.to_owned(), planned)?;
    emit_session_snapshot(app, &committed)?;
    Ok(true)
}

#[tauri::command]
fn stage_media_library_session_describe_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err(
            "The media-library session changed before description drafts were saved".into(),
        );
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let Some(planned) = plan_session_describe_drafts(&snapshot, &relative_path, &edits)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
fn stage_media_library_session_geocode_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err(
            "The media-library session changed before reverse-geocode drafts were saved".into(),
        );
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let Some(planned) = plan_session_geocode_drafts(&snapshot, &relative_path, &edits)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}
#[tauri::command]
fn stage_media_library_session_normalise_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    enabled_groups: Vec<normalise::NormaliseGroup>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before normalise drafts were saved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let Some(planned) =
        plan_session_normalise_drafts(&snapshot, &relative_path, &edits, &enabled_groups)?
    else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
fn preview_media_library_session_bulk_drafts(
    session_id: u64,
    relative_paths: Vec<String>,
    request: bulk_metadata::BulkMetadataDraftRequest,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<bulk_metadata::BulkMetadataDraftPreviewPlan, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the bulk edit was previewed".into());
    }
    if !matches!(
        snapshot.draft_persistence,
        session::MediaLibrarySessionDraftPersistenceState::Ready
    ) {
        return Err("Draft persistence is not ready".into());
    }
    let plan = bulk_metadata::plan_bulk_metadata_drafts(&snapshot, &relative_paths, &request)?;
    Ok(bulk_metadata::BulkMetadataDraftPreviewPlan {
        preview: plan.preview,
    })
}

#[tauri::command]
fn stage_media_library_session_bulk_drafts(
    session_id: u64,
    relative_paths: Vec<String>,
    request: bulk_metadata::BulkMetadataDraftRequest,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the bulk edit was staged".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let plan = bulk_metadata::plan_bulk_metadata_drafts(&snapshot, &relative_paths, &request)?;
    if plan.rows.is_empty() {
        return Ok(snapshot);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let mutations = plan
        .rows
        .iter()
        .map(
            |(relative_path, entries)| draft_repository::MetadataDraftRowMutation {
                relative_path: relative_path.clone(),
                entries: entries.clone(),
            },
        )
        .collect::<Vec<_>>();
    let app_data_dir = commands::shared::app_data_dir(&app)?;
    if let Err(error) =
        draft_repository::apply_row_mutations(&app_data_dir, folder, &mutations, &repository_state)
    {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_rows(session_id, plan.rows)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

/// Production occurrence-aware metadata apply.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn apply_metadata_draft_edits_cmd(
    session_id: u64,
    rel_paths: Option<Vec<String>>,
    app: AppHandle,
    apply_state: State<'_, apply_batch::ApplyEditsState>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<apply_batch::MetadataApplyResult, String> {
    let session_snapshot = session_state.snapshot();
    if session_snapshot.session_id != Some(session_id) {
        return Err("The media-library session changed before apply started".into());
    }
    ensure_session_draft_mutation_allowed(&session_snapshot)?;
    let folder_path = session_snapshot
        .folder
        .clone()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let (operation_id, begun) =
        session_state.begin_new_apply_operation(session_id, rel_paths.clone())?;
    emit_session_snapshot(&app, &begun)?;

    let app_settings = settings::load_settings(&commands::shared::app_data_dir(&app)?)?;
    let batch_size = usize::from(app_settings.metadata_apply_batch_size);
    let write_concurrency = usize::from(app_settings.metadata_apply_concurrency);
    log::info!(
        "[apply_edits] starting batch_size={} write_concurrency={} requested={}",
        batch_size,
        write_concurrency,
        rel_paths.as_ref().map_or(0, Vec::len)
    );
    let run_app = app.clone();
    let run_operation_id = operation_id.clone();
    let result =
        apply_batch::run_apply_edits_command(&apply_state, &operation_id, move |cancel_flag| {
            tauri::async_runtime::spawn_blocking(move || {
                apply_batch::run_apply_metadata_draft_edits_blocking(
                    folder_path,
                    rel_paths,
                    run_operation_id,
                    run_app,
                    cancel_flag,
                    apply_batch::MetadataApplyLimits {
                        batch_size,
                        write_concurrency,
                    },
                )
            })
        })
        .await;
    if let Err(error) = &result {
        if let Ok(failed) =
            session_state.fail_apply_operation(session_id, &operation_id, error.clone())
        {
            let _ = emit_session_snapshot(&app, &failed);
        }
    }
    result
}

#[tauri::command]
fn cancel_apply_edits(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    apply_state: State<'_, apply_batch::ApplyEditsState>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<(), String> {
    let cancelling = session_state.request_apply_cancellation(session_id, &operation_id)?;
    emit_session_snapshot(&app, &cancelling)?;
    apply_state.signal_cancel(&operation_id);
    Ok(())
}

#[tauri::command]
fn dismiss_media_library_session_apply_operation(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.dismiss_apply_operation(session_id, &operation_id)?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
}
#[tauri::command]
fn dismiss_media_library_session_batch_operation(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.dismiss_batch_operation(session_id, &operation_id)?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
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

    // â”€â”€ ActiveQueues race-condition tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ App entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        .manage(session::MediaLibrarySessionState::new())
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
            commands::settings::estimate_per_image_normalise_cost_cmd,
            commands::settings::estimate_per_image_location_normalise_cost_cmd,
            commands::describe::estimate_describe_cost_cmd,
            commands::describe::describe_images_cmd,
            commands::describe::cancel_describe_cmd,
            commands::geocode::prepare_geocode_images_cmd,
            commands::geocode::geocode_images_cmd,
            commands::geocode::cancel_geocode_cmd,
            commands::normalise::normalise_metadata_cmd,
            commands::normalise::cancel_normalise_cmd,
            commands::normalise::estimate_normalise_cost_cmd
        ])
        .setup(|app| {
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
