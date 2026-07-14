# Metadata Pipeline Guidance

This document holds operational rules for the metadata pipeline. For the full type-flow design, see `docs/METADATA_FORMATS_DESIGN.md`.

## Current row-edit flow

Opening a new ordinary non-GPS Details Pane editor requires a unique schema
resolution whose authoritative occurrence carries writable embedded `TagInfo`
plus a runtime write target. The editor captures that exact occurrence ID and
complete target snapshot. Save passes the captured ID to the production action;
it never re-resolves an occurrence from schema identity. The action requires v5
persistence readiness, loaded occurrences, one exact ID match, targetability,
no exact-schema v4 owner, and safe target-aware ownership before writing a
cloned `ExistingOccurrence` to `TargetDraftEditsStore`.

Target ownership is deliberately strict: no same-schema target entry creates
the exact slot; one entry may be updated only when its complete target equals
the current occurrence target; any `NewProperty`, different occurrence, stale
snapshot, or multiplicity blocks the row. Overlay uses the same complete-target
check. Incompatible targets remain visible in the unresolved target section.

The presentation boundary is target-aware as well. A complete existing target
that still matches one exact authoritative occurrence receives one ordinary
draft row even when compatibility omitted that schema. This applies to Set,
Delete, ListAdd, and ListRemove. The row's original value comes from the exact
occurrence; Delete remains visible as original-value strike-through followed by
`—` and keeps individual discard. Presented ownership is recorded by exact
`metadataOccurrenceIdToken`, never schema, selector text, or a first sibling.
The supplemental view excludes only those exact tokens, so same-schema
siblings remain read-only there. No target means no ordinary-row exception.
Unresolved classification is derived from the final constructed presentation
plan rather than inferred from target compatibility alone.

The target store's current-value resolver reads only
`ImageMetadataOccurrencesStore`: loading, missing/duplicate IDs, changed schema
or selector snapshots, and `NewProperty` resolve to `undefined`. Restoring the
exact current value removes only that occurrence draft. V5 autosave writes only
`MediaLibraryTargetDraftEdits.jsonl`; exact target discard does the same.
Legacy discard writes only `MediaLibraryDraftEdits.jsonl`.

Persisted v4 row drafts remain visible and apply/discard through v4, but block
ordinary Edit and Remove and are never converted. GPS members and paired GPS
writes, group/bulk operations, and generated producers remain v4. Missing,
unowned multiple, untargetable, and loading occurrences are read-only;
supplemental duplicate-schema rows remain read-only. Combined apply remains v5
then v4 with the exact-schema cross-system guard, and ordinary row outcomes use
the existing target-aware verification pipeline.

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

An ordinary editor resolves only the exact occurrence ID captured when it was
opened. It requires authoritative occurrences to remain loaded, exactly one ID
match, the same embedded schema and exact write selector, continued
targetability, and compatible row ownership. Loading, missing, duplicate-ID,
same-schema replacement, changed selector, changed schema, or ownership change
closes the interactive editor, shows a clear unavailable message, preserves all
drafts, and invokes no setter. A value-only change for the same target
explicitly refreshes the editor and still saves the captured ID. Set initializes
from its staged value; Delete from the exact current occurrence value; list
intents use their effective staged semantic value when available. GPS retains
the legacy compatibility-based initialization and schema-v4 callbacks.

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
write targets exist. Legacy drafts and verification remain schema-keyed; the
Add Property bridge keeps exact target identity separately.

Genuine read, parse, canonicalisation, or projection-invariant failures still
emit empty collections to clear loading state and report details through
`worker_error`.

## Locked Draft Target Model

`MetadataDraftTarget` locks the distinction used by the production Add Property
bridge and future producer migrations:

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

The `apply_edits_v5.rs` single-file path composes those planners into the
occurrence-aware apply flow used by production Add Property:

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

The pure Rust reconciliation engine consumes those already-computed structured
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
logging remains pending. It is composed by the v5 batch command and production
frontend protocol adapter for Add Property. Remaining editor callbacks,
verification, and logging remain schema v4.

Schema-v5 Tauri load/save commands parse and serialize lines with a
file-relative path as outer context and target-aware `{ target, edit }` entries.
The production frontend v5 collection, observable store, and command adapter
use the parallel shape:

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

Production creates the target store and imports the adapter for Add Property
and unique non-GPS existing rows.
Startup loads its v5 persistence before the independent schema-v4 map, and
`AppState` exposes both. Exact ordinary Details Pane rows and verification
consume `MetadataDraftTarget`; the search-worker counts both draft systems.
GPS and batch/generated producers remain schema v4.

A v4 schema ID cannot be converted automatically into an existing-occurrence
or new-property target without authoritative runtime context. In particular,
selecting a first occurrence would violate the occurrence identity rules.
There is no automatic v4-to-v5 semantic conversion; the one-time file migration
only relocates data that is already strictly schema v5.

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

## Versioned v5 batch apply

The backend `apply_metadata_draft_edits_v5_cmd` has a production frontend
caller and listener for Add Property. It performs `load v5 map once →
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
state. V5 cancellation and events are isolated from v4. Target-aware logging
and all non-Add-Property producers remain v4.

The `targetApplyTauri` adapter provides a strict frontend protocol
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
uses this adapter. The production Add Property controller composes it with the
independent v5 persistence and autosave gate; other operations remain schema v4.

### Frontend result application

The `targetApplyResults` module accepts a strict file result, prepares all
cloned candidates and derives target-verification outcomes without store access,
then validates those outcomes against the effective draft snapshot before
mutation. Non-null `persisted_draft_entries` replaces the complete
file in `TargetDraftEditsStore`; null leaves drafts unchanged because it means
no changed draft map was successfully persisted. Reconciliation kinds and the
`applied` flag never reconstruct or gate draft state.

Non-null `fresh_image_metadata` replaces both authoritative occurrences and
the temporary compatibility collection. This refresh still occurs when
semantic verification reports an error or a write warning accompanies valid
fresh metadata. Prepared verification outcomes are defensively cloned and
installed only after their current slot and complete target match the effective
drafts. A non-null backend draft snapshot is the sole candidate for that file;
a null snapshot validates against the existing stored collection.

Exact store comparison makes progress followed by the identical final file
result a no-op with no second notification. Exact means full wire structure and
identity, not semantic metadata equality; a genuinely different final result
therefore remains able to overwrite progress state. Complete final results
strictly parse and prepare every file, then validate every verification contract
against the current global draft snapshot plus its own effective per-file
candidate before mutating the first store. An invalid file preserves every
prior frontend store and emits no notification. Successful batches retain file
order, cancellation, and abort status.

This pure module has no listener, Tauri invocation, autosave, or React
integration of its own. The production controller calls it without causing a
second persistence write; legacy `DraftEditsStore` operations remain schema v4.

### Production frontend apply coordination

`TargetApplyControllerV5` composes the adapter and result engine for production
target-aware applies:

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
processes and independent callers. The controller is the sole frontend v5 apply
owner: the versioned events still have
no backend operation ID, so a unique local generation token rejects callbacks
from completed, failed, cancelled, or older controller runs.

Progress is supplemental. Its complete validated file result updates persisted
target drafts, authoritative occurrences, and compatibility metadata while the
autosave gate is held. The production subscriber therefore avoids saving
snapshots that the backend already persisted. Malformed event records,
progress-application failures, and optional callback failures are contained
while the command continues. Backend file errors and warnings are counted and
presented before progress application, and final diagnostics are presented
before authoritative final application. Per-run path/message deduplication
keeps progress/final repetition idempotent. A frontend verification-contract
failure is reported separately and never replaces the backend persistence,
write, or readback diagnostic.

Immediately after the command resolves, progress acceptance is disabled before
the final result is applied authoritatively. A late queued event therefore
cannot overwrite final state. Exact equality suppresses duplicate store
notifications for identical progress and final snapshots, while genuinely
different final state replaces the progress snapshot. Command rejection does
not fabricate a final result or roll stores back. Listener cleanup is attempted
before suppression and ownership release on every path; an existing command or
final-application error is not masked by cleanup failure.

Verification acceptance requires an authoritative observed value, including an
explicit `MetadataValue::Null`. Readback failure, invalid readback, missing
post-write state, blocked reconciliation, and other outcomes without observed
state offer exact-target discard plus keep, never acceptance.

Cancellation calls the existing exact v5 adapter once while a signal is in
flight and keeps controller ownership and autosave suppression until the apply
command resolves or rejects. `useMediaLibrary` owns the stable production
instance and publishes its separate target/apply state. Target-aware
verification covers all production schema-v5 operations, including exact
ordinary existing-row editing. GPS and other legacy producers still use
schema-v4 persistence, apply, and verification.

## Temporary production v4/v5 editing bridge

Production now owns one stable `TargetDraftEditsStore`, one
`TargetDraftAutosaveGateV5`, and one `TargetApplyControllerV5`. Schema v4 owns
`MediaLibraryDraftEdits.jsonl`; schema v5 owns
`MediaLibraryTargetDraftEdits.jsonl`. Both files and both maps may coexist for
the same folder and relative path. Folder opening awaits strict v5 loading
before independently attempting v4, so migration can finish before the v4 path
is examined. A valid empty v5 load is writable. A malformed, v4, or
future-version payload in the new v5 file places that
folder in `load-failed(error)`: the error remains visible, the in-memory target
store stays empty, and the invalid persistence file is never saved, truncated,
or replaced. Target-aware mutation, autosave, apply, and Add Property remain
blocked until the file is fixed and the folder is reopened. Schema-v4 actions
remain available. A different successfully loaded folder gets its own `ready`
state. Folder switch and close clear target state and keep autosave bound to the
current folder.

When the new v5 file is absent, the v5 loader classifies the old path. An
all-v5 file is fully validated for line shape, duplicate paths, and duplicate
slots, then atomically renamed without reserialization. A valid all-v4 file or
an empty/comment-only file is not migrated. Mixed versions, malformed apparent
v5 data, duplicates, unversioned lines, and unsupported versions are preserved
and rejected with an unsafe-classification migration error. Once the new v5
file exists, it is loaded strictly and the old path is never consulted for
target entries.

User target mutations save the complete schema-v5 map. Authoritative
`persisted_draft_entries` snapshots applied by the controller still update
React state, occurrence metadata, and the compatibility metadata store, but the
autosave gate suppresses a duplicate frontend save while those snapshots are
being applied. Result metadata is consumed directly by the existing strict v5
result engine. `Clear` outcomes disappear via persisted snapshots; `Keep`,
`Replace`, and `Blocked` remain as target drafts. They are not projected into
the schema-v4 verification collection. Instead, production derives a separate
target-aware, session-only verification collection after validating each exact
current target against this authoritative persisted snapshot.

Combined apply runs target-aware v5 paths first and legacy v4 paths second,
sequentially under one modal. Progress names the active phase, and cancellation
is sent only to that phase. An exact file/schema collision rejects before either
command. Draft counts, Apply All, Discard All, per-file commands, and
`has:edits` aggregate both stores, while target records remain separate rather
than being flattened into the legacy schema map.

Add Property creates a `NewProperty` only when no target-aware entry owns the
exact schema. Exactly one existing `NewProperty` is replaced in the same slot.
An `ExistingOccurrence` owner or any multiple-entry resolution rejects the
operation without mutation or legacy fallback. The picker excludes schemas
from metadata, applicable legacy drafts, and every target-aware draft,
including ambiguous resolutions. All checks use complete
`SchemaDefinitionId`; absent index and index zero stay distinct.

The controller uses `compatibilityChanged` from each application summary to
increment React `metadataVersion`, so image-field sorts respond to v5 progress
and final-only results. Idempotent identical progress/final application does not
double-invalidate; a genuinely changed final result does. Draft-only changes do
not invalidate metadata sorting.

Every v4 progress result containing fresh compatibility metadata invalidates
the same path in `ImageMetadataOccurrencesStore`. The compatibility result
remains installed, but the occurrence state becomes unavailable rather than an
empty array. A later scan or full v5 result can restore authoritative
occurrences. For a same-file mixed apply, the later v4 phase therefore leaves
fresh v4 compatibility visible and invalidates the earlier v5 occurrence
collection; the Details Pane cannot overlay a stale occurrence value.

The production v5 draft producers are Add New Property and uniquely resolved
writable non-GPS existing rows. The explicit v4 producers are GPS editing,
bulk remove-field,
AI description, geocode, normalise, and other batch-generated drafts. Schema-v4
persistence, apply logging, and verification remain in service for them.

## Target-aware v5 verification flow

For every production v5 operation, each valid v5 file result is processed as:

```text
persisted_draft_entries
→ authoritative target draft file snapshot
→ derive non-Clear current targets
→ validate exact file/slot/complete-target presence
→ authoritatively replace that file's verification entries
```

`Clear` produces no pending verification. `Keep` and `Blocked` retain the
submitted target. `Replace` uses the exact replacement `ExistingOccurrence`;
the submitted `NewProperty` survives only as explanatory context. No schema
lookup, occurrence enumeration, or first-match selection participates.

Progress is supplemental. Final results repeat derivation and replacement for
every completed file in final-result order; exact progress/final repetition is
a no-op and a genuinely different final result wins. File errors and warnings
are presented with the affected relative path and exact per-run deduplication.
Semantic file failures contribute to v5 apply progress independently of
protocol and local application failures.

The target dialog offers accept-file-state (remove the exact target draft),
keep-draft (dismiss only the diagnostic), and discard-draft (remove the exact
draft and diagnostic). Blocked or missing states use conservative discard
wording and never auto-retarget. Draft removal autosaves only
`MediaLibraryTargetDraftEdits.jsonl`; legacy verification continues to affect
only `MediaLibraryDraftEdits.jsonl`. Target verification is session-only,
separate from v4, and shown ahead of the v4 dialog. Ordinary row editing remains
v4.
