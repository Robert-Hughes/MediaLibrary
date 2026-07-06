import { describe, expect, it } from "vitest";
import {
  metadataValueToDisplayString,
  metadataValueToDisplayStringForTag,
  variantToDisplayString,
} from "../draft";
import type { TagInfo, TagKind } from "../types";

describe("variantToDisplayString (regression)", () => {
  it("joins arrays with comma-space", () => {
    expect(
      variantToDisplayString({
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [
            { kind: "Text", value: "a" },
            { kind: "Text", value: "b" },
          ],
        },
      }),
    ).toBe("a, b");
  });
  it("joins object entries", () => {
    expect(
      variantToDisplayString({
        kind: "Struct",
        value: {
          k: { kind: "Text", value: "v" },
          k2: { kind: "Text", value: "v2" },
        },
      }),
    ).toBe("k: v; k2: v2");
  });
});

describe("metadataValueToDisplayString", () => {
  it("preserves semantic scalar distinctions in display", () => {
    expect(metadataValueToDisplayString({ kind: "Integer", value: 5 })).toBe(
      "5",
    );
    expect(metadataValueToDisplayString({ kind: "Real", value: 5 })).toBe("5");
    expect(
      metadataValueToDisplayString({
        kind: "Rational",
        value: { numerator: 1, denominator: 250 },
      }),
    ).toBe("1/250");
  });

  it("renders temporal values without inventing offsets", () => {
    expect(
      metadataValueToDisplayString({
        kind: "Time",
        value: {
          hour: 10,
          minute: 56,
          second: 5,
          subsecond: null,
          offset: null,
        },
      }),
    ).toBe("10:56:05");
    expect(
      metadataValueToDisplayString({
        kind: "Time",
        value: {
          hour: 10,
          minute: 56,
          second: 5,
          subsecond: null,
          offset: { sign: "Plus", hours: 1, minutes: 0 },
        },
      }),
    ).toBe("10:56:05+01:00");
  });

  it("does not display binary or unknown as ordinary text edits", () => {
    expect(metadataValueToDisplayString({ kind: "Binary" })).toBe("<binary>");
    expect(
      metadataValueToDisplayString({
        kind: "Unknown",
        value: {
          expected: null,
          raw: { malformed: true },
          reason: "no schema",
        },
      }),
    ).toBe('{"malformed":true}');
  });

  describe("LangAlt formatting", () => {
    it("LangAlt x-default only displays just the value", () => {
      expect(
        metadataValueToDisplayString({
          kind: "LangAlt",
          value: { "x-default": "Caption" },
        }),
      ).toBe("Caption");
    });

    it("LangAlt single non-default language displays just the value", () => {
      expect(
        metadataValueToDisplayString({
          kind: "LangAlt",
          value: { en: "Caption" },
        }),
      ).toBe("Caption");
    });

    it("LangAlt multiple languages displays language prefixes", () => {
      expect(
        metadataValueToDisplayString({
          kind: "LangAlt",
          value: { en: "Caption", fr: "Légende" },
        }),
      ).toBe("en: Caption; fr: Légende");
    });

    it("LangAlt empty map displays empty string", () => {
      expect(
        metadataValueToDisplayString({
          kind: "LangAlt",
          value: {},
        }),
      ).toBe("");
    });
  });
});

describe("metadataValueToDisplayStringForTag", () => {
  function tagInfo(kind: TagKind): TagInfo {
    return {
      group: "IFD0",
      name: "Orientation",
      writable: true,
      kind,
      description: null,
    };
  }

  it("maps enum integer codes to schema labels", () => {
    expect(
      metadataValueToDisplayStringForTag(
        "IFD0:Orientation",
        { kind: "Integer", value: 6 },
        tagInfo({
          kind: "Enum",
          data: {
            repr: "Integer",
            options: [{ code: "6", label: "Rotate 90 CW" }],
          },
        }),
      ),
    ).toBe("Rotate 90 CW");
  });

  it("falls back to generic formatting when schema is missing", () => {
    expect(
      metadataValueToDisplayStringForTag("IFD0:Orientation", {
        kind: "Integer",
        value: 6,
      }),
    ).toBe("6");
  });

  it("falls back to generic formatting for unknown integer tags", () => {
    expect(
      metadataValueToDisplayStringForTag("MadeUp:Code", {
        kind: "Integer",
        value: 6,
      }),
    ).toBe("6");
  });

  it("falls back to generic formatting when enum option is missing", () => {
    expect(
      metadataValueToDisplayStringForTag(
        "IFD0:Orientation",
        { kind: "Integer", value: 6 },
        tagInfo({
          kind: "Enum",
          data: {
            repr: "Integer",
            options: [{ code: "1", label: "Horizontal (normal)" }],
          },
        }),
      ),
    ).toBe("6");
  });

  it("maps text enum codes to schema labels", () => {
    expect(
      metadataValueToDisplayStringForTag(
        "XMP:Mode",
        { kind: "Text", value: "auto" },
        tagInfo({
          kind: "Enum",
          data: {
            repr: "String",
            options: [{ code: "auto", label: "Automatic" }],
          },
        }),
      ),
    ).toBe("Automatic");
  });

  it("allows real integer enum codes", () => {
    expect(
      metadataValueToDisplayStringForTag(
        "IFD0:Orientation",
        { kind: "Real", value: 6 },
        tagInfo({
          kind: "Enum",
          data: {
            repr: "Integer",
            options: [{ code: "6", label: "Rotate 90 CW" }],
          },
        }),
      ),
    ).toBe("Rotate 90 CW");
  });

  it("falls back to generic formatting for non-enum schema", () => {
    expect(
      metadataValueToDisplayStringForTag(
        "IFD0:Orientation",
        { kind: "Integer", value: 6 },
        tagInfo({ kind: "Integer", data: { min: null, max: null } }),
      ),
    ).toBe("6");
  });

  it("formats exposure time rational values with seconds", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:ExposureTime", {
        kind: "Rational",
        value: { numerator: 1, denominator: 250 },
      }),
    ).toBe("1/250 s");
  });

  it("formats exposure time real reciprocals with seconds", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:ExposureTime", {
        kind: "Real",
        value: 0.004,
      }),
    ).toBe("1/250 s");
  });

  it("formats multi-second exposure time values", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:ExposureTime", {
        kind: "Real",
        value: 2,
      }),
    ).toBe("2 s");
  });

  it("formats f-number real values", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:FNumber", {
        kind: "Real",
        value: 2.8,
      }),
    ).toBe("f/2.8");
  });

  it("formats f-number rational values", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:FNumber", {
        kind: "Rational",
        value: { numerator: 28, denominator: 10 },
      }),
    ).toBe("f/2.8");
  });

  it("formats focal length integer values", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:FocalLength", {
        kind: "Integer",
        value: 35,
      }),
    ).toBe("35 mm");
  });

  it("formats focal length rational values", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:FocalLength", {
        kind: "Rational",
        value: { numerator: 355, denominator: 10 },
      }),
    ).toBe("35.5 mm");
  });

  it("formats GPSLatitude Real values as friendly degrees", () => {
    expect(
      metadataValueToDisplayStringForTag("GPS:GPSLatitude", {
        kind: "Real",
        value: 52.2037391662611,
      }),
    ).toBe("52.203739°");
  });

  it("formats GPSLongitude Real values as friendly degrees", () => {
    expect(
      metadataValueToDisplayStringForTag("XMP-exif:GPSLongitude", {
        kind: "Real",
        value: 0.123724997044444,
      }),
    ).toBe("0.123725°");
  });

  it("formats GPSAltitude Real values as metres", () => {
    expect(
      metadataValueToDisplayStringForTag("GPS:GPSAltitude", {
        kind: "Real",
        value: 123.4,
      }),
    ).toBe("123.4 m");
  });

  it("formats GPSLatitude Rational fallback as degrees, not a giant fraction", () => {
    const display = metadataValueToDisplayStringForTag("GPS:GPSLatitude", {
      kind: "Rational",
      value: {
        numerator: 522037391662611,
        denominator: 10000000000000,
      },
    });
    expect(display).toBe("52.203739°");
    expect(display).not.toContain("/");
  });

  it("formats GPSLatitude one-item List<Rational> fallback as degrees", () => {
    expect(
      metadataValueToDisplayStringForTag("GPS:GPSLatitude", {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [
            {
              kind: "Rational",
              value: {
                numerator: 522037391662611,
                denominator: 10000000000000,
              },
            },
          ],
        },
      }),
    ).toBe("52.203739°");
  });

  it("formats GPSLatitude three-item DMS List<Rational> fallback as degrees", () => {
    expect(
      metadataValueToDisplayStringForTag("GPS:GPSLatitude", {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [
            { kind: "Rational", value: { numerator: 52, denominator: 1 } },
            { kind: "Rational", value: { numerator: 12, denominator: 1 } },
            {
              kind: "Rational",
              value: { numerator: 1346, denominator: 100 },
            },
          ],
        },
      }),
    ).toBe("52.203739°");
  });

  it("keeps non-GPS Rational formatting unchanged", () => {
    expect(
      metadataValueToDisplayStringForTag("Maker:ThreeRationals", {
        kind: "Rational",
        value: {
          numerator: 522037391662611,
          denominator: 10000000000000,
        },
      }),
    ).toBe("522037391662611/10000000000000");
  });

  it("falls back to generic formatting for unsupported known-tag values", () => {
    expect(
      metadataValueToDisplayStringForTag("ExifIFD:ExposureTime", {
        kind: "Text",
        value: "fast",
      }),
    ).toBe("fast");
  });
});
