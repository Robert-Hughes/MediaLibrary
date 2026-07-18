# Metadata formats and editing design

MediaLibrary has one active metadata-edit format: target-aware drafts. Every
persisted entry contains a complete `MetadataDraftTarget` and a semantic
`MetadataDraftEdit`.

The identity concepts used here are defined canonically in the
[metadata identity model](METADATA_IDENTITY_MODEL.md). In short, occurrences
are authoritative, schema identity is not occurrence identity, observed
selectors establish occupancy, and every action after target construction uses
the complete target.

## Transient occurrence format

Scan and readback payloads use
`{ id, schema_id, value, tag_info, observed_selector, write_target }`.
Unknown local schemas retain their exact identity with null interpretation and
write target. `ImageMetadata` contains only authoritative occurrences;
schema-oriented consumers derive safe read-only values on demand.

The occurrence relationship is validated structurally. A write target is legal
only when a non-null observed selector has exactly equal `group1`, `group7` and
`tag_name`. This differs from occupancy comparison, where family 1 and tag name
are case-insensitive and family 7 remains case-sensitive.

## Draft and audit persistence

`MediaLibraryTargetDraftEdits.jsonl` is the only draft file read or written.
Records use persisted `schema_version: 5`; there is no old-shape compatibility
reader or migration. New Property logical slots contain both exact schema and
exact destination, so same-schema destinations do not overwrite one another.
Duplicate paths, duplicate logical slots and malformed entries are rejected
before a save can truncate the file.

`MediaLibraryTargetApplyLog.jsonl` is the only active apply audit. Its existing
format and identity marker are unchanged. Rows retain complete targets,
semantic values, verification results and reconciliation decisions, and are
never rewritten.

The historical `MediaLibraryDraftEdits.jsonl` and
`MediaLibraryApplyLog.jsonl` files are ignored. They are not parsed, migrated,
rewritten, truncated or deleted.

## Semantic values and edits

`MetadataValue` carries typed text, numbers, rationals, lists, structures,
dates, times, offsets and date-times. `MetadataDraftEdit` carries `Set`,
`Delete`, `ListAdd` or `ListRemove`, plus optional display text. Display text is
not execution identity and is omitted from JSON when absent.

Redundant `Set` suppression uses semantic equality: sequences are ordered,
bags are unordered, structures ignore object-key insertion order, and nested
children compare completely. Delete and list mutation intents are not
suppressed as redundant.

## Write, verify and reconcile

The active operation is:

1. Validate the complete persisted target against authoritative occurrences
   and its stored destination.
2. Render the structured selector only at the final ExifTool write boundary
   and produce stable UTF-8 numeric and textual argument passes.
3. Write the file and read authoritative occurrences again.
4. For New Property, require exactly one readback match for the intended exact
   schema and selector.
5. Verify semantic results, including rational equivalence, GPS tolerance,
   list semantics, nested values, dates, times, offsets and the narrow IPTC
   country-code padding rule.
6. Reconcile the exact target as Clear, Keep, Replace or Blocked.
7. Persist the reconciled drafts atomically and append the audit record.

Clear results require no attention row. Keep, Replace, Blocked, unavailable
readback, missing values, mismatches, coercions, lingering deletes and observed
nulls retain exact target context for review.

Every observed-selector collision blocks New Property across schemas. A
same-schema occurrence without a safely represented observed selector blocks
conservatively; an unknown-selector occurrence from another schema does not
block every destination.

Semantic value editing preserves the complete New Property target and changes
only its staged edit, including custom family-1 destinations for GPS schemas.
Destination editing atomically deletes the exact original target and upserts
the replacement with the unchanged semantic edit. A stale or failed operation
preserves the original slot. Neither action falls back to a same-schema target.

## Search projection

Search receives every authoritative occurrence's exact schema, semantic value
and runtime coordinates, plus every target draft's schema and semantic edit.
Friendly labels are indexed alongside them. Search is a read-only text
projection: it never selects, replaces, merges or mutates a target.
