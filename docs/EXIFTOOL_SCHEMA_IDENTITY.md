# ExifTool Schema Identity

This document defines how MediaLibrary identifies ExifTool schema definitions.
`SchemaDefinitionId` is the sole metadata identity throughout the application.

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

## ExifTool's exact runtime identity

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

## One identity throughout the application

`SchemaDefinitionId` is retained for registry lookup, scanner results,
raw/pretty pass joining, frontend metadata state, React and JavaScript
collection values, columns and sorting, draft edits, writes, readback
verification, apply outcomes and logs, and Add New Property.

JavaScript uses `schemaDefinitionIdToken(id)` only to make stable keys for
`Map`, object and React collection mechanics. Every collection value retains
the structured ID. The token is not a second metadata identity and is not a
domain-facing API type.

## Friendly labels remain important

`TagInfo.group`, `TagInfo.name` and descriptions remain useful for display,
search, diagnostics, Add New Property discovery and construction of ExifTool
write selectors. They must never be used to recover or guess identity.

## Raw/pretty pass joining

Both ExifTool passes carry `table`, `id` and optional `index`. MediaLibrary
joins them by exact `SchemaDefinitionId`. The original JSON property key is
retained only as diagnostic and display context; it is not the join key.

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

Missing exact schema definitions remain unknown and read-only. MediaLibrary
does not guess a table from Make, Model, file type, enum values or value shape.

Conflicting duplicate runtime IDs must never silently overwrite one another.
LangAlt children are merged deliberately as described above; other duplicate
or conflicting occurrences must be diagnosed or rejected.

## Add New Property

The user searches friendly fields, but every result represents one exact
`TagInfo`. Same-name definitions appear separately with table, ID and index
context, and the user explicitly selects one. Arbitrary free-text properties
cannot be written. Existing-property detection compares exact IDs.

## Persistence and migration

Metadata and drafts cross JSON boundaries as entry arrays containing
`{id, value}` or `{id, edit}`. Struct-valued IDs are not used as JSON object
keys. Draft schema v4 stores exact IDs. Legacy string-key draft schemas cannot
be migrated safely and are rejected. Legacy image-column settings without
exact IDs are reset rather than guessed.

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
- no Family 5 identity extension unless later runtime evidence proves it is
  necessary.
