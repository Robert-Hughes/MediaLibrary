import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../search/searchQuery";

describe("parseSearchQuery", () => {
  it("separates free text from case-insensitive operators", () => {
    expect(parseSearchQuery("  Beatles KIND:Audio has:EDITS live  ")).toEqual({
      raw: "  Beatles KIND:Audio has:EDITS live  ",
      freeText: "Beatles live",
      normalizedFreeText: "beatles live",
      filters: {
        hasEdits: true,
        mediaKinds: ["audio"],
      },
      filterKey: "hasEdits=1;mediaKinds=audio",
    });
  });

  it("deduplicates and canonicalizes repeated media kinds", () => {
    const parsed = parseSearchQuery(
      "kind:video kind:audio kind:video kind:image",
    );
    expect(parsed.filters.mediaKinds).toEqual(["image", "audio", "video"]);
    expect(parsed.filterKey).toBe("hasEdits=0;mediaKinds=image,audio,video");
  });

  it("keeps unknown and partial operators as free text", () => {
    const parsed = parseSearchQuery(
      "kind:document mykind:audio has:changes kind:audio,",
    );
    expect(parsed.freeText).toBe(
      "kind:document mykind:audio has:changes kind:audio,",
    );
    expect(parsed.filters).toEqual({
      hasEdits: false,
      mediaKinds: [],
    });
  });

  it("returns an empty structured query for whitespace", () => {
    expect(parseSearchQuery(" \t ")).toMatchObject({
      freeText: "",
      normalizedFreeText: "",
      filters: { hasEdits: false, mediaKinds: [] },
    });
  });
});
