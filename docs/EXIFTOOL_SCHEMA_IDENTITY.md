# ExifTool Schema Identity

This document defines how MediaLibrary identifies ExifTool schema definitions.
`SchemaDefinitionId` is static schema identity, not the identity of a concrete
runtime field occurrence. The distinction from runtime occurrence identity and
ExifTool write targeting is defined in the
[metadata identity model](METADATA_IDENTITY_MODEL.md).

The sections below describe the exact static schema identity used inside the
active occurrence-targeted editing model.

Automated validation covers exact scan/registry joins, same-name BMP table
collisions, a real-file repeated definition with `index: 0`, draft and column
persistence, worker payloads, exact write selection, and temporary-copy
text/list/LangAlt/GPS/DateTime write-readback. See
[Exact-ID manual validation](EXACT_ID_MANUAL_VALIDATION.md) for UI cases that
remain intentionally manual.

## Five distinct metadata concepts

MediaLibrary keeps the following concepts separate. Similar-looking property
names in diagnostics do not make them interchangeable.

| Concept                                              | What it identifies                                                                             | Source                                                                                          | User-facing?                          | Shared by several occurrences?                                              | Usable for writing?                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Friendly property label                              | A human-readable group/name such as `IFD0:XResolution`                                         | ExifTool group/tag names and `TagInfo`                                                          | Yes: display, search and explanations | Yes                                                                         | No; it is not stable execution identity                                           |
| Runtime tag-ID scope (`RuntimeTagIdScope`)           | The wrapped table, tag ID and optional index associated with the extracted family-7 runtime ID | Wrapped ExifTool JSON                                                                           | Diagnostic only                       | Yes                                                                         | No; it is one component of occurrence identity, not a mutation selector           |
| Schema definition identity (`SchemaDefinitionId`)    | One exact static ExifTool definition used to interpret a semantic value                        | Exact registry resolution, normally from wrapped scope                                          | Diagnostic context                    | Yes                                                                         | For schema-driven New Property only; never to first-select an existing occurrence |
| Runtime occurrence identity (`MetadataOccurrenceId`) | One concrete field/value in one file                                                           | Parsed ExifTool property-key coordinates plus wrapped scope                                     | Diagnostic context                    | No                                                                          | It selects the occurrence to validate, but is not itself ExifTool argv            |
| Writable selector identity (`MetadataWriteTarget`)   | Family 1 + family 7 + canonical tag name used as an ExifTool mutation selector                 | Proven runtime coordinates for existing fields; intended schema-locked coordinates for creation | Shown where useful for diagnostics    | Existing selectors must be unambiguous; intended selectors require readback | Yes, after authoritative validation                                               |

`MetadataOccurrenceId.document` is the family-3 document/sample coordinate,
`path` is the family-5 metadata path, `runtime_tag_id` is the family-7 runtime
ID, `tag_id_scope` is the wrapped table/ID/index scope, and `copy` is the
family-4 copy number. Together they identify a concrete occurrence; none of
those fields may be replaced by a friendly label or schema lookup.

`MetadataWriteTarget` stores `group1 + group7 + tag_name`. For example,
`{ group1: "IFD1", group7: "ID-282", tag_name: "XResolution" }` renders
only at the final write boundary as `1IFD1:7ID-282:XResolution`. ExifTool's
official documentation states that group names may be prefixed with their
family number and that a write tag may contain leading family 0, 1, 2, or 7
groups. See [ExifTool tag operations](https://exiftool.org/exiftool_pod2.html#Tag-operations),
especially the `-TAG` and `-TAG[+-^]=[VALUE]` sections. MediaLibrary qualifies
families 1 and 7 explicitly so an entered destination cannot be interpreted as
another family.

Families 3, 4, and 5 remain extraction-occurrence coordinates. They can
distinguish documents, copies, and physical paths, but this application does
not use them as direct-write coordinates.

## Problem: friendly ExifTool names are not identities

Names such as `IFD0:Orientation`, `File:BMPVersion` and
`Canon:WhiteBalance` are useful human-facing labels, but they are not
guaranteed to identify one ExifTool tag-table definition. Collisions exist for
`Group1:TagName`, and adding the decimal Tag ID still does not make that key
globally unique. A Tag ID is meaningful only within an ExifTool table.

Definitions with the same friendly name can differ in type, writability, enum
values and write destination. For example, `File:BMPVersion` can identify
definitions in both `BMP::Main` and `BMP::OS2`, even though the friendly name
and numeric ID overlap. The table is therefore essential identity, not extra
diagnostic context.

## Investigation evidence

The schema and runtime investigation found:

- 973 conflicting `Group1 + TagName` groups;
- 206 conflicts after adding Tag ID;
- 435 logical runtime occurrences per pass;
- 433 occurrences that matched one static definition directly by exact
  table, ID and index;
- two remaining LangAlt language children that mapped predictably to their
  parent definition;
- no runtime occurrence with multiple exact matches in the fixture set;
- runtime `index` values for repeated definitions; and
- a composite `ThumbnailImage` whose runtime identity exposed its actual
  `Composite` table.

These figures describe the investigation fixture set. They are evidence for
the design, not a claim that every possible ExifTool file format was tested
exhaustively.

## ExifTool's wrapped runtime tag-ID scope

MediaLibrary requests JSON values with table and decimal-ID output:

```text
-j -t -D
```

Each wrapped runtime value has this shape:

```json
{
  "table": "Exif::Main",
  "id": 36867,
  "index": 0,
  "val": "..."
}
```

- `table` is the internal ExifTool tag table that supplied the selected
  definition.
- `id` is the tag's ID within that table. `-D` emits numeric IDs in decimal.
- `index`, when present, selects one of several definitions with the same ID
  in the same table.
- `val` is the value for that occurrence. Its representation depends on the
  other pass flags, including `-n`.

The `{table, id, index?}` tuple is retained as
`MetadataOccurrenceId.tag_id_scope`. It scopes the extracted runtime tag ID,
but it is not automatically the final semantic schema identity.

## Canonical application identity

The Rust identity type is:

```rust
SchemaDefinitionId {
    table: String,
    tag_id: String,
    index: Option<u32>,
}
```

`table` is ExifTool's internal tag-table name. `tag_id` is canonical base-10
text when ExifTool's ID is numeric; non-numeric ExifTool IDs remain strings.
The ID is local to its table and cannot be interpreted without it. `index`
selects one repeated definition within a table. `None` and `Some(0)` are
different identities: omission means the ID is not repeated, while zero is
the first member of a repeated set. Friendly names are deliberately not
stored in the identity.

## Static `-listx` reconstruction

The registry reconstructs the same identity from:

```text
exiftool -listx -f -lang en
```

For each static definition it:

1. removes only the exact `Image::ExifTool::` prefix from the table name;
2. normalises numeric and hexadecimal IDs to canonical base-10 strings;
3. preserves textual IDs;
4. counts repeated IDs within each table in document order;
5. assigns `Some(0)` through `Some(N - 1)` only when a table contains repeated
   definitions for that ID, and otherwise assigns `None`; and
6. rejects duplicate reconstructed `SchemaDefinitionId` values rather than
   overwriting or choosing between them.

## Exact schema identity alongside runtime identity

`SchemaDefinitionId` is retained structurally for registry lookup,
`MetadataOccurrence.schema_id`, frontend occurrence state,
columns and sorting, target snapshots, readback verification, apply outcomes
and logs, and Add New Property. It is always present on an authoritative
`MetadataOccurrence`, even when the local registry has no matching `TagInfo`.

It is not the identity of a concrete runtime field. `MetadataOccurrenceId`
identifies the occurrence using document, metadata path, family-7 runtime tag
ID, wrapped table/ID/index scope, and copy. Several occurrence IDs may share one
schema ID. The occurrence also carries optional resolved `TagInfo` and an
optional exact `MetadataWriteTarget`; these concerns are not interchangeable.
When `TagInfo` exists, its `id` must equal `MetadataOccurrence.schema_id`.
Schema identity alone does not establish writability.

The raw wrapped scope and resolved schema are deliberately both retained:

- `MetadataOccurrenceId.tag_id_scope` records what the runtime wrapper
  supplied for that extracted occurrence;
- `MetadataOccurrence.schema_id` records the authoritative static definition
  used to interpret its semantic value.

They normally agree, but agreement is not an invariant. LangAlt child
extraction is the key exception: a language-specific runtime child retains its
child scope in `tag_id_scope`, while `schema_id` resolves to the exact LangAlt
parent definition. Documentation and diagnostics must not describe
`schema_id` as merely an untouched copy of the wrapped tuple.

Runtime family 7 is not necessarily identical to the static schema tag ID.
The scanner removes exactly one transport-level `ID-` prefix from an observed
family-7 group. Existing targets restore exactly that prefix from
`MetadataOccurrenceId.runtime_tag_id`; they never derive family 7 from the
static schema. Thus runtime `ID-AbC` becomes complete group `ID-ID-AbC`. New
Property has no runtime occurrence, so its schema-controlled family 7 is
derived instead from the exact selected `SchemaDefinitionId.tag_id`. That
schema derivation follows ExifTool's documented family-7 encoding: ASCII
letters, digits, hyphen, and underscore are retained, while every other UTF-8
byte becomes two lowercase hexadecimal digits. For example, `AAPL:Keywords`
becomes `ID-AAPL3aKeywords`, `Creation Time` becomes `ID-Creation20Time`, and
`xid ` becomes `ID-xid20`. See ExifTool's
[`GetGroup` family documentation](https://exiftool.org/ExifTool.html#GetGroup).

JavaScript uses `schemaDefinitionIdToken(id)` only to make stable keys for
`Map`, object and React collection mechanics. Every collection value retains
the structured ID. The token is not a second metadata identity and is not a
domain-facing API type.

## Friendly labels remain important

`TagInfo.group`, `TagInfo.name` and descriptions remain useful for display,
search, diagnostics, Add New Property discovery and construction of ExifTool
write selectors. They must never be used to recover or guess identity.

## Raw/pretty pass joining

Both ExifTool passes carry property-key runtime coordinates and wrapped
`table`, `id` and optional `index`. MediaLibrary parses both sources before
constructing the complete `MetadataOccurrenceId`, then joins raw and display
properties by that ID. The runtime tag name is retained as extraction and
write-target context, but is not part of the join identity.

## LangAlt special case

LangAlt uses one deliberately narrow canonicalisation:

1. Attempt exact registry lookup.
2. Only when it is missing, identify a confirmed language suffix.
3. Strip that suffix while staying in the same table.
4. Look up the exact parent ID.
5. Accept the parent only when its schema kind is `LangAlt`.
6. Merge the language child into the parent's `MetadataValue::LangAlt`.

This is not a general suffix heuristic or a secondary registry index.

## Missing and duplicate identities

Missing exact schema definitions remain unknown and read-only. Their
`MetadataOccurrence.schema_id` still preserves the exact ExifTool table, tag ID
and optional index, while `tag_info` and `write_target` remain null. MediaLibrary
does not guess a table from Make, Model, file type, enum values, value shape,
occurrence path, runtime tag ID or selector coordinates.

Any second property with the same complete runtime ID within one source and
one ExifTool pass is an invariant violation. It is rejected even when its
diagnostic fields and extracted value are identical. The same ID appearing
once in each of the raw and display passes remains the expected join key.
LangAlt children are merged deliberately as described above.

## Add New Property

The user searches friendly fields, but every result represents one exact
`TagInfo`. Same-name definitions appear separately with table, ID and index
context, and the user explicitly selects one. The default target uses family 1
from `info.group`, family 7 from `info.id.tag_id`, and tag name from
`info.name`. Only family 1 is editable.

The editable combobox suggests the schema default first, then applicable
writable schema groups and proven groups observed in the file. Suggestions are
advisory, not an exhaustive or guaranteed list of legal destinations. Unknown
tokens remain enterable when they match `[A-Za-z_#][A-Za-z0-9_#-]*`. Numeric
family prefixes, whitespace, colons, equals signs, controls, and argument
syntax are rejected. The backend repeats this validation and locks family 7
and tag name to the selected schema.

## Draft target variants

`ExistingOccurrence` snapshots the complete `MetadataOccurrenceId`, resolved
`SchemaDefinitionId`, and proven `MetadataWriteTarget`. Apply rereads the file
and revalidates all three before rendering the stored runtime selector. It
does not reconstruct that selector from a friendly label and never uses the
schema ID to choose among same-schema occurrences.

`NewProperty` stores both the exact `SchemaDefinitionId` and a complete intended
`MetadataWriteTarget`. A `MetadataWriteTarget` is the ExifTool selector; it is
not proof that ExifTool will instantiate the exact indexed definition selected
by the user. Apply re-resolves the schema, validates the family-1 destination
and schema-locked family 7/name, writes the stored target, and verifies exact
authoritative readback.

New Property draft slots include both schema and destination. Same-schema
drafts for IFD0 and IFD1 coexist and are presented separately when one ordinary
schema row cannot represent both. An existing proven selector blocks only the
same complete destination; another proven same-schema destination does not.
Because an occurrence without `write_target` has no proven free destination, a
same-schema unresolved occurrence conservatively blocks creation.

## Wire formats and persistence

Transient scan and readback occurrences cross the Rust/TypeScript boundary as
`{ id, schema_id, value, tag_info, write_target }`. `schema_id` is required;
`tag_info` and `write_target` are nullable. A present `TagInfo.id` must exactly
match `schema_id`.

Target drafts continue to persist a complete `ExistingOccurrence` or
`NewProperty { schema_id, write_target }` beside the semantic edit. New Property
group 1 is therefore preserved across persistence and reopening. The v5 shape
is updated in place while draft `schema_version` remains 5; no compatibility
reader or migration is provided. Apply-log
schema version and identity marker remain unchanged, and existing append-only
rows are never rewritten. Struct-valued IDs are never JSON object keys.
Historical draft files are ignored rather than parsed or migrated.

## Derived schema-oriented views

`ImageMetadata` now carries only authoritative `occurrences`; the scanner no
longer emits or stores a schema-keyed metadata projection. Schema-oriented UI
and generated-workflow consumers derive a fresh read-only view from occurrences
when needed. The derivation groups by `MetadataOccurrence.schema_id`,
conservatively collapses identical ordinary values, merges compatible LangAlt
values, and omits conflicts without affecting authoritative occurrence state.
Schema presence is resolved separately from value representability, so an
ambiguous value remains known to exist without selecting an arbitrary
occurrence. Derived views are never retained as a second store and must never be
used to choose a runtime target.

## Rejected approaches

MediaLibrary deliberately has:

- no `Group1:TagName` registry lookup;
- no secondary friendly-name identity index;
- no candidate scoring;
- no `definition_score`;
- no `SchemaResolution`;
- no Make/Model inference;
- no file-type inference;
- no enum or value-shape inference;
- no “prefer writable candidate” fallback; and
- no friendly tag-name contribution to occurrence identity.

## Search indexing

Every authoritative occurrence crosses the search-worker boundary with its
structured exact `SchemaDefinitionId`, semantic value, and complete runtime
`MetadataOccurrenceId`. Draft entries carry their exact target schema and
semantic edit. Before posting either stream, the main thread resolves `TagInfo`
through the existing exact-ID cache and sends only the searchable label subset:
group, name, and description.

The worker indexes all same-schema occurrences independently, including runtime
document, path, family-7 tag ID, wrapped table/tag-ID/index scope, and copy,
while labels remain presentation text rather than identity. Exact interpreted
schema fields and a readable diagnostic form remain searchable when registry
interpretation is missing. Internal JSON tokens used for JavaScript map keys
are not user-facing searchable text.
