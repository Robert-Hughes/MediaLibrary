# Metadata pipeline

MediaLibrary has one production metadata-edit pipeline. It is schema-v5,
target-aware, and occurrence-based from draft creation through audit.

## Scan and presentation

The scanner returns authoritative `MetadataOccurrence` values. Compatibility
metadata may still support read-only consumers, but editing decisions use exact
occurrences. Details Pane rows show exact pending target values, reopen editors
from staged semantic values, and keep same-schema siblings separate.

Manual row editing, New Property, GPS editing, removal, AI description,
reverse geocoding, and normalisation all resolve their generated edits to
`ExistingOccurrence` or `NewProperty` targets before staging. Ambiguous and
read-only inputs fail without partial mutation.

## Draft state and persistence

One `TargetDraftEditsStore` owns frontend metadata drafts. Loading
`MediaLibraryTargetDraftEdits.jsonl` is strict: a load failure leaves the folder
in a blocked persistence state, disables metadata-draft mutation and apply, and
does not fall back. Opening another valid folder creates a safe fresh state.

Autosave serialises only complete target entries. The historical
`MediaLibraryDraftEdits.jsonl` file is ignored, not migrated, and never touched.

## Apply controller and backend

The frontend invokes only `apply_metadata_draft_edits_v5_cmd`, listens only for
the v5 started/progress contracts, and cancels only through
`cancel_apply_edits_v5`. `TargetApplyControllerV5` owns listener lifetime,
progress, cancellation races, autosave suppression, and authoritative result
parsing.

For each requested file, the backend:

1. loads and validates complete target drafts;
2. resolves exact writable occurrences or deliberate creations;
3. separates numeric and textual ExifTool passes;
4. writes a deterministic escaped UTF-8 argfile;
5. rereads authoritative metadata occurrences;
6. verifies each semantic edit;
7. reconciles exact targets as Clear, Keep, Replace, or Blocked;
8. persists the reconciled target map; and
9. appends a target-aware audit record.

Successful files update authoritative frontend metadata incrementally. Failed
files retain drafts. Warnings are shown but are not failures. Verification rows
that need attention retain their complete target and allow accepting current
file state, keeping the draft, or discarding the pending draft where safe.

`MediaLibraryTargetApplyLog.jsonl` is the only active apply audit. The
historical `MediaLibraryApplyLog.jsonl` is ignored and left unchanged.

## Search projection

The list-search worker receives full target-draft search entries: exact schema
ID plus complete semantic edit. Resolved group, name, and description labels
enrich the indexed text. Initial snapshots, incremental changes, deletion of a
path's last draft, retries, stale-result protection, and reserved property-like
paths are supported.

This projection supports exact schema, friendly label, description, staged
value, and `has:edits` queries. It is not an execution adapter and never merges
or selects targets by schema.

## Removed pipeline

The unversioned schema-keyed draft loader/saver, apply and cancel commands,
progress events, verification dialog, outcome reducer, batch orchestration, and
historical apply-log writer have been removed. Production contains no fallback
or conversion branch for that pipeline.
