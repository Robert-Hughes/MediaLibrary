# Metadata identity model

Metadata editing is occurrence-aware. The model keeps display names, schema
definitions, and runtime occurrences separate because they answer different
questions.

## Friendly identity

ExifTool group/name strings and descriptions are for people. They label rows,
editors, column choices, diagnostics, and search results. They are not stable
write selectors and never collapse two targets.

## Schema identity

`SchemaDefinitionId { table, tag_id, index? }` identifies a schema definition.
Exact comparison includes the optional index, so an omitted index is distinct
from index zero. A schema ID is suitable for choosing a New Property definition
and for text search, but not for choosing among existing occurrences.

## Occurrence identity

`MetadataOccurrenceId { document, path, tag_id, copy }` identifies one concrete
runtime occurrence. Scanner output retains this ID, its semantic value,
resolved `TagInfo`, and its exact runtime write selector.

An existing occurrence can be edited only when it has:

- an unambiguous occurrence ID;
- exact writable schema information; and
- an exact runtime `MetadataWriteTarget`.

Unknown-schema, read-only, selector-less, duplicated, or otherwise ambiguous
occurrences remain visible but cannot be mutated.

## Draft target identity

`MetadataDraftTarget` has two variants:

- `ExistingOccurrence` stores the complete occurrence ID, schema snapshot, and
  runtime write-target snapshot.
- `NewProperty` stores the exact schema ID for a deliberate creation.

Logical slots preserve IFD0/IFD1 siblings, same-schema occurrences,
ExistingOccurrence/NewProperty separation, and absent-index/index-zero
separation. Reconciliation may replace a NewProperty target with the exact
occurrence created by the write, without losing the operation's identity.

## Persistence and lifecycle

The production store is `TargetDraftEditsStore`. It validates complete target
equality, snapshots inputs immutably, applies batches atomically, and emits at
most one notification for a changed batch. The sole persistence file is
`MediaLibraryTargetDraftEdits.jsonl`.

Applying a draft validates identity, writes through ExifTool, reads
authoritative occurrences, verifies semantic intent, reconciles the exact
target, persists the result, and appends to
`MediaLibraryTargetApplyLog.jsonl`.

The historical `MediaLibraryDraftEdits.jsonl` and
`MediaLibraryApplyLog.jsonl` files are ignored and left byte-for-byte
untouched. Their schema-keyed editing and verification model is not active and
is not migrated.

## Search does not own identity

Search indexes `target.schema_id`, friendly labels, descriptions, and the
complete draft edit's displayable value. This is a read-only text projection.
Search updates never use schema equality to select or mutate a target; all
mutation stays exact-target based.
