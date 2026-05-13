# Image fixtures

Pre-baked image files used by the integration test tier (see `AGENTS.md`).

Each fixture is a real image (typically 4×4 pixels) carrying a known set of metadata tags. Tests assert against the claims in this file; they do **not** run exiftool at test setup. If a fixture's tags don't match the README, `tools/check-fixtures.sh` will fail in CI.

Adding a new fixture: see `tools/build-fixture.sh` for documented recipes, then add an entry below.

## Corpus

_None yet — populated as the integration test tier is built out._

Planned fixtures (per `METADATA_FORMATS_PLAN.md` §7.0):

- `keywords_basic.jpg` — JPEG with `XMP-dc:Subject = ["beach","sunset"]` and `IPTC:Keywords = ["beach","sunset"]`. Tests Bag round-trip.
- `langalt_description.jpg` — JPEG with `XMP-dc:Description` in `x-default`, `en`, `fr`. Tests LangAlt editor + write-back.
- `gps_decimal_rational.jpg` — JPEG with GPS coordinates set as rationals. Tests GPS override editor and DMS/decimal toggle.
- `face_regions_mwg.jpg` — JPEG with `XMP-mwg-rs:Regions` containing two face structs. Tests struct read + nested object preservation under `-struct`.
- `orientation_rotate90.jpg` — JPEG with `Orientation = 6`. Tests enum editor and two-pass read.
- `flash_bitfield.jpg` — JPEG with `Flash = 25` (fired + auto). Tests bitfield override editor.
- `nested_keys_quicktime.mov` — QuickTime MOV with `Keys` group. Tests that a Variant `Object` carries through without crashing the batch.
- `unicode_paths_漢字.jpg` — JPEG with Unicode filename. Tests `-charset filename=utf8` flag.
- `malformed_truncated.jpg` — JPEG truncated mid-marker. Tests per-entry parse isolation; this file must not kill the batch when mixed with valid files.
- `rating_3.jpg`, `rating_5.jpg` — JPEGs with integer `Rating` tag. Tests integer editor + bounds clamping.
- `unwritable_in_png.png` — PNG where attempting to write an XMP-mwg-rs tag is expected to be silently dropped by exiftool. Tests verifier's "missing post-write" outcome.

Format coverage matrix (each format should have at least one Keywords round-trip fixture):

- `keywords_jpeg.jpg`
- `keywords_tiff.tif`
- `keywords_png.png`
- `keywords_heic.heic`
- `keywords_mov.mov`
- `keywords_cr2.cr2` (Canon raw)
- `keywords_arw.arw` (Sony raw)
