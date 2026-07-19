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

`ImageMetadata` contains only authoritative occurrences. Columns, sorting,
normalisation, overwrite, generated workflows and composite semantic editors
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

A fresh composite GPS editor resolves its six schema fields into complete
targets before it opens. Saving pairs semantic edits with those captured
targets, validates each target directly against current authoritative state and
applies the exact batch atomically. It does not plan a replacement destination
from a schema at save time. An individually targetable GPS occurrence can be
edited through its exact captured target even when another occurrence shares
its schema. Composite GPS editing remains disabled when the six-member set is
ambiguous.

Details group removal calls the target-addressed removal planner with only the
complete targets assigned to that displayed group. Targetable existing rows
become exact Delete upserts, pending New Properties become exact cancellations,
already-staged Deletes are no-ops, and any stale, missing, duplicate or
conflicting target rejects the whole mutation. Schema-addressed column and
multi-file removal remain valid request boundaries and delegate to the same
exact-target invariants.

## Draft state and persistence

One `TargetDraftEditsStore` owns frontend drafts. Loading
`MediaLibraryTargetDraftEdits.jsonl` is strict: a failure blocks draft mutation
and apply for that folder and does not fall back. Autosave serialises only
complete target entries using persisted draft schema version 5.

The historical `MediaLibraryDraftEdits.jsonl` file is ignored, not migrated,
and never touched.

## Apply controller and backend

The frontend invokes `apply_metadata_draft_edits_cmd`, listens for
`apply_edits_started` and `apply_metadata_edits_progress`, and cancels through
`cancel_apply_edits`. `TargetApplyController` owns listener lifetime, progress,
cancellation races, autosave suspension and authoritative result parsing.

For each requested file, the backend:

1. loads and validates complete target drafts;
2. validates exact writable occurrences or deliberate creations;
3. separates numeric and textual ExifTool passes;
4. writes a deterministic escaped UTF-8 argument file;
5. re-reads authoritative occurrences;
6. verifies each semantic edit against the complete intended target;
7. reconciles exact targets as Clear, Keep, Replace or Blocked;
8. persists the reconciled target map; and
9. appends a target-aware audit record.

A LangAlt `Set` replaces the complete map: the writer clears the parent first,
then emits one language-qualified assignment for every intended member. This
removes omitted languages. Ordinary strict readback verification applies
because the scanner returns the same complete parent value after writing.

Successful files update authoritative frontend metadata incrementally. Failed
files retain drafts. Verification rows retain their complete target and allow
accepting current file state, keeping the draft, or discarding the exact pending
draft where safe.

New Property verification succeeds only for exactly one occurrence matching
the intended exact schema and selector. Changed index, redirected destination,
missing or duplicate result, silent ignore, and semantic mismatch preserve the
draft. ExistingOccurrence apply validates the full occurrence, schema and
write-target snapshot; it never locates an owner by schema.

Composite editors may use schema IDs to enumerate semantic fields, but every
field resolves to a complete mutation target before the editor opens. A single
existing staged New Property target is already the destination and is preserved
exactly; the registered default destination is used only when there is neither
an authoritative occurrence nor an existing exact staged target. Multiple
possible staged destinations are ambiguous and are never first-selected.
Selector uniqueness is checked across authoritative occurrences, stored drafts
and every target in the incoming batch.

`MediaLibraryTargetApplyLog.jsonl` is the only active apply audit. The
historical `MediaLibraryApplyLog.jsonl` is ignored and left unchanged.

## Generated workflows

Describe, reverse-geocode and normalise jobs return transient
`SchemaMetadataEdit` values. The planner resolves each suggestion before a
target exists: it requires a unique existing occurrence, rejects multiplicity,
or deliberately creates a New Property target when a valid destination is
known. Once planned, only an exact matching target owner can be changed;
same-schema siblings are unrelated.

## Search projection

The search worker receives authoritative occurrence fields, complete target
drafts, semantic values and friendly labels. Initial snapshots, incremental
changes, last-draft deletion, retries, stale-result protection and reserved
paths are supported. Search never owns execution identity.
