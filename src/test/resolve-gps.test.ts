/**
 * Unit tests for the GPS resolver used by the reverse-geocode flow.
 *
 * The resolver is the seam where "what should the geocoder see for
 * this photo?" is decided. The plan §2 requires drafts to win over
 * on-disk metadata so a user who has fixed a wrong GPS but not yet
 * applied it sees their correction sent to Nominatim. These tests
 * pin that contract.
 */
import { describe, it, expect } from "vitest";
import { resolveGps } from "../utils/resolveGps";
import type { MetadataDraftEdit, MetadataValue } from "../types";

function setEdit(value: MetadataValue): MetadataDraftEdit {
  return { value, intent: "Set" };
}
function real(value: number): MetadataValue {
  return { kind: "Real", value };
}
function deleteEdit(): MetadataDraftEdit {
  return { value: null, intent: "Delete" };
}

describe("resolveGps", () => {
  it("returns null/null when no metadata or drafts have GPS", () => {
    expect(resolveGps(undefined, {})).toEqual({ lat: null, lon: null });
    expect(resolveGps({}, {})).toEqual({ lat: null, lon: null });
  });

  it("reads decimal Composite GPS from metadata", () => {
    const meta = {
      "Composite:GPSLatitude": 51.5001,
      "Composite:GPSLongitude": -0.1262,
    };
    expect(resolveGps({}, meta)).toEqual({ lat: 51.5001, lon: -0.1262 });
  });

  it("parses DMS strings with refs", () => {
    // Standard EXIF DMS shape that ExifTool emits without -n.
    const meta = {
      "GPS:GPSLatitude": "51 deg 30' 0.55\" N",
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": "0 deg 7' 34.49\" W",
      "GPS:GPSLongitudeRef": "W",
    };
    const { lat, lon } = resolveGps({}, meta);
    expect(lat).toBeCloseTo(51.5001527, 5);
    expect(lon).toBeCloseTo(-0.1262472, 5);
  });

  it("draft Set value wins over metadata", () => {
    // A user corrected the lat in drafts but the metadata still has the
    // wrong value. The geocoder must see the corrected value.
    const drafts: Record<string, MetadataDraftEdit> = {
      "Composite:GPSLatitude": setEdit(real(48.8584)),
      "Composite:GPSLongitude": setEdit(real(2.2945)),
    };
    const meta = {
      "Composite:GPSLatitude": 51.5,
      "Composite:GPSLongitude": -0.12,
    };
    expect(resolveGps(drafts, meta)).toEqual({ lat: 48.8584, lon: 2.2945 });
  });

  it("draft Delete intent makes the field unavailable for geocoding", () => {
    // The user marked the GPS for removal. Even though metadata has a
    // value, the draft-aware view shows it as gone, so the geocoder
    // sees null/null (and the loop will emit no_gps).
    const drafts: Record<string, MetadataDraftEdit> = {
      "Composite:GPSLatitude": deleteEdit(),
      "Composite:GPSLongitude": deleteEdit(),
    };
    const meta = {
      "Composite:GPSLatitude": 51.5,
      "Composite:GPSLongitude": -0.12,
    };
    expect(resolveGps(drafts, meta)).toEqual({ lat: null, lon: null });
  });
});
