# Metadata identity model

MediaLibrary separates human-readable metadata names, static ExifTool schema
definitions, concrete fields found in a file, observed selector occupancy,
writable selectors, and draft operations. These concepts often contain similar
text, but they answer different questions and are never interchangeable.

## Which identity should I use?

| Need                                    | Correct concept            |
| --------------------------------------- | -------------------------- |
| Display, search and explanation         | Friendly property label    |
| Registry lookup and semantic definition | `SchemaDefinitionId`       |
| One concrete field in a file            | `MetadataOccurrenceId`     |
| Raw runtime tag-ID namespace            | `RuntimeTagIdScope`        |
| Determine selector occupancy            | `MetadataObservedSelector` |
| Construct an ExifTool write             | `MetadataWriteTarget`      |
| Persist an existing or new operation    | `MetadataDraftTarget`      |
| Represent unresolved generated output   | `SchemaMetadataEdit`       |

Friendly labels such as `IFD0:XResolution`, `File:BMPVersion`, descriptions,
and `TagInfo.group`/`TagInfo.name` are presentation. They are useful for rows,
search, diagnostics and property discovery, but are never identity or a write
selector. For example, `File:BMPVersion` can refer to definitions in both
`BMP::Main` and `BMP::OS2`; the same label and numeric tag ID do not make those
definitions equal.

## Static schema identity

`SchemaDefinitionId { table, tag_id, index? }` identifies one static ExifTool
definition. The table is essential because a tag ID is local to its table.
Numeric IDs are canonical base-10 text and textual IDs remain strings.

An absent index and index zero are different identities. Absence means that the
ID is not repeated in its table; `index: 0` selects the first definition in a
repeated set. The registry reconstructs this distinction from `exiftool -listx`
and rejects duplicate reconstructed IDs.

Schema identity is appropriate for registry lookup, Add Property selection,
columns, sorting, schema-oriented read-only projections, and generated output
that has not yet been assigned a target. It does not identify a concrete field:
several occurrences may share one schema. IFD0 and IFD1 XResolution fields are
typical same-schema siblings and must remain independently targetable.

## Runtime occurrence identity

`MetadataOccurrenceId` identifies one concrete field within one file:

```text
family-3 document/sample
+ family-5 metadata path
+ family-7 runtime tag ID
+ RuntimeTagIdScope { table, tag_id, index? }
+ family-4 copy
```

Occurrence IDs are scoped to the file whose authoritative scan contains them.
Every attempted duplicate complete ID within one ExifTool pass is rejected,
even when the values are equal. The same ID in the raw and display passes is
expected because it is their join key.

The wrapped `RuntimeTagIdScope` and `MetadataOccurrence.schema_id` are both
required. The former namespaces the extracted family-7 runtime ID; the latter
is the authoritative static definition used to interpret the semantic value.
They usually agree, but agreement is not an invariant. A LangAlt language child
retains its child runtime scope while `schema_id` resolves, through the narrow
confirmed LangAlt rule, to the parent definition. This is not a general suffix
heuristic.

The distinction also protects real IPTC collisions. Within one IPTC block,
`EnvelopeRecordVersion` and `ApplicationRecordVersion` may share family-7 ID
`0`, wrapped ID `0`, and the same family-5 path, while their wrapped tables are
`IPTC::EnvelopeRecord` and `IPTC::ApplicationRecord`. The complete scope keeps
them distinct.

An authoritative `MetadataOccurrence` therefore carries:

- the complete runtime `id`;
- the required exact `schema_id`;
- its semantic `value`;
- optional resolved `tag_info` for interpretation and presentation;
- optional `observed_selector`; and
- optional proven `write_target`.

When `tag_info` exists, `tag_info.id` must equal `schema_id`. Unknown registry
definitions retain their exact schema and occurrence IDs but have null
interpretation and write target, so they remain visible and read-only.

## Occurrence-first Details presentation

Every existing metadata row in the Details pane represents exactly one
authoritative `MetadataOccurrence`. Equal values and a shared
`SchemaDefinitionId` do not merge rows: IFD0 and IFD1 siblings, repeated copies
and document/path variants remain independently visible and actionable.

The row's friendly group is presentation, not identity. Existing occurrences
use `observed_selector.group1`, then `tag_info.group`, then an explicit fallback
based on `schema_id.table`. Pending New Property rows use their stored
`write_target.group1`, so a custom destination appears in its custom group
rather than the schema's default group. OS Metadata remains a separate
read-only section.

Friendly labels prefer `TagInfo.name`, then the observed selector's tag name,
then schema diagnostics. A compact origin qualifier is shown only when needed
to distinguish otherwise identical labels or expose unusual path, document or
copy information. The tooltip and search text retain the complete schema,
occurrence, observed-selector and write-target diagnostics.

The presentation model has three row kinds:

- `ExistingOccurrenceRow` retains the complete occurrence, its exact
  targetability result and any exactly owned draft;
- `NewPropertyRow` retains the complete intended target, destination and
  semantic edit; and
- `MissingOccurrenceDraftRow` retains a stored ExistingOccurrence operation
  whose authoritative occurrence is missing or unsafe to select.

An ExistingOccurrence draft overlays a row only when the complete occurrence ID
is unique, the current occurrence is exactly targetable and the complete stored
target equals the current target snapshot. A stale snapshot remains visible as
status on the current occurrence row but its staged value is not presented as
current and it is never redirected. Missing and duplicate occurrence targets
are shown as target-only warning rows. Safe exact discard remains available.

New Property rows are intended destinations, not claims that an occurrence
already exists. Same-schema destinations remain separate rows. Occupied or
otherwise unsafe destinations stay visible with status and never convert into
an ExistingOccurrence target.

Group removal and discard use the complete targets owned by the unfiltered
friendly group. Search affects visibility only. Exact target planning means a
group action cannot widen from IFD0 to IFD1 merely because both occurrences
share one schema, and a custom New Property destination belongs to its displayed
custom group.

## Observed selectors and write targets

`MetadataObservedSelector { group1, group7, tag_name }` records that a complete
selector is occupied in the file. `MetadataWriteTarget` has the same structured
shape but additionally represents a selector proven safe for an independent
write. An observed selector does not prove writability, and a null write target
does not prove that a destination is free.

For an existing occurrence, a non-null write target requires an exactly equal
observed selector. Occupancy comparison is a separate operation: family 1 and
tag name compare case-insensitively, while family 7 remains case-sensitive.
Only at the final write boundary does a target render as, for example,
`1IFD1:7ID-282:XResolution`.

Runtime family 7 must not be derived from static schema identity. Existing
targets restore it from the occurrence's runtime tag ID. New Property has no
runtime occurrence, so its schema-controlled family 7 is deliberately derived
from the selected schema tag ID using ExifTool's encoding: ASCII letters,
digits, hyphen and underscore remain, and every other UTF-8 byte becomes two
lowercase hexadecimal digits. Thus `AAPL:Keywords` becomes
`ID-AAPL3aKeywords`. This family-7 derivation boundary is why runtime and schema
identity remain separate.

## Draft target identity

`MetadataDraftTarget` persists one exact operation:

- `ExistingOccurrence` stores the complete occurrence ID, schema snapshot and
  proven runtime write-target snapshot.
- `NewProperty` stores the selected schema ID and complete intended write
  destination.

New Property identity includes its destination because the schema alone cannot
identify a creation slot. Two drafts for the same schema at IFD0 and IFD1, or
at a default and custom family-1 destination, can coexist. Editing, replacing
or discarding one must leave the sibling untouched. Destination editing is one
atomic exact-target mutation: delete the original target and upsert the
replacement with the unchanged semantic edit.

Logical target slots preserve complete occurrence identity,
ExistingOccurrence/NewProperty separation, same-schema destinations, and
absent-index/index-zero separation. A slot token is collection mechanics, not
a second domain identity; the stored value always retains the complete target
snapshot.

## The target-first rule

Once a `MetadataDraftTarget` exists, every edit, replacement, discard,
verification, apply, retry and reconciliation operation begins with that
complete target. It uses complete target equality, the exact logical slot, the
occurrence snapshot where applicable, and the target's stored write
destination. A schema may choose which editor to display, but must not choose
which existing target is mutated.

Schema-based resolution is allowed only before a target exists, including:

- selecting an Add Property schema definition;
- resolving a `SchemaMetadataEdit` produced by a generated workflow;
- deriving schema-oriented read-only display, search, column or sort data; and
- resolving a user request to remove a named schema into zero, one or several
  explicit occurrences and targets.

It is prohibited after target construction. Code must not extract
`target.schema_id`, find a schema owner, reconstruct a target from whichever
occurrence currently matches, redirect a GPS member through a composite
planner, or first-select one same-schema sibling. If an opened target changes
or disappears, saving fails safely rather than redirecting to another target.

Apply re-reads authoritative state and validates the complete stored target.
A changed occurrence ID, selector, schema snapshot, or same-schema replacement
is stale and cannot silently stand in for the intended operation.

## Generated metadata boundary

`SchemaMetadataEdit { schema_id, edit }` is transient generated-workflow
output. It is intentionally schema-addressed because no concrete target exists
yet. Planning must obtain a unique existing occurrence explicitly and reject
multiple occurrences. When the schema is absent, it creates a deliberate New
Property target only when a valid destination is known.

After planning that complete target, an existing draft owner is relevant only
when its exact target matches. Same-schema owners at other occurrences or
destinations are unrelated and remain untouched. The resulting persisted
entry is `MetadataTargetDraftEntry { target, edit }`.

## Persistence and lifecycle

`TargetDraftEditsStore` owns frontend drafts and mutates them by exact target.
The sole active draft file is `MediaLibraryTargetDraftEdits.jsonl`. Each JSONL
record retains complete target entries and uses persisted `schema_version: 5`.
Duplicate relative paths, duplicate logical target slots, malformed entries,
and unsupported versions are rejected before unsafe mutation or truncation.
Valid version-5 files continue to load; there is no old-shape compatibility
reader or migration.

Applying validates the target, writes through ExifTool, re-reads authoritative
occurrences, verifies the semantic result, reconciles the exact target as
Clear, Keep, Replace or Blocked, persists the result, and appends to
`MediaLibraryTargetApplyLog.jsonl`. Existing apply-log rows are append-only and
are not rewritten.

The historical `MediaLibraryDraftEdits.jsonl` and
`MediaLibraryApplyLog.jsonl` files are ignored and left byte-for-byte
untouched. They are not parsed, migrated, rewritten, truncated or deleted.

## Read-only projections and search

`ImageMetadata` stores authoritative occurrences only. Deliberate
schema-oriented views are derived on demand for consumers such as columns,
sorting, generated workflows and composite semantic editors: identical values
may collapse, compatible LangAlt values may merge, and conflicts remain
unavailable without selecting an arbitrary occurrence. Those projections do
not own Details-row identity. Search indexes structured schema and occurrence
fields, statuses, stored targets, semantic values and friendly labels, but
never owns or mutates identity.

## Rejected heuristics and fallbacks

MediaLibrary has no friendly-name identity index, `Group1:TagName` registry
lookup, candidate scoring, Make/Model or file-type inference, enum/value-shape
inference, writable-candidate preference, schema-owner first selection, GPS
retargeting fallback, or selector-to-schema guessing. BMP same-name collisions,
IPTC runtime collisions, family-7 runtime/schema differences, custom New
Property destinations, IFD0/IFD1 siblings, and absent index versus index zero
are all handled by retaining the explicit identities described above.
