//! Shared primitives for per-image batch jobs.
//!
//! Several Media Library features run the same shape of operation:
//! iterate a list of relative paths, process each one (network call,
//! local compute, …), emit progress events, accumulate failures, and
//! finish with a summary. The AI-description flow was the first; the
//! reverse-geocoding flow is the second; more are likely.
//!
//! Rather than copy-paste the loop, the truly shared bits are extracted
//! here:
//!
//!  - `BatchJobCancelState` — cooperative cancellation flag installed at
//!    job start, signalled by the cancel command, checked at item
//!    boundaries by the loop.
//!  - `BatchFailureRow` — the wire shape of a per-item failure entry in
//!    the `${prefix}_complete` payload. Identical across jobs by design;
//!    the frontend's failure list renders any job's failures the same
//!    way.
//!  - `BatchProgressEmitter` — typed wrapper around `app.emit` that
//!    prepends the job's event prefix so the four event names
//!    (`${prefix}_started` / `${prefix}_progress` / `${prefix}_complete`
//!    and the per-job `${prefix}_*` extras) can't drift between caller
//!    and listener.
//!
//! The per-item business logic stays in each job's own module
//! (`openai_describe.rs`, `geocode.rs`). Keeping the inner loop body in
//! each command — rather than abstracting it behind an async-trait —
//! avoids generics gymnastics and keeps each command readable on its
//! own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{future::Future, num::NonZeroUsize};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Typed wire kind for a per-image batch-job failure.
///
/// Each variant serialises to the snake-case string that has historically
/// been used as the stringly `kind` field on `BatchFailureRow`,
/// `DescribeFailure`, and `GeocodeFailure`. Switching to an enum lets the
/// frontend exhaustively render friendly labels and lets Rust callers stop
/// allocating `String`s for static error labels.
///
/// Variants are grouped by where they originate. New batch features (e.g.
/// the metadata-normaliser planned in `docs/NORMALISE_METADATA_PLAN.md`)
/// add their own variants here so the wire contract stays in one place.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum BatchFailureKind {
    // ── Shared transport / lifecycle ────────────────────────────────────
    /// HTTP request returned a non-2xx status.
    Http,
    /// Transport-layer network error (DNS, connection, timeout, …).
    Network,
    /// The user cancelled the run before this item completed.
    Cancelled,
    /// Frontend-synthesised: the Tauri command itself threw before
    /// reporting any per-image progress (rare; surfaces as a single
    /// failure row with `relativePath = "(batch)"`).
    CommandFailed,
    /// Frontend-synthesised: the estimate-phase preflight (e.g.
    /// describe's `/responses/input_tokens` per-image walk) errored
    /// before any image was processed for real. Every input image
    /// surfaces with this kind so the user sees the run aborted up-front
    /// rather than after a partial batch.
    PreflightFailed,

    // ── AI-description ─────────────────────────────────────────────────
    /// Local image decode / downscale failed (corrupt file, unsupported
    /// format, …). The API was never called for this image.
    Decode,
    /// API responded with `status: "incomplete"` — typically max-output-
    /// tokens hit. The partial response is unparseable.
    Incomplete,
    /// API refused to answer (policy refusal in `output[].refusal`).
    Refused,
    /// API returned a 2xx response whose JSON body didn't match the
    /// expected schema.
    BadJson,
    /// `usage` block missing or malformed in an otherwise-successful
    /// response. Kept distinct from `BadJson` so a cost-reporting gap
    /// doesn't get conflated with content-parse failures in the audit
    /// log.
    UsageParse,

    // ── Reverse-geocode ────────────────────────────────────────────────
    /// Image had no resolvable GPS coordinates (neither draft nor
    /// metadata). Counted separately from real failures in the summary.
    NoGps,
    /// Nominatim returned no usable address fields for the GPS query.
    NominatimEmpty,
    /// Reading or writing the local geocache file failed.
    CacheIo,

    // ── Metadata-normaliser ────────────────────────────────────────────
    /// OpenAI returned a non-2xx response or a transport error during
    /// Group B description merge / Group C title generation.
    AiCallFailed,
    /// AI response parsed as JSON but missing the required field for the
    /// structured-output schema.
    AiSchemaInvalid,
    /// AI returned HTTP 429.
    AiRateLimited,
    /// Appending to the normaliser audit JSONL log failed.
    AuditLogIo,
    /// Bug in the normaliser surfaced as a per-image failure rather than
    /// crashing the whole batch. Detail string carries the message.
    Internal,
    /// Required by plan §6: no OpenAI API key configured but the user
    /// enabled a group that needs AI (Group B distinct sources, or
    /// Group C all-empty + description present).
    AiKeyMissing,
}

impl BatchFailureKind {
    /// Snake-case wire form used in event payloads. Allocates nothing.
    pub fn as_wire(&self) -> &'static str {
        match self {
            BatchFailureKind::Http => "http",
            BatchFailureKind::Network => "network",
            BatchFailureKind::Cancelled => "cancelled",
            BatchFailureKind::CommandFailed => "command_failed",
            BatchFailureKind::PreflightFailed => "preflight_failed",
            BatchFailureKind::Decode => "decode",
            BatchFailureKind::Incomplete => "incomplete",
            BatchFailureKind::Refused => "refused",
            BatchFailureKind::BadJson => "bad_json",
            BatchFailureKind::UsageParse => "usage_parse",
            BatchFailureKind::NoGps => "no_gps",
            BatchFailureKind::NominatimEmpty => "nominatim_empty",
            BatchFailureKind::CacheIo => "cache_io",
            BatchFailureKind::AiCallFailed => "ai_call_failed",
            BatchFailureKind::AiSchemaInvalid => "ai_schema_invalid",
            BatchFailureKind::AiRateLimited => "ai_rate_limited",
            BatchFailureKind::AuditLogIo => "audit_log_io",
            BatchFailureKind::Internal => "internal",
            BatchFailureKind::AiKeyMissing => "ai_key_missing",
        }
    }
}

impl std::fmt::Display for BatchFailureKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_wire())
    }
}

/// Cooperative cancellation flag shared between a running batch loop and
/// the `cancel_${prefix}_cmd` Tauri command.
///
/// Lifecycle:
///
/// 1. The command handler that starts the loop calls `install()` to get
///    a fresh `AtomicBool` and stores the loop's reference to it.
/// 2. The loop checks the flag at each item boundary (and ideally
///    between sub-calls inside one item) and breaks out when it's set.
/// 3. When the loop exits — success, failure, or cancellation — the
///    handler calls `clear()` so a follow-up cancel command silently
///    no-ops instead of mutating a stale flag.
/// 4. The cancel command handler calls `signal_cancel()` which flips the
///    flag if a flag is currently installed.
///
/// Two distinct features (e.g. describe and geocode) keep their own
/// `BatchJobCancelState` instances so that cancelling one doesn't affect
/// the other.
#[derive(Default)]
pub struct BatchJobCancelState {
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

impl BatchJobCancelState {
    /// Install a fresh cancellation flag and return a clone of it.
    ///
    /// Overwrites any previously-installed flag — only one batch of this
    /// kind can run at a time, and starting a new batch from the
    /// frontend implicitly supersedes any stale flag from a previous
    /// run that didn't `clear()` itself.
    pub fn install(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        *self.cancelled.lock().unwrap() = Some(flag.clone());
        flag
    }

    /// Drop the currently-installed flag.
    ///
    /// Call this exactly once per `install`, after the loop has fully
    /// drained, so a `signal_cancel` arriving later is a no-op rather
    /// than setting a flag that no loop is reading.
    pub fn clear(&self) {
        *self.cancelled.lock().unwrap() = None;
    }

    /// Set the installed flag to `true`, if one is installed.
    ///
    /// Returns `true` when a flag was set; `false` when there is nothing
    /// running. The command handler doesn't strictly need the return
    /// value but it's handy for tests.
    pub fn signal_cancel(&self) -> bool {
        if let Some(f) = self.cancelled.lock().unwrap().as_ref() {
            f.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

/// Run a fixed collection with at most `max_in_flight` asynchronous items
/// active at once.
///
/// Results are passed to `on_complete` as soon as each task finishes, so the
/// caller can emit progress in completion order without sharing aggregate
/// state between workers. Once cancellation is observed, no new items are
/// scheduled; tasks already in flight are allowed to finish.
pub async fn run_bounded<T, O, Work, WorkFuture, Complete>(
    items: Vec<T>,
    max_in_flight: NonZeroUsize,
    cancel_flag: Arc<AtomicBool>,
    work: Work,
    mut on_complete: Complete,
) -> Result<usize, String>
where
    T: Send + 'static,
    O: Send + 'static,
    Work: Fn(T) -> WorkFuture + Send + Sync + 'static,
    WorkFuture: Future<Output = O> + Send + 'static,
    Complete: FnMut(O),
{
    let mut pending = items.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    let work = Arc::new(work);
    let mut dispatched = 0usize;

    loop {
        while tasks.len() < max_in_flight.get() && !cancel_flag.load(Ordering::Relaxed) {
            let Some(item) = pending.next() else {
                break;
            };
            let work = work.clone();
            tasks.spawn(async move { work(item).await });
            dispatched += 1;
        }

        let Some(joined) = tasks.join_next().await else {
            break;
        };
        match joined {
            Ok(outcome) => on_complete(outcome),
            Err(error) => {
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
                return Err(format!("batch worker failed: {error}"));
            }
        }
    }

    Ok(dispatched)
}

/// Synchronous counterpart to [`run_bounded`] for blocking workloads such as
/// ExifTool processes. Workers claim items from one queue, stop claiming when
/// cancellation is observed, and let already-claimed work finish.
pub fn run_bounded_blocking<T, O, Work>(
    items: Vec<(usize, T)>,
    max_in_flight: NonZeroUsize,
    cancel_flag: &Arc<AtomicBool>,
    work: Work,
) -> Vec<(usize, O)>
where
    T: Send,
    O: Send,
    Work: Fn(T) -> O + Sync,
{
    let pending = Mutex::new(std::collections::VecDeque::from(items));
    let completed = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..max_in_flight.get() {
            let work = &work;
            scope.spawn(|| loop {
                if cancel_flag.load(Ordering::Relaxed) {
                    break;
                }
                let next = pending.lock().unwrap().pop_front();
                let Some((index, item)) = next else {
                    break;
                };
                let outcome = work(item);
                completed.lock().unwrap().push((index, outcome));
            });
        }
    });
    completed.into_inner().unwrap()
}

/// Per-item failure entry on the `${prefix}_complete` payload.
///
/// The frontend renders these uniformly across jobs — only the `kind`
/// values differ between jobs. See `BatchFailureKind` for the closed set
/// of wire values.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailureRow {
    pub relative_path: String,
    pub kind: BatchFailureKind,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchMetadataProgress {
    pub current: usize,
    pub total: usize,
    pub relative_path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edits: Option<Vec<crate::draft_edits::SchemaMetadataEdit>>,
}

impl BatchMetadataProgress {
    pub fn new(
        current: usize,
        total: usize,
        relative_path: String,
        status: String,
        error: Option<String>,
        edits: Option<&crate::draft_edits::SchemaMetadataEditMap>,
    ) -> Self {
        Self {
            current,
            total,
            relative_path,
            status,
            error,
            edits: edits
                .cloned()
                .map(crate::draft_edits::schema_metadata_edit_entries),
        }
    }
}

/// Count/age bounded event buffer for sequential batch jobs.
pub struct EventBatch<T> {
    items: Vec<T>,
    max_items: usize,
    max_age: Duration,
    last_flush: std::time::Instant,
    emit_first: bool,
}

impl<T> EventBatch<T> {
    pub fn new(max_items: usize, max_age: Duration, emit_first: bool) -> Self {
        assert!(max_items > 0);
        Self {
            items: Vec::new(),
            max_items,
            max_age,
            last_flush: std::time::Instant::now(),
            emit_first,
        }
    }

    pub fn push(&mut self, item: T) -> Option<Vec<T>> {
        self.items.push(item);
        if self.emit_first {
            self.emit_first = false;
            return self.take();
        }
        if self.items.len() >= self.max_items || self.last_flush.elapsed() >= self.max_age {
            return self.take();
        }
        None
    }

    pub fn flush(&mut self) -> Option<Vec<T>> {
        self.take()
    }

    fn take(&mut self) -> Option<Vec<T>> {
        if self.items.is_empty() {
            return None;
        }
        self.last_flush = std::time::Instant::now();
        Some(std::mem::take(&mut self.items))
    }
}

/// Helper for emitting the three standard events of a batch job with
/// the right prefix.
///
/// Each job is free to emit additional `${prefix}_*` events (e.g.
/// `describe_estimate_*` for the cost-preflight phase) directly through
/// `app.emit`; the emitter just covers the universal three so the
/// prefix string lives in exactly one place per command.
pub struct BatchProgressEmitter<'a> {
    app: &'a AppHandle,
    prefix: &'static str,
    session_id: u64,
    operation_id: String,
    producer: Option<GeneratedDraftProducer>,
    staging_failures: Mutex<Vec<crate::session::MediaLibraryBatchOperationFailure>>,
}

#[derive(Clone, Debug)]
pub enum GeneratedDraftProducer {
    Describe,
    Geocode,
    Normalise {
        enabled_groups: Vec<crate::normalise::NormaliseGroup>,
    },
}

impl GeneratedDraftProducer {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Describe => "describe",
            Self::Geocode => "geocode",
            Self::Normalise { .. } => "normalise",
        }
    }
}

/// Commit a retained operation failure when confirmation cannot safely resume
/// the worker. This keeps malformed or unavailable retained inputs recoverable
/// even though no progress emitter could be constructed.
pub fn fail_retained_operation(app: &AppHandle, session_id: u64, operation_id: &str, error: &str) {
    if let Ok(snapshot) = app
        .state::<crate::session::MediaLibrarySessionState>()
        .fail_batch_operation(session_id, operation_id, error.to_owned())
    {
        let _ = app.emit(crate::session::SESSION_CHANGED_EVENT, snapshot);
    }
}

impl<'a> BatchProgressEmitter<'a> {
    pub fn begin(
        app: &'a AppHandle,
        prefix: &'static str,
        session_id: u64,
        phase: crate::session::MediaLibraryBatchOperationPhase,
        requested_paths: Vec<String>,
        request: Option<serde_json::Value>,
        producer: Option<GeneratedDraftProducer>,
    ) -> Result<Self, String> {
        let total = requested_paths.len();
        let snapshot = app
            .state::<crate::session::MediaLibrarySessionState>()
            .begin_batch_operation(session_id, prefix, phase, total, requested_paths, request)?;
        let operation_id = snapshot
            .batch_operations
            .get(prefix)
            .expect("the operation was inserted above")
            .operation_id
            .clone();
        app.emit(crate::session::SESSION_CHANGED_EVENT, snapshot)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            app,
            prefix,
            session_id,
            operation_id,
            producer,
            staging_failures: Mutex::new(Vec::new()),
        })
    }

    pub fn resume(
        app: &'a AppHandle,
        prefix: &'static str,
        session_id: u64,
        operation_id: String,
        total: usize,
        confirmed_request: Option<serde_json::Value>,
        producer: GeneratedDraftProducer,
    ) -> Result<Self, String> {
        let snapshot = app
            .state::<crate::session::MediaLibrarySessionState>()
            .start_batch_operation(session_id, &operation_id, total, confirmed_request)?;
        app.emit(crate::session::SESSION_CHANGED_EVENT, snapshot)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            app,
            prefix,
            session_id,
            operation_id,
            producer: Some(producer),
            staging_failures: Mutex::new(Vec::new()),
        })
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn fail(&self, error: impl Into<String>) {
        if let Ok(snapshot) = self
            .app
            .state::<crate::session::MediaLibrarySessionState>()
            .fail_batch_operation(self.session_id, &self.operation_id, error.into())
        {
            self.emit_session_snapshot(snapshot);
        }
    }

    fn emit_session_snapshot(&self, snapshot: crate::session::MediaLibrarySessionSnapshot) {
        let _ = self
            .app
            .emit(crate::session::SESSION_CHANGED_EVENT, snapshot);
    }

    pub fn estimate_started(&self, total: usize) {
        let _ = total;
    }

    pub fn estimate_progress(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        error: Option<&str>,
    ) {
        let _ = self
            .app
            .state::<crate::session::MediaLibrarySessionState>()
            .update_batch_operation_estimate_progress(
                self.session_id,
                &self.operation_id,
                current,
                total,
                Some(relative_path.to_owned()),
                error.map(str::to_owned),
            );
    }

    pub fn estimate_complete<S: Serialize>(&self, estimate: &S) {
        let Ok(estimate) = serde_json::to_value(estimate) else {
            return;
        };
        if let Ok(snapshot) = self
            .app
            .state::<crate::session::MediaLibrarySessionState>()
            .complete_batch_operation_estimate(self.session_id, &self.operation_id, estimate)
        {
            self.emit_session_snapshot(snapshot);
        }
    }

    pub fn started(&self, total: usize) {
        #[derive(Clone, Serialize)]
        struct Payload {
            total: usize,
        }
        let _ = self
            .app
            .emit(&format!("{}_started", self.prefix), Payload { total });
    }
    /// Emit `${prefix}_progress` with semantic draft edits.
    pub fn progress_metadata(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&crate::draft_edits::SchemaMetadataEditMap>,
    ) {
        let edit_entries = edits
            .cloned()
            .map(crate::draft_edits::schema_metadata_edit_entries);
        let (status, error) =
            self.stage_result(relative_path, status, error, edit_entries.as_deref());
        let _ = self
            .app
            .state::<crate::session::MediaLibrarySessionState>()
            .update_batch_operation_progress(
                self.session_id,
                &self.operation_id,
                current,
                total,
                Some(relative_path.to_owned()),
                Some(&status),
                error.clone(),
            );
        #[derive(Clone, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            current: usize,
            total: usize,
            relative_path: &'a str,
            status: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            edits: Option<Vec<crate::draft_edits::SchemaMetadataEdit>>,
        }
        let _ = self.app.emit(
            &format!("{}_progress", self.prefix),
            Payload {
                current,
                total,
                relative_path,
                status: &status,
                error: error.as_deref(),
                edits: edit_entries,
            },
        );
    }

    /// Emit `${prefix}_progress_batch` using the scanner-style `results` envelope.
    pub fn progress_metadata_batch(&self, results: &[BatchMetadataProgress]) {
        let state = self.app.state::<crate::session::MediaLibrarySessionState>();
        for result in results {
            let (status, error) = self.stage_result(
                &result.relative_path,
                &result.status,
                result.error.as_deref(),
                result.edits.as_deref(),
            );
            let _ = state.update_batch_operation_progress(
                self.session_id,
                &self.operation_id,
                result.current,
                result.total,
                Some(result.relative_path.clone()),
                Some(&status),
                error,
            );
        }
        #[derive(Clone, Serialize)]
        struct Payload<'a> {
            results: &'a [BatchMetadataProgress],
        }
        let _ = self.app.emit(
            &format!("{}_progress_batch", self.prefix),
            Payload { results },
        );
    }
    ///
    /// `summary` is whatever shape the caller chose (token totals for
    /// describe, source counters for geocode, …). The emitter doesn't
    /// constrain it; the caller's wire type and the frontend hook
    /// stay in lockstep.
    pub fn complete<S: Serialize + Clone>(
        &self,
        succeeded: &[String],
        failed: &[BatchFailureRow],
        summary: &S,
    ) {
        let mut failures = failed
            .iter()
            .map(
                |failure| crate::session::MediaLibraryBatchOperationFailure {
                    relative_path: failure.relative_path.clone(),
                    kind: failure.kind.as_wire().to_owned(),
                    detail: failure.detail.clone(),
                },
            )
            .collect::<Vec<_>>();
        failures.extend(self.staging_failures.lock().unwrap().clone());
        let failed_paths = failures
            .iter()
            .map(|failure| failure.relative_path.as_str())
            .collect::<std::collections::HashSet<_>>();
        let succeeded = succeeded
            .iter()
            .filter(|path| !failed_paths.contains(path.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if let Ok(mut summary_value) = serde_json::to_value(summary) {
            reconcile_summary_counts(&mut summary_value, succeeded.len(), failed_paths.len());
            if let Ok(snapshot) = self
                .app
                .state::<crate::session::MediaLibrarySessionState>()
                .complete_batch_operation(
                    self.session_id,
                    &self.operation_id,
                    succeeded.clone(),
                    failures,
                    summary_value,
                )
            {
                self.emit_session_snapshot(snapshot);
            }
        }
        #[derive(Clone, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a, S: Serialize> {
            succeeded: &'a [String],
            failed: &'a [BatchFailureRow],
            usage_summary: &'a S,
        }
        let _ = self.app.emit(
            &format!("{}_complete", self.prefix),
            Payload {
                succeeded: &succeeded,
                failed,
                usage_summary: summary,
            },
        );
    }

    fn stage_result(
        &self,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&[crate::draft_edits::SchemaMetadataEdit]>,
    ) -> (String, Option<String>) {
        let Some(edits) = edits.filter(|edits| !edits.is_empty()) else {
            return (status.to_owned(), error.map(str::to_owned));
        };
        let Some(producer) = self.producer.as_ref() else {
            return (status.to_owned(), error.map(str::to_owned));
        };
        match crate::stage_batch_generated_metadata_drafts(
            self.app,
            self.session_id,
            &self.operation_id,
            producer,
            relative_path,
            edits,
        ) {
            Ok(_) => (status.to_owned(), error.map(str::to_owned)),
            Err(stage_error) => {
                let failure = crate::session::MediaLibraryBatchOperationFailure {
                    relative_path: relative_path.to_owned(),
                    kind: "draft_stage_failed".into(),
                    detail: stage_error.clone(),
                };
                let mut failures = self.staging_failures.lock().unwrap();
                if !failures.contains(&failure) {
                    failures.push(failure);
                }
                if status == "ok" {
                    ("draft_stage_failed".into(), Some(stage_error))
                } else {
                    (status.to_owned(), error.map(str::to_owned))
                }
            }
        }
    }
}

fn reconcile_summary_counts(summary: &mut serde_json::Value, succeeded: usize, failed: usize) {
    let Some(summary) = summary.as_object_mut() else {
        return;
    };
    for key in ["nSucceeded", "n_succeeded"] {
        if summary.contains_key(key) {
            summary.insert(key.into(), serde_json::Value::from(succeeded));
        }
    }
    for key in ["nFailed", "n_failed"] {
        if summary.contains_key(key) {
            summary.insert(key.into(), serde_json::Value::from(failed));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::time::Duration;

    #[test]
    fn event_batch_emits_first_then_count_bounded_batches() {
        let mut batch = EventBatch::new(3, Duration::from_secs(60), true);
        assert_eq!(batch.push(1), Some(vec![1]));
        assert_eq!(batch.push(2), None);
        assert_eq!(batch.push(3), None);
        assert_eq!(batch.push(4), Some(vec![2, 3, 4]));
        assert_eq!(batch.flush(), None);
    }

    #[test]
    fn event_batch_flushes_partial_tail() {
        let mut batch = EventBatch::new(10, Duration::from_secs(60), false);
        assert_eq!(batch.push("a"), None);
        assert_eq!(batch.push("b"), None);
        assert_eq!(batch.flush(), Some(vec!["a", "b"]));
        assert_eq!(batch.flush(), None);
    }

    #[test]
    fn install_returns_unset_flag_each_time() {
        let s = BatchJobCancelState::default();
        let a = s.install();
        assert!(!a.load(Ordering::Relaxed));
        // signal_cancel sets the live flag (which is now `a` plus the
        // copy held inside the state).
        assert!(s.signal_cancel());
        assert!(a.load(Ordering::Relaxed));

        // Re-install replaces the stored flag so the new caller sees
        // a fresh unset bool. The old `a` is still set — its owner
        // (the old loop) is responsible for noticing and exiting.
        let b = s.install();
        assert!(!b.load(Ordering::Relaxed));
        assert!(a.load(Ordering::Relaxed));
    }

    #[test]
    fn signal_cancel_returns_false_when_nothing_installed() {
        let s = BatchJobCancelState::default();
        assert!(!s.signal_cancel());
    }

    #[test]
    fn batch_failure_kind_wire_round_trip_for_every_variant() {
        // Lock the wire shape: serde rename_all="snake_case" must produce
        // exactly these strings, and parsing them back must yield the
        // same variant. New variants added later need to be appended to
        // this list so a missed `as_wire()` arm fails the test.
        let all = [
            (BatchFailureKind::Http, "http"),
            (BatchFailureKind::Network, "network"),
            (BatchFailureKind::Cancelled, "cancelled"),
            (BatchFailureKind::CommandFailed, "command_failed"),
            (BatchFailureKind::PreflightFailed, "preflight_failed"),
            (BatchFailureKind::Decode, "decode"),
            (BatchFailureKind::Incomplete, "incomplete"),
            (BatchFailureKind::Refused, "refused"),
            (BatchFailureKind::BadJson, "bad_json"),
            (BatchFailureKind::UsageParse, "usage_parse"),
            (BatchFailureKind::NoGps, "no_gps"),
            (BatchFailureKind::NominatimEmpty, "nominatim_empty"),
            (BatchFailureKind::CacheIo, "cache_io"),
            (BatchFailureKind::AiCallFailed, "ai_call_failed"),
            (BatchFailureKind::AiSchemaInvalid, "ai_schema_invalid"),
            (BatchFailureKind::AiRateLimited, "ai_rate_limited"),
            (BatchFailureKind::AuditLogIo, "audit_log_io"),
            (BatchFailureKind::Internal, "internal"),
            (BatchFailureKind::AiKeyMissing, "ai_key_missing"),
        ];
        for (variant, wire) in all {
            assert_eq!(variant.as_wire(), wire, "as_wire() for {:?}", variant);
            let serialised = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                serialised,
                format!("\"{}\"", wire),
                "serialised form for {:?}",
                variant
            );
            let parsed: BatchFailureKind = serde_json::from_str(&serialised).unwrap();
            assert_eq!(parsed, variant, "round-trip for {:?}", variant);
        }
    }

    #[test]
    fn clear_makes_subsequent_signal_a_no_op() {
        // After `clear()`, the flag previously returned to the loop is
        // no longer reachable through the state — a stray cancel command
        // arriving later does nothing rather than mutating a flag for a
        // run that already finished.
        let s = BatchJobCancelState::default();
        let flag = s.install();
        s.clear();
        assert!(!s.signal_cancel());
        assert!(!flag.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn bounded_runner_limits_parallelism_and_reports_completion_order() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(Mutex::new(Vec::new()));
        let active_for_work = active.clone();
        let peak_for_work = peak.clone();
        let completed_for_callback = completed.clone();

        let dispatched = run_bounded(
            vec![(0usize, 80u64), (1, 10), (2, 40), (3, 5), (4, 5)],
            NonZeroUsize::new(3).unwrap(),
            Arc::new(AtomicBool::new(false)),
            move |(id, delay_ms)| {
                let active = active_for_work.clone();
                let peak = peak_for_work.clone();
                async move {
                    let now_active = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    peak.fetch_max(now_active, AtomicOrdering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    active.fetch_sub(1, AtomicOrdering::SeqCst);
                    id
                }
            },
            move |id| completed_for_callback.lock().unwrap().push(id),
        )
        .await
        .unwrap();

        let completed = completed.lock().unwrap().clone();
        assert_eq!(dispatched, 5);
        assert_eq!(peak.load(AtomicOrdering::SeqCst), 3);
        assert_eq!(completed.len(), 5);
        assert_eq!(
            completed.iter().copied().collect::<HashSet<_>>(),
            HashSet::from([0, 1, 2, 3, 4])
        );
        assert_ne!(completed, vec![0, 1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn bounded_runner_cancellation_stops_new_work_and_drains_in_flight() {
        let cancel = Arc::new(AtomicBool::new(false));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let started = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));

        let cancel_for_callback = cancel.clone();
        let release_for_work = release.clone();
        let started_for_work = started.clone();
        let completed_for_callback = completed.clone();
        let release_after_cancel = release.clone();
        let cancel_after_start = cancel.clone();
        let started_to_watch = started.clone();

        let canceller = tokio::spawn(async move {
            while started_to_watch.load(AtomicOrdering::SeqCst) < 3 {
                tokio::task::yield_now().await;
            }
            cancel_after_start.store(true, AtomicOrdering::Relaxed);
            release_after_cancel.add_permits(3);
        });

        let dispatched = run_bounded(
            (0usize..10).collect(),
            NonZeroUsize::new(3).unwrap(),
            cancel,
            move |id| {
                let release = release_for_work.clone();
                let started = started_for_work.clone();
                async move {
                    started.fetch_add(1, AtomicOrdering::SeqCst);
                    let permit = release.acquire().await.unwrap();
                    permit.forget();
                    id
                }
            },
            move |_| {
                completed_for_callback.fetch_add(1, AtomicOrdering::SeqCst);
                assert!(cancel_for_callback.load(AtomicOrdering::Relaxed));
            },
        )
        .await
        .unwrap();
        canceller.await.unwrap();

        assert_eq!(dispatched, 3);
        assert_eq!(started.load(AtomicOrdering::SeqCst), 3);
        assert_eq!(completed.load(AtomicOrdering::SeqCst), 3);
    }
}
