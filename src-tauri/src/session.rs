use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const SESSION_CHANGED_EVENT: &str = "media_library_session_changed";

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
}

pub struct MediaLibrarySessionState {
    next_session_id: AtomicU64,
    snapshot: Mutex<MediaLibrarySessionSnapshot>,
}

impl MediaLibrarySessionState {
    pub fn new() -> Self {
        Self {
            next_session_id: AtomicU64::new(1),
            snapshot: Mutex::new(MediaLibrarySessionSnapshot {
                session_id: None,
                revision: 0,
                lifecycle: MediaLibrarySessionLifecycle::Idle,
                folder: None,
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
        Ok(snapshot.clone())
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

        let loaded = state.mark_loaded(1, "C:/photos").unwrap();
        assert_eq!(loaded.revision, 2);
        assert_eq!(loaded.lifecycle, MediaLibrarySessionLifecycle::Loaded);
        assert_eq!(state.snapshot(), loaded);

        let closing = state.begin_close();
        assert_eq!(closing.revision, 3);
        assert_eq!(closing.lifecycle, MediaLibrarySessionLifecycle::Closing);

        let idle = state.finish_close();
        assert_eq!(idle.revision, 4);
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
}
