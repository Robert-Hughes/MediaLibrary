import { describe, expect, it } from "vitest";
import {
  deriveLegacyFileEdits,
  displayStringOf,
  mapTypedToLegacy,
  variantToDisplayString,
} from "../draft";
import type { DraftEdit } from "../types";

describe("displayStringOf", () => {
  it("returns undefined when no draft exists", () => {
    expect(displayStringOf(undefined)).toBeUndefined();
  });

  it("returns null for Delete intent (regardless of display)", () => {
    const d: DraftEdit = { value: null, intent: "Delete", display: "ignored" };
    expect(displayStringOf(d)).toBeNull();
  });

  it("prefers editor-supplied display over generic variant stringification", () => {
    const d: DraftEdit = { value: 6, intent: "Set", display: "Rotate 90 CW" };
    expect(displayStringOf(d)).toBe("Rotate 90 CW");
  });

  it("falls back to variant stringification when display is absent", () => {
    const d: DraftEdit = { value: 6, intent: "Set" };
    expect(displayStringOf(d)).toBe("6");
  });

  it("falls back to variant stringification when display is null", () => {
    const d: DraftEdit = { value: 6, intent: "Set", display: null as unknown as string };
    expect(displayStringOf(d)).toBe("6");
  });

  it("does not invoke display fallback for list values when display is present", () => {
    const d: DraftEdit = {
      value: ["beach", "sunset"],
      intent: "Set",
      display: "beach • sunset",
    };
    expect(displayStringOf(d)).toBe("beach • sunset");
  });
});

describe("mapTypedToLegacy", () => {
  it("uses display string at the Tauri boundary when present", () => {
    const typed = {
      "a.jpg": {
        "EXIF:Orientation": { value: 6, intent: "Set", display: "Rotate 90 CW" } as DraftEdit,
      },
    };
    expect(mapTypedToLegacy(typed)).toEqual({
      "a.jpg": { "EXIF:Orientation": "Rotate 90 CW" },
    });
  });

  it("falls back to variantToDisplayString when display absent", () => {
    const typed = {
      "a.jpg": { Rating: { value: 5, intent: "Set" } as DraftEdit },
    };
    expect(mapTypedToLegacy(typed)).toEqual({ "a.jpg": { Rating: "5" } });
  });

  it("emits null for Delete intent and ignores any display value", () => {
    const typed = {
      "a.jpg": {
        Tag: { value: null, intent: "Delete", display: "should-not-show" } as DraftEdit,
      },
    };
    expect(mapTypedToLegacy(typed)).toEqual({ "a.jpg": { Tag: null } });
  });
});

describe("deriveLegacyFileEdits", () => {
  it("prefers display per key", () => {
    const file = {
      "EXIF:Orientation": { value: 6, intent: "Set", display: "Rotate 90 CW" } as DraftEdit,
      Rating: { value: 5, intent: "Set" } as DraftEdit,
      Old: { value: null, intent: "Delete" } as DraftEdit,
    };
    expect(deriveLegacyFileEdits(file)).toEqual({
      "EXIF:Orientation": "Rotate 90 CW",
      Rating: "5",
      Old: null,
    });
  });
});

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
