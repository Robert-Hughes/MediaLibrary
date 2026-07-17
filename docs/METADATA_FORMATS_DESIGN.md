# Metadata formats and editing design

MediaLibrary has one active metadata-edit format: schema-v5 target drafts. A
draft always contains a complete `MetadataDraftTarget` and a semantic
`MetadataDraftEdit`.

## Occurrence concerns and identity layers

Authoritative `MetadataOccurrence` state carries four independent concerns:

1. `MetadataOccurrenceId` identifies one concrete value in one file.
2. Required `schema_id: SchemaDefinitionId` identifies the exact ExifTool
   definition, including the distinction between an absent index and index
   zero. Several occurrences may share it.
3. Nullable `tag_info` supplies registry interpretation and friendly group,
   name and description metadata. When present, `TagInfo.id` must exactly match
   `schema_id`.
4. Nullable `write_target` supplies a proven exact runtime selector.

Friendly labels are presentation and search text only. A missing `TagInfo` does
not mean schema identity is missing, and a schema ID or selector alone does not
make an occurrence writable. Same-schema occurrences remain independent
runtime targets and are never first-selected.

An `ExistingOccurrence` target already snapshots its occurrence ID, schema ID
and runtime `MetadataWriteTarget`; `NewProperty` identifies a deliberate
creation by exact schema ID. Adding schema identity to the transient occurrence
shape therefore requires no target-format migration.

## Transient occurrence format

## Transient occurrence format

Scan and readback payloads use the required shape
`{ id, schema_id, value, tag_info, write_target }`. Unknown local schemas retain
their exact table, tag ID and optional index with null interpretation and write
target. `ImageMetadata` contains only this authoritative occurrence collection.
Schema-oriented read-only consumers derive safe values on demand; no second
schema-keyed scan store or wire field exists.

## Draft and audit persistence

`MediaLibraryTargetDraftEdits.jsonl` is the only draft file read or written.
Its schema-v5 shape and version are unchanged by the transient occurrence
migration.
Each JSONL record retains the full target and edit. Duplicate logical target
slots and malformed entries are rejected before a save can truncate the file.

`MediaLibraryTargetApplyLog.jsonl` is the only apply audit written. Its
schema version and target-aware record shape are unchanged. Audit rows
retain complete targets, semantic values, verification results, and
reconciliation decisions.

The historical files `MediaLibraryDraftEdits.jsonl` and
`MediaLibraryApplyLog.jsonl` are ignored. They are not parsed, migrated,
rewritten, truncated, or deleted.

## Semantic values and edits

`MetadataValue` carries typed values such as text, numbers, rationals, lists,
structures, dates, times, offsets, and date-times. `MetadataDraftEdit` carries
`Set`, `Delete`, `ListAdd`, or `ListRemove` plus optional display text. Display
text is not execution identity and is omitted from JSON when absent.

Redundant `Set` suppression uses semantic equality: sequences are ordered,
bags are unordered, structures ignore object key insertion order, and nested
children are compared completely. Delete and list mutation intents are never
suppressed as redundant.

## Write, verify, and reconcile

The active pipeline is:

1. Validate the persisted target against authoritative occurrences and schema.
2. Render numeric and textual ExifTool argument passes with stable UTF-8
   argfile escaping.
3. Write the file.
4. Read authoritative occurrences again.
5. Verify semantic results, including rational equivalence, floating-point/GPS
   tolerance, list semantics, nested values, dates, times, UTC offsets, and the
   narrow IPTC country-code padding rule.
6. Reconcile each exact target as `Clear`, `Keep`, `Replace`, or `Blocked`.
7. Persist the reconciled target drafts atomically.
8. Append the target-aware audit record.

Clear results require no attention row. Keep, Replace, Blocked, unavailable
readback, missing values, mismatches, coercions, lingering deletes, and
observed nulls retain exact target context for review.

## Search projection

List search receives every authoritative occurrence's exact schema identity,
semantic value, and runtime occurrence coordinates. It also receives every
target draft's exact `target.schema_id` and complete semantic edit. The main
thread resolves friendly group, name, and description labels, and the worker
indexes them alongside exact schema and occurrence fields. This supports
`has:edits`, initial replay, incremental updates, last-draft deletion, retry,
stale-enrichment protection, and reserved paths.

Search is only a text projection. It never selects, replaces, merges, or
mutates targets by schema identity; execution identity stays in
`TargetDraftEditsStore`.

## Removed format

The former schema-keyed apply, cancellation, progress, verification, draft
persistence, and apply-log pipeline has been removed from production. There is
no fallback or migration path.
