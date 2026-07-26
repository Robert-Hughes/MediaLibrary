# Metadata Normalisation — Implementation Plan

Add a "Normalise Metadata" batch feature to Media Library. For each selected
image, walk a set of **field groups** (semantically equivalent tags spread
across XMP / IPTC IIM / EXIF namespaces), derive a canonical value per group
from the current data + existing drafts, and stage **draft edits** that bring
every field in the group into sync. Architecture mirrors the AI-description
and reverse-geocode flows; shared batch infrastructure is reused and refactored
where helpful.

## 1. Field groups

A **group** is a set of tags that the spec treats as semantically equivalent.
Each group has:

- A **primary field** that holds the canonical value losslessly (richest
  datatype, modern namespace).
- A set of **derivative fields** that mirror the primary; each derivative
  declares how to project the primary value into its datatype (LangAlt,
  ASCII-fold, IIM length limit, etc.).
- Optional **read-only input fields** — read for context when computing the
  canonical value, never written.
- A **conflict policy** for when sources disagree.
- A **normalisation rule** for the canonical form (case, separator, tone).

The user enables groups individually via per-group checkboxes in the confirm
dialog. Unchecked groups are skipped.

### Conflict policy summary

Conflict handling is group-specific. A counted conflict is a user-visible
stat/warning path, not necessarily a blocker. Description is the only group
that currently blocks deterministic edits when conflicting target sources need
AI and the AI call is unavailable or fails.

| Group         | Policy                                                                                                                                                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Keywords    | No conflict concept; union all sources and project canonical bag/leaves.                                                                                                                                                                                                                                         |
| B Description | Multiple distinct target sources trigger AI merge. If targets are empty but AI-derived context exists, run AI description generation. If AI is unavailable or fails, return a typed AI failure.                                                                                                                  |
| C Title       | Primary XMP title wins; if empty, derivative IPTC ObjectName wins. AI generation only when targets are empty and description context exists.                                                                                                                                                                     |
| D Headline    | Primary XMP headline wins; if empty, IPTC headline wins.                                                                                                                                                                                                                                                         |
| E Creator     | Union names, dedup, preserve first-seen order.                                                                                                                                                                                                                                                                   |
| F Copyright   | Primary XMP rights wins; if empty, longest derivative wins.                                                                                                                                                                                                                                                      |
| G Location    | Per XMP/IIM pair, XMP wins on conflict. Conflict is counted, but edits are still emitted.                                                                                                                                                                                                                        |
| H Dates       | EXIF/XMP/IPTC are compared using Dates normaliser wall-clock semantics. Primary EXIF wins on conflict. Conflict is counted, but edits may still be emitted. Offsetless and offset-bearing values can be considered equivalent only inside Dates normaliser comparison when wall-clock date/time/subsecond match. |
| I IPTC UTF-8  | If the file contains IPTC IIM metadata and its character-set marker is not UTF-8, stage `IPTC:CodedCharacterSet=UTF8`. The apply planner performs the physical conversion described below.                                                                                                                       |

Dates' "primary wins + conflict count" behaviour is intentional and mirrors
Location; it is not a global "conflict blocks edits" rule.

### Group A — Keywords

| Role            | Field                        | Datatype                           |
| --------------- | ---------------------------- | ---------------------------------- |
| Primary         | `XMP-lr:HierarchicalSubject` | Bag of `Parent\|Child\|Leaf` paths |
| Derivative      | `XMP-dc:Subject`             | Bag of strings (leaves only)       |
| Derivative      | `IPTC:Keywords`              | Bag of strings (leaves only)       |
| Read-only input | `XMP-mlib:AITags`            | Bag of strings                     |
| Read-only input | `XMP-mlib:AIObjects`         | Bag of strings                     |

**Canonical form.** Bag of hierarchical paths. Each leaf and each path
component normalised to lowercase, hyphen-separated (e.g. `new-york`, not
`New_York` or `NewYork`). Whitespace trimmed; empty components dropped.
The bag itself is sorted alphabetically by full path string (see
"Ordering" below).

**Ordering.** Both the hierarchical primary (`XMP-lr:HierarchicalSubject`)
and the flat derivatives (`XMP-dc:Subject`, `IPTC:Keywords`) are sorted
alphabetically — by full normalised path for the hierarchical bag, by
leaf for the flats. XMP bag and IIM repeated-string semantics declare
the field unordered (readers must not infer meaning from order), so we
are free to pick a canonical order. Alphabetical was chosen because:

1. It matches Lightroom / Bridge / digiKam defaults — most existing
   libraries already look like this on disk.
2. It keeps the hierarchical primary visibly consistent with the sorted
   flat derivatives, which avoids the otherwise-confusing "same set, two
   different orders" appearance in metadata viewers.
3. It makes re-runs byte-stable regardless of which source supplied a
   given tag first, simplifying the idempotency detector.
4. Relevance-based ordering (the only competing convention, used by stock
   agencies and AI taggers) requires a confidence score we do not have
   for user-entered tags or hierarchical paths derived from a union.

**Derivation — union across all sources.**

The canonical bag is the union of:

1. Every path in `XMP-lr:HierarchicalSubject` (after normalisation).
2. Every flat keyword in `XMP-dc:Subject`, `IPTC:Keywords`,
   `XMP-mlib:AITags`, `XMP-mlib:AIObjects` (after normalisation) that is
   **not already the leaf of some path from step 1**. Each such orphan
   flat keyword is promoted to a degenerate single-component path.

Dedup is by full normalised path string.

Worked example. `HierarchicalSubject = [A|B|C, 1|2|3]` and
`Keywords = [C, D]` →
canonical paths (post-normalisation, sorted) = `[1|2|3, a|b|c, d]`. `C`
is absorbed because it is the leaf of `A|B|C`; `D` is promoted because
it appears nowhere as a leaf.

Derivative projection:

- `dc:Subject` = sorted unique leaves of canonical paths
  (`[3, c, d]` in the example).
- `IPTC:Keywords` = same set.

This means the flat-derivative fields will always be a strict subset of the
information in `HierarchicalSubject` after normalisation. Round-tripping is
lossless from the user's point of view because re-running normalisation on
the new state reproduces the same canonical bag.

**Conflict policy.** Always-union. Multiple non-empty distinct values are
merged, not resolved.

**No AI.** Pure string operations.

### Group B — Description

| Role            | Field                        | Datatype                                                                            |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| Primary         | `XMP-dc:Description`         | LangAlt (`x-default`)                                                               |
| Derivative      | `IFD0:ImageDescription`      | ASCII string                                                                        |
| Derivative      | `IPTC:Caption-Abstract`      | string (UTF-8 if `IPTC:CodedCharacterSet=ESC % G`, else ASCII), 2000-char IIM limit |
| Read-only input | `XMP-mlib:AIDescription`     | string                                                                              |
| Read-only input | `XMP-mlib:AIInterpretation`  | string                                                                              |
| Read-only input | `XMP-mlib:AIOcrText`         | Bag of strings                                                                      |
| Read-only input | `XMP-mlib:AIObjects`         | Bag of strings                                                                      |
| Read-only input | Group F (Location) values    | strings                                                                             |
| Read-only input | Group A (Keywords) canonical | (post-pass output)                                                                  |
| Read-only input | Group G (Dates) canonical    | (post-pass output, ISO date)                                                        |
| Excluded        | `EXIF:UserComment`           | — (user note, not caption)                                                          |

**Canonical form.** Single paragraph, sentence-cased, factual tone, no
marketing language, no repetition. UTF-8 in primary; downstream derivatives
adapt.

**Derivation.**

- `ImageDescription` = ASCII-fold of canonical (strip diacritics, replace
  smart-quotes, em-dash → `--`). EXIF spec is ASCII; do not write non-ASCII.
- `Caption-Abstract` = canonical truncated to 2000 chars at a word boundary.
  Encoding follows `IPTC:CodedCharacterSet` if present; otherwise ASCII-fold.

**Conflict policy.**

1. All target sources empty and no AI-derived context exists → no drafts (see §4 all-empty rule).
2. All target sources empty and AI-derived context exists → **AI generation** creates canonical Description, then project to all derivatives.
3. Exactly one target source non-empty → take that value, `normalise(...)`
   it, project to all derivatives. No AI.
4. Multiple target sources non-empty AND equal after `normalise(...)` →
   write the normalised form to all derivatives. No AI.
5. Multiple target sources non-empty AND distinct after normalisation →
   **AI merge** produces canonical, then project to all derivatives.

**AI merge/generation.** Single call to the configured normalisation model (default
`gpt-5.4-nano`). Inputs and prompt: §6.

### Group C — Title

| Role            | Field                         | Datatype                  |
| --------------- | ----------------------------- | ------------------------- |
| Primary         | `XMP-dc:Title`                | LangAlt (`x-default`)     |
| Derivative      | `IPTC:ObjectName`             | string, 64-char IIM limit |
| Read-only input | Group B canonical (post-pass) | string                    |
| Read-only input | Group F (Location) values     | strings                   |

**Canonical form.** Short title-case phrase, ≤8 words, no trailing
punctuation.

**Conflict policy.** Pick a canonical value, then project to all
derivatives:

1. Primary non-empty → canonical = `normalise(primary)`.
2. Primary empty, derivative non-empty → canonical = `normalise(derivative)`.
3. All target empty AND Group B canonical now non-empty → canonical =
   **AI-generated** title from description (single nano call, `≤8 words`).
4. All target empty AND no description available → no drafts (see §4
   all-empty rule).

In cases 1–3 the canonical is projected to every target field (set-value
draft where current value differs from the projection).

### Group D — Headline

| Role       | Field                    | Datatype                   |
| ---------- | ------------------------ | -------------------------- |
| Primary    | `XMP-photoshop:Headline` | string                     |
| Derivative | `IPTC:Headline`          | string, 256-char IIM limit |

**Canonical form.** Single-sentence headline, ≤25 words.

**Conflict policy.** Pick a canonical value, then project to all
derivatives:

1. Primary non-empty → canonical = `normalise(primary)`.
2. Primary empty, derivative non-empty → canonical = `normalise(derivative)`.
3. All target empty → no drafts (no AI generation from description; keeps
   scope tight).

No AI in this group.

### Group E — Creator

| Role       | Field            | Datatype                                  |
| ---------- | ---------------- | ----------------------------------------- |
| Primary    | `XMP-dc:Creator` | Seq of strings (ordered)                  |
| Derivative | `IFD0:Artist`    | string (semicolon-separated for multiple) |
| Derivative | `IPTC:By-line`   | repeated string                           |

**Canonical form.** Seq of names. Each name kept verbatim — do not
"normalise" name capitalisation or order; risk of mangling non-English names
outweighs benefit.

**Conflict policy.** Union of all non-empty sources, dedup case-sensitive,
preserve first-seen order. No AI.

### Group F — Copyright

| Role       | Field                  | Datatype              |
| ---------- | ---------------------- | --------------------- |
| Primary    | `XMP-dc:Rights`        | LangAlt (`x-default`) |
| Derivative | `IFD0:Copyright`       | ASCII string          |
| Derivative | `IPTC:CopyrightNotice` | string                |

**Canonical form.** Single-line copyright string, leading/trailing whitespace
trimmed. No tone/tense normalisation. No AI.

**Conflict policy.** Pick a canonical value, then project to all
derivatives:

1. Primary non-empty → canonical = `normalise(primary)`.
2. Primary empty, ≥1 derivative non-empty → canonical = `normalise(longest
non-empty derivative)`. (Only group where length-based pick is used;
   copyright notices are typically appended to, so the longest is usually
   the most complete.)
3. All target empty → no drafts.

No AI.

### Group G — Location (LocationCreated canonical)

| Role       | Field                                | Datatype                               |
| ---------- | ------------------------------------ | -------------------------------------- |
| Canonical  | `XMP-iptcExt:LocationCreated`        | bag of Location structures             |
| AI input   | `XMP-mlib:ReverseGeocodeGeocodeJSON` | exact Nominatim response text          |
| AI input   | `XMP-mlib:ReverseGeocodeJSONv2`      | exact Nominatim response text          |
| Projection | `XMP-iptcCore:Location`              | string                                 |
| Derivative | `IPTC:Sub-location`                  | string                                 |
| Projection | `XMP-photoshop:City`                 | string                                 |
| Derivative | `IPTC:City`                          | string                                 |
| Projection | `XMP-photoshop:State`                | string                                 |
| Derivative | `IPTC:Province-State`                | string                                 |
| Projection | `XMP-photoshop:Country`              | string                                 |
| Derivative | `IPTC:Country-PrimaryLocationName`   | string                                 |
| Projection | `XMP-iptcCore:CountryCode`           | string (ISO 3166-1 alpha-2, uppercase) |
| Derivative | `IPTC:Country-PrimaryLocationCode`   | fixed-width legacy IPTC projection     |

When exactly one LocationCreated structure exists, its `Sublocation`, `City`,
`ProvinceState`, `CountryName`, and `CountryCode` members are canonical and
project to the five flat XMP/IIM pairs. A missing member removes both
corresponding flat fields. Other structured members such as GPS and
`LocationId` are preserved in LocationCreated and have no flat projection.
Multiple structures are ambiguous and produce no drafts.

When LocationCreated is absent and either raw reverse-geocode evidence field
is present, Group G uses its configured AI model to interpret the two response
strings. AI supplies only the human-facing names (`Sublocation`, `City`,
`ProvinceState`, `CountryName`, `WorldRegion`, and `LocationName`).
Coordinates come from the photo, OSM LocationIds come from the responses, and
CountryCode is copied only when the supplied valid alpha-2 codes agree. The
completed structure then follows the same deterministic projection path as an
existing LocationCreated.

When LocationCreated and reverse-geocode evidence are both absent, the five
pairs are read independently using the existing XMP-wins conflict policy.
Their canonical values create one LocationCreated structure and are also
synchronized across each pair.

**Country-code projection.** `XMP-iptcCore:CountryCode` stores the normal
alpha-2 semantic value, e.g. `GB`. `IPTC:Country-PrimaryLocationCode` stores
the legacy fixed-width projection; two-character ASCII codes are right-padded
with one space, e.g. `GB `. Non-two-character values are preserved after
canonicalisation rather than failed or truncated. This is not alpha-3
conversion and does not use an ISO lookup table.

**Legacy conflict policy.** Per pair, pick canonical then project to both fields:

1. Both empty → no drafts.
2. Exactly one non-empty → canonical = that value (uppercased for
   `CountryCode`); project to the other side.
3. Both non-empty AND equal after canonicalisation → write canonical
   projections to both (handles e.g. `gb` vs `GB`, and `GB` vs `GB ` for
   CountryCode).
4. Both non-empty AND distinct after canonicalisation → primary (XMP side)
   wins. Recorded in stats as `n_location_xmp_iim_conflict`. This fallback is
   used only when no canonical structure or reverse-geocode evidence exists.

Reverse Geocode writes only the two `XMP-mlib` evidence fields. Group G is the
explicit semantic interpretation and legacy-projection step.

### Group H — Dates

| Sub-group         | Primary                          | Mirrors                                                                       | Semantics                                                                |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| H1 Shutter time   | `ExifIFD:DateTimeOriginal` (DTO) | `XMP-photoshop:DateCreated`, `IPTC:DateCreated` + `IPTC:TimeCreated`          | Moment shutter fired                                                     |
| H2 Digitised time | `ExifIFD:CreateDate`             | `XMP-xmp:CreateDate`, `IPTC:DigitalCreationDate` + `IPTC:DigitalCreationTime` | Moment digital file created (= DTO for born-digital, scan time for film) |
| H3 Modify time    | (skipped)                        | —                                                                             | Auto-updated by exiftool on every write; do not normalise                |

**Canonical form per sub-group.** ISO 8601 datetime with timezone offset if
known: `YYYY-MM-DDTHH:MM:SS±HH:MM`. Sub-second precision preserved if any
source has it (`ExifIFD:SubSecTimeOriginal` for H1, `SubSecTimeDigitized` for
H2).

**Timezone.** Offset taken from `ExifIFD:OffsetTimeOriginal` (H1) /
`ExifIFD:OffsetTime` (H2) when present. If absent, write the datetime portion
without offset (do not invent UTC).

**Derivation.**

- IPTC date/time split: `IPTC:DateCreated` = `YYYY-MM-DD`,
  `IPTC:TimeCreated` = `HH:MM:SS±HH:MM` (offset suffix permitted per IIM
  spec).
- XMP fields: full ISO datetime as-is.

**Conflict policy per sub-group.**

1. All target sources empty AND filename fallback applies (H1 only) →
   propose datetime from filename regex. See below.
2. Exactly one target source non-empty → propagate to others (after
   normalisation to ISO form).
3. Multiple target sources non-empty AND all equal after ISO normalisation →
   write the normalised form.
4. Multiple target sources non-empty AND distinct → primary (EXIF side) wins.
   Recorded in stats as `n_date_conflict`. No AI.

**Filename fallback (H1 only).** Triggered when _all_ H1 target fields are
empty. Regex table tried in order:

| Pattern                                                                         | Source               | Notes                                |
| ------------------------------------------------------------------------------- | -------------------- | ------------------------------------ |
| `IMG[_-](\d{8})[_-](\d{6})`                                                     | iOS / Android camera | YYYYMMDD_HHMMSS                      |
| `PXL[_-](\d{8})[_-](\d{6})(\d{3})`                                              | Pixel                | Last 3 digits subsec                 |
| `VID[_-](\d{8})[_-](\d{6})`                                                     | Video filenames      | Same datetime                        |
| `Screenshot[ _](\d{4})-(\d{2})-(\d{2})(?:[ _](\d{2})[.\-](\d{2})[.\-](\d{2}))?` | iOS/macOS screenshot | Time optional                        |
| `(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[.\-:](\d{2})[.\-:](\d{2})`                 | Generic ISO-ish      |                                      |
| `(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})`                               | Compact              |                                      |
| `(\d{4})-(\d{2})-(\d{2})`                                                       | Date-only            | Time defaults to `00:00:00`, flagged |

Matches at any position in the file stem. Sanity bounds: 1900 ≤ year ≤
(current year + 1).

**Date-only filename match** writes `DTO=YYYY-MM-DDT00:00:00` and increments
`n_dto_from_filename_date_only` in stats so the user can audit.

**Filename fallback never overwrites an existing DTO.** It only fills.

H2 has no filename fallback. H3 is skipped entirely (auto-managed).

### Group I — IPTC UTF-8

This group is the repair path for legacy or missing IPTC IIM character-set
declarations. If the effective metadata contains any IPTC schema and
`IPTC:CodedCharacterSet` is neither ExifTool's `UTF8` value nor the raw
`ESC % G` marker, it stages a normal draft setting the marker to `UTF8`.
It is a no-op for files without IPTC metadata and files already declared
UTF-8.

The group deliberately creates an ordinary draft; it does not write the file
or manufacture same-value drafts for every IPTC field. When that draft is
later included in an apply, the write planner detects the transition and
derives transient rewrites for every existing non-ASCII IPTC value not
explicitly targeted by another draft in that apply. This is necessary because
changing `CodedCharacterSet` changes only the declaration: ExifTool does not
automatically transcode untouched IPTC bytes. The derived rewrites are
verified and written to the target-aware apply audit with their reason, but
are not persisted as user drafts and do not produce draft reconciliation
outcomes.

Only drafts selected for the current apply contribute to this process.
In particular, a staged IPTC draft that the user does not apply must not be
silently substituted for the authoritative value used by a derived rewrite.
An explicitly applied IPTC draft always takes precedence over the derived
same-value rewrite for its occurrence.

## 2. Pass ordering

Groups are not fully ordered. Most groups are independent. The exceptions:

1. **Independent groups (any order):** A (Keywords), E (Creator), F
   (Copyright), G (Location), H (Dates), I (IPTC UTF-8).
2. **After group A and G and H:** B (Description). Reads keywords, location,
   and dates as context for AI merge.
3. **After group B:** C (Title), D (Headline). Title may AI-generate from
   description when target empty.

Implementation: a three-pass scheduler. Pass 1 runs A, E, F, I, G, H in the
fixed deterministic order listed here. Pass 2 runs B. Pass 3 runs C, D. Each
pass sees the previous passes' draft outputs via the draft-overlay read
(see §3).

## 3. Draft-overlay read precedence

Whenever a group computes its canonical value or reads context from another
group, it reads field values with this precedence:

1. Existing draft in the typed draft store (from earlier passes in _this_
   normaliser run, or from prior unrelated user edits).
2. On-disk metadata.

This is the same pattern used by reverse-geocode for GPS coordinates
([REVERSE_GEOCODE_PLAN.md §2](REVERSE_GEOCODE_PLAN.md)). Drafts are
persisted to JSONL on disk by Rust (`draft_edits.rs`), but the live
working copy lives in the React typed draft store while the app is
running. Both sides therefore hold the drafts; the geocode design has
the front end resolve the draft-vs-metadata overlay because the React
store is already in memory, avoiding a mid-batch JSONL re-read on the
backend. Normaliser follows the same handoff: front end builds the
per-image input bundle (target field values + read-only inputs) using
the in-memory draft overlay and ships it to the backend per image.

## 4. Coherent-replacement rule per group

For a group that is being normalised on a given image, the resulting draft
set is an **atomic, complete replacement** of that group's target fields
(matching reverse-geocode's discipline in
[REVERSE_GEOCODE_PLAN.md §1](REVERSE_GEOCODE_PLAN.md)).

- Field in canonical → set-value draft.
- Field absent from canonical → **remove-tag draft**.

Read-only input fields are never drafted (only read).

**Exception: idempotency no-op.** If `group_is_normalised(file)` returns
true (see §5), no drafts at all are emitted for that group on that image.
Re-runs are cheap and observably no-op.

**All-empty groups.** If every target source and every read-only input is
empty for a group, that group produces no drafts (not even
remove-tag drafts). Rationale: nothing to normalise; "delete everything"
would be surprising. Description has an explicit exception: all target fields empty is not all-empty if read-only AI-derived context exists (which instead triggers AI Description generation).

**Implementation note (v1 / v2).** Every group implemented so far derives
a scalar / seq / bag canonical that projects either fully across its
target tags or not at all — there is no partial case where canonical
exists but some derivatives project to empty. The "field absent from
canonical → remove-tag draft" branch is therefore unreachable in
current code and no group emits remove-tag drafts. A forward-compat
helper (`append_remove_tag_drafts_for_missing_projections` in
[normalise.rs](../src-tauri/src/normalise.rs)) exists so that a future
group with a structured canonical (where individual sub-fields can
independently be empty while others are populated) can satisfy this
rule without re-deriving it. Call it after the group's set-value
emission once such a group lands.

## 5. Idempotency detector

For each (group, image) pair, before computing anything:

```
group_is_normalised(group, file) =
    let sources = read_targets_with_draft_overlay(group, file)
    let canonical = derive_canonical(group, sources, read_only_inputs(group, file))
    canonical == normalise(canonical)                       // already in normal form
    AND for each derivative d in group:
        sources[d] == project(canonical, d.datatype)        // already in sync
```

The first clause catches the `Tower` / `tower` case: equal mirrors but not
yet normalised → trigger normalisation. The second clause catches drift
between primary and derivatives.

Implemented per group; some groups may short-circuit (e.g. Group B's
detector can avoid running the AI by checking sources equal-after-normalise
before deciding).

## 6. AI integration

**Model.** New setting `normalise_metadata_model`, default `gpt-5.4-nano`.
Picker UI mirrors the existing `ai_describe_model` setting; instead of
showing the estimated cost to describe one file, the dropdown shows the
estimated cost to **normalise** one file's metadata when AI is required.

Location uses a second setting, `normalise_location_model`, with the same
recommended-model picker but defaults to `gpt-5.6-luna`. Repeated hierarchy
experiments showed that the stricter canonical prompt made nano consistent,
but Luna was required to distinguish settlements from administrative
districts reliably. It is separate because reverse-geocode hierarchy selection
is a distinct quality/cost workload from description merging and title
generation.

**Settings dropdown preview cost.** At settings-time there is no
selection to dry-run, so the dropdown uses a synthetic typical-cost-per-
file helper mirroring describe's
`estimate_typical_cost_per_image` ([openai_describe.rs:55](src-tauri/src/openai_describe.rs)).

```rust
/// Synthetic cost shown next to each model in the picker. Used only
/// for the settings-dialog preview where there is no real selection
/// of files to walk; the run-time estimator (§7) computes exact
/// costs from real prompts.
///
/// Assumes the worst case: both Group B (description merge) AND
/// Group C (title generation) fire on the same file. Typical token
/// counts derived from prompt structure + median field lengths from
/// the existing user library (recorded in fixtures so the constant
/// can be regenerated).
pub fn typical_normalise_cost_per_image(model: &str) -> Option<f64> {
    let p = pricing_for(model)?;
    // Group B: ~800 input tokens (system + 3 description sources +
    // AI context + location + keywords + date), ~250 output tokens
    // expected.
    let b_in = 800.0; let b_out = 250.0;
    // Group C: ~300 input tokens (system + description + location +
    // keywords), ~15 output tokens.
    let c_in = 300.0; let c_out = 15.0;
    Some(
        ((b_in + c_in) / 1_000_000.0) * p.input_per_1m
        + ((b_out + c_out) / 1_000_000.0) * p.output_per_1m
    )
}
```

The dropdown label format matches describe: `gpt-5.4-nano (≈ $0.0001 per photo when AI fires)`.

**Where AI is used.**

1. Group B AI generation — when all Description target sources are empty but AI-derived context exists.
2. Group B AI merge — when Description target sources conflict.
3. Group C AI title generation — when all Group C targets are empty and Description canonical is available (including newly regenerated Description).
4. Group G AI location resolution — when LocationCreated is absent and at
   least one of `XMP-mlib:ReverseGeocodeGeocodeJSON` or
   `XMP-mlib:ReverseGeocodeJSONv2` is non-empty.

Existing LocationCreated always suppresses the Group G call. All projection,
coordinates, country-code agreement, and OSM identifier construction remain
deterministic.

**Group B prompt.**

System message:

> You generate or normalise a factual photo description for a personal media library.
> Produce a single factual paragraph in `x-default` English.
> Prefer existing human-authored description sources when present.
> When no human description source is present, use AI-derived context such as
> `XMP-mlib:AIDescription`, `XMP-mlib:AIInterpretation`, `XMP-mlib:AIOcrText`, and `XMP-mlib:AIObjects`.
> Use location, keywords, and date only as contextual hints.
> Do not invent facts not supported by the supplied inputs.
> Keep it concise, factual, sentence-cased, and non-marketing.
> If sources conflict, prefer the more specific or better-supported statement.
> If an interpretation field contains speculation/mood/intent, only include it if it is clearly useful and phrase it cautiously; otherwise omit it.

User message (JSON):

```json
{
  "description_sources": {
    "XMP-dc:Description": "...",
    "IFD0:ImageDescription": "...",
    "IPTC:Caption-Abstract": "..."
  },
  "ai_context": {
    "XMP-mlib:AIDescription": "...",
    "XMP-mlib:AIInterpretation": "...",
    "XMP-mlib:AIOcrText": ["...", "..."],
    "XMP-mlib:AIObjects": ["...", "..."]
  },
  "location": {
    "location": "Trafalgar Square",
    "city": "London",
    "country": "United Kingdom"
  },
  "keywords": ["lion", "statue", "tourist"],
  "date": "2024-08-12"
}
```

Empty / unknown fields omitted from the user message.

Output schema: `{"description": string}`. No `dropped_facts`, no
metadata-about-the-merge.

**Group C prompt.**

System message:

> You generate a short photo title. ≤8 words. Title case. No trailing
> punctuation. Use the description as the primary source; use location and
> keywords for disambiguation.

User message:

```json
{
  "description": "...",
  "location": { "location": "...", "city": "..." },
  "keywords": ["..."]
}
```

Output: `{"title": string}`.

**Group G prompt.** The two response strings are supplied verbatim and clearly
labelled. The system prompt defines the IPTC meaning of each human-facing
member, requests English or commonly anglicised names, allows supported
combinations such as `Minato, Tokyo`, and requires null for unsupported
fields. Structured output returns nullable `sublocation`, `city`,
`provinceState`, `countryName`, `worldRegion`, and `locationName` values.

**Image bytes are never sent.** All visual content is assumed already
distilled into `XMP-mlib:AIDescription` via the AI Describe feature; users
who want richer descriptions should run AI Describe first.

**Cost audit.** Each AI call appends a JSONL row to a normaliser audit log
in the same style as `describe_log.rs`. Fields: timestamp, model,
prompt_version, group (`description` / `title` / `location`), input token count, output
token count, cost, error (if any), relative_path. The user can compare
before/after manually if they want.

**Prompt version.** Current `"v3"`. Bumped when any prompt or schema changes;
audit-log entries retain old version strings for archaeology.

## 7. Cost estimation

A `estimate_normalise_cost_cmd` runs before the awaiting-confirm phase
(matching describe's estimate phase, not geocode's skip-estimate). It
loops over **every** selected image — same pattern as
`estimate_describe_cost_cmd` ([lib.rs:945](src-tauri/src/lib.rs)).

**Key property:** the estimate phase performs the _entire_ normalisation
walk for each image (idempotency detector, conflict resolution per
group, projection to derivatives) — only the AI dispatch is skipped.
Cost estimation respects the shared `ai_cost_estimate_mode` setting used
by AI Description. The default `heuristic` mode still captures which Group
B / Group C prompts would fire, but estimates input tokens locally instead
of calling `/responses/input_tokens` (Group B description merge: ~800 input
tokens; Group C title generation: ~300 input tokens). `exact` mode fully
builds each text prompt and sends it to `/responses/input_tokens` for an
exact input token count; no actual completion is requested. Normalise exact
preflight sends text prompts only, never image bytes. Output tokens use the
per-prompt caps (Group B: 400 max; Group C: 30 max). Per-call cost uses the
same pricing table used by describe.

Because the walk is exact (not a sample, not an extrapolation), the
estimate always emits exact would-fire counts. Input token totals are exact
in exact mode and heuristic in heuristic mode:

- `n_images_with_ai_b` — images whose Group B will fire AI
- `n_images_with_ai_c` — images whose Group C will fire AI
- `n_images_no_ai` — images that will run purely deterministically
- `total_input_tokens` (sum of preflight counts)
- `predicted_cost_usd` (expected-output-tokens-based)
- `upper_bound_cost_usd` (max-output-tokens-based)

Predicted vs upper bound therefore reflects only output-token
uncertainty, not "maybe AI fires, maybe not".

Emit per-image progress events (`normalise_estimate_progress`) so the
estimating panel shows a moving counter, matching describe's UX. Same
cancellation semantics as describe: cancel flag installed for the
estimate run and cleared on completion.

**Re-walk on confirm.** When the user confirms, `normalise_metadata_cmd`
re-walks each image from scratch and dispatches AI where needed. No
plan caching between estimate and run — the deterministic part is cheap
(no I/O beyond what the front end already shipped in the input bundle),
and the simpler control flow avoids a stateful handoff. Group walks are
designed to be pure functions of `(input_bundle, ai_client)` so the two
runs produce the same per-group decisions; only the AI responses
introduce non-determinism, and only inside Group B and Group C.

The dialog awaiting-confirm panel displays:

> Ready to normalise metadata for **N images** using model `<model_name>`.
>
> Groups: _(list of checked group names)_.
>
> AI calls required:
>
> - _K_ images need an AI description merge
> - _J_ images need an AI title generation
> - _M_ images run purely deterministically (no AI)
>
> **Cost:** $X.YZ predicted, up to $X.YZ in the worst case (output-token
> variation only).
>
> Existing fields **will be overwritten** with drafts. No file is changed
> on disk until you apply drafts.

If no AI call fires anywhere across the selection, the estimate panel
reads `No AI calls required. Free.` and the cost line is suppressed.

## 8. Backend: `BatchJob` extension

Reuses `batch_job.rs` from
[REVERSE_GEOCODE_PLAN.md §3](REVERSE_GEOCODE_PLAN.md). Adds:

- `src-tauri/src/normalise.rs`:
  - `pub enum NormaliseGroup { Keywords, Description, Title, Headline, Creator, Copyright, Location, Dates, IptcUtf8 }`
  - `pub struct NormaliseRequestItem { rel_path: String, group_inputs: GroupInputs }`
    — front end resolves the draft overlay for every target / read-only
    input field across all enabled groups and ships the per-image bundle.
  - `pub struct GroupInputs { keywords: Option<KeywordsInput>, description: Option<DescriptionInput>, ... }`
  - `pub struct NormaliseJob { client, model, audit_log, enabled_groups }`
    implementing `BatchJob`.
  - `process_one` walks enabled groups in pass order
    (independent → description → title/headline), building a draft-overlay
    HashMap that subsequent groups read from for context.
  - Group implementations as free functions:
    - `fn normalise_keywords(input) -> Option<GroupOutput>`
    - `fn normalise_description(input, ctx, ai_client) -> Result<Option<GroupOutput>, AiError>`
    - `fn normalise_title(input, description_canonical, ctx, ai_client) -> Result<Option<GroupOutput>, AiError>`
    - …
  - Each returns `None` when `group_is_normalised` shortcuts. `Some(GroupOutput)`
    carries a `HashMap<String, MetadataDraftEdit>` with set-value and remove-tag
    drafts per §4.
  - Code-comment requirement: the coherent-replacement rule, the
    idempotency detector, and the conflict-policy decisions are documented
    inline near the implementations, so a future reader doesn't quietly
    flip them.

- `src-tauri/src/normalise_log.rs` — JSONL audit log helper, mirroring
  `describe_log.rs`. Extracted to a shared module if the describe refactor
  in §11 lands first.

- **Commands** in `src-tauri/src/lib.rs`:
  - `estimate_normalise_cost_cmd(folder, items, enabled_groups, model)` —
    cost upper bound per §7.
  - `normalise_metadata_cmd(folder, items, enabled_groups, model)` —
    installs cancel flag, constructs `NormaliseJob`, calls `run_batch_loop`.
  - `cancel_normalise_cmd()` — flips flag.
  - State: `NormaliseState` (cancel flag holder), parallels
    `DescribeState` / `GeocodeState`.

- Event prefix: `"normalise"`. Events:
  `normalise_estimate_started/_progress/_error/_complete`,
  `normalise_progress`, `normalise_complete`.

### Failure kinds

| Kind                | Meaning                                    |
| ------------------- | ------------------------------------------ |
| `ai_call_failed`    | OpenAI returned non-2xx or invalid JSON    |
| `ai_schema_invalid` | Response parsed but missing required field |
| `ai_rate_limited`   | 429 from OpenAI                            |
| `audit_log_io`      | Could not append to JSONL log              |
| `cancelled`         | User cancelled mid-image                   |
| `internal`          | Bug — surfaced with detail string          |

Per-image AI failures do not abort the batch. The image surfaces in the
failure list; non-AI groups for that image still write their drafts.

## 9. Frontend: dialog and hook

### Hook

- **New `src/hooks/useNormaliseMetadata.ts`** — thin wrapper over
  `useBatchImageJob`. Prefix `"normalise"`. Estimate phase enabled. Owns
  the per-group checkbox state and the model selection.
- Calls `buildNormaliseItems(relPaths, enabledGroups)` to resolve the
  draft overlay for every relevant field across enabled groups.

### Dialog

- **`NormaliseProgressDialog`** — slots for `BatchJobDialog`.
  - Awaiting-confirm panel: per-group checkbox list, model picker, estimate
    panel with cost upper bound and `Existing fields will be overwritten`
    warning.
  - Running panel: reuses `RunningProgressPanel` with `noun="image"`.
  - Done panel: failure list + stats (see §10).

### Settings entry

The settings dialog exposes `normalise_metadata_model` for Description/Title
and `normalise_location_model` for Location. Both use the same recommended
model list and local per-file cost helpers; the run estimator prices each call
with the model configured for that group.

## 10. Done-panel stats

```ts
interface NormaliseSummary {
  nSucceeded: number;
  nFailed: number;
  nSkippedAllNormalised: number; // every enabled group already in normal form
  perGroup: {
    [groupName: string]: {
      nNoOp: number; // group already normalised
      nNormalisedDeterministic: number;
      nNormalisedAI: number; // only B, C
      nConflictPrimaryWon: number; // distinct sources, primary preferred
      nLocationXmpIimConflict?: number;
      nDateConflict?: number;
      nDtoFromFilename?: number;
      nDtoFromFilenameDateOnly?: number;
    };
  };
  aiCostTotalUsd: number;
  aiCallsTotal: number;
}
```

Done panel renders a compact per-group breakdown plus an AI cost total
and call count if non-zero.

## 11. Refactor shopping list (commit before normaliser feature)

These are extracted ahead of normaliser so the new feature lands cleanly:

1. **Typed `BatchFailureKind`** — Rust enum + TS union, replacing the
   stringly `kind: string` shape currently passed in describe and geocode
   wire types. Frontend dialogs (`DescribeProgressDialog`,
   `GeocodeProgressDialog`) update to switch on the typed kind.
2. **Shared overwrite-warning component** — the multi-select-aware confirm
   text used in both describe and geocode is hoisted into a reusable
   component. Normaliser will use the same shape (count-of-files-with-data
   varies per enabled-group set).
3. **Shared audit-log module** — `describe_log.rs` generalised; normaliser
   appends via the same helper.
4. **Generic `BatchSummary<TPerSource>`** wire shape on the TS side, with
   per-source counter rendering helpers. `GeocodeSummary` and
   `DescribeUsageSummary` become instances; `NormaliseSummary` is the third.

Each refactor lands as its own commit and changes no observable user
behaviour.

## 12. Cancellation

`NormaliseState` cancel flag installed at command entry, flipped by
`cancel_normalise_cmd`. Checked:

- Between images (loop boundary in `run_batch_loop`).
- Between groups within an image.
- Between AI sub-calls within Group B → Group C (cancelling mid-image
  preserves any drafts already emitted in earlier groups for that image,
  surfaces the image with `cancelled` kind).

## 13. Overwrite warning — multi-select aware

Mirrors the pattern in
[REVERSE_GEOCODE_PLAN.md §5](REVERSE_GEOCODE_PLAN.md). "Already has
data" means any target field of any enabled group is non-empty in
metadata or in the typed draft store.

`DetailsPane`, `FileList` context menu, single / some / all phrasings
identical in structure to the geocode warning. Wording template:

> _N_ of _M_ selected files already have metadata in the groups you have
> selected. Normalising will overwrite those fields with drafts — fields
> outside the canonical form will be cleared. Continue?

Context menu entry: `Normalise Metadata…` next to `Reverse Geocode…` and
`AI Describe…`. Always visible when ≥1 file selected.

## 14. Files touched / created

**Refactor (per §11):**

- `src/types.ts` — `BatchFailureKind` typed union; generic summary helpers.
- `src/components/BatchFailureList.tsx` — generalised over typed kind.
- `src/components/OverwriteWarning.ts` — shared text builder.
- `src-tauri/src/batch_job.rs` — typed `JobError::kind` enum.
- `src-tauri/src/describe_log.rs` → renamed / re-exported as
  `batch_audit_log.rs` with a generic appender.
- `src/components/DescribeProgressDialog.tsx`,
  `src/components/GeocodeProgressDialog.tsx` — switch to typed kinds + new
  warning component.

**New (normaliser-specific):**

- `src-tauri/src/normalise.rs` — group implementations, `NormaliseJob`,
  conflict policies, ASCII-fold, filename-regex table.
- `src-tauri/src/normalise_prompts.rs` — system / user message templates,
  prompt version constant, response schema validation.
- `src-tauri/src/normalise_log.rs` (or inline in
  `batch_audit_log.rs`).
- `src/hooks/useNormaliseMetadata.ts` — thin wrapper.
- `src/components/NormaliseProgressDialog.tsx` — slots.
- `src/components/NormaliseGroupChecklist.tsx` — per-group checkboxes for
  awaiting-confirm panel.
- `src/types.ts` — `NormaliseGroup` enum, `NormaliseRequestItem`,
  `NormaliseSummary`, `NormaliseGroupOutput`, per-group input bundles.

**Wiring:**

- `src/App.tsx` — `useNormaliseMetadata` hook, `NormaliseProgressDialog`,
  `onNormalise` prop plumbing.
- `src/components/DetailsPane.tsx` — `Normalise Metadata…` button +
  overwrite warning.
- `src/components/FileList.tsx` — context-menu entry + warning.
- `src/components/GalleryView.tsx` — prop pass-through.
- `src/components/SettingsDialog.tsx` (or equivalent) —
  `normalise_metadata_model` picker with per-file normalise cost estimate.

**Tests:**

- `src-tauri/src/normalise.rs` unit tests:
  - Group A: union with leaf-dedup (worked example `[A|B|C, 1|2|3]` ∪
    `[C, D]` → `[A|B|C, 1|2|3, D]`); hierarchy ↔ flat round-trip;
    lowercase-hyphen normalisation; leaves-only flatten in derivatives;
    degenerate-path promotion when no hierarchy present; idempotency
    after one normalisation pass.
  - Group B: all-equal-after-normalise no-AI path; distinct-sources AI
    path (with mocked client); ASCII-fold for `ImageDescription`; 2000-char
    truncation at word boundary for `Caption-Abstract`; UTF-8 vs ASCII
    encoding based on `CodedCharacterSet`.
  - Group C: AI title generation only fires when targets empty AND
    description non-empty; primary-wins when both set; ObjectName 64-char
    truncation.
  - Group D: primary wins; no AI; no generation from description.
  - Group E: union with order preservation; no name normalisation.
  - Group F: longest-wins fallback for derivatives only.
  - Group G: existing LocationCreated suppresses AI and projects to five
    XMP↔IIM pairs; raw evidence with missing LocationCreated invokes AI once;
    one evidence field is sufficient; identifiers/GPS/country code remain
    deterministic; multiple structures are unresolved; without evidence,
    legacy fields seed LocationCreated using XMP-wins.
  - Group H: H1 / H2 sync; ISO normalisation with and without offset;
    sub-second preservation; IPTC date/time split; filename regex table
    (each pattern); date-only fallback writes 00:00:00 + flags stat;
    H1 fallback never overwrites existing DTO; H3 skipped entirely.
  - Idempotency: every group's detector reports `true` on already-normalised
    fixtures; second run produces zero drafts for a fixture that the first
    run normalised.
  - Coherent replacement: missing canonical fields produce remove-tag drafts.
  - All-empty group: zero drafts (no remove-tag flood).
  - Draft-overlay precedence: existing drafts override metadata as inputs.
- `src-tauri/src/normalise.rs` integration test: end-to-end with a
  mocked AI client across a small fixture set; verifies pass ordering
  (Group A canonical visible to Group B; Group B canonical visible to
  Group C).
- `src/test/normalise-flow.test.tsx` — mirror `describe-flow.test.tsx`:
  estimate → confirm → run → done; per-group checkbox interaction; cost
  upper-bound display; cancel mid-run.
- `src/test/details-pane-normalise.test.tsx` — button + single-image
  overwrite warning.
- `src/test/filelist-normalise-contextmenu.test.tsx` — menu entry +
  multi-select warnings (all / some / single).
- `src-tauri/src/batch_job.rs` — extend existing tests for the typed
  `JobError::kind` change.

## Current generated-draft staging boundary

Normalisation input bundles now use the shared effective metadata resolver:
compatibility metadata, uniquely resolved authoritative occurrences, and safely
current target-draft overlays. Valid Set/NewProperty values therefore feed later
normalisation, while Delete makes the field
absent; stale or ambiguous targets are ignored rather than first-selected.
Overwrite estimation consumes the same effective view.

The backend emits exact semantic `Set`/`Delete` edits. At run
confirmation the enabled group selection is cloned and retained for that run;
progress events are checked only against the exact union of
`NORMALISE_TARGET_TAGS_BY_GROUP` for that immutable snapshot. Each file batch is
validated completely, resolved through authoritative occurrences, and applied
as one exact-target store mutation. A disabled-group field or unsafe target
fails that file as `draft_stage_failed` without stopping later files. No active
normalise path creates or saves anything except exact target drafts.
