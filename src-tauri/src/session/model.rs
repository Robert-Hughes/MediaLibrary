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
