//! Authoritative mutable media-library session state machine.

mod events;
mod model;
pub use events::{drain_session_events, SessionEvent};
pub use model::*;

use crate::draft_edits::{MetadataTargetDraftEntry, MetadataTargetDraftsByFile};
use crate::scanner::{FileInfo, FileMetadata};
use crate::search_service::MediaLibrarySearchService;
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};

pub struct MediaLibrarySessionState {
    next_session_id: AtomicU64,
    next_issue_id: AtomicU64,
    next_thumbnail_version: AtomicU64,
    next_apply_operation_id: AtomicU64,
    snapshot: Mutex<MediaLibrarySessionSnapshot>,
    thumbnail_cache: Mutex<HashMap<String, String>>,
    superseded_scan_metadata: Mutex<BTreeSet<String>>,
    search: MediaLibrarySearchService,
    /// Optional ordered channel for revisioned session events. When present,
    /// every accepted mutation pushes its notification while holding the
    /// snapshot lock, so the channel order equals commit/revision order.
    notifier: Option<mpsc::Sender<SessionEvent>>,
    /// Receiver side of `notifier`, moved to the dedicated drain thread during
    /// Tauri setup. `None` in unit tests and after it has been taken.
    event_receiver: Mutex<Option<mpsc::Receiver<SessionEvent>>>,
}

impl MediaLibrarySessionState {
    pub fn new() -> Self {
        Self {
            next_session_id: AtomicU64::new(1),
            next_issue_id: AtomicU64::new(1),
            next_thumbnail_version: AtomicU64::new(1),
            next_apply_operation_id: AtomicU64::new(1),
            snapshot: Mutex::new(MediaLibrarySessionSnapshot {
                session_id: None,
                revision: 0,
                lifecycle: MediaLibrarySessionLifecycle::Idle,
                folder: None,
                files: Vec::new(),
                discovery_running: false,
                issues: Vec::new(),
                metadata: Vec::new(),
                thumbnails: Vec::new(),
                drafts: MetadataTargetDraftsByFile::new(),
                draft_persistence: MediaLibrarySessionDraftPersistenceState::Loading,
                apply_operation: None,
                verification_outcomes: HashMap::new(),
                batch_operations: HashMap::new(),
            }),
            thumbnail_cache: Mutex::new(HashMap::new()),
            superseded_scan_metadata: Mutex::new(BTreeSet::new()),
            search: MediaLibrarySearchService::new(),
            notifier: None,
            event_receiver: Mutex::new(None),
        }
    }

    /// Construct production state with an ordered session-event channel.
    /// The sender is used to queue notifications in commit order; the
    /// receiver should be handed to `drain_session_events` during setup.
    pub fn with_event_channel(
        notifier: mpsc::Sender<SessionEvent>,
        receiver: mpsc::Receiver<SessionEvent>,
    ) -> Self {
        Self {
            notifier: Some(notifier),
            event_receiver: Mutex::new(Some(receiver)),
            ..Self::new()
        }
    }

    /// Take the event-channel receiver so the application can spawn the
    /// ordered emitter thread. Returns `None` for unit-test instances.
    pub fn take_event_receiver(&self) -> Option<mpsc::Receiver<SessionEvent>> {
        self.event_receiver.lock().unwrap().take()
    }

    /// Queue a revisioned session event in commit order. Safe to call only
    /// while the snapshot mutex is held; a no-op when no channel is installed.
    fn notify(&self, event: SessionEvent) {
        if let Some(sender) = &self.notifier {
            let _ = sender.send(event);
        }
    }

    pub fn snapshot(&self) -> MediaLibrarySessionSnapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn search(&self) -> &MediaLibrarySearchService {
        &self.search
    }

    /// Inspect authoritative state without cloning the complete session.
    /// Callers must keep the closure read-only and return only the small data
    /// they need after the lock is released.
    pub(crate) fn inspect<R>(&self, read: impl FnOnce(&MediaLibrarySessionSnapshot) -> R) -> R {
        let snapshot = self.snapshot.lock().unwrap();
        read(&snapshot)
    }

    pub fn begin_batch_operation(
        &self,
        session_id: u64,
        kind: &str,
        phase: MediaLibraryBatchOperationPhase,
        total: usize,
        requested_paths: Vec<String>,
        request: Option<serde_json::Value>,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before the batch operation started".into(),
            );
        }
        if snapshot
            .batch_operations
            .get(kind)
            .is_some_and(|operation| {
                !matches!(
                    operation.phase,
                    MediaLibraryBatchOperationPhase::Completed
                        | MediaLibraryBatchOperationPhase::Failed
                )
            })
        {
            return Err(format!("A '{kind}' batch operation is already active"));
        }
        snapshot.revision += 1;
        let operation_id = format!("{kind}-{}", snapshot.revision);
        snapshot.batch_operations.insert(
            kind.to_owned(),
            MediaLibraryBatchOperation {
                operation_id,
                kind: kind.to_owned(),
                requested_paths,
                request,
                phase,
                total,
                current: 0,
                current_file: None,
                cancelling: false,
                failures: Vec::new(),
                succeeded: Vec::new(),
                estimate: None,
                summary: None,
                error: None,
            },
        );
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn start_batch_operation(
        &self,
        session_id: u64,
        operation_id: &str,
        total: usize,
        confirmed_request: Option<serde_json::Value>,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed before the batch operation ran".into());
        }
        let operation = snapshot
            .batch_operations
            .values_mut()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| "The batch operation identity changed".to_string())?;
        operation.phase = MediaLibraryBatchOperationPhase::Running;
        operation.total = total;
        operation.current = 0;
        operation.current_file = None;
        operation.cancelling = false;
        operation.failures.clear();
        operation.succeeded.clear();
        operation.summary = None;
        operation.error = None;
        if let Some(request) = confirmed_request {
            operation.request = Some(request);
        }
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_batch_operation_progress(
        &self,
        session_id: u64,
        operation_id: &str,
        current: usize,
        total: usize,
        relative_path: Option<String>,
        status: Option<&str>,
        error: Option<String>,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed during the batch operation".into());
        }
        let operation = snapshot
            .batch_operations
            .values_mut()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| "The batch operation identity changed".to_string())?;
        operation.phase = MediaLibraryBatchOperationPhase::Running;
        operation.current = current;
        operation.total = total;
        operation.current_file = relative_path.clone();
        if status == Some("ok") {
            if let Some(path) = relative_path {
                if !operation.succeeded.contains(&path) {
                    operation.succeeded.push(path);
                }
            }
        } else if let (Some(path), Some(detail)) = (relative_path, error) {
            operation.failures.push(MediaLibraryBatchOperationFailure {
                relative_path: path,
                kind: status.unwrap_or("failed").to_owned(),
                detail,
            });
        }
        Ok(())
    }
    pub fn update_batch_operation_estimate_progress(
        &self,
        session_id: u64,
        operation_id: &str,
        current: usize,
        total: usize,
        relative_path: Option<String>,
        error: Option<String>,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed during batch estimation".into());
        }
        let operation = snapshot
            .batch_operations
            .values_mut()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| "The batch operation identity changed".to_string())?;
        operation.phase = MediaLibraryBatchOperationPhase::Estimating;
        operation.current = current;
        operation.total = total;
        operation.current_file = relative_path;
        if error.is_some() {
            operation.error = error;
        }
        Ok(())
    }

    /// Commit one generated-draft row without cloning the complete session.
    /// Batch workers reconcile the frontend once at a phase boundary; cloning
    /// files, metadata, thumbnails, and every draft for each item is both
    /// unnecessary and prohibitively expensive for large runs.
    pub fn commit_generated_draft_row(
        &self,
        session_id: u64,
        relative_path: String,
        entries: Vec<MetadataTargetDraftEntry>,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before the drafts were committed".into(),
            );
        }
        if !matches!(
            snapshot.draft_persistence,
            MediaLibrarySessionDraftPersistenceState::Ready
        ) {
            return Err("Draft persistence is not ready".into());
        }
        snapshot.revision += 1;
        let revision = snapshot.revision;
        self.notify(SessionEvent::RevisionAdvanced(
            MediaLibrarySessionRevisionAdvanced {
                session_id,
                revision,
            },
        ));
        if entries.is_empty() {
            snapshot.drafts.remove(&relative_path);
        } else {
            snapshot
                .drafts
                .insert(relative_path.clone(), entries.clone());
        }
        drop(snapshot);
        self.search
            .set_drafts(session_id, revision, vec![(relative_path, entries)]);
        Ok(())
    }

    pub fn complete_batch_operation_estimate(
        &self,
        session_id: u64,
        operation_id: &str,
        estimate: serde_json::Value,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before batch estimation completed".into(),
            );
        }
        let operation = snapshot
            .batch_operations
            .values_mut()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| "The batch operation identity changed".to_string())?;
        operation.phase = MediaLibraryBatchOperationPhase::AwaitingConfirm;
        operation.current = operation.total;
        operation.current_file = None;
        operation.cancelling = false;
        operation.estimate = Some(estimate);
        operation.error = None;
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn complete_batch_operation(
        &self,
        session_id: u64,
        operation_id: &str,
        succeeded: Vec<String>,
        failures: Vec<MediaLibraryBatchOperationFailure>,
        summary: serde_json::Value,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before the batch operation completed".into(),
            );
        }
        let operation = snapshot
            .batch_operations
            .values_mut()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| "The batch operation identity changed".to_string())?;
        operation.phase = MediaLibraryBatchOperationPhase::Completed;
        operation.current = operation.total;
        operation.current_file = None;
        operation.cancelling = false;
        operation.succeeded = succeeded;
        operation.failures = failures;
        operation.summary = Some(summary);
        operation.error = None;
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn fail_batch_operation(
        &self,
        session_id: u64,
        operation_id: &str,
        error: String,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id) {
            return Err("The media-library session changed during the batch failure".into());
        }
        let operation = snapshot
            .batch_operations
            .values_mut()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| "The batch operation identity changed".to_string())?;
        operation.phase = MediaLibraryBatchOperationPhase::Failed;
        operation.current_file = None;
        operation.cancelling = false;
        operation.error = Some(error);
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn request_batch_operation_cancellation(
        &self,
        session_id: u64,
        operation_id: &str,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed before batch cancellation".into());
        }
        let operation = snapshot
            .batch_operations
            .values_mut()
            .find(|operation| operation.operation_id == operation_id)
            .ok_or_else(|| "The batch operation identity changed".to_string())?;
        operation.cancelling = true;
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn dismiss_batch_operation(
        &self,
        session_id: u64,
        operation_id: &str,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id) {
            return Err(
                "The media-library session changed before the batch operation was dismissed".into(),
            );
        }
        let kind = snapshot
            .batch_operations
            .iter()
            .find_map(|(kind, operation)| {
                (operation.operation_id == operation_id).then(|| kind.clone())
            });
        if kind
            .as_deref()
            .is_some_and(|kind| snapshot.batch_operations.remove(kind).is_some())
        {
            snapshot.revision += 1;
            let result = snapshot.clone();
            self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
            return Ok(result);
        }
        Ok(snapshot.clone())
    }

    pub fn begin_apply_operation(
        &self,
        session_id: u64,
        operation_id: String,
        requested_paths: Option<Vec<String>>,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed before apply started".into());
        }
        if snapshot.apply_operation.as_ref().is_some_and(|operation| {
            matches!(operation.state, MediaLibraryApplyOperationState::Running)
        }) {
            return Err("A metadata apply operation is already running".into());
        }
        snapshot.revision += 1;
        snapshot.apply_operation = Some(MediaLibraryApplyOperation {
            operation_id,
            requested_paths,
            state: MediaLibraryApplyOperationState::Running,
            total: None,
            current: 0,
            current_file: None,
            cancelling: false,
            file_failure_count: 0,
            warning_count: 0,
            issues: Vec::new(),
            summary: None,
        });
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn begin_new_apply_operation(
        &self,
        session_id: u64,
        requested_paths: Option<Vec<String>>,
    ) -> Result<(String, MediaLibrarySessionSnapshot), String> {
        let sequence = self.next_apply_operation_id.fetch_add(1, Ordering::Relaxed);
        let operation_id = format!("target-apply-{sequence}");
        let snapshot =
            self.begin_apply_operation(session_id, operation_id.clone(), requested_paths)?;
        Ok((operation_id, snapshot))
    }

    pub fn update_apply_operation(
        &self,
        session_id: u64,
        message: &crate::apply_batch::MetadataApplyStreamMessage,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed during apply".into());
        }
        let message_operation_id = match message {
            crate::apply_batch::MetadataApplyStreamMessage::Started { operation_id, .. }
            | crate::apply_batch::MetadataApplyStreamMessage::ProgressBatch {
                operation_id, ..
            }
            | crate::apply_batch::MetadataApplyStreamMessage::Complete { operation_id, .. } => {
                operation_id
            }
        };
        if snapshot
            .apply_operation
            .as_ref()
            .map(|operation| operation.operation_id.as_str())
            != Some(message_operation_id.as_str())
        {
            return Err("The metadata apply operation identity changed".into());
        }

        let mut search_metadata = Vec::new();
        let mut search_drafts = Vec::new();
        match message {
            crate::apply_batch::MetadataApplyStreamMessage::Started { total, .. } => {
                let operation = snapshot.apply_operation.as_mut().unwrap();
                operation.total = Some(*total);
            }
            crate::apply_batch::MetadataApplyStreamMessage::ProgressBatch {
                current,
                total,
                results,
                ..
            } => {
                {
                    let operation = snapshot.apply_operation.as_mut().unwrap();
                    operation.current = *current;
                    operation.total = Some(*total);
                    operation.current_file =
                        results.last().map(|result| result.relative_path.clone());
                    operation.file_failure_count += results
                        .iter()
                        .filter(|result| result.error.is_some())
                        .count();
                    operation.warning_count += results
                        .iter()
                        .filter(|result| result.warning.is_some())
                        .count();
                }
                for result in results {
                    if let Some(metadata) = &result.fresh_file_metadata {
                        if let Some(entry) = snapshot
                            .metadata
                            .iter_mut()
                            .find(|entry| entry.relative_path == result.relative_path)
                        {
                            entry.state = MediaLibrarySessionMetadataState::Ready {
                                occurrences: metadata.occurrences.clone(),
                            };
                            search_metadata.push((
                                result.relative_path.clone(),
                                Some(metadata.occurrences.clone()),
                            ));
                        }
                    }
                    if let Some(entries) = &result.persisted_draft_entries {
                        if entries.is_empty() {
                            snapshot.drafts.remove(&result.relative_path);
                        } else {
                            snapshot
                                .drafts
                                .insert(result.relative_path.clone(), entries.clone());
                        }
                        search_drafts.push((result.relative_path.clone(), entries.clone()));
                    }
                    if result.target_outcomes.is_empty() {
                        snapshot.verification_outcomes.remove(&result.relative_path);
                    } else {
                        snapshot
                            .verification_outcomes
                            .insert(result.relative_path.clone(), result.target_outcomes.clone());
                    }
                    for (severity, error_type, message) in [
                        result
                            .error
                            .as_ref()
                            .map(|message| ("error", "metadata-apply-file", message)),
                        result
                            .warning
                            .as_ref()
                            .map(|message| ("warning", "metadata-apply-warning", message)),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        snapshot.apply_operation.as_mut().unwrap().issues.push(
                            MediaLibraryApplyIssue {
                                relative_path: result.relative_path.clone(),
                                severity: severity.to_owned(),
                                message: message.clone(),
                            },
                        );
                        snapshot.issues.push(MediaLibrarySessionIssue {
                            issue_id: self.next_issue_id.fetch_add(1, Ordering::Relaxed),
                            severity: severity.to_owned(),
                            error_type: error_type.to_owned(),
                            error_message: message.clone(),
                            affected_files: vec![result.relative_path.clone()],
                        });
                    }
                }
                const MAX_SESSION_ISSUES: usize = 100;
                if snapshot.issues.len() > MAX_SESSION_ISSUES {
                    let excess = snapshot.issues.len() - MAX_SESSION_ISSUES;
                    snapshot.issues.drain(0..excess);
                }
            }
            crate::apply_batch::MetadataApplyStreamMessage::Complete { summary, .. } => {
                let operation = snapshot.apply_operation.as_mut().unwrap();
                operation.current = summary.completed;
                operation.total = Some(summary.selected);
                operation.current_file = None;
                operation.file_failure_count = summary.failed;
                operation.warning_count = summary.warning_count;
                operation.summary = Some(summary.clone());
                operation.state = MediaLibraryApplyOperationState::Completed;
            }
        }
        snapshot.revision += 1;
        let revision = snapshot.revision;
        match message {
            crate::apply_batch::MetadataApplyStreamMessage::Complete { .. } => {
                self.notify(SessionEvent::ApplyProgress(Box::new(message.clone())));
                self.notify(SessionEvent::Snapshot(Box::new(snapshot.clone())));
            }
            _ => {
                self.notify(SessionEvent::ApplyProgress(Box::new(message.clone())));
                self.notify(SessionEvent::RevisionAdvanced(
                    MediaLibrarySessionRevisionAdvanced {
                        session_id,
                        revision,
                    },
                ));
            }
        }
        drop(snapshot);
        if !search_metadata.is_empty() {
            self.search
                .set_metadata(session_id, revision, search_metadata);
        }
        if !search_drafts.is_empty() {
            self.search.set_drafts(session_id, revision, search_drafts);
        }
        self.search.set_revision(session_id, revision);
        Ok(())
    }

    pub fn request_apply_cancellation(
        &self,
        session_id: u64,
        operation_id: &str,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed before apply cancellation".into());
        }
        let operation = snapshot
            .apply_operation
            .as_mut()
            .ok_or_else(|| "No metadata apply operation is active".to_string())?;
        if operation.operation_id != operation_id {
            return Err("The metadata apply operation identity changed".into());
        }
        if !matches!(operation.state, MediaLibraryApplyOperationState::Running) {
            return Ok(snapshot.clone());
        }
        operation.cancelling = true;
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn fail_apply_operation(
        &self,
        session_id: u64,
        operation_id: &str,
        error: String,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id) {
            return Err("The media-library session changed during apply failure".into());
        }
        let operation = snapshot
            .apply_operation
            .as_mut()
            .ok_or_else(|| "No metadata apply operation is active".to_string())?;
        if operation.operation_id != operation_id {
            return Err("The metadata apply operation identity changed".into());
        }
        operation.state = MediaLibraryApplyOperationState::Failed { error };
        operation.current_file = None;
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn dismiss_apply_operation(
        &self,
        session_id: u64,
        operation_id: &str,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id) {
            return Err("The media-library session changed before apply was dismissed".into());
        }
        let Some(operation) = snapshot.apply_operation.as_ref() else {
            return Ok(snapshot.clone());
        };
        if operation.operation_id != operation_id {
            return Err("The metadata apply operation identity changed".into());
        }
        snapshot.apply_operation = None;
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn resolve_verification_outcome(
        &self,
        session_id: u64,
        relative_path: &str,
        current_target: &crate::metadata_draft_target::MetadataDraftTarget,
        persisted_entries: Option<Vec<MetadataTargetDraftEntry>>,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before verification was resolved".into(),
            );
        }
        let outcomes = snapshot
            .verification_outcomes
            .get_mut(relative_path)
            .ok_or_else(|| "The verification outcome is no longer pending".to_string())?;
        let previous_len = outcomes.len();
        outcomes.retain(|outcome| {
            let target = match &outcome.draft_reconciliation {
                crate::apply_edits::MetadataDraftReconciliation::Replace { target } => target,
                _ => &outcome.target,
            };
            target != current_target
        });
        if outcomes.len() == previous_len {
            return Err("The verification outcome is no longer pending".into());
        }
        if outcomes.is_empty() {
            snapshot.verification_outcomes.remove(relative_path);
        }
        if let Some(entries) = persisted_entries {
            if entries.is_empty() {
                snapshot.drafts.remove(relative_path);
            } else {
                snapshot.drafts.insert(relative_path.to_owned(), entries);
            }
        }
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn dismiss_all_verification_outcomes(
        &self,
        session_id: u64,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before verification was dismissed".into(),
            );
        }
        if snapshot.verification_outcomes.is_empty() {
            return Ok(snapshot.clone());
        }
        snapshot.verification_outcomes.clear();
        snapshot.revision += 1;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn begin_open(&self, folder: String) -> MediaLibrarySessionSnapshot {
        let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let mut snapshot = self.snapshot.lock().unwrap();
        snapshot.session_id = Some(session_id);
        snapshot.revision += 1;
        snapshot.lifecycle = MediaLibrarySessionLifecycle::Opening;
        snapshot.folder = Some(folder);
        snapshot.files.clear();
        snapshot.discovery_running = false;
        snapshot.issues.clear();
        snapshot.metadata.clear();
        snapshot.thumbnails.clear();
        snapshot.drafts.clear();
        snapshot.draft_persistence = MediaLibrarySessionDraftPersistenceState::Loading;
        snapshot.apply_operation = None;
        snapshot.verification_outcomes.clear();
        snapshot.batch_operations.clear();
        self.superseded_scan_metadata.lock().unwrap().clear();
        self.thumbnail_cache.lock().unwrap().clear();
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        drop(snapshot);
        self.search.reset(Some(session_id), result.revision);
        result
    }

    pub fn install_draft_load_result(
        &self,
        session_id: u64,
        result: Result<MetadataTargetDraftsByFile, String>,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Opening
        {
            return Err("The media-library session changed before drafts loaded".into());
        }
        snapshot.revision += 1;
        match result {
            Ok(drafts) => {
                snapshot.drafts = drafts;
                snapshot.draft_persistence = MediaLibrarySessionDraftPersistenceState::Ready;
            }
            Err(error) => {
                snapshot.drafts.clear();
                snapshot.draft_persistence = MediaLibrarySessionDraftPersistenceState::LoadFailed {
                    error: error.clone(),
                };
                snapshot.issues.push(MediaLibrarySessionIssue {
                    issue_id: self.next_issue_id.fetch_add(1, Ordering::Relaxed),
                    severity: "error".into(),
                    error_type: "metadata-target-load".into(),
                    error_message: error,
                    affected_files: Vec::new(),
                });
            }
        }
        let revision = snapshot.revision;
        let rows = snapshot
            .drafts
            .iter()
            .map(|(path, entries)| (path.clone(), entries.clone()))
            .collect();
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        drop(snapshot);
        self.search.set_revision(session_id, revision);
        self.search.set_drafts(session_id, revision, rows);
        Ok(result)
    }

    pub fn fail_session(
        &self,
        session_id: u64,
        error_type: &str,
        error_message: String,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || matches!(
                snapshot.lifecycle,
                MediaLibrarySessionLifecycle::Idle | MediaLibrarySessionLifecycle::Closing
            )
        {
            return Err("The media-library session changed before failure was recorded".into());
        }
        snapshot.revision += 1;
        snapshot.lifecycle = MediaLibrarySessionLifecycle::Failed;
        snapshot.discovery_running = false;
        snapshot.issues.push(MediaLibrarySessionIssue {
            issue_id: self.next_issue_id.fetch_add(1, Ordering::Relaxed),
            severity: "error".into(),
            error_type: error_type.to_owned(),
            error_message,
            affected_files: Vec::new(),
        });
        const MAX_SESSION_ISSUES: usize = 100;
        if snapshot.issues.len() > MAX_SESSION_ISSUES {
            let excess = snapshot.issues.len() - MAX_SESSION_ISSUES;
            snapshot.issues.drain(0..excess);
        }
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn commit_draft_rows(
        &self,
        session_id: u64,
        rows: Vec<(String, Vec<MetadataTargetDraftEntry>)>,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before the drafts were committed".into(),
            );
        }
        if !matches!(
            snapshot.draft_persistence,
            MediaLibrarySessionDraftPersistenceState::Ready
        ) {
            return Err("Draft persistence is not ready".into());
        }
        if rows.is_empty() {
            return Ok(snapshot.clone());
        }
        snapshot.revision += 1;
        let revision = snapshot.revision;
        for (relative_path, entries) in &rows {
            if entries.is_empty() {
                snapshot.drafts.remove(relative_path);
            } else {
                snapshot
                    .drafts
                    .insert(relative_path.clone(), entries.clone());
            }
        }
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        drop(snapshot);
        self.search.set_drafts(session_id, revision, rows);
        Ok(result)
    }

    pub fn commit_draft_row(
        &self,
        session_id: u64,
        relative_path: String,
        entries: Vec<MetadataTargetDraftEntry>,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        self.commit_draft_rows(session_id, vec![(relative_path, entries)])
    }

    pub fn mark_draft_save_failed(
        &self,
        session_id: u64,
        error: String,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before the draft failure was recorded".into(),
            );
        }
        snapshot.revision += 1;
        snapshot.draft_persistence = MediaLibrarySessionDraftPersistenceState::SaveFailed { error };
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn mark_loaded(
        &self,
        session_id: u64,
        folder: &str,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.folder.as_deref() != Some(folder)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Opening
        {
            return Err("The media-library session changed before scanning started".into());
        }
        snapshot.revision += 1;
        snapshot.lifecycle = MediaLibrarySessionLifecycle::Loaded;
        snapshot.discovery_running = true;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn add_files(
        &self,
        session_id: u64,
        files: Vec<FileInfo>,
    ) -> Result<MediaLibrarySessionFilesAdded, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
            || !snapshot.discovery_running
        {
            return Err("The media-library session changed during file discovery".into());
        }
        snapshot.revision += 1;
        snapshot
            .metadata
            .extend(files.iter().map(|file| MediaLibrarySessionFileMetadata {
                relative_path: file.relative_path.clone(),
                state: MediaLibrarySessionMetadataState::Loading,
            }));
        snapshot
            .thumbnails
            .extend(files.iter().map(|file| MediaLibrarySessionFileThumbnail {
                relative_path: file.relative_path.clone(),
                state: MediaLibrarySessionThumbnailState::Loading,
            }));
        snapshot.files.extend(files.iter().cloned());
        let delta = MediaLibrarySessionFilesAdded {
            session_id,
            revision: snapshot.revision,
            files,
        };
        self.notify(SessionEvent::FilesAdded(delta.clone()));
        drop(snapshot);
        self.search
            .add_files(session_id, delta.revision, delta.files.clone());
        Ok(delta)
    }

    pub fn commit_metadata_results(
        &self,
        session_id: u64,
        results: Vec<FileMetadata>,
    ) -> Result<MediaLibrarySessionMetadataChanged, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed during metadata scanning".into());
        }
        let superseded = self.superseded_scan_metadata.lock().unwrap();
        let mut entries = Vec::with_capacity(results.len());
        for result in results {
            let entry = snapshot
                .metadata
                .iter_mut()
                .find(|entry| entry.relative_path == result.relative_path)
                .ok_or_else(|| {
                    format!(
                        "Metadata arrived for an undiscovered file: {}",
                        result.relative_path
                    )
                })?;
            if superseded.contains(&result.relative_path) {
                continue;
            }
            entry.state = MediaLibrarySessionMetadataState::Ready {
                occurrences: result.occurrences,
            };
            entries.push(entry.clone());
        }
        if !entries.is_empty() {
            snapshot.revision += 1;
        }
        let delta = MediaLibrarySessionMetadataChanged {
            session_id,
            revision: snapshot.revision,
            entries,
        };
        if !delta.entries.is_empty() {
            self.notify(SessionEvent::MetadataChanged(delta.clone()));
        }
        let search_entries = delta
            .entries
            .iter()
            .map(|entry| {
                let occurrences = match &entry.state {
                    MediaLibrarySessionMetadataState::Ready { occurrences } => {
                        Some(occurrences.clone())
                    }
                    MediaLibrarySessionMetadataState::Loading
                    | MediaLibrarySessionMetadataState::Failed { .. } => None,
                };
                (entry.relative_path.clone(), occurrences)
            })
            .collect();
        drop(snapshot);
        self.search
            .set_metadata(session_id, delta.revision, search_entries);
        Ok(delta)
    }

    pub fn commit_thumbnail_results(
        &self,
        session_id: u64,
        results: Vec<(String, Option<String>)>,
    ) -> Result<MediaLibrarySessionThumbnailsChanged, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed during thumbnail generation".into());
        }
        let mut cache = self.thumbnail_cache.lock().unwrap();
        let mut entries = Vec::with_capacity(results.len());
        for (relative_path, thumbnail) in results {
            let entry = snapshot
                .thumbnails
                .iter_mut()
                .find(|entry| entry.relative_path == relative_path)
                .ok_or_else(|| {
                    format!("Thumbnail arrived for an undiscovered file: {relative_path}")
                })?;
            if let MediaLibrarySessionThumbnailState::Ready { cache_key } = &entry.state {
                cache.remove(cache_key);
            }
            entry.state = match thumbnail {
                Some(thumbnail) => {
                    let version = self.next_thumbnail_version.fetch_add(1, Ordering::Relaxed);
                    let cache_key = format!("{session_id}:{version}");
                    cache.insert(cache_key.clone(), thumbnail);
                    MediaLibrarySessionThumbnailState::Ready { cache_key }
                }
                None => MediaLibrarySessionThumbnailState::Failed,
            };
            entries.push(entry.clone());
        }
        if !entries.is_empty() {
            snapshot.revision += 1;
        }
        let delta = MediaLibrarySessionThumbnailsChanged {
            session_id,
            revision: snapshot.revision,
            entries,
        };
        if !delta.entries.is_empty() {
            self.notify(SessionEvent::ThumbnailsChanged(delta.clone()));
        }
        Ok(delta)
    }

    pub fn thumbnail_payloads(
        &self,
        session_id: u64,
        cache_keys: &[String],
    ) -> Result<Vec<MediaLibraryThumbnailPayload>, String> {
        let snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before thumbnails were retrieved".into(),
            );
        }
        let valid: std::collections::HashSet<&str> = snapshot
            .thumbnails
            .iter()
            .filter_map(|entry| match &entry.state {
                MediaLibrarySessionThumbnailState::Ready { cache_key } => Some(cache_key.as_str()),
                _ => None,
            })
            .collect();
        let cache = self.thumbnail_cache.lock().unwrap();
        Ok(cache_keys
            .iter()
            .filter(|key| valid.contains(key.as_str()))
            .filter_map(|key| {
                cache
                    .get(key)
                    .map(|thumbnail| MediaLibraryThumbnailPayload {
                        cache_key: key.clone(),
                        thumbnail: thumbnail.clone(),
                    })
            })
            .collect())
    }

    pub fn commit_post_write_metadata_results(
        &self,
        session_id: u64,
        results: Vec<FileMetadata>,
    ) -> Result<MediaLibrarySessionMetadataChanged, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed during metadata apply".into());
        }
        let mut superseded = self.superseded_scan_metadata.lock().unwrap();
        let mut entries = Vec::with_capacity(results.len());
        for result in results {
            let entry = snapshot
                .metadata
                .iter_mut()
                .find(|entry| entry.relative_path == result.relative_path)
                .ok_or_else(|| {
                    format!(
                        "Post-write metadata arrived for an undiscovered file: {}",
                        result.relative_path
                    )
                })?;
            superseded.insert(result.relative_path.clone());
            entry.state = MediaLibrarySessionMetadataState::Ready {
                occurrences: result.occurrences,
            };
            entries.push(entry.clone());
        }
        if !entries.is_empty() {
            snapshot.revision += 1;
        }
        let delta = MediaLibrarySessionMetadataChanged {
            session_id,
            revision: snapshot.revision,
            entries,
        };
        let search_entries = delta
            .entries
            .iter()
            .map(|entry| {
                let occurrences = match &entry.state {
                    MediaLibrarySessionMetadataState::Ready { occurrences } => {
                        Some(occurrences.clone())
                    }
                    MediaLibrarySessionMetadataState::Loading
                    | MediaLibrarySessionMetadataState::Failed { .. } => None,
                };
                (entry.relative_path.clone(), occurrences)
            })
            .collect();
        drop(snapshot);
        self.search
            .set_metadata(session_id, delta.revision, search_entries);
        Ok(delta)
    }

    pub fn remove_files(
        &self,
        session_id: u64,
        relative_paths: &[String],
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed before files were removed".into());
        }
        let paths: std::collections::BTreeSet<&str> =
            relative_paths.iter().map(String::as_str).collect();
        let file_count = snapshot.files.len();
        let metadata_count = snapshot.metadata.len();
        let thumbnail_count = snapshot.thumbnails.len();
        let draft_count = snapshot.drafts.len();
        let removed_cache_keys: Vec<String> = snapshot
            .thumbnails
            .iter()
            .filter(|entry| paths.contains(entry.relative_path.as_str()))
            .filter_map(|entry| match &entry.state {
                MediaLibrarySessionThumbnailState::Ready { cache_key } => Some(cache_key.clone()),
                _ => None,
            })
            .collect();
        snapshot
            .files
            .retain(|file| !paths.contains(file.relative_path.as_str()));
        snapshot
            .metadata
            .retain(|entry| !paths.contains(entry.relative_path.as_str()));
        snapshot
            .thumbnails
            .retain(|entry| !paths.contains(entry.relative_path.as_str()));
        snapshot
            .drafts
            .retain(|path, _| !paths.contains(path.as_str()));
        if !removed_cache_keys.is_empty() {
            let mut cache = self.thumbnail_cache.lock().unwrap();
            for key in removed_cache_keys {
                cache.remove(&key);
            }
        }
        self.superseded_scan_metadata
            .lock()
            .unwrap()
            .retain(|path| !paths.contains(path.as_str()));
        let changed = snapshot.files.len() != file_count
            || snapshot.metadata.len() != metadata_count
            || snapshot.thumbnails.len() != thumbnail_count
            || snapshot.drafts.len() != draft_count;
        if changed {
            snapshot.revision += 1;
        }
        let revision = snapshot.revision;
        let result = snapshot.clone();
        if changed {
            self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        }
        drop(snapshot);
        if changed {
            self.search
                .remove_paths(session_id, revision, relative_paths.to_vec());
        }
        Ok(result)
    }

    pub fn finish_discovery(&self, session_id: u64) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Loaded
        {
            return Err("The media-library session changed before discovery completed".into());
        }
        if snapshot.discovery_running {
            snapshot.revision += 1;
            snapshot.discovery_running = false;
            let result = snapshot.clone();
            self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
            return Ok(result);
        }
        Ok(snapshot.clone())
    }

    pub fn add_issue(
        &self,
        session_id: u64,
        severity: String,
        error_type: String,
        error_message: String,
        affected_files: Vec<String>,
    ) -> Result<MediaLibrarySessionIssueAdded, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || matches!(
                snapshot.lifecycle,
                MediaLibrarySessionLifecycle::Idle | MediaLibrarySessionLifecycle::Closing
            )
        {
            return Err("The media-library session changed before the issue was recorded".into());
        }
        let issue_id = self.next_issue_id.fetch_add(1, Ordering::Relaxed);
        snapshot.revision += 1;
        let mut metadata = Vec::new();
        if error_type == "metadata" {
            for relative_path in &affected_files {
                if let Some(entry) = snapshot
                    .metadata
                    .iter_mut()
                    .find(|entry| entry.relative_path == *relative_path)
                {
                    entry.state = MediaLibrarySessionMetadataState::Failed {
                        error: error_message.clone(),
                    };
                    metadata.push(entry.clone());
                }
            }
        }
        let issue = MediaLibrarySessionIssue {
            issue_id,
            severity,
            error_type,
            error_message,
            affected_files,
        };
        snapshot.issues.push(issue.clone());
        const MAX_SESSION_ISSUES: usize = 100;
        if snapshot.issues.len() > MAX_SESSION_ISSUES {
            let excess = snapshot.issues.len() - MAX_SESSION_ISSUES;
            snapshot.issues.drain(0..excess);
        }
        let delta = MediaLibrarySessionIssueAdded {
            session_id,
            revision: snapshot.revision,
            issue,
            metadata,
        };
        self.notify(SessionEvent::IssueAdded(delta.clone()));
        let search_entries = delta
            .metadata
            .iter()
            .map(|entry| (entry.relative_path.clone(), None))
            .collect();
        drop(snapshot);
        self.search
            .set_metadata(session_id, delta.revision, search_entries);
        Ok(delta)
    }

    pub fn dismiss_issue(&self, issue_id: u64) -> MediaLibrarySessionSnapshot {
        let mut snapshot = self.snapshot.lock().unwrap();
        let previous_len = snapshot.issues.len();
        snapshot.issues.retain(|issue| issue.issue_id != issue_id);
        if snapshot.issues.len() != previous_len {
            snapshot.revision += 1;
            let result = snapshot.clone();
            self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
            return result;
        }
        snapshot.clone()
    }

    pub fn begin_close(&self, session_id: u64) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle == MediaLibrarySessionLifecycle::Idle
        {
            return Err("The media-library session changed before close started".into());
        }
        snapshot.revision += 1;
        snapshot.lifecycle = MediaLibrarySessionLifecycle::Closing;
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        Ok(result)
    }

    pub fn finish_close(&self, session_id: u64) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != MediaLibrarySessionLifecycle::Closing
        {
            return Err("The media-library session changed before close completed".into());
        }
        snapshot.revision += 1;
        snapshot.session_id = None;
        snapshot.lifecycle = MediaLibrarySessionLifecycle::Idle;
        snapshot.folder = None;
        snapshot.files.clear();
        snapshot.discovery_running = false;
        snapshot.issues.clear();
        snapshot.metadata.clear();
        snapshot.thumbnails.clear();
        snapshot.drafts.clear();
        snapshot.draft_persistence = MediaLibrarySessionDraftPersistenceState::Loading;
        snapshot.apply_operation = None;
        snapshot.verification_outcomes.clear();
        snapshot.batch_operations.clear();
        self.thumbnail_cache.lock().unwrap().clear();
        self.superseded_scan_metadata.lock().unwrap().clear();
        let result = snapshot.clone();
        self.notify(SessionEvent::Snapshot(Box::new(result.clone())));
        drop(snapshot);
        self.search.reset(None, result.revision);
        Ok(result)
    }
}

impl Default for MediaLibrarySessionState {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::MetadataOccurrences;
    fn test_file(relative_path: &str) -> FileInfo {
        FileInfo {
            relative_path: relative_path.into(),
            filename: relative_path.into(),
            media_kind: crate::scanner::MediaKind::Image,
            date_modified: None,
            date_created: None,
        }
    }

    #[test]
    fn notifications_are_queued_in_commit_order() {
        let (notifier, receiver) = std::sync::mpsc::channel();
        let state = MediaLibrarySessionState::with_event_channel(notifier, receiver);
        let receiver = state.take_event_receiver().unwrap();
        let session_id = state.begin_open("C:/photos".into()).session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        state
            .add_files(session_id, vec![test_file("a.jpg")])
            .unwrap();
        state
            .commit_metadata_results(
                session_id,
                vec![FileMetadata {
                    relative_path: "a.jpg".into(),
                    occurrences: MetadataOccurrences::default(),
                }],
            )
            .unwrap();
        state.finish_discovery(session_id).unwrap();

        let events: Vec<SessionEvent> = receiver.try_iter().collect();
        let names: Vec<&'static str> = events.iter().map(SessionEvent::event_name).collect();
        assert_eq!(
            names,
            vec![
                SESSION_CHANGED_EVENT,
                SESSION_CHANGED_EVENT,
                SESSION_CHANGED_EVENT,
                SESSION_FILES_ADDED_EVENT,
                SESSION_METADATA_CHANGED_EVENT,
                SESSION_CHANGED_EVENT,
            ]
        );
        let revisions: Vec<u64> = events.iter().map(SessionEvent::revision).collect();
        assert_eq!(revisions, vec![1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn concurrent_commits_are_notified_in_revision_order() {
        let (notifier, receiver) = std::sync::mpsc::channel();
        let state = std::sync::Arc::new(MediaLibrarySessionState::with_event_channel(
            notifier, receiver,
        ));
        let receiver = state.take_event_receiver().unwrap();
        let (_, session_id) = {
            let opened = state.begin_open("C:/photos".into());
            let session_id = opened.session_id.unwrap();
            state
                .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
                .unwrap();
            state.mark_loaded(session_id, "C:/photos").unwrap();
            ((), session_id)
        };

        let mut handles = Vec::new();
        for thread_index in 0..8 {
            let state = state.clone();
            handles.push(std::thread::spawn(move || {
                for batch in 0..20 {
                    let files: Vec<FileInfo> = (0..3)
                        .map(|item| test_file(&format!("t{thread_index}-b{batch}-{item}.jpg")))
                        .collect();
                    assert!(state.add_files(session_id, files).is_ok());
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let events: Vec<SessionEvent> = receiver.try_iter().collect();
        assert_eq!(events.len(), 3 + 8 * 20);
        let revisions: Vec<u64> = events.iter().map(SessionEvent::revision).collect();
        for pair in revisions.windows(2) {
            assert_eq!(
                pair[1],
                pair[0] + 1,
                "notifications must be queued in revision order"
            );
        }
        assert!(events[3..]
            .iter()
            .all(|event| matches!(event, SessionEvent::FilesAdded(_))));
    }

    #[test]
    fn apply_progress_streams_through_the_ordered_channel() {
        let (notifier, receiver) = std::sync::mpsc::channel();
        let state = MediaLibrarySessionState::with_event_channel(notifier, receiver);
        let receiver = state.take_event_receiver().unwrap();
        let session_id = state.begin_open("C:/photos".into()).session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        let (operation_id, _) = state.begin_new_apply_operation(session_id, None).unwrap();
        // Drain the four lifecycle snapshots queued so far.
        assert_eq!(receiver.try_iter().count(), 4);

        state
            .update_apply_operation(
                session_id,
                &crate::apply_batch::MetadataApplyStreamMessage::Started {
                    operation_id: operation_id.clone(),
                    total: 1,
                },
            )
            .unwrap();
        state
            .update_apply_operation(
                session_id,
                &crate::apply_batch::MetadataApplyStreamMessage::ProgressBatch {
                    operation_id: operation_id.clone(),
                    sequence: 1,
                    current: 1,
                    total: 1,
                    results: Vec::new(),
                },
            )
            .unwrap();
        let during: Vec<SessionEvent> = receiver.try_iter().collect();
        assert_eq!(during.len(), 4, "started and progress push progress + tick");
        assert_eq!(
            during
                .iter()
                .filter(|event| matches!(event, SessionEvent::ApplyProgress(_)))
                .count(),
            2
        );
        let ticks: Vec<u64> = during
            .iter()
            .filter_map(|event| match event {
                SessionEvent::RevisionAdvanced(value) => Some(value.revision),
                _ => None,
            })
            .collect();
        assert_eq!(ticks, vec![5, 6], "progress revisions advance via ticks");

        state
            .update_apply_operation(
                session_id,
                &crate::apply_batch::MetadataApplyStreamMessage::Complete {
                    operation_id,
                    summary: crate::apply_batch::MetadataApplySummary {
                        requested: 1,
                        selected: 1,
                        completed: 1,
                        applied: 1,
                        failed: 0,
                        warning_count: 0,
                        cancelled: false,
                        aborted: false,
                        abort_reason: None,
                        delivery_failure_count: 0,
                    },
                },
            )
            .unwrap();
        let after_complete: Vec<SessionEvent> = receiver.try_iter().collect();
        assert_eq!(after_complete.len(), 2);
        assert!(matches!(after_complete[0], SessionEvent::ApplyProgress(_)));
        assert!(matches!(after_complete[1], SessionEvent::Snapshot(_)));
    }

    #[test]
    fn batch_progress_does_not_advance_the_session_revision() {
        let (notifier, receiver) = std::sync::mpsc::channel();
        let state = MediaLibrarySessionState::with_event_channel(notifier, receiver);
        let receiver = state.take_event_receiver().unwrap();
        let session_id = state.begin_open("C:/photos".into()).session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        let started = state
            .begin_batch_operation(
                session_id,
                "describe",
                MediaLibraryBatchOperationPhase::Running,
                1,
                vec!["a.jpg".into()],
                None,
            )
            .unwrap();
        let operation_id = started.batch_operations["describe"].operation_id.clone();
        let revision_at_start = started.revision;
        assert_eq!(receiver.try_iter().count(), 4);

        state
            .update_batch_operation_progress(
                session_id,
                &operation_id,
                1,
                1,
                Some("a.jpg".into()),
                Some("ok"),
                None,
            )
            .unwrap();
        state
            .update_batch_operation_estimate_progress(
                session_id,
                &operation_id,
                1,
                1,
                Some("a.jpg".into()),
                None,
            )
            .unwrap();

        assert_eq!(
            receiver.try_iter().count(),
            0,
            "batch progress must not queue session events"
        );
        assert_eq!(
            state.snapshot().revision,
            revision_at_start,
            "per-row batch progress must not consume revisions"
        );
    }

    #[test]
    fn generated_draft_rows_advance_revision_with_a_tick() {
        let (notifier, receiver) = std::sync::mpsc::channel();
        let state = MediaLibrarySessionState::with_event_channel(notifier, receiver);
        let receiver = state.take_event_receiver().unwrap();
        let session_id = state.begin_open("C:/photos".into()).session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        state
            .add_files(session_id, vec![test_file("a.jpg")])
            .unwrap();
        assert_eq!(receiver.try_iter().count(), 4);

        state
            .commit_generated_draft_row(session_id, "a.jpg".into(), Vec::new())
            .unwrap();
        let events: Vec<SessionEvent> = receiver.try_iter().collect();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SessionEvent::RevisionAdvanced(value) => {
                assert_eq!(value.session_id, session_id);
                assert_eq!(value.revision, 5);
            }
            other => panic!("expected a revision tick, got {other:?}"),
        }
    }

    #[test]
    fn lifecycle_is_reconstructible_from_snapshot() {
        let state = MediaLibrarySessionState::new();
        assert_eq!(
            state.snapshot().lifecycle,
            MediaLibrarySessionLifecycle::Idle
        );

        let opening = state.begin_open("C:/photos".into());
        assert_eq!(opening.session_id, Some(1));
        assert_eq!(opening.revision, 1);
        assert_eq!(opening.lifecycle, MediaLibrarySessionLifecycle::Opening);
        assert!(opening.files.is_empty());
        assert!(!opening.discovery_running);

        let loaded = state.mark_loaded(1, "C:/photos").unwrap();
        assert_eq!(loaded.revision, 2);
        assert_eq!(loaded.lifecycle, MediaLibrarySessionLifecycle::Loaded);
        assert!(loaded.discovery_running);
        assert_eq!(state.snapshot(), loaded);

        let added = state.add_files(1, vec![test_file("a.jpg")]).unwrap();
        assert_eq!(added.revision, 3);
        assert_eq!(state.snapshot().files, vec![test_file("a.jpg")]);
        assert_eq!(state.snapshot().metadata.len(), 1);
        assert!(matches!(
            state.snapshot().metadata[0].state,
            MediaLibrarySessionMetadataState::Loading
        ));

        let metadata_delta = state
            .commit_metadata_results(
                1,
                vec![FileMetadata {
                    relative_path: "a.jpg".into(),
                    occurrences: MetadataOccurrences::default(),
                }],
            )
            .unwrap();
        assert_eq!(metadata_delta.entries.len(), 1);
        assert!(matches!(
            state.snapshot().metadata[0].state,
            MediaLibrarySessionMetadataState::Ready { .. }
        ));

        let completed = state.finish_discovery(1).unwrap();
        assert_eq!(completed.revision, 5);
        assert!(!completed.discovery_running);

        let closing = state.begin_close(1).unwrap();
        assert_eq!(closing.revision, 6);
        assert_eq!(closing.lifecycle, MediaLibrarySessionLifecycle::Closing);

        let idle = state.finish_close(1).unwrap();
        assert_eq!(idle.revision, 7);
        assert_eq!(idle.lifecycle, MediaLibrarySessionLifecycle::Idle);
        assert_eq!(idle.session_id, None);
        assert_eq!(idle.folder, None);
    }

    #[test]
    fn stale_scan_start_is_rejected() {
        let state = MediaLibrarySessionState::new();
        let first = state.begin_open("C:/first".into());
        let second = state.begin_open("C:/second".into());

        assert!(state
            .mark_loaded(first.session_id.unwrap(), "C:/first")
            .is_err());
        assert!(state
            .mark_loaded(second.session_id.unwrap(), "C:/second")
            .is_ok());
    }

    #[test]
    fn stale_close_cannot_replace_a_newer_session() {
        let state = MediaLibrarySessionState::new();
        let first = state.begin_open("C:/first".into());
        let first_id = first.session_id.unwrap();
        let second = state.begin_open("C:/second".into());
        let second_id = second.session_id.unwrap();

        assert!(state.begin_close(first_id).is_err());
        assert_eq!(state.snapshot().session_id, Some(second_id));
        assert_eq!(state.snapshot().folder.as_deref(), Some("C:/second"));
    }
    #[test]
    fn stale_file_batches_are_rejected_without_mutating_the_snapshot() {
        let state = MediaLibrarySessionState::new();
        let first = state.begin_open("C:/first".into());
        state
            .mark_loaded(first.session_id.unwrap(), "C:/first")
            .unwrap();
        let second = state.begin_open("C:/second".into());
        state
            .mark_loaded(second.session_id.unwrap(), "C:/second")
            .unwrap();

        assert!(state
            .add_files(first.session_id.unwrap(), vec![test_file("stale.jpg")])
            .is_err());
        assert!(state.snapshot().files.is_empty());
    }

    #[test]
    fn thumbnail_payloads_are_session_owned_and_recoverable_by_cache_key() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        let session_id = opened.session_id.unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        state
            .add_files(session_id, vec![test_file("a.jpg")])
            .unwrap();
        let delta = state
            .commit_thumbnail_results(
                session_id,
                vec![("a.jpg".into(), Some("data:image/jpeg;base64,abc".into()))],
            )
            .unwrap();
        let cache_key = match &delta.entries[0].state {
            MediaLibrarySessionThumbnailState::Ready { cache_key } => cache_key.clone(),
            _ => panic!("expected ready"),
        };
        assert_eq!(
            state.thumbnail_payloads(session_id, &[cache_key]).unwrap()[0].thumbnail,
            "data:image/jpeg;base64,abc"
        );
    }

    #[test]
    fn post_write_metadata_supersedes_late_scan_results() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        let session_id = opened.session_id.unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        state
            .add_files(session_id, vec![test_file("a.jpg")])
            .unwrap();

        let post_write = state
            .commit_post_write_metadata_results(
                session_id,
                vec![FileMetadata {
                    relative_path: "a.jpg".into(),
                    occurrences: MetadataOccurrences::default(),
                }],
            )
            .unwrap();
        assert_eq!(post_write.entries.len(), 1);
        let revision = post_write.revision;

        let late_scan = state
            .commit_metadata_results(
                session_id,
                vec![FileMetadata {
                    relative_path: "a.jpg".into(),
                    occurrences: MetadataOccurrences::default(),
                }],
            )
            .unwrap();
        assert!(late_scan.entries.is_empty());
        assert_eq!(late_scan.revision, revision);
        assert_eq!(state.snapshot().revision, revision);
    }

    #[test]
    fn removed_files_reject_late_metadata_results() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        state
            .mark_loaded(opened.session_id.unwrap(), "C:/photos")
            .unwrap();
        state
            .add_files(opened.session_id.unwrap(), vec![test_file("gone.jpg")])
            .unwrap();
        let removed = state
            .remove_files(opened.session_id.unwrap(), &["gone.jpg".into()])
            .unwrap();
        assert!(removed.files.is_empty());
        assert!(removed.metadata.is_empty());
        assert!(state
            .commit_metadata_results(
                opened.session_id.unwrap(),
                vec![FileMetadata {
                    relative_path: "gone.jpg".into(),
                    occurrences: MetadataOccurrences::default(),
                }],
            )
            .is_err());
    }

    #[test]
    fn search_index_tracks_authoritative_mutations_and_snapshot_recovery() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        let session_id = opened.session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        state
            .add_files(session_id, vec![test_file("a.jpg")])
            .unwrap();

        let search = |query: &str| {
            state
                .search()
                .submit(crate::search_service::MediaLibrarySearchRequest {
                    session_id,
                    request_id: 1,
                    query: query.into(),
                })
        };
        assert_eq!(search("a.jpg").unwrap().matched_paths, vec!["a.jpg"]);

        let schema_id = crate::tag_schema::SchemaDefinitionId {
            table: "Test::Main".into(),
            tag_id: "Needle".into(),
            index: None,
        };
        let occurrence = crate::metadata_occurrence::MetadataOccurrence::try_new(
            crate::metadata_occurrence::MetadataOccurrenceId {
                document: None,
                path: "XMP".into(),
                runtime_tag_id: "Needle".into(),
                tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                    table: schema_id.table.clone(),
                    tag_id: schema_id.tag_id.clone(),
                    index: None,
                },
                copy: 0,
            },
            schema_id.clone(),
            crate::metadata_value::MetadataValue::Text("metadata needle".into()),
            None,
            None,
            None,
        )
        .unwrap();
        state
            .commit_metadata_results(
                session_id,
                vec![FileMetadata {
                    relative_path: "a.jpg".into(),
                    occurrences: MetadataOccurrences(vec![occurrence]),
                }],
            )
            .unwrap();
        assert_eq!(
            search("metadata needle").unwrap().matched_paths,
            vec!["a.jpg"]
        );

        let target = crate::metadata_draft_target::MetadataDraftTarget::NewProperty {
            schema_id: schema_id.clone(),
            write_target: crate::metadata_occurrence::MetadataWriteTarget {
                group1: "XMP-test".into(),
                group7: "ID-Test".into(),
                tag_name: "Needle".into(),
            },
        };
        state
            .commit_draft_row(
                session_id,
                "a.jpg".into(),
                vec![MetadataTargetDraftEntry {
                    target,
                    edit: crate::draft_edits::MetadataDraftEdit {
                        value: Some(crate::metadata_value::MetadataValue::Text(
                            "draft needle".into(),
                        )),
                        intent: crate::draft_edits::EditIntent::Set,
                    },
                }],
            )
            .unwrap();
        assert_eq!(search("has:edits").unwrap().matched_paths, vec!["a.jpg"]);
        assert_eq!(search("draft needle").unwrap().matched_paths, vec!["a.jpg"]);

        state
            .begin_apply_operation(session_id, "apply-search".into(), None)
            .unwrap();
        let replacement = crate::metadata_occurrence::MetadataOccurrence::try_new(
            crate::metadata_occurrence::MetadataOccurrenceId {
                document: None,
                path: "XMP".into(),
                runtime_tag_id: "Needle".into(),
                tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                    table: schema_id.table.clone(),
                    tag_id: schema_id.tag_id.clone(),
                    index: None,
                },
                copy: 0,
            },
            schema_id,
            crate::metadata_value::MetadataValue::Text("apply replacement".into()),
            None,
            None,
            None,
        )
        .unwrap();
        state
            .update_apply_operation(
                session_id,
                &crate::apply_batch::MetadataApplyStreamMessage::ProgressBatch {
                    operation_id: "apply-search".into(),
                    sequence: 1,
                    current: 1,
                    total: 1,
                    results: vec![crate::apply_batch::MetadataApplyFileResult {
                        relative_path: "a.jpg".into(),
                        applied: true,
                        error: None,
                        warning: None,
                        fresh_file_metadata: Some(FileMetadata {
                            relative_path: "a.jpg".into(),
                            occurrences: MetadataOccurrences(vec![replacement]),
                        }),
                        target_outcomes: Vec::new(),
                        persisted_draft_entries: Some(Vec::new()),
                    }],
                },
            )
            .unwrap();
        assert!(search("metadata needle").unwrap().matched_paths.is_empty());
        assert_eq!(
            search("apply replacement").unwrap().matched_paths,
            vec!["a.jpg"]
        );
        assert!(search("has:edits").unwrap().matched_paths.is_empty());

        let recovered = state.snapshot();
        let recovered_result = search("apply replacement").unwrap();
        assert_eq!(recovered_result.session_revision, recovered.revision);
        assert_eq!(recovered_result.matched_paths, vec!["a.jpg"]);

        state.remove_files(session_id, &["a.jpg".into()]).unwrap();
        assert!(search("a.jpg").unwrap().matched_paths.is_empty());
        state.begin_close(session_id).unwrap();
        state.finish_close(session_id).unwrap();
        assert!(search("a.jpg").is_err());
    }

    #[test]
    fn issues_are_session_owned_and_dismissed_by_stable_id() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        state
            .mark_loaded(opened.session_id.unwrap(), "C:/photos")
            .unwrap();
        state
            .add_files(opened.session_id.unwrap(), vec![test_file("private.jpg")])
            .unwrap();
        let with_issue = state
            .add_issue(
                opened.session_id.unwrap(),
                "error".into(),
                "metadata".into(),
                "permission denied".into(),
                vec!["private.jpg".into()],
            )
            .unwrap();
        assert_eq!(with_issue.issue.error_message, "permission denied");
        assert!(matches!(
            with_issue.metadata[0].state,
            MediaLibrarySessionMetadataState::Failed { .. }
        ));
        let issue_id = with_issue.issue.issue_id;
        assert_eq!(state.snapshot().issues[0].issue_id, issue_id);

        let dismissed = state.dismiss_issue(issue_id);
        assert!(dismissed.issues.is_empty());
        assert!(dismissed.revision > with_issue.revision);
    }

    #[test]
    fn apply_operation_ids_are_allocated_by_the_session() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        let session_id = opened.session_id.unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();

        let (first_id, first) = state
            .begin_new_apply_operation(session_id, Some(vec!["a.jpg".into()]))
            .unwrap();
        assert_eq!(first_id, "target-apply-1");
        assert_eq!(first.apply_operation.unwrap().operation_id, first_id);
        state
            .fail_apply_operation(session_id, &first_id, "done".into())
            .unwrap();

        let (second_id, _) = state.begin_new_apply_operation(session_id, None).unwrap();
        assert_eq!(second_id, "target-apply-2");
    }

    #[test]
    fn apply_diagnostics_are_reconstructible_from_the_session_snapshot() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        let session_id = opened.session_id.unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        state
            .begin_apply_operation(session_id, "apply-1".into(), None)
            .unwrap();

        state
            .update_apply_operation(
                session_id,
                &crate::apply_batch::MetadataApplyStreamMessage::ProgressBatch {
                    operation_id: "apply-1".into(),
                    sequence: 1,
                    current: 1,
                    total: 1,
                    results: vec![crate::apply_batch::MetadataApplyFileResult {
                        relative_path: "failed.jpg".into(),
                        applied: false,
                        error: Some("write failed".into()),
                        warning: Some("metadata partially refreshed".into()),
                        fresh_file_metadata: None,
                        target_outcomes: Vec::new(),
                        persisted_draft_entries: None,
                    }],
                },
            )
            .unwrap();

        let updated = state.snapshot();
        let operation = updated.apply_operation.as_ref().unwrap();
        assert_eq!(operation.issues.len(), 2);
        assert_eq!(operation.issues[0].relative_path, "failed.jpg");
        assert_eq!(operation.issues[0].severity, "error");
        assert_eq!(operation.issues[0].message, "write failed");
        assert_eq!(operation.issues[1].severity, "warning");

        let recovered = state.snapshot();
        assert_eq!(recovered.apply_operation, updated.apply_operation);
    }

    #[test]
    fn stale_apply_commands_cannot_mutate_the_current_operation() {
        let state = MediaLibrarySessionState::new();
        let opening = state.begin_open("C:/photos".into());
        let session_id = opening.session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/photos").unwrap();
        state
            .begin_apply_operation(session_id, "apply-current".into(), None)
            .unwrap();

        assert!(state
            .request_apply_cancellation(session_id, "apply-stale")
            .is_err());
        assert!(state
            .dismiss_apply_operation(session_id, "apply-stale")
            .is_err());
        let operation = state.snapshot().apply_operation.unwrap();
        assert_eq!(operation.operation_id, "apply-current");
        assert!(!operation.cancelling);
    }

    #[test]
    fn frontend_production_uses_typed_rust_authority_boundaries() {
        let frontend = include_str!("../../../src/useMediaLibrary.ts");
        let metadata_actions = include_str!("../../../src/hooks/useMetadataSessionActions.ts");
        assert!(!frontend.contains("mutate_media_library_session_draft_rows"));
        assert!(!frontend.contains("save_metadata_draft_rows"));
        assert!(!metadata_actions.contains("mutate_media_library_session_draft_rows"));
        assert!(!metadata_actions.contains("save_metadata_draft_rows"));
        assert!(metadata_actions.contains("set_media_library_session_draft"));
        assert!(metadata_actions.contains("discard_media_library_session_drafts"));
    }

    #[test]
    fn batch_operation_wire_shape_is_rust_generated() {
        let generated = include_str!("../../../src/types/generated/MediaLibraryBatchOperation.ts");
        assert!(generated.contains("This file was generated by"));
        assert!(generated.contains("operation_id"));
        assert!(generated.contains("estimate: unknown | null"));
        assert!(generated.contains("summary: unknown | null"));
    }

    #[test]
    fn failed_scan_state_and_issue_are_recoverable_from_snapshot() {
        let state = MediaLibrarySessionState::new();
        let opening = state.begin_open("C:/missing".into());
        let session_id = opening.session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/missing").unwrap();

        let failed = state
            .fail_session(session_id, "scan", "not a directory".into())
            .unwrap();

        assert_eq!(failed.lifecycle, MediaLibrarySessionLifecycle::Failed);
        assert!(!failed.discovery_running);
        assert_eq!(failed.issues.len(), 1);
        assert_eq!(failed.issues[0].error_type, "scan");
        assert_eq!(state.snapshot(), failed);
    }

    #[test]
    fn stale_batch_operation_cannot_mutate_a_replacement_session() {
        let state = MediaLibrarySessionState::new();
        let first = state.begin_open("C:/one".into());
        let first_id = first.session_id.unwrap();
        state
            .install_draft_load_result(first_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(first_id, "C:/one").unwrap();
        let started = state
            .begin_batch_operation(
                first_id,
                "describe",
                MediaLibraryBatchOperationPhase::Running,
                1,
                vec!["one.jpg".into()],
                Some(serde_json::json!(["one.jpg"])),
            )
            .unwrap();
        let operation_id = started.batch_operations["describe"].operation_id.clone();

        let second = state.begin_open("C:/two".into());
        let second_id = second.session_id.unwrap();
        state
            .install_draft_load_result(second_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(second_id, "C:/two").unwrap();

        assert!(state
            .update_batch_operation_progress(
                first_id,
                &operation_id,
                1,
                1,
                Some("one.jpg".into()),
                Some("ok"),
                None,
            )
            .is_err());
        assert!(state.snapshot().batch_operations.is_empty());
    }

    #[test]
    fn estimate_and_run_share_one_batch_operation_identity() {
        let state = MediaLibrarySessionState::new();
        let opening = state.begin_open("C:/media".into());
        let session_id = opening.session_id.unwrap();
        state
            .install_draft_load_result(session_id, Ok(MetadataTargetDraftsByFile::new()))
            .unwrap();
        state.mark_loaded(session_id, "C:/media").unwrap();
        let estimating = state
            .begin_batch_operation(
                session_id,
                "normalise",
                MediaLibraryBatchOperationPhase::Estimating,
                1,
                vec!["image.jpg".into()],
                Some(serde_json::json!([{"relPath": "image.jpg"}])),
            )
            .unwrap();
        let operation_id = estimating.batch_operations["normalise"]
            .operation_id
            .clone();
        let awaiting = state
            .complete_batch_operation_estimate(
                session_id,
                &operation_id,
                serde_json::json!({"cost": 1}),
            )
            .unwrap();
        let running = state
            .start_batch_operation(session_id, &operation_id, 1, None)
            .unwrap();

        assert_eq!(
            running.batch_operations["normalise"].operation_id,
            operation_id
        );
        assert_eq!(
            running.batch_operations["normalise"].estimate,
            awaiting.batch_operations["normalise"].estimate
        );
        assert!(state
            .start_batch_operation(session_id, "stale", 1, None)
            .is_err());
    }
}
