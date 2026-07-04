# Tasks

## Implementation

- [x] 1.1 Add metadata buffer refs in useMediaLibrary.ts
- [x] 1.2 Create flushMetadataBatch function
- [x] 1.3 Modify image_metadata_ready listener for batching
- [x] 1.4 Add cleanup on scan start and scan complete
- [x] 1.5 Add thumbnail batching to frontend (buffer + flush function)
- [x] 1.6 Batch Rust thumbnail_ready events (emit in batches of 50)
- [x] 1.7 Run build and tests

## Verification

- [ ] 2.1 Verify spinners disappear as metadata loads
- [ ] 2.2 Verify UI remains responsive during load
- [ ] 2.3 Verify no regression in normal-sized folders
