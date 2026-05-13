# Open questions from the metadata-formats refactor

Log of decisions deferred during implementation. Review and answer before continuing the phases that depend on each.

## General

1. **`test_images/` already exists at repo root** with `dummy.jpg`, `large_with_exif.jpg`, `real_with_exif.jpg`, plus a stray `MediaLibraryDraftEdits.jsonl`. The plan called for fixtures under `src-tauri/tests/fixtures/images/`. Should new fixtures live alongside the existing ones in `test_images/`, or in the new `src-tauri/tests/fixtures/images/`? Either way, the existing `scanner.rs` tests reference `test_images/...` and must keep working. Current bias: keep the existing `test_images/` for thumbnail tests; add new metadata fixtures under `src-tauri/tests/fixtures/images/`.

2. **`MediaLibraryDraftEdits.jsonl` in `test_images/`** — this file is checked in but appears to be a stray. Safe to delete? It's preventing a clean fixture corpus story.

## Phase 1 (Variant)

3. **`Variant::Null` vs `Option<Variant>`** — the plan adds a `Null` arm. ExifTool's `-j` output never produces JSON `null`, but our internal flows may want to. Worth keeping the `Null` arm explicitly? Current bias: yes, for symmetry with frontend `null`.

4. **`Variant::Integer(i64)` precision** — some EXIF fields use `u32` (offsets) or larger. `i64` covers everything practical but lossy serialization across the Tauri boundary may apply. Confirm `i64` is acceptable.

## Phase 2 (schema registry)

5. **`exiftool -listx` runtime cost.** Reported anecdotally as 200–500 ms with peaks to a few seconds. Doing this synchronously at startup blocks the splash screen. Should the registry build async with a "schema loading" placeholder, blocking only the new-property dialog and the verify path? Current bias: build lazily, first time any path needs it, with a single in-flight guard.

6. **Schema rebuild on exiftool version change.** Within a single app session, exiftool can't change versions, so no rebuild logic is needed. Confirm.

## Phase 3 (draft migration)

7. **Migration timing.** Run on first load of the draft file, eagerly? Or only when a draft edit is about to be saved? Eager is simpler. Bias: eager, with backup file and toast.

8. **What about drafts saved while the user has both schema versions in their workflow?** If they edit on machine A (v2), pull the JSONL onto machine B running an older build (v1 reader)... v1 reader will fail. Probably not a real scenario for a local desktop app, but flag it.

## Phase 4 (editors)

9. **Editor for `Struct` (face regions etc.)** — the plan says "expandable form per field". Real face-region structs are arrays of structs (one per face). Editor needs to handle list-of-struct, not just struct. Spec the UX more precisely before implementing.

10. **`GPSAltitudeRef` is paired with `GPSAltitude` (above/below sea level). Same for Latitude/Longitude Ref tags.** The plan says the GPS editor handles this. Implementation question: does the editor write both tags as one apply, or does the draft store them as separate entries? Bias: separate entries in draft; editor writes both on save.

## Phase 5 (write-back)

11. **`-n` scoping by two-pass exec** — the plan splits args into a numeric group and a text group. What about tags whose `-n` behaviour is ambiguous (e.g. `Rating` is integer but exiftool accepts both `5` and `5.0`)? Probably fine to put them in the `-n` group always. Confirm by exiftool's docs during implementation.

12. **List `Set` semantics: `-TAG=` then `-TAG=item`** — exiftool actually documents `-TAG=` as a delete. Sending `-TAG= -TAG=a -TAG=b` should yield `[a, b]` but verify with a real fixture.

13. **Apply log location** — `MediaLibraryApplyLog.jsonl` next to the draft file? Or in app-data dir? Per-folder is more discoverable but spreads logs across many places. Bias: next to the draft file.

## Phase 6 (scanner two-pass)

14. **Two-pass cost** — doubles scan time. Defer to lazy pass-A (per-file on details-pane open) if perf complaints arise? Bias: ship two-pass first, measure, then revisit.

15. **Worker scheduling** — the scanner runs in a work queue (`work_queue.rs`). Two exiftool invocations per batch: same worker, sequential, or parallel? Bias: sequential same worker — we don't gain wall time by running both at once because exiftool startup dominates and CPU isn't the bottleneck.

## Phase 7 (tests)

16. **CI exiftool installation** — the integration tier needs exiftool on PATH in CI. Windows runner with `choco install exiftool` is straightforward; macOS/Linux is even easier. No existing CI config in repo — does one exist that I haven't found? If not, adding it is out of scope here but should be flagged.

17. **`ts-rs` adoption** — the plan calls for generated TS types. The repo doesn't currently use any type-generation crate. Adding it is straightforward but touches every shared type. Defer until Phase 3 actually needs the migration.

## Decisions taken without explicit confirmation

- Per-entry parse in `parse_exiftool_batch_json` uses `serde_json::Value` as the intermediate, then `serde_json::from_value` per entry. Trade-off: extra allocation per entry, but isolates the failure cleanly. (Phase 0)
- Existing `test_images/` fixture set kept as-is. New fixtures will live in `src-tauri/tests/fixtures/images/`. (Phase 0)
- `QUESTIONS.md` lives at repo root so it's visible without diving into docs/.
