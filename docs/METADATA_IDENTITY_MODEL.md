# Metadata Identity Model

This document locks the distinction between static schema identity, runtime
occurrence identity, and exact ExifTool write targeting. These are related but
independent concepts and must not be substituted for one another.

## Current production editing boundary

Add Property and uniquely resolved writable existing rows, including GPS
members, use the schema-v5 target store. An existing row is eligible only when its authoritative
`MetadataOccurrence` has non-null embedded `TagInfo`, that `TagInfo` is
writable, and the occurrence has a non-null runtime `MetadataWriteTarget`.
Production receives only the occurrence ID, rereads the authoritative
collection, rejects missing or duplicate exact IDs, and constructs this cloned
snapshot from that occurrence:

```text
ExistingOccurrence = occurrence ID + embedded schema ID + runtime write target
```

The current-value guard rereads the exact ID and requires all three snapshots
to still match. It never resolves a same-schema sibling, and `NewProperty` has
no current value. Exact target drafts therefore clear when a Set restores the
current occurrence value.

Persisted schema-v4 drafts are not converted. A v4 draft keeps display, discard,
and v4 apply ownership; exact-schema supplemental Edit and Remove stay
unavailable until it is applied or discarded. Read-only, unknown-schema,
missing-write-target, duplicate-ID, and persistence-load-failure states remain
read-only. While occurrences are loading, exact editing is unavailable and
existing v5 targets are shown as unresolved rather than overlaid by schema.

Every safely presented v5 target has an explicit destination. `NewProperty` and
uniquely resolved `ExistingOccurrence` targets retain ordinary-row
presentation, including a unique occurrence omitted by the compatibility
projection. When a schema has multiple authoritative occurrences, its complete
`ExistingOccurrence` target normally remains on the concrete **Additional Metadata
Occurrences** row instead. GPS is the deliberate exception: a multiply-resolved
GPS target stays unresolved and GPS supplemental rows remain read-only. The
non-GPS supplemental presentation key is exactly
`metadataOccurrenceIdToken(target.occurrence_id)`, so no schema-keyed ordinary
row is synthesized and a same-schema sibling remains a distinct supplemental
row.

Both destinations seed Set, Delete, ListAdd, and ListRemove from the exact
authoritative occurrence. Delete keeps the original struck through beside the
staged `—`; supplemental rows also expose exact Edit, Remove, and individual
Discard actions. A target is removed from the unresolved section only after
the final plan constructs its exact destination.

The current production bridge permits zero exact-schema target owners or one
identical complete `ExistingOccurrence` owner. Therefore, while occurrence A
owns a schema, same-schema supplemental occurrence B remains visible but is
blocked rather than replaced or first-selected. Discarding A makes B eligible
again. GPS supplemental rows remain read-only and are never selected by the GPS
target planner.

Opening an ordinary or supplemental non-GPS editor, or an individual unique GPS
editor, captures the selected occurrence ID and its
complete target snapshot. While open, the pane resolves that ID exactly and
requires one authoritative match, the same embedded schema and selector, and
compatible ordinary-row ownership. Loading, missing, duplicate-ID,
changed-schema, changed-selector, or ownership changes replace the editor with
a clear unavailable message and never invoke a setter. A same-schema sibling
cannot retarget the editor. Value-only refreshes explicitly reseed the editor
while preserving the captured ID, and Save passes that captured ID to the
production action.

Individual GPS Edit and Remove and the paired/map composite GPS editor use an
exact schema-v5 batch planner. Existing fields retain their authoritative
occurrence ID, embedded schema, and runtime selector; missing paired fields are
deliberate exact-schema `NewProperty` targets. The complete batch validates
occurrence cardinality and v4/v5 ownership before one target-store mutation.
The composite editor captures all six targets when it opens and refuses Save if
any destination changes. Persisted v4 GPS drafts are not converted and block
v5 editing for their group until applied or discarded. Manual group and
selected-photo field removal use schema v5. AI/geocode/normalise and other
generated backends retain schema-keyed semantic results; the frontend resolves
each complete per-file result against authoritative occurrences into exact v5
targets before persistence.
Ordinary and supplemental v5 outcomes share the existing target-aware verification pipeline;
Match/DeleteOk clear only the exact occurrence slot, while Keep/Blocked retain
it without reinterpreting or removing a schema sibling.

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
it is not duplicated inside `MetadataDraftTarget`. File-relative paths are
untrusted string keys, not JavaScript object mechanics. Frontend collections
therefore create and test own data properties only, never the prototype chain,
so reserved-looking filenames such as `__proto__`, `constructor`, and
`toString` survive unchanged.

`MetadataDraftTarget` and `MetadataDraftSlot` answer different identity
questions:

```text
target snapshot identity
    ExistingOccurrence = occurrence + schema + selector snapshot
    NewProperty        = schema

draft-slot identity
    ExistingOccurrence = occurrence only
    NewProperty        = schema only
```

The complete target snapshot is retained for later stale-target validation.
The slot identifies the one logical draft position within a file. Consequently,
two stale snapshots with the same `MetadataOccurrenceId` cannot become two
independent drafts merely because their schema or selector snapshots changed.
Existing-occurrence and new-property slots remain different variants even when
they carry the same schema. File-relative path is outer context, not a slot
field; the occurrence ID's family-5 `path` remains part of occurrence identity.

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

## Occurrence-aware apply foundation

`apply_edits_v5.rs` implements the single-file schema-v5 foundation used by
production target-aware operations:

```text
MetadataDraftEntryV5[]
→ authoritative pre-write occurrence read
→ exact target validation for the complete batch
→ structured selector-collision check
→ target-aware argument planners
→ numeric then text ExifTool passes
→ authoritative occurrence readback
→ strict post-write exact-occurrence-ID validation
→ target-aware semantic verification
```

All logical target slots are checked before target lookup, and every target is
planned and every argfile is rendered before the first write. Duplicate slots,
duplicate exact pre-write occurrence IDs, stale targets, and case-insensitive
`(group1, tag_name)` selector collisions reject the complete batch atomically.
Both the pre-write and post-write authoritative occurrence collections require
every exact `MetadataOccurrenceId` to be unique. A duplicate exact post-write ID
is a readback-invariant failure: no target is verified or cleared, and the
invalid `ImageMetadata` is not returned as fresh metadata. This is distinct
from an I/O readback failure because the read completed but its authoritative
identity collection was invalid.

An existing field resolves before and after writing only through its exact
`MetadataOccurrenceId`; a same-schema sibling is irrelevant. A new property
must be absent before writing. After writing it resolves to zero, one, or
multiple occurrences with the exact embedded schema identity. Zero is missing,
one is verified using that occurrence's actual value, and multiple is
ambiguous. Multiple results are never reduced to a first, lowest, `Copy0`,
`IFD0`, or writable occurrence.
Multiple distinct occurrence IDs sharing one schema remain a valid collection;
for a new-property readback they produce `AmbiguousPostWrite`. They are not the
same condition as multiple records sharing one exact occurrence ID, which
invalidates the complete readback before cardinality is evaluated.

Legacy projection omissions do not block this v5 reader because authoritative
occurrences remain complete and their exact IDs are unique. Verification and
post-write draft reconciliation are separate results. Every outcome retains the
complete original target and carries one explicit reconciliation:

```text
Clear    semantic success; remove the original logical slot
Keep     the original target remains retryable, or authoritative state is unknown
Replace  remove the original slot and retain the same edit against a supplied target
Blocked  retain the draft for user resolution, but do not treat it as immediately re-applicable
```

An existing target clears only for `Match` or `DeleteOk`. A non-clear semantic
result keeps the exact target while it remains present with the same schema and
selector. A missing existing occurrence, or one whose schema or selector has
changed, is blocked as stale; it is never retargeted to a same-schema sibling.

A `NewProperty` target cannot remain retryable once a unique occurrence has
been created. `Match` clears it. For a unique non-clear result, reconciliation
replaces it with an `ExistingOccurrence` target constructed from that fresh
occurrence's exact ID, embedded schema, and runtime selector while preserving
the original `MetadataDraftEdit`. If the fresh occurrence is read-only or has
no exact selector, reconciliation is blocked. Zero matches keep the creation
target; multiple matches block and include every distinct ID without selecting
a replacement. `ReadbackFailed` and `ReadbackInvalid` conservatively keep the
original target because authoritative state is unknown or unusable.

The single-file result still exposes `targets_to_clear`, derived only from
`Clear` reconciliations in input order and without duplicate logical slots.
The single-file helper does not persist replacement itself; the v5 batch
coordinator applies its structured reconciliation and persists the resulting v5
entries. The production target controller consumes those persisted snapshots.
The successful
result retains the scanner's complete `ImageMetadata`, including authoritative
occurrences and the temporary compatibility projection. The target-aware apply
log preserves schema identity, runtime occurrence identity, write selector,
observed created occurrence, and draft-reconciliation persistence as distinct
fields; none is collapsed into another. The target-aware path never forces
these records into the schema-keyed v4 log.

A successful `NewProperty` creation logs both the complete original creation
target and the exact uniquely created occurrence under `post_write: Unique`,
even when the proposed and persisted reconciliation is `Clear`. Ambiguous
creation readback retains every candidate in deterministic supplied order under
`post_write: Multiple` and chooses none.

The single-file module is composed by the registered v5 batch command. The
production frontend protocol adapter applies drafts created by Add Property,
manual ordinary and supplemental rows, GPS editors, group removal, and
selected-photo removal, plus fresh generated results resolved from schema-keyed
semantic edits to exact targets using authoritative occurrences. Schema-v5
operations append to the independent target-aware apply log; schema-v4
operations retain the legacy log.

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

The Details Pane resolves each ordinary schema identity explicitly to
`missing`, `unique`, or `multiple` when choosing a new editable row. A unique
resolution uses the authoritative occurrence value and embedded `TagInfo`; a
missing resolution retains the legacy compatibility value and schema lookup.
Multiple resolutions never select one runtime field. Each concrete occurrence
is shown separately in **Additional Metadata Occurrences**, while any existing
legacy compatibility row is marked ambiguous and cannot be edited or removed.
A targetable occurrence edits through its exact v5 target. When it owns
a draft, that draft stays on its occurrence-token row; siblings stay visible
and blocked. A uniquely resolved compatibility omission retains the ordinary
row exception instead.

An ordinary or supplemental editor captures its exact occurrence ID on open and continues by
exact-ID resolution, never by a later schema resolution. A value-only refresh
reseeds the editor for the same occurrence. Loading, missing, duplicate,
same-schema replacement, changed embedded schema, changed selector, or
incompatible row ownership prevents Save and surfaces an unavailable message.
Set drafts seed from the staged value, Delete from the exact current value, and
list operations from the effective staged semantic value when available.
Individual GPS rows use these same safeguards. The composite GPS editor instead
captures all six planned targets and revalidates the complete snapshot before
calling the GPS v5 batch action.

The file-level duplicate-occurrence scan failure is fixed: a lossy legacy
projection no longer blocks transport of the successful occurrence read.
An existing schema-level draft for a multiple resolution remains attached only
to the compatibility row and may be discarded, but it cannot be edited further
or copied onto concrete occurrence rows. This includes a Delete draft when the
ambiguous schema was omitted from the legacy projection: the pane synthesises
only the ambiguity-marked compatibility row so the draft remains visible and
discardable. Concrete occurrence rows remain draft-free and read-only. Authoritative scanner data is occurrence-aware; ordinary and supplemental manual rows use exact ExistingOccurrence targets; GPS individual and composite editors use exact v5 targets; manual group removal and selected-photo removal use exact v5 planning; Add Property uses NewProperty targets; fresh AI, reverse-geocode, normalise, and other generated results are resolved through authoritative occurrences to exact v5 targets before persistence; schema-v5 apply, verification, and logging retain complete targets; unknown-schema occurrences remain visible and read-only; already-persisted schema-v4 drafts are not automatically converted; target-aware apply logging uses its own append-only file.

`MetadataDraftTarget`, `MetadataDraftSlot`, and schema-v5 Tauri load/save
commands define the target-aware persistence boundary. The v5 JSONL line keeps
`relative_path` as outer context and stores a vector of `{ target, edit }`
entries. A frontend
collection, observable store, and Tauri adapter now mirror that boundary:

```text
file-relative path
→ metadataDraftTargetSlotToken(target)-keyed collection
→ complete MetadataDraftTarget + MetadataDraftEdit
```

The token is collection mechanics only, never domain identity; every entry
retains its complete target snapshot. Setting a different snapshot for the same
logical slot replaces the stored target and edit. The adapter validates every
unknown load result structurally and sends only deterministic
`MetadataDraftEntryV5[]` arrays. Rust persistence, frontend wire conversion,
and store reset reject duplicate logical slots. Persistence conversion and
reset also require each record key to equal its derived token, detect duplicate
values hidden under different malformed keys, and never silently re-key a
collection. Reset validates before replacing state, so failure is atomic and
silent. Reserved-looking outer paths remain ordinary domain data. Logical draft
identity is the target slot described above, never object-property behaviour.
The shared frontend semantic guard requires integral finite values for
`MetadataValue::Integer`, while `Real` continues to accept finite fractions;
`Unknown.raw` must be recursively JSON-compatible, and unit variants must keep
their generated no-content wire shape. All production schema-v5 operations,
including fresh AI, reverse-geocode, normalise, and other generated results, use
these guarantees before exact target resolution and v5 persistence.
A frontend/Tauri-contract test round-trips shared-schema IFD0/IFD1
occurrences and existing/new targets without collapsing them.

The Rust reconciliation helper applies already-computed outcomes to
one file's original v5 entry collection:

```text
original v5 entry
+ target outcome reconciliation
→ validated reconciled v5 entry collection
```

Every original logical slot requires exactly one outcome, and the outcome's
complete original target snapshot must equal the entry target; matching a slot
or schema alone is insufficient. `Clear` removes the slot, while `Keep` and
`Blocked` retain the exact target and semantic edit. A `Replace` is valid only
from `NewProperty` to the supplied exact `ExistingOccurrence`, must keep the
same `SchemaDefinitionId`, and preserves the original semantic edit rather than
any sent, observed, before, or display value. A replacement may not collide
with a retained slot, another replacement, or any other original operation,
including one marked `Clear`; any collision rejects the complete
transformation. Blocked reasons remain transient outcome information for a
future command and frontend to surface, not persisted draft state. The helper
performs no persistence itself; the production v5 batch coordinator persists
its result without changing schema-v4 persistence or apply.

Production creates the target-aware store and calls the v5 adapter for Add
Property, exact unique-row edits, individual/composite GPS edits, manual group
removal, selected-photo field removal, and fresh generated results after
authoritative target resolution. The v4 file remains independently owned by
already-persisted legacy drafts, including GPS drafts and any generated drafts
created before the generated-producer migration;
target-aware logging is independently owned by the schema-v5 batch boundary.

V4 entries are not automatically converted: a `SchemaDefinitionId` alone does
not reveal whether the intended operation edits an existing occurrence or
creates a new property. Choosing an occurrence would require forbidden
first-match logic. Existing v4 drafts remain in their own file and are never
converted. Add Property and exact unique-row operations produce and apply v5
drafts.

## Schema-v5 batch boundary

The versioned `apply_metadata_draft_edits_v5_cmd` is used by the production
target-aware controller. It strictly loads
the v5 map once (never substituting an empty map for malformed, v4, or unreadable data),
rejects duplicate requested paths before events or writes, retains requested
order, and selects only files with current non-empty drafts. Its flow is:

```text
load v5 map once
→ apply selected file
→ reconcile complete target outcomes
→ save changed candidate map
→ emit versioned progress
→ continue at file boundary
```

Command admission is exclusive within v5. `ApplyEditsV5State` checks and
installs the active cancellation flag atomically under one mutex, so only one
schema-v5 batch apply command can run at a time. A second invocation is
rejected as busy before its worker starts, which means it performs no draft
load, started or progress event, metadata write, or draft save. Cancellation
therefore always addresses the sole active v5 apply. Normal completion, worker
failure, and worker join failure clear the state with ownership checking so a
later invocation can acquire it. This state remains independent from the
production v4 apply state.

Cancellation is checked only between files. A hard failure with no outcomes
leaves drafts unchanged; complete structured outcomes are reconciled even when
semantic verification reports an error. Unchanged reconciliation is not saved,
and changed state is adopted only after its complete candidate map saves.
Reconciliation or persistence failure emits the affected result and aborts
later files. Progress transports complete target outcomes and full
`ImageMetadata`, including authoritative occurrences and the temporary
compatibility projection. `persisted_draft_entries` distinguishes no persisted
change (`null`), removal (`[]`), and retained/replaced entries. The command uses
isolated cancellation and versioned events and has no target-aware apply
logging. Every production schema-v5 operation consumes its state and events;
fresh generated results join this path after authoritative target resolution.

A frontend protocol adapter wraps
`apply_metadata_draft_edits_v5_cmd`, `cancel_apply_edits_v5`,
`apply_edits_v5_started`, and `apply_metadata_edits_v5_progress`. Command
results and versioned event payloads enter the adapter as `unknown`. The
boundary strictly validates complete nested targets, outcomes, structured
reconciliations, authoritative occurrences, compatibility metadata, and
persisted draft entries. It also rechecks that `Replace` changes a
`NewProperty` into an `ExistingOccurrence` with exactly the same schema identity.

Strict frontend v5 `ImageMetadata` validation also enforces collection
identity. Every authoritative occurrence must have a unique exact
`MetadataOccurrenceId` (`document`, complete path, tag ID, and copy), while
every compatibility entry must have a unique exact `SchemaDefinitionId`
(`table`, tag ID, and optional index). An absent schema index and index zero are
different identities. A repeated exact occurrence or schema identity
invalidates the complete file result or progress event; the adapter never
deduplicates the array or chooses a first entry. Distinct IFD0 and IFD1
occurrences, copy numbers, or document values remain valid even when they
share one schema.

This strict apply-result policy is intentionally different from ordinary scan
event normalization. Scan normalization is lossy: it may drop malformed or
duplicate exact occurrences, retain valid siblings, sort them, warn, and
continue. Apply command results and progress events are authoritative protocol
objects and reject the complete containing result instead. The final command
result remains authoritative when progress delivery is absent.

Listener registration is intentionally separate from invocation. Progress
events are supplemental immediate updates and can be absent because backend
event emission is non-fatal; the final command result is authoritative for the
completed-file list and batch status. No operation ID is needed because backend
admission permits only one active v5 apply and the global events describe that
sole operation.

The adapter itself remains framework-free. Production composes it with
`AppState`, the target store, strict v5 load/save commands, the v5 autosave
gate, and React listeners. Schema-v4 persistence and apply remain independently
active only for persisted legacy drafts. Fresh generated results use the v5
store and apply path after authoritative target resolution.

## Frontend v5 result application

A framework-free result engine sits behind the strict typed
file-result boundary:

```text
strict typed file result
→ prepare complete exact candidates
→ replace persisted target drafts when non-null
→ replace authoritative occurrences when non-null
→ replace compatibility metadata when non-null
→ return target outcomes for future verification handling
```

`persisted_draft_entries` is the sole authority for local target-draft
replacement. The frontend does not reimplement reconciliation: null means no
draft-map change was successfully persisted, an empty array removes that file,
and a non-empty array replaces its complete target-aware snapshot. Target
outcomes are defensively returned but are not yet stored as verification state.

Fresh metadata independently replaces both the ordered occurrence snapshot and
the schema-keyed compatibility projection, even when semantic verification
reported an error. Equality is exact structural equality, not display equality
or semantic numeric equivalence: for example rational `1/2` and `2/4` are
different authoritative snapshots. Record insertion order is irrelevant while
occurrence order and complete identities remain significant.

Progress and final results may repeat the same file. Exact current-store
comparison makes an identical repeat a notification-free no-op, while a
genuinely different final result remains authoritative and overwrites progress
state. The engine itself performs no Tauri call, subscription, autosave, or
React update; the production controller composes it for target-aware apply.

## Production frontend v5 apply controller

The framework-free `TargetApplyControllerV5` coordinates the complete
production frontend protocol for target-aware operations:

```text
local controller ownership
→ autosave suppression
→ versioned listener setup
→ versioned apply command
→ incremental strict progress application
→ disable progress acceptance
→ authoritative final application
→ listener cleanup and lifecycle release
```

Local ownership rejects an overlapping `run()` before autosave suppression,
listener registration, Tauri invocation, or store mutation. Backend admission
remains authoritative across other controllers, callers, and processes. The
controller is the sole frontend owner of every v5 apply invocation because the
global versioned events still carry no operation ID.
Each local run also captures a unique generation token so completed, failed,
cancelled, or older-run callbacks cannot affect a current run.

Started events update only observable controller progress. Valid progress is
supplemental and applies the strict complete file result through the existing
result engine while autosave is suppressed. Event protocol and local
application failures are recorded as structured data, callback failures are
contained, and none automatically cancels the command. The final command
result remains authoritative: progress acceptance is disabled before final
application, so queued late progress cannot overwrite final state. Exact
idempotency makes an identical progress/final pair notification-free, while a
genuinely different final snapshot replaces progress state.

`TargetDraftAutosaveGateV5` is an ownership-aware, idempotently released gate
for the production autosave subscriber. Suppression spans listener setup, all
backend-persisted progress and final snapshot installation, and listener
cleanup. The gate performs no persistence itself; the production store
subscriber checks it before saving.
All exit paths attempt cleanup before releasing suppression and local
ownership; command or final-application errors remain primary if cleanup also
fails. Cancellation is only a deduplicated signal to the exact v5 cancel
adapter and does not end ownership or release suppression before the apply
command settles.

`useMediaLibrary` owns one controller, target store, and autosave gate for its
lifetime, and loaded `AppState` exposes the distinct target snapshot and apply
state. Add New Property and exact unique-row operations use this draft path and
the same target-aware verification; legacy producers retain v4 verification.

## Production schema-v5 activation

Add New Property is the first production editor to use exact target identity.
It creates a `NewProperty` target containing the schema picker's complete
`SchemaDefinitionId` (including the distinction between no index and index
zero), stores it in the production `TargetDraftEditsStore`, persists it through
schema-v5 commands, and applies it only through `TargetApplyControllerV5`.
Backend reconciliation may replace that target with a complete
`ExistingOccurrence`; the Details Pane continues to edit and discard that exact
replacement target, including its occurrence ID and write selector.

Unique writable metadata rows, including individual GPS members, also create `ExistingOccurrence` targets
from their authoritative occurrence and use exact current-value comparison.

This is a temporary bridge organised by operation type. Individual and
composite GPS editing, manual group and selected-photo field removal, and fresh
AI description, geocode, normalise, and other generated results use v5. The
generated backends remain schema-keyed, while the frontend resolves each
complete result against authoritative occurrences before creating exact target
drafts. No generic schema-to-occurrence inference for persisted drafts or
v4-file conversion was introduced. A file and
exact schema cannot be owned by both systems: creation and combined apply reject
the collision without deleting or converting either draft. The narrow Add
Property view also refuses to first-select when multiple target-aware existing
occurrences share one schema; target-aware verification acts only through the
complete persisted target selected by reconciliation.

### Exact manual removal

Details Pane group removal and Photo List selected-photo field removal plan
only exact schema-v5 mutations. Their previews are derived from the same pure
planner used by execution; selected-photo execution still re-plans every file
after confirmation. Every requested file must have authoritative occurrences
loaded, and a multi-file action plans every file before the target store
mutates. A uniquely resolved writable occurrence becomes an
`ExistingOccurrence` Delete using its occurrence ID, embedded schema ID, and
runtime selector. A v5 Set or list draft on that exact target is replaced by
Delete. An already identical exact Delete is a no-op and stays staged. A
missing field with one exact `NewProperty` owner cancels that pending creation;
a genuinely absent field is a no-op.

Missing exact schemas are never recovered by identity guessing. Unknown
occurrences remain visible and read-only through their own presentation, but
their tag ID, path, friendly name, group, or value shape is never compared to a
missing schema. In particular, a runtime tag ID is local to its ExifTool table
and cannot establish schema correspondence alone.

Multiple authoritative occurrences, read-only exact fields, missing write
targets, stale or incompatible ownership, multiple exact-schema owners, and
persisted schema-v4 ownership block the complete requested action. Nothing
first-selects an occurrence or converts a persisted v4 draft. Group discard may
clear exact group members from both stores, using schema IDs for v4 and
captured complete targets for v5. Each changed store saves only its own
persistence file. Details Pane and Gallery no longer receive a generic v4
batch setter.

The target store also enforces exact schema ownership for Add Property. With no
target-aware entry, Add Property creates one `NewProperty` slot. One existing
`NewProperty` is edited in that same logical slot. Any `ExistingOccurrence`, or
multiple target entries of any kinds sharing the exact schema, blocks creation
as already owned or ambiguous. The picker excludes every target-owned schema,
including ambiguous sets, while exact identity continues to distinguish an
absent index from index zero.

Strict v5 loading has a folder-scoped persistence state. A valid empty load is
`ready`. A failed load is `load-failed(error)`: the target store remains empty,
the invalid file stays untouched, and target mutation, autosave, apply, and Add
Property are blocked until the file is fixed and the folder is reopened. This
does not block schema-v4 editing, persistence, or apply.

The persistence files are deliberately independent. Schema v4 exclusively owns
`MediaLibraryDraftEdits.jsonl`; schema v5 exclusively owns
`MediaLibraryTargetDraftEdits.jsonl`. Both maps may contain the same folder and
relative path. Folder opening loads v5 first so that, only when the target file
is absent, a completely valid all-v5 file left at the old shared path can be
strictly validated and atomically renamed before v4 loads. Valid v4 and
comment-only old files are not migrated. Mixed, malformed, duplicate, legacy,
or unsupported shared data is preserved and rejected as unsafe to classify.

V5 progress and authoritative final results invalidate React metadata sorting
only when their application summary reports `compatibilityChanged`. Exact
progress/final repetition is a no-op; a different final result invalidates
again. Conversely, any v4 write result with fresh compatibility metadata marks
that file's occurrence collection unavailable because v4 cannot transport a
complete authoritative collection. In a mixed same-file v5-then-v4 apply, the
final UI therefore shows fresh v4 compatibility metadata and never treats the
pre-v4 v5 occurrences as current.

## Production target-aware verification

Schema-v5 production results now produce session-only verification state.
Identity is the relative path plus
`metadataDraftTargetSlotToken(currentTarget)`, while each value retains the
complete original and current target snapshots. `Clear` creates no pending
diagnostic. `Keep` and `Blocked` act through the original target; `Replace`
acts through the exact persisted replacement `ExistingOccurrence`, preserving
occurrence ID, schema ID, and runtime write selector. Verification outcomes are
derived during store-independent preparation. Before storage, the current slot
must exist in the effective draft snapshot and its complete target must compare
equal. A non-null persisted snapshot validates against exactly that backend
candidate; null validates against the current stored file collection. Every
file in a final batch validates before the first store mutation, so an invalid
contract preserves all prior draft, verification, occurrence, and compatibility
state without notifying listeners.

Progress results are supplemental; every completed file in the final command
result authoritatively replaces that file's verification collection in final
order. Exact repetition is a no-op. Acceptance removes the exact pending target
draft and is offered only when the backend supplied an authoritative observed
value. An observed `MetadataValue::Null` is authoritative; an absent observed
value is not. Readback failure, invalid readback, missing post-write state,
blocked reconciliation, and future outcomes without observed state offer exact
discard instead. Keep remains available and dismisses only the diagnostic.
Blocked targets are never repaired or schema-resolved automatically. Draft
changes prune only verification entries whose complete current target has
disappeared or changed.

Backend file errors and warnings are presented before frontend store
application. They remain visible when pure verification validation rejects a
progress or final result; the frontend contract error is recorded separately
and does not replace a persistence, write, or readback diagnostic.

This state is not persisted and remains separate from schema-v4 verification.
The target dialog takes precedence while it has entries; the v4 dialog may
appear after it empties. Target-aware verification applies to every production
schema-v5 operation, including generated AI, reverse-geocode output, and
normalise results. Their backends remain schema-keyed semantic producers, but
the frontend resolves exact ExistingOccurrence or NewProperty ownership using
authoritative runtime context. Persisted legacy drafts and their verification
remain v4 without conversion; schema-v5 apply evidence uses the separate
target-aware log.
