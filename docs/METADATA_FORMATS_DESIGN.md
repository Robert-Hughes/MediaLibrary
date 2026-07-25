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
write target. `FileMetadata` contains only authoritative occurrences;
schema-oriented consumers derive safe read-only values on demand.

One XMP LangAlt property is one occurrence with one complete
`MetadataValue::LangAlt` map. ExifTool's language-suffixed read results are
consolidated under the canonical parent runtime ID within exact
document/path/copy scope. They are never exposed as separate occurrences.

The occurrence relationship is validated structurally. A write target is legal
only when a non-null observed selector has exactly equal `group1`, `group7` and
`tag_name`. This differs from occupancy comparison, where family 1 and tag name
are case-insensitive and family 7 remains case-sensitive.

## Details presentation format

The Details pane uses a transient discriminated row union rather than a
persisted format:

- `ExistingOccurrenceRow` owns one complete authoritative occurrence, exact
  targetability, an exact matching draft where valid and stale/duplicate state;
- `NewPropertyRow` owns one complete intended target and semantic edit; and
- `MissingOccurrenceDraftRow` owns one complete stored ExistingOccurrence
  operation whose authoritative occurrence cannot be selected safely.

Internal row keys are stable JavaScript collection tokens only. They are never
persisted or sent through Tauri and are not domain identity.

Friendly groups and labels are projections. Existing rows choose their group
from observed family 1, resolved `TagInfo.group`, then a schema-table fallback.
New Property and target-only rows use the stored destination's family 1. Every
existing occurrence remains a separate row even when schema and value are
equal. OS Metadata remains a separate read-only section.

A stored ExistingOccurrence edit is displayed as an overlay only when its
complete target exactly matches the current exact target for a unique
occurrence ID. Stale targets remain visible without staged-value overlay or
redirection. New Property rows remain destination operations rather than being
converted to occurrences when a destination is occupied.

Group operations consume complete row targets from the unfiltered group. Search
changes visibility only. Exact group removal is atomic and target-addressed;
schema-wide removal remains a separate column or multi-file request boundary.

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
`Delete`, `ListAdd` or `ListRemove`. Drafts persist only semantic values;
user-facing text is derived from the value, exact schema ID and resolved tag
information by the shared schema-aware formatter.

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
   schema and selector, except for the documented empty-value normalisation
   below.
5. Verify semantic results, including rational equivalence, GPS tolerance,
   list semantics, nested values, dates, times, offsets and the narrow IPTC
   country-code padding rule.
6. Reconcile the exact target as Clear, Keep, Replace or Blocked.
7. Persist the reconciled drafts atomically and append the audit record.

LangAlt `Set` has whole-value semantics. Rendering first clears the parent
property and then recreates every language in the map, so removing a language
from the semantic value removes it from the file.

### Empty-value storage normalisation

MediaLibrary deliberately treats a requested empty semantic value as equivalent
to an empty or absent authoritative readback. This rule is schema-independent:
it is not specific to AI metadata or to any individual property. It applies only
when no occurrence remains. A candidate under another schema or selector,
multiple candidates, or absence after a non-empty write remains a verification
failure.

This is a storage-boundary compromise required by ExifTool. Its
[`-TAG[+-^]=[VALUE]` documentation](https://exiftool.org/exiftool_pod2.html)
defines `-TAG=` with no value as deletion, while `^=` writes an empty scalar
value rather than a zero-item array. ExifTool also ignores empty RDF Bag
containers during XMP rewriting; see the official
[empty `rdf:Bag` explanation](https://exiftool.org/forum/index.php?topic=13031.0).
Consequently, an empty Bag or Seq cannot be retained reliably across ordinary
ExifTool reads and later XMP writes.

Verification preserves both sides of this normalisation. The audit record keeps
the requested empty `sent` value, records `post_write` as `Missing`, reports the
semantic verification as `Match`, and proposes `Clear` for the exact draft.
Thus the physical state is never misreported even though the draft succeeds.
For generated AI metadata, the independently stored model, prompt-version and
generation-time properties provide evidence that analysis ran when an empty
result property is normalised to absence.

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
