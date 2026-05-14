# Test image fixtures

Pre-baked image files used by both the unit test tier (existing thumbnail
tests in `scanner.rs`) and the integration tier (`cargo test --features
integration`). See `AGENTS.md` for the test tier policy.

Tests assert against the claims in this README. They do **not** run exiftool
at test setup. `tools/check-fixtures.sh` verifies that committed fixtures
still contain the tags listed here.

To add a new fixture: see `tools/build-fixture.sh` for documented recipes
(applied by hand, not at test time), then add an entry below.

## Existing fixtures

| File | Source | What it tests |
|---|---|---|
| `dummy.jpg` | minimal | Smallest legal JPEG. Used as a baseline. |
| `real_with_exif.jpg` | real photo | Has a small (~100×68 px) embedded EXIF thumbnail. `scanner::extract_exif_thumbnail` should reject the embedded thumb as too small and fall through to full-decode. |
| `large_with_exif.jpg` | real photo | Has a large (200×150 px) embedded EXIF thumbnail. `scanner::extract_exif_thumbnail` should accept it directly. |

## Planned fixtures (per METADATA_FORMATS_PLAN.md §7.0)

Populated as the integration test tier is built out. Each ~2 KB; image
content stripped to 4×4 px so the repo stays small.

- `keywords_basic.jpg` — JPEG with `XMP-dc:Subject = ["beach","sunset"]` and `IPTC:Keywords = ["beach","sunset"]`. Bag round-trip.
- `langalt_description.jpg` — JPEG with `XMP-dc:Description` in `x-default`, `en`, `fr`. LangAlt editor + write-back.
- `gps_decimal_rational.jpg` — JPEG with GPS coordinates as rationals. GPS override editor and DMS/decimal toggle.
- `face_regions_mwg.jpg` — JPEG with `XMP-mwg-rs:Regions` containing two face structs. Struct read + nested object preservation under `-struct`.
- `orientation_rotate90.jpg` — JPEG with `Orientation = 6`. Enum editor + two-pass read.
- `flash_bitfield.jpg` — JPEG with `Flash = 25` (fired + auto). Bitfield override editor.
- `nested_keys_quicktime.mov` — QuickTime MOV with `Keys` group. Variant `Object` carrying through without crashing.
- `unicode_paths_漢字.jpg` — JPEG with Unicode filename. `-charset filename=utf8`.
- `malformed_truncated.jpg` — JPEG truncated mid-marker. Per-entry parse isolation: must not kill the batch when mixed with valid files.
- `rating_3.jpg`, `rating_5.jpg` — JPEGs with integer `Rating` tag. Integer editor + bounds clamping.
- `unwritable_in_png.png` — PNG where attempting to write an XMP-mwg-rs tag is expected to be silently dropped by exiftool. Verifier's "missing post-write" outcome.

Format coverage matrix (each format gets at least one Keywords round-trip):

- `keywords_jpeg.jpg`
- `keywords_tiff.tif`
- `keywords_png.png`
- `keywords_heic.heic`
- `keywords_mov.mov`
- `keywords_cr2.cr2` (Canon raw)
- `keywords_arw.arw` (Sony raw)
