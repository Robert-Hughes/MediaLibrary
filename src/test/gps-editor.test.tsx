// GpsEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GpsEditor } from "../components/editors/GpsEditor";
import {
  parseDecimalDegrees,
  parseHemisphere,
  decimalToDms,
} from "../components/editors/editorHelpers";
import { gpsMemberGroup } from "../metadata/tag_overrides";

const exampleGroup = {
  latitudeKey: "GPS:GPSLatitude",
  latitudeRefKey: "GPS:GPSLatitudeRef",
  longitudeKey: "GPS:GPSLongitude",
  longitudeRefKey: "GPS:GPSLongitudeRef",
  altitudeKey: "GPS:GPSAltitude",
  altitudeRefKey: "GPS:GPSAltitudeRef",
};

const gpsRefKinds: NonNullable<
  React.ComponentProps<typeof GpsEditor>["refKinds"]
> = {
  latitude: {
    kind: "Enum",
    data: {
      repr: "String",
      options: [
        { code: "N", label: "North" },
        { code: "S", label: "South" },
      ],
    },
  },
  longitude: {
    kind: "Enum",
    data: {
      repr: "String",
      options: [
        { code: "E", label: "East" },
        { code: "W", label: "West" },
      ],
    },
  },
  altitude: {
    kind: "Enum",
    data: {
      repr: "Integer",
      options: [
        { code: "0", label: "Above Sea Level" },
        { code: "1", label: "Below Sea Level" },
      ],
    },
  },
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

  it("Save emits 4 paired semantic draft edits", () => {
    const onSave = vi.fn();
    render(
      <GpsEditor
        group={exampleGroup}
        initialLatDecimal={51.5}
        initialLatRef="N"
        initialLonDecimal={0.13}
        initialLonRef="W"
        refKinds={gpsRefKinds}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("gps-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    const edits = onSave.mock.calls[0][0] as Array<{
      key: string;
      edit: { value: unknown; intent: string };
    }>;
    expect(edits).toHaveLength(4);
    const byKey = Object.fromEntries(edits.map((e) => [e.key, e.edit]));
    expect(byKey["GPS:GPSLatitude"]).toMatchObject({
      value: { kind: "Real", value: 51.5 },
      intent: "Set",
    });
    expect(byKey["GPS:GPSLatitudeRef"]).toMatchObject({
      value: { kind: "Text", value: "N" },
      intent: "Set",
    });
    expect(byKey["GPS:GPSLongitude"]).toMatchObject({
      value: { kind: "Real", value: 0.13 },
      intent: "Set",
    });
    expect(byKey["GPS:GPSLongitudeRef"]).toMatchObject({
      value: { kind: "Text", value: "W" },
      intent: "Set",
    });
    // Pretty-form display for the pending-change cell.
    expect((byKey["GPS:GPSLatitude"] as { display?: string }).display).toBe(
      `51 deg 30' 0" N`,
    );
    expect((byKey["GPS:GPSLatitudeRef"] as { display?: string }).display).toBe(
      "North",
    );
    expect((byKey["GPS:GPSLongitudeRef"] as { display?: string }).display).toBe(
      "West",
    );
  });

  it("Save emits 6 paired semantic draft edits when altitude is filled", async () => {
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
        refKinds={gpsRefKinds}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const alt = screen.getByTestId("gps-editor-alt-input") as HTMLInputElement;
    await user.type(alt, "120.5");
    fireEvent.click(screen.getByTestId("gps-editor-save"));
    const edits = onSave.mock.calls[0][0] as Array<{
      key: string;
      edit: { value: unknown; intent: string };
    }>;
    expect(edits).toHaveLength(6);
    const byKey = Object.fromEntries(edits.map((e) => [e.key, e.edit]));
    expect(byKey["GPS:GPSAltitude"]).toMatchObject({
      value: { kind: "Real", value: 120.5 },
      intent: "Set",
    });
    expect((byKey["GPS:GPSAltitude"] as { display?: string }).display).toBe(
      "120.5 m Above Sea Level",
    );
    // exiftool encodes AltitudeRef as 0 (above) or 1 (below).
    expect(byKey["GPS:GPSAltitudeRef"]).toMatchObject({
      value: { kind: "Integer", value: 0 },
      intent: "Set",
    });
    expect((byKey["GPS:GPSAltitudeRef"] as { display?: string }).display).toBe(
      "Above Sea Level",
    );
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

describe("gpsMemberGroup", () => {
  it("matches all six GPS fields under GPS: prefix", () => {
    const fields = [
      "GPS:GPSLatitude",
      "GPS:GPSLatitudeRef",
      "GPS:GPSLongitude",
      "GPS:GPSLongitudeRef",
      "GPS:GPSAltitude",
      "GPS:GPSAltitudeRef",
    ];
    for (const field of fields) {
      expect(gpsMemberGroup(field)).toEqual(exampleGroup);
    }
  });

  it("matches XMP-exif prefix", () => {
    const g = gpsMemberGroup("XMP-exif:GPSLatitudeRef");
    expect(g).toBeDefined();
    expect(g?.latitudeKey).toBe("XMP-exif:GPSLatitude");
    expect(g?.latitudeRefKey).toBe("XMP-exif:GPSLatitudeRef");
    expect(g?.longitudeKey).toBe("XMP-exif:GPSLongitude");
    expect(g?.longitudeRefKey).toBe("XMP-exif:GPSLongitudeRef");
    expect(g?.altitudeKey).toBe("XMP-exif:GPSAltitude");
    expect(g?.altitudeRefKey).toBe("XMP-exif:GPSAltitudeRef");
  });

  it("does not match unrelated tags", () => {
    expect(gpsMemberGroup("GPS:GPSVersionID")).toBeNull();
    expect(gpsMemberGroup("GPS:GPSMapDatum")).toBeNull();
    expect(gpsMemberGroup("XMP-dc:Subject")).toBeNull();
    expect(gpsMemberGroup("plain")).toBeNull();
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
  it.each([
    ["South", "lat", "S"],
    ["north", "lat", "N"],
    ["West", "lon", "W"],
    ["east", "lon", "E"],
  ] as const)("parses full-word hemisphere %s", (value, axis, expected) => {
    expect(parseHemisphere(value, axis)).toBe(expected);
  });
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
