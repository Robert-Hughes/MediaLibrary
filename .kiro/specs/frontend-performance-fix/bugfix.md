# Bugfix Requirements Document

## Introduction

This bugfix addresses a performance issue where the frontend becomes overloaded when loading metadata for a large folder. The user reports that metadata takes an unreasonable amount of time to be shown, spinners persist for a long time, and the frontend appears unresponsive even though the Rust backend (exiftool) works correctly and completes its work efficiently.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a folder with 500+ photos is scanned THEN the frontend receives image_metadata_ready events individually and triggers a separate setTimeout flush for each batch, causing excessive React state updates

1.2 WHEN image_metadata_ready events arrive rapidly THEN each event calls flushBatch() which rebuilds the entire photos array in app state, triggering cascading re-renders across all PhotoRow components

1.3 WHEN metadata events are processed THEN the app state update sets imageMetadataRemaining to a new value, which triggers re-renders of the entire photo list even though only one row's metadata changed

1.4 WHEN there are 1000+ photos in a folder THEN the combination of individual metadata event processing and full state rebuilds causes the frontend to become overloaded, resulting in no visible updates for extended periods despite the backend completing its work

### Expected Behavior (Correct)

2.1 WHEN image_metadata_ready events arrive THEN the system SHALL batch multiple events together before triggering a state update, with a maximum batch size of 50 items

2.2 WHEN metadata updates are flushed to React state THEN the system SHALL only update the imageMetadataRemaining counter without rebuilding the entire photos array

2.3 WHEN the scan completes THEN the system SHALL show metadata loading spinners only for photos that are still loading, not for photos that have already received their metadata

2.4 WHEN processing large folders (1000+ photos) THEN the system SHALL maintain UI responsiveness by decoupling metadata arrival from state updates

### Unchanged Behavior (Regression Prevention)

3.1 WHEN individual photo metadata is received THEN the system SHALL CONTINUE TO update the ImageMetadataStore so the specific row displays the metadata immediately via useSyncExternalStore

3.2 WHEN a thumbnail is generated THEN the system SHALL CONTINUE TO update the ThumbnailStore so the specific row displays the thumbnail immediately via useSyncExternalStore

3.3 WHEN a new folder is opened THEN the system SHALL CONTINUE TO clear all previous state and begin a fresh scan

3.4 WHEN scan_complete is received THEN the system SHALL CONTINUE TO set the scanning flag to false to indicate completion
