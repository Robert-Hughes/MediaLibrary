# Open questions and decisions log

Living document. Resolved items kept for traceability.

## Resolved

| # | Question | Decision |
|---|---|---|
| 1 | Fixture location | `test_images/` at repo root. Single fixture corpus. No separate `src-tauri/tests/fixtures/` tree. |
| 2 | Stray `MediaLibraryDraftEdits.jsonl` in `test_images/` | Deleted. Was untracked. |
| 3 | `Variant::Null` vs `Option<Variant>` | Keep `Variant::Null`. Avoids `Option<Option<…>>` mess at boundaries. |
| 4 | `Variant::Integer` precision | `i64` is fine. Out-of-range writes will surface as verifier mismatches (Phase 5). |
| 5 | listx runtime cost | Cache result to `<dirs::cache_dir>/MediaLibrary/tag_schema_<ver>.json`. Build lazily on first `get_registry()` call. Cache key includes exiftool `-ver`. |
| 6 | Cache invalidation on exiftool version change | Cache filename is keyed by version. New version → cache miss → rebuild. Single `exiftool -ver` subprocess at registry init. |
| 7 | Phase 3 migration | No saved drafts in the wild. Migration code exists and is tested but is dead-code in practice. Keep as defensive insurance; no UX toast needed. |
| 8 | Cross-version draft compatibility | N/A — single-user local desktop app. |
| 9 | Struct editor (face regions etc.) | Generic recursive editor that handles arbitrary nesting of all kinds, including list-of-struct, struct-of-list, etc. One renderer routed by `TagKind`. |
| 10 | GPS paired-tag handling | Draft stores GPS tags as separate entries (`GPSLatitude`, `GPSLatitudeRef`, …). The specialised GPS editor displays a one-line warning that editing the location will modify all paired tags. Editor writes all paired drafts together on save. |
| 13 | Apply log location | Next to the draft file: `MediaLibraryApplyLog.jsonl` in the photo folder. |
| 14 | Two-pass scanner | Run both passes up-front in one read cycle. No half-loaded state. |
| 15 | Two-pass worker scheduling | Same worker, sequential invocations. Pretty pass first (most likely to be displayed), numeric pass second. |
| 16 | CI exiftool | Assume installed and on PATH. No CI config additions in this refactor. |

## Open

| # | Question | Notes |
|---|---|---|
| 11 | exiftool `-n` behaviour for ambiguous numeric tags (e.g. `Rating` accepts `5` and `5.0`) | Exploratory testing required during Phase 5 implementation. Strongly prefer `-n` form for robustness; document exploratory findings as code comments. |
| 12 | List `Set` via `-TAG= -TAG=a -TAG=b` | Exploratory testing required during Phase 5. Record findings as code comments at the argv-builder call site. |
| 17 | `ts-rs` adoption | Pending user decision after explanation. |

## Decisions taken without explicit confirmation

- Per-entry parse in `parse_exiftool_batch_json` uses `serde_json::Value` as the intermediate, then `serde_json::from_value` per entry. Trade-off: extra allocation per entry, but isolates the failure cleanly. (Phase 0)
- Existing `test_images/` fixture set kept as-is. New fixtures will live in `src-tauri/tests/fixtures/images/`. (Phase 0)
- `QUESTIONS.md` lives at repo root so it's visible without diving into docs/.
- `Variant::Integer` is `i64`. Sufficient for every EXIF/XMP tag we care about. (Phase 1)
- `Variant` untagged-enum arm order is `Null, Bool, Integer, Float, String, List, Object`. Integer-before-Float verified by unit test `variant_integer_takes_precedence_over_float`. (Phase 1)
- `tag_schema` registry is built lazily on first `get_registry()` call via `OnceLock`. Failure caches the error; no retry within a process. (Phase 2)
- `tag_schema` augments listx with a hand-curated override table for XMP bag/seq tags (Subject, Creator, HierarchicalSubject, mwg-rs:Regions, …). listx does not emit bag/seq info for XMP namespaces. The override list lives in `apply_overrides` at the bottom of `tag_schema.rs`. (Phase 2)
- Draft JSONL backup uses fixed name `MediaLibraryDraftEdits.v1.bak.jsonl` next to the draft file. Backup is written once on the first v1→v2 migration; subsequent loads do not overwrite. (Phase 3)
- The legacy `DraftEditsPayload = HashMap<String, HashMap<String, Option<String>>>` is retained as the Tauri-boundary shape. Internally, `TypedDraftEdits = HashMap<…, DraftEdit>` carries the v2 model. Conversion happens in `load_draft_edits` / `save_draft_edits` so the existing frontend keeps working. (Phase 3)
- Phase 6 partial: only flag changes (`-struct`, `-charset utf8`). The two-pass display/raw split is deferred. (Phase 6)

## Deferred work — follow-up phases not completed in this pass

Each item below is a self-contained next-step that builds on the work already
landed.  They were scoped out of this pass because either (a) the change is
heavily frontend-side and risks invalidating many existing tests at once, or
(b) the change is gated on a follow-up that itself needs careful design.

### Phase 3b — Frontend draft layer carries Variant

- Replace `DraftEditsValue = string | null` in `src/types.ts` with
  `{ value: Variant | null; intent: 'Set' | 'Delete' | 'ListAdd' | 'ListRemove' }`.
- Update `setDraftValue` signature in `src/useMediaLibrary.ts:41,652` and every
  call site (`DetailsPane`, `ValueEditDialog`, `NewPropertyDialog`,
  `ContextMenu`).
- Change the Tauri commands `load_draft_edits` / `save_draft_edits` /
  `apply_draft_edits_cmd` to accept and return the typed shape.  The current
  legacy-string shim in `src-tauri/src/draft_edits.rs` becomes unused and can
  be deleted.
- Frontend tests in `src/test/draft-metadata-editing.test.tsx` and
  `src/test/apply-edits.test.tsx` will need updates — most rely on string
  draft values.
- Diff view: render structured before/after rather than string-compared
  representation.

### Phase 4 — Type-aware editors

Depends on Phase 3b.  See `METADATA_FORMATS_PLAN.md` §4.

- Convert `ValueEditDialog` to a router on `TagKind`.
- New editor components, one per kind: `BagEditor`, `SeqEditor`,
  `LangAltEditor`, `EnumEditor`, `RationalEditor`, `IntegerEditor`,
  `DateTimeEditor`, `BooleanEditor`, `GpsEditor`, `FlashEditor`, `StructEditor`.
- `src/metadata/tag_overrides.ts` for the hard-coded specialised mappings
  (GPS coords, Flash bitfield, name-matched datetime upgrades).
- Update `NewPropertyDialog` to autocomplete from the registry and switch
  the value control on tag pick.

### Phase 5 — Write-back fidelity

Depends on Phase 3b.  See `METADATA_FORMATS_PLAN.md` §5.

- Replace the single `-TAG=value` builder in `apply_edits.rs:73` with
  `build_args(tag, info, intent, value) -> Vec<String>`.
- Two-pass exec (numeric `-n` group first, then text group).
- Argv preview UI before apply.
- Type-aware verification: lists as multisets/ordered, floats by epsilon,
  lang-alt per-language, structs recursively.  Coerced / mismatch / missing
  outcomes surfaced to the user.
- `MediaLibraryApplyLog.jsonl` append-only audit log next to the draft file.

### Phase 6 — Two-pass scanner read

See `METADATA_FORMATS_PLAN.md` §6.

- Add a `Pass B` invocation with `-n` for raw values.
- Restructure `ImageMetadata` to carry both `display` (pretty) and `raw`
  (numeric) hashmaps.  Frontend `Variant` already supports both.
- Update `ImageMetadataReadyPayload` event shape.
- The basic infrastructure is in place (Phase 6 partial already adds
  `-struct` and `-charset utf8`), so this is a roughly mechanical follow-up
  blocked only on frontend `ImageMetadata` shape ripple.

### Phase 7 — Integration tier and fixtures

- `src-tauri/tests/integration/` skeleton with `#[cfg(feature = "integration")]`
  gating.  Add `integration` feature to `Cargo.toml`.
- Build out the fixture corpus enumerated in
  `src-tauri/tests/fixtures/images/README.md` (currently scaffolding only).
- `tools/build-fixture.sh` documenting how each fixture was produced.
- `tools/check-fixtures.sh` for CI verification that committed fixtures
  match the README's claims.
- Round-trip integration tests per `TagKind`.
- `vitest --project integration` config for the frontend tier.
- CI workflow (none currently in repo) installing exiftool and running
  the integration tier.

### Phase 7 — `ts-rs` generated types

- Replace the hand-written TS mirrors of `Variant`, `TagInfo`, `TagKind`,
  `DraftEdit`, `EditIntent` with `ts-rs`-generated `types.generated.ts`.
- `cargo build` generates; CI diffs against committed copy.
