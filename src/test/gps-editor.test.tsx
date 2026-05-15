// GpsEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GpsEditor,
  gpsGroupFor,
  parseDecimalDegrees,
  parseHemisphere,
  decimalToDms,
} from "../components/editors/GpsEditor";

const exampleGroup = {
  latitudeKey: "GPS:GPSLatitude",
  latitudeRefKey: "GPS:GPSLatitudeRef",
  longitudeKey: "GPS:GPSLongitude",
  longitudeRefKey: "GPS:GPSLongitudeRef",
  altitudeKey: "GPS:GPSAltitude",
  altitudeRefKey: "GPS:GPSAltitudeRef",
};

beforeEach(() => cleanup());

describe("GpsEditor", () => {
  it("shows the paired-tag warning", () => {
    render(
      <GpsEditor
        group={exampleGroup}
        initialLatDecimal={51.5}
        initialLatRef="N"
        initialLonDecimal={0.13}
        initialLonRef="W"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const warning = screen.getByTestId("gps-editor-warning");
    expect(warning).toHaveTextContent("GPS:GPSLatitude");
    expect(warning).toHaveTextContent("GPS:GPSLatitudeRef");
    expect(warning).toHaveTextContent("GPS:GPSLongitude");
    expect(warning).toHaveTextContent("GPS:GPSLongitudeRef");
  });

  it("Save emits 4 paired DraftEdits", () => {
    const onSave = vi.fn();
    render(
      <GpsEditor
        group={exampleGroup}
        initialLatDecimal={51.5}
        initialLatRef="N"
        initialLonDecimal={0.13}
        initialLonRef="W"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("gps-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    const edits = onSave.mock.calls[0][0] as Array<{ key: string; edit: { value: unknown; intent: string } }>;
    expect(edits).toHaveLength(4);
    const byKey = Object.fromEntries(edits.map((e) => [e.key, e.edit]));
    expect(byKey["GPS:GPSLatitude"]).toMatchObject({ value: 51.5, intent: "Set" });
    expect(byKey["GPS:GPSLatitudeRef"]).toMatchObject({ value: "N", intent: "Set" });
    expect(byKey["GPS:GPSLongitude"]).toMatchObject({ value: 0.13, intent: "Set" });
    expect(byKey["GPS:GPSLongitudeRef"]).toMatchObject({ value: "W", intent: "Set" });
    // Pretty-form display for the pending-change cell.
    expect((byKey["GPS:GPSLatitude"] as { display?: string }).display).toBe(`51 deg 30' 0" N`);
    expect((byKey["GPS:GPSLatitudeRef"] as { display?: string }).display).toBe("N");
    expect((byKey["GPS:GPSLongitudeRef"] as { display?: string }).display).toBe("W");
  });

  it("Save emits 6 paired DraftEdits when altitude is filled", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <GpsEditor
        group={exampleGroup}
        initialLatDecimal={51.5}
        initialLatRef="N"
        initialLonDecimal={0.13}
        initialLonRef="W"
        initialAltitudeMetres={null}
        initialAltitudeRef="above"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const alt = screen.getByTestId("gps-editor-alt-input") as HTMLInputElement;
    await user.type(alt, "120.5");
    fireEvent.click(screen.getByTestId("gps-editor-save"));
    const edits = onSave.mock.calls[0][0] as Array<{ key: string; edit: { value: unknown; intent: string } }>;
    expect(edits).toHaveLength(6);
    const byKey = Object.fromEntries(edits.map((e) => [e.key, e.edit]));
    expect(byKey["GPS:GPSAltitude"]).toMatchObject({ value: 120.5, intent: "Set" });
    expect((byKey["GPS:GPSAltitude"] as { display?: string }).display).toBe("120.5 m Above Sea Level");
    // exiftool encodes AltitudeRef as 0 (above) or 1 (below).
    expect(byKey["GPS:GPSAltitudeRef"]).toMatchObject({ value: 0, intent: "Set" });
    expect((byKey["GPS:GPSAltitudeRef"] as { display?: string }).display).toBe("Above Sea Level");
  });

  it("Empty altitude leaves the altitude pair untouched", () => {
    const onSave = vi.fn();
    render(
      <GpsEditor
        group={exampleGroup}
        initialLatDecimal={51.5}
        initialLatRef="N"
        initialLonDecimal={0.13}
        initialLonRef="W"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("gps-editor-save"));
    const edits = onSave.mock.calls[0][0] as Array<{ key: string }>;
    expect(edits).toHaveLength(4);
    const keys = edits.map((e) => e.key);
    expect(keys).not.toContain("GPS:GPSAltitude");
    expect(keys).not.toContain("GPS:GPSAltitudeRef");
  });

  it("rejects out-of-range latitude", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <GpsEditor
        group={exampleGroup}
        initialLatDecimal={51}
        initialLatRef="N"
        initialLonDecimal={0}
        initialLonRef="E"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const lat = screen.getByTestId("gps-editor-lat-input") as HTMLInputElement;
    await user.clear(lat);
    await user.type(lat, "120");
    fireEvent.click(screen.getByTestId("gps-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("gps-editor-error")).toHaveTextContent("0–90");
  });
});

describe("gpsGroupFor", () => {
  it("matches GPS:GPSLatitude / GPSLongitude", () => {
    expect(gpsGroupFor("GPS:GPSLatitude")).toEqual(exampleGroup);
    expect(gpsGroupFor("GPS:GPSLongitude")).toEqual(exampleGroup);
  });

  it("matches XMP-exif prefix", () => {
    const g = gpsGroupFor("XMP-exif:GPSLatitude");
    expect(g?.latitudeKey).toBe("XMP-exif:GPSLatitude");
    expect(g?.longitudeRefKey).toBe("XMP-exif:GPSLongitudeRef");
  });

  it("does not match Ref tags", () => {
    expect(gpsGroupFor("GPS:GPSLatitudeRef")).toBeNull();
  });

  it("does not match non-GPS tags", () => {
    expect(gpsGroupFor("XMP-dc:Subject")).toBeNull();
    expect(gpsGroupFor("plain")).toBeNull();
  });
});

describe("decimalToDms", () => {
  it("formats a decimal latitude with hemisphere", () => {
    expect(decimalToDms(51.50726667, "N")).toBe(`51 deg 30' 26.16" N`);
  });
  it("renders whole degrees without trailing zeros", () => {
    expect(decimalToDms(51.5, "N")).toBe(`51 deg 30' 0" N`);
  });
  it("uses the supplied hemisphere regardless of sign", () => {
    expect(decimalToDms(0.13, "W")).toMatch(/W$/);
  });
});

describe("parseDecimalDegrees", () => {
  it("parses a plain number", () => {
    expect(parseDecimalDegrees(51.5)).toBeCloseTo(51.5);
    expect(parseDecimalDegrees("51.5")).toBeCloseTo(51.5);
  });

  it("converts DMS string to decimal", () => {
    const r = parseDecimalDegrees(`51 deg 30' 26.16" N`);
    expect(r).toBeCloseTo(51.50726667, 6);
  });

  it("absolute-values negative inputs (hemisphere handled separately)", () => {
    expect(parseDecimalDegrees(-51.5)).toBeCloseTo(51.5);
  });

  it("returns null for nonsense", () => {
    expect(parseDecimalDegrees("rubbish")).toBeNull();
    expect(parseDecimalDegrees(null)).toBeNull();
    expect(parseDecimalDegrees(undefined)).toBeNull();
  });
});

describe("parseHemisphere", () => {
  it("returns trailing letter from DMS string", () => {
    expect(parseHemisphere(`51 deg 30' 26.16" N`, "lat")).toBe("N");
    expect(parseHemisphere(`51 deg 30' 26.16" S`, "lat")).toBe("S");
    expect(parseHemisphere(`0 deg 7' 39.9" W`, "lon")).toBe("W");
  });

  it("infers from sign of decimal number", () => {
    expect(parseHemisphere(-51.5, "lat")).toBe("S");
    expect(parseHemisphere(51.5, "lat")).toBe("N");
    expect(parseHemisphere(-1.0, "lon")).toBe("W");
    expect(parseHemisphere(1.0, "lon")).toBe("E");
  });

  it("accepts a bare 'N'/'S'/'E'/'W' string", () => {
    expect(parseHemisphere("N", "lat")).toBe("N");
    expect(parseHemisphere("w", "lon")).toBe("W");
  });

  it("falls back to N/E", () => {
    expect(parseHemisphere(undefined, "lat")).toBe("N");
    expect(parseHemisphere(null, "lon")).toBe("E");
  });
});
