# Apply memory and ownership

Metadata Apply is a streamed, chunk-bounded protocol. Its design goal is that
the number of files already completed must not determine the amount of live
per-file result data in either Rust or the WebView.

## Data path

`apply_metadata_draft_edits_cmd` receives:

- the opened folder;
- either an explicit relative-path subset or `null` for every persisted draft
  row in that folder;
- an operation ID; and
- a command-owned `Channel<MetadataApplyStreamMessage>`.

The backend sends, in order:

1. `started`, containing the selected file count;
2. one `progress_batch` per persisted backend chunk; and
3. `complete`, containing the compact `MetadataApplySummary`.

The normal command response repeats only that compact summary. It does **not**
return the complete file collection. If delivery of a progress batch fails,
only that batch's file results are returned through `undelivered_files`, and
the summary records the exact fallback count. A failed completion-message send
is reported separately because its payload is already compact.

This gives the normal path one owner for each heavyweight per-file payload:

- Rust owns the current chunk until the channel send completes;
- the WebView parses and applies that bounded chunk;
- occurrence arrays transfer into the authoritative occurrence store;
- persisted draft rows and unresolved verification outcomes transfer into
  their stores; and
- the progress payload is then eligible for collection.

No successful file is replayed from the terminal command result.

## Frontend application

`TargetApplyController` validates the operation ID before parsing heavyweight
file results. Within the current operation it requires contiguous sequence and
completed-file counts. Each accepted batch is validated before any store is
mutated, then drafts, verification and occurrences are installed with one
outer-store update per chunk.

The controller retains only:

- compact progress and summary counters;
- at most twenty compact protocol/application error records;
- at most one failed chunk for a terminal retry; and
- exceptional undelivered files until they have been applied.

It does not retain raw event payloads, every per-file application summary or a
settled Promise whose value contains the complete result collection. Callback
failures are contained and cannot interrupt the backend command.

Apply readback commits fresh occurrences and persisted draft rows to the Rust
session, then updates the separate Rust search index after releasing the main
session lock. An active query is re-evaluated through a coalesced refresh and an
event is emitted only when the effective matched path set changes. The frontend
receives no occurrence or draft payload for search and retains no search-index
copy to clean up after Apply.

## Exact-once and failure semantics

- A streamed file is incorporated once. Terminal completion never replays it.
- A file whose channel send failed is incorporated from `undelivered_files`
  instead.
- Applied and verified targets clear only after the backend has successfully
  persisted that file's reconciled draft row.
- Failed, blocked, cancelled, unprocessed and persistence-failed drafts remain.
- Cancellation counts only files for which a result was produced; unprocessed
  files are not reported as complete.
- A reconciliation or persistence failure can abort later files without losing
  the results already persisted and streamed.
- A stale operation ID is discarded before deep payload validation.

## Live memory model

Normal backend state is:

- selected path strings;
- the current SQLite/ExifTool chunk;
- the current progress batch; and
- compact counters.

Normal frontend state is:

- one incoming bounded progress batch;
- authoritative metadata already needed by the library UI;
- remaining drafts;
- unresolved verification outcomes; and
- compact Apply state and capped diagnostics.

Legitimate O(total files) state remains where it represents the library rather
than duplicated Apply transport data: authoritative occurrence metadata,
remaining draft rows, unresolved verification outcomes and an explicit subset
path list. Apply-all avoids even the frontend subset list by asking SQLite for
all rows belonging to the opened folder.

## Synthetic measurements

Measurements were taken on Manta after commit `26ae4d3`, using Node 24 with
explicit garbage collection and the production parser/store functions. They
are comparative engineering measurements rather than WebView heap guarantees.
Each result below is the average of three repeated runs unless stated
otherwise.

### Draft reconciliation

The test cleared 2,000 persisted draft rows. Before batching, the actual
one-file path took 7,186 ms and sent 2,000 notifications. With the production
default chunk size of 32 it took 335 ms and sent 63 notifications:

| Shape                          |     Time | Notifications |
| ------------------------------ | -------: | ------------: |
| Previous one-file application  | 7,186 ms |         2,000 |
| Chunk size 32                  |   335 ms |            63 |
| Chunk size 100                 |   115 ms |            20 |
| One synthetic 2,000-file chunk |     8 ms |             1 |

The default production shape reduced this test's elapsed time by about 95.3%
and notifications by about 96.9%. A one-file chunk remains superlinear because
the immutable outer snapshot must still be rebuilt; production avoids that
shape by applying the backend chunk as one store mutation.

### Heavyweight file results

The test used 1,202 files, forty occurrences per file and 512-character values.
The previous terminal replay retained a 20.5 MB duplicate result vector and
created another 93.7 MB of transient preparation data, taking 512 ms after all
progress results had already been incorporated.

With streamed chunks of 32:

| Measurement                              |                 Previous |             Streamed |
| ---------------------------------------- | -----------------------: | -------------------: |
| Duplicate/transient Apply transport peak |                 114.2 MB | 1.1 MB maximum chunk |
| Terminal completion allocation           |                 114.2 MB |       about 0.004 MB |
| Terminal completion time                 |                   512 ms |             0.318 ms |
| Compact terminal JSON                    | complete file collection |            244 bytes |

The duplicated transport peak fell by about 99.0%, while terminal allocation
and computation fell by more than 99.9%. Applying all streamed chunks took
about 530 ms in total, but that is now the sole incremental application pass;
the old design performed equivalent progress work and then repeated the whole
collection at terminal completion.

The authoritative occurrence-store heap in this synthetic workload fell from
50.7 MB to 35.2 MB, mainly because parsed occurrence arrays now transfer to the
store instead of being cloned into intermediate and application-summary
collections.
