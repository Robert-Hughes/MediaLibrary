# Metadata formats and editing design

MediaLibrary has one active metadata-edit format: schema-v5 target drafts. A
draft always contains a complete `MetadataDraftTarget` and a semantic
`MetadataDraftEdit`.

## Identity layers

Metadata uses three deliberately different identities:

- Friendly labels (`group`, `name`, and description) are presentation and
  search text only.
- `SchemaDefinitionId` identifies the ExifTool schema definition, including
  the distinction between an absent index and index zero.
- `MetadataOccurrenceId` identifies one concrete value in one file. An
  `ExistingOccurrence` target also snapshots its schema ID and runtime
  `MetadataWriteTarget`; `NewProperty` identifies a deliberate creation by
  exact schema ID.

Schema identity is never sufficient to select an existing value when several
occurrences share a definition. Same-schema occurrences remain independent
targets.

## Draft and audit persistence

`MediaLibraryTargetDraftEdits.jsonl` is the only draft file read or written.
Each JSONL record retains the full target and edit. Duplicate logical target
slots and malformed entries are rejected before a save can truncate the file.

`MediaLibraryTargetApplyLog.jsonl` is the only apply audit written. Audit rows
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

List search receives every target draft's exact `target.schema_id` and complete
semantic edit. The main thread resolves friendly group, name, and description
labels, and the worker indexes those labels together with the exact schema and
staged value. This supports `has:edits`, initial replay, incremental updates,
last-draft deletion, retry, stale-enrichment protection, and reserved paths.

Search is only a text projection. It never selects, replaces, merges, or
mutates targets by schema identity; execution identity stays in
`TargetDraftEditsStore`.

## Removed format

The former schema-keyed apply, cancellation, progress, verification, draft
persistence, and apply-log pipeline has been removed from production. There is
no fallback or migration path.
