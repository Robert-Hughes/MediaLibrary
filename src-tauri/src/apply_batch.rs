//! Versioned target-aware batch metadata apply coordinator for the target-aware metadata pipeline.
//!
//! This module consumes [`MetadataTargetDraftEntry`] values, invokes the
//! occurrence-aware single-file pipeline, applies structured draft
//! reconciliation, and persists only through the target-aware-owned SQLite
//! repository. It emits
//! versioned events consumed by the production frontend controller.
//! After reconciliation and persistence, it appends target-aware audit evidence
//! to the independent `MediaLibraryTargetApplyLog.jsonl` file.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};

use crate::apply_edits::{
    apply_single_file_metadata, execute_prepared_metadata_write, executed_relative_path,
    finalize_executed_metadata_write, prepare_single_file_metadata, MetadataSingleFileOutcome,
    MetadataTargetOutcome,
};
use crate::apply_log::{
    append_target_metadata_entries_with_state, ApplyLogState, TargetApplyAuditRecord,
    TargetDraftPersistenceOutcome,
};
use crate::draft_edits::{
    resolve_canonical_photo_path, DraftRepositoryState, MetadataTargetDraftEntry,
};
use crate::draft_reconciliation::reconcile_metadata_draft_entries;
use crate::draft_repository::{
    load_draft_rows, persist_reconciled_rows, select_all_relative_paths,
    select_existing_relative_paths, LoadedDraftRow, ReconciledDraftRow,
};
use crate::scanner;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyFileResult {
    pub relative_path: String,
    pub applied: bool,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub fresh_file_metadata: Option<scanner::FileMetadata>,
    pub target_outcomes: Vec<MetadataTargetOutcome>,
    pub persisted_draft_entries: Option<Vec<MetadataTargetDraftEntry>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyResult {
    pub summary: MetadataApplySummary,
    pub undelivered_files: Vec<MetadataApplyFileResult>,
    pub complete_delivery_failed: bool,
    #[cfg(test)]
    #[serde(skip)]
    #[ts(skip)]
    pub files: Vec<MetadataApplyFileResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplySummary {
    pub requested: usize,
    pub selected: usize,
    pub completed: usize,
    pub applied: usize,
    pub failed: usize,
    pub warning_count: usize,
    pub cancelled: bool,
    pub aborted: bool,
    pub abort_reason: Option<String>,
    pub delivery_failure_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MetadataApplyStreamMessage {
    Started {
        operation_id: String,
        total: usize,
    },
    ProgressBatch {
        operation_id: String,
        sequence: usize,
        current: usize,
        total: usize,
        results: Vec<MetadataApplyFileResult>,
    },
    Complete {
        operation_id: String,
        summary: MetadataApplySummary,
    },
}

/// Cancellation state for the sole metadata apply command.
pub struct ApplyEditsState {
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyEditsBusyError;

impl std::fmt::Display for ApplyEditsBusyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("A target-aware metadata apply operation is already running")
    }
}

impl std::error::Error for ApplyEditsBusyError {}

impl ApplyEditsState {
    pub fn new() -> Self {
        Self {
            cancelled: Mutex::new(None),
        }
    }

    pub fn try_install(&self) -> Result<Arc<AtomicBool>, ApplyEditsBusyError> {
        let mut installed = self.cancelled.lock().unwrap();
        if installed.is_some() {
            return Err(ApplyEditsBusyError);
        }

        let flag = Arc::new(AtomicBool::new(false));
        *installed = Some(flag.clone());
        Ok(flag)
    }

    pub fn clear(&self) {
        *self.cancelled.lock().unwrap() = None;
    }

    pub fn clear_if_mine(&self, flag: &Arc<AtomicBool>) {
        let mut installed = self.cancelled.lock().unwrap();
        if installed
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, flag))
        {
            *installed = None;
        }
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
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) async fn run_apply_edits_command<T, StartWorker, WorkerFuture, WorkerJoinError>(
    state: &ApplyEditsState,
    start_worker: StartWorker,
) -> Result<T, String>
where
    StartWorker: FnOnce(Arc<AtomicBool>) -> WorkerFuture,
    WorkerFuture: Future<Output = Result<Result<T, String>, WorkerJoinError>>,
    WorkerJoinError: std::fmt::Display,
{
    let cancel_flag = state.try_install().map_err(|error| error.to_string())?;
    let result = match start_worker(cancel_flag.clone()).await {
        Ok(result) => result,
        Err(error) => Err(format!("Target-aware apply edits worker failed: {error}")),
    };
    state.clear_if_mine(&cancel_flag);
    result
}

pub trait DraftPersistence {
    fn select_existing(
        &self,
        folder_path: &str,
        relative_paths: &[String],
    ) -> Result<Vec<String>, String>;
    fn select_all(&self, _folder_path: &str) -> Result<Vec<String>, String> {
        Err("Draft persistence does not support selecting all rows".into())
    }
    fn load_rows(
        &self,
        folder_path: &str,
        relative_paths: &[String],
    ) -> Result<Vec<LoadedDraftRow>, String>;
    fn persist_rows(&self, folder_path: &str, rows: &[ReconciledDraftRow]) -> Result<(), String>;
}

pub trait SingleFileApply {
    fn apply(
        &self,
        folder_path: &str,
        relative_path: &str,
        edits: &[MetadataTargetDraftEntry],
    ) -> MetadataSingleFileOutcome;

    fn apply_batch(
        &self,
        folder_path: &str,
        jobs: &[(String, Vec<MetadataTargetDraftEntry>)],
        _write_concurrency: usize,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Vec<(String, MetadataSingleFileOutcome)> {
        jobs.iter()
            .take_while(|_| !cancel_flag.load(Ordering::Relaxed))
            .map(|(relative_path, edits)| {
                (
                    relative_path.clone(),
                    self.apply(folder_path, relative_path, edits),
                )
            })
            .collect()
    }
}

pub(crate) trait DraftReconciler {
    fn reconcile(
        &self,
        entries: &[MetadataTargetDraftEntry],
        outcomes: &[MetadataTargetOutcome],
    ) -> Result<Vec<MetadataTargetDraftEntry>, String>;
}

pub trait ApplyEvents {
    fn send(&self, message: &MetadataApplyStreamMessage) -> Result<(), String>;
}

pub(crate) trait TargetApplyLogger {
    fn append(
        &self,
        folder_path: &str,
        relative_path: &str,
        records: &[TargetApplyAuditRecord],
        draft_persistence: &TargetDraftPersistenceOutcome,
    ) -> Result<(), String>;
}

struct RealDraftPersistence {
    app: AppHandle,
}

impl DraftPersistence for RealDraftPersistence {
    fn select_existing(
        &self,
        folder_path: &str,
        relative_paths: &[String],
    ) -> Result<Vec<String>, String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        select_existing_relative_paths(&app_data_dir, folder_path, relative_paths, &state)
    }

    fn select_all(&self, folder_path: &str) -> Result<Vec<String>, String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        select_all_relative_paths(&app_data_dir, folder_path, &state)
    }

    fn load_rows(
        &self,
        folder_path: &str,
        relative_paths: &[String],
    ) -> Result<Vec<LoadedDraftRow>, String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        load_draft_rows(&app_data_dir, folder_path, relative_paths, &state)
    }

    fn persist_rows(&self, folder_path: &str, rows: &[ReconciledDraftRow]) -> Result<(), String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        persist_reconciled_rows(&app_data_dir, folder_path, rows, &state)
    }
}

struct RealSingleFileApply;

impl SingleFileApply for RealSingleFileApply {
    fn apply(
        &self,
        folder_path: &str,
        relative_path: &str,
        edits: &[MetadataTargetDraftEntry],
    ) -> MetadataSingleFileOutcome {
        apply_single_file_metadata(folder_path, relative_path, edits)
    }

    fn apply_batch(
        &self,
        folder_path: &str,
        jobs: &[(String, Vec<MetadataTargetDraftEntry>)],
        write_concurrency: usize,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Vec<(String, MetadataSingleFileOutcome)> {
        apply_real_metadata_batch(folder_path, jobs, write_concurrency, cancel_flag)
    }
}

fn read_metadata_for_jobs(
    folder_path: &str,
    relative_paths: &[String],
) -> HashMap<String, Result<scanner::FileMetadata, String>> {
    let absolute_paths = relative_paths
        .iter()
        .map(|relative_path| {
            Path::new(folder_path).join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        })
        .collect::<Vec<_>>();
    let mut by_path = HashMap::with_capacity(relative_paths.len());
    match scanner::read_file_metadata_batch(relative_paths, &absolute_paths) {
        Ok(outcome) => {
            for metadata in outcome.results {
                by_path.insert(metadata.relative_path.clone(), Ok(metadata));
            }
            for failure in outcome.failures {
                by_path.insert(failure.relative_path, Err(failure.error_message));
            }
            for relative_path in relative_paths {
                by_path.entry(relative_path.clone()).or_insert_with(|| {
                    Err(format!(
                        "authoritative metadata batch read returned neither a result nor a failure for {relative_path}"
                    ))
                });
            }
        }
        Err(error) => {
            for relative_path in relative_paths {
                by_path.insert(
                    relative_path.clone(),
                    Err(format!("authoritative metadata batch read failed: {error}")),
                );
            }
        }
    }
    by_path
}

fn apply_real_metadata_batch(
    folder_path: &str,
    jobs: &[(String, Vec<MetadataTargetDraftEntry>)],
    write_concurrency: usize,
    cancel_flag: &Arc<AtomicBool>,
) -> Vec<(String, MetadataSingleFileOutcome)> {
    let phase_started = Instant::now();
    let relative_paths = jobs
        .iter()
        .map(|(relative_path, _)| relative_path.clone())
        .collect::<Vec<_>>();
    let mut before_by_path = read_metadata_for_jobs(folder_path, &relative_paths);
    log::info!(
        "[apply_perf] phase=chunk_pre_read duration_ms={} files={}",
        phase_started.elapsed().as_millis(),
        jobs.len()
    );

    if cancel_flag.load(Ordering::Relaxed) {
        return Vec::new();
    }

    let mut immediate = HashMap::new();
    let mut prepared = Vec::new();
    for (index, (relative_path, edits)) in jobs.iter().enumerate() {
        match before_by_path
            .remove(relative_path)
            .expect("batch reader returns one entry per requested path")
        {
            Ok(before) => {
                match prepare_single_file_metadata(folder_path, relative_path, edits, before) {
                    Ok(item) => prepared.push((index, item)),
                    Err(outcome) => {
                        immediate.insert(index, *outcome);
                    }
                }
            }
            Err(error) => {
                immediate.insert(
                    index,
                    MetadataSingleFileOutcome::pre_write_read_failure(error),
                );
            }
        }
    }

    let phase_started = Instant::now();
    let executed = crate::batch_job::run_bounded_blocking(
        prepared,
        NonZeroUsize::new(write_concurrency).unwrap_or(NonZeroUsize::MIN),
        cancel_flag,
        execute_prepared_metadata_write,
    );
    log::info!(
        "[apply_perf] phase=chunk_writes duration_ms={} completed={} concurrency={}",
        phase_started.elapsed().as_millis(),
        executed.len(),
        write_concurrency
    );

    let post_relative_paths = executed
        .iter()
        .map(|(_, item)| executed_relative_path(item).to_string())
        .collect::<Vec<_>>();
    let phase_started = Instant::now();
    let mut fresh_by_path = read_metadata_for_jobs(folder_path, &post_relative_paths);
    log::info!(
        "[apply_perf] phase=chunk_post_read duration_ms={} files={}",
        phase_started.elapsed().as_millis(),
        post_relative_paths.len()
    );

    for (index, item) in executed {
        let relative_path = executed_relative_path(&item).to_string();
        let fresh = fresh_by_path
            .remove(&relative_path)
            .expect("batch reader returns one entry per written path");
        immediate.insert(index, finalize_executed_metadata_write(item, fresh));
    }

    let mut ordered = immediate.into_iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(index, _)| *index);
    ordered
        .into_iter()
        .map(|(index, outcome)| (jobs[index].0.clone(), outcome))
        .collect()
}

struct RealDraftReconciler;

impl DraftReconciler for RealDraftReconciler {
    fn reconcile(
        &self,
        entries: &[MetadataTargetDraftEntry],
        outcomes: &[MetadataTargetOutcome],
    ) -> Result<Vec<MetadataTargetDraftEntry>, String> {
        reconcile_metadata_draft_entries(entries, outcomes).map_err(|error| error.to_string())
    }
}

struct RealTargetApplyLogger {
    app: AppHandle,
}

impl TargetApplyLogger for RealTargetApplyLogger {
    fn append(
        &self,
        folder_path: &str,
        relative_path: &str,
        records: &[TargetApplyAuditRecord],
        draft_persistence: &TargetDraftPersistenceOutcome,
    ) -> Result<(), String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
        let state = self.app.state::<ApplyLogState>();
        append_target_metadata_entries_with_state(
            &app_data_dir,
            &photo_path,
            records,
            draft_persistence,
            &state,
        )
    }
}

struct TauriApplyEvents {
    channel: Channel<MetadataApplyStreamMessage>,
    app: AppHandle,
    session_id: u64,
}

impl ApplyEvents for TauriApplyEvents {
    fn send(&self, message: &MetadataApplyStreamMessage) -> Result<(), String> {
        if let MetadataApplyStreamMessage::ProgressBatch { results, .. } = message {
            let metadata: Vec<_> = results
                .iter()
                .filter_map(|result| result.fresh_file_metadata.clone())
                .collect();
            if !metadata.is_empty() {
                let delta = self
                    .app
                    .state::<crate::session::MediaLibrarySessionState>()
                    .commit_post_write_metadata_results(self.session_id, metadata)?;
                self.app
                    .emit(crate::session::SESSION_METADATA_CHANGED_EVENT, delta)
                    .map_err(|error| error.to_string())?;
            }
        }
        let snapshot = self
            .app
            .state::<crate::session::MediaLibrarySessionState>()
            .update_apply_operation(self.session_id, message)?;
        self.app
            .emit(crate::session::SESSION_CHANGED_EVENT, snapshot)
            .map_err(|error| error.to_string())?;
        self.channel
            .send(message.clone())
            .map_err(|error| error.to_string())
    }
}
#[derive(Debug, Clone, Copy)]
pub struct MetadataApplyLimits {
    pub batch_size: usize,
    pub write_concurrency: usize,
}

pub fn run_apply_metadata_draft_edits_blocking(
    folder_path: String,
    relative_paths: Option<Vec<String>>,
    operation_id: String,
    progress_channel: Channel<MetadataApplyStreamMessage>,
    app: AppHandle,
    cancel_flag: Arc<AtomicBool>,
    limits: MetadataApplyLimits,
) -> Result<MetadataApplyResult, String> {
    run_apply_metadata_draft_edits_with_limits(
        &folder_path,
        relative_paths.as_deref(),
        &RealDraftPersistence { app: app.clone() },
        &RealSingleFileApply,
        &RealDraftReconciler,
        &RealTargetApplyLogger { app: app.clone() },
        &TauriApplyEvents {
            channel: progress_channel,
            app: app.clone(),
            session_id: app
                .state::<crate::session::MediaLibrarySessionState>()
                .snapshot()
                .session_id
                .ok_or_else(|| "No active media-library session".to_owned())?,
        },
        &operation_id,
        cancel_flag,
        limits.batch_size,
        limits.write_concurrency,
    )
}

fn combine_errors(original: Option<String>, additional: String) -> String {
    match original {
        Some(original) => format!("{original}; {additional}"),
        None => additional,
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn run_apply_metadata_draft_edits_with<P, A, R, L, E>(
    folder_path: &str,
    relative_paths: &[String],
    persistence: &P,
    single_file_apply: &A,
    reconciler: &R,
    target_logger: &L,
    events: &E,
    cancel_flag: Arc<AtomicBool>,
) -> Result<MetadataApplyResult, String>
where
    P: DraftPersistence,
    A: SingleFileApply,
    R: DraftReconciler,
    L: TargetApplyLogger,
    E: ApplyEvents,
{
    run_apply_metadata_draft_edits_with_limits(
        folder_path,
        Some(relative_paths),
        persistence,
        single_file_apply,
        reconciler,
        target_logger,
        events,
        "test-operation",
        cancel_flag,
        1,
        1,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_apply_metadata_draft_edits_with_limits<P, A, R, L, E>(
    folder_path: &str,
    relative_paths: Option<&[String]>,
    persistence: &P,
    single_file_apply: &A,
    reconciler: &R,
    target_logger: &L,
    events: &E,
    operation_id: &str,
    cancel_flag: Arc<AtomicBool>,
    batch_size: usize,
    write_concurrency: usize,
) -> Result<MetadataApplyResult, String>
where
    P: DraftPersistence,
    A: SingleFileApply,
    R: DraftReconciler,
    L: TargetApplyLogger,
    E: ApplyEvents,
{
    let batch_started = Instant::now();
    if let Some(relative_paths) = relative_paths {
        let mut seen = HashSet::new();
        for relative_path in relative_paths {
            if !seen.insert(relative_path.as_str()) {
                return Err(format!(
                    "duplicate requested relative path: {relative_path}"
                ));
            }
        }
    }

    let phase_started = Instant::now();
    let selected = match relative_paths {
        Some(relative_paths) => persistence.select_existing(folder_path, relative_paths)?,
        None => persistence.select_all(folder_path)?,
    };
    let requested = relative_paths.map_or(selected.len(), <[String]>::len);
    let total = selected.len();
    log::info!(
        "[apply_perf] phase=draft_select duration_ms={} requested={} selected={}",
        phase_started.elapsed().as_millis(),
        requested,
        total
    );
    log::info!(
        "[apply_perf] phase=batch_start requested={} selected={} batch_size={} write_concurrency={}",
        requested,
        total,
        batch_size,
        write_concurrency
    );

    if let Err(error) = events.send(&MetadataApplyStreamMessage::Started {
        operation_id: operation_id.to_owned(),
        total,
    }) {
        log::warn!("[apply_batch] Failed to emit started event: {error}");
    }

    #[cfg(test)]
    let mut files = Vec::with_capacity(total);
    let mut undelivered_files = Vec::new();
    let mut completed = 0usize;
    let mut applied = 0usize;
    let mut failed = 0usize;
    let mut warning_count = 0usize;
    let mut sequence = 0usize;
    let mut cancelled = false;
    let mut aborted = false;
    let mut abort_reason = None;

    for chunk in selected.chunks(batch_size) {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let phase_started = Instant::now();
        let loaded_rows = persistence.load_rows(folder_path, chunk)?;
        if loaded_rows.len() != chunk.len() {
            let loaded_paths = loaded_rows
                .iter()
                .map(|row| row.relative_path.as_str())
                .collect::<HashSet<_>>();
            let missing = chunk
                .iter()
                .filter(|path| !loaded_paths.contains(path.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            return Err(format!(
                "Draft rows changed before metadata apply began: {}",
                missing.join(", ")
            ));
        }
        log::info!(
            "[apply_perf] phase=chunk_draft_load duration_ms={} files={}",
            phase_started.elapsed().as_millis(),
            loaded_rows.len()
        );

        let jobs = loaded_rows
            .iter()
            .map(|row| (row.relative_path.clone(), row.entries.clone()))
            .collect::<Vec<_>>();
        let mut rows_by_path = loaded_rows
            .into_iter()
            .map(|row| (row.relative_path.clone(), row))
            .collect::<HashMap<_, _>>();
        let chunk_started = Instant::now();
        let chunk_outcomes =
            single_file_apply.apply_batch(folder_path, &jobs, write_concurrency, &cancel_flag);
        log::info!(
            "[apply_perf] phase=chunk_pipeline duration_ms={} requested={} completed={}",
            chunk_started.elapsed().as_millis(),
            jobs.len(),
            chunk_outcomes.len()
        );
        if chunk_outcomes.len() < jobs.len() {
            cancelled = cancel_flag.load(Ordering::Relaxed);
        }

        struct PendingResult {
            relative_path: String,
            outcome: MetadataSingleFileOutcome,
            reconciled: Option<ReconciledDraftRow>,
            fatal_reason: Option<String>,
            draft_persistence: TargetDraftPersistenceOutcome,
        }

        let phase_started = Instant::now();
        let mut pending = Vec::with_capacity(chunk_outcomes.len());
        for (relative_path, outcome) in chunk_outcomes {
            let row = rows_by_path
                .remove(&relative_path)
                .expect("apply batch returns only requested paths");
            let mut reconciled = None;
            let mut fatal_reason = None;
            let mut draft_persistence = TargetDraftPersistenceOutcome::Unchanged;
            if !outcome.outcomes.is_empty() {
                match reconciler.reconcile(&row.entries, &outcome.outcomes) {
                    Ok(entries) if entries != row.entries => {
                        reconciled = Some(row.reconciled(entries));
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let reason = format!(
                            "target-aware draft reconciliation failed for {relative_path}: {error}"
                        );
                        fatal_reason = Some(reason.clone());
                        draft_persistence =
                            TargetDraftPersistenceOutcome::ReconciliationFailed { error: reason };
                    }
                }
            }
            pending.push(PendingResult {
                relative_path,
                outcome,
                reconciled,
                fatal_reason,
                draft_persistence,
            });
        }
        log::info!(
            "[apply_perf] phase=chunk_reconcile duration_ms={} files={}",
            phase_started.elapsed().as_millis(),
            pending.len()
        );

        let rows_to_persist = pending
            .iter()
            .filter_map(|item| item.reconciled.clone())
            .collect::<Vec<_>>();
        if !rows_to_persist.is_empty() {
            let persist_started = Instant::now();
            match persistence.persist_rows(folder_path, &rows_to_persist) {
                Ok(()) => {
                    for item in &mut pending {
                        if item.reconciled.is_some() {
                            item.draft_persistence = TargetDraftPersistenceOutcome::Persisted;
                        }
                    }
                    log::info!(
                        "[apply_perf] phase=chunk_draft_persist duration_ms={} status=ok rows={}",
                        persist_started.elapsed().as_millis(),
                        rows_to_persist.len()
                    );
                }
                Err(error) => {
                    for item in &mut pending {
                        if item.reconciled.is_some() {
                            let reason = format!(
                                "target-aware draft persistence failed for {}: {error}",
                                item.relative_path
                            );
                            item.fatal_reason = Some(reason.clone());
                            item.draft_persistence =
                                TargetDraftPersistenceOutcome::PersistenceFailed { error: reason };
                        }
                    }
                    log::info!(
                        "[apply_perf] phase=chunk_draft_persist duration_ms={} status=failed rows={}",
                        persist_started.elapsed().as_millis(),
                        rows_to_persist.len()
                    );
                }
            }
        }

        let mut chunk_results = Vec::with_capacity(pending.len());
        for item in pending {
            let coordinator_file_started = Instant::now();
            let PendingResult {
                relative_path,
                outcome,
                reconciled,
                fatal_reason,
                draft_persistence,
            } = item;
            let mut final_error = outcome.error.clone();
            if let Some(reason) = fatal_reason.as_ref() {
                final_error = Some(combine_errors(final_error, reason.clone()));
            }
            let persisted_draft_entries =
                if matches!(draft_persistence, TargetDraftPersistenceOutcome::Persisted) {
                    reconciled.as_ref().map(|row| row.entries.clone())
                } else {
                    None
                };

            let phase_started = Instant::now();
            if !outcome.audit_records.is_empty() {
                if let Err(error) = target_logger.append(
                    folder_path,
                    &relative_path,
                    &outcome.audit_records,
                    &draft_persistence,
                ) {
                    log::warn!(
                    "[apply_batch] Failed to append target apply log for {relative_path}: {error}"
                );
                }
            }
            log::info!(
                "[apply_perf] file={} phase=audit duration_ms={} records={}",
                relative_path,
                phase_started.elapsed().as_millis(),
                outcome.audit_records.len()
            );

            let result = MetadataApplyFileResult {
                relative_path,
                applied: final_error.is_none(),
                error: final_error,
                warning: outcome.warning,
                fresh_file_metadata: outcome.fresh_file_metadata,
                target_outcomes: outcome.outcomes,
                persisted_draft_entries,
            };
            if result.applied {
                applied += 1;
            } else {
                failed += 1;
            }
            if result.warning.is_some() {
                warning_count += 1;
            }
            let current = completed + chunk_results.len() + 1;
            log::info!(
                "[apply_perf] file={} phase=coordinator_total duration_ms={} current={} total={}",
                result.relative_path,
                coordinator_file_started.elapsed().as_millis(),
                current,
                total
            );
            chunk_results.push(result);

            if let Some(reason) = fatal_reason {
                aborted = true;
                abort_reason.get_or_insert(reason);
            }
        }

        if !chunk_results.is_empty() {
            sequence += 1;
            completed += chunk_results.len();
            let message = MetadataApplyStreamMessage::ProgressBatch {
                operation_id: operation_id.to_owned(),
                sequence,
                current: completed,
                total,
                results: chunk_results.clone(),
            };
            if let Err(error) = events.send(&message) {
                log::warn!(
                    "[apply_batch] Failed to emit progress batch ending at {completed}: {error}"
                );
                undelivered_files.extend(chunk_results.iter().cloned());
            }
            #[cfg(test)]
            files.extend(chunk_results);
        }

        if aborted || cancelled {
            break;
        }
    }

    log::info!(
        "[apply_perf] phase=batch_complete duration_ms={} completed={} total={} cancelled={} aborted={}",
        batch_started.elapsed().as_millis(),
        completed,
        total,
        cancelled,
        aborted
    );
    let summary = MetadataApplySummary {
        requested,
        selected: total,
        completed,
        applied,
        failed,
        warning_count,
        cancelled,
        aborted,
        abort_reason,
        delivery_failure_count: undelivered_files.len(),
    };
    let complete_delivery_failed = events
        .send(&MetadataApplyStreamMessage::Complete {
            operation_id: operation_id.to_owned(),
            summary: summary.clone(),
        })
        .is_err();
    Ok(MetadataApplyResult {
        summary,
        undelivered_files,
        complete_delivery_failed,
        #[cfg(test)]
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apply_edits::MetadataDraftReconciliation;
    use crate::apply_log::{
        TargetApplyObservedOccurrence, TargetApplyPassStatus, TargetApplyPostWriteState,
        TargetApplyVerificationEvidence, TargetApplyWriteEvidence,
    };
    use crate::draft_edits::{EditIntent, MetadataDraftEdit, MetadataTargetDraftsByFile};
    use crate::metadata_draft_target::MetadataDraftTarget;
    use crate::metadata_occurrence::{
        MetadataOccurrence, MetadataOccurrenceId, MetadataOccurrences, MetadataWriteTarget,
    };
    use crate::metadata_value::MetadataValue;
    use crate::tag_schema::SchemaDefinitionId;
    use std::collections::{HashMap, VecDeque};
    use std::fs;

    struct FakePersistence {
        load: Result<MetadataTargetDraftsByFile, String>,
        current: Mutex<MetadataTargetDraftsByFile>,
        saves: Mutex<Vec<MetadataTargetDraftsByFile>>,
        save_error: Option<String>,
    }

    impl FakePersistence {
        fn new(load: Result<MetadataTargetDraftsByFile, String>) -> Self {
            let current = load.clone().unwrap_or_default();
            Self {
                load,
                current: Mutex::new(current),
                saves: Mutex::new(Vec::new()),
                save_error: None,
            }
        }
    }

    impl DraftPersistence for FakePersistence {
        fn select_existing(
            &self,
            _folder_path: &str,
            relative_paths: &[String],
        ) -> Result<Vec<String>, String> {
            self.load.as_ref().map_err(Clone::clone)?;
            let current = self.current.lock().unwrap();
            Ok(relative_paths
                .iter()
                .filter(|path| {
                    current
                        .get(path.as_str())
                        .is_some_and(|entries| !entries.is_empty())
                })
                .cloned()
                .collect())
        }

        fn load_rows(
            &self,
            _folder_path: &str,
            relative_paths: &[String],
        ) -> Result<Vec<LoadedDraftRow>, String> {
            self.load.as_ref().map_err(Clone::clone)?;
            let current = self.current.lock().unwrap();
            Ok(relative_paths
                .iter()
                .filter_map(|relative_path| {
                    current.get(relative_path).map(|entries| LoadedDraftRow {
                        relative_path: relative_path.clone(),
                        entries: entries.clone(),
                        original_json: serde_json::to_string(entries).unwrap(),
                    })
                })
                .collect())
        }

        fn persist_rows(
            &self,
            _folder_path: &str,
            rows: &[ReconciledDraftRow],
        ) -> Result<(), String> {
            if let Some(error) = &self.save_error {
                return Err(error.clone());
            }
            let mut current = self.current.lock().unwrap();
            for row in rows {
                if row.entries.is_empty() {
                    current.remove(&row.relative_path);
                } else {
                    current.insert(row.relative_path.clone(), row.entries.clone());
                }
            }
            self.saves.lock().unwrap().push(current.clone());
            Ok(())
        }
    }

    struct FakeApply {
        outcomes: Mutex<HashMap<String, VecDeque<MetadataSingleFileOutcome>>>,
        calls: Mutex<Vec<String>>,
        cancel_after: Option<(String, Arc<AtomicBool>)>,
    }

    impl FakeApply {
        fn new(outcomes: impl IntoIterator<Item = (String, MetadataSingleFileOutcome)>) -> Self {
            let mut by_path = HashMap::<String, VecDeque<_>>::new();
            for (path, outcome) in outcomes {
                by_path.entry(path).or_default().push_back(outcome);
            }
            Self {
                outcomes: Mutex::new(by_path),
                calls: Mutex::new(Vec::new()),
                cancel_after: None,
            }
        }
    }

    impl SingleFileApply for FakeApply {
        fn apply(
            &self,
            _folder_path: &str,
            relative_path: &str,
            _edits: &[MetadataTargetDraftEntry],
        ) -> MetadataSingleFileOutcome {
            self.calls.lock().unwrap().push(relative_path.to_owned());
            let result = self
                .outcomes
                .lock()
                .unwrap()
                .get_mut(relative_path)
                .and_then(VecDeque::pop_front)
                .unwrap();
            if self
                .cancel_after
                .as_ref()
                .is_some_and(|(path, _)| path == relative_path)
            {
                self.cancel_after
                    .as_ref()
                    .unwrap()
                    .1
                    .store(true, Ordering::Relaxed);
            }
            result
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    struct RecordedTargetLog {
        folder_path: String,
        relative_path: String,
        records: Vec<TargetApplyAuditRecord>,
        draft_persistence: TargetDraftPersistenceOutcome,
    }

    #[derive(Default)]
    struct FakeTargetLogger {
        calls: Mutex<Vec<RecordedTargetLog>>,
        results: Mutex<VecDeque<Result<(), String>>>,
    }

    impl FakeTargetLogger {
        fn with_results(results: impl IntoIterator<Item = Result<(), String>>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                results: Mutex::new(results.into_iter().collect()),
            }
        }
    }

    impl TargetApplyLogger for FakeTargetLogger {
        fn append(
            &self,
            folder_path: &str,
            relative_path: &str,
            records: &[TargetApplyAuditRecord],
            draft_persistence: &TargetDraftPersistenceOutcome,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push(RecordedTargetLog {
                folder_path: folder_path.to_owned(),
                relative_path: relative_path.to_owned(),
                records: records.to_vec(),
                draft_persistence: draft_persistence.clone(),
            });
            self.results.lock().unwrap().pop_front().unwrap_or(Ok(()))
        }
    }

    struct TracePersistence {
        drafts: MetadataTargetDraftsByFile,
        trace: Arc<Mutex<Vec<&'static str>>>,
        save_error: bool,
    }

    impl DraftPersistence for TracePersistence {
        fn select_existing(
            &self,
            _folder_path: &str,
            relative_paths: &[String],
        ) -> Result<Vec<String>, String> {
            Ok(relative_paths
                .iter()
                .filter(|path| self.drafts.contains_key(path.as_str()))
                .cloned()
                .collect())
        }

        fn load_rows(
            &self,
            _folder_path: &str,
            relative_paths: &[String],
        ) -> Result<Vec<LoadedDraftRow>, String> {
            Ok(relative_paths
                .iter()
                .filter_map(|relative_path| {
                    self.drafts
                        .get(relative_path)
                        .map(|entries| LoadedDraftRow {
                            relative_path: relative_path.clone(),
                            entries: entries.clone(),
                            original_json: serde_json::to_string(entries).unwrap(),
                        })
                })
                .collect())
        }

        fn persist_rows(
            &self,
            _folder_path: &str,
            _rows: &[ReconciledDraftRow],
        ) -> Result<(), String> {
            self.trace.lock().unwrap().push("save");
            if self.save_error {
                Err("save failed".into())
            } else {
                Ok(())
            }
        }
    }

    struct TraceApply {
        outcome: MetadataSingleFileOutcome,
        trace: Arc<Mutex<Vec<&'static str>>>,
    }

    impl SingleFileApply for TraceApply {
        fn apply(
            &self,
            _folder_path: &str,
            _relative_path: &str,
            _edits: &[MetadataTargetDraftEntry],
        ) -> MetadataSingleFileOutcome {
            self.trace.lock().unwrap().push("apply");
            self.outcome.clone()
        }
    }

    struct TraceReconciler {
        trace: Arc<Mutex<Vec<&'static str>>>,
        fail: bool,
    }

    impl DraftReconciler for TraceReconciler {
        fn reconcile(
            &self,
            entries: &[MetadataTargetDraftEntry],
            outcomes: &[MetadataTargetOutcome],
        ) -> Result<Vec<MetadataTargetDraftEntry>, String> {
            self.trace.lock().unwrap().push("reconcile");
            if self.fail {
                Err("reconcile failed".into())
            } else {
                RealDraftReconciler.reconcile(entries, outcomes)
            }
        }
    }

    struct TraceLogger {
        trace: Arc<Mutex<Vec<&'static str>>>,
    }

    impl TargetApplyLogger for TraceLogger {
        fn append(
            &self,
            _folder_path: &str,
            _relative_path: &str,
            _records: &[TargetApplyAuditRecord],
            _draft_persistence: &TargetDraftPersistenceOutcome,
        ) -> Result<(), String> {
            self.trace.lock().unwrap().push("log");
            Ok(())
        }
    }

    struct TraceEvents {
        trace: Arc<Mutex<Vec<&'static str>>>,
    }

    impl ApplyEvents for TraceEvents {
        fn send(&self, message: &MetadataApplyStreamMessage) -> Result<(), String> {
            if matches!(message, MetadataApplyStreamMessage::ProgressBatch { .. }) {
                self.trace.lock().unwrap().push("progress");
            }
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    enum RecordedEvent {
        Started {
            total: usize,
        },
        ProgressBatch {
            sequence: usize,
            current: usize,
            total: usize,
            results: Vec<MetadataApplyFileResult>,
        },
        Complete(MetadataApplySummary),
    }

    #[derive(Default)]
    struct FakeEvents {
        events: Mutex<Vec<RecordedEvent>>,
        fail: bool,
    }

    impl ApplyEvents for FakeEvents {
        fn send(&self, message: &MetadataApplyStreamMessage) -> Result<(), String> {
            let recorded = match message {
                MetadataApplyStreamMessage::Started { total, .. } => {
                    RecordedEvent::Started { total: *total }
                }
                MetadataApplyStreamMessage::ProgressBatch {
                    sequence,
                    current,
                    total,
                    results,
                    ..
                } => RecordedEvent::ProgressBatch {
                    sequence: *sequence,
                    current: *current,
                    total: *total,
                    results: results.clone(),
                },
                MetadataApplyStreamMessage::Complete { summary, .. } => {
                    RecordedEvent::Complete(summary.clone())
                }
            };
            self.events.lock().unwrap().push(recorded);
            if self.fail {
                Err("event failed".into())
            } else {
                Ok(())
            }
        }
    }

    fn schema(tag_id: &str) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: tag_id.into(),
            index: None,
        }
    }

    fn new_target(tag_id: &str) -> MetadataDraftTarget {
        MetadataDraftTarget::NewProperty {
            schema_id: schema(tag_id),
            write_target: MetadataWriteTarget {
                group1: "XMP-test".into(),
                group7: format!("ID-{tag_id}"),
                tag_name: format!("Tag{tag_id}"),
            },
        }
    }

    fn existing_target(tag_id: &str, path: &str) -> MetadataDraftTarget {
        MetadataDraftTarget::ExistingOccurrence {
            occurrence_id: MetadataOccurrenceId {
                document: None,
                path: path.into(),
                runtime_tag_id: tag_id.into(),
                tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                    table: "Exif::Main".into(),
                    tag_id: tag_id.into(),
                    index: None,
                },
                copy: 0,
            },
            schema_id: schema(tag_id),
            write_target: MetadataWriteTarget {
                group1: if path.ends_with("IFD1") {
                    "IFD1"
                } else {
                    "IFD0"
                }
                .into(),
                group7: format!("ID-{tag_id}"),
                tag_name: format!("Tag{tag_id}"),
            },
        }
    }

    fn entry(target: MetadataDraftTarget, text: &str) -> MetadataTargetDraftEntry {
        MetadataTargetDraftEntry {
            target,
            edit: MetadataDraftEdit {
                value: Some(MetadataValue::Text(text.into())),
                intent: EditIntent::Set,
            },
        }
    }

    fn target_outcome(
        target: &MetadataDraftTarget,
        draft_reconciliation: MetadataDraftReconciliation,
    ) -> MetadataTargetOutcome {
        MetadataTargetOutcome {
            target: target.clone(),
            draft_reconciliation,
            display_name: "Test".into(),
            kind: "Match".into(),
            sent: Some(MetadataValue::Text("sent".into())),
            before: Some(MetadataValue::Text("before".into())),
            observed: Some(MetadataValue::Text("observed".into())),
            message: None,
        }
    }

    fn audit_record(
        target: &MetadataDraftTarget,
        proposed_reconciliation: MetadataDraftReconciliation,
    ) -> TargetApplyAuditRecord {
        TargetApplyAuditRecord {
            target: target.clone(),
            derived_reason: None,
            display_name: "Test".into(),
            intent: EditIntent::Set,
            sent: Some(MetadataValue::Text("sent".into())),
            before: Some(MetadataValue::Text("before".into())),
            write: TargetApplyWriteEvidence {
                selector: target
                    .write_target()
                    .cloned()
                    .unwrap_or_else(|| MetadataWriteTarget {
                        group1: "IFD0".into(),
                        group7: format!("ID-{}", target.schema_id().tag_id),
                        tag_name: format!("Tag{}", target.schema_id().tag_id),
                    }),
                arguments: vec!["-raw".into()],
                pass: TargetApplyPassStatus::Succeeded,
                diagnostic: None,
            },
            post_write: TargetApplyPostWriteState::Missing,
            verification: TargetApplyVerificationEvidence {
                kind: "Match".into(),
                message: None,
                proposed_reconciliation,
            },
        }
    }

    fn outcome(
        error: Option<&str>,
        outcomes: Vec<MetadataTargetOutcome>,
    ) -> MetadataSingleFileOutcome {
        let audit_records = outcomes
            .iter()
            .map(|outcome| audit_record(&outcome.target, outcome.draft_reconciliation.clone()))
            .collect();
        MetadataSingleFileOutcome {
            fresh_file_metadata: None,
            error: error.map(str::to_owned),
            warning: Some("warning".into()),
            outcomes,
            targets_to_clear: Vec::new(),
            audit_records,
        }
    }

    #[test]
    fn target_batch_apply_leaves_historical_apply_log_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let historical_path = dir.path().join("MediaLibraryApplyLog.jsonl");
        let historical_bytes = b"historical apply evidence\r\n\0kept exactly";
        fs::write(&historical_path, historical_bytes).unwrap();

        let target = new_target("270");
        let persistence =
            FakePersistence::new(Ok(drafts(&[("file.jpg", entry(target.clone(), "draft"))])));
        let apply = FakeApply::new([(
            "file.jpg".to_string(),
            outcome(
                None,
                vec![target_outcome(&target, MetadataDraftReconciliation::Keep)],
            ),
        )]);

        let result = run_apply_metadata_draft_edits_with(
            dir.path().to_str().unwrap(),
            &["file.jpg".to_string()],
            &persistence,
            &apply,
            &RealDraftReconciler,
            &FakeTargetLogger::default(),
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();

        assert!(result.files[0].applied);
        assert_eq!(fs::read(historical_path).unwrap(), historical_bytes);
    }

    fn drafts(items: &[(&str, MetadataTargetDraftEntry)]) -> MetadataTargetDraftsByFile {
        let mut result = MetadataTargetDraftsByFile::new();
        for (path, item) in items {
            result
                .entry((*path).to_owned())
                .or_default()
                .push(item.clone());
        }
        result
    }

    #[test]
    fn target_state_acquisition_is_exclusive_and_ownership_aware() {
        let state = ApplyEditsState::new();

        let active = state.try_install().expect("first acquisition must succeed");
        assert_eq!(state.try_install().unwrap_err(), ApplyEditsBusyError);

        assert!(state.signal_cancel());
        assert!(active.load(Ordering::Relaxed));

        let unrelated = Arc::new(AtomicBool::new(false));
        state.clear_if_mine(&unrelated);
        assert_eq!(state.try_install().unwrap_err(), ApplyEditsBusyError);

        state.clear_if_mine(&active);
        let reacquired = state
            .try_install()
            .expect("clearing the active flag must permit reacquisition");
        assert!(!reacquired.load(Ordering::Relaxed));

        state.clear();
        assert!(state.try_install().is_ok());
    }

    #[test]
    fn target_busy_error_text_is_stable_and_descriptive() {
        assert_eq!(
            ApplyEditsBusyError.to_string(),
            "A target-aware metadata apply operation is already running"
        );
    }

    #[derive(Debug, Default, PartialEq, Eq)]
    struct AdmissionEffects {
        workers: usize,
        loads: usize,
        started_events: usize,
        progress_events: usize,
        applies: usize,
        saves: usize,
    }

    #[tokio::test]
    async fn busy_command_starts_no_worker_events_or_persistence_work() {
        let state = ApplyEditsState::new();
        let active = state.try_install().unwrap();
        let effects = Arc::new(Mutex::new(AdmissionEffects::default()));
        let effects_for_worker = effects.clone();

        let result = run_apply_edits_command(&state, move |_| {
            let mut effects = effects_for_worker.lock().unwrap();
            effects.workers += 1;
            effects.loads += 1;
            effects.started_events += 1;
            effects.progress_events += 1;
            effects.applies += 1;
            effects.saves += 1;
            std::future::ready::<Result<Result<(), String>, String>>(Ok(Ok(())))
        })
        .await;

        assert_eq!(
            result,
            Err("A target-aware metadata apply operation is already running".into())
        );
        assert_eq!(*effects.lock().unwrap(), AdmissionEffects::default());
        assert!(!active.load(Ordering::Relaxed));
        state.clear_if_mine(&active);
    }

    #[tokio::test]
    async fn command_lifecycle_releases_after_completion_and_worker_error() {
        let state = ApplyEditsState::new();
        let completed = run_apply_edits_command(&state, |_| {
            std::future::ready::<Result<Result<&'static str, String>, &'static str>>(Ok(Ok(
                "completed",
            )))
        })
        .await;
        assert_eq!(completed, Ok("completed"));

        let worker_error = run_apply_edits_command(&state, |_| {
            std::future::ready::<Result<Result<(), String>, &'static str>>(Ok(Err(
                "worker failed".into()
            )))
        })
        .await;
        assert_eq!(worker_error, Err("worker failed".into()));

        let reacquired = state
            .try_install()
            .expect("worker error must release command state");
        state.clear_if_mine(&reacquired);
    }

    #[tokio::test]
    async fn command_lifecycle_releases_after_worker_panic_join_failure() {
        let state = ApplyEditsState::new();
        let result = run_apply_edits_command(&state, |_| {
            tokio::task::spawn_blocking(|| -> Result<(), String> {
                panic!("simulated target-aware worker panic")
            })
        })
        .await;

        assert!(result
            .unwrap_err()
            .starts_with("Target-aware apply edits worker failed:"));
        let reacquired = state
            .try_install()
            .expect("join failure must release command state");
        state.clear_if_mine(&reacquired);
    }

    #[test]
    fn strict_load_and_duplicate_validation_precede_all_events_and_work() {
        let events = FakeEvents::default();
        let apply = FakeApply::new([]);
        let persistence = FakePersistence::new(Err("malformed target-aware".into()));
        let error = run_apply_metadata_draft_edits_with(
            "folder",
            &["a.jpg".into()],
            &persistence,
            &apply,
            &RealDraftReconciler,
            &FakeTargetLogger::default(),
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(error, "malformed target-aware");
        assert!(events.events.lock().unwrap().is_empty());

        let target = new_target("1");
        let persistence = FakePersistence::new(Ok(drafts(&[("a.jpg", entry(target, "x"))])));
        let error = run_apply_metadata_draft_edits_with(
            "folder",
            &["a.jpg".into(), "a.jpg".into()],
            &persistence,
            &apply,
            &RealDraftReconciler,
            &FakeTargetLogger::default(),
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert!(error.contains("a.jpg"));
        assert!(events.events.lock().unwrap().is_empty());
        assert!(apply.calls.lock().unwrap().is_empty());
        assert!(persistence.saves.lock().unwrap().is_empty());
    }

    #[test]
    fn zero_selected_starts_once_and_requested_reserved_path_order_is_exact() {
        let events = FakeEvents::default();
        let empty = FakePersistence::new(Ok(MetadataTargetDraftsByFile::new()));
        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["missing.jpg".into()],
            &empty,
            &FakeApply::new([]),
            &RealDraftReconciler,
            &FakeTargetLogger::default(),
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.files.is_empty());
        assert_eq!(
            events.events.lock().unwrap().as_slice(),
            &[
                RecordedEvent::Started { total: 0 },
                RecordedEvent::Complete(result.summary.clone()),
            ]
        );

        for reserved in [
            "__proto__",
            "constructor",
            "prototype",
            "toString",
            "hasOwnProperty",
        ] {
            let target = new_target(reserved);
            let persistence =
                FakePersistence::new(Ok(drafts(&[(reserved, entry(target.clone(), "x"))])));
            let apply = FakeApply::new([(
                reserved.into(),
                outcome(
                    None,
                    vec![target_outcome(&target, MetadataDraftReconciliation::Keep)],
                ),
            )]);
            let result = run_apply_metadata_draft_edits_with(
                "folder",
                &["absent".into(), reserved.into()],
                &persistence,
                &apply,
                &RealDraftReconciler,
                &FakeTargetLogger::default(),
                &FakeEvents::default(),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
            assert_eq!(result.files[0].relative_path, reserved);
        }
    }

    #[test]
    fn cancellation_is_observed_only_at_file_boundaries() {
        let state = ApplyEditsState::new();
        let current = state.try_install().unwrap();
        assert!(state.signal_cancel());
        assert!(current.load(Ordering::Relaxed));
        state.clear_if_mine(&current);
        assert!(!state.signal_cancel());

        let first_target = new_target("1");
        let second_target = new_target("2");
        let persistence = FakePersistence::new(Ok(drafts(&[
            ("first.jpg", entry(first_target.clone(), "a")),
            ("second.jpg", entry(second_target.clone(), "b")),
        ])));
        let flag = Arc::new(AtomicBool::new(false));
        let mut apply = FakeApply::new([
            (
                "first.jpg".into(),
                outcome(
                    None,
                    vec![target_outcome(
                        &first_target,
                        MetadataDraftReconciliation::Clear,
                    )],
                ),
            ),
            (
                "second.jpg".into(),
                outcome(
                    None,
                    vec![target_outcome(
                        &second_target,
                        MetadataDraftReconciliation::Clear,
                    )],
                ),
            ),
        ]);
        apply.cancel_after = Some(("first.jpg".into(), flag.clone()));
        let logger = FakeTargetLogger::default();
        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["first.jpg".into(), "second.jpg".into()],
            &persistence,
            &apply,
            &RealDraftReconciler,
            &logger,
            &FakeEvents::default(),
            flag,
        )
        .unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].persisted_draft_entries, Some(Vec::new()));
        assert!(result.summary.cancelled);
        assert!(!result.summary.aborted);
        assert_eq!(result.summary.abort_reason, None);
        let logs = logger.calls.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].relative_path, "first.jpg");
    }

    #[test]
    fn clear_keep_blocked_and_replace_use_structured_reconciliation_and_complete_saves() {
        let clear = new_target("1");
        let keep = existing_target("2", "JPEG-APP1-IFD0");
        let blocked = existing_target("3", "JPEG-APP1-IFD1");
        let replace_source = new_target("4");
        let replacement = existing_target("4", "JPEG-APP1-IFD0");
        let unrelated = new_target("9");
        let original_replace_edit = entry(replace_source.clone(), "original edit");
        let persistence = FakePersistence::new(Ok(drafts(&[
            ("clear.jpg", entry(clear.clone(), "clear")),
            ("keep.jpg", entry(keep.clone(), "keep")),
            ("blocked.jpg", entry(blocked.clone(), "blocked")),
            ("replace.jpg", original_replace_edit.clone()),
            ("unrelated.jpg", entry(unrelated, "untouched")),
        ])));
        let apply = FakeApply::new([
            (
                "clear.jpg".into(),
                outcome(
                    None,
                    vec![target_outcome(&clear, MetadataDraftReconciliation::Clear)],
                ),
            ),
            (
                "keep.jpg".into(),
                outcome(
                    Some("semantic mismatch without draft change"),
                    vec![target_outcome(&keep, MetadataDraftReconciliation::Keep)],
                ),
            ),
            (
                "blocked.jpg".into(),
                outcome(
                    None,
                    vec![target_outcome(
                        &blocked,
                        MetadataDraftReconciliation::Blocked {
                            reason: "stale".into(),
                        },
                    )],
                ),
            ),
            (
                "replace.jpg".into(),
                outcome(
                    Some("semantic mismatch"),
                    vec![target_outcome(
                        &replace_source,
                        MetadataDraftReconciliation::Replace {
                            target: replacement.clone(),
                        },
                    )],
                ),
            ),
        ]);
        let events = FakeEvents::default();
        let logger = FakeTargetLogger::default();
        let result = run_apply_metadata_draft_edits_with_limits(
            "folder",
            Some(&[
                "clear.jpg".into(),
                "keep.jpg".into(),
                "blocked.jpg".into(),
                "replace.jpg".into(),
            ]),
            &persistence,
            &apply,
            &RealDraftReconciler,
            &logger,
            &events,
            "test-operation",
            Arc::new(AtomicBool::new(false)),
            4,
            1,
        )
        .unwrap();
        assert_eq!(persistence.saves.lock().unwrap().len(), 1);
        assert_eq!(result.files[0].persisted_draft_entries, Some(Vec::new()));
        assert_eq!(result.files[1].persisted_draft_entries, None);
        assert!(!result.files[1].applied);
        assert_eq!(result.files[2].persisted_draft_entries, None);
        assert!(!result.files[3].applied);
        let replaced = result.files[3].persisted_draft_entries.as_ref().unwrap();
        assert_eq!(replaced[0].target, replacement);
        assert_eq!(replaced[0].edit, original_replace_edit.edit);
        assert!(persistence
            .saves
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .contains_key("unrelated.jpg"));
        let logs = logger.calls.lock().unwrap();
        assert_eq!(logs.len(), 4);
        assert_eq!(
            logs.iter()
                .map(|call| call.draft_persistence.clone())
                .collect::<Vec<_>>(),
            vec![
                TargetDraftPersistenceOutcome::Persisted,
                TargetDraftPersistenceOutcome::Unchanged,
                TargetDraftPersistenceOutcome::Unchanged,
                TargetDraftPersistenceOutcome::Persisted,
            ]
        );
    }

    #[test]
    fn hard_failure_without_outcomes_does_not_save_or_abort() {
        let target = new_target("1");
        let persistence = FakePersistence::new(Ok(drafts(&[("a.jpg", entry(target, "x"))])));
        let logger = FakeTargetLogger::default();
        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["a.jpg".into()],
            &persistence,
            &FakeApply::new([("a.jpg".into(), outcome(Some("planning failed"), Vec::new()))]),
            &RealDraftReconciler,
            &logger,
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(!result.files[0].applied);
        assert!(!result.summary.aborted);
        assert!(persistence.saves.lock().unwrap().is_empty());
        assert!(logger.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn reconciliation_and_persistence_failures_emit_progress_and_abort_later_files() {
        let first = new_target("1");
        let later = new_target("2");
        let persistence = FakePersistence::new(Ok(drafts(&[
            ("first.jpg", entry(first.clone(), "x")),
            ("later.jpg", entry(later.clone(), "y")),
        ])));
        let apply = FakeApply::new([
            (
                "first.jpg".into(),
                outcome(
                    Some("semantic mismatch"),
                    vec![
                        target_outcome(&first, MetadataDraftReconciliation::Keep),
                        target_outcome(&first, MetadataDraftReconciliation::Keep),
                    ],
                ),
            ),
            (
                "later.jpg".into(),
                outcome(
                    None,
                    vec![target_outcome(&later, MetadataDraftReconciliation::Clear)],
                ),
            ),
        ]);
        let events = FakeEvents::default();
        let reconciliation_logger = FakeTargetLogger::default();
        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["first.jpg".into(), "later.jpg".into()],
            &persistence,
            &apply,
            &RealDraftReconciler,
            &reconciliation_logger,
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.summary.aborted);
        assert!(!result.summary.cancelled);
        assert_eq!(result.files.len(), 1);
        assert!(result.files[0]
            .error
            .as_ref()
            .unwrap()
            .contains("semantic mismatch"));
        assert!(result.files[0]
            .error
            .as_ref()
            .unwrap()
            .contains("reconciliation failed"));
        assert_eq!(events.events.lock().unwrap().len(), 3);
        assert!(persistence.saves.lock().unwrap().is_empty());
        let reconciliation_logs = reconciliation_logger.calls.lock().unwrap();
        assert_eq!(reconciliation_logs.len(), 1);
        let TargetDraftPersistenceOutcome::ReconciliationFailed { error } =
            &reconciliation_logs[0].draft_persistence
        else {
            panic!("expected reconciliation failure")
        };
        assert_eq!(Some(error), result.summary.abort_reason.as_ref());
        drop(reconciliation_logs);

        let mut failing = FakePersistence::new(Ok(drafts(&[
            ("first.jpg", entry(first.clone(), "x")),
            ("later.jpg", entry(later, "y")),
        ])));
        failing.save_error = Some("disk uncertain".into());
        let persistence_logger = FakeTargetLogger::default();
        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["first.jpg".into(), "later.jpg".into()],
            &failing,
            &FakeApply::new([(
                "first.jpg".into(),
                outcome(
                    Some("write failed"),
                    vec![target_outcome(&first, MetadataDraftReconciliation::Clear)],
                ),
            )]),
            &RealDraftReconciler,
            &persistence_logger,
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.summary.aborted);
        let error = result.files[0].error.as_ref().unwrap();
        assert!(error.contains("write failed") && error.contains("disk uncertain"));
        assert_eq!(result.files[0].persisted_draft_entries, None);
        let persistence_logs = persistence_logger.calls.lock().unwrap();
        assert_eq!(persistence_logs.len(), 1);
        let TargetDraftPersistenceOutcome::PersistenceFailed { error } =
            &persistence_logs[0].draft_persistence
        else {
            panic!("expected persistence failure")
        };
        assert_eq!(Some(error), result.summary.abort_reason.as_ref());
    }

    #[test]
    fn mixed_same_schema_targets_log_separately_in_original_order_after_one_save() {
        let ifd0 = existing_target("282", "JPEG-APP1-IFD0");
        let ifd1 = existing_target("282", "JPEG-APP1-IFD1");
        let persistence = FakePersistence::new(Ok(drafts(&[
            ("file.jpg", entry(ifd0.clone(), "first")),
            ("file.jpg", entry(ifd1.clone(), "second")),
        ])));
        let apply = FakeApply::new([(
            "file.jpg".into(),
            outcome(
                None,
                vec![
                    target_outcome(&ifd0, MetadataDraftReconciliation::Clear),
                    target_outcome(&ifd1, MetadataDraftReconciliation::Clear),
                ],
            ),
        )]);
        let logger = FakeTargetLogger::default();

        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["file.jpg".into()],
            &persistence,
            &apply,
            &RealDraftReconciler,
            &logger,
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();

        assert_eq!(persistence.saves.lock().unwrap().len(), 1);
        assert_eq!(result.files[0].persisted_draft_entries, Some(Vec::new()));
        let logs = logger.calls.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(
            logs[0].draft_persistence,
            TargetDraftPersistenceOutcome::Persisted
        );
        assert_eq!(logs[0].records.len(), 2);
        assert_eq!(logs[0].records[0].target, ifd0);
        assert_eq!(logs[0].records[1].target, ifd1);
    }

    #[test]
    fn new_property_target_and_exact_created_occurrence_cross_logger_boundary_unchanged() {
        let target = new_target("282");
        let created = TargetApplyObservedOccurrence {
            occurrence_id: MetadataOccurrenceId {
                document: None,
                path: "JPEG-APP1-IFD0".into(),
                runtime_tag_id: "282".into(),
                tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                    table: "Exif::Main".into(),
                    tag_id: "282".into(),
                    index: None,
                },
                copy: 0,
            },
            schema_id: Some(schema("282")),
            write_target: Some(MetadataWriteTarget {
                group1: "IFD0".into(),
                group7: "ID-282".into(),
                tag_name: "XResolution".into(),
            }),
            value: MetadataValue::Integer(300),
        };
        let mut applied = outcome(
            None,
            vec![target_outcome(&target, MetadataDraftReconciliation::Clear)],
        );
        applied.audit_records[0].post_write = TargetApplyPostWriteState::Unique {
            occurrence: Box::new(created.clone()),
        };
        let logger = FakeTargetLogger::default();

        run_apply_metadata_draft_edits_with(
            "folder",
            &["created.jpg".into()],
            &FakePersistence::new(Ok(drafts(&[("created.jpg", entry(target.clone(), "300"))]))),
            &FakeApply::new([("created.jpg".into(), applied)]),
            &RealDraftReconciler,
            &logger,
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();

        let logs = logger.calls.lock().unwrap();
        assert_eq!(logs[0].records[0].target, target);
        let TargetApplyPostWriteState::Unique { occurrence } = &logs[0].records[0].post_write
        else {
            panic!("expected unique created occurrence")
        };
        assert_eq!(occurrence.as_ref(), &created);
    }

    #[test]
    fn logger_failure_is_non_fatal_and_later_files_are_still_applied_and_logged() {
        let first = new_target("1");
        let second = new_target("2");
        let persistence = FakePersistence::new(Ok(drafts(&[
            ("first.jpg", entry(first.clone(), "first")),
            ("second.jpg", entry(second.clone(), "second")),
        ])));
        let apply = FakeApply::new([
            (
                "first.jpg".into(),
                outcome(
                    None,
                    vec![target_outcome(&first, MetadataDraftReconciliation::Keep)],
                ),
            ),
            (
                "second.jpg".into(),
                outcome(
                    None,
                    vec![target_outcome(&second, MetadataDraftReconciliation::Keep)],
                ),
            ),
        ]);
        let logger =
            FakeTargetLogger::with_results([Err("log destination unavailable".into()), Ok(())]);

        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["first.jpg".into(), "second.jpg".into()],
            &persistence,
            &apply,
            &RealDraftReconciler,
            &logger,
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();

        assert_eq!(result.files.len(), 2);
        assert!(result.files.iter().all(|file| file.applied));
        assert!(result.files.iter().all(|file| file.error.is_none()));
        assert!(result
            .files
            .iter()
            .all(|file| file.warning.as_deref() == Some("warning")));
        assert!(!result.summary.aborted);
        assert_eq!(
            apply.calls.lock().unwrap().as_slice(),
            &["first.jpg", "second.jpg"]
        );
        let logs = logger.calls.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].relative_path, "first.jpg");
        assert_eq!(logs[1].relative_path, "second.jpg");
    }

    fn run_traced_batch(
        reconciliation_fails: bool,
        save_fails: bool,
    ) -> (MetadataApplyResult, Vec<&'static str>) {
        let trace = Arc::new(Mutex::new(Vec::new()));
        let target = new_target("1");
        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["a.jpg".into()],
            &TracePersistence {
                drafts: drafts(&[("a.jpg", entry(target.clone(), "value"))]),
                trace: trace.clone(),
                save_error: save_fails,
            },
            &TraceApply {
                outcome: outcome(
                    None,
                    vec![target_outcome(&target, MetadataDraftReconciliation::Clear)],
                ),
                trace: trace.clone(),
            },
            &TraceReconciler {
                trace: trace.clone(),
                fail: reconciliation_fails,
            },
            &TraceLogger {
                trace: trace.clone(),
            },
            &TraceEvents {
                trace: trace.clone(),
            },
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let recorded = trace.lock().unwrap().clone();
        (result, recorded)
    }

    #[test]
    fn apply_reconcile_save_log_and_progress_order_is_explicit_on_every_path() {
        let (successful, successful_trace) = run_traced_batch(false, false);
        assert!(!successful.summary.aborted);
        assert_eq!(
            successful_trace,
            ["apply", "reconcile", "save", "log", "progress"]
        );

        let (reconciliation_failed, reconciliation_trace) = run_traced_batch(true, false);
        assert!(reconciliation_failed.summary.aborted);
        assert_eq!(
            reconciliation_trace,
            ["apply", "reconcile", "log", "progress"]
        );

        let (persistence_failed, persistence_trace) = run_traced_batch(false, true);
        assert!(persistence_failed.summary.aborted);
        assert_eq!(
            persistence_trace,
            ["apply", "reconcile", "save", "log", "progress"]
        );
    }

    #[test]
    fn progress_preserves_full_metadata_outcomes_and_ignores_emit_failures() {
        let target = new_target("1");
        let metadata = scanner::FileMetadata {
            relative_path: "a.jpg".into(),
            occurrences: MetadataOccurrences(vec![MetadataOccurrence {
                id: MetadataOccurrenceId {
                    document: None,
                    path: "JPEG-APP1-IFD0".into(),
                    runtime_tag_id: "1".into(),
                    tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                        table: "Exif::Main".into(),
                        tag_id: "1".into(),
                        index: None,
                    },
                    copy: 0,
                },
                schema_id: schema("1"),
                value: MetadataValue::Text("authoritative".into()),
                tag_info: None,
                observed_selector: None,
                write_target: None,
            }]),
        };
        let mut applied = outcome(
            None,
            vec![target_outcome(&target, MetadataDraftReconciliation::Keep)],
        );
        applied.fresh_file_metadata = Some(metadata.clone());
        let events = FakeEvents {
            events: Mutex::new(Vec::new()),
            fail: true,
        };
        let result = run_apply_metadata_draft_edits_with(
            "folder",
            &["a.jpg".into()],
            &FakePersistence::new(Ok(drafts(&[("a.jpg", entry(target, "x"))]))),
            &FakeApply::new([("a.jpg".into(), applied)]),
            &RealDraftReconciler,
            &FakeTargetLogger::default(),
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.files[0].applied);
        assert_eq!(result.files[0].fresh_file_metadata, Some(metadata));
        let recorded = events.events.lock().unwrap();
        let RecordedEvent::ProgressBatch {
            current,
            total,
            results,
            ..
        } = &recorded[1]
        else {
            panic!()
        };
        assert_eq!(*current, 1);
        assert_eq!(*total, 1);
        assert_eq!(results.as_slice(), result.files.as_slice());
        let progress_json = serde_json::to_value(&results[0]).unwrap();
        assert!(progress_json.get("target_outcomes").is_some());
        assert!(progress_json.to_string().contains("occurrences"));
        assert!(!progress_json.to_string().contains("slot"));
        assert!(!progress_json.to_string().contains("audit_records"));
        assert!(!progress_json.to_string().contains("draft_persistence"));
        let terminal_json = serde_json::to_value(&result).unwrap();
        assert!(terminal_json.get("files").is_none());
        assert_eq!(
            terminal_json["undelivered_files"],
            serde_json::to_value(&result.files).unwrap()
        );
        assert_eq!(result.summary.delivery_failure_count, 1);
        assert!(result.complete_delivery_failed);
        assert!(!progress_json.to_string().contains("post_write"));
        assert!(!progress_json.to_string().contains("identity_model"));
    }

    #[test]
    fn bounded_executor_runs_multiple_items_concurrently_without_exceeding_limit() {
        use std::sync::atomic::AtomicUsize;
        use std::time::Duration;

        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let first_wave = std::sync::Barrier::new(3);
        let cancel = Arc::new(AtomicBool::new(false));
        let items = (0..8).map(|index| (index, index)).collect();

        let mut completed = crate::batch_job::run_bounded_blocking(
            items,
            NonZeroUsize::new(3).unwrap(),
            &cancel,
            |value| {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                if value < 3 {
                    first_wave.wait();
                }
                std::thread::sleep(Duration::from_millis(15));
                active.fetch_sub(1, Ordering::SeqCst);
                value
            },
        );
        completed.sort_by_key(|(index, _)| *index);

        assert_eq!(
            completed,
            (0..8).map(|index| (index, index)).collect::<Vec<_>>()
        );
        assert!(peak.load(Ordering::SeqCst) >= 2);
        assert!(peak.load(Ordering::SeqCst) <= 3);
    }

    #[test]
    fn configured_apply_batch_size_and_concurrency_reach_batch_executor() {
        #[derive(Default)]
        struct RecordingBatchApply {
            calls: Mutex<Vec<(Vec<String>, usize)>>,
        }

        impl SingleFileApply for RecordingBatchApply {
            fn apply(
                &self,
                _folder_path: &str,
                _relative_path: &str,
                _edits: &[MetadataTargetDraftEntry],
            ) -> MetadataSingleFileOutcome {
                panic!("configured batches must use apply_batch")
            }

            fn apply_batch(
                &self,
                _folder_path: &str,
                jobs: &[(String, Vec<MetadataTargetDraftEntry>)],
                write_concurrency: usize,
                _cancel_flag: &Arc<AtomicBool>,
            ) -> Vec<(String, MetadataSingleFileOutcome)> {
                self.calls.lock().unwrap().push((
                    jobs.iter().map(|(path, _)| path.clone()).collect(),
                    write_concurrency,
                ));
                jobs.iter()
                    .map(|(path, _)| {
                        (
                            path.clone(),
                            MetadataSingleFileOutcome {
                                fresh_file_metadata: None,
                                error: None,
                                warning: None,
                                outcomes: Vec::new(),
                                targets_to_clear: Vec::new(),
                                audit_records: Vec::new(),
                            },
                        )
                    })
                    .collect()
            }
        }

        let paths = (0..5)
            .map(|index| format!("{index}.jpg"))
            .collect::<Vec<_>>();
        let target = new_target("1");
        let draft_items = paths
            .iter()
            .map(|path| (path.as_str(), entry(target.clone(), "x")))
            .collect::<Vec<_>>();
        let apply = RecordingBatchApply::default();

        let result = run_apply_metadata_draft_edits_with_limits(
            "folder",
            Some(&paths),
            &FakePersistence::new(Ok(drafts(&draft_items))),
            &apply,
            &RealDraftReconciler,
            &FakeTargetLogger::default(),
            &FakeEvents::default(),
            "test-operation",
            Arc::new(AtomicBool::new(false)),
            2,
            3,
        )
        .unwrap();

        assert_eq!(result.files.len(), 5);
        assert_eq!(
            *apply.calls.lock().unwrap(),
            vec![
                (vec!["0.jpg".into(), "1.jpg".into()], 3),
                (vec!["2.jpg".into(), "3.jpg".into()], 3),
                (vec!["4.jpg".into()], 3),
            ]
        );
    }

    #[cfg(feature = "integration")]
    #[test]
    fn real_batch_pipeline_round_trips_multiple_files() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test_images")
            .join("rating_3.jpg");
        let temp = tempfile::tempdir().unwrap();
        let rating_id = crate::known_ids::xmp_rating();
        let paths = (0..4)
            .map(|index| {
                let relative_path = format!("rating-{index}.jpg");
                fs::copy(&source, temp.path().join(&relative_path)).unwrap();
                relative_path
            })
            .collect::<Vec<_>>();
        let mut before = read_metadata_for_jobs(temp.path().to_str().unwrap(), &paths);
        let jobs = paths
            .iter()
            .map(|relative_path| {
                let metadata = before.remove(relative_path).unwrap().unwrap();
                let occurrence = metadata
                    .occurrences
                    .iter()
                    .find(|occurrence| occurrence.schema_id == rating_id)
                    .expect("rating occurrence");
                let target = MetadataDraftTarget::ExistingOccurrence {
                    occurrence_id: occurrence.id.clone(),
                    schema_id: rating_id.clone(),
                    write_target: occurrence.write_target.clone().expect("writable rating"),
                };
                (
                    relative_path.clone(),
                    vec![MetadataTargetDraftEntry {
                        target,
                        edit: MetadataDraftEdit {
                            value: Some(MetadataValue::Real(5.0)),
                            intent: EditIntent::Set,
                        },
                    }],
                )
            })
            .collect::<Vec<_>>();

        let outcomes = apply_real_metadata_batch(
            temp.path().to_str().unwrap(),
            &jobs,
            2,
            &Arc::new(AtomicBool::new(false)),
        );

        assert_eq!(outcomes.len(), jobs.len());
        for (index, (relative_path, outcome)) in outcomes.iter().enumerate() {
            assert_eq!(relative_path, &paths[index]);
            assert!(outcome.fresh_file_metadata.is_some());
            assert_eq!(outcome.outcomes.len(), 1);
            assert!(matches!(
                outcome.outcomes[0].kind.as_str(),
                "Match" | "Coerced"
            ));
        }
    }
}
