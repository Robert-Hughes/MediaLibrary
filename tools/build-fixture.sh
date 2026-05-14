#!/usr/bin/env bash
# Build test_images/ fixtures from a base JPEG.
#
# Reproducibility recipe. Committed but NOT run in CI / tests. To
# regenerate the fixture corpus by hand, run this script from the repo
# root with exiftool on PATH.
#
# Base: test_images/real_with_exif.jpg. The base is itself a small
# 100×68 JPEG. We copy it and apply per-fixture tag overrides.
# Strip-then-set is used so the result has exactly the tags the test
# expects, no accidental inheritance.
#
# Each fixture's expected tag contents are documented in test_images/README.md.
# After running this script the README is the source of truth — assert
# against it, not against re-running this.

set -euo pipefail

BASE="test_images/real_with_exif.jpg"
[[ -f "$BASE" ]] || { echo "Missing $BASE" >&2; exit 1; }

mkfx() {
    local name="$1"; shift
    local dst="test_images/$name"
    cp -f "$BASE" "$dst"
    # Strip everything writable so we start clean.  '-all=' keeps file
    # structure but clears metadata.  Then apply the requested tags.
    # `-n` lets us write raw numeric values for enum/int tags (e.g.
    # Orientation=6, Flash=25, Rating=5) without exiftool trying to
    # PrintConv-reverse them.
    exiftool -overwrite_original -all= "$dst" >/dev/null
    exiftool -overwrite_original -n "$@" "$dst" >/dev/null
    echo "  built $dst"
}

echo "Building fixtures..."

# Bag of strings (XMP-dc:Subject and IPTC:Keywords).
mkfx keywords_basic.jpg \
    -XMP-dc:Subject=beach -XMP-dc:Subject=sunset \
    -IPTC:Keywords=beach -IPTC:Keywords=sunset

# Integer enum.
mkfx orientation_rotate90.jpg \
    -IFD0:Orientation=6

# Numeric Rating.
mkfx rating_5.jpg \
    -XMP-xmp:Rating=5

mkfx rating_3.jpg \
    -XMP-xmp:Rating=3

# LangAlt description.
mkfx langalt_description.jpg \
    -XMP-dc:Description-x-default="default text" \
    -XMP-dc:Description-en="english text" \
    -XMP-dc:Description-fr="texte francais"

# GPS coordinates (decimal degrees applied; exiftool stores as rationals).
mkfx gps_decimal_rational.jpg \
    -GPS:GPSLatitude=51.50726667 -GPS:GPSLatitudeRef=N \
    -GPS:GPSLongitude=-0.12775000 -GPS:GPSLongitudeRef=W

# Flash bitfield: 25 = fired + auto-flash.
mkfx flash_bitfield.jpg \
    -EXIF:Flash=25

# Face regions (MWG XMP). exiftool's struct argument syntax: nested
# {field=value,...} blocks. The fixture has two face regions identifying
# Alice and Bob.
mkfx face_regions_mwg.jpg \
    "-XMP-mwg-rs:RegionInfo={AppliedToDimensions={W=1000,H=1000,Unit=pixel},RegionList=[{Name=Alice,Type=Face,Area={X=0.30,Y=0.40,W=0.10,H=0.15}},{Name=Bob,Type=Face,Area={X=0.60,Y=0.40,W=0.10,H=0.15}}]}"

# Unicode filename: the build script copies the keywords_basic content into a
# file whose name contains non-ASCII characters.  Tests that exercise
# `-charset filename=utf8` use this fixture.
cp -f "test_images/keywords_basic.jpg" "test_images/unicode_paths_漢字.jpg"
echo "  built test_images/unicode_paths_漢字.jpg"

# Malformed JPEG: truncate `real_with_exif.jpg` mid-marker.  The per-entry
# parse safety net (Phase 0) means scanning a folder containing this file
# must not kill metadata for the other files in the batch.
head -c 1024 "$BASE" > "test_images/malformed_truncated.jpg"
echo "  built test_images/malformed_truncated.jpg"

echo "Done."
