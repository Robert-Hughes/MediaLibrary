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

## Inactive occurrence-aware apply foundation

`apply_edits_v5.rs` implements an inactive single-file schema-v5 foundation:

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
Replacement persistence is not implemented: no batch coordinator or frontend
consumer removes or inserts drafts yet. The successful result retains the
scanner's complete `ImageMetadata`, including authoritative occurrences and
the temporary compatibility projection. Target-aware apply logging remains
pending; the inactive path does not force targets into the schema-keyed v4 log.

There is no Tauri apply command or production caller for this module.
Production apply, persistence, `AppState`, frontend behavior, and logging
remain schema v4.

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

`MetadataDraftTarget`, `MetadataDraftSlot`, and inactive schema-v5 Tauri
load/save commands now define the persistence boundary for the upcoming draft
migration. The inactive v5 JSONL line keeps `relative_path` as outer context
and stores a vector of `{ target, edit }` entries. An inactive frontend
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
their generated no-content wire shape. These are inactive schema-v5 boundary
guarantees only: production persistence remains schema v4, the target-aware
store is not in `AppState`, and the occurrence-aware apply foundation has no
production caller or command.
A frontend/Tauri-contract test round-trips shared-schema IFD0/IFD1
occurrences and existing/new targets without collapsing them.

The inactive Rust reconciliation helper applies already-computed outcomes to
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
performs no persistence, has no Tauri command or production caller, and does
not change schema-v4 production persistence or apply.

Command registration does not mean production usage. No production component
creates this target-aware store or calls the v5 adapter or commands. Production
startup, `AppState`, `DraftEditsStore`, autosave and apply remain schema-keyed
v4, as do Details Pane callbacks, Add Property, apply/write, verification,
search-worker indexing, and current draft files. V4 and v5 commands share one
filename and must never be mixed in one live folder session.

V4 entries are not automatically converted: a `SchemaDefinitionId` alone does
not reveal whether the intended operation edits an existing occurrence or
creates a new property. Choosing an occurrence would require forbidden
first-match logic. Pending v4 drafts must therefore be recreated after a future
v5 migration, and activating v5 apply remains pending.

## Inactive schema-v5 batch boundary

The versioned `apply_metadata_draft_edits_v5_cmd` is registered for testing and
future migration work but has no frontend caller. It strictly loads the v5 map
once (never substituting an empty map for malformed, v4, or unreadable data),
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

Cancellation is checked only between files. A hard failure with no outcomes
leaves drafts unchanged; complete structured outcomes are reconciled even when
semantic verification reports an error. Unchanged reconciliation is not saved,
and changed state is adopted only after its complete candidate map saves.
Reconciliation or persistence failure emits the affected result and aborts
later files. Progress transports complete target outcomes and full
`ImageMetadata`, including authoritative occurrences and the temporary
compatibility projection. `persisted_draft_entries` distinguishes no persisted
change (`null`), removal (`[]`), and retained/replaced entries. The command uses
isolated cancellation and versioned events, has no target-aware apply logging,
and switches no production state or event; production remains schema v4.
