# Metadata pipeline

MediaLibrary has one target-aware, occurrence-based metadata-edit pipeline from
scan through audit. The canonical identity definitions and target-first rule
are in the [metadata identity model](METADATA_IDENTITY_MODEL.md).

## Scan and presentation

The scanner returns authoritative `MetadataOccurrence` values containing the
runtime occurrence ID, exact schema ID, semantic value, optional resolved tag
information, optional observed selector and optional proven write target.
Malformed relationships are rejected rather than repaired. Unknown schemas
remain visible and diagnosable but read-only.

`ImageMetadata` contains only authoritative occurrences. List, Details Pane,
GPS, normalisation, overwrite, column and sorting consumers derive safe
schema-oriented read-only views on demand. Conflicting same-schema values remain
unavailable without affecting exact occurrence visibility.

Details Pane rows show exact pending target values and reopen editors from
staged semantic values. Editors construct complete ExistingOccurrence or New
Property targets before staging. A schema may select an editor, but mutations
carry the complete target. Stale, ambiguous and read-only inputs fail without
partial mutation or same-schema redirection.

New Property value editing and destination editing are separate operations.
Value editing preserves the exact stored target, including a custom GPS
destination. Destination editing performs one atomic exact-target move. Pending
verification blocks both operations until the outcome is resolved.

## Draft state and persistence

One `TargetDraftEditsStore` owns frontend drafts. Loading
`MediaLibraryTargetDraftEdits.jsonl` is strict: a failure blocks draft mutation
and apply for that folder and does not fall back. Autosave serialises only
complete target entries using persisted draft schema version 5.

The historical `MediaLibraryDraftEdits.jsonl` file is ignored, not migrated,
and never touched.

## Apply controller and backend

The frontend invokes `apply_metadata_draft_edits_cmd`, listens for
`apply_edits_started` and `apply_metadata_edits_progress`, and cancels through
`cancel_apply_edits`. `TargetApplyController` owns listener lifetime, progress,
cancellation races, autosave suspension and authoritative result parsing.

For each requested file, the backend:

1. loads and validates complete target drafts;
2. validates exact writable occurrences or deliberate creations;
3. separates numeric and textual ExifTool passes;
4. writes a deterministic escaped UTF-8 argument file;
5. re-reads authoritative occurrences;
6. verifies each semantic edit against the complete intended target;
7. reconciles exact targets as Clear, Keep, Replace or Blocked;
8. persists the reconciled target map; and
9. appends a target-aware audit record.

Successful files update authoritative frontend metadata incrementally. Failed
files retain drafts. Verification rows retain their complete target and allow
accepting current file state, keeping the draft, or discarding the exact pending
draft where safe.

New Property verification succeeds only for exactly one occurrence matching
the intended exact schema and selector. Changed index, redirected destination,
missing or duplicate result, silent ignore, and semantic mismatch preserve the
draft. ExistingOccurrence apply validates the full occurrence, schema and
write-target snapshot; it never locates an owner by schema.

`MediaLibraryTargetApplyLog.jsonl` is the only active apply audit. The
historical `MediaLibraryApplyLog.jsonl` is ignored and left unchanged.

## Generated workflows

Describe, reverse-geocode and normalise jobs return transient
`SchemaMetadataEdit` values. The planner resolves each suggestion before a
target exists: it requires a unique existing occurrence, rejects multiplicity,
or deliberately creates a New Property target when a valid destination is
known. Once planned, only an exact matching target owner can be changed;
same-schema siblings are unrelated.

## Search projection

The search worker receives authoritative occurrence fields, complete target
drafts, semantic values and friendly labels. Initial snapshots, incremental
changes, last-draft deletion, retries, stale-result protection and reserved
paths are supported. Search never owns execution identity.
