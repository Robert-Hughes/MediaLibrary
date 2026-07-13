# Metadata Identity Model

This document locks the distinction between static schema identity, runtime
occurrence identity, and exact ExifTool write targeting. These are related but
independent concepts and must not be substituted for one another.

## Static schema identity

```text
TagInfo::id: SchemaDefinitionId
```

`SchemaDefinitionId` identifies one exact ExifTool schema definition. It
describes the definition's datatype, display information, and general schema
writability. It does not identify a concrete field stored in a source file, and
one schema definition may describe several occurrences in the same file.

For example, the same schema definition can describe both a main-image and a
thumbnail resolution value:

```text
Schema: Exif::Main / 282 / XResolution
├── JPEG-APP1-IFD0 / tag 282 / copy 0 = 300
└── JPEG-APP1-IFD1 / tag 282 / copy 0 = 72
```

## Runtime occurrence identity

```text
MetadataOccurrenceId
```

`MetadataOccurrenceId` identifies one concrete value within one source file.
It consists of ExifTool family 3 (document or timed sample), family 5 (complete
metadata container path), family 7 (runtime tag ID), and normalised family 4
(copy number, with the primary occurrence represented as zero).

At the ExifTool read boundary, family 3 `Main` is stored as `document: None`;
the empty primary family-4 position (or explicit `Copy0`) is stored as
`copy: 0`; and the family-7 `ID-` transport prefix is omitted from stored
`tag_id`. Non-primary document/sample names, complete family-5 paths, and the
remainder of family-7 IDs are retained exactly and case-sensitively.

Runtime occurrence identity deliberately excludes schema identity. When an
identity must be unique across files, it must be combined with the source
file's relative path.

## Metadata occurrence

```text
MetadataOccurrence
```

`MetadataOccurrence` combines the occurrence ID with its current canonical
semantic value. It embeds `Option<TagInfo>` when exact static schema resolution
succeeds and does not duplicate `SchemaDefinitionId`; `TagInfo::id` remains the
sole schema identity.

The occurrence also embeds an optional exact `MetadataWriteTarget`. Runtime
fields that do not resolve to the static registry are retained with no
`TagInfo` and no write target, so they remain visible but read-only.

## Metadata occurrence collection

```text
MetadataOccurrences
```

`MetadataOccurrences` is the ordered collection of concrete occurrences read
from one source file. Collection identity is occurrence-based, and its
deterministic order follows `MetadataOccurrenceId`. A schema lookup can return
zero, one, or several occurrences; callers must handle all three states. The
collection deliberately provides no conversion or first-match helper that
silently chooses one occurrence for a schema definition.

## Write targeting

```text
MetadataWriteTarget
```

`MetadataWriteTarget` records an exact, supported ExifTool write selector. It
contains runtime family 1 and the writable tag name. It is separate from both
occurrence identity and schema identity and is absent whenever writing that
specific occurrence would be ambiguous or unsupported.

```text
tag_info.writable == true
```

does not by itself make an occurrence writable. The occurrence must also have
an exact `MetadataWriteTarget`. This distinction prevents general schema
writability from being mistaken for proof that a concrete stored value can be
targeted safely.

### Conservative targets for existing occurrences

The private scanner occurrence stage assigns a target only after every
occurrence in one source file is known. An exact target currently requires:

- an exactly resolved, statically writable `TagInfo`;
- a supported schema kind (not `Binary` or `Unknown`);
- the main family-3 document;
- no other runtime occurrence with the same selector;
- no runtime LangAlt child semantics;
- exact agreement between the runtime tag name and canonical `TagInfo::name`;
- non-empty, syntactically safe family-1 and tag-name components.

Selector ambiguity is detected across all occurrences, including otherwise
ineligible siblings, using the ASCII-case-insensitive runtime family-1/tag-name
pair. Family 5 cannot disambiguate a selector because it is not represented in
`MetadataWriteTarget`.

Family 4 is part of runtime occurrence identity but not part of the supported
write selector. A non-zero `CopyN` does not by itself make an occurrence
read-only. Exactness is determined by whether the family-1/tag-name selector is
unique across the file's extracted occurrences. Family-4 numbering may span
same-named tags in different groups, so `CopyN` is not equivalent to "Nth copy
within this family-1 selector". Family 4 cannot itself be used as the current
write target.

`TagInfo::group` is not the occurrence write destination. Runtime family 1
supplies the target group, so occurrences sharing one static schema may still
have distinct exact targets:

```text
shared TagInfo
├── occurrence IFD0 → write target IFD0:XResolution
└── occurrence IFD1 → write target IFD1:XResolution
```

For example, different family-1 selectors are independently exact even when
ExifTool assigns a later family-4 number to one occurrence:

```text
IFD0:XResolution / Copy0
IFD1:XResolution / Copy2
→ both exact because the family-1 selectors differ
```

Conversely, family-4 identity cannot distinguish occurrences for a write
selector that they share:

```text
IFD0:XResolution / Copy0
IFD0:XResolution / Copy1
→ neither exact because the write selector is shared
```

## Locked draft target distinction

```text
MetadataDraftTarget
├── ExistingOccurrence
│   ├── occurrence_id: MetadataOccurrenceId
│   ├── schema_id: SchemaDefinitionId
│   └── write_target: MetadataWriteTarget
└── NewProperty
    └── schema_id: SchemaDefinitionId
```

`ExistingOccurrence` means an edit to one runtime field the user explicitly
selected. It captures runtime identity, semantic schema identity, and the exact
supported ExifTool selector as three independent facts. It can be constructed
only from a `MetadataOccurrence` whose exact `TagInfo` is writable and whose
exact `MetadataWriteTarget` is present. Nothing is derived from a friendly
name, `TagInfo::group`, a schema ID, or another occurrence sharing the schema.

The stored write target is a selector snapshot, not authority for a blind
future write. The occurrence-aware apply migration must:

```text
reread authoritative occurrences
→ find the exact MetadataOccurrenceId
→ validate the schema and write-target snapshot
→ reject stale or ambiguous targets
→ construct the ExifTool write
```

`NewProperty` means creation from one exactly selected, writable `TagInfo`. No
runtime occurrence exists yet, so this variant has no occurrence ID, guessed
family-1 group, or write target. Creation remains schema-driven.

Pure target-aware write planning now makes the destination rules executable:

```text
ExistingOccurrence
→ validate against the freshly read exact occurrence
→ selector from the fresh occurrence's MetadataWriteTarget
→ value semantics from the fresh occurrence's embedded TagInfo

NewProperty
→ validate the exact supplied TagInfo schema
→ schema-driven creation selector
→ value semantics from that TagInfo
```

The stored selector snapshot is never trusted without fresh-occurrence
validation. Existing-occurrence planning never uses `TagInfo::group` as its
destination, while new-property creation deliberately remains schema-driven.
Both paths share the legacy builder's semantic value encoder, so this identity
work changes selector choice rather than datatype, enum, list, struct, or
date/time encoding.

The file-relative path remains the outer draft-map context for both variants;
it is not duplicated inside `MetadataDraftTarget`.

## No arbitrary schema-to-occurrence conversion

A lookup that begins with a schema definition can produce any of these states:

```text
missing
unique occurrence
multiple/ambiguous occurrences
```

Consumers must represent and handle those states explicitly. They must never
silently select the first occurrence, and there is no general conversion from
`SchemaDefinitionId` to `MetadataOccurrenceId`.

## Migration status

The scanner's ExifTool pass maps are keyed by `MetadataOccurrenceId`, and pretty
and raw values join by occurrence identity. Its canonical stage materialises
`MetadataOccurrence` values. Exactly resolved occurrences embed their cloned
`TagInfo`; unresolved occurrences retain no `TagInfo`. Scanner occurrences
include exact write targets where the conservative eligibility and per-file
ambiguity checks demonstrate them.

The backend scanner's `ImageMetadata` result now carries authoritative
`MetadataOccurrences` alongside temporary legacy `MetadataEntries`. The legacy
schema projection cannot represent multiple different values sharing one
schema identity, so it omits that complete schema group atomically instead of
selecting an occurrence. Every concrete occurrence remains authoritative, and
unrelated legacy schema entries remain available. The backend batch outcome
returns and logs explicit compatibility omissions; they are not metadata-read
failures or `worker_error` events.

The Tauri `image_metadata_ready` event transports the scanner's `ImageMetadata`
result directly, including both authoritative `occurrences` and the legacy
`metadata` projection. The frontend validates and retains occurrences in the
parallel `ImageMetadataOccurrencesStore`, while `ImageMetadataStore` retains the
legacy projection.

The Details Pane now resolves each ordinary schema identity explicitly to
`missing`, `unique`, or `multiple`. A unique resolution uses the authoritative
occurrence value and its embedded `TagInfo`; a missing resolution retains the
legacy compatibility value and schema lookup. Multiple resolutions never
select one runtime field. Each concrete occurrence is shown separately in the
read-only **Additional Metadata Occurrences** section, while any existing
legacy compatibility row is marked ambiguous and cannot be edited or removed.
Row actions resolve against the current index while their menu is open. An
editor opened for a unique schema closes without saving if that schema becomes
multiple; a replacement unique occurrence refreshes the editor's authoritative
base value. Details Pane editors overlay schema-keyed drafts on that base, so a
draft still takes precedence over the occurrence value.

The file-level duplicate-occurrence scan failure is fixed: a lossy legacy
projection no longer blocks transport of the successful occurrence read.
An existing schema-level draft for a multiple resolution remains attached only
to the compatibility row and may be discarded, but it cannot be edited further
or copied onto concrete occurrence rows. This includes a Delete draft when the
ambiguous schema was omitted from the legacy projection: the pane synthesises
only the ambiguity-marked compatibility row so the draft remains visible and
discardable. Concrete occurrence rows remain draft-free and read-only. Draft
identity and persistence, apply/write
commands, verification, GPS resolution, Add Property, list columns, sorting,
search-worker indexing, and normalisation remain schema-keyed. Unknown-schema
occurrence display and occurrence-specific editing remain pending. No arbitrary
first occurrence is selected, including when values are identical or one
occurrence appears more writable or otherwise preferable, and no write command
uses occurrence identity yet.

`MetadataDraftTarget` is now the locked model for the upcoming draft migration,
and pure write planning exists for both variants, but no production component
creates or consumes those targets or builders. Persisted and in-memory drafts
remain schema-keyed v4, the JSONL shape and schema-keyed verification are
unchanged, and draft v5 is still pending. Only the target enum is locked; no
future v5 persistence shape is finalised here.
