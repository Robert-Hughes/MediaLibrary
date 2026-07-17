# Metadata pipeline

MediaLibrary has one production metadata-edit pipeline. It is schema-v5,
target-aware, and occurrence-based from draft creation through audit.

## Scan and presentation

The scanner returns authoritative `MetadataOccurrence` values with a semantic
`value` plus four independent identity, interpretation and targeting concerns:
runtime `id`, always-present exact `schema_id`, optional resolved `tag_info`, and
optional proven `write_target`. `TagInfo` supplies interpretation and labels; it
is not the source of occurrence schema identity. When present, `tag_info.id`
must exactly match `schema_id`, and malformed wire payloads are rejected rather
than repaired.

The names are intentionally precise: the friendly property label is for
people; `id.tag_id_scope` is the raw wrapped runtime table/ID/index scope;
`schema_id` is the resolved static semantic definition; `id` is the complete
runtime occurrence identity (document/sample, path, family-7 ID, wrapped scope
and copy); and `write_target` is the separately proven mutation selector.
Multiple occurrences may share a schema. No path may use that shared schema to
first-select one of them.

Usually wrapped scope and resolved schema are the same. LangAlt child
extraction demonstrates why both fields exist: the child scope remains in the
occurrence ID while `schema_id` resolves to the exact LangAlt parent.

Unknown registry schemas therefore remain in authoritative occurrence state as
an exact schema ID with null `TagInfo` and null write target. They can be shown
and diagnosed by table, tag ID and optional index, but remain read-only. Schema
identity alone cannot authorise a write.
`ImageMetadata` contains only authoritative occurrences. Schema-oriented list,
Details Pane, GPS, normalisation, overwrite, and column-frequency consumers
derive safe read-only schema views on demand. Identical ordinary values may be
collapsed and compatible LangAlt values merged; conflicting same-schema values
remain unavailable without affecting exact occurrence visibility. Schema
presence is resolved separately from value projection. No schema-keyed scan
wire field or second frontend metadata store remains.

Details Pane rows show exact pending target values, reopen editors from staged
semantic values, and keep same-schema siblings separate. Editors resolve complete
`ExistingOccurrence` or `NewProperty` targets before staging. Ambiguous and
read-only inputs fail without partial mutation.

`ExistingOccurrence` snapshots occurrence ID, resolved schema ID and a proven
runtime write target, then revalidates the complete snapshot before apply.
`NewProperty` stores the exact selected schema plus an intended complete
`MetadataWriteTarget { group1, group7, tag_name }`. Only family 1 is editable;
family 7 and tag name are generated from and validated against the selected
schema. A `MetadataWriteTarget` is the ExifTool selector; it is not proof that
ExifTool will instantiate the exact indexed definition selected by the user.

Runtime family 7 is not necessarily identical to the static schema tag ID.
Existing targets restore the complete family-7 group from the observed runtime
ID after the scanner's one-prefix removal. New targets derive it from the exact
static schema tag ID because no runtime occurrence exists yet. That schema
derivation preserves ASCII letters, digits, hyphen, and underscore and encodes
every other UTF-8 byte as two lowercase hexadecimal digits, matching ExifTool's
[`GetGroup` family-7 rules](https://exiftool.org/ExifTool.html#GetGroup).

New Property draft identity includes schema and complete destination. Multiple
same-schema destinations therefore coexist; unoverlayable destinations appear
as separate target-aware rows. Exact selector occupancy uses case-insensitive
family 1 + family 7 + tag name. A proven same-schema occurrence elsewhere is
allowed, while a same-schema occurrence without a proven target blocks creation
conservatively. The dialog's destination suggestions are advisory and unknown
valid family-1 tokens remain enterable.

## Draft state and persistence

One `TargetDraftEditsStore` owns frontend metadata drafts. Loading
`MediaLibraryTargetDraftEdits.jsonl` is strict: a load failure leaves the folder
in a blocked persistence state, disables metadata-draft mutation and apply, and
does not fall back. Opening another valid folder creates a safe fresh state.

Autosave serialises only complete target entries. The historical
`MediaLibraryDraftEdits.jsonl` file is ignored, not migrated, and never touched.

## Apply controller and backend

The frontend invokes only `apply_metadata_draft_edits_v5_cmd`, listens only for
the v5 started/progress contracts, and cancels only through
`cancel_apply_edits_v5`. `TargetApplyControllerV5` owns listener lifetime,
progress, cancellation races, autosave suppression, and authoritative result
parsing.

For each requested file, the backend:

1. loads and validates complete target drafts;
2. resolves exact writable occurrences or deliberate creations;
3. separates numeric and textual ExifTool passes;
4. writes a deterministic escaped UTF-8 argfile;
5. rereads authoritative metadata occurrences and compares exact schema plus
   intended family-1/family-7/tag-name selector identity;
6. verifies each semantic edit;
7. reconciles exact targets as Clear, Keep, Replace, or Blocked;
8. persists the reconciled target map; and
9. appends a target-aware audit record.

Successful files update authoritative frontend metadata incrementally. Failed
files retain drafts. Warnings are shown but are not failures. Verification rows
that need attention retain their complete target and allow accepting current
file state, keeping the draft, or discarding the pending draft where safe.

New Property verification succeeds only for exactly one occurrence with the
selected exact schema, intended family-1 destination, runtime-derived family 7,
canonical tag name, and expected semantic value. A changed schema index,
redirected destination, missing or duplicate exact result, silent ignore, or
semantic mismatch preserves the draft. Audit evidence retains the attempted
complete selector, selected schema, observed occurrence/schema identities, and
separates execution errors from readback-only verification failures.

ExifTool documents numeric group-family qualification and permits leading
family 1 and family 7 groups in its official
[tag-operations documentation](https://exiftool.org/exiftool_pod2.html#Tag-operations).

`MediaLibraryTargetApplyLog.jsonl` is the only active apply audit. The
historical `MediaLibraryApplyLog.jsonl` is ignored and left unchanged.

## Search projection

The list-search worker receives authoritative occurrence entries with exact
schema ID, semantic value, and runtime occurrence coordinates, plus full
target-draft search entries with exact schema ID and semantic edit. Resolved
group, name, and description labels enrich the indexed text. Initial snapshots,
incremental changes, deletion of a path's last draft, retries, stale-result
protection, and reserved property-like paths are supported.

This projection supports exact schema, runtime path/document/tag/copy fields,
friendly label, description, current value, staged value, and `has:edits`
queries. It is not an execution adapter and never merges or selects targets by
schema.

## Removed pipeline

The unversioned schema-keyed draft loader/saver, apply and cancel commands,
progress events, verification dialog, outcome reducer, batch orchestration, and
historical apply-log writer have been removed. Production contains no fallback
or conversion branch for that pipeline.

## Transient and persisted wire formats

Scan and readback `ImageMetadata` payloads contain `relative_path` and the
authoritative occurrence collection only. Removing the schema-keyed scan
projection does not change `MetadataDraftTarget`, target slot tokens, the
schema-v5 command or event names, reconciliation kinds,
`MediaLibraryTargetDraftEdits.jsonl`, or `MediaLibraryTargetApplyLog.jsonl`.
`ExistingOccurrence` targets persist their own schema/selector snapshot and
compare it directly with the authoritative occurrence. `NewProperty` persists
both schema and intended selector. The v5 shape changed in place with no draft
version migration or old-shape adapter.
