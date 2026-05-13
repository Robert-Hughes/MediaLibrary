# Metadata Formats — Implementation Plan

Companion document: `METADATA_FORMATS_DESIGN.md` (rationale, examples, user-facing behaviour).

This plan replaces the current string-collapsing metadata pipeline with a typed, schema-aware one that preserves data fidelity from exiftool through the UI and back to the file. Each phase is independently mergeable and revertible. Ship in order.

---

## Phase 0 — Safety net (no behaviour change)

Goal: stop silent failures before changing semantics.

### 0.1 Per-entry parse, not per-batch

- `src-tauri/src/scanner.rs:231` currently deserializes the whole exiftool JSON array into `Vec<HashMap<String, Variant>>`. One bad entry kills the batch.
- Change: parse as `Vec<serde_json::Value>` first, then convert each entry independently. On per-entry failure, log path + reason, skip that file, keep going.
- Add `tracing::warn!` with `SourceFile` so users see which file was dropped.

### 0.2 Fixture corpus

- New directory: `src-tauri/tests/fixtures/exiftool/`.
- Capture real `-j` output from:
  - JPEG with XMP `Subject` + IPTC `Keywords`
  - MOV with `Keys` group (nested object)
  - RAW (CR2 or ARW) with GPS rationals
  - JPEG with multi-language `XMP-dc:Description`
  - JPEG with face-region struct (`XMP-mwg-rs:Regions`)
  - JPEG with `Rating`, `Flash`, `Orientation` (enums)
- Each fixture is the literal exiftool stdout, committed.
- Tests: feed fixture → assert parse succeeds, assert specific tag values present.

**Deliverable:** one commit. No user-visible change. Reliability net for everything below.

---

## Phase 1 — Complete the `Variant` type

### 1.1 Extend the enum

`src-tauri/src/scanner.rs:47`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Variant {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    String(String),
    List(Vec<Variant>),
    Object(BTreeMap<String, Variant>),
}
```

- Order matters for `#[serde(untagged)]`. `Integer` must precede `Float` or all ints become floats.
- `BTreeMap` for stable serialization (deterministic diffs in JSONL).
- Custom fallback: if none of the variants match, store the raw `serde_json::Value` as `Variant::String(value.to_string())` and log at `debug` level. Never error.

### 1.2 Frontend mirror

`src/types.ts:13`:

```ts
export type Variant =
  | null
  | boolean
  | number
  | string
  | Variant[]
  | { [k: string]: Variant };
```

Note: TypeScript collapses int/float into `number`. Backend keeps the distinction. When the frontend needs to know (write-back of integer-typed tags), the schema (Phase 2) supplies the type, not the runtime value.

### 1.3 Display renderer

Replace `formatVariant` at `src/components/DetailsPane.tsx:29`. New `renderVariant(v)` returns JSX:

- `null` → muted "—"
- `boolean` → check icon
- `number` → right-aligned mono
- `string` → as-is
- `Variant[]` → chip list
- `Object` → expandable key/value sub-table

Never lossy-stringify. The comma-join bug at `DetailsPane.tsx:350` (using `formatVariant` output as edit-dialog seed) is fixed structurally: edit dialog receives the raw `Variant`, not a display string.

**Deliverable:** one commit. Visible change: lists no longer display as `"a, b"`; they appear as chips.

---

## Phase 2 — Tag schema registry

### 2.1 Build at startup

- New file: `src-tauri/src/tag_schema.rs`.
- On app startup, run `exiftool -listx -lang en` once. Parse the XML into:

```rust
pub struct TagInfo {
    pub group: String,         // "XMP-dc"
    pub name: String,          // "Subject"
    pub writable: bool,
    pub kind: TagKind,
    pub description: Option<String>,
}

pub enum TagKind {
    Text,
    LangAlt,
    Integer { min: Option<i64>, max: Option<i64> },
    Real,
    Rational,
    Boolean,
    DateTime,
    Enum { repr: EnumRepr, options: Vec<(String, String)> }, // (code, label)
    Bag(Box<TagKind>),
    Seq(Box<TagKind>),
    Alt(Box<TagKind>),
    Struct(BTreeMap<String, TagKind>),
    Binary,
    Unknown,
}

pub enum EnumRepr { Integer, String }
```

- Held in `Arc<RwLock<TagRegistry>>` on the Tauri state. In-memory only — no disk cache.
- Lookup is `Group:Name` (matches `-G1` output).
- Fallback for unlisted tags: `TagKind::Unknown`, writable = unknown. Treated as text by editor with a warning.

### 2.2 Expose to frontend

Tauri command `get_tag_info(tag: String) -> Option<TagInfo>`. Frontend caches per-session. Used by:

- Edit dialog router (Phase 4)
- New-property dialog autocomplete (Phase 4)
- Verifier (Phase 5)

### 2.3 Surface unknowns honestly

When the user edits a tag with `TagKind::Unknown`, the editor renders a warning: "Tag not in exiftool's writable schema; treating as raw text. Edit may be silently rejected by exiftool." Don't hide.

**Deliverable:** one commit. No edit-flow change yet. Schema endpoint available, registry populated at startup.

---

## Phase 3 — Draft layer carries `Variant`

This is the one-way door. Migrator must be bullet-proof.

### 3.1 Backend draft model

`src-tauri/src/draft_edits.rs:7`:

```rust
pub struct DraftEdit {
    pub value: Option<Variant>,   // None = delete
    pub intent: EditIntent,
}

pub enum EditIntent {
    Set,         // replace whole value
    Delete,      // -TAG=
    ListAdd,     // -TAG+=item per element
    ListRemove,  // -TAG-=item per element
}
```

Outer map shape unchanged: `HashMap<RelativePath, HashMap<TagKey, DraftEdit>>`.

### 3.2 JSONL schema version

Add top-level `"schema_version": 2` to each line. Migrator at load time:

- v1 (current, `Option<String>`): wrap each value as `Variant::String(s)` with `intent: Set`. `None` → `intent: Delete`.
- Before rewriting, copy `MediaLibraryDraftEdits.jsonl` to `MediaLibraryDraftEdits.v1.bak.jsonl` once. Log the migration. Surface a one-time toast in UI: "Draft edits migrated to schema v2. Backup saved."

### 3.3 Frontend draft store

`src/types.ts:211`:

```ts
export type DraftEditsValue = {
  value: Variant | null;
  intent: 'Set' | 'Delete' | 'ListAdd' | 'ListRemove';
};
```

`setDraftValue` in `src/hooks/useMediaLibrary.ts:41,652` changes signature. Every call-site updated; type system enforces.

### 3.4 Type-aware diff in draft pane

Original `Variant` vs draft `Variant`, rendered per type:

- Lists: highlight added/removed items individually
- LangAlt: per-language before/after
- Numerics: show both with precision indicator if differs
- Structs: per-field diff

Never display the diff as a string compare of joined representations.

**Deliverable:** one commit, but big. Visible change: draft pane shows structured diffs. Migration runs once.

---

## Phase 4 — Type-aware editors

`ValueEditDialog` becomes a router on `TagKind`. Each kind has a dedicated control:

### 4.1 Editors by kind

| `TagKind` | Editor |
|---|---|
| `Text` | text input |
| `LangAlt` | language tab strip; per-lang textarea; explicit `x-default` |
| `Bag<Text>` / `Seq<Text>` | chip editor; add/remove/reorder; never joined |
| `Integer { min, max }` | numeric input with bounds + step from schema |
| `Real` | numeric input |
| `Rational` | numerator/denominator pair, or decimal toggle |
| `Boolean` | tri-state checkbox (true / false / unset) |
| `DateTime` | datetime picker emitting `YYYY:MM:DD HH:MM:SS±ZZ:ZZ` |
| `Enum { Integer }` | dropdown of labels; draft stores numeric code |
| `Enum { String }` | dropdown of labels; draft stores code (same as label often) |
| `Struct` | nested form per field, each field recurses into kind router |
| GPS coordinates (name-matched, override) | DMS / decimal composite |
| Bitfield (name-matched, override: `Flash`, ...) | checkbox per bit + sub-enum + computed code preview |
| `Unknown` | text input + "raw text" warning banner |
| `Binary` | read-only with "binary, not editable" message |

### 4.2 Hardcoded special-case list

App owns conversion logic for tags exiftool's `-listx` does not describe semantically:

- `GPS*Latitude`, `GPS*Longitude`, `GPS*Altitude` → composite editor
- `Flash` → bitfield editor (bit layout hardcoded per exiftool docs)
- `*Date*` / `*Time*` (where listx says `string` but value matches exiftool date pattern) → datetime editor

This list lives in `src/metadata/tag_overrides.ts`. Adding a new override is a single-file change.

### 4.3 New-property dialog

`src/components/NewPropertyDialog.tsx:32`:

- Autocomplete from registry. User types `Subject`; suggestions: `XMP-dc:Subject`, `IPTC:Subject`, etc.
- After tag selection, the value control switches to the matching editor.
- Unknown / unwritable tags blocked with explanation.

**Deliverable:** one commit per editor kind is fine; ship as a series. Visible change: every edit uses the right control.

---

## Phase 5 — Write-back fidelity

### 5.1 Argument builder

Replace `src-tauri/src/apply_edits.rs:73`. New function:

```rust
fn build_args(tag: &str, info: &TagInfo, intent: EditIntent, value: Option<&Variant>) -> Vec<String>;
```

Rules:

- **List `Set`**: emit `-TAG=` (clears existing) then `-TAG=item` per element.
- **List `ListAdd`**: `-TAG+=item` per element.
- **List `ListRemove`**: `-TAG-=item` per element.
- **`LangAlt`**: `-XMP-dc:Description-en=...`. Default language explicit as `x-default`. One arg per language present in draft.
- **Numeric / Bool / Enum / DateTime**: emit raw value. These need `-n` (see 5.2).
- **`Delete`**: `-TAG=`.
- **Text**: emit value as-is.

### 5.2 Two-pass exec for `-n` scoping

exiftool's `-n` is global to an invocation. Solution: split args into two groups:

- Group A: tags whose values need numeric interpretation (`Integer`, `Real`, `Rational`, `Boolean`, `Enum{Integer}`, `DateTime` shutter math, GPS coords).
- Group B: text, lang-alt, lists of text.

Run two `exiftool` invocations in sequence: one with `-n`, one without. Both pointed at the same file. Order: numeric first, then text (text writes can depend on numeric tags being set; rare but happens for derived fields).

If only one group has args, skip the other invocation.

### 5.3 Argv preview

Before applying, show a "Preview command" panel listing the exact argv for each invocation. User can copy. Default on for first ten applies per session, then opt-in via a toggle. Reason: trust-building. User sees what we're about to do.

### 5.4 Verification re-read and reporting

After write, re-read the file using scan flags (Phase 6). Compare `Variant` to `Variant` with type-aware equality:

- Lists: multiset equality for `Bag`, ordered for `Seq`.
- Floats: `abs(a - b) < ε`, ε per type (rationals tighter than reals).
- LangAlt: per-lang map equality.
- Structs: recursive.

Outcomes:

- **Match**: green, draft cleared.
- **Coerced**: exiftool wrote a normalized value (we sent `5`, file holds `5/1`; we sent `"true"`, file holds `True`). Yellow, message: "exiftool normalized: sent `<a>`, file holds `<b>`. Accept?" User confirms or reverts.
- **Mismatch**: red, expandable diff, draft retained.
- **Tag missing post-write**: special case for unwritable tags exiftool silently dropped. Red, message: "Tag `<X>` was not written. Possible causes: not writable in this format, format-specific restriction." Draft retained.

Never silently accept divergence (current behaviour at `apply_edits.rs:121`).

### 5.5 Apply log

Append-only JSONL: `MediaLibraryApplyLog.jsonl`. One line per tag per apply: timestamp, file, tag, intent, argv, value-before, value-after, outcome. User-inspectable; never read by the app, only written.

**Deliverable:** one commit. Visible change: preview dialog, verification messages, log file.

---

## Phase 6 — Scanner read flags

`src-tauri/src/scanner.rs:177`. Update exiftool invocation.

### 6.1 Flag changes

Current:
```
exiftool -a -G1 -s --system:all --composite:all -j <paths>
```

New, two-pass:

**Pass A (pretty, for display):**
```
exiftool -a -G1 -s -struct -charset filename=utf8 -charset utf8 --system:all --composite:all -j <paths>
```

**Pass B (numeric, for edit-binding + verification):**
```
exiftool -a -G1 -s -struct -n -charset filename=utf8 -charset utf8 --system:all --composite:all -j <paths>
```

Flag rationale:

- `-G1`: group prefix on tag names (`XMP-dc:Subject`). Disambiguates duplicates. Already present.
- `-struct`: keep nested XMP structs as JSON objects rather than auto-flattening. Now safe to parse (Phase 1 added `Object` variant).
- `-charset` pair: explicit UTF-8 for filenames and tag values. Avoids Windows code-page surprises.
- Pass B `-n`: raw machine values for numerics, enums, GPS, datetime.

### 6.2 Merge into `ImageMetadata`

```rust
pub struct ImageMetadata {
    pub path: PathBuf,
    pub display: HashMap<String, Variant>,   // pass A
    pub raw: HashMap<String, Variant>,       // pass B
}
```

- Details pane reads `display`.
- Editor binds to `raw[tag]`.
- Verification compares `raw` before/after.

### 6.3 Cost

Two exiftool invocations per scan batch (not per file). Batched scan already amortizes startup cost over many files; adding a second pass roughly doubles scan time. Acceptable. If complaints arise, switch to lazy pass-A-on-selection.

**Deliverable:** one commit. Visible change: display values now match exiftool exactly (pretty form preserved for free).

---

## Phase 7 — Tests and documentation

Test strategy: **hybrid tiers**.

- **Unit tier** (`cargo test`, `vitest`) — fast, offline, runs every commit. Operates on fixture JSON/XML strings and pre-baked image fixtures. No exiftool exec.
- **Integration tier** (`cargo test --features integration`, `vitest --project integration`) — disabled by default. Runs real exiftool against image fixtures. Round-trip write-and-re-read tests. Required for sign-off.

`AGENTS.md` (created in 7.0 below) tells contributors that running `cargo test` alone is not sufficient — the integration tier must be run to claim full pass.

### 7.0 AGENTS.md and fixture corpus

Create `AGENTS.md` at repo root documenting:

- The hybrid test tiers and how to run each.
- The image fixture corpus location and provenance.
- The mutation testing job.
- Required pre-commit / pre-merge tier coverage.

Image fixtures live at `src-tauri/tests/fixtures/images/`. Each fixture is a real JPEG / TIFF / HEIC / MOV / RAW source from `D:\OneDrive\Pictures` that has been:

1. Resized to 4×4 pixels (or smallest legal for the format) with exiftool `-all=` stripped, then specific tags re-applied to a known state.
2. Renamed by what it tests: `keywords_basic.jpg`, `langalt_description.jpg`, `gps_decimal_rational.jpg`, `face_regions_mwg.jpg`, `orientation_rotate90.jpg`, `flash_bitfield.jpg`, `nested_keys_quicktime.mov`, `unicode_paths_漢字.jpg`, `malformed_truncated.jpg`, etc.
3. Committed to git directly (no LFS). Each fixture is expected to be <2 KB after stripping.
4. Documented in `src-tauri/tests/fixtures/images/README.md` — one line per fixture: file, source camera/format, what it tests, exact tag values it should contain.

Fixtures are static. **No exiftool runs during test setup.** Tests open the committed file and assert. To add a new fixture, the contributor runs exiftool by hand once to produce it, commits the file plus an entry in the README. The README acts as the canonical "what does this file contain" reference.

A small helper script `tools/build-fixture.sh` (committed but not run in CI) documents how each fixture was produced — so the corpus is reproducible by hand if someone wants to regenerate.

### 7.1 Test matrix: design section → tests

The table maps every promise in `METADATA_FORMATS_DESIGN.md` to a named test. If a row has no test, the promise is unverified — design is on the hook.

#### Design §2 — `Variant` type

| Promise | Test | Tier | File |
|---|---|---|---|
| All 7 variants serde JSON round-trip | `variant_null_roundtrip`, `_bool_`, `_integer_`, `_float_`, `_string_`, `_list_`, `_object_` | unit | `src-tauri/src/variant.rs` `#[cfg(test)]` |
| Untagged ordering: `5` parses as `Integer` | `variant_integer_takes_precedence_over_float` | unit | same |
| Untagged ordering: `5.6` parses as `Float` | `variant_float_for_fractional` | unit | same |
| Unknown shape falls back to `String` with debug log | `variant_unparseable_becomes_string` | unit | same |
| Nested `Object` round-trip | `variant_nested_object_roundtrip` | unit | same |
| Property: any `serde_json::Value` → `Variant` → JSON is idempotent (for representable shapes) | `prop_variant_json_idempotent` | unit (proptest) | same |
| Frontend `Variant` matches Rust shape | `variant.type.test.ts` (type-level: assignment-compat assertions) | unit (vitest) | `src/types.test.ts` |

#### Design §3 — Tag schema registry

| Promise | Test | Tier | File |
|---|---|---|---|
| Parses `exiftool -listx` XML correctly | `listx_parses_text_tag`, `_integer_tag`, `_real_tag`, `_rational_tag`, `_boolean_tag`, `_datetime_tag`, `_langalt_tag`, `_bag_tag`, `_seq_tag`, `_alt_tag`, `_struct_tag`, `_binary_tag` | unit | `src-tauri/src/tag_schema.rs` |
| Enum (integer-coded) populates code→label table fully | `listx_orientation_enum_has_all_8_options` | unit | same |
| Enum (string-coded) parses | `listx_xmp_color_mode_string_enum` | unit | same |
| `writable=false` tags marked unwritable | `listx_marks_unwritable` | unit | same |
| Bounds extracted where present | `listx_rating_bounds_0_to_5` | unit | same |
| Lookup by `Group:Name` works | `registry_lookup_by_group_name` | unit | same |
| Unlisted tag → `TagKind::Unknown` | `registry_unknown_tag_falls_back` | unit | same |
| Real `exiftool -listx` startup actually populates non-empty registry | `live_listx_registry_nonempty` | integration | `src-tauri/tests/integration/registry.rs` |
| Registry rebuild on different exiftool versions doesn't panic | `live_listx_compat_versions` | integration (matrix CI) | same |

Fixture: `src-tauri/tests/fixtures/listx/sample_listx.xml` — a hand-curated trimmed subset of real `-listx` output covering each `TagKind`. Plus `sample_listx_v12.xml` and `sample_listx_v13.xml` if behaviour differs.

#### Design §4 — Reading (two-pass scanner)

| Promise | Test | Tier | File |
|---|---|---|---|
| Pass A returns pretty values | `scan_passA_orientation_pretty` (asserts `"Rotate 90 CW"`) | integration | `tests/integration/scanner.rs` |
| Pass B returns raw values | `scan_passB_orientation_numeric` (asserts `6`) | integration | same |
| `display` and `raw` merged correctly into `ImageMetadata` | `scan_image_metadata_has_both_views` | integration | same |
| `-struct` preserves nested objects | `scan_face_regions_struct_preserved` | integration | same |
| `-G1` prefixes tag keys | `scan_keys_include_group_prefix` | integration | same |
| UTF-8 filename charset works | `scan_unicode_filename_succeeds` (uses `unicode_paths_漢字.jpg`) | integration | same |
| Per-entry parse failure does not drop batch | `scan_one_bad_file_doesnt_kill_batch` (fixture: `malformed_truncated.jpg` mixed with valid files) | unit (canned JSON) + integration (real exec) | both |
| Fallback path: unknown JSON shape becomes `Variant::String` | `scan_unknown_object_shape_falls_through` | unit | same |
| Parse uses `serde_json::Value` first → per-entry conversion | `scan_per_entry_isolation` (force one entry to fail; assert others survive) | unit | same |
| Empty batch returns empty, doesn't panic | `scan_empty_input` | unit | same |
| Composite/system excluded as flagged | `scan_no_system_or_composite_tags` | integration | same |

Fixtures needed:
- `orientation_rotate90.jpg` (Orientation=6)
- `face_regions_mwg.jpg` (XMP-mwg-rs:Regions with 2 face structs)
- `unicode_paths_漢字.jpg`
- `malformed_truncated.jpg`
- `canned/scanner_passA.json`, `canned/scanner_passB.json`, `canned/scanner_mixed_good_bad.json` for unit tier

#### Design §5 — Editors per kind

| Promise | Test | Tier | File |
|---|---|---|---|
| `TagKind` routes to correct editor component | `EditorRouter.test.tsx` — one case per kind, asserts the right component renders | unit (vitest + RTL) | `src/components/ValueEditDialog.test.tsx` |
| `Bag<Text>` editor never joins values | `bag_editor_adds_chip_not_csv` (type "a", enter, type "b", enter → draft is `["a", "b"]` not `"a, b"`) | unit | `src/components/editors/BagEditor.test.tsx` |
| `Bag` editor remove individual chip | `bag_editor_removes_one` | unit | same |
| `Seq` editor reorder preserves order | `seq_editor_reorder` | unit | `SeqEditor.test.tsx` |
| `LangAlt` always shows `x-default` tab | `langalt_editor_xdefault_present_when_empty` | unit | `LangAltEditor.test.tsx` |
| `LangAlt` adding language tab | `langalt_editor_add_lang` | unit | same |
| `Enum<Integer>` dropdown lists all schema options | `enum_int_dropdown_full_options` (Orientation: 8 entries) | unit | `EnumEditor.test.tsx` |
| `Enum<Integer>` draft stores code not label | `enum_int_draft_stores_code` | unit | same |
| `Enum<Integer>` value not in schema → shows raw + "Custom..." | `enum_int_unknown_code_fallback` | unit | same |
| `Rational` editor accepts decimal toggle | `rational_editor_toggle_modes` | unit | `RationalEditor.test.tsx` |
| `Integer` editor enforces bounds | `integer_editor_clamps_to_max` (Rating > 5 rejected) | unit | `IntegerEditor.test.tsx` |
| `DateTime` editor emits exiftool format | `datetime_editor_emits_colon_format` | unit | `DateTimeEditor.test.tsx` |
| Override: `GPSLatitude` → DMS/decimal composite | `gps_override_renders_composite` | unit | `GpsEditor.test.tsx` |
| Override: GPS DMS↔decimal math correct | `gps_dms_decimal_roundtrip` (property test over coord range) | unit | same |
| Override: `Flash` → bitfield checkboxes | `flash_override_renders_bitfield` | unit | `FlashEditor.test.tsx` |
| Override: Flash bits ↔ code correct | `flash_bits_to_code_table` (full truth table) | unit | same |
| Override: name-matched date upgrade | `datetime_string_tag_upgraded_when_name_matches` | unit | same |
| Unknown tag → warning banner | `unknown_tag_shows_warning` | unit | same |
| Binary tag → read-only message | `binary_tag_not_editable` | unit | same |
| New-property dialog autocomplete | `new_property_autocomplete_from_registry` | unit | `NewPropertyDialog.test.tsx` |
| New-property: pick tag → editor switches | `new_property_editor_switches_on_tag_pick` | unit | same |
| New-property: unwritable tag blocked | `new_property_blocks_unwritable` | unit | same |
| Override list `tag_overrides.ts` is exhaustive for documented cases | `overrides_cover_gps_flash_dates` | unit | `src/metadata/tag_overrides.test.ts` |

#### Design §6 — Write-back

| Promise | Test | Tier | File |
|---|---|---|---|
| `Set` `Text` → `-TAG=value` | `argv_set_text` | unit | `src-tauri/src/apply_edits.rs` |
| `Set` `Integer` → `-n -TAG=N` | `argv_set_integer_uses_n_flag` | unit | same |
| `Set` `Bag` → `-TAG=` then `-TAG=item` repeated | `argv_set_bag_explicit_clear_then_repeat` | unit | same |
| `ListAdd` → `-TAG+=item` per item | `argv_listadd_repeated_plus` | unit | same |
| `ListRemove` → `-TAG-=item` per item | `argv_listremove_repeated_minus` | unit | same |
| `LangAlt` → `-TAG-lang=value` per lang | `argv_langalt_per_lang` | unit | same |
| `LangAlt` always includes `x-default` | `argv_langalt_xdefault_always_emitted` | unit | same |
| `Delete` → `-TAG=` | `argv_delete_empty_assign` | unit | same |
| Two-pass split: numeric kinds in `-n` group | `argv_split_numeric_to_n_group` | unit | same |
| Two-pass split: text kinds in non-`-n` group | `argv_split_text_to_plain_group` | unit | same |
| Empty group: skip invocation | `argv_skip_empty_n_group` | unit | same |
| Numeric group runs first | `argv_order_numeric_before_text` | unit | same |
| Value containing `=` or leading `-` doesn't break argv (argv pass, not shell) | `argv_value_with_equals_safe`, `argv_value_with_leading_dash_safe` | unit | same |
| Value containing NUL rejected | `argv_value_with_nul_errors` | unit | same |
| Argv preview reflects what will be exec'd | `preview_matches_actual_argv` (capture argv via mock exec) | unit | same |
| `build_args` total: never panics on any `(TagKind, Intent, Variant)` triple | `prop_build_args_total` | unit (proptest) | same |
| **Regression**: old CSV-keywords bug doesn't recur | `regression_keywords_never_csv_joined` (edits Bag, asserts argv has repeated args, never single comma value) | unit + integration | both |
| Verify: match → green outcome | `verify_match_clean` | unit | `verify.rs` |
| Verify: coerced (5 → 5/1) → yellow outcome with diff | `verify_rational_coerced_to_fraction` | integration | `tests/integration/verify.rs` |
| Verify: mismatch → red outcome | `verify_mismatch_red` | integration | same |
| Verify: tag missing post-write → red with explanation | `verify_unwritten_tag_red` (use tag we know format rejects) | integration | same |
| Verify: type-aware equality — Bag is multiset | `verify_bag_multiset_equal` | unit | same |
| Verify: type-aware equality — Seq is ordered | `verify_seq_order_matters` | unit | same |
| Verify: float epsilon | `verify_float_within_epsilon` | unit | same |
| Verify never silently accepts divergence | `verify_no_silent_skip_for_nonstring` (regression for old `apply_edits.rs:121` bug) | unit | same |
| Apply log appended per tag | `applylog_one_line_per_tag` | unit | `apply_log.rs` |
| Apply log is append-only (never truncated) | `applylog_append_only` | unit | same |
| Apply log captures argv, before, after, outcome | `applylog_schema_complete` | unit | same |
| Full round-trip per `TagKind` | `roundtrip_<kind>` for each: Text, Bag, Seq, LangAlt, Integer, Real, Rational, Boolean, DateTime, EnumInt, EnumStr, GPS, Flash, Struct | integration | `tests/integration/roundtrip.rs` |
| Cross-format: JPEG / TIFF / PNG / HEIC / MOV / CR2 / ARW each round-trip Keywords | `roundtrip_keywords_<format>` matrix | integration | same |
| Tag rejected by format surfaces clearly | `unsupported_tag_in_png_reports_clearly` | integration | same |

#### Design §7 — Draft persistence + migration

| Promise | Test | Tier | File |
|---|---|---|---|
| Draft JSONL v2 round-trip | `draft_v2_roundtrip` | unit | `src-tauri/src/draft_edits.rs` |
| v1 string-only migrates to v2 with `Variant::String` + `Set` intent | `migrate_v1_string_to_v2_set` | unit | same |
| v1 `null` migrates to `Delete` intent | `migrate_v1_null_to_delete` | unit | same |
| Migration creates `.v1.bak.jsonl` before rewrite | `migrate_creates_backup` | unit | same |
| Migration is idempotent (running on v2 file no-ops) | `migrate_idempotent_on_v2` | unit | same |
| Mixed-version JSONL handled (one line v1, one v2) | `migrate_mixed_versions` | unit | same |
| Corrupt JSONL line skipped, others preserved | `loader_skips_bad_lines` | unit | same |
| Property: any `DraftEdit` JSONL round-trips | `prop_draftedit_jsonl_roundtrip` | unit (proptest) | same |
| Frontend draft store type matches backend | type-check via `tsc --noEmit` in CI | unit | tsconfig |

#### Design §8 — Non-goals (negative tests)

| Promise | Test | Tier | File |
|---|---|---|---|
| App contains no PrintConv reimplementation | grep-style check: no large lookup tables in `src/metadata/` except documented overrides | unit (custom lint test) | `tests/no_printconv_reimpl.rs` |
| Silent batch drop cannot recur | `scan_partial_batch_failure_logged_visible` | unit | scanner tests |
| Unwritable tag UI block | `unwritable_tag_blocked_in_new_property` (already above) | unit | covered |
| Keywords/Subject not auto-synced | `keywords_subject_independent` (edit one, assert other untouched in draft and on disk) | integration | `tests/integration/sync.rs` |

### 7.2 Manual test plan (smoke)

Automated tests can't cover everything Tauri does (window IPC, OS file dialog, drag-drop). Add a checklist for human verification at release time:

`tests/manual/RELEASE_SMOKE.md`:

1. Open folder with mixed formats; details pane shows pretty values for Orientation, ExposureTime, GPSLatitude.
2. Edit Keywords on a JPEG: chip add/remove. Apply. Re-open externally (e.g. `exiftool -Keywords <file>`) → list matches.
3. Edit Description (LangAlt) on two languages. Apply. Verify both languages in file.
4. Edit Orientation via dropdown. Apply. File opens in Photos with new rotation.
5. Discard draft on a partially-edited file. Verify on-disk metadata unchanged.
6. Force a coerced write (set Rating to 3.5). UI shows yellow normalization message.
7. Edit a tag that doesn't exist on the format (e.g. XMP-mwg-rs on PNG). UI shows red unwritten message.
8. Apply log: open `MediaLibraryApplyLog.jsonl`, confirm one entry per tag edited.

### 7.3 Performance regression tests

Two-pass scanner could regress. Cheap check:

- `bench_scan_100_jpgs` — benchmark target, asserts wall time < 2× baseline.
- Run on every PR via `cargo bench --bench scan` (Criterion).

### 7.4 Frontend type contract

TypeScript types mirror Rust types. Drift is a recurring failure mode. Mitigation:

- `src-tauri/build.rs` emits a `types.generated.ts` from Rust types via `ts-rs` for `Variant`, `TagInfo`, `TagKind`, `DraftEdit`, `EditIntent`, `ImageMetadata`.
- `src/types.ts` imports from `types.generated.ts`; hand-written types are forbidden for the cross-boundary shapes.
- CI fails if `types.generated.ts` is out of date (build it in CI, diff against committed copy).

### 7.5 Tooling

- `tools/inspect-apply-log.ts` — pretty-prints `MediaLibraryApplyLog.jsonl`.
- `tools/build-fixture.sh` — documented commands to regenerate each test fixture (committed but not run in CI).
- `tools/check-fixtures.sh` — verifies each committed fixture still contains the tags `tests/fixtures/images/README.md` says it does. Run in CI.

### 7.6 Documentation

- `METADATA_FORMATS_DESIGN.md` linked from README.
- `AGENTS.md` describes test tiers and fixture provenance.
- `src-tauri/tests/fixtures/images/README.md` is the fixture index.

**Deliverable:** commit per sub-section. Order: 7.0 (fixtures + AGENTS.md) before any test work; 7.1 subsections per design section in design order.

---

## Sequencing summary

| Phase | Depends on | Risk | User-visible |
|---|---|---|---|
| 0 — safety net | — | low | no |
| 1 — complete Variant | 0 | medium | mild (list display) |
| 2 — schema registry | 0 | low | no (endpoint only) |
| 3 — Variant in drafts | 1 | high (JSONL migration) | yes |
| 4 — typed editors | 1, 2, 3 | medium | yes |
| 5 — write-back fidelity | 1, 2, 3 | high (two-pass exec, verify semantics) | yes |
| 6 — scanner two-pass | 1 | medium (perf) | indirect |
| 7 — tests + docs | all | low | no |

## Non-goals

- Not building a general RDF/XMP graph editor. Stick to the flat tag list `-listx` exposes.
- Not auto-syncing `Keywords` ↔ `Subject` ↔ `HierarchicalSubject`. Show as separate fields; document the overlap.
- Not silently dropping unwritable tags. Block at the UI with the registry's reason.
- Not reimplementing exiftool's Perl PrintConv code. Pretty display comes from exiftool itself (pass A).
