import { describe, expect, it } from "vitest";
import { metadataValueToDisplayString, variantToDisplayString } from "../draft";

describe("variantToDisplayString (regression)", () => {
  // Sanity coverage so the fallback path keeps formatting lists / objects
  // the way existing tests expect.
  it("joins arrays with comma-space", () => {
    expect(variantToDisplayString(["a", "b"])).toBe("a, b");
  });
  it("joins object entries", () => {
    expect(variantToDisplayString({ k: "v", k2: "v2" })).toBe("k: v; k2: v2");
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
});
