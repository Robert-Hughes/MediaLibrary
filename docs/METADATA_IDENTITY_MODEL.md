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

## Creating a new property

Add New Property begins from a selected `TagInfo`. A later migration step will
decide the new `MetadataOccurrenceId` and `MetadataWriteTarget` after creation.
No separate creation-target type is introduced yet.

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

This commit only defines the locked model. The current scanner, metadata
collection, drafts, columns, search, and write pipeline still use their
existing schema-keyed representation. Subsequent small commits will migrate
those systems incrementally.
