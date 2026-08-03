//! Ordered delivery of revisioned session events.
//!
//! Session mutations assign revisions under one snapshot mutex. To guarantee
//! the frontend observes events in revision order, every mutation pushes its
//! notification onto a single channel *while still holding that mutex*.
//! `drain_session_events` consumes the channel on one dedicated thread and
//! calls `app.emit` in FIFO order, so webview delivery order matches commit
//! order even though many worker threads mutate the session concurrently.

use super::{
    MediaLibrarySessionFilesAdded, MediaLibrarySessionIssueAdded,
    MediaLibrarySessionMetadataChanged, MediaLibrarySessionSnapshot,
    MediaLibrarySessionThumbnailsChanged, SESSION_CHANGED_EVENT, SESSION_FILES_ADDED_EVENT,
    SESSION_ISSUE_ADDED_EVENT, SESSION_METADATA_CHANGED_EVENT, SESSION_THUMBNAILS_CHANGED_EVENT,
};
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
}

impl SessionEvent {
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::Snapshot(_) => SESSION_CHANGED_EVENT,
            Self::FilesAdded(_) => SESSION_FILES_ADDED_EVENT,
            Self::MetadataChanged(_) => SESSION_METADATA_CHANGED_EVENT,
            Self::ThumbnailsChanged(_) => SESSION_THUMBNAILS_CHANGED_EVENT,
            Self::IssueAdded(_) => SESSION_ISSUE_ADDED_EVENT,
        }
    }

    /// The session revision carried by this event.
    pub fn revision(&self) -> u64 {
        match self {
            Self::Snapshot(value) => value.revision,
            Self::FilesAdded(value) => value.revision,
            Self::MetadataChanged(value) => value.revision,
            Self::ThumbnailsChanged(value) => value.revision,
            Self::IssueAdded(value) => value.revision,
        }
    }

    pub fn into_payload(self) -> serde_json::Value {
        let serialized = match self {
            Self::Snapshot(payload) => serde_json::to_value(*payload),
            Self::FilesAdded(payload) => serde_json::to_value(payload),
            Self::MetadataChanged(payload) => serde_json::to_value(payload),
            Self::ThumbnailsChanged(payload) => serde_json::to_value(payload),
            Self::IssueAdded(payload) => serde_json::to_value(payload),
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
        let name = event.event_name();
        let payload = event.into_payload();
        let _ = crate::emit_frontend_event(&app, name, payload);
    }
}
