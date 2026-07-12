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

## Creating a new property

Add New Property begins from a selected `TagInfo`. A later migration step will
plan the intended `MetadataOccurrenceId` and `MetadataWriteTarget` before the
write. The actual resulting occurrence identity will be confirmed by rereading
the file after ExifTool creates it. No separate creation-target type is
introduced at present.

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
and raw values join by occurrence identity. Its private canonical stage now
materialises `MetadataOccurrence` values. Exactly resolved occurrences embed
their cloned `TagInfo`; unresolved occurrences retain no `TagInfo`. Private
scanner occurrences now include exact write targets where the conservative
eligibility and per-file ambiguity checks demonstrate them.

Scanner output is still projected into the legacy schema-keyed representation.
That temporary projection cannot represent multiple different values which
share one schema identity, so it fails explicitly instead of selecting an
occurrence.

Targets are not emitted through Tauri and the apply pipeline does not consume
them. Application consumers and the legacy scanner projection remain
schema-keyed. The user-visible duplicate-occurrence problem is therefore not
fixed until scanner output itself becomes occurrence-based; subsequent small
commits will migrate those systems incrementally.
