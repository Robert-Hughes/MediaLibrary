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

### Original (pre-refactor) fixtures

| File | Source | What it tests |
|---|---|---|
| `dummy.jpg` | minimal placeholder | Not actually a JPEG (UTF-16 text). Pre-existing; used by some thumbnail tests as a missing-image placeholder. |
| `real_with_exif.jpg` | real photo (Canon EOS 40D) | Has a small (~100×68 px) embedded EXIF thumbnail. `scanner::extract_exif_thumbnail` should reject the embedded thumb as too small and fall through to full-decode. |
| `large_with_exif.jpg` | real photo | Has a large (200×150 px) embedded EXIF thumbnail. `scanner::extract_exif_thumbnail` should accept it directly. |

### Metadata-formats refactor fixtures

Built from `real_with_exif.jpg` via `tools/build-fixture.sh` (run by hand once, never at test setup).

| File | Tag contents | Tests |
|---|---|---|
| `keywords_basic.jpg` | `XMP-dc:Subject = ["beach","sunset"]`, `IPTC:Keywords = ["beach","sunset"]` | Bag<Text> read; will gain teeth for Bag write-back once Phase 3b carries `Variant::List` from the frontend. |
| `orientation_rotate90.jpg` | `IFD0:Orientation = 6` (Rotate 90 CW) | Enum<Integer> two-pass read (display = "Rotate 90 CW", raw = 6) and numeric-pass write-back. |
| `rating_5.jpg` | `XMP-xmp:Rating = 5` | Integer/Real read and write-back. |
| `rating_3.jpg` | `XMP-xmp:Rating = 3` | Used as the source of the rating round-trip test (set to 5). |
| `langalt_description.jpg` | `XMP-dc:Description` with `x-default = "default text"`, `en = "english text"`, `fr = "texte francais"` | LangAlt read across multiple languages. |
| `gps_decimal_rational.jpg` | `GPSLatitude = 51.50726667 N`, `GPSLongitude = -0.12775 W` | GPS coord read; will support GPS editor work in Phase 4. |
| `flash_bitfield.jpg` | `EXIF:Flash = 25` (Auto, fired) | Flash bitfield read. |
| `unicode_paths_漢字.jpg` | copy of `keywords_basic.jpg` | Filename carries non-ASCII characters. Exercises `-charset filename=utf8`; integration test asserts the scanner returns gracefully even on Windows where CreateProcess argument encoding can defeat the flag. |
| `malformed_truncated.jpg` | first 1 KB of `real_with_exif.jpg` (head -c 1024) | Truncated JPEG. Per-entry parse isolation must keep the rest of a batch intact when this file is mixed in. |

## Planned fixtures (still TODO)

Build via `tools/build-fixture.sh` extensions or by hand. Each ~2 KB.

- `face_regions_mwg.jpg` — JPEG with `XMP-mwg-rs:Regions` containing two face structs. Struct read + nested object preservation under `-struct`. Building this requires nested-struct argument syntax in exiftool.
- `nested_keys_quicktime.mov` — QuickTime MOV with `Keys` group. Variant `Object` carrying through without crashing. Requires a real MOV source.
- `unwritable_in_png.png` — PNG where attempting to write an XMP-mwg-rs tag is expected to be silently dropped by exiftool. Verifier's "missing post-write" outcome.

Format coverage matrix (each format gets at least one Keywords round-trip):

- `keywords_jpeg.jpg` (covered by `keywords_basic.jpg`)
- `keywords_tiff.tif`
- `keywords_png.png`
- `keywords_heic.heic`
- `keywords_mov.mov`
- `keywords_cr2.cr2` (Canon raw)
- `keywords_arw.arw` (Sony raw)
