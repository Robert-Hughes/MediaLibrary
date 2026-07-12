# Metadata Pipeline Guidance

This document holds operational rules for the metadata pipeline. For the full type-flow design, see `docs/METADATA_FORMATS_DESIGN.md`.

## Backend Scanner Result

The scanner's public Rust `ImageMetadata` result contains authoritative,
occurrence-keyed `MetadataOccurrences` and a temporary schema-keyed
`MetadataEntries` compatibility projection. The Tauri scan event still sends
only the legacy projection, and apply/readback remains schema-keyed. Identical
values sharing a schema may deduplicate in the compatibility field; conflicting
values sharing a schema still fail that file at the projection boundary.

## Tag-Schema Overrides

The tag registry is built from `exiftool -listx -lang en` in `src-tauri/src/tag_schema.rs`. ExifTool listx is silent or misleading for several shapes the app needs, so `apply_overrides` patches known gaps.

Add overrides only when the app has evidence that the schema badge, editor choice, or write behavior is wrong.

Override classes:

- XMP list, sequence, and alternate shapes: listx reports many XMP bags, sequences, and alternatives as plain `string`. Promote known tags to `Bag<Text>`, `Seq<Text>`, or the appropriate shape using the XMP specification as the source.
- DateTime promotion: XMP does not constrain datetime strings at the schema level, so listx reports well-known datetime fields as `string`. Promote known datetime tags so the editor, verifier, and write-argument routing handle them correctly.
- `type='undef'` cleanup: ASCII version strings such as `ExifVersion`, `FlashpixVersion`, and `InteropVersion` can be promoted to `Text`; opaque binary blobs such as MakerNotes, preview images, thumbnails, XMP-as-undef, dust-removal data, and DNG private data should be demoted to `Binary`.

Binary overrides force `writable=false` so the UI marks them read-only and autocomplete drops them. An override must not grant write permission that listx denied.

Relevant tests live in `src-tauri/src/tag_schema.rs`, including:

- `undef_version_strings_promoted_to_text`
- `undef_binary_blobs_demoted_to_binary_and_readonly`
- `binary_override_does_not_grant_write_when_listx_said_no`

See `docs/DATATYPE_MISMATCHES.md` for deferred schema-vs-runtime datatype mismatch analysis.

## Empty List Set Means Delete

A draft `Set` on a `Bag` or `Seq` tag with `MetadataValue::List { items: vec![], .. }`, `MetadataValue::Null`, or an empty string is treated as a tag clear.

ExifTool's CLI write path clears a list with `-TAG=` and writes values with repeated `-TAG=item` arguments. An empty list produces only the clear argument, so ExifTool removes the property. The read/write path does not distinguish "tag absent" from "present but empty" for this case.

`verify_metadata_set` in `src-tauri/src/apply_edits.rs` returns `Match` when an empty-value `Set` leaves the tag absent, null, an empty string, or an empty list after write. Tests such as `verify_metadata_set_distinguishes_match_coerced_mismatch_missing_and_unparsed` pin this behavior.

Preserving a literal empty RDF `Bag` would require a different write path, such as an XMP template or direct XMP packet edit.

## Drafts Vs Committed Metadata

Metadata lives in two stores:

- committed metadata: `imageMetadata`, reflecting what is on disk
- draft edits: `draftEdits`, reflecting pending user edits not yet written

Loaded app state, persistence, and editor components use semantic
`MetadataValue`/`MetadataDraftEdit` values directly. New code should keep
metadata and drafts on that semantic path.

Every read site should choose one of these patterns.

### Resolve

Use when you need the single effective value the user would get after saving. Drafts win over committed metadata.

Examples: geocode payloads, search haystacks, and feature gates. `resolveGps` is the reference shape.

### Show Both

Use when UI intentionally renders committed value and draft value side by side.

Examples: `PhotoRow` cells and `DetailsPane` value rows. These components take `(value, draftValue)` separately so pending edits stay visible.

### Committed Only

Use when behavior must reflect persisted state only.

Examples: sorting in `src/utils/sorting.ts`, backend persistence and verification, and post-write fresh reads. Drafts must be excluded or rows can move while the user types.

### OR-Exist Guards

Pre-write warnings sometimes need to know whether a value exists in metadata or drafts. This is an OR-exist union (`inMeta || inDraft`), not resolve semantics.

Before adding a metadata read, choose the pattern explicitly. In display contexts, raw `metadata[key]` is rarely enough if pending edits should be visible.
