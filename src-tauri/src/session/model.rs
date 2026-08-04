//! Stable wire and domain model for the authoritative media-library session.

use crate::apply_edits::MetadataTargetOutcome;
use crate::draft_edits::MetadataTargetDraftsByFile;
use crate::metadata_occurrence::MetadataOccurrences;
use crate::scanner::FileInfo;
use serde::Serialize;
use std::collections::HashMap;

pub const SESSION_CHANGED_EVENT: &str = "media_library_session_changed";
pub const SESSION_FILES_ADDED_EVENT: &str = "media_library_session_files_added";
pub const SESSION_METADATA_CHANGED_EVENT: &str = "media_library_session_metadata_changed";
pub const SESSION_THUMBNAILS_CHANGED_EVENT: &str = "media_library_session_thumbnails_changed";
pub const SESSION_ISSUE_ADDED_EVENT: &str = "media_library_session_issue_added";
pub const SESSION_APPLY_PROGRESS_EVENT: &str = "media_library_session_apply_progress";
pub const SESSION_REVISION_ADVANCED_EVENT: &str = "media_library_session_revision_advanced";
pub const SESSION_BATCH_OPERATION_CHANGED_EVENT: &str =
    "media_library_session_batch_operation_changed";
pub const SESSION_APPLY_OPERATION_CHANGED_EVENT: &str =
    "media_library_session_apply_operation_changed";
pub const SESSION_VERIFICATION_OUTCOMES_CHANGED_EVENT: &str =
    "media_library_session_verification_outcomes_changed";
pub const SESSION_DRAFTS_CHANGED_EVENT: &str = "media_library_session_drafts_changed";
pub const SESSION_DRAFT_PERSISTENCE_CHANGED_EVENT: &str =
    "media_library_session_draft_persistence_changed";
pub const SESSION_DISCOVERY_CHANGED_EVENT: &str = "media_library_session_discovery_changed";
pub const SESSION_FILES_REMOVED_EVENT: &str = "media_library_session_files_removed";
pub const SESSION_ISSUE_REMOVED_EVENT: &str = "media_library_session_issue_removed";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaLibrarySessionLifecycle {
    Idle,
    Opening,
    Loaded,
    Failed,
    Closing,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionSnapshot {
    #[cfg_attr(test, ts(type = "number | null"))]
    pub session_id: Option<u64>,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub lifecycle: MediaLibrarySessionLifecycle,
    pub folder: Option<String>,
    pub files: Vec<FileInfo>,
    pub discovery_running: bool,
    pub issues: Vec<MediaLibrarySessionIssue>,
    pub metadata: Vec<MediaLibrarySessionFileMetadata>,
    pub thumbnails: Vec<MediaLibrarySessionFileThumbnail>,
    pub drafts: MetadataTargetDraftsByFile,
    pub draft_persistence: MediaLibrarySessionDraftPersistenceState,
    pub apply_operation: Option<MediaLibraryApplyOperation>,
    pub verification_outcomes: HashMap<String, Vec<MetadataTargetOutcome>>,
    pub batch_operations: HashMap<String, MediaLibraryBatchOperation>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaLibraryApplyOperationState {
    Running,
    Completed,
    Failed { error: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibraryApplyIssue {
    pub relative_path: String,
    pub severity: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibraryApplyOperation {
    pub operation_id: String,
    pub requested_paths: Option<Vec<String>>,
    pub state: MediaLibraryApplyOperationState,
    pub total: Option<usize>,
    pub current: usize,
    pub current_file: Option<String>,
    pub cancelling: bool,
    pub file_failure_count: usize,
    pub warning_count: usize,
    pub issues: Vec<MediaLibraryApplyIssue>,
    pub summary: Option<crate::apply_batch::MetadataApplySummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaLibraryBatchOperationPhase {
    Estimating,
    AwaitingConfirm,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibraryBatchOperationFailure {
    pub relative_path: String,
    pub kind: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibraryBatchOperation {
    pub operation_id: String,
    pub kind: String,
    pub requested_paths: Vec<String>,
    #[cfg_attr(test, ts(type = "unknown | null"))]
    pub request: Option<serde_json::Value>,
    pub phase: MediaLibraryBatchOperationPhase,
    pub total: usize,
    pub current: usize,
    pub current_file: Option<String>,
    pub cancelling: bool,
    pub failures: Vec<MediaLibraryBatchOperationFailure>,
    pub succeeded: Vec<String>,
    #[cfg_attr(test, ts(type = "unknown | null"))]
    pub estimate: Option<serde_json::Value>,
    #[cfg_attr(test, ts(type = "unknown | null"))]
    pub summary: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaLibrarySessionDraftPersistenceState {
    Loading,
    Ready,
    LoadFailed { error: String },
    SaveFailed { error: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaLibrarySessionMetadataState {
    Loading,
    Ready { occurrences: MetadataOccurrences },
    Failed { error: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionFileMetadata {
    pub relative_path: String,
    pub state: MediaLibrarySessionMetadataState,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionMetadataChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub entries: Vec<MediaLibrarySessionFileMetadata>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaLibrarySessionThumbnailState {
    Loading,
    Ready { cache_key: String },
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionFileThumbnail {
    pub relative_path: String,
    pub state: MediaLibrarySessionThumbnailState,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionThumbnailsChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub entries: Vec<MediaLibrarySessionFileThumbnail>,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibraryThumbnailPayload {
    pub cache_key: String,
    pub thumbnail: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionIssue {
    #[cfg_attr(test, ts(type = "number"))]
    pub issue_id: u64,
    pub severity: String,
    pub error_type: String,
    pub error_message: String,
    pub affected_files: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionIssueAdded {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub issue: MediaLibrarySessionIssue,
    pub metadata: Vec<MediaLibrarySessionFileMetadata>,
}

/// Revision-only advance notification. Emitted for accepted state transitions
/// that change no user-visible entity set (for example per-row apply progress
/// or generated-draft staging), so the frontend's revision sequence stays dense
/// and no spurious gaps are reported.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionRevisionAdvanced {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionFilesAdded {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub files: Vec<FileInfo>,
}

/// One batch operation (describe / geocode / normalise) was created, advanced
/// or removed. `operation` is `None` when the operation was dismissed.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionBatchOperationChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub kind: String,
    pub operation: Option<MediaLibraryBatchOperation>,
}

/// The apply operation was created, advanced to a terminal state, or cleared.
/// `operation` is `None` when the apply operation was dismissed.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionApplyOperationChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub operation: Option<MediaLibraryApplyOperation>,
}

/// Verification outcomes changed for a set of files. Carries the mutated
/// outcomes map plus any draft rows committed alongside the resolution (the
/// resolve command can persist draft entries in the same mutation).
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionVerificationOutcomesChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub outcomes: HashMap<String, Vec<MetadataTargetOutcome>>,
    pub draft_rows: HashMap<String, Vec<crate::draft_edits::MetadataTargetDraftEntry>>,
}

/// Draft rows committed for a set of files. An empty entry value removes the
/// file's drafts.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionDraftsChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub rows: HashMap<String, Vec<crate::draft_edits::MetadataTargetDraftEntry>>,
}

/// Draft persistence state changed (for example a save failure).
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionDraftPersistenceChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub state: MediaLibrarySessionDraftPersistenceState,
}

/// Discovery (scan) running flag changed.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionDiscoveryChanged {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub discovery_running: bool,
}

/// Files were removed from the session.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionFilesRemoved {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub paths: Vec<String>,
}

/// An issue was dismissed.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySessionIssueRemoved {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub issue_id: u64,
}
