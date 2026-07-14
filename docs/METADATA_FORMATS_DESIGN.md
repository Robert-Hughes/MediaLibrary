# Metadata Formats — Design

Operational metadata-pipeline guidance lives in `docs/METADATA_PIPELINE.md`.
The authoritative rationale and reconstruction rules for exact tag-definition
identity live in [ExifTool Schema Identity](EXIFTOOL_SCHEMA_IDENTITY.md).

This document describes how MediaLibrary handles image metadata: the types it preserves, how it reads, edits, and writes metadata, and the rationale for the design choices. It is aimed primarily at developers but also useful for advanced users who want to understand what the app actually does to their files.

The guiding principle: **never hide behaviour from the user where it affects the outcome.** If exiftool coerces a value, the user sees it. If a tag is unwritable, the user is told. If we don't know a tag's type, we say so rather than guessing.

---

## 1. The problem

Image metadata is not just key/value strings. A single file may contain:

- Plain text (`XMP-dc:Creator`)
- Multi-language alternatives (`XMP-dc:Description` with `x-default`, `en`, `fr`, ...)
- Unordered bags of strings (`XMP-dc:Subject`, `IPTC:Keywords`)
- Ordered sequences (`XMP-xmpRights:Owner`)
- Integers (`Rating`, `ISO`)
- Floats and rationals (`FNumber`, `ExposureTime`, `GPSLatitude`)
- Enumerations (`Orientation`, `Flash`, `WhiteBalance`)
- Booleans (`XMP-xmpRights:Marked`)
- Nested structures (`XMP-mwg-rs:Regions` for face/area markup)
- Dates with timezone and sub-second precision

The previous pipeline collapsed all of these to strings at the draft layer. The result:

- Editing `Keywords = ["beach", "sunset"]` pre-filled the editor with `"beach, sunset"` and saved it back as a **single keyword** containing a comma. Data corruption.
- Numeric fields written as strings sometimes round-tripped silently and sometimes did not, with no signal to the user.
- Nested structs from exiftool crashed the whole batch parse silently, dropping every file's metadata in that batch.
- New-property edits had no way to know what type they should be.

The new design fixes these by preserving type all the way through.

---

## 2. The `MetadataValue` type

ExifTool JSON is a boundary format only. The scanner decodes ExifTool output as
`serde_json::Value`, then parses it into the app's semantic value model:

```rust
#[serde(tag = "kind", content = "value")]
pub enum MetadataValue {
    Null,
    Text(String),
    Bool(bool),
    Integer(i64),
    Real(f64),
    Rational(RationalValue),
    Date(DateValue),
    Time(TimeValue),
    DateTime(DateTimeValue),
    TimeOffset(UtcOffsetValue),
    LangAlt(BTreeMap<String, String>),
    List { list_kind: ListKind, items: Vec<MetadataValue> },
    Struct(BTreeMap<String, MetadataValue>),
    Binary,
    Unknown { expected: Option<TagKind>, raw: serde_json::Value, reason: Option<String> },
}
```

The frontend mirrors this:

```ts
type MetadataValue =
  | { kind: "Null" }
  | { kind: "Text"; value: string }
  | { kind: "Integer"; value: number }
  | { kind: "Real"; value: number }
  | { kind: "Rational"; value: RationalValue }
  | { kind: "List"; value: { list_kind: ListKind; items: MetadataValue[] } }
  | ...;
```

Metadata read from files, draft edits, write-back payloads, verification, and
apply logs use `MetadataValue`. There is no place in normal operation where a
semantic value round-trips through a display string.

### ExifTool JSON boundary

The old JSON-shape `Variant` compatibility type has been removed. Scanner
boundary code keeps ExifTool output as `serde_json::Value` only long enough to
parse it into `MetadataValue`; app logic should not introduce another
shape-preserving enum.

### Why `Integer`, `Real`, and `Rational` separately

ExifTool JSON numbers do not by themselves carry enough meaning. A `Rating`
integer, an aperture real, and an exact shutter-speed rational need different
write and verification behavior. `MetadataValue` preserves those distinctions
explicitly, while `TagKind` describes what each tag expects.

---

## 3. The tag schema registry

`MetadataValue` describes the actual value observed or drafted. It does not
describe what shape a value _should_ have for a given tag. For that,
MediaLibrary builds a registry of tag types at startup.

### Source: `exiftool -listx -f -lang en`

exiftool publishes its tag database as XML. MediaLibrary obtains it with
`exiftool -listx -f -lang en`; each tag entry includes its table, ID, friendly
group and name, writability, base type and, for enum tags, its value-to-label
mapping.

MediaLibrary runs the command lazily on first registry access and parses the
XML into an in-memory `TagRegistry` keyed by exact `SchemaDefinitionId`
(`table`, canonical `tag_id`, and optional repeated-definition `index`). The
parsed result is cached to disk at
`<dirs::cache_dir>/MediaLibrary/tag_schema_<version>.json`, keyed by the output
of `exiftool -ver`. Subsequent launches read the cache directly; an ExifTool
version change triggers a rebuild. Cache failures degrade to the live build
path. See [ExifTool Schema Identity](EXIFTOOL_SCHEMA_IDENTITY.md) for the full
identity rationale and reconstruction algorithm.

### What the registry tells us

For each exact schema definition:

- Is it writable?
- What is its base type? `Text`, `Integer`, `Real`, `Rational`, `Boolean`, `Date`, `Time`, `DateTime`, `LangAlt`, `Struct`, `Binary`.
- Is it a list? `Bag` (unordered, e.g. Keywords), `Seq` (ordered), `Alt` (alternatives, used by LangAlt).
- For enums: the list of `(code, label)` pairs.
- Bounds (min/max) where exiftool publishes them.

### What the registry does not tell us

Two gaps in `-listx`:

1. **Code-based PrintConv.** `-listx` does not describe exiftool's Perl-implemented formatters — the code that turns `ExposureTime: 0.004` into `"1/250"`, `GPSLatitude: 51.50726` into `"51 deg 30' 26.16\" N"`, or `Flash: 16` into `"Off, Did not fire"`. These are functions, not tables. We never reimplement them. See Section 5.

2. **XMP bag/seq/alt list-ness.** `-listx` emits `type='string'` for `XMP-dc:Subject` even though Subject is a Bag of strings; same for `Creator` (Seq) and a handful of others. This isn't a bug — `-listx`'s `count` attribute is only set for tags with explicit count limits (e.g. IPTC), and XMP namespaces declare list-ness in the XMP spec rather than in exiftool's table definitions. We close the gap with a small hand-curated override table at the bottom of `tag_schema.rs` covering the well-known XMP list/seq/alt tags (Subject, Creator, HierarchicalSubject, mwg-rs:Regions, …). The override list is one entry per tag and easy to grow as new namespaces matter.

### Unknown tags

Tags that are missing from the registry, or whose raw JSON cannot be parsed as the schema's expected kind, are represented as `MetadataValue::Unknown`. Unknown/unparsed values are read-only in the editor because editing them as plain text could destroy structure or type information. Explicit force-text editing is not currently supported.

---

## 4. Reading: two passes

`scanner.rs` runs exiftool twice per scan batch:

**Pass A — pretty:**

```
exiftool -a -G1 -s -struct -t -D -charset filename=utf8 -charset utf8 \
  --system:all --composite:all -j <paths>
```

**Pass B — numeric:**

```
exiftool -a -G1 -s -struct -t -D -charset filename=utf8 -charset utf8 \
  --system:all --composite:all -j -n <paths>
```

### Flag explanations

- `-G1` — Include the friendly Group 1 location/name component, such as
  `XMP-dc`, `ExifIFD`, `IPTC` or `Track1`. It is useful for presentation and
  write-selector construction, but it does not uniquely identify a schema
  definition and is never metadata identity.
- `-s` — Short tag names (no description text).
- `-struct` — Keep nested structs as JSON objects rather than flattening to dotted keys. Required for face regions, `Keys` group on QuickTime, etc.
- `-a` — Allow duplicate tags (e.g. `Subject` from both `XMP-dc` and `IPTC`).
- `--system:all --composite:all` — Exclude file-system metadata (size, mtime — we have those) and computed composites (we don't want them in drafts).
- `-j` — JSON output.
- `-t` — Wrap each JSON value with the internal ExifTool tag-table name and
  optional repeated-definition index.
- `-D` — Include the tag ID, emitting numeric IDs in decimal.
- `-charset filename=utf8 -charset utf8` — UTF-8 throughout. Avoids Windows code-page surprises.
- `-n` (pass B only) — No PrintConv. Raw machine values.

### Why two passes

| Tag            | Pass A (default)         | Pass B (`-n`)                                       |
| -------------- | ------------------------ | --------------------------------------------------- |
| `Orientation`  | `"Rotate 90 CW"`         | `6`                                                 |
| `ExposureTime` | `"1/250"`                | `0.004`                                             |
| `FNumber`      | `"5.6"`                  | `5.6`                                               |
| `GPSLatitude`  | `"51 deg 30' 26.16\" N"` | `51.50726667`                                       |
| `Flash`        | `"Off, Did not fire"`    | `16`                                                |
| `FileSize`     | `"4.2 MB"`               | `4404019`                                           |
| `Keywords`     | `["beach", "sunset"]`    | `["beach", "sunset"]` (same — no PrintConv applies) |

We want **pass A for display** (matches what every other tool shows) and **pass B for editing and verification** (the actual machine value, unambiguous on write).

Both passes expose `table`, `id` and optional `index`. They are joined by exact
`SchemaDefinitionId`, never by the original JSON property name. The frontend
receives metadata as `{id, value}` entry arrays, then may token-key JavaScript
collections with `schemaDefinitionIdToken(id)` while retaining the structured
ID in every value. Image columns and sorting also carry exact IDs.

### Why not just compute pretty form ourselves

For enum tags (`Orientation`, `WhiteBalance`, `Flash`-as-table), we could — `-listx` gives us the table. We don't, for two reasons:

1. Code-based PrintConv (`ExposureTime`, `GPSLatitude`, `FileSize`, `Duration`, `LensID` against external lens database, hundreds of MakerNotes formatters) is implemented in Perl in exiftool's source. Reimplementing means tracking exiftool's release-by-release changes forever. Wrong tool for the job.
2. Even where we could (enums), the user benefit is small. Two-pass cost is one extra exiftool exec per scan batch, not per file. exiftool's startup time dominates; the second pass adds maybe 50%, not 100%, of the wall time.

If scan latency ever becomes a real complaint, the fallback is lazy pass-A: scan with `-n` only, fire a second exec on details-pane open for just the selected file. Defer until measured.

### Cost

Two execs per batch. For a 1000-file scan in batches of 100, that's 20 execs instead of 10. exiftool startup is the dominant cost; the file-read cost is paid once (filesystem cache).

---

## 5. Editing: schema-driven UI

The edit dialog is a router on `TagKind` from the registry. Each kind has a dedicated control. The user is never asked "is this a string or a number?" — the schema knows.

### Editors by kind

| Kind                                         | Control                                       | Notes                                                                   |
| -------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `Text`                                       | text input                                    |                                                                         |
| `LangAlt`                                    | language tab strip; per-lang textarea         | `x-default` always present and explicit                                 |
| `Bag<Text>` (Keywords, Subject)              | chip editor                                   | individual add/remove; never joined                                     |
| `Seq<Text>`                                  | chip editor with reorder                      | order matters                                                           |
| `Integer`                                    | numeric input + bounds                        |                                                                         |
| `Real`                                       | numeric input                                 |                                                                         |
| `Rational` (ExposureTime, ShutterSpeedValue) | numerator/denominator pair, or decimal toggle |                                                                         |
| `Boolean`                                    | tri-state (true / false / unset)              |                                                                         |
| `Date`                                       | date picker                                   | emits `YYYY:MM:DD`; for date-only metadata such as IPTC IIM date fields |
| `Time`                                       | time picker                                   | emits `HH:MM:SS`; for time-only metadata such as IPTC IIM time fields   |
| `DateTime`                                   | datetime picker                               | emits `YYYY:MM:DD HH:MM:SS±ZZ:ZZ`; for full EXIF/XMP timestamp fields   |
| `Enum<Integer>` (Orientation, Flash-base)    | dropdown of labels                            | draft stores code; display shows label                                  |
| `Enum<String>` (some XMP enums)              | dropdown of labels                            |                                                                         |
| `Struct`                                     | nested form                                   | each field recurses                                                     |
| `Unknown`                                    | read-only                                     | editing as text could destroy structure or type information             |
| `Binary`                                     | read-only                                     | "not editable in app"                                                   |

### Recursive composition

The editor router is generic over `TagKind`. Each kind's editor delegates back to the router for any inner kind. That means arbitrary nesting works without special cases: a `Bag<Struct>` renders as a chip-list of expandable sub-forms, a `Seq<LangAlt>` as an ordered list of language-tab strips, a `Struct` whose field is itself a `Bag<Text>` as a sub-form containing a chip editor. No depth limit. Face-region markup (`XMP-mwg-rs:Regions`, a Bag of structs with per-face name/area sub-fields) works through the same router as a flat string tag.

Temporal metadata is intentionally split into three first-class schema kinds. `Date` represents date-only values, `Time` represents time-only values, and `DateTime` represents full timestamps. This keeps the UI faithful to the underlying storage: a tag that only stores an IPTC IIM date should not ask the user for a time, and a tag that only stores an IPTC IIM time should not ask for a calendar date. Temporal editor selection comes only from `TagInfo.kind`; the frontend does not infer temporal meaning from a tag name or the current value.

### Special-case overrides

A small set of editor behaviors cannot sensibly live in the static tag schema because they combine multiple tags or reinterpret a packed value. These have frontend routing overrides:

- **GPS coordinates**: `GPS*Latitude`, `GPS*Longitude`, `GPS*Altitude` get a DMS / decimal composite editor. App owns the conversion math — fixed, not version-dependent.
- **`Flash`**: bitfield editor with checkboxes per bit (fired / return-detected / red-eye / function), plus mode sub-enum. Bit layout hardcoded per exiftool documentation. Computed code preview shown.

The frontend override list lives in one file (`src/metadata/tag_overrides.ts`). Adding a new frontend override is a single-file change.

Known temporal tags that `-listx` reports as `string` are promoted in the backend schema override table in `src-tauri/src/tag_schema.rs`, for example common XMP create/modify/metadata timestamp fields. Those tags then flow through the same schema-driven badge, editor, write-back, and verification paths as every other `DateTime` tag.

#### GPS paired tags

`GPSLatitude` is meaningless without `GPSLatitudeRef` (the N/S hemisphere). Same for Longitude/LongitudeRef and Altitude/AltitudeRef (above-or-below-sea-level).

How we handle the pairing:

- Draft store keeps each tag as a **separate entry**. No paired-edit primitive at the draft layer.
- The GPS editor displays a one-line warning above the input: "Editing this location will also write `GPSLatitudeRef`, `GPSLongitudeRef`, …".
- On save the editor writes all paired draft entries together so the numeric value and its reference can never be out of sync.
- Discarding the location discards every paired draft entry.

The same pattern applies to any future paired-tag editor (the warning text and the on-save write-list are the only per-editor bits).

### Worked example: Orientation

1. Pass A reads `Orientation = "Rotate 90 CW"` (display).
2. Pass B reads `Orientation = 6` (raw).
3. Details pane shows `"Rotate 90 CW"`.
4. User clicks edit. Registry says `Orientation` is `Enum<Integer>` with options `[(1, "Horizontal (normal)"), ..., (6, "Rotate 90 CW"), ...]`.
5. Editor renders a dropdown of labels, with `"Rotate 90 CW"` selected.
6. User picks `"Rotate 180"`. Draft stores `{ value: MetadataValue::Integer(3), intent: Set, display: "Rotate 180" }`.
7. On apply, write-back emits `exiftool -n -Orientation=3`.
8. Re-read pass A shows `"Rotate 180"`. Verify succeeds.

### Worked example: ExposureTime

1. Pass A: `"1/250"`. Pass B: `0.004`.
2. Details pane shows `"1/250"`.
3. User clicks edit. Registry says `Rational`, no enum table.
4. Editor renders numerator/denominator inputs (`1` and `250`) with a decimal toggle.
5. User changes denominator to `500`. Draft stores `{ value: MetadataValue::Rational(1/500), intent: Set }`.
6. Write-back: `exiftool -n -ExposureTime=1/500`.
7. exiftool writes the rational `1/500` to the file.
8. Re-read pass A shows `"1/500"`. Verify succeeds.

### Worked example: Keywords

1. Pass A: `["beach", "sunset"]`. Pass B: same.
2. Details pane shows chips: [beach] [sunset].
3. User clicks edit. Registry says `Bag<Text>`.
4. Editor renders chip editor with `beach` and `sunset`, plus an input to add.
5. User adds `vacation`, removes `sunset`. Draft stores `{ value: MetadataValue::List { list_kind: Bag, items: [Text("beach"), Text("vacation")] }, intent: Set }`.
6. Write-back: `exiftool -XMP-dc:Subject= -XMP-dc:Subject=beach -XMP-dc:Subject=vacation`. The empty assignment clears the existing list before re-adding; explicit replace, no ambiguity.
7. Re-read shows `["beach", "vacation"]`. Verify succeeds.

---

## 6. Writing: argument construction and verification

Default policy: prefer the numeric `-n` form everywhere it applies — most robust against locale and presentation quirks.

### Argument rules

For each draft edit, the writer builds exiftool argv based on the tag's kind and the edit's intent:

| Intent       | Kind                               | Args                                                               |
| ------------ | ---------------------------------- | ------------------------------------------------------------------ |
| `Set`        | `Text` / `Integer` / `Real` / etc. | `-TAG=value`                                                       |
| `Set`        | `Bag` / `Seq`                      | `-TAG=` then `-TAG=item1 -TAG=item2 ...` (explicit clear + repeat) |
| `Set`        | `LangAlt`                          | `-TAG-lang=value` per language; `x-default` explicit               |
| `ListAdd`    | `Bag` / `Seq`                      | `-TAG+=item` per item                                              |
| `ListRemove` | `Bag` / `Seq`                      | `-TAG-=item` per item                                              |
| `Delete`     | any                                | `-TAG=`                                                            |

The previous implementation joined list values with `", "` and emitted `-TAG=a, b`. exiftool does not split on comma by default; the result was a single-element list containing the joined string. The repeated-arg form is unambiguous and matches exiftool's documented contract.

### `-n` scope: two-pass write

exiftool's `-n` is global to an invocation. A single invocation cannot mix numeric-form and pretty-form arguments. The writer therefore splits the argv into two groups and runs exiftool twice:

- **Group A (numeric)**: `Integer`, `Real`, `Rational`, `Boolean`, `Enum<Integer>`, GPS coords, datetime where we send raw — invoked with `-n`.
- **Group B (text)**: `Text`, `LangAlt`, `Bag<Text>`, `Seq<Text>` — invoked without `-n`.

Either group may be empty, in which case its invocation is skipped. Numeric group runs first so text-group edits can depend on numeric tags being set (rare but possible for derived fields).

### Verification

After write, the file is re-read with the scan flags and parsed into
`MetadataValue`. The observed semantic value is compared to the intended
`MetadataValue` using kind-aware equality:

- Lists: multiset for `Bag`, ordered for `Seq`.
- Floats: within type-specific epsilon (rationals tighter than reals).
- LangAlt: per-language map equality.
- Structs: recursive field equality.

Three outcomes:

1. **Match** — green badge. Draft cleared.
2. **Coerced** — exiftool wrote a normalized value (e.g. we sent `5`, file holds `5/1`; we sent `"True"`, file holds `True`). Yellow. Message: `exiftool normalized: sent <a>, file holds <b>. Accept?` The user confirms (clears draft) or reverts (re-stages with the file's value as the new draft).
3. **Mismatch / missing** — red. Possible causes: tag is not writable in this format (some formats don't support all XMP tags); exiftool silently dropped it; a higher-priority tag overwrote it. Expandable diff. Draft retained.

The previous implementation skipped the verify check entirely for non-`String` variants (`apply_edits.rs:121`), silently accepting any post-write value. The new behaviour never hides divergence.

### Apply log

Every apply appends one line per tag to `MediaLibraryApplyLog.jsonl` next to the draft file: timestamp, file path, tag, intent, full argv, value before, value after, outcome. Append-only, never read by the app. User-inspectable for forensics or undo.

### Inactive schema-v5 single-file apply

The inactive `apply_edits_v5.rs` foundation uses the target-aware draft model
without changing production apply:

```text
v5 entry
→ exact authoritative pre-write target validation
→ structured selector collision check
→ target-aware argument planner
→ shared numeric/text ExifTool execution
→ authoritative occurrence readback
→ strict post-write exact-occurrence-ID validation
→ target-aware semantic verification
→ explicit post-write draft reconciliation
```

The complete batch, including argfile rendering, succeeds before any write.
Existing fields resolve only by exact `MetadataOccurrenceId`; neither schema
identity nor selector similarity may choose a replacement. New properties
require zero pre-existing exact-schema occurrences and resolve after writing as
zero, one, or multiple exact-schema occurrences. Multiple results are always
`AmbiguousPostWrite` and are never reduced through first-result, `Copy0`,
`IFD0`, lowest-ID, or writability preference.

Both pre-write and post-write authoritative collections require unique exact
`MetadataOccurrenceId` values. A duplicate exact post-write ID is a
`ReadbackInvalid` invariant failure, not an I/O read failure: the complete
readback is rejected before any target is verified, no target clears, and the
invalid `ImageMetadata` is not exposed as fresh metadata. Multiple distinct IDs
that share one schema do not violate this invariant. Existing IFD0 and IFD1
targets, for example, remain independently resolvable, while multiple distinct
same-schema IDs for a new property remain `AmbiguousPostWrite`. These results
do not depend on occurrence order.

Both v4 and v5 use the same argfile escaping, numeric-before-text execution,
and value-oriented semantic verification. V5 separately models what should
happen to the original logical draft slot:

```text
Clear    semantic success; remove the original slot
Keep     original target remains retryable, or authoritative state is unknown
Replace  remove the original slot and retain the same edit with an exact supplied target
Blocked  retain for user resolution without claiming it is safely re-applicable
```

An existing target clears only for `Match` or `DeleteOk`; pending semantic
results keep the unchanged exact target. Missing occurrences and changed
schema/selector snapshots are blocked rather than automatically retargeted.
For `NewProperty`, zero matches keep the creation target and a unique `Match`
clears it. A unique non-clear result must not remain a creation target after the
property exists: reconciliation replaces it, when possible, with the exact
fresh occurrence ID, embedded schema, and runtime selector. Read-only or
untargetable created occurrences block. Ambiguous creation blocks without
selecting any replacement. Readback failure or invalidity keeps the original
target conservatively and performs no partial replacement.

The inactive application stage is a pure, atomic transformation:

```text
original v5 entry
+ target outcome reconciliation
→ validated reconciled v5 entry collection
```

Before constructing output, it indexes and rejects duplicate original slots,
indexes and rejects duplicate outcome slots, rejects unexpected outcomes,
requires exactly one outcome per original slot, and compares the complete
outcome target snapshot with the complete original target. Slot or schema
identity alone never authorizes a match. `Clear` omits the entry; `Keep` and
`Blocked` preserve its target and edit unchanged. `Replace` is permitted only
from `NewProperty` to the supplied exact `ExistingOccurrence`, with the same
schema, and preserves the original semantic edit byte-for-byte through
serialization. It never derives an edit from sent, before, observed, display,
or occurrence-value data.

Every replacement slot is checked against retained original slots, other
replacement slots, and every different original operation including a cleared
one. Any convergence rejects the complete transformation instead of merging
operations. Successful output uses logical-slot ordering. Blocked reasons stay
transient on outcomes for a future command and frontend to surface; they are
not added to schema-v5 persistence. The pure file helper performs no
persistence or metadata writes. It is composed by the inactive v5 batch command
and protocol adapter but has no production caller or frontend state consumer,
and production persistence and apply remain schema v4.

`targets_to_clear` is derived only from `Clear` reconciliation, by logical slot
and in input order. Legacy projection omissions do not invalidate a v5
authoritative occurrence read. Successful, invariant-valid readback returns the
complete scanner `ImageMetadata` unchanged. Reconciliation application remains
inactive in-memory foundation code: there is no batch replacement persistence
and no frontend consumer.

The v5 path does not write the schema-keyed legacy apply log; target-aware
logging remains pending. The registered batch command and inactive frontend
adapter have no production caller. Production apply, persistence, frontend
state, and logging remain schema v4.

---

## 7. Persistence: drafts only

### Locked target model for the pending migration

`MetadataDraftTarget` defines the future distinction without changing current
draft persistence:

```text
ExistingOccurrence
    runtime MetadataOccurrenceId
    + semantic SchemaDefinitionId
    + exact MetadataWriteTarget snapshot

NewProperty
    semantic SchemaDefinitionId only
```

An existing target is created only from one explicit occurrence with writable
exact `TagInfo` and a present exact write target. A new-property target begins
from one exact writable `TagInfo` and does not invent an occurrence, family-1
group, or selector. No schema lookup may silently choose a first occurrence.

The write-target snapshot must be revalidated against the exact occurrence
after rereading the authoritative file before a later apply pipeline writes.
The relative file path remains outer draft-map context and is not part of the
target.

Target snapshots and draft slots have separate identities:

```text
target snapshot identity
    ExistingOccurrence = occurrence + schema + selector
    NewProperty        = schema

draft-slot identity
    ExistingOccurrence = occurrence only
    NewProperty        = schema only
```

The complete snapshot is preserved for stale-target validation, while the slot
identifies one logical draft position. A changed schema or selector snapshot
therefore cannot create a second draft for the same occurrence. Existing and
new variants remain distinct operations even when their schemas match.

Pure write planning now implements the two selector paths:

```text
ExistingOccurrence
    validate stored target against a fresh authoritative occurrence
    → fresh MetadataWriteTarget selector
    → fresh embedded TagInfo semantic encoding

NewProperty
    validate exact supplied TagInfo schema
    → schema-driven creation selector
    → supplied TagInfo semantic encoding
```

The stored selector snapshot is never sufficient without fresh-occurrence
validation. Existing-occurrence planning never uses `TagInfo::group` for the
write destination; new-property creation remains schema-driven because it has
no occurrence selector. These planners share the legacy builder's semantic
value encoder and preserve its numeric/text pass grouping and argument order.

This model, its pure planners, and the composed inactive v5 single-file apply
foundation have no production consumer. Draft collections, UI behavior,
production write argument construction, and schema-keyed readback verification
remain unchanged. Production Tauri commands still use the schema-v4 loader and
saver.

Inactive v5 Tauri load/save commands define the eventual target-aware JSONL
line:

```json
{
  "schema_version": 5,
  "relative_path": "photo.jpg",
  "edits": [
    {
      "target": {
        "kind": "ExistingOccurrence",
        "occurrence_id": {
          "document": null,
          "path": "JPEG-APP1-IFD0",
          "tag_id": "282",
          "copy": 0
        },
        "schema_id": { "table": "Exif::Main", "tag_id": "282" },
        "write_target": { "group1": "IFD0", "tag_name": "XResolution" }
      },
      "edit": {
        "value": { "kind": "Integer", "value": 300 },
        "intent": "Set"
      }
    }
  ]
}
```

The relative path remains outer context; it is not duplicated in a target. It
is an untrusted string key, so frontend collection construction and lookup use
own data properties rather than prototype-chain behaviour. Reserved-looking
filenames such as `__proto__`, `constructor`, `prototype`, `toString`, and
`hasOwnProperty` are preserved exactly.
V5 entries preserve complete targets but reject duplicate draft slots. Files
sort by relative path and entries sort by `MetadataDraftSlot`, after validating
the complete input before truncation. The registered commands share the v4
filename and must not be mixed with v4 commands during one live folder session.
Registration does not imply production usage: no production caller invokes
them.

The frontend now has an equally inactive target-aware collection, observable
store, and Tauri adapter:

```text
file-relative path
→ metadataDraftTargetSlotToken(target)-keyed collection
→ complete MetadataDraftTarget + MetadataDraftEdit
```

The JSON slot token is collection mechanics only and is never the domain
identity of a draft. Each entry stores the complete target snapshot. Setting a
new snapshot in the same slot replaces both target and edit rather than
creating a second draft. Unknown command results pass through shared structural
identity and recursive semantic-value guards; one invalid entry rejects the
complete load. Only deterministic `MetadataDraftEntryV5[]` arrays cross Tauri.
From-wire conversion rejects duplicate slots. Save conversion and store reset
validate all record keys and logical slots first, never silently re-key malformed
collections, and leave store state unchanged on failure. Rust persistence also
rejects duplicates before opening or truncating the file. A contract test now
round-trips the frontend collection through the Tauri wire shape and back,
including shared-schema occurrences and existing/new targets sharing a schema.
Object-property behaviour is never draft identity; logical identity remains the
target slot. The frontend semantic guard distinguishes integral finite
`Integer` values from finite fractional `Real` values, requires `Unknown.raw`
to contain only recursively JSON-compatible values, and rejects content fields
on the `Null` and `Binary` unit variants.

V4 entries are not automatically converted. A schema ID does not say whether
the operation edits an existing occurrence or creates a new property, and
choosing a first occurrence would be forbidden first-match logic. Pending v4
drafts must be recreated after the eventual migration. Activating v5 apply is
still pending. No production component creates the target-aware store or
imports the adapter; production frontend startup, `AppState`,
`DraftEditsStore`, autosave, apply, and verification remain schema-keyed v4 and
keep using the v4 commands.

MediaLibrary persists draft edits (`MediaLibraryDraftEdits.jsonl`). Read metadata is **not** cached — every scan re-queries exiftool. Reasons:

- exiftool is the source of truth; caching invites staleness.
- The file is the canonical store. Sidecars introduce sync questions we don't want to answer.
- exiftool startup amortizes well over batches; scan cost is acceptable.

Draft schema is versioned. The production on-disk draft schema is v4; schema v5
is available only through the explicitly versioned inactive commands and
inactive target-aware store. The inactive single-file v5 apply foundation is
composed by the versioned batch command but has no production caller.
Every v4
draft entry carries the exact ExifTool schema-definition identity; JSON object
keys and display labels are never used as metadata identity:

```json
{
  "schema_version": 4,
  "relative_path": "photo.jpg",
  "edits": [
    {
      "id": { "table": "XMP::dc", "tag_id": "description" },
      "edit": {
        "value": { "kind": "Text", "value": "caption" },
        "intent": "Set",
        "display": "optional UI label"
      }
    }
  ]
}
```

To ensure integrity and predictability, the persistence layer enforces the following validation and sorting guarantees:

- **No Duplicate Entries**: Both load and save operations reject any draft edit payload containing duplicate `SchemaDefinitionId` keys for the same file.
- **No Duplicate Paths**: Loading draft edits rejects payloads containing duplicate `relative_path` entries.
- **Deterministic Ordering**: When saved to disk, lines (files) are sorted alphabetically by `relative_path`, and the edits list within each line is sorted by `SchemaDefinitionId`.

Older v1-v3 draft files are not loaded or migrated. Loading a legacy line
returns a clear error telling the user to recreate pending drafts with
`schema_version` 4. This avoids reconstructing exact schema identity or
semantic values from legacy
strings or JSON-shaped raw values.

Likewise, legacy image-column settings without exact IDs are reset instead of
being guessed from friendly strings.

---

## 8. What we explicitly do not do

- **No PrintConv reimplementation.** Pretty display comes from exiftool itself (pass A). We don't ship a Perl-equivalent formatter.
- **No silent type coercion.** If exiftool normalizes a value on write, the user is told.
- **No silent batch drops.** A single bad file logs a warning; other files in the batch parse normally.
- **No comma-joined list editing.** Lists are always edited as lists.
- **No auto-sync between overlapping tags.** `Keywords` (IPTC), `Subject` (XMP-dc), and `HierarchicalSubject` (Lightroom) overlap conceptually. We display them as separate fields and document the overlap. The user decides which to edit.
- **No magic for unwritable tags.** Block at the UI with the registry's reason.
- **No general RDF/XMP graph editor.** We work with the flat tag list `-listx` exposes. Struct editing is supported for the cases exiftool surfaces; we don't expose RDF semantics.

---

## 9. Glossary

### Inactive schema-v5 batch transport

The registered but frontend-inactive v5 command strictly loads one v5 map,
rejects duplicate requested paths before writing, applies selected files in
request order, reconciles every complete target outcome vector, saves only
changed complete candidates, emits versioned progress, and checks cancellation
at the next file boundary. No-outcome hard failures do not alter drafts;
semantic errors do not suppress valid reconciliation; and reconciliation or
persistence failures abort later files. Candidate state is adopted only after
save succeeds.

The command has an atomic, v5-only admission gate: at most one schema-v5 batch
apply can hold its cancellation flag. A second invocation is rejected as busy
before spawning a worker, loading drafts, emitting started or progress events,
writing metadata, or saving drafts, and it cannot replace the active flag.
Cancellation consequently targets the sole active operation. Normal
completion, worker failure, and worker join failure release the state through
an ownership-aware clear and permit reacquisition. Production v4 uses a
separate state and retains its existing lifecycle.

Its progress result preserves full `ImageMetadata` (authoritative occurrences
plus compatibility metadata), complete targets and reconciliation decisions.
`persisted_draft_entries` is null for no successful map change, empty when the
file key was removed, and non-empty for exact retained/replaced entries. There
is no production caller/listener, production state/event switch, or target-aware
log entry. Production remains schema-v4.

An inactive frontend apply adapter accepts every command result and versioned
event payload as `unknown`, then strictly validates complete nested targets,
semantic values, outcomes, reconciliation, authoritative occurrences,
compatibility metadata, and persisted entries. It rechecks replacement domain
invariants at this boundary. Fresh authoritative occurrences must have unique
exact `MetadataOccurrenceId` values, and compatibility entries must have
unique exact `SchemaDefinitionId` values. The latter includes the optional
index, so an absent index and index zero remain distinct. Any exact duplicate
invalidates the complete file result or progress event; no first entry is
selected and no reduced collection is constructed. Invocation and listener
registration remain separate. Progress events are supplemental and may be
absent after a non-fatal emission failure; the final command result is
authoritative for completed files and batch status.

This strict apply boundary does not change lossy scan-event normalization.
Scan events may drop malformed or duplicate exact occurrences, preserve valid
siblings in deterministic order, warn, and continue. The apply adapter rejects
the complete invalid containing result because its final command results are
authoritative protocol data.

The events carry no operation ID because the backend permits only one active v5
apply. No frontend store, `AppState`, or production React consumer uses the
adapter. Startup, autosave, persistence, and apply remain schema v4;
coordination with the separately callable v5 load/save commands and a future v5
autosave policy remains production-activation work.

The inactive frontend also has a pure v5 result preparation and store-application
layer. Its flow is `strict result → clone and prepare exact candidates → replace
non-null persisted target drafts → replace both non-null fresh metadata views →
return cloned target outcomes`. Persisted entries are authoritative; frontend
reconciliation is forbidden. Null persisted entries mean no successfully
persisted draft-map change, whereas an empty array authoritatively removes the
file.

Fresh metadata is authoritative independently of success or semantic error.
Progress and final results may repeat a file, so all three stores use exact
structural snapshot equality to suppress identical mutations and notifications.
This equality preserves rational representation, complete target/schema/runtime
identity, and occurrence order while ignoring record insertion order. A final
result that genuinely differs still overwrites earlier progress state.

Target outcomes are returned for future verification state but are not stored.
There is no autosave, React integration, production caller, or Tauri subscription
in this layer. Production persistence and apply remain schema v4.

### Inactive schema-v5 frontend controller

The inactive, non-React `TargetApplyControllerV5` now composes the strict
transport and store-application layers as `local ownership → autosave
suppression → versioned listeners → versioned command → incremental strict
progress application → progress disablement → authoritative final application
→ cleanup and release`.

Local overlap fails before side effects. Backend exclusivity remains the
cross-process and cross-caller authority, while a unique local generation token
contains callbacks from older or released runs. The controller is intended to
be the sole frontend v5 apply owner on future activation because versioned
events have no operation ID. Progress remains supplemental; event protocol,
progress application, state-listener, and optional callback failures are
contained rather than thrown from event callbacks or treated as cancellation.

The final command result is authoritative. Progress is disabled before final
application, preventing late callbacks from overwriting final state. Exact
structural equality makes identical progress/final snapshots no-ops without
duplicate notifications, and genuinely different final snapshots still
replace progress state. Command rejection preserves the exact primary error
and retains any already-applied authoritative progress data; there is no local
snapshot rollback.

`TargetDraftAutosaveGateV5` is held during listener setup, every progress and
final store mutation, and listener cleanup, then released idempotently on every
exit path. It only models suppression ownership: it performs no persistence and
has no store subscriber. Cancellation reuses its active signal request and does
not release ownership or suppression before normal command settlement. Cleanup
failure cannot strand either lifecycle resource or mask an earlier command or
final-application failure.

There is no controller instance, React hook, `useMediaLibrary` integration,
target-aware `AppState`, or v5 autosave subscriber in the normal application.
Production startup, persistence, apply, editing, and verification remain schema
v4.

- **MetadataValue** — Discriminated semantic value model used inside the app for read metadata, draft edits, writes, verification, and apply logs.
- **SchemaDefinitionId** — Exact ExifTool definition identity: `{table, tag_id, index?}` from `-listx`. It remains the key for current schema-keyed v4 drafts and their production paths. It is distinct from runtime occurrence identity and exact write targeting. `Group1:Name` is display/search text only.
- **MetadataDraftTarget** — Locked future target union: an existing occurrence carries runtime occurrence, semantic schema, and exact selector snapshot; a new property carries only the selected schema. No production draft or apply path consumes it yet.
- **MetadataDraftSlot** — One logical draft position within a file: occurrence identity for an existing field, schema identity for a new property. It deliberately excludes stale target snapshots and the outer file-relative path.
- **ExifTool JSON boundary** - serde_json::Value held only at scan parsing boundaries before conversion into MetadataValue.
- **TagKind** — The schema's classification of a tag (`Text`, `Bag<Text>`, `Enum<Integer>`, etc.). Drives which editor renders.
- **PrintConv** — exiftool's mechanism for converting raw machine values to human-readable form. Table-based (we use it) or code-based (we don't reimplement).
- **`-n`** — exiftool flag suppressing PrintConv. Returns raw values.
- **`-G1`** — exiftool flag prefixing tag names with their specific group (`XMP-dc:Subject` not `Subject`).
- **`-listx`** — exiftool flag producing the writable-tag database as XML.
- **LangAlt** — XMP alternative-language array (e.g. `Description` in multiple languages with one `x-default`).
- **Bag / Seq / Alt** — XMP list types: unordered, ordered, alternatives.
- **EditIntent** — `Set` / `Delete` / `ListAdd` / `ListRemove`. Determines the exiftool operator (`=`, `+=`, `-=`).
