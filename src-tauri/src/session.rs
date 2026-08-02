use crate::apply_edits::MetadataTargetOutcome;
use crate::draft_edits::{MetadataTargetDraftEntry, MetadataTargetDraftsByFile};
use crate::metadata_occurrence::MetadataOccurrences;
use crate::scanner::{FileInfo, FileMetadata};
use serde::Serialize;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const SESSION_CHANGED_EVENT: &str = "media_library_session_changed";
pub const SESSION_FILES_ADDED_EVENT: &str = "media_library_session_files_added";
pub const SESSION_METADATA_CHANGED_EVENT: &str = "media_library_session_metadata_changed";
pub const SESSION_THUMBNAILS_CHANGED_EVENT: &str = "media_library_session_thumbnails_changed";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaLibrarySessionLifecycle {
    Idle,
    Opening,
    Loaded,
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
    pub summary: Option<crate::apply_batch::MetadataApplySummary>,
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
pub struct MediaLibrarySessionFilesAdded {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: u64,
    pub files: Vec<FileInfo>,
}

pub struct MediaLibrarySessionState {
    next_session_id: AtomicU64,
    next_issue_id: AtomicU64,
    next_thumbnail_version: AtomicU64,
    snapshot: Mutex<MediaLibrarySessionSnapshot>,
    thumbnail_cache: Mutex<HashMap<String, String>>,
    superseded_scan_metadata: Mutex<BTreeSet<String>>,
}

impl MediaLibrarySessionState {
    pub fn new() -> Self {
        Self {
            next_session_id: AtomicU64::new(1),
            next_issue_id: AtomicU64::new(1),
            next_thumbnail_version: AtomicU64::new(1),
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
            }),
            thumbnail_cache: Mutex::new(HashMap::new()),
            superseded_scan_metadata: Mutex::new(BTreeSet::new()),
        }
    }

    pub fn snapshot(&self) -> MediaLibrarySessionSnapshot {
        self.snapshot.lock().unwrap().clone()
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
            summary: None,
        });
        Ok(snapshot.clone())
    }

    pub fn update_apply_operation(
        &self,
        session_id: u64,
        message: &crate::apply_batch::MetadataApplyStreamMessage,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
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
        Ok(snapshot.clone())
    }

    pub fn request_apply_cancellation(
        &self,
        session_id: u64,
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
        if !matches!(operation.state, MediaLibraryApplyOperationState::Running) {
            return Ok(snapshot.clone());
        }
        operation.cancelling = true;
        snapshot.revision += 1;
        Ok(snapshot.clone())
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
        Ok(snapshot.clone())
    }

    pub fn dismiss_apply_operation(
        &self,
        session_id: u64,
    ) -> Result<MediaLibrarySessionSnapshot, String> {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.session_id != Some(session_id) {
            return Err("The media-library session changed before apply was dismissed".into());
        }
        if snapshot.apply_operation.is_none() {
            return Ok(snapshot.clone());
        }
        snapshot.apply_operation = None;
        snapshot.verification_outcomes.clear();
        snapshot.revision += 1;
        Ok(snapshot.clone())
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
        Ok(snapshot.clone())
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
        Ok(snapshot.clone())
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
        self.superseded_scan_metadata.lock().unwrap().clear();
        self.thumbnail_cache.lock().unwrap().clear();
        snapshot.clone()
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
                snapshot.draft_persistence =
                    MediaLibrarySessionDraftPersistenceState::LoadFailed { error };
            }
        }
        Ok(snapshot.clone())
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
        for (relative_path, entries) in rows {
            if entries.is_empty() {
                snapshot.drafts.remove(&relative_path);
            } else {
                snapshot.drafts.insert(relative_path, entries);
            }
        }
        Ok(snapshot.clone())
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
        Ok(snapshot.clone())
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
        Ok(snapshot.clone())
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
        Ok(MediaLibrarySessionFilesAdded {
            session_id,
            revision: snapshot.revision,
            files,
        })
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
        Ok(MediaLibrarySessionMetadataChanged {
            session_id,
            revision: snapshot.revision,
            entries,
        })
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
        Ok(MediaLibrarySessionThumbnailsChanged {
            session_id,
            revision: snapshot.revision,
            entries,
        })
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
        Ok(MediaLibrarySessionMetadataChanged {
            session_id,
            revision: snapshot.revision,
            entries,
        })
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
        if snapshot.files.len() != file_count
            || snapshot.metadata.len() != metadata_count
            || snapshot.thumbnails.len() != thumbnail_count
            || snapshot.drafts.len() != draft_count
        {
            snapshot.revision += 1;
        }
        Ok(snapshot.clone())
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
    ) -> Result<MediaLibrarySessionSnapshot, String> {
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
                }
            }
        }
        snapshot.issues.push(MediaLibrarySessionIssue {
            issue_id,
            severity,
            error_type,
            error_message,
            affected_files,
        });
        const MAX_SESSION_ISSUES: usize = 100;
        if snapshot.issues.len() > MAX_SESSION_ISSUES {
            let excess = snapshot.issues.len() - MAX_SESSION_ISSUES;
            snapshot.issues.drain(0..excess);
        }
        Ok(snapshot.clone())
    }

    pub fn dismiss_issue(&self, issue_id: u64) -> MediaLibrarySessionSnapshot {
        let mut snapshot = self.snapshot.lock().unwrap();
        let previous_len = snapshot.issues.len();
        snapshot.issues.retain(|issue| issue.issue_id != issue_id);
        if snapshot.issues.len() != previous_len {
            snapshot.revision += 1;
        }
        snapshot.clone()
    }

    pub fn begin_close(&self) -> MediaLibrarySessionSnapshot {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.lifecycle == MediaLibrarySessionLifecycle::Idle {
            return snapshot.clone();
        }
        snapshot.revision += 1;
        snapshot.lifecycle = MediaLibrarySessionLifecycle::Closing;
        snapshot.clone()
    }

    pub fn finish_close(&self) -> MediaLibrarySessionSnapshot {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.lifecycle == MediaLibrarySessionLifecycle::Idle {
            return snapshot.clone();
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
        self.thumbnail_cache.lock().unwrap().clear();
        self.superseded_scan_metadata.lock().unwrap().clear();
        snapshot.clone()
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

        let closing = state.begin_close();
        assert_eq!(closing.revision, 6);
        assert_eq!(closing.lifecycle, MediaLibrarySessionLifecycle::Closing);

        let idle = state.finish_close();
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
        assert_eq!(with_issue.issues.len(), 1);
        assert!(matches!(
            with_issue.metadata[0].state,
            MediaLibrarySessionMetadataState::Failed { .. }
        ));
        let issue_id = with_issue.issues[0].issue_id;
        assert_eq!(state.snapshot().issues[0].issue_id, issue_id);

        let dismissed = state.dismiss_issue(issue_id);
        assert!(dismissed.issues.is_empty());
        assert!(dismissed.revision > with_issue.revision);
    }
}
