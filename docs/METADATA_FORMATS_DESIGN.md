# Metadata formats and editing design

MediaLibrary has one active metadata-edit format: schema-v5 target drafts. A
draft always contains a complete `MetadataDraftTarget` and a semantic
`MetadataDraftEdit`.

## Occurrence concerns and identity layers

The editing model distinguishes five concepts:

1. A friendly property label (`TagInfo.group` plus `TagInfo.name`) is human
   display, search and explanation text, not execution identity.
2. `RuntimeTagIdScope` retains the wrapped table, tag ID and optional index
   associated with the family-7 runtime ID. It is part of occurrence identity,
   not necessarily the resolved semantic definition.
3. Required `schema_id: SchemaDefinitionId` identifies one exact static
   ExifTool definition, including absent index versus index zero. Several
   occurrences may share it, so it must not first-select an occurrence.
4. `MetadataOccurrenceId` identifies one concrete value using family-3
   document/sample, family-5 metadata path, family-7 runtime ID, wrapped scope,
   and family-4 copy.
5. Nullable `write_target: MetadataWriteTarget` is a separately proven runtime
   mutation selector, not schema identity and not a reconstruction from the
   friendly label.

Nullable `tag_info` supplies registry interpretation, friendly labels and
description metadata. When present, `TagInfo.id` must exactly match
`schema_id`.

Friendly labels are presentation and search text only. A missing `TagInfo` does
not mean schema identity is missing, and a schema ID or selector alone does not
make an occurrence writable. Same-schema occurrences remain independent
runtime targets and are never first-selected.

The wrapped runtime scope is not a replacement for `schema_id`. It namespaces
the runtime tag ID, while `schema_id` remains authoritative interpretation and
may resolve to a different LangAlt parent. In that case the child runtime tuple
remains in `occurrence.id.tag_id_scope` and the parent definition is stored in
`occurrence.schema_id`.

An `ExistingOccurrence` target snapshots its occurrence ID, schema ID and
runtime `MetadataWriteTarget`, then revalidates all three before apply.
`NewProperty` identifies a deliberate creation by exact schema ID because no
runtime occurrence exists yet. Its same-schema/multiple-destination semantics
are deliberately deferred to a separate design decision and are not changed
here. Adding schema identity to the transient occurrence shape therefore
requires no target-format migration.

## Transient occurrence format

Scan and readback payloads use the required shape
`{ id, schema_id, value, tag_info, write_target }`. Unknown local schemas retain
their exact table, tag ID and optional index with null interpretation and write
target. `ImageMetadata` contains only this authoritative occurrence collection.
Schema-oriented read-only consumers derive safe values on demand; no second
schema-keyed scan store or wire field exists.

## Draft and audit persistence

`MediaLibraryTargetDraftEdits.jsonl` is the only draft file read or written.
Its occurrence object is updated in place with the new required identity fields
while `schema_version` remains 5. There is no old-shape compatibility reader or
migration.
Each JSONL record retains the full target and edit. Duplicate logical target
slots and malformed entries are rejected before a save can truncate the file.

`MediaLibraryTargetApplyLog.jsonl` is the only apply audit written. Its schema
version and identity-model marker are unchanged. Newly appended rows naturally
carry the complete occurrence ID; existing append-only rows are not rewritten.
Audit rows retain complete targets, semantic values, verification results, and
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
