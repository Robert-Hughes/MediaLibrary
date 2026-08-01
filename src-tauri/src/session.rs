use crate::scanner::FileInfo;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const SESSION_CHANGED_EVENT: &str = "media_library_session_changed";
pub const SESSION_FILES_ADDED_EVENT: &str = "media_library_session_files_added";

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
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
    snapshot: Mutex<MediaLibrarySessionSnapshot>,
}

impl MediaLibrarySessionState {
    pub fn new() -> Self {
        Self {
            next_session_id: AtomicU64::new(1),
            next_issue_id: AtomicU64::new(1),
            snapshot: Mutex::new(MediaLibrarySessionSnapshot {
                session_id: None,
                revision: 0,
                lifecycle: MediaLibrarySessionLifecycle::Idle,
                folder: None,
                files: Vec::new(),
                discovery_running: false,
                issues: Vec::new(),
            }),
        }
    }

    pub fn snapshot(&self) -> MediaLibrarySessionSnapshot {
        self.snapshot.lock().unwrap().clone()
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
        snapshot.clone()
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
        snapshot.files.extend(files.iter().cloned());
        Ok(MediaLibrarySessionFilesAdded {
            session_id,
            revision: snapshot.revision,
            files,
        })
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

        let completed = state.finish_discovery(1).unwrap();
        assert_eq!(completed.revision, 4);
        assert!(!completed.discovery_running);

        let closing = state.begin_close();
        assert_eq!(closing.revision, 5);
        assert_eq!(closing.lifecycle, MediaLibrarySessionLifecycle::Closing);

        let idle = state.finish_close();
        assert_eq!(idle.revision, 6);
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
    fn issues_are_session_owned_and_dismissed_by_stable_id() {
        let state = MediaLibrarySessionState::new();
        let opened = state.begin_open("C:/photos".into());
        state
            .mark_loaded(opened.session_id.unwrap(), "C:/photos")
            .unwrap();
        let with_issue = state
            .add_issue(
                opened.session_id.unwrap(),
                "error".into(),
                "scanner".into(),
                "permission denied".into(),
                vec!["private.jpg".into()],
            )
            .unwrap();
        assert_eq!(with_issue.issues.len(), 1);
        let issue_id = with_issue.issues[0].issue_id;
        assert_eq!(state.snapshot().issues[0].issue_id, issue_id);

        let dismissed = state.dismiss_issue(issue_id);
        assert!(dismissed.issues.is_empty());
        assert!(dismissed.revision > with_issue.revision);
    }
}
