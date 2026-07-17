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
5. `MetadataWriteTarget { group1, group7, tag_name }` is the structured
   ExifTool write selector. It is nullable on occurrences because existing
   occurrences require proof, and required on New Property drafts because they
   carry an intended destination.

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
`NewProperty` identifies a deliberate creation by exact schema ID and complete
intended selector because no runtime occurrence exists yet. A
`MetadataWriteTarget` is the ExifTool selector; it is not proof that ExifTool
will instantiate the exact indexed definition selected by the user. Exact
schema identity remains alongside the selector for post-write verification.

Runtime family 7 is not necessarily identical to the static schema tag ID.
Existing occurrence targets derive the complete `ID-...` group from observed
`runtime_tag_id`; New Property derives it from the selected static tag ID using
ExifTool's family-7 byte encoding (ASCII letters, digits, hyphen, and underscore
are retained; every other UTF-8 byte becomes two lowercase hexadecimal digits).
See [`GetGroup`](https://exiftool.org/ExifTool.html#GetGroup). Only New Property
family 1 may be overridden. Family 7 and canonical tag name remain
schema-controlled.

## Transient occurrence format

Scan and readback payloads use the required shape
`{ id, schema_id, value, tag_info, write_target }`. Unknown local schemas retain
their exact table, tag ID and optional index with null interpretation and write
target. `ImageMetadata` contains only this authoritative occurrence collection.
Schema-oriented read-only consumers derive safe values on demand; no second
schema-keyed scan store or wire field exists.

## Draft and audit persistence

`MediaLibraryTargetDraftEdits.jsonl` is the only draft file read or written.
Its New Property target shape is updated in place to include `write_target`
while `schema_version` remains 5. There is no old-shape compatibility reader or
migration. New Property logical slots contain both exact schema and exact
destination, so same-schema IFD0 and IFD1 drafts do not overwrite one another.
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

1. Validate the persisted target against authoritative occurrences and schema,
   including the family-1 grammar and schema-locked family 7/tag name.
2. Render `1<group1>:7<group7>:<tag_name>` only at the final write boundary,
   then produce numeric and textual ExifTool argument passes with stable UTF-8
   argfile escaping.
3. Write the file.
4. Read authoritative occurrences again.
5. For New Property, require exactly one readback match for exact schema,
   family 1, runtime family 7, and tag name; then verify semantic results,
   including rational equivalence, floating-point/GPS tolerance, list
   semantics, nested values, dates, times, UTC offsets, and the narrow IPTC
   country-code padding rule.
6. Reconcile each exact target as `Clear`, `Keep`, `Replace`, or `Blocked`.
7. Persist the reconciled target drafts atomically.
8. Append the target-aware audit record.

Clear results require no attention row. Keep, Replace, Blocked, unavailable
readback, missing values, mismatches, coercions, lingering deletes, and
observed nulls retain exact target context for review.

Selector occupancy and planned-write collision keys compare family 1, family 7,
and tag name case-insensitively. A proven same-schema occurrence at a different
selector is allowed. A same-schema occurrence with no exact target blocks
creation conservatively because absence of proof is not proof that a
destination is free. Families 3, 4, and 5 remain extraction identity rather
than supported direct-write coordinates.

The numeric family qualification follows ExifTool's official
[tag-operations documentation](https://exiftool.org/exiftool_pod2.html#Tag-operations),
which describes family-number prefixes and permits family 1 and 7 groups in
write tags.

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
