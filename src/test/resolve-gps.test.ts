// @vitest-environment node
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
import { resolveGps as exactResolveGps } from "../utils/resolveGps";
import type { MetadataDraftEdit, MetadataValue } from "../types";
import { mockMetadata, mockSchemaDraftDisplayProjection } from "./factories";

type DraftInput = Parameters<typeof mockSchemaDraftDisplayProjection>[0];
type MetadataInput = Parameters<typeof exactResolveGps>[1];

const resolveGps = (drafts: DraftInput | undefined, metadata: MetadataInput) =>
  exactResolveGps(
    drafts ? mockSchemaDraftDisplayProjection(drafts) : undefined,
    metadata,
  );

function setEdit(value: MetadataValue): MetadataDraftEdit {
  return { value, intent: "Set" };
}
function real(value: number): MetadataValue {
  return { kind: "Real", value };
}
function text(value: string): MetadataValue {
  return { kind: "Text", value };
}
function singletonList(value: MetadataValue): MetadataValue {
  return { kind: "List", value: { list_kind: "Bag", items: [value] } };
}
function deleteEdit(): MetadataDraftEdit {
  return { value: null, intent: "Delete" };
}

describe("resolveGps", () => {
  it("returns null/null when no metadata or drafts have GPS", () => {
    expect(resolveGps(undefined, {})).toEqual({ lat: null, lon: null });
    expect(resolveGps({}, {})).toEqual({ lat: null, lon: null });
  });

  it("parses DMS strings with refs", () => {
    // Standard EXIF DMS shape that ExifTool emits without -n.
    const meta = mockMetadata({
      "GPS:GPSLatitude": "51 deg 30' 0.55\" N",
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": "0 deg 7' 34.49\" W",
      "GPS:GPSLongitudeRef": "W",
    });
    const { lat, lon } = resolveGps({}, meta);
    expect(lat).toBeCloseTo(51.5001527, 5);
    expect(lon).toBeCloseTo(-0.1262472, 5);
  });

  it("applies GPSLongitudeRef=W to raw GPS Real longitude", () => {
    const meta = mockMetadata({
      "GPS:GPSLatitude": { kind: "Real", value: 53.983856 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
      "GPS:GPSLongitude": { kind: "Real", value: 1.100918 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "W" },
    });
    const { lat, lon } = resolveGps({}, meta);
    expect(lat).toBeCloseTo(53.983856, 6);
    expect(lon).toBeCloseTo(-1.100918, 6);
  });

  it("applies singleton List GPSLongitudeRef=W to raw GPS Real longitude", () => {
    const meta = mockMetadata({
      "GPS:GPSLatitude": { kind: "Real", value: 53.983856 },
      "GPS:GPSLatitudeRef": singletonList(text("N")),
      "GPS:GPSLongitude": { kind: "Real", value: 1.100918 },
      "GPS:GPSLongitudeRef": singletonList(text("W")),
    });
    const { lat, lon } = resolveGps({}, meta);
    expect(lat).toBeCloseTo(53.983856, 6);
    expect(lon).toBeCloseTo(-1.100918, 6);
  });

  it("applies GPSLatitudeRef=S to raw GPS Real latitude", () => {
    const meta = mockMetadata({
      "GPS:GPSLatitude": { kind: "Real", value: 53.983856 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "S" },
      "GPS:GPSLongitude": { kind: "Real", value: 1.100918 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "E" },
    });
    const { lat, lon } = resolveGps({}, meta);
    expect(lat).toBeCloseTo(-53.983856, 6);
    expect(lon).toBeCloseTo(1.100918, 6);
  });

  it("applies singleton List GPSLatitudeRef=S to raw GPS Real latitude", () => {
    const meta = mockMetadata({
      "GPS:GPSLatitude": { kind: "Real", value: 53.983856 },
      "GPS:GPSLatitudeRef": singletonList(text("S")),
      "GPS:GPSLongitude": { kind: "Real", value: 1.100918 },
      "GPS:GPSLongitudeRef": singletonList(text("E")),
    });
    const { lat, lon } = resolveGps({}, meta);
    expect(lat).toBeCloseTo(-53.983856, 6);
    expect(lon).toBeCloseTo(1.100918, 6);
  });

  it("keeps raw GPS Real longitude positive when GPSLongitudeRef=E", () => {
    const meta = mockMetadata({
      "GPS:GPSLatitude": { kind: "Real", value: 53.983856 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
      "GPS:GPSLongitude": { kind: "Real", value: 1.100918 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "E" },
    });
    const { lon } = resolveGps({}, meta);
    expect(lon).toBeCloseTo(1.100918, 6);
  });

  it("applies ref drafts to draft raw GPS Real values", () => {
    const drafts: Record<string, MetadataDraftEdit> = {
      "GPS:GPSLatitude": setEdit(real(53.983856)),
      "GPS:GPSLatitudeRef": setEdit(text("N")),
      "GPS:GPSLongitude": setEdit(real(1.100918)),
      "GPS:GPSLongitudeRef": setEdit(text("W")),
    };
    const meta = mockMetadata({
      "GPS:GPSLatitude": 10,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 20,
      "GPS:GPSLongitudeRef": "E",
    });
    const { lat, lon } = resolveGps(drafts, meta);
    expect(lat).toBeCloseTo(53.983856, 6);
    expect(lon).toBeCloseTo(-1.100918, 6);
  });

  it("applies singleton List ref drafts to draft raw GPS Real values", () => {
    const drafts: Record<string, MetadataDraftEdit> = {
      "GPS:GPSLatitude": setEdit(real(53.983856)),
      "GPS:GPSLatitudeRef": setEdit(singletonList(text("N"))),
      "GPS:GPSLongitude": setEdit(real(1.100918)),
      "GPS:GPSLongitudeRef": setEdit(singletonList(text("W"))),
    };
    const { lat, lon } = resolveGps(drafts, {});
    expect(lat).toBeCloseTo(53.983856, 6);
    expect(lon).toBeCloseTo(-1.100918, 6);
  });

  it("draft Set value wins over metadata", () => {
    // A user corrected the lat in drafts but the metadata still has the
    // wrong value. The geocoder must see the corrected value.
    const drafts: Record<string, MetadataDraftEdit> = {
      "GPS:GPSLatitude": setEdit(real(48.8584)),
      "GPS:GPSLongitude": setEdit(real(2.2945)),
      "GPS:GPSLongitudeRef": setEdit(text("E")),
    };
    const meta = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
    });
    expect(resolveGps(drafts, meta)).toEqual({ lat: 48.8584, lon: 2.2945 });
  });

  it("draft Delete intent makes the field unavailable for geocoding", () => {
    // The user marked the GPS for removal. Even though metadata has a
    // value, the draft-aware view shows it as gone, so the geocoder
    // sees null/null (and the loop will emit no_gps).
    const drafts: Record<string, MetadataDraftEdit> = {
      "GPS:GPSLatitude": deleteEdit(),
      "GPS:GPSLongitude": deleteEdit(),
    };
    const meta = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
    });
    expect(resolveGps(drafts, meta)).toEqual({ lat: null, lon: null });
  });
});
