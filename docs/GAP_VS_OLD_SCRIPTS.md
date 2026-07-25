# Gap Analysis: Legacy "Update Metadata Scripts" vs MediaLibrary App

Comparison of the prior Gemini-CLI / PowerShell / Python batch pipeline (in `Update Metadata Scripts/`) against the current Tauri MediaLibrary app. Identifies capabilities the legacy approach exercised that the new app does not yet cover.

## A. Architecture comparison

Legacy = 3-phase batch pipeline: `geocode → AI review (Gemini flash) → apply via exiftool → verify`. Per-batch JSON artifacts (`metadata.json`, `tags.json`, `geocache.json`, `metadata_after.json`) + HTML reports.

App = interactive drafts → apply with JSONL audit log. No explicit batch boundary, no review HTML, no verification report.

## B. Image+text combination question

Legacy: **single Gemini call per batch, image+text together** (`Update Metadata (One Batch).txt` lines 195-245). Required visual inspection of full-size originals (not thumbs). Geocode runs _first_ as separate Python call so location strings already in agent context when it views images. Multi-batch chaining used cumulative "summary for next run" appended to next prompt for theme continuity.

Lesson burned in: **Flash Lite hallucinated** ("theme-smearing" — generic landscape guesses for portraits/animals, batches 030-039). `Update Metadata (Outer).txt` lines 91-94 mandates flash, not lite.

App: `openai_describe.rs` design only; not shipped. No batch-chain context. No "view full image required" enforcement. No model-quality guardrail documented.

## C. Specific feature gaps

| Feature                              | Legacy did                                                                                                                                                                                                               | App state                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GPS clustering detection**         | Manually spotted ("all London files at one coord" — TODO.md known issue, partly attempted via per-image visual rewrite)                                                                                                  | **MISSING**. Haversine util exists in `src-tauri/src/geocode_cache.rs:70-84` but only for cache match. No outlier/cluster scan.                                                                                   |
| **Wrong-date detection**             | `generate_verification_report.py` lines 88-95: checks CreateDate/ModifyDate/XMP dates match DateTimeOriginal; flags mismatch with badges; "Dup Dates" column on review report (`generate_batch_report.py` lines 159-174) | **MISSING**. `DateTimeEditor` edits each field independently. No cross-field check. No filename-vs-date sanity (phone vs camera filename formats — TODO.md unresolved).                                           |
| **Date sync on apply**               | exiftool `-AllDates<DateTimeOriginal` syncs all date variants (`apply_metadata_direct.ps1:35-39`)                                                                                                                        | **MISSING**. No "sync all dates from DTO" command.                                                                                                                                                                |
| **Legacy field normalization**       | Mirrored writes: XMP-photoshop:City + IPTC:City, XMP-dc:Subject + IPTC:Keywords (`apply_metadata_v2.ps1:58-79`)                                                                                                          | **PARTIAL**. Reverse-geocode writes mirrors atomically (coherent rule). No general legacy→modern migration. UserComment / Description / Caption-Abstract / ImageDescription read separately, user picks manually. |
| **Tag/keyword merge across bags**    | tags = set union of existing + AI proposal; never replace (`Update Metadata (One Batch).txt:209-245`)                                                                                                                    | **MISSING**. IPTC:Keywords / XMP-dc:Subject / XMP-lr:HierarchicalSubject all coexist in `tag_schema.rs:407-409`. `BagEditor` edits each separately. No dedup, no cross-bag merge, no warning of redundancy.       |
| **Geocode cache**                    | per-batch + global cache, 50m haversine match, Nominatim 1s ratelimit                                                                                                                                                    | **PRESENT**. `geocode_cache.rs` stores the normalized LocationCreated candidate; GeocodeJSON provides the selected feature identity without nearby-POI guessing.                                                  |
| **Geocoding city/state bug**         | TODO.md: some 2010 files got "England" stored as City instead of State                                                                                                                                                   | **UNKNOWN**. Worth checking new mapping in `geocode.rs` against legacy bug.                                                                                                                                       |
| **Hierarchical place build**         | building→tourism→amenity→leisure→historic→shop→village→hamlet→suburb→city→town→county→state→country (`geocode_batch.py:40-61`)                                                                                           | Check if app's Nominatim formatter follows same hierarchy.                                                                                                                                                        |
| **GPS rewrite proposal vs preserve** | tags.json `gps` field only present when AI explicitly proposed correction; absent = preserve embedded (`Update Metadata (One Batch).txt:225-236`)                                                                        | App has GPS editor but no "AI suggests correction" path tied to visual content.                                                                                                                                   |
| **Batch review HTML**                | `generate_batch_report.py` — date-sorted, Keep/Add/Change/Remove badges, thumb→original link, "Was:" history, GPS distance check, Dup Dates column                                                                       | **MISSING**. No HTML export. No before/apply preview screen.                                                                                                                                                      |
| **Verification HTML**                | `generate_verification_report.py` — re-reads metadata after apply, compares to proposal, PASS/FAIL per file                                                                                                              | **PARTIAL**. Target-aware verification exposes exact-occurrence Match/Coerced/Mismatch evidence for attention in the app and audit log, but there is no aggregated HTML verification view.                        |
| **Correction batches**               | `batch-CORRECTION-Hawnby`, `-FINAL`, `-ADDITIONAL` — re-process flagged subsets                                                                                                                                          | **MISSING**. Failed target drafts remain available for retry, but there is no dedicated "retry failed subset" UI.                                                                                                 |
| **Multi-batch chaining context**     | "Batch summary for next run" → prepended to next prompt for theme continuity (`Update Metadata (Outer).txt:157-166`)                                                                                                     | **MISSING**. AI describe has no inter-batch memory.                                                                                                                                                               |
| **Audit trail**                      | Per-batch logs `_review_HHMMSS.log`, `_apply_HHMMSS.log`                                                                                                                                                                 | **PRESENT** (`MediaLibraryTargetApplyLog.jsonl` records exact targets, before/after evidence, outcomes, and draft reconciliation). The historical apply log is ignored.                                           |
| **Schema enforcement on AI output**  | Mandatory `tags[]`, `desc`, `location`, `gps`, `notes` together — to avoid ordering bugs in apply                                                                                                                        | **N/A yet** (AI describe unshipped). Design step.                                                                                                                                                                 |
| **UTF-8 / encoding traps**           | PS 5.1 UTF-16 redirect bug forced `_metadata_utf8.json` rewrites                                                                                                                                                         | Rust = UTF-8 native. Non-issue.                                                                                                                                                                                   |
| **Numeric tag coercion**             | "2010" must stay string in tags array                                                                                                                                                                                    | Watch in AI describe schema.                                                                                                                                                                                      |

## D. Image+text token strategy — recommendation per legacy evidence

Legacy did **one combined call** with geocode pre-fed as text, image attached. Token cost accepted because:

1. Image pass alone gives weak captions (model can't read EXIF date/camera from pixels reliably);
2. Text pass alone hallucinates content (flash-lite "theme-smearing");
3. Geocode-first means model sees "Cambridge, UK" before image → grounds visual interpretation.

Two-pass (image first, then merge with text) = more tokens (image re-encoded twice OR loss of co-attention). Legacy author chose one-pass after burning through batches 030-039 mistakes.

## E. Things legacy itself never solved (TODO.md)

1. Bulk-GPS group rewrite from visual content alone — never reliable
2. Confirm full 2010 coverage — possible misses
3. Date taken validation across filename formats (phone vs camera)
4. Geocoding City/State swap bug
5. Facial/person recognition — never built
6. No automated detection of theme-smear (`tags_clean.json` / `tags_final.json` were manual repairs)

App inherits these as still-open.

## F. Concrete missing capabilities to replicate

1. **GPS cluster scan**: scan library, find lat/lon points with N>threshold files within R meters, flag as "suspected manual bulk tag", offer per-image visual re-geocode.
2. **Cross-date validator**: detect DTO vs CreateDate vs ModifyDate vs FileModifyDate vs IPTC:DateCreated mismatches; surface as warning column; bulk "sync all dates to DTO" action.
3. **Filename-date sanity**: parse common filename formats (IMG_YYYYMMDD, PXL_*, phone vs camera), warn when filename year ≠ DTO year.
4. **Keyword merge**: dedup IPTC:Keywords ∪ XMP-dc:Subject ∪ XMP-lr:HierarchicalSubject; "normalize keywords" command; show diff before apply.
5. **Legacy description merge**: detect UserComment/Description/Caption-Abstract/ImageDescription divergence; merge or pick canonical; mirror on write.
6. **Batch concept in UI**: explicit batch selection + scope, "review report" HTML or in-app pane before apply, verification pane after apply reading JSONL log into aggregated PASS/FAIL.
7. **Failed subset rerun** for apply/describe/geocode.
8. **AI describe**: ship the designed feature with image+text single-pass, model gating (no lite), geocode-first context priming, required schema validation, multi-batch summary chaining.
9. **Audit-log reader UI**: JSONL log already richer than legacy; needs viewer.
10. **Hierarchical place formatter** parity check vs legacy 14-level hierarchy.

## G. Key files for cross-check

Legacy:

- `Update Metadata Scripts/Update Metadata (One Batch).txt`
- `Update Metadata Scripts/Update Metadata (Outer).txt`
- `Update Metadata Scripts/TODO.md`
- `Update Metadata Scripts/geocode_batch.py`
- `Update Metadata Scripts/generate_batch_report.py`
- `Update Metadata Scripts/generate_verification_report.py`
- `Update Metadata Scripts/apply_metadata_v2.ps1`

App:

- `src-tauri/src/geocode_cache.rs`
- `src-tauri/src/apply_edits.rs`
- `src-tauri/src/tag_schema.rs`
- `docs/IMAGE_ANALYSIS.md`
- `TODO.md`
