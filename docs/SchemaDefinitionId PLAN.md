Implement the new ExifTool schema-identity design throughout the MediaLibrary repository.

This is a production implementation task, not another investigation.

Work from the current branch and first read the repository’s contributor/agent instructions. Preserve unrelated changes and pre-existing untracked investigation files.

## Goal

Replace the existing `Group1:TagName` metadata identity with one canonical identity used throughout the application:

```rust
SchemaDefinitionId {
    table,
    tag_id,
    index,
}
```

ExifTool 13.57 exposes these fields for runtime tags when invoked with:

```text
-j -t -D
```

The same identity can be reconstructed from `exiftool -listx -f -lang en`.

The key architectural rule is:

> Every metadata property in MediaLibrary is identified only by `SchemaDefinitionId`.

There must not be separate concepts of:

```text
application key
schema key
tag key
Group1:TagName key
runtime key
```

Friendly names such as `IFD0:Orientation` remain useful for display, searching and constructing ExifTool write arguments, but they are not identifiers.

## Non-negotiable design constraints

1. `SchemaDefinitionId` is the only metadata identity type.
2. `TagRegistry` has one lookup map keyed by `SchemaDefinitionId`.
3. Do not add a secondary registry index keyed by `Group1:TagName`.
4. Do not retain `definition_score()` or any winner-selection logic.
5. Do not introduce `SchemaResolution`, candidate scoring, compatibility merging or ambiguity heuristics.
6. A lookup is simply present or absent:

   ```rust
   Option<&TagInfo>
   ```

7. Runtime schema selection must use ExifTool’s emitted `table`, `id` and optional `index`.
8. Do not use Family 5, Make, Model, FileType, enum values or other heuristics to infer a table.
9. Add New Property must return and select one exact `SchemaDefinitionId`.
10. Friendly names are labels and search fields only.
11. Drafts, writes, readback verification, outcomes, columns and frontend state must carry `SchemaDefinitionId`, not a friendly string.
12. Remove obsolete string-key and schema-collision code rather than retaining compatibility layers indefinitely.

## Phase 1 — Define `SchemaDefinitionId`

Add the canonical type in `src-tauri/src/tag_schema.rs`, or a small dedicated module if that gives cleaner dependencies.

Use approximately:

```rust
#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SchemaDefinitionId {
    pub table: String,
    pub tag_id: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub index: Option<u32>,
}
```

### Required documentation

The struct and all three fields must have proper Rust doc-comments explaining the ExifTool mapping.

Use wording along these lines, improving it where appropriate:

```rust
/// Canonical identity of one ExifTool tag definition.
///
/// At runtime ExifTool emits this identity when JSON output (`-j`) is combined
/// with table output (`-t`) and decimal tag IDs (`-D`). The same identity is
/// reconstructed from `exiftool -listx -f -lang en`.
///
/// Unlike a display name such as `IFD0:Orientation`, this identifies the exact
/// ExifTool tag-table definition selected for the value.
pub struct SchemaDefinitionId {
    /// ExifTool's internal tag-table name.
    ///
    /// Runtime values come from the JSON `table` field emitted by `-j -t`.
    /// Static `-listx` table names are normalised by removing the leading
    /// `Image::ExifTool::` namespace, so for example
    /// `Image::ExifTool::Exif::Main` becomes `Exif::Main`.
    pub table: String,

    /// The ID of the tag within `table`.
    ///
    /// Runtime values come from the JSON `id` field emitted by `-D`. Numeric
    /// IDs are stored as canonical base-10 strings so JSON numbers and XML
    /// attribute strings compare identically. Non-numeric ExifTool IDs are
    /// preserved as strings.
    pub tag_id: String,

    /// Selects one definition when the same table contains several `<tag>`
    /// entries with the same tag ID.
    ///
    /// ExifTool emits this as the JSON `index` field under `-j -t`. For
    /// `-listx`, it is reconstructed as the zero-based occurrence of that ID
    /// within the table. `None` means ExifTool omitted the index because the
    /// table/ID pair is unambiguous; it is not equivalent to `Some(0)`.
    pub index: Option<u32>,
}
```

The final comments must clearly communicate:

- how runtime output maps to the fields;
- how `-listx` maps to them;
- that `tag_id` is local to its table;
- why `index` exists;
- that `None` and `Some(0)` are different.

Generate and export the corresponding TypeScript type through the existing `ts-rs` process.

## Phase 2 — Canonical normalisation helpers

Create small, well-tested helpers for:

### Table names

Normalise static `-listx` table names by removing exactly this prefix when present:

```text
Image::ExifTool::
```

Examples:

```text
Image::ExifTool::Exif::Main → Exif::Main
Image::ExifTool::BMP::OS2   → BMP::OS2
Image::ExifTool::Composite  → Composite
Extra                       → Extra
```

Do not use fuzzy matching, suffix matching or manufacturer inference.

### Tag IDs

Store all tag IDs as strings.

For runtime `-D` JSON:

- JSON integer `274` becomes `"274"`.
- JSON string `"description"` remains `"description"`.
- Reject unsupported JSON shapes with a clear diagnostic.

For `-listx`:

- Canonicalise numeric and hexadecimal numeric representations to the same base-10 string that `-D` emits.
- Preserve textual and symbolic IDs exactly where case is significant.
- Add tests covering numeric, hexadecimal and textual IDs.

Keep this normalisation in one shared implementation. Do not duplicate subtly different versions in scanner and schema parser.

## Phase 3 — Rebuild the static registry around the unique ID

Change `TagInfo` so it includes its identity:

```rust
pub struct TagInfo {
    pub id: SchemaDefinitionId,

    /// Effective ExifTool Family-1 group, used for display and write syntax.
    pub group: String,

    /// ExifTool tag name, used for display and write syntax.
    pub name: String,

    pub writable: bool,
    pub kind: TagKind,
    pub description: Option<String>,
    pub storage_count: Option<String>,
}
```

Retain other genuinely useful schema fields where already required, but do not add another identity field.

A friendly display label may be derived from `TagInfo`:

```rust
impl TagInfo {
    pub fn display_name(&self) -> String {
        format!("{}:{}", self.group, self.name)
    }

    pub fn exiftool_write_name(&self) -> String {
        format!("{}:{}", self.group, self.name)
    }
}
```

These are derived labels/selectors, not keys.

### Parse every definition

Change `TagRegistry` to:

```rust
pub struct TagRegistry {
    tags: BTreeMap<SchemaDefinitionId, TagInfo>,
}
```

Its primary API should be:

```rust
pub fn lookup(&self, id: &SchemaDefinitionId) -> Option<&TagInfo>;
pub fn iter(&self) -> impl Iterator<Item = (&SchemaDefinitionId, &TagInfo)>;
pub fn all_writable(&self) -> impl Iterator<Item = &TagInfo>;
```

Do not add `lookup_by_group_and_name`.

### Reconstruct `index`

`-listx` does not need to provide a literal index attribute. Reconstruct it from document order:

1. Within each table, group `<tag>` elements by canonical tag ID.
2. Preserve their XML/document order.
3. When an ID occurs once, assign `index: None`.
4. When an ID occurs more than once, assign `Some(0)`, `Some(1)`, and so on.
5. The ordering must match ExifTool’s runtime `GetTagIndex`/JSON `index`.

A two-pass parse per table is acceptable if it makes this reliable.

### Duplicate insertion

After including `table + tag_id + index`, duplicate identities should not be silently resolved.

If two parsed definitions produce the same `SchemaDefinitionId`:

- return a schema parse error with the complete ID and both definitions;
- do not score or overwrite one.

Delete:

```text
definition_score
winner selection
collision collapsing
Group:Name registry map
```

### Registry cache

A struct-keyed `BTreeMap` cannot be represented directly as a JSON object.

Keep the map internally, but serialise the registry cache as a list of `TagInfo` records. On deserialisation, rebuild the map from each `TagInfo.id` and reject duplicate IDs.

Bump `TAG_SCHEMA_PARSER_VERSION`.

Do not preserve compatibility with old cache contents; the cache is disposable and should rebuild automatically.

## Phase 4 — Parse `-j -t -D` runtime objects

Update both ExifTool scanner passes to include:

```text
-t
-D
```

The normal command should be based on:

```text
-a -G1 -s -struct -t -D -j
```

with the existing charset and exclusion options retained, and with `-n` added for the raw pass.

Do not add Family 5, Make/Model resolution or other fallback fields.

### Parse the wrapped value

With `-t -D`, ordinary tag values are objects resembling:

```json
{
  "id": 274,
  "table": "Exif::Main",
  "val": 1
}
```

and indexed definitions may resemble:

```json
{
  "id": 513,
  "index": 0,
  "table": "Exif::Main",
  "val": 1120
}
```

Create a private strongly typed parser for:

```rust
struct ExifToolRuntimeValue {
    table: String,
    tag_id: String,
    index: Option<u32>,
    language: Option<String>,
    value: serde_json::Value,
}
```

The actual deserialisation type may use `serde_json::Value` for `id` before normalisation.

Do not spread ad hoc `.get("table")`, `.get("id")` parsing throughout the scanner.

### SourceFile

Continue treating `SourceFile` as file-routing metadata rather than a metadata property. Handle its non-wrapped shape explicitly.

### Runtime map

Each parsed runtime property must produce:

```rust
SchemaDefinitionId
```

from its `table`, `id` and optional `index`.

The original JSON property name, such as `IFD0:Orientation`, may be retained only for:

- diagnostics;
- language-child detection;
- checking ExifTool output consistency.

It must not be used as the metadata identity or registry lookup key.

## Phase 5 — Join raw and formatted passes by `SchemaDefinitionId`

Replace the current maps keyed by `String` with maps keyed by `SchemaDefinitionId`.

The two passes should align using the exact ID:

```text
formatted table/id/index
raw table/id/index
```

Do not align by the original JSON property name.

The canonical semantic parse should:

1. Find the raw runtime value by `SchemaDefinitionId`.
2. Find the formatted hint by the same `SchemaDefinitionId`.
3. Look up `TagInfo` by the same ID.
4. Call `parse_metadata_value()` using the exact `TagKind`.
5. Store the result under that ID.

A formatted/raw mismatch must produce a diagnostic including:

- source file;
- full `SchemaDefinitionId`;
- original JSON property names from both passes;
- which pass was missing.

Do not silently match it to another definition.

## Phase 6 — Handle LangAlt as narrow canonicalisation

The investigation found the only direct lookup misses were language-specific LangAlt children:

```text
runtime:
    table = XMP::dc
    id = description-en

static parent:
    table = XMP::dc
    id = description
    kind = LangAlt
```

Implement one narrow canonicalisation rule:

1. Try exact `SchemaDefinitionId` lookup first.
2. Only after exact lookup fails, inspect the runtime language information.
3. Construct a base ID in the same table by removing the confirmed language suffix.
4. Perform a normal exact registry lookup of that base ID.
5. Accept it only if the resulting `TagInfo.kind` is `TagKind::LangAlt`.
6. Store the language code within `MetadataValue::LangAlt`.
7. Merge all language children under the one parent `SchemaDefinitionId`.

Prefer ExifTool’s explicit `lang` field when it is present. Use suffix parsing only as a carefully tested fallback.

Support at least:

```text
en
en-GB
fr
x-default
```

Do not create separate schema definitions for each language.

Do not add a secondary LangAlt registry index.

Do not strip arbitrary `-suffix` values from unrelated tag IDs.

## Phase 7 — Define wire-safe metadata entry types

Do not attempt to serialise a map with `SchemaDefinitionId` object keys.

Add a wire type:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataEntry {
    pub id: SchemaDefinitionId,
    pub value: MetadataValue,
}
```

Change scanner/event/result payloads from:

```rust
HashMap<String, MetadataValue>
```

to:

```rust
Vec<MetadataEntry>
```

or a small transparent collection wrapper containing that vector.

Use `BTreeMap<SchemaDefinitionId, MetadataValue>` internally where convenient, then convert to a stable ordered vector at the wire boundary.

Update:

- `ImageMetadata`;
- `ImageMetadataResult`;
- fresh metadata in apply progress;
- `MetadataApplyEditsResult`;
- readback structures;
- generated TypeScript types;
- test factories and mocks.

Ordering should be deterministic, preferably by `SchemaDefinitionId`.

## Phase 8 — Frontend identity helpers

JavaScript object identity cannot safely key a `Map` using newly deserialised object instances.

Add a small helper module, for example:

```text
src/utils/schemaDefinitionId.ts
```

It may contain:

```typescript
schemaDefinitionIdEquals(a, b);
schemaDefinitionIdToken(id);
formatSchemaDefinitionIdForDiagnostics(id);
tagInfoDisplayName(info);
```

`schemaDefinitionIdToken()` may produce an unambiguous canonical string such as JSON encoding of:

```typescript
[id.table, id.tag_id, id.index ?? null];
```

This token is allowed only as an internal JavaScript collection/React-key mechanism.

It must not become:

- a public domain type;
- a persisted metadata identity;
- an ExifTool tag name;
- an API parameter replacing `SchemaDefinitionId`;
- a second concept called an application key.

All domain-facing functions and component props must accept `SchemaDefinitionId`.

Document this restriction next to the token helper.

## Phase 9 — Update frontend metadata storage and access

Replace:

```typescript
Record<string, MetadataValue>;
```

metadata collections with entries carrying exact IDs.

The frontend store may normalise the wire vector into an internal map keyed by `schemaDefinitionIdToken(id)`, but each stored value must include the original `SchemaDefinitionId`.

Provide central helpers rather than scattering token operations:

```typescript
metadataGet(collection, id);
metadataHas(collection, id);
metadataEntries(collection);
metadataIds(collection);
```

Update all consumers, including:

- scan-event handling;
- `ImageMetadataStore`;
- details pane;
- photo rows;
- list view;
- sorting;
- searching/indexing;
- editor opening;
- effective value calculation;
- normalisation;
- geocoding;
- GPS editors;
- diagnostics;
- test factories.

Do a repository-wide search for assumptions such as:

```text
Record<string, MetadataValue>
metadata[key]
Object.entries(metadata)
Object.keys(metadata)
Group:Name
split(":")
startsWith("XMP-")
endsWith(":GPSLatitude")
```

Replace identity-related uses with `SchemaDefinitionId`.

Friendly name logic may still inspect `TagInfo.group` and `TagInfo.name` for display. It must not use the resulting string to retrieve metadata.

For specialised known-tag behaviour, use exact `SchemaDefinitionId` constants or compare exact IDs. Do not use regexes against friendly names as identity tests.

Centralise known IDs instead of scattering table/ID literals.

## Phase 10 — Update schema lookup hooks and commands

Change the Tauri command from:

```rust
fn get_tag_info(tag: String)
```

to:

```rust
fn get_tag_info(id: SchemaDefinitionId)
```

and perform one exact registry lookup.

Update `useTagInfo` and `useTagInfos` to accept `SchemaDefinitionId`.

Their internal caches may use `schemaDefinitionIdToken()`, but callers pass IDs.

Remove comments and fallback behaviour referring to:

```text
Group:Name
unknown tag uses text fallback
```

A missing schema should be represented as `null`/`None` and diagnosed. Do not infer another schema.

## Phase 11 — Redesign Add New Property around exact selection

Replace `list_schema_tags() -> Vec<String>` with a command returning complete writable definitions:

```rust
fn list_writable_schema_definitions() -> Result<Vec<TagInfo>, String>
```

or an equivalently named command.

The registry should produce this by iterating its single `SchemaDefinitionId` map and filtering `writable`.

Replace `useSchemaTagNames` with a hook returning writable `TagInfo[]`.

### UI behaviour

The current free-text field must become a search field, not an identity field.

The user may search by:

- friendly `Group1:TagName`;
- tag name;
- description;
- table name;
- tag ID;
- kind.

However, the user must select one concrete result containing one exact `SchemaDefinitionId`.

Requirements:

- Typing arbitrary text is not enough to enable Next.
- Next is enabled only after a concrete result has been selected.
- `onSave` receives `SchemaDefinitionId`.
- Duplicate detection compares exact IDs.
- Results with the same friendly name remain separate.
- Show enough context to distinguish them, for example:

  ```text
  WhiteBalance
  Canon:WhiteBalance
  Canon::CameraInfo40D · ID 4

  WhiteBalance
  Canon:WhiteBalance
  Canon::CameraInfo5D · ID 4
  ```

- Show `index` when present.
- Continue filtering read-only definitions out of Add New Property.
- Existing filename applicability filtering may remain as a search/presentation heuristic, but it must operate on `TagInfo` and must not alter identity.

Delete the old behaviour that allowed an unknown free-text tag to be sent as raw text.

## Phase 12 — Migrate drafts to `SchemaDefinitionId`

Draft edits must no longer be keyed by `Group1:TagName`.

Define a wire/persistence entry such as:

```rust
pub struct MetadataDraftEntry {
    pub id: SchemaDefinitionId,
    pub edit: MetadataDraftEdit,
}
```

A per-file draft collection should serialise as a list of these entries, not a JSON object with struct keys.

Internally it may use:

```rust
BTreeMap<SchemaDefinitionId, MetadataDraftEdit>
```

### Draft file version

Bump the draft schema from v3 to v4.

Suggested v4 shape:

```json
{
  "schema_version": 4,
  "relative_path": "photo.jpg",
  "edits": [
    {
      "id": {
        "table": "Exif::Main",
        "tag_id": "274",
        "index": null
      },
      "edit": {
        "intent": "Set",
        "value": {
          "kind": "Integer",
          "value": 1
        }
      }
    }
  ]
}
```

Do not attempt to migrate v3 `Group:Name` drafts automatically because the old key may be ambiguous.

Reject v1–v3 with a clear message telling the user to recreate pending drafts.

Update:

- Rust draft persistence;
- frontend `DraftEditsStore`;
- store notifications;
- draft equality/redundancy checks;
- save/load commands;
- all draft-related tests.

All draft store APIs must accept `SchemaDefinitionId`.

## Phase 13 — Update write argument construction

Change write construction so callers provide the selected ID and exact `TagInfo`.

For example:

```rust
pub fn build_metadata_args(
    id: &SchemaDefinitionId,
    info: &TagInfo,
    edit: &MetadataDraftEdit,
) -> Result<BuiltArgs, String>
```

Requirements:

1. Require that `info.id == *id`.
2. Reject missing schema rather than falling back to raw text.
3. Reject read-only definitions before constructing arguments.
4. Derive the ExifTool write selector from:

   ```rust
   info.exiftool_write_name()
   ```

5. Keep the selected `SchemaDefinitionId` throughout diagnostics and verification.
6. Do not try to pass the table name to ExifTool using an invented syntax.
7. Do not convert the friendly write selector into MediaLibrary’s identity.

The command sent to ExifTool may still contain:

```text
-IFD0:Orientation=...
```

because that is ExifTool’s write syntax. MediaLibrary’s identity remains:

```text
Exif::Main / 274 / optional index
```

## Phase 14 — Exact readback verification

Before/after metadata maps and verification must use `SchemaDefinitionId`.

For each edit:

- `before` is looked up by exact ID;
- `observed` is looked up by exact ID;
- successful verification clears the draft for that exact ID;
- a value written under a different ExifTool definition does not count as a match.

This is particularly important for Add New Property: selecting one definition does not permit verification against a different definition with the same friendly name.

Change:

```rust
MetadataTagOutcome {
    tag: String,
    ...
}
```

to carry:

```rust
id: SchemaDefinitionId
```

It may additionally contain a friendly display name for logs/UI, but that label is not the identity.

Update apply logs, batch logs and mismatch dialogs to include the full ID in diagnostics.

Do not retain maps such as:

```rust
HashMap<String, Vec<String>>
```

where the string means metadata identity. Use `SchemaDefinitionId`.

## Phase 15 — Known-tag constants and special behaviour

The repository contains logic for known metadata such as:

- GPS coordinates and altitude;
- exposure time;
- aperture;
- focal length;
- country codes;
- dates;
- normalisation groups;
- geocoding fields;
- keywords and descriptions.

Replace hard-coded `Group1:TagName` identity constants with exact `SchemaDefinitionId` constants.

Centralise them in clearly named modules rather than scattering table/ID literals.

Verify each constant against ExifTool 13.57 `-listx`.

A friendly group/name may still be used to render labels. It must not be used to retrieve or mutate metadata.

Remove identity checks resembling:

```typescript
key === "ExifIFD:ExposureTime";
key.endsWith(":GPSLatitude");
```

and replace them with exact ID comparison.

## Phase 16 — Columns, sorting and persisted UI configuration

Image metadata columns must identify their property using `SchemaDefinitionId`.

Use a discriminated shape such as:

```typescript
type VisibleColumn =
  { kind: "os"; key: OsColumnKey } | { kind: "image"; id: SchemaDefinitionId };
```

Do the same for image sort keys.

Column labels should come from `TagInfo`, not from an identity string.

Existing persisted image-column configuration uses ambiguous string keys and must not be silently interpreted under the new model.

Bump/reset the relevant persisted configuration version:

- preserve OS-column settings where safely possible;
- discard or reset legacy image-column selections;
- document the reset;
- update persistence tests.

Do not introduce a permanent mapping from old `Group:Name` strings to new IDs.

## Phase 17 — Missing schemas and duplicate runtime identities

### Missing schema

When runtime ExifTool output supplies a valid `SchemaDefinitionId` that is absent from the registry:

- preserve the runtime ID in diagnostics;
- preserve the value as `MetadataValue::Unknown` if practical;
- expose it as read-only/uneditable;
- log a clear schema-gap warning;
- do not resolve it heuristically;
- do not write it as generic text.

### Duplicate canonical IDs

Because `-a` is retained, detect cases where two non-LangAlt runtime properties canonicalise to the same `SchemaDefinitionId`.

Rules:

1. LangAlt children merge normally.
2. Identical duplicate values may be deduplicated with a diagnostic.
3. Different values for the same canonical ID must not silently overwrite one another.
4. Return a clear parse error or file-level metadata error containing:

   - source file;
   - ID;
   - both original JSON property names;
   - both values.

Do not add Family 4 to `SchemaDefinitionId`; it identifies runtime occurrences, not static schema definitions.

Do not invent a second occurrence-key system in this change.

## Phase 18 — Remove obsolete code

Delete or rewrite all obsolete mechanisms, including:

```text
definition_score
Group:Name registry lookup
collision winner selection
SchemaResolution-style logic
schema compatibility merging
Make/Model schema inference
FileType schema inference
Family 5 schema inference
raw enum-value schema inference
IFD0/IFD1 identity equivalence
unknown-tag text write fallback
useSchemaTagNames
free-text Add New Property identity
```

Research scripts and reports under `tools/`, `docs/` or `investigation/` may remain for historical evidence, but production code must not depend on them.

Do not delete pre-existing untracked research output unless explicitly necessary.

## Phase 19 — Documentation

Update at least:

```text
docs/METADATA_FORMATS_DESIGN.md
docs/GENERATED_TYPES.md
```

and any other design documents describing `Group1:TagName` as the metadata key.

Document:

- why `Group1:TagName` was insufficient;
- the `-j -t -D` discovery;
- `SchemaDefinitionId`;
- static index reconstruction;
- LangAlt canonicalisation;
- wire arrays rather than object-key maps;
- exact Add New Property selection;
- draft v4;
- exact readback verification;
- the distinction between identity and friendly display/write names.

Do not retain contradictory older design text.

## Phase 20 — Required Rust tests

Add focused tests for:

### Identity normalisation

- static table prefix removal;
- runtime table preservation;
- decimal ID normalisation;
- hexadecimal static ID normalisation;
- textual IDs;
- `None != Some(0)`.

### Static parser

- Windows and OS/2 `BMPVersion` become two distinct definitions:

  ```text
  BMP::Main / 0 / None
  BMP::OS2 / 0 / None
  ```

- repeated `Exif::Main` ID 513 definitions receive `Some(0)`, `Some(1)`, etc.;
- a unique table/ID receives `None`;
- effective tag-level G1 overrides are retained in `TagInfo`;
- duplicate canonical IDs cause an error;
- all alternatives remain in the registry;
- no scoring occurs.

### Cache

- serialisation uses a list;
- deserialisation reconstructs the exact map;
- duplicate IDs in cache are rejected;
- old cache version rebuilds.

### Runtime JSON parsing

- ordinary `table/id/val`;
- indexed `table/id/index/val`;
- numeric and textual IDs;
- missing table or ID;
- Composite `ThumbnailImage`;
- BMP runtime table distinction;
- original JSON property name is not used as identity.

### Two-pass merge

- raw and formatted values join by ID;
- same friendly name with different IDs remains two entries;
- mismatched identities do not merge.

### LangAlt

- `description-en` and `description-fr` merge into the parent definition;
- `x-default` works;
- exact lookup is attempted first;
- unrelated hyphenated IDs are not stripped;
- base definition must be `TagKind::LangAlt`.

### Draft v4

- round trip;
- multiple IDs with the same friendly name remain distinct;
- v3 is rejected;
- duplicate IDs in one file are rejected.

### Writes and verification

- write selector is derived from `TagInfo`;
- missing schema is rejected;
- read-only definition is rejected;
- readback must use the exact ID;
- a same-name/different-ID readback does not clear the draft;
- outcomes carry `SchemaDefinitionId`.

## Phase 21 — Required frontend tests

Update existing tests and add coverage for:

1. `useTagInfo` caching by value-equivalent IDs.
2. Two separately deserialised equal IDs share one cache entry.
3. Two IDs with the same friendly name do not collide.
4. Details pane renders both same-name definitions separately.
5. Draft edits are independent by exact ID.
6. New Property search:

   - searches friendly text;
   - displays duplicate-friendly-name results separately;
   - requires explicit selection;
   - passes the selected ID to `onSave`;
   - prevents only exact-ID duplicates.

7. Typed editors receive the exact `TagInfo`.
8. Columns and sorting use exact IDs.
9. Legacy image-column persistence is reset safely.
10. LangAlt values appear as one property.
11. Metadata search/indexing still searches friendly names and displayed values.
12. GPS and other specialised editors use exact known IDs.
13. Apply progress and mismatch UI display a friendly name while retaining exact identity.

Do not weaken tests merely to accommodate the refactor.

## Phase 22 — Generated types and checks

Regenerate all `ts-rs` files through the repository’s established command.

Ensure the generated exports include at least:

```text
SchemaDefinitionId
MetadataEntry
MetadataDraftEntry
TagInfo
ImageMetadata
MetadataTagOutcome
```

Run all repository-standard checks. At minimum, where supported:

```text
cargo fmt --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm test -- --run
npm run build
```

Also run the repository’s lint/typecheck commands if separate.

Fix warnings introduced by the refactor.

## Phase 23 — Manual verification

Perform a brief manual verification using representative files:

1. Ordinary JPEG EXIF tags.
2. `test_win_v3.bmp`.
3. `test_os2_v1.bmp`.
4. A file containing `IFD1:ThumbnailImage`, if Composite output is enabled in that path.
5. A LangAlt description file.
6. Add New Property with two search results sharing a friendly name.
7. Edit, save and verify an ordinary writable property.
8. Confirm the draft is cleared only when the exact selected ID verifies.

Record the observed IDs in the final response.

## Completion criteria

The implementation is complete only when:

- `SchemaDefinitionId` is the sole metadata identity.
- Its doc-comments fully explain the ExifTool mapping.
- Every static definition is retained.
- Registry lookup is exact and unique.
- Runtime scanning uses `-t -D`.
- Raw and formatted passes join by ID.
- Metadata wire collections carry IDs explicitly.
- Drafts use schema v4 and exact IDs.
- Add New Property requires exact selection.
- Writes and readback verification retain the selected ID.
- No production metadata collection is keyed by `Group1:TagName`.
- No fallback schema-resolution heuristics remain.
- Tests and generated TypeScript types pass.

## Final response

Report:

```text
Commit SHA:
Files changed:
SchemaDefinitionId location:
Exact doc-comments added:
Registry representation:
Runtime ExifTool command:
Wire metadata representation:
Draft schema version and shape:
Add New Property behaviour:
LangAlt handling:
Missing-schema behaviour:
Duplicate-runtime-ID behaviour:
Obsolete code removed:
Rust tests:
Frontend tests:
Build/typecheck:
Manual test results:
Remaining limitations:
Final git status:
```

Commit the implementation with a clear conventional commit message after all checks pass.

Do not include pre-existing investigation dumps or unrelated untracked files in the commit.
