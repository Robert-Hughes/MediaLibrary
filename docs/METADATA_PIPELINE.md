# Metadata pipeline

MediaLibrary has one target-aware, occurrence-based metadata-edit pipeline from
scan through audit. The canonical identity definitions and target-first rule
are in the [metadata identity model](METADATA_IDENTITY_MODEL.md).

## Scan and presentation

The scanner returns authoritative `MetadataOccurrence` values containing the
runtime occurrence ID, exact schema ID, semantic value, optional resolved tag
information, optional observed selector and optional proven write target.
Malformed relationships are rejected rather than repaired. Unknown schemas
remain visible and diagnosable but read-only.

ExifTool's flattened LangAlt language accessors are scanner input fragments,
not independent occurrences. Fragments are consolidated within exact
document/path/copy and parent-runtime scope into one writable parent occurrence
whose value is the complete language map. Conflicting values for one language
produce one read-only `Unknown` parent occurrence.

`FileMetadata` contains only authoritative occurrences. Columns, sorting,
normalisation, overwrite, generated workflows and multi-field semantic editors
may derive deliberate schema-oriented read-only projections. Those projections
never decide the identity or ownership of an existing Details row.

The Details pane builds a pure occurrence-first presentation model before
rendering React components. Every authoritative occurrence becomes one
`ExistingOccurrenceRow`, including equal same-schema values. Pending New
Property drafts become `NewPropertyRow` values in their stored destination
group. Stored ExistingOccurrence operations whose occurrence is missing or
unsafe to select become target-only `MissingOccurrenceDraftRow` warnings.

Friendly grouping follows the runtime occurrence or intended destination and
is not identity. Search filters displayed rows but the map, GPS group menu,
removal and discard operations retain the complete unfiltered group. Every row
search document contains the friendly label, group, current and staged values,
status, schema diagnostics, complete occurrence diagnostics where applicable,
observed selector and write target.

An exact ExistingOccurrence draft overlays a row only when the occurrence ID is
unique and the complete stored target equals the target reconstructed from that
same current occurrence. A stale target remains visible with status, is not
overlaid or redirected, and can be discarded by its stored target. Missing and
duplicate occurrence operations remain target-only warnings. New Property rows
remain intended destinations even when occupied or otherwise unsafe.

One metadata-row component and one row-context-menu pathway handle all row
kinds. Existing rows expose edit, GPS, discard and remove actions only when the
complete target makes each action safe. New Property value editing preserves
the complete target; destination editing atomically replaces the exact original
target while retaining the semantic edit. Target-only warnings expose only
operations safe for their stored target.

A fresh grouped GPS editor resolves its six schema fields into complete
targets before it opens. Saving pairs semantic edits with those captured
targets, validates each target directly against current authoritative state and
applies the exact batch atomically. It does not plan a replacement destination
from a schema at save time. An individually targetable GPS occurrence can be
edited through its exact captured target even when another occurrence shares
its schema. Grouped GPS editing remains disabled when the six-member set is
ambiguous.

Details group removal calls the target-addressed removal planner with only the
complete targets assigned to that displayed group. Targetable existing rows
become exact Delete upserts, pending New Properties become exact cancellations,
already-staged Deletes are no-ops, and any stale, missing, duplicate or
conflicting target rejects the whole mutation. Schema-addressed column and
multi-file removal remain valid request boundaries and delegate to the same
exact-target invariants.

## Draft state and persistence

One `TargetDraftEditsStore` owns frontend drafts. The active store is
`<app-data>/MediaLibraryTargetDraftEdits.sqlite3`, with one row per canonical
absolute photo path and a JSON entry vector for that row. Loading an opened
folder is strict: a malformed row blocks draft mutation and apply and does not
fall back. Autosave validates and writes only changed rows in one transaction;
it never reads or serialises the complete draft collection.

Historical JSONL draft files are ignored and never touched. SQLite is the only
active draft store and there is no runtime import or fallback path.

## Apply controller and backend

The frontend invokes `apply_metadata_draft_edits_cmd` with a command-owned
Tauri channel and cancels through `cancel_apply_edits`. The channel carries one
started message, bounded progress batches and one compact completion summary.
It replaces the historical global Apply events, so messages are scoped to one
command and cannot be consumed by a later Apply. `TargetApplyController` owns
progress sequencing, cancellation races, autosave suspension, bounded retry
state and authoritative result application.

The command's ordinary terminal response contains only compact counters. A
full per-file result appears there only when sending that file's progress batch
through the channel failed, allowing the frontend to recover that exceptional
result without duplicating every successful payload. Normal Apply memory is
therefore bounded by one backend/frontend chunk plus the authoritative stores,
not by the total number of completed files. See
[Apply memory and ownership](APPLY_MEMORY_MODEL.md) for the detailed contract,
failure behaviour and measurements.

For each requested file, the backend:

1. loads and validates only the requested chunk's draft rows;
2. validates exact writable occurrences or deliberate creations;
3. renders every typed value into one deterministic escaped UTF-8 argument
   file;
4. writes that argument file in ExifTool raw (`-n`) mode;
5. re-reads authoritative occurrences;
6. verifies each semantic edit against the complete intended target;
7. reconciles exact targets as Clear, Keep, Replace or Blocked;
8. persists all changed rows in the chunk in one transaction; and
9. appends a target-aware audit record.

### IPTC IIM character-set safety

IPTC IIM text is safe for non-ASCII writes only when the effective
`IPTC:CodedCharacterSet` for that apply is UTF-8 (`UTF8`, corresponding to
the raw `ESC % G` marker). Before planning any non-ASCII IPTC property write,
the backend evaluates that marker using authoritative metadata plus only the
drafts included in the current apply. If the effective marker is missing,
ambiguous or anything other than UTF-8, planning rejects that property with
an error directing the user to the **IPTC UTF-8** normalisation group. ASCII
IPTC writes and deletes are unaffected.

The normalisation group stages an ordinary
`IPTC:CodedCharacterSet=UTF8` draft. When an apply changes the marker to
UTF-8, the planner derives same-value writes for existing non-ASCII IPTC
occurrences that are otherwise untouched. This apparently redundant behavior
is required because changing the marker does not make ExifTool transcode
existing IPTC bytes; without the rewrites, legacy bytes would merely be
reinterpreted as UTF-8. Explicit drafts in the current apply take precedence,
including list edits, which are rendered as a complete replacement while the
conversion is taking place. Drafts still staged in the application but not
selected for this apply are intentionally invisible to the planner.

Derived rewrites are transient write-plan targets. They are read back and
verified like explicit targets, and the target-aware audit records the
derivation reason and physical arguments. They are not stored as drafts and
do not participate in user-draft reconciliation.

A LangAlt `Set` replaces the complete map: the writer clears the parent first,
then emits one language-qualified assignment for every intended member. This
removes omitted languages. Ordinary strict readback verification applies
because the scanner returns the same complete parent value after writing.

Successful files update authoritative frontend metadata incrementally. Failed
files retain drafts. Verification rows retain their complete target and allow
accepting current file state, keeping the draft, or discarding the exact pending
draft where safe.

New Property verification normally succeeds only for exactly one occurrence
matching the intended exact schema and selector. The sole absence exception is
a requested semantic empty value: ExifTool represents `-TAG=` as deletion and
does not reliably retain zero-item XMP containers, so empty and absent readback
are intentionally equivalent. This rule is generic rather than property-specific
and is documented in `METADATA_FORMATS_DESIGN.md`. Changed index, redirected
destination, missing after a non-empty write, duplicate result, silent ignore,
and semantic mismatch preserve the draft. ExistingOccurrence apply validates
the full occurrence, schema and write-target snapshot; it never locates an
owner by schema. If an empty Set removes that exact occurrence, the same
empty/absent semantic rule clears the draft.

Multi-field editors may use schema IDs to enumerate semantic fields, but every
field resolves to a complete mutation target before the editor opens. A single
existing staged New Property target is already the destination and is preserved
exactly; the registered default destination is used only when there is neither
an authoritative occurrence nor an existing exact staged target. Multiple
possible staged destinations are ambiguous and are never first-selected.
Selector uniqueness is checked across authoritative occurrences, stored drafts
and every target in the incoming batch.

The central `<app-data>/MediaLibraryTargetApplyLog.jsonl` is the only active apply audit. Current schema-version 3 rows identify photos by canonical absolute `photo_path` and record one ordered argument vector and one raw write status for each exact target. Older rows remain append-only and are not
rewritten. The historical `MediaLibraryApplyLog.jsonl` is ignored and left
unchanged.

## Generated workflows

Describe, reverse-geocode and normalise jobs return transient
`SchemaMetadataEdit` values. The planner resolves each suggestion before a
target exists: it requires a unique existing occurrence, rejects multiplicity,
or deliberately creates a New Property target from the exact writable
`TagInfo`. Generated properties use the same schema-derived default-target
constructor as the Add New Property dialog; they do not have a separate manual
destination registry. If that exact writable definition is unavailable, the
generated batch is rejected rather than guessing a destination. Once planned,
only an exact matching target owner can be changed; same-schema siblings are
unrelated.

## Search service

Rust maintains the list-search index directly from the same authoritative
session transitions that commit files, metadata occurrences, target drafts,
post-write replacements and removals. Queries cross Tauri as small
session/request-tagged messages and results contain only matched relative paths;
the frontend retains presentation state and sorted-list ordering. Backend
refreshes are coalesced, stale revisions and sessions are rejected, and no
complete occurrence or draft collection is copied into JavaScript.
