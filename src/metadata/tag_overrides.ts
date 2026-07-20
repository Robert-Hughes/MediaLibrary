// Single home for the editor-routing overrides described in
// METADATA_FORMATS_DESIGN.md §5 ("Special-case overrides").
//
// `exiftool -listx` describes most tags well enough for the schema-driven
// router in TypedValueEditor, but a small set of editor behaviors need
// frontend routing because they combine multiple tags or reinterpret a packed
// value:
//
//   - GPS coordinates       — grouped editor with paired Latitude/Ref…
//   - Flash bitfield        — checkbox-per-bit editor
//
// Adding a new override means adding one entry here and (if a new editor)
// importing it in TypedValueEditor.tsx.  No editor file should grow its own
// "is-this-tag-special" matcher in isolation again.

import type { SchemaDefinitionId } from "../types";
import { GPS_IDS, KNOWN_METADATA_IDS, isKnownId } from "./knownIds";

export interface GpsTagGroup {
  latitudeId: SchemaDefinitionId;
  latitudeRefId: SchemaDefinitionId;
  longitudeId: SchemaDefinitionId;
  longitudeRefId: SchemaDefinitionId;
  /** GPSAltitude (metres) paired with its 0=above-sea-level / 1=below ref. */
  altitudeId: SchemaDefinitionId;
  altitudeRefId: SchemaDefinitionId;
}

/**
 * Given a key like `GPS:GPSLatitude`, `XMP-exif:GPSLongitude`, or
 * `GPS:GPSAltitude` (including their Ref variants), return the paired-tag group
 * covering the same coordinate triple. Returns `null` if the key isn't a GPS coord.
 */
export function gpsMemberGroup(id: SchemaDefinitionId): GpsTagGroup | null {
  if (!Object.values(GPS_IDS).some((known) => isKnownId(id, known)))
    return null;
  return {
    latitudeId: GPS_IDS.latitude,
    latitudeRefId: GPS_IDS.latitudeRef,
    longitudeId: GPS_IDS.longitude,
    longitudeRefId: GPS_IDS.longitudeRef,
    altitudeId: GPS_IDS.altitude,
    altitudeRefId: GPS_IDS.altitudeRef,
  };
}

/**
 * Recognise Flash tags by name across every group prefix exiftool exposes
 * them under (`EXIF:Flash`, `IFD0:Flash`, `MakerNotes:Flash`, …).
 */
export function isFlashTag(id: SchemaDefinitionId): boolean {
  return isKnownId(id, KNOWN_METADATA_IDS.flash);
}
