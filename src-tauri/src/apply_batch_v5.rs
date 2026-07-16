//! Versioned schema-v5 batch metadata apply coordinator for the controlled bridge.
//!
//! This module consumes [`MetadataDraftEntryV5`] values, invokes the
//! occurrence-aware single-file pipeline, applies structured draft
//! reconciliation, and persists only through the schema-v5-owned
//! `MediaLibraryTargetDraftEdits.jsonl` file. It emits
//! versioned events consumed by the production frontend controller.
//! Target-aware apply logging remains pending.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::apply_edits_v5::{
    apply_single_file_metadata_v5, MetadataSingleFileOutcomeV5, MetadataTargetOutcome,
};
use crate::draft_edits::{
    load_metadata_draft_edits_v5, save_metadata_draft_edits_v5, MetadataDraftEditsV5,
    MetadataDraftEntryV5,
};
use crate::draft_reconciliation_v5::reconcile_metadata_draft_file_v5;
use crate::scanner;

pub const APPLY_EDITS_V5_STARTED_EVENT: &str = "apply_edits_v5_started";
pub const APPLY_METADATA_EDITS_V5_PROGRESS_EVENT: &str = "apply_metadata_edits_v5_progress";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyFileResultV5 {
    pub relative_path: String,
    pub applied: bool,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub fresh_image_metadata: Option<scanner::ImageMetadata>,
    pub target_outcomes: Vec<MetadataTargetOutcome>,

    /// `None` means no changed draft map was successfully persisted.
    /// `Some([])` means the persisted file entry was removed completely.
    /// `Some(entries)` contains the exact persisted entries after reconciliation.
    pub persisted_draft_entries: Option<Vec<MetadataDraftEntryV5>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyEditsResultV5 {
    pub files: Vec<MetadataApplyFileResultV5>,
    pub cancelled: bool,
    pub aborted: bool,
    pub abort_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ApplyEditsV5StartedPayload {
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyEditsProgressPayloadV5 {
    pub current: usize,
    pub total: usize,
    pub result: MetadataApplyFileResultV5,
}

/// Cancellation state isolated from production [`crate::ApplyEditsState`].
pub struct ApplyEditsV5State {
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyEditsV5BusyError;

impl std::fmt::Display for ApplyEditsV5BusyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("A schema-v5 metadata apply operation is already running")
    }
}

impl std::error::Error for ApplyEditsV5BusyError {}

impl ApplyEditsV5State {
    pub fn new() -> Self {
        Self {
            cancelled: Mutex::new(None),
        }
    }

    pub fn try_install(&self) -> Result<Arc<AtomicBool>, ApplyEditsV5BusyError> {
        let mut installed = self.cancelled.lock().unwrap();
        if installed.is_some() {
            return Err(ApplyEditsV5BusyError);
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

impl Default for ApplyEditsV5State {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) async fn run_apply_edits_v5_command<T, StartWorker, WorkerFuture, WorkerJoinError>(
    state: &ApplyEditsV5State,
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
        Err(error) => Err(format!("Schema-v5 apply edits worker failed: {error}")),
    };
    state.clear_if_mine(&cancel_flag);
    result
}

pub trait DraftPersistenceV5 {
    fn load(&self, folder_path: &str) -> Result<MetadataDraftEditsV5, String>;
    fn save(&self, folder_path: &str, drafts: &MetadataDraftEditsV5) -> Result<(), String>;
}

pub trait SingleFileApplyV5 {
    fn apply(
        &self,
        folder_path: &str,
        relative_path: &str,
        edits: &[MetadataDraftEntryV5],
    ) -> MetadataSingleFileOutcomeV5;
}

pub trait ApplyEventsV5 {
    fn started(&self, payload: ApplyEditsV5StartedPayload) -> Result<(), String>;
    fn progress(&self, payload: MetadataApplyEditsProgressPayloadV5) -> Result<(), String>;
}

struct RealDraftPersistenceV5;

impl DraftPersistenceV5 for RealDraftPersistenceV5 {
    fn load(&self, folder_path: &str) -> Result<MetadataDraftEditsV5, String> {
        load_metadata_draft_edits_v5(folder_path)
    }

    fn save(&self, folder_path: &str, drafts: &MetadataDraftEditsV5) -> Result<(), String> {
        save_metadata_draft_edits_v5(folder_path, drafts)
    }
}

struct RealSingleFileApplyV5;

impl SingleFileApplyV5 for RealSingleFileApplyV5 {
    fn apply(
        &self,
        folder_path: &str,
        relative_path: &str,
        edits: &[MetadataDraftEntryV5],
    ) -> MetadataSingleFileOutcomeV5 {
        apply_single_file_metadata_v5(folder_path, relative_path, edits)
    }
}

struct TauriApplyEventsV5 {
    app: AppHandle,
}

impl ApplyEventsV5 for TauriApplyEventsV5 {
    fn started(&self, payload: ApplyEditsV5StartedPayload) -> Result<(), String> {
        self.app
            .emit(APPLY_EDITS_V5_STARTED_EVENT, payload)
            .map_err(|error| error.to_string())
    }

    fn progress(&self, payload: MetadataApplyEditsProgressPayloadV5) -> Result<(), String> {
        self.app
            .emit(APPLY_METADATA_EDITS_V5_PROGRESS_EVENT, payload)
            .map_err(|error| error.to_string())
    }
}

pub fn run_apply_metadata_draft_edits_v5_blocking(
    folder_path: String,
    relative_paths: Vec<String>,
    app: AppHandle,
    cancel_flag: Arc<AtomicBool>,
) -> Result<MetadataApplyEditsResultV5, String> {
    run_apply_metadata_draft_edits_v5_with(
        &folder_path,
        &relative_paths,
        &RealDraftPersistenceV5,
        &RealSingleFileApplyV5,
        &TauriApplyEventsV5 { app },
        cancel_flag,
    )
}

fn combine_errors(original: Option<String>, additional: String) -> String {
    match original {
        Some(original) => format!("{original}; {additional}"),
        None => additional,
    }
}

fn run_apply_metadata_draft_edits_v5_with<P, A, E>(
    folder_path: &str,
    relative_paths: &[String],
    persistence: &P,
    single_file_apply: &A,
    events: &E,
    cancel_flag: Arc<AtomicBool>,
) -> Result<MetadataApplyEditsResultV5, String>
where
    P: DraftPersistenceV5,
    A: SingleFileApplyV5,
    E: ApplyEventsV5,
{
    let mut current_drafts = persistence.load(folder_path)?;

    let mut seen = HashSet::new();
    for relative_path in relative_paths {
        if !seen.insert(relative_path.as_str()) {
            return Err(format!(
                "duplicate requested relative path: {relative_path}"
            ));
        }
    }

    let selected: Vec<_> = relative_paths
        .iter()
        .filter(|relative_path| {
            current_drafts
                .get(relative_path.as_str())
                .is_some_and(|entries| !entries.is_empty())
        })
        .cloned()
        .collect();
    let total = selected.len();

    if let Err(error) = events.started(ApplyEditsV5StartedPayload { total }) {
        log::warn!("[apply_batch_v5] Failed to emit started event: {error}");
    }

    let mut files = Vec::with_capacity(total);
    let mut cancelled = false;
    let mut aborted = false;
    let mut abort_reason = None;

    for relative_path in selected {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let original_entries = current_drafts
            .get(relative_path.as_str())
            .expect("selected schema-v5 draft remains present until its own operation")
            .clone();
        let outcome = single_file_apply.apply(folder_path, &relative_path, &original_entries);
        // The later target-aware logger will consume these internal records
        // after reconciliation persistence has annotated them. Disk logging
        // remains deliberately inactive in this evidence-capture slice.
        let _target_apply_audit_records = &outcome.audit_records;
        let mut final_error = outcome.error.clone();
        let mut persisted_draft_entries = None;
        let mut fatal_reason = None;

        if !outcome.outcomes.is_empty() {
            match reconcile_metadata_draft_file_v5(
                &current_drafts,
                &relative_path,
                &outcome.outcomes,
            ) {
                Ok(candidate) if candidate != current_drafts => {
                    if let Err(error) = persistence.save(folder_path, &candidate) {
                        let reason = format!(
                            "schema-v5 draft persistence failed for {relative_path}: {error}"
                        );
                        final_error = Some(combine_errors(final_error, reason.clone()));
                        fatal_reason = Some(reason);
                    } else {
                        current_drafts = candidate;
                        persisted_draft_entries = Some(
                            current_drafts
                                .get(relative_path.as_str())
                                .cloned()
                                .unwrap_or_default(),
                        );
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let reason = format!(
                        "schema-v5 draft reconciliation failed for {relative_path}: {error}"
                    );
                    final_error = Some(combine_errors(final_error, reason.clone()));
                    fatal_reason = Some(reason);
                }
            }
        }

        let result = MetadataApplyFileResultV5 {
            relative_path,
            applied: final_error.is_none(),
            error: final_error,
            warning: outcome.warning,
            fresh_image_metadata: outcome.fresh_image_metadata,
            target_outcomes: outcome.outcomes,
            persisted_draft_entries,
        };
        let current = files.len() + 1;
        if let Err(error) = events.progress(MetadataApplyEditsProgressPayloadV5 {
            current,
            total,
            result: result.clone(),
        }) {
            log::warn!(
                "[apply_batch_v5] Failed to emit progress event for {}: {error}",
                result.relative_path
            );
        }
        files.push(result);

        if let Some(reason) = fatal_reason {
            aborted = true;
            abort_reason = Some(reason);
            break;
        }
    }

    // Target-aware apply logging remains pending; never write the v4
    // schema-keyed apply log from this occurrence-aware coordinator.
    Ok(MetadataApplyEditsResultV5 {
        files,
        cancelled,
        aborted,
        abort_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apply_edits_v5::MetadataDraftReconciliation;
    use crate::draft_edits::{EditIntent, MetadataDraftEdit};
    use crate::metadata_draft_target::MetadataDraftTarget;
    use crate::metadata_occurrence::{
        MetadataOccurrence, MetadataOccurrenceId, MetadataOccurrences, MetadataWriteTarget,
    };
    use crate::metadata_value::MetadataValue;
    use crate::scanner::{MetadataEntries, MetadataEntry};
    use crate::tag_schema::SchemaDefinitionId;
    use std::collections::{HashMap, VecDeque};

    struct FakePersistence {
        load: Result<MetadataDraftEditsV5, String>,
        saves: Mutex<Vec<MetadataDraftEditsV5>>,
        save_error: Option<String>,
    }

    impl FakePersistence {
        fn new(load: Result<MetadataDraftEditsV5, String>) -> Self {
            Self {
                load,
                saves: Mutex::new(Vec::new()),
                save_error: None,
            }
        }
    }

    impl DraftPersistenceV5 for FakePersistence {
        fn load(&self, _folder_path: &str) -> Result<MetadataDraftEditsV5, String> {
            self.load.clone()
        }

        fn save(&self, _folder_path: &str, drafts: &MetadataDraftEditsV5) -> Result<(), String> {
            if let Some(error) = &self.save_error {
                return Err(error.clone());
            }
            self.saves.lock().unwrap().push(drafts.clone());
            Ok(())
        }
    }

    struct FakeApply {
        outcomes: Mutex<HashMap<String, VecDeque<MetadataSingleFileOutcomeV5>>>,
        calls: Mutex<Vec<String>>,
        cancel_after: Option<(String, Arc<AtomicBool>)>,
    }

    impl FakeApply {
        fn new(outcomes: impl IntoIterator<Item = (String, MetadataSingleFileOutcomeV5)>) -> Self {
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

    impl SingleFileApplyV5 for FakeApply {
        fn apply(
            &self,
            _folder_path: &str,
            relative_path: &str,
            _edits: &[MetadataDraftEntryV5],
        ) -> MetadataSingleFileOutcomeV5 {
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
    enum RecordedEvent {
        Started(ApplyEditsV5StartedPayload),
        Progress(Box<MetadataApplyEditsProgressPayloadV5>),
    }

    #[derive(Default)]
    struct FakeEvents {
        events: Mutex<Vec<RecordedEvent>>,
        fail: bool,
    }

    impl ApplyEventsV5 for FakeEvents {
        fn started(&self, payload: ApplyEditsV5StartedPayload) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(RecordedEvent::Started(payload));
            if self.fail {
                Err("event failed".into())
            } else {
                Ok(())
            }
        }

        fn progress(&self, payload: MetadataApplyEditsProgressPayloadV5) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(RecordedEvent::Progress(Box::new(payload)));
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
        }
    }

    fn existing_target(tag_id: &str, path: &str) -> MetadataDraftTarget {
        MetadataDraftTarget::ExistingOccurrence {
            occurrence_id: MetadataOccurrenceId {
                document: None,
                path: path.into(),
                tag_id: tag_id.into(),
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
                tag_name: format!("Tag{tag_id}"),
            },
        }
    }

    fn entry(target: MetadataDraftTarget, text: &str) -> MetadataDraftEntryV5 {
        MetadataDraftEntryV5 {
            target,
            edit: MetadataDraftEdit {
                value: Some(MetadataValue::Text(text.into())),
                intent: EditIntent::Set,
                display: None,
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

    fn outcome(
        error: Option<&str>,
        outcomes: Vec<MetadataTargetOutcome>,
    ) -> MetadataSingleFileOutcomeV5 {
        MetadataSingleFileOutcomeV5 {
            fresh_image_metadata: None,
            error: error.map(str::to_owned),
            warning: Some("warning".into()),
            outcomes,
            targets_to_clear: Vec::new(),
            audit_records: Vec::new(),
        }
    }

    fn drafts(items: &[(&str, MetadataDraftEntryV5)]) -> MetadataDraftEditsV5 {
        let mut result = MetadataDraftEditsV5::new();
        for (path, item) in items {
            result
                .entry((*path).to_owned())
                .or_default()
                .push(item.clone());
        }
        result
    }

    #[test]
    fn v5_state_acquisition_is_exclusive_and_ownership_aware() {
        let state = ApplyEditsV5State::new();

        let active = state.try_install().expect("first acquisition must succeed");
        assert_eq!(state.try_install().unwrap_err(), ApplyEditsV5BusyError);

        assert!(state.signal_cancel());
        assert!(active.load(Ordering::Relaxed));

        let unrelated = Arc::new(AtomicBool::new(false));
        state.clear_if_mine(&unrelated);
        assert_eq!(state.try_install().unwrap_err(), ApplyEditsV5BusyError);

        state.clear_if_mine(&active);
        let reacquired = state
            .try_install()
            .expect("clearing the active flag must permit reacquisition");
        assert!(!reacquired.load(Ordering::Relaxed));

        state.clear();
        assert!(state.try_install().is_ok());
    }

    #[test]
    fn v5_state_is_independent_from_production_apply_state() {
        let production = crate::ApplyEditsState::new();
        let production_flag = production.install();
        let v5 = ApplyEditsV5State::new();
        let v5_flag = v5.try_install().unwrap();

        assert!(v5.signal_cancel());
        assert!(v5_flag.load(Ordering::Relaxed));
        assert!(!production_flag.load(Ordering::Relaxed));

        assert!(production.signal_cancel());
        assert!(production_flag.load(Ordering::Relaxed));
    }

    #[test]
    fn v5_busy_error_text_is_stable_and_descriptive() {
        assert_eq!(
            ApplyEditsV5BusyError.to_string(),
            "A schema-v5 metadata apply operation is already running"
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
        let state = ApplyEditsV5State::new();
        let active = state.try_install().unwrap();
        let effects = Arc::new(Mutex::new(AdmissionEffects::default()));
        let effects_for_worker = effects.clone();

        let result = run_apply_edits_v5_command(&state, move |_| {
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
            Err("A schema-v5 metadata apply operation is already running".into())
        );
        assert_eq!(*effects.lock().unwrap(), AdmissionEffects::default());
        assert!(!active.load(Ordering::Relaxed));
        state.clear_if_mine(&active);
    }

    #[tokio::test]
    async fn command_lifecycle_releases_after_completion_and_worker_error() {
        let state = ApplyEditsV5State::new();
        let completed = run_apply_edits_v5_command(&state, |_| {
            std::future::ready::<Result<Result<&'static str, String>, &'static str>>(Ok(Ok(
                "completed",
            )))
        })
        .await;
        assert_eq!(completed, Ok("completed"));

        let worker_error = run_apply_edits_v5_command(&state, |_| {
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
        let state = ApplyEditsV5State::new();
        let result = run_apply_edits_v5_command(&state, |_| {
            tokio::task::spawn_blocking(|| -> Result<(), String> {
                panic!("simulated schema-v5 worker panic")
            })
        })
        .await;

        assert!(result
            .unwrap_err()
            .starts_with("Schema-v5 apply edits worker failed:"));
        let reacquired = state
            .try_install()
            .expect("join failure must release command state");
        state.clear_if_mine(&reacquired);
    }

    #[test]
    fn strict_load_and_duplicate_validation_precede_all_events_and_work() {
        let events = FakeEvents::default();
        let apply = FakeApply::new([]);
        let persistence = FakePersistence::new(Err("malformed v5".into()));
        let error = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &["a.jpg".into()],
            &persistence,
            &apply,
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(error, "malformed v5");
        assert!(events.events.lock().unwrap().is_empty());

        let target = new_target("1");
        let persistence = FakePersistence::new(Ok(drafts(&[("a.jpg", entry(target, "x"))])));
        let error = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &["a.jpg".into(), "a.jpg".into()],
            &persistence,
            &apply,
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
        let empty = FakePersistence::new(Ok(MetadataDraftEditsV5::new()));
        let result = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &["missing.jpg".into()],
            &empty,
            &FakeApply::new([]),
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.files.is_empty());
        assert_eq!(
            events.events.lock().unwrap().as_slice(),
            &[RecordedEvent::Started(ApplyEditsV5StartedPayload {
                total: 0
            })]
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
            let result = run_apply_metadata_draft_edits_v5_with(
                "folder",
                &["absent".into(), reserved.into()],
                &persistence,
                &apply,
                &FakeEvents::default(),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
            assert_eq!(result.files[0].relative_path, reserved);
        }
    }

    #[test]
    fn cancellation_is_isolated_and_observed_only_at_file_boundaries() {
        let production = crate::ApplyEditsState::new();
        let production_flag = production.install();
        let state = ApplyEditsV5State::new();
        let current = state.try_install().unwrap();
        assert!(state.signal_cancel());
        assert!(current.load(Ordering::Relaxed));
        state.clear_if_mine(&current);
        assert!(!state.signal_cancel());
        assert!(!production_flag.load(Ordering::Relaxed));
        assert!(production.signal_cancel());
        assert!(production_flag.load(Ordering::Relaxed));

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
        let result = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &["first.jpg".into(), "second.jpg".into()],
            &persistence,
            &apply,
            &FakeEvents::default(),
            flag,
        )
        .unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].persisted_draft_entries, Some(Vec::new()));
        assert!(result.cancelled);
        assert!(!result.aborted);
        assert_eq!(result.abort_reason, None);
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
                    None,
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
        let result = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &[
                "clear.jpg".into(),
                "keep.jpg".into(),
                "blocked.jpg".into(),
                "replace.jpg".into(),
            ],
            &persistence,
            &apply,
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(persistence.saves.lock().unwrap().len(), 2);
        assert_eq!(result.files[0].persisted_draft_entries, Some(Vec::new()));
        assert_eq!(result.files[1].persisted_draft_entries, None);
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
    }

    #[test]
    fn hard_failure_without_outcomes_does_not_save_or_abort() {
        let target = new_target("1");
        let persistence = FakePersistence::new(Ok(drafts(&[("a.jpg", entry(target, "x"))])));
        let result = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &["a.jpg".into()],
            &persistence,
            &FakeApply::new([("a.jpg".into(), outcome(Some("planning failed"), Vec::new()))]),
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(!result.files[0].applied);
        assert!(!result.aborted);
        assert!(persistence.saves.lock().unwrap().is_empty());
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
        let result = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &["first.jpg".into(), "later.jpg".into()],
            &persistence,
            &apply,
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.aborted);
        assert!(!result.cancelled);
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
        assert_eq!(events.events.lock().unwrap().len(), 2);
        assert!(persistence.saves.lock().unwrap().is_empty());

        let mut failing = FakePersistence::new(Ok(drafts(&[
            ("first.jpg", entry(first.clone(), "x")),
            ("later.jpg", entry(later, "y")),
        ])));
        failing.save_error = Some("disk uncertain".into());
        let result = run_apply_metadata_draft_edits_v5_with(
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
            &FakeEvents::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.aborted);
        let error = result.files[0].error.as_ref().unwrap();
        assert!(error.contains("write failed") && error.contains("disk uncertain"));
        assert_eq!(result.files[0].persisted_draft_entries, None);
    }

    #[test]
    fn progress_preserves_full_metadata_outcomes_and_ignores_emit_failures() {
        let target = new_target("1");
        let metadata = scanner::ImageMetadata {
            relative_path: "a.jpg".into(),
            occurrences: MetadataOccurrences(vec![MetadataOccurrence {
                id: MetadataOccurrenceId {
                    document: None,
                    path: "JPEG-APP1-IFD0".into(),
                    tag_id: "1".into(),
                    copy: 0,
                },
                value: MetadataValue::Text("authoritative".into()),
                tag_info: None,
                write_target: None,
            }]),
            metadata: MetadataEntries(vec![MetadataEntry {
                id: schema("1"),
                value: MetadataValue::Text("compatibility".into()),
            }]),
        };
        let mut applied = outcome(
            None,
            vec![target_outcome(&target, MetadataDraftReconciliation::Keep)],
        );
        applied.fresh_image_metadata = Some(metadata.clone());
        let events = FakeEvents {
            events: Mutex::new(Vec::new()),
            fail: true,
        };
        let result = run_apply_metadata_draft_edits_v5_with(
            "folder",
            &["a.jpg".into()],
            &FakePersistence::new(Ok(drafts(&[("a.jpg", entry(target, "x"))]))),
            &FakeApply::new([("a.jpg".into(), applied)]),
            &events,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(result.files[0].applied);
        assert_eq!(result.files[0].fresh_image_metadata, Some(metadata));
        let recorded = events.events.lock().unwrap();
        let RecordedEvent::Progress(progress) = &recorded[1] else {
            panic!()
        };
        assert_eq!(progress.current, 1);
        assert_eq!(progress.total, 1);
        assert_eq!(progress.result, result.files[0]);
        let json = serde_json::to_value(&result).unwrap();
        assert!(json["files"][0].get("target_outcomes").is_some());
        assert!(json.to_string().contains("occurrences"));
        assert!(!json.to_string().contains("slot"));
        assert!(!json.to_string().contains("audit_records"));
    }

    #[test]
    fn event_and_command_names_leave_production_v4_names_present() {
        assert_eq!(APPLY_EDITS_V5_STARTED_EVENT, "apply_edits_v5_started");
        assert_eq!(
            APPLY_METADATA_EDITS_V5_PROGRESS_EVENT,
            "apply_metadata_edits_v5_progress"
        );
        let lib = include_str!("lib.rs");
        assert!(lib.contains("apply_metadata_draft_edits_cmd"));
        assert!(lib.contains("cancel_apply_edits"));
        assert!(lib.contains("apply_edits_started"));
        assert!(lib.contains("apply_metadata_edits_progress"));
        assert!(lib.contains("apply_metadata_draft_edits_v5_cmd"));
        assert!(lib.contains("cancel_apply_edits_v5"));
    }

    #[test]
    fn generated_types_use_exact_domain_types_and_exports() {
        let file = include_str!("../../src/types/generated/MetadataApplyFileResultV5.ts");
        for field in [
            "relative_path",
            "applied",
            "error",
            "warning",
            "fresh_image_metadata",
            "target_outcomes",
            "persisted_draft_entries",
        ] {
            assert!(file.contains(field));
        }
        assert!(file.contains("ImageMetadata | null"));
        assert!(file.contains("Array<MetadataTargetOutcome>"));
        assert!(file.contains("Array<MetadataDraftEntryV5> | null"));
        assert!(!file.contains("any"));
        assert!(!file.contains("audit"));

        let batch = include_str!("../../src/types/generated/MetadataApplyEditsResultV5.ts");
        assert!(batch.contains("files: Array<MetadataApplyFileResultV5>"));
        for field in ["cancelled", "aborted", "abort_reason"] {
            assert!(batch.contains(field));
        }
        let progress =
            include_str!("../../src/types/generated/MetadataApplyEditsProgressPayloadV5.ts");
        assert!(progress.contains("current: number"));
        assert!(progress.contains("total: number"));
        assert!(progress.contains("result: MetadataApplyFileResultV5"));
        assert!(!progress.contains("audit"));
        let exports = include_str!("../../src/types.ts");
        for name in [
            "MetadataApplyFileResultV5",
            "MetadataApplyEditsResultV5",
            "ApplyEditsV5StartedPayload",
            "MetadataApplyEditsProgressPayloadV5",
        ] {
            assert!(exports.contains(name));
        }
    }
}
