// Single home for the editor-routing overrides described in
// METADATA_FORMATS_DESIGN.md §5 ("Special-case overrides").
//
// `exiftool -listx` describes most tags well enough for the schema-driven
// router in TypedValueEditor, but a small set of editor behaviors need
// frontend routing because they combine multiple tags or reinterpret a packed
// value:
//
//   - GPS coordinates       — composite editor with paired Latitude/Ref…
//   - Flash bitfield        — checkbox-per-bit editor
//
// Adding a new override means adding one entry here and (if a new editor)
// importing it in TypedValueEditor.tsx.  No editor file should grow its own
// "is-this-tag-special" matcher in isolation again.

export interface GpsTagGroup {
  latitudeKey: string;
  latitudeRefKey: string;
  longitudeKey: string;
  longitudeRefKey: string;
  /** GPSAltitude (metres) paired with its 0=above-sea-level / 1=below ref. */
  altitudeKey: string;
  altitudeRefKey: string;
}

/**
 * Given a key like `GPS:GPSLatitude`, `XMP-exif:GPSLongitude`, or
 * `GPS:GPSAltitude`, return the paired-tag group covering the same
 * coordinate triple.  Returns `null` if the key isn't a GPS coord.  The
 * Ref-suffix variants (`GPSLatitudeRef`, `GPSAltitudeRef`, …) are
 * intentionally excluded so editing the Ref directly falls through to the
 * schema router rather than bouncing into the GPS composite editor.
 */
export function gpsTagGroup(key: string): GpsTagGroup | null {
  const m = key.match(/^([\w-]+):(GPS(?:Latitude|Longitude|Altitude))(?!Ref)$/);
  if (!m) return null;
  const [, group] = m;
  return {
    latitudeKey: `${group}:GPSLatitude`,
    latitudeRefKey: `${group}:GPSLatitudeRef`,
    longitudeKey: `${group}:GPSLongitude`,
    longitudeRefKey: `${group}:GPSLongitudeRef`,
    altitudeKey: `${group}:GPSAltitude`,
    altitudeRefKey: `${group}:GPSAltitudeRef`,
  };
}

/**
 * Recognise Flash tags by name across every group prefix exiftool exposes
 * them under (`EXIF:Flash`, `IFD0:Flash`, `MakerNotes:Flash`, …).
 */
export function isFlashTag(key: string): boolean {
  return /^[\w-]+:Flash$/.test(key);
}
