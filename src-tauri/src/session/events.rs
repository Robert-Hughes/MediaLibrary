//! Ordered delivery of revisioned session events.
//!
//! Session mutations assign revisions under one snapshot mutex. To guarantee
//! the frontend observes events in revision order, every mutation pushes its
//! notification onto a single channel *while still holding that mutex*.
//! `drain_session_events` consumes the channel on one dedicated thread and
//! calls `app.emit` in FIFO order, so webview delivery order matches commit
//! order even though many worker threads mutate the session concurrently.

use super::{
    MediaLibrarySessionApplyOperationChanged, MediaLibrarySessionBatchOperationChanged,
    MediaLibrarySessionDiscoveryChanged, MediaLibrarySessionDraftPersistenceChanged,
    MediaLibrarySessionDraftsChanged, MediaLibrarySessionFilesAdded,
    MediaLibrarySessionFilesRemoved, MediaLibrarySessionIssueAdded,
    MediaLibrarySessionIssueRemoved, MediaLibrarySessionMetadataChanged,
    MediaLibrarySessionRevisionAdvanced, MediaLibrarySessionSnapshot,
    MediaLibrarySessionThumbnailsChanged, MediaLibrarySessionVerificationOutcomesChanged,
    SESSION_APPLY_OPERATION_CHANGED_EVENT, SESSION_APPLY_PROGRESS_EVENT,
    SESSION_BATCH_OPERATION_CHANGED_EVENT, SESSION_CHANGED_EVENT, SESSION_DISCOVERY_CHANGED_EVENT,
    SESSION_DRAFTS_CHANGED_EVENT, SESSION_DRAFT_PERSISTENCE_CHANGED_EVENT,
    SESSION_FILES_ADDED_EVENT, SESSION_FILES_REMOVED_EVENT, SESSION_ISSUE_ADDED_EVENT,
    SESSION_ISSUE_REMOVED_EVENT, SESSION_METADATA_CHANGED_EVENT, SESSION_REVISION_ADVANCED_EVENT,
    SESSION_THUMBNAILS_CHANGED_EVENT, SESSION_VERIFICATION_OUTCOMES_CHANGED_EVENT,
};
use crate::apply_batch::MetadataApplyStreamMessage;
use std::sync::mpsc;
use tauri::AppHandle;

/// One revisioned session notification, queued in commit order.
#[derive(Debug)]
pub enum SessionEvent {
    Snapshot(Box<MediaLibrarySessionSnapshot>),
    FilesAdded(MediaLibrarySessionFilesAdded),
    MetadataChanged(MediaLibrarySessionMetadataChanged),
    ThumbnailsChanged(MediaLibrarySessionThumbnailsChanged),
    IssueAdded(MediaLibrarySessionIssueAdded),
    /// Apply-progress stream, emitted through the same ordered channel so it
    /// always follows the operation's begin snapshot. Not revisioned itself.
    ApplyProgress(Box<MetadataApplyStreamMessage>),
    /// Revision-only advance for state changes that carry no delta payload
    /// Revision-only advance notification. See the wire-model doc comment.
    RevisionAdvanced(MediaLibrarySessionRevisionAdvanced),
    /// One batch operation (describe / geocode / normalise) changed. Carries
    /// only the affected operation instead of a full session snapshot.
    BatchOperationChanged(Box<MediaLibrarySessionBatchOperationChanged>),
    /// The apply operation changed. Carries only the apply operation instead
    /// of a full session snapshot.
    ApplyOperationChanged(Box<MediaLibrarySessionApplyOperationChanged>),
    /// Verification outcomes (and any co-committed draft rows) changed.
    VerificationOutcomesChanged(Box<MediaLibrarySessionVerificationOutcomesChanged>),
    /// Draft rows were committed for a set of files.
    DraftsChanged(Box<MediaLibrarySessionDraftsChanged>),
    /// Draft persistence state changed.
    DraftPersistenceChanged(Box<MediaLibrarySessionDraftPersistenceChanged>),
    /// The discovery-running flag changed.
    DiscoveryChanged(Box<MediaLibrarySessionDiscoveryChanged>),
    /// Files were removed from the session.
    FilesRemoved(Box<MediaLibrarySessionFilesRemoved>),
    /// An issue was dismissed.
    IssueRemoved(Box<MediaLibrarySessionIssueRemoved>),
    /// Disposable unversioned frontend projection (batch-job estimate
    /// telemetry, progress, completion summaries). Routed through the same
    /// ordered channel so it is delivered after the snapshot/mutation it
    /// describes and can never overtake it. Carries the event name because
    /// the projection namespace is caller-chosen per job (`describe_*`,
    /// `geocode_*`, `normalise_*`).
    Projection(Box<ProjectionEvent>),
}

/// One unversioned frontend projection event queued on the session channel.
#[derive(Debug)]
pub struct ProjectionEvent {
    pub event: String,
    pub payload: serde_json::Value,
}

impl SessionEvent {
    pub fn event_name(&self) -> &str {
        match self {
            Self::Snapshot(_) => SESSION_CHANGED_EVENT,
            Self::FilesAdded(_) => SESSION_FILES_ADDED_EVENT,
            Self::MetadataChanged(_) => SESSION_METADATA_CHANGED_EVENT,
            Self::ThumbnailsChanged(_) => SESSION_THUMBNAILS_CHANGED_EVENT,
            Self::IssueAdded(_) => SESSION_ISSUE_ADDED_EVENT,
            Self::ApplyProgress(_) => SESSION_APPLY_PROGRESS_EVENT,
            Self::RevisionAdvanced(_) => SESSION_REVISION_ADVANCED_EVENT,
            Self::BatchOperationChanged(_) => SESSION_BATCH_OPERATION_CHANGED_EVENT,
            Self::ApplyOperationChanged(_) => SESSION_APPLY_OPERATION_CHANGED_EVENT,
            Self::VerificationOutcomesChanged(_) => SESSION_VERIFICATION_OUTCOMES_CHANGED_EVENT,
            Self::DraftsChanged(_) => SESSION_DRAFTS_CHANGED_EVENT,
            Self::DraftPersistenceChanged(_) => SESSION_DRAFT_PERSISTENCE_CHANGED_EVENT,
            Self::DiscoveryChanged(_) => SESSION_DISCOVERY_CHANGED_EVENT,
            Self::FilesRemoved(_) => SESSION_FILES_REMOVED_EVENT,
            Self::IssueRemoved(_) => SESSION_ISSUE_REMOVED_EVENT,
            Self::Projection(value) => &value.event,
        }
    }

    /// The session revision carried by this event. Apply-progress events are
    /// not revisioned and report `0`.
    pub fn revision(&self) -> u64 {
        match self {
            Self::Snapshot(value) => value.revision,
            Self::FilesAdded(value) => value.revision,
            Self::MetadataChanged(value) => value.revision,
            Self::ThumbnailsChanged(value) => value.revision,
            Self::IssueAdded(value) => value.revision,
            Self::ApplyProgress(_) => 0,
            Self::RevisionAdvanced(value) => value.revision,
            Self::BatchOperationChanged(value) => value.revision,
            Self::ApplyOperationChanged(value) => value.revision,
            Self::VerificationOutcomesChanged(value) => value.revision,
            Self::DraftsChanged(value) => value.revision,
            Self::DraftPersistenceChanged(value) => value.revision,
            Self::DiscoveryChanged(value) => value.revision,
            Self::FilesRemoved(value) => value.revision,
            Self::IssueRemoved(value) => value.revision,
            Self::Projection(_) => 0,
        }
    }

    pub fn into_payload(self) -> serde_json::Value {
        let serialized = match self {
            Self::Snapshot(payload) => serde_json::to_value(*payload),
            Self::FilesAdded(payload) => serde_json::to_value(payload),
            Self::MetadataChanged(payload) => serde_json::to_value(payload),
            Self::ThumbnailsChanged(payload) => serde_json::to_value(payload),
            Self::IssueAdded(payload) => serde_json::to_value(payload),
            Self::ApplyProgress(payload) => serde_json::to_value(*payload),
            Self::RevisionAdvanced(payload) => serde_json::to_value(payload),
            Self::BatchOperationChanged(payload) => serde_json::to_value(*payload),
            Self::ApplyOperationChanged(payload) => serde_json::to_value(*payload),
            Self::VerificationOutcomesChanged(payload) => serde_json::to_value(*payload),
            Self::DraftsChanged(payload) => serde_json::to_value(*payload),
            Self::DraftPersistenceChanged(payload) => serde_json::to_value(*payload),
            Self::DiscoveryChanged(payload) => serde_json::to_value(*payload),
            Self::FilesRemoved(payload) => serde_json::to_value(*payload),
            Self::IssueRemoved(payload) => serde_json::to_value(*payload),
            Self::Projection(value) => Ok(value.payload),
        };
        serialized.unwrap_or_else(|error| {
            log::error!("[session-event] failed to serialize payload: {error}");
            serde_json::Value::Null
        })
    }
}

/// Drain `SessionEvent`s in FIFO order and emit each to the frontend.
///
/// Runs for the application lifetime: the channel stays open while the
/// session state (which owns the sender) is alive, and the loop exits when
/// every sender is dropped during teardown.
pub fn drain_session_events(receiver: mpsc::Receiver<SessionEvent>, app: AppHandle) {
    while let Ok(event) = receiver.recv() {
        let name = event.event_name().to_owned();
        let payload = event.into_payload();
        let _ = crate::emit_frontend_event(&app, &name, payload);
    }
}
