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

## Authoritative occurrence state

Every scanner result keeps four independent concerns:

1. `MetadataOccurrenceId { document, path, runtime_tag_id, tag_id_scope,
copy }` identifies one concrete runtime occurrence. `tag_id_scope` is the
   wrapped `{ table, tag_id, index? }` discriminator that namespaces the
   family-7 runtime ID.
2. `MetadataOccurrence.schema_id` always stores the exact
   `SchemaDefinitionId { table, tag_id, index? }` reported by ExifTool. Several
   runtime occurrences may share it.
3. `MetadataOccurrence.tag_info` is optional resolved registry interpretation
   and presentation metadata. When present, `TagInfo.id` must exactly equal the
   occurrence's `schema_id`; a mismatch is rejected rather than repaired.
4. `MetadataOccurrence.write_target` is an optional proven exact runtime write
   selector.

Runtime occurrence identity and schema identity are deliberately separate. The
raw wrapped scope resembles a `SchemaDefinitionId`, and can be converted to its
structurally equivalent raw discriminator, but it is not the occurrence's
authoritative interpretation identity. LangAlt child extraction retains its raw
child scope while `MetadataOccurrence.schema_id` may resolve to the confirmed
canonical parent. Neither friendly labels, runtime tag names nor selector
coordinates may be used to infer either identity.

The full runtime occurrence identity is:

```text
family-3 document/sample
+ family-5 metadata path
+ family-7 runtime tag ID
+ wrapped table/tag-ID/optional-index scope
+ family-4 copy
```

The wrapped discriminator is required because real IPTC-IIM JPEGs can expose
both `EnvelopeRecordVersion` and `ApplicationRecordVersion`. Both occupy the
family-5 path `JPEG-APP13-Photoshop-IPTC`, both have family-7 ID `0`, and both
have wrapped ID `0`, but their wrapped tables are respectively
`IPTC::EnvelopeRecord` and `IPTC::ApplicationRecord`. Family 5 stops at the
shared IPTC block, so it cannot distinguish those records. The runtime tag name
is extraction and write-target information, not occurrence identity.

Within one ExifTool pass, conflicting duplicates of the complete occurrence ID
are rejected. Completely identical duplicates remain diagnosed and
deduplicated temporarily; this policy will be tightened after validation
against real files.

An existing occurrence can be edited only when it has an unambiguous occurrence
ID, matching resolved writable and supported `TagInfo`, and an exact
`MetadataWriteTarget`. Schema identity alone never proves writability.

An occurrence absent from the local registry still retains its exact
`schema_id`, with `tag_info: null` and `write_target: null`. It remains visible,
distinguishable and diagnosable, but read-only. Duplicated or otherwise
ambiguous occurrences also remain unavailable to mutation without selecting an
arbitrary representative.

`ImageMetadata` now stores only authoritative occurrences. Schema-oriented
read-only consumers derive a safe value view on demand from
`occurrence.schema_id`; identical values may collapse, compatible LangAlt values
may merge, and conflicts remain unavailable without selecting an occurrence.
Schema presence is tracked separately from value representability, and no
schema-keyed scan store or wire field remains.

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

Search indexes `target.schema_id`, every structured occurrence-ID component,
friendly labels, descriptions, and the complete draft edit's displayable value.
This is a read-only text projection.
Search updates never use schema equality to select or mutate a target; all
mutation stays exact-target based.
