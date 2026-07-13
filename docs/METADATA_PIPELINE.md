# Metadata Pipeline Guidance

This document holds operational rules for the metadata pipeline. For the full type-flow design, see `docs/METADATA_FORMATS_DESIGN.md`.

## Backend Scanner Result

The scanner's public Rust `ImageMetadata` result contains authoritative,
occurrence-keyed `MetadataOccurrences` and a temporary schema-keyed
`MetadataEntries` compatibility projection. The Tauri `image_metadata_ready`
event sends that result directly with `relative_path`, `occurrences`, and
`metadata`. The frontend validates and stores the two representations
independently in `ImageMetadataOccurrencesStore` and `ImageMetadataStore`.

The Details Pane is the first deliberately narrow production occurrence
consumer. It builds a per-file schema-resolution index and classifies every
schema lookup as `missing`, `unique`, or `multiple`. A unique ordinary row uses
the authoritative occurrence value and embedded `TagInfo` without depending on
a second schema lookup. Missing resolutions preserve the existing legacy row
behavior. Multiple resolutions never select a preferred or first occurrence:
all concrete values render separately in the read-only **Additional Metadata
Occurrences** section, including identical values retained behind one legacy
compatibility value.

When a multiple resolution also has a compatibility row, that row is visibly
ambiguous and offers no Edit, Edit GPS, Remove, or group Remove action. It may
show the existing compatibility projection value, but no aggregate value is
invented when the schema is absent. An existing schema-level draft stays only
on that compatibility row and may be discarded; concrete occurrence rows never
receive drafts or context-menu actions.

Details Pane row menus and open editors follow the current live schema
resolution rather than the resolution that existed when an interaction began.
If a unique schema becomes multiple, its editor closes without saving or
changing a draft. If one unique occurrence is replaced by another, the row and
editor refresh from the replacement's exact semantic value. The pane builds an
editor-only authoritative base by overlaying unique occurrence values on the
legacy collection, then applies the existing draft overlay; Set, Delete,
ListAdd, and ListRemove draft precedence is unchanged. The resulting effective
collection supplies both the editor's initial value and its file metadata.
GPS resolution continues to receive the legacy schema-keyed collection.

If an ambiguous schema is absent from the legacy projection but already has a
schema-keyed Delete draft, the Details Pane creates a Null-valued compatibility
row solely to keep that draft visible and discardable. The row remains
ambiguity-marked and excluded from individual and group Remove actions, while
group Discard includes it. No such row is created for missing or uniquely
resolved absent schemas. Concrete occurrence rows remain draft-free and
read-only.

Draft identity and persistence, GPS resolution, Add Property, search-worker indexing,
sorting, normalisation, writes, and readback verification remain schema-keyed
through `ImageMetadataStore`.
Identical values sharing a schema may deduplicate in the compatibility field;
an incompatible schema group is instead omitted atomically from the legacy
projection without affecting unrelated entries. Every concrete value remains in
authoritative `MetadataOccurrences`, so a lossy compatibility projection no
longer fails the file or creates a failed-file placeholder.

Compatibility omissions are logged and returned from the backend-only
`MetadataBatchReadOutcome::legacy_projection_omissions` diagnostics. They are
not `worker_error` events. Consumers other than the Details Pane fallback may
show an omitted schema as blank until they migrate to occurrences. Schema-keyed apply
and readback verification reject any partial projection rather than proceeding
unsafely. Unknown-schema occurrences remain excluded because public occurrences
do not carry the scanner's temporary projection-schema candidate.
Occurrence-specific editing remains pending, and no arbitrary first occurrence
may be selected. No apply or write command consumes occurrence identity or
`MetadataWriteTarget` yet.

For the original IFD0/IFD1 `XResolution` collision, both authoritative values
now remain part of a successful scan and are visible with their distinct paths
and origins in the Details Pane. They remain read-only there even when distinct
write targets exist, because drafts and apply verification are still
schema-keyed.

Genuine read, parse, canonicalisation, or projection-invariant failures still
emit empty collections to clear loading state and report details through
`worker_error`.

## Locked Draft Target Model

`MetadataDraftTarget` locks the distinction needed by the upcoming migration:

- `ExistingOccurrence` carries the explicitly selected
  `MetadataOccurrenceId`, the exact semantic `SchemaDefinitionId`, and a
  snapshot of that occurrence's exact `MetadataWriteTarget`.
- `NewProperty` carries only the exact `SchemaDefinitionId` selected through a
  writable `TagInfo`; it has no runtime occurrence or write selector yet.

An existing target is constructible only when that occurrence's exact
`TagInfo` is writable and its exact write target exists. A new-property target
starts from an exactly resolved writable `TagInfo`. Neither path permits a
schema-to-occurrence first-match conversion.

Before a later occurrence-aware apply path writes an existing target, it must
reread the file, find the exact occurrence ID, validate the fresh schema and
write-target snapshot, and reject stale or ambiguous targets. The relative file
path remains outer draft-map context rather than a target field. It is also an
untrusted string key. JavaScript v5 collections use own data properties for
construction and lookup, so names such as `__proto__`, `constructor`,
`prototype`, `toString`, and `hasOwnProperty` are preserved exactly instead of
resolving through `Object.prototype`.

Target snapshot identity and draft-slot identity are deliberately separate:

```text
                         target snapshot                 draft slot
ExistingOccurrence      occurrence + schema + selector  occurrence only
NewProperty             schema                          schema only
```

The target snapshot preserves everything needed for later revalidation. The
slot says which one draft position it occupies, so changed stale schema or
selector snapshots for the same occurrence cannot create parallel drafts.
Existing and new variants remain distinct slots even when their schemas match.

Pure write-argument planners now enforce the next boundary without executing
ExifTool:

```text
ExistingOccurrence
→ exact fresh-occurrence validation
→ fresh runtime MetadataWriteTarget selector
→ fresh embedded TagInfo value semantics

NewProperty
→ exact TagInfo schema validation
→ schema-driven creation selector
→ TagInfo value semantics
```

An existing selector snapshot is never trusted on its own, and
existing-occurrence writes never derive a destination from `TagInfo::group`.
New-property creation remains schema-driven because no runtime occurrence or
write target exists yet. The target-aware planners and the legacy builder share
one semantic value encoder.

The inactive `apply_edits_v5.rs` single-file path now composes those planners
into the future occurrence-aware apply flow:

```text
v5 entry
→ authoritative pre-write ImageMetadata
→ duplicate-slot and exact-occurrence validation for every target
→ structured ASCII-case-insensitive selector collision check
→ target-aware numeric/text argument planning and argfile rendering
→ numeric pass, then text pass only after numeric success
→ authoritative occurrence readback
→ strict post-write exact-occurrence-ID validation
→ exact-target/cardinality-aware semantic verification
→ explicit per-target draft reconciliation
```

No write begins until the complete batch has validated and rendered. Existing
targets use only their exact occurrence ID for pre-write lookup and post-write
resolution; they never select a same-schema replacement. New properties must
have zero exact-schema occurrences before writing. Their readback explicitly
reports zero as `MissingPostWrite`, one as the unique value to verify, and
multiple as `AmbiguousPostWrite`, including every matching occurrence ID. No
first, lowest, `Copy0`, `IFD0`, or writable-result preference exists.

Both authoritative occurrence collections require unique exact
`MetadataOccurrenceId` values. A pre-write duplicate rejects planning. A
post-write duplicate produces `ReadbackInvalid` for every planned target before
any target verification, clears no target, and withholds the invalid
`ImageMetadata` from downstream consumers. The read itself succeeded, so this
invariant failure remains distinct from the client-error `ReadbackFailed` path.
Any numeric or text write-pass failure is retained alongside the invariant
failure.

Two or more distinct IDs may legitimately share one schema, such as IFD0 and
IFD1 occurrences. Existing targets still resolve independently by exact ID. A
new property resolving to multiple such distinct same-schema IDs remains valid
readback data but yields `AmbiguousPostWrite`; a repeated exact ID invalidates
the collection before that cardinality check. Neither condition depends on
scanner result order.

The v5 authoritative reader accepts a successful occurrence result even when
the temporary legacy projection reports omissions. Verification and draft
reconciliation are separate results. Every target outcome preserves the
original submitted target and carries one explicit reconciliation:

```text
Clear    semantic success; remove the original slot
Keep     original target remains retryable, or post-write state is unknown
Replace  remove the original slot and use the supplied complete target with the same edit
Blocked  retain for user resolution, but do not present it as safely retryable
```

Existing `Match` and `DeleteOk` outcomes clear. Other semantic outcomes keep an
unchanged exact existing target while it is still present with the same schema
and selector. A missing or changed existing target is blocked as stale and is
never retargeted to a same-schema sibling.

For `NewProperty`, zero matches keep the creation target. A unique `Match`
clears it. A unique non-clear result cannot leave an apparently retryable
creation draft after the property exists: it replaces the target with an exact
`ExistingOccurrence` built from the fresh occurrence ID, fresh embedded schema,
and fresh runtime selector. A construction failure blocks instead. Multiple
matches block and never choose a replacement. `ReadbackFailed` and
`ReadbackInvalid` keep every original target conservatively and construct no
replacement.

`targets_to_clear` remains as a transitional result field but is derived only
from `Clear` reconciliations, in input order and by unique logical slot. A
successful, invariant-valid readback returns the original full `ImageMetadata`
rather than rebuilding its legacy map. No batch layer persists `Replace` yet,
and no frontend consumer uses reconciliation.

This path deliberately does not use the schema-keyed apply log; target-aware
logging remains pending. It has no Tauri apply command or production caller.
Production apply, persistence, `AppState`, frontend callbacks, dialogs, and
logging remain schema v4.

This remains foundation code only. Inactive schema-v5 Tauri load/save commands
can parse and serialize lines with a file-relative path as outer context and
target-aware `{ target, edit }` entries, but they have no production caller. An
inactive frontend v5 collection, observable store, and command adapter now use
the parallel shape:

```text
file-relative path
→ logical-slot-token-keyed collection
→ complete MetadataDraftTarget + MetadataDraftEdit
```

The slot token is internal collection mechanics, not exposed domain identity.
Every value retains its complete target. Load results enter the adapter as
`unknown`: shared identity, target, edit, and recursive semantic-value guards
reject the complete payload if any file or entry is invalid. Save conversion
validates all collections before returning wire data and sends deterministic
arrays of `{ target, edit }`; slot tokens and source paths inside targets never
cross Tauri. Duplicate logical slots fail in Rust persistence, frontend wire
conversion, and store reset. Record keys that do not equal their derived slots
also fail, including duplicate values hidden under different bad keys, rather
than being silently re-keyed. Store reset is atomic and silent after successful
validation. Outer path property behaviour never contributes to logical draft
identity; target-slot identity remains authoritative. The shared value guard
accepts `Integer` only for finite integral numbers, keeps finite fractional
numbers valid for `Real`, requires `Unknown.raw` to be recursively
JSON-compatible, and enforces the generated unit shapes for `Null` and
`Binary`. A tested frontend/Tauri-contract round-trip preserves full targets,
shared-schema IFD0/IFD1 occurrences, and cross-variant same-schema entries.

Command registration does not mean production usage. No production component
creates this store or imports the adapter. Production startup and autosave
still call the unversioned schema-v4 Tauri commands; `AppState`,
`DraftEditsStore`, and persistence remain keyed by `SchemaDefinitionId`. No
production Details Pane, Add Property, apply command, persistence, or
search-worker path consumes `MetadataDraftTarget`, and activating v5 apply
remains pending; no occurrence-aware apply command is introduced here. V4 and
v5 commands share one filename and must never be mixed
in one live folder session.

A v4 schema ID cannot be converted automatically into an existing-occurrence
or new-property target without authoritative runtime context. In particular,
selecting a first occurrence would violate the occurrence identity rules, so
pending v4 drafts must be recreated after the eventual migration.
There is no automatic v4-to-v5 migration.

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
