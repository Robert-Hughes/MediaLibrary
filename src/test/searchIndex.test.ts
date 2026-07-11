import { describe, it, expect } from "vitest";
import { SearchIndex } from "../search/searchIndex";
import type { MetadataDraftEdit } from "../types";
import { mockMetadata } from "./factories";

const edit = (value: string): MetadataDraftEdit => ({
  value: { kind: "Text", value },
  intent: "Set",
});
const del: MetadataDraftEdit = { value: null, intent: "Delete" };

function seed(idx: SearchIndex) {
  idx.setPhoto({
    relative_path: "a.jpg",
    filename: "a.jpg",
    date_modified: 1_700_000_000,
    date_created: null,
  });
  idx.setPhoto({
    relative_path: "b.jpg",
    filename: "b.jpg",
    date_modified: 1_700_000_000,
    date_created: null,
  });
  idx.setPhoto({
    relative_path: "sub/c.jpg",
    filename: "c.jpg",
    date_modified: 1_700_000_000,
    date_created: null,
  });
}

function matchedSet(idx: SearchIndex, q: string): Set<string> {
  return new Set(idx.query(q).matched);
}

describe("SearchIndex", () => {
  describe("query basics", () => {
    it("returns all paths for empty query", () => {
      const idx = new SearchIndex();
      seed(idx);
      expect(matchedSet(idx, "")).toEqual(
        new Set(["a.jpg", "b.jpg", "sub/c.jpg"]),
      );
      expect(matchedSet(idx, "   ")).toEqual(
        new Set(["a.jpg", "b.jpg", "sub/c.jpg"]),
      );
    });

    it("filters by filename substring (case-insensitive)", () => {
      const idx = new SearchIndex();
      seed(idx);
      expect(matchedSet(idx, "a.JPG")).toEqual(new Set(["a.jpg"]));
    });

    it("filters by relative path fragment", () => {
      const idx = new SearchIndex();
      seed(idx);
      expect(matchedSet(idx, "sub/")).toEqual(new Set(["sub/c.jpg"]));
    });

    it("matches via hidden metadata key", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setMeta("a.jpg", mockMetadata({ "Secret:Tag": "hidden-value" }));
      idx.setMeta("b.jpg", mockMetadata({ "Secret:Tag": "other" }));
      expect(matchedSet(idx, "hidden-value")).toEqual(new Set(["a.jpg"]));
    });

    it("matches via metadata value across nested variants", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setMeta(
        "a.jpg",
        mockMetadata({
          "IFD0:Make": "Sony",
          Subjects: ["birds", "trees"],
        }),
      );
      expect(matchedSet(idx, "trees")).toEqual(new Set(["a.jpg"]));
    });

    it("loading metadata yields no metadata match", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setMeta("a.jpg", "loading");
      expect(matchedSet(idx, "anything-meta")).toEqual(new Set());
    });
  });

  describe("draft edits", () => {
    it("matches draft value text", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setDrafts("a.jpg", { "XMP-dc:Description": edit("a tasty muffin") });
      expect(matchedSet(idx, "muffin")).toEqual(new Set(["a.jpg"]));
    });

    it("renders delete-intent edits as '—' in the haystack", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setDrafts("a.jpg", { "X:Y": del });
      expect(matchedSet(idx, "—")).toEqual(
        new Set(["a.jpg", "b.jpg", "sub/c.jpg"]),
      );
      expect(matchedSet(idx, "x:y")).toEqual(new Set(["a.jpg"]));
    });

    it("clearing drafts removes their contribution to the haystack", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setDrafts("a.jpg", { "XMP-dc:Description": edit("uniquedraftword") });
      expect(matchedSet(idx, "uniquedraftword")).toEqual(new Set(["a.jpg"]));
      idx.setDrafts("a.jpg", undefined);
      expect(matchedSet(idx, "uniquedraftword")).toEqual(new Set());
    });
  });

  describe("has:edits filter", () => {
    it("restricts to paths with any draft", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setDrafts("a.jpg", { "X:Y": edit("v") });
      expect(matchedSet(idx, "has:edits")).toEqual(new Set(["a.jpg"]));
    });

    it("combines with a substring query", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setDrafts("a.jpg", { "X:Y": edit("v") });
      idx.setDrafts("b.jpg", { "X:Y": edit("v") });
      expect(matchedSet(idx, "has:edits a.jpg")).toEqual(new Set(["a.jpg"]));
    });

    it("yields nothing when no drafts exist", () => {
      const idx = new SearchIndex();
      seed(idx);
      expect(matchedSet(idx, "has:edits")).toEqual(new Set());
    });
  });

  describe("prefix narrowing cache", () => {
    it("a wider query after a narrower one still returns full matches", () => {
      const idx = new SearchIndex();
      seed(idx);
      // narrow first
      idx.query("a.jpg");
      // wider — cache should not be used
      expect(matchedSet(idx, "")).toEqual(
        new Set(["a.jpg", "b.jpg", "sub/c.jpg"]),
      );
    });

    it("typing extra chars narrows correctly", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setMeta("a.jpg", mockMetadata({ "IFD0:Make": "Canon" }));
      idx.setMeta("b.jpg", mockMetadata({ "IFD0:Make": "Canon EOS R5" }));
      expect(matchedSet(idx, "canon")).toEqual(new Set(["a.jpg", "b.jpg"]));
      expect(matchedSet(idx, "canon eos")).toEqual(new Set(["b.jpg"]));
    });

    it("a switched-stem query still produces correct results", () => {
      const idx = new SearchIndex();
      seed(idx);
      expect(matchedSet(idx, "a.jpg")).toEqual(new Set(["a.jpg"]));
      expect(matchedSet(idx, "b.jpg")).toEqual(new Set(["b.jpg"]));
    });

    it("toggling has:edits filter does not reuse prior cache unsoundly", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.setDrafts("a.jpg", { "X:Y": edit("v") });
      // First a plain substring that all match would
      expect(matchedSet(idx, ".jpg")).toEqual(
        new Set(["a.jpg", "b.jpg", "sub/c.jpg"]),
      );
      // Now add filter — must scope to drafts even though prior matched all
      expect(matchedSet(idx, ".jpg has:edits")).toEqual(new Set(["a.jpg"]));
      // Drop filter again — should re-include all
      expect(matchedSet(idx, ".jpg")).toEqual(
        new Set(["a.jpg", "b.jpg", "sub/c.jpg"]),
      );
    });

    it("mutation invalidates the cache", () => {
      const idx = new SearchIndex();
      seed(idx);
      expect(matchedSet(idx, "uniquemeta")).toEqual(new Set());
      idx.setMeta("a.jpg", mockMetadata({ "X:Y": "uniquemeta" }));
      // If cache wasn't invalidated, the prior empty result would be reused.
      expect(matchedSet(idx, "uniquemeta")).toEqual(new Set(["a.jpg"]));
    });
  });

  describe("deletion and clear", () => {
    it("deletePath removes from results", () => {
      const idx = new SearchIndex();
      seed(idx);
      expect(matchedSet(idx, "a.jpg")).toEqual(new Set(["a.jpg"]));
      idx.deletePath("a.jpg");
      expect(matchedSet(idx, "a.jpg")).toEqual(new Set());
    });

    it("clear empties the index", () => {
      const idx = new SearchIndex();
      seed(idx);
      idx.clear();
      expect(idx.size()).toBe(0);
      expect(matchedSet(idx, "")).toEqual(new Set());
    });
  });

  describe("photo upsert updates haystack", () => {
    it("replacing photo fields re-indexes filename matches", () => {
      const idx = new SearchIndex();
      idx.setPhoto({
        relative_path: "p",
        filename: "old.jpg",
        date_modified: null,
        date_created: null,
      });
      expect(matchedSet(idx, "old")).toEqual(new Set(["p"]));
      idx.setPhoto({
        relative_path: "p",
        filename: "renamed.jpg",
        date_modified: null,
        date_created: null,
      });
      expect(matchedSet(idx, "old")).toEqual(new Set());
      expect(matchedSet(idx, "renamed")).toEqual(new Set(["p"]));
    });
  });
});
