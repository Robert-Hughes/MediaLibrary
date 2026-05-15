// Single home for the editor-routing overrides described in
// METADATA_FORMATS_DESIGN.md §5 ("Special-case overrides").
//
// `exiftool -listx` describes most tags well enough for the schema-driven
// router in TypedValueEditor, but a small set of tags need name-based or
// pattern-based redirects:
//
//   - GPS coordinates       — composite editor with paired Latitude/Ref…
//   - Flash bitfield        — checkbox-per-bit editor
//   - Date-named string tags — listx says `string`; the value matches the
//                               exiftool date pattern, so route to DateTimeEditor.
//
// Adding a new override means adding one entry here and (if a new editor)
// importing it in TypedValueEditor.tsx.  No editor file should grow its own
// "is-this-tag-special" matcher in isolation again.

export interface GpsTagGroup {
  latitudeKey: string;
  latitudeRefKey: string;
  longitudeKey: string;
  longitudeRefKey: string;
  /** Phase 8 fix-up — GPSAltitude (metres) paired with its 0=above-sea-level / 1=below ref. */
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

/**
 * Phase 8.5 — promote string-typed tags whose name and value both look like
 * a date/time to the DateTime editor.
 *
 * `exiftool -listx` returns `type='string'` for several date-bearing tags
 * because XMP doesn't constrain them at the schema level.  When the tag
 * name matches a date keyword AND the current value matches the exiftool
 * canonical date form, the user gets a real date picker instead of a free-
 * form text input.  The check is deliberately conservative: a string value
 * that doesn't match the pattern leaves the editor as plain text so we
 * never block a user typing a partial value.
 *
 * Date keywords: `Date`, `Time`, `When`, `Created`, `Modified`.  Pattern
 * mirrors exiftool's `YYYY:MM:DD HH:MM:SS[.s][±HH:MM]` (date-only and
 * time-only forms also accepted).
 */
const DATE_NAME_RX = /(Date|Time|When|Created|Modified)/i;
const DATE_VALUE_RX =
  /^\d{4}:\d{2}:\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export function isDateTimeNamePattern(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  // Match the part after the group prefix so `XMP-xmp:CreateDate` lights up
  // on `CreateDate`.  Falls back to the full key if no `:` present.
  const namePart = key.includes(":") ? key.split(":").slice(-1)[0] : key;
  if (!DATE_NAME_RX.test(namePart)) return false;
  return DATE_VALUE_RX.test(value.trim());
}
