import { describe, it, expect } from "vitest";
import { haystackContainsNormalized, normalizeListSearchQuery, splitForHighlight } from "../utils/listSearchText";

describe("normalizeListSearchQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeListSearchQuery("  Foo  ")).toBe("foo");
  });
});

describe("haystackContainsNormalized", () => {
  it("returns true for empty needle", () => {
    expect(haystackContainsNormalized("anything", "")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(haystackContainsNormalized("Hello World", "world")).toBe(true);
  });
});

describe("splitForHighlight", () => {
  it("returns single non-match segment when query empty", () => {
    expect(splitForHighlight("abc", "")).toEqual([{ text: "abc", match: false }]);
  });

  it("marks middle match preserving case", () => {
    expect(splitForHighlight("fooBarBaz", "bar")).toEqual([
      { text: "foo", match: false },
      { text: "Bar", match: true },
      { text: "Baz", match: false },
    ]);
  });

  it("handles repeated matches", () => {
    expect(splitForHighlight("abab", "ab")).toEqual([
      { text: "ab", match: true },
      { text: "ab", match: true },
    ]);
  });
});
