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

An inactive pure Rust engine can now consume those already-computed structured
reconciliations in memory:

```text
original v5 entry
+ target outcome reconciliation
→ validated reconciled v5 entry collection
```

It requires exactly one outcome for every original logical slot, rejects
outcomes for unknown slots, and requires the outcome's complete original target
snapshot to equal the entry target. `Clear` removes the original slot; `Keep`
and `Blocked` retain the complete original target and edit. `Replace` accepts
only `NewProperty` to exact supplied `ExistingOccurrence`, requires identical
schema identity, and carries forward the original semantic edit without using
sent, before, observed, occurrence-value, or display fields. Replacement slots
are checked against every retained slot, every other replacement, and every
other original operation even when that operation is `Clear`; a collision
rejects the whole transformation. Successful entries are ordered by logical
slot. Blocked reasons remain transient outcome information that a future
command and frontend must surface rather than persist.

The file-level helper clones only after validation, removes an emptied file,
and otherwise preserves unrelated files. It performs no load, save, metadata
write, or production-state mutation. There is no Tauri command or production
caller for it, and production persistence and apply remain schema v4.

`targets_to_clear` remains as a transitional result field but is derived only
from `Clear` reconciliations, in input order and by unique logical slot. A
successful, invariant-valid readback returns the original full `ImageMetadata`
rather than rebuilding its legacy map. No batch layer persists `Replace`, and
no frontend consumer uses reconciliation.

This path deliberately does not use the schema-keyed apply log; target-aware
logging remains pending. It is composed by the inactive v5 batch command and
frontend protocol adapter but has no production caller. Production apply,
persistence, `AppState`, frontend callbacks, dialogs, and logging remain schema
v4.

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

## Inactive versioned v5 batch apply

The backend now contains an inactive `apply_metadata_draft_edits_v5_cmd` with
no production frontend caller or listener. It performs `load v5 map once →
apply selected file → reconcile complete target outcomes → save changed
candidate map → emit versioned progress → continue at file boundary`. Loading
is strict; malformed,
v4, and unreadable draft files are errors rather than empty maps. Duplicate
requested paths reject before any event, write, or save, while absent and empty
paths are skipped without changing requested order.

Only one v5 batch apply command may be active. Acquisition checks and installs
the cancellation flag atomically under the v5 state mutex; a concurrent second
invocation returns a descriptive busy error before worker creation, loading,
started or progress events, metadata writes, or draft saves. Cancellation thus
signals the sole active v5 operation. Completion, a returned worker error, and
a worker join failure all release the state with an ownership-aware clear, so
the next invocation can acquire it. The v5 state is isolated from production
`ApplyEditsState` and does not change v4 command behavior.

Cancellation occurs only between files. A single-file hard failure with no
outcomes leaves drafts unchanged. Non-empty structured reconciliation is still
applied when semantic verification reports an error. Semantically unchanged
maps are not saved; a changed candidate becomes current only after a successful
complete-map save. Reconciliation and persistence failures emit progress for
the affected file and abort later files. Versioned progress carries complete
target outcomes, full authoritative occurrences, compatibility metadata, and
`persisted_draft_entries` as null/empty/non-empty for unchanged/removed/retained
state. V5 cancellation and events are isolated from v4. Target-aware logging is
still pending, and production persistence, apply, events, and UI remain v4.

The inactive `targetApplyTauri` adapter provides a strict frontend protocol
boundary for the apply/cancel commands and the two versioned events. Every
command result and event payload enters as `unknown`; validation recursively
covers semantic values, complete draft targets and edits, target outcomes,
reconciliation, full `ImageMetadata`, and persisted entries. Frontend
validation repeats the replacement invariant: only an original `NewProperty`
may be replaced, its replacement must be an `ExistingOccurrence`, and both
schemas must match exactly.

The same strict boundary requires unique exact identities inside every fresh
`ImageMetadata`: `occurrences` is keyed by the full `MetadataOccurrenceId`, and
the compatibility `metadata` projection is keyed by the full
`SchemaDefinitionId`. Exact duplicates invalidate the complete file result or
progress event, with both array indexes reported; no duplicate is removed and
no first entry is selected. Distinct same-schema IFD0/IFD1 occurrences,
different copies, and different documents remain valid, as do schema IDs that
differ by table, tag ID, or absent index versus index zero.

Ordinary scan events retain their separate lossy policy. Their normalizers may
drop malformed or duplicate occurrences, keep and deterministically order
valid siblings, emit the existing warning, and continue. Strict v5 apply
results and progress payloads instead reject the whole invalid file result.
The final command result remains authoritative for completed files.

Event subscription is separate from command invocation. Started/progress events
are optional immediate notifications rather than a completion ledger: event
emission failure is non-fatal, so the final command result is authoritative for
completed files and batch state. The events have no operation ID because the
backend admits only one active v5 command.

No production React listener, frontend store mutation, or `AppState` consumer
uses this adapter. Startup, autosave, persistence, and production apply remain
schema v4. Coordination with the independent v5 load/save commands and a future
v5 autosave policy remains required before activation.

### Inactive frontend result application

The inactive `targetApplyResults` module accepts a strict file result, prepares
all cloned candidates before mutation, then applies each independently
authoritative field. Non-null `persisted_draft_entries` replaces the complete
file in `TargetDraftEditsStore`; null leaves drafts unchanged because it means
no changed draft map was successfully persisted. Reconciliation kinds and the
`applied` flag never reconstruct or gate draft state.

Non-null `fresh_image_metadata` replaces both authoritative occurrences and
the temporary compatibility collection. This refresh still occurs when
semantic verification reports an error or a write warning accompanies valid
fresh metadata. Target outcomes are returned, defensively cloned, for future
verification handling and are not stored yet.

Exact store comparison makes progress followed by the identical final file
result a no-op with no second notification. Exact means full wire structure and
identity, not semantic metadata equality; a genuinely different final result
therefore remains able to overwrite progress state. Complete final results
validate and prepare every file before mutating the first store and retain file
order, cancellation, and abort status.

This module has no listener, Tauri invocation, autosave, React integration, or
production caller. It does not cause a second persistence write. Normal startup,
persistence, apply, and `DraftEditsStore` continue to use schema v4.

### Inactive frontend apply coordination

The inactive `TargetApplyControllerV5` composes the adapter and result engine
without activating either in production:

```text
local controller ownership
→ autosave suppression
→ versioned listener setup
→ versioned apply command
→ incremental strict progress application
→ disable progress acceptance
→ authoritative final application
→ listener cleanup and release
```

A local overlapping run is rejected before suppression, registration,
invocation, or mutation. Backend exclusivity remains authoritative across
processes and independent callers. Production activation must make this
controller the sole frontend v5 apply owner: the versioned events still have
no backend operation ID, so a unique local generation token rejects callbacks
from completed, failed, cancelled, or older controller runs.

Progress is supplemental. Its complete validated file result updates persisted
target drafts, authoritative occurrences, and compatibility metadata while the
autosave gate is held. The gate exists so a future subscriber can avoid saving
snapshots that the backend already persisted; it does not persist or subscribe
to anything yet. Malformed event records, progress-application failures, and
optional callback failures are contained while the command continues.

Immediately after the command resolves, progress acceptance is disabled before
the final result is applied authoritatively. A late queued event therefore
cannot overwrite final state. Exact equality suppresses duplicate store
notifications for identical progress and final snapshots, while genuinely
different final state replaces the progress snapshot. Command rejection does
not fabricate a final result or roll stores back. Listener cleanup is attempted
before suppression and ownership release on every path; an existing command or
final-application error is not masked by cleanup failure.

Cancellation calls the existing exact v5 adapter once while a signal is in
flight and keeps controller ownership and autosave suppression until the apply
command resolves or rejects. There is no React hook, `useMediaLibrary` caller,
`AppState` target store, v5 autosave subscriber, or production integration.
Production persistence and apply remain schema v4.
