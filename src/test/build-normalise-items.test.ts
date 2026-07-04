import { describe, it, expect } from "vitest";
import type { DraftEdit, NormaliseGroup, Variant } from "../types";
import {
  buildNormaliseItemForPhoto,
  buildNormaliseItems,
  resolveTag,
} from "../utils/buildNormaliseItems";

function set(value: Variant): DraftEdit {
  return { value, intent: "Set" };
}

function del(): DraftEdit {
  return { value: null, intent: "Delete" };
}

describe("resolveTag", () => {
  it("draft Set wins over metadata", () => {
    const m: Record<string, Variant> = { "XMP-dc:Title": "from-meta" };
    const d: Record<string, DraftEdit> = { "XMP-dc:Title": set("from-draft") };
    expect(resolveTag(m, d, "XMP-dc:Title")).toBe("from-draft");
  });

  it("draft Delete masks metadata to null", () => {
    const m: Record<string, Variant> = { "XMP-dc:Title": "from-meta" };
    const d: Record<string, DraftEdit> = { "XMP-dc:Title": del() };
    expect(resolveTag(m, d, "XMP-dc:Title")).toBeNull();
  });

  it("falls through to metadata when no draft", () => {
    const m: Record<string, Variant> = { "XMP-dc:Title": "meta" };
    expect(resolveTag(m, undefined, "XMP-dc:Title")).toBe("meta");
  });

  it("returns null when neither side has the tag", () => {
    expect(resolveTag(undefined, undefined, "X")).toBeNull();
  });
});

const ALL_GROUPS: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
  "headline",
  "title",
  "location",
  "dates",
];

describe("buildNormaliseItemForPhoto — keywords", () => {
  it("packs draft-overlay keyword sources into the bundle", () => {
    const m: Record<string, Variant> = {
      "XMP-lr:HierarchicalSubject": ["A|B|C"],
      "XMP-dc:Subject": ["C", "D"],
      "IPTC:Keywords": ["D"],
      "XMP-mlib:AITags": ["lion"],
      "XMP-mlib:AIObjects": ["statue"],
    };
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, [
      "keywords",
    ]);
    expect(item.groupInputs.keywords).toEqual({
      hierarchicalSubject: ["A|B|C"],
      dcSubject: ["C", "D"],
      iptcKeywords: ["D"],
      aiTags: ["lion"],
      aiObjects: ["statue"],
    });
  });

  it("uses draft list when present", () => {
    const m: Record<string, Variant> = { "XMP-dc:Subject": ["meta"] };
    const d: Record<string, DraftEdit> = {
      "XMP-dc:Subject": set(["draft1", "draft2"]),
    };
    const item = buildNormaliseItemForPhoto("x.jpg", m, d, ["keywords"]);
    expect(item.groupInputs.keywords?.dcSubject).toEqual(["draft1", "draft2"]);
  });

  it("treats deleted-draft as empty", () => {
    const m: Record<string, Variant> = { "XMP-dc:Subject": ["meta"] };
    const d: Record<string, DraftEdit> = { "XMP-dc:Subject": del() };
    const item = buildNormaliseItemForPhoto("x.jpg", m, d, ["keywords"]);
    expect(item.groupInputs.keywords?.dcSubject).toEqual([]);
  });

  it("promotes scalar string to single-entry list (exiftool quirk)", () => {
    // Exiftool sometimes emits a single-entry Bag as a scalar string;
    // the resolver must accept this and treat it as ["x"].
    const m: Record<string, Variant> = { "XMP-dc:Subject": "lone-keyword" };
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, [
      "keywords",
    ]);
    expect(item.groupInputs.keywords?.dcSubject).toEqual(["lone-keyword"]);
  });
});

describe("buildNormaliseItemForPhoto — creator", () => {
  it("packs Seq creator + scalar artist + Seq byline", () => {
    const m: Record<string, Variant> = {
      "XMP-dc:Creator": ["Alice", "Bob"],
      "IFD0:Artist": "Alice; Bob",
      "IPTC:By-line": ["Alice"],
    };
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, ["creator"]);
    expect(item.groupInputs.creator).toEqual({
      creator: ["Alice", "Bob"],
      artist: "Alice; Bob",
      byline: ["Alice"],
    });
  });
});

describe("buildNormaliseItemForPhoto — disabled groups stay null", () => {
  it("only enabled groups get populated", () => {
    const m: Record<string, Variant> = {
      "XMP-dc:Subject": ["a"],
      "XMP-dc:Creator": ["alice"],
    };
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, [
      "keywords",
    ]);
    expect(item.groupInputs.keywords).not.toBeNull();
    expect(item.groupInputs.creator).toBeNull();
    expect(item.groupInputs.copyright).toBeNull();
  });
});

describe("buildNormaliseItemForPhoto — location", () => {
  it("packs all five XMP↔IIM pairs", () => {
    const m: Record<string, Variant> = {
      "XMP-photoshop:City": "Paris",
      "IPTC:Country-PrimaryLocationCode": "FR",
    };
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, [
      "location",
    ]);
    expect(item.groupInputs.location).toEqual({
      locationXmp: null,
      locationIptc: null,
      cityXmp: "Paris",
      cityIptc: null,
      stateXmp: null,
      stateIptc: null,
      countryXmp: null,
      countryIptc: null,
      countryCodeXmp: null,
      countryCodeIptc: "FR",
    });
  });
});

describe("buildNormaliseItemForPhoto — dates", () => {
  it("extracts file_stem from rel path with subdir + extension", () => {
    const item = buildNormaliseItemForPhoto(
      "trips/2024/IMG_20240615_143045.jpg",
      undefined,
      undefined,
      ["dates"],
    );
    expect(item.groupInputs.dates?.fileStem).toBe("IMG_20240615_143045");
  });

  it("handles Windows-style backslashes in rel path", () => {
    const item = buildNormaliseItemForPhoto(
      "trips\\2024\\IMG_20240615_143045.jpg",
      undefined,
      undefined,
      ["dates"],
    );
    expect(item.groupInputs.dates?.fileStem).toBe("IMG_20240615_143045");
  });

  it("handles dotfile (no extension)", () => {
    const item = buildNormaliseItemForPhoto(
      "weird/.hidden",
      undefined,
      undefined,
      ["dates"],
    );
    expect(item.groupInputs.dates?.fileStem).toBe(".hidden");
  });

  it("packs all H1 + H2 source fields", () => {
    const m: Record<string, Variant> = {
      "ExifIFD:DateTimeOriginal": "2024:06:15 14:30:45",
      "ExifIFD:OffsetTimeOriginal": "+01:00",
      "ExifIFD:CreateDate": "2024:06:15 14:30:45",
    };
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, ["dates"]);
    expect(item.groupInputs.dates?.dateTimeOriginal).toBe(
      "2024:06:15 14:30:45",
    );
    expect(item.groupInputs.dates?.offsetTimeOriginal).toBe("+01:00");
    expect(item.groupInputs.dates?.createDate).toBe("2024:06:15 14:30:45");
  });
});

describe("buildNormaliseItems batch", () => {
  it("returns one item per supplied rel path", () => {
    const md = new Map<string, Record<string, Variant>>();
    md.set("a.jpg", { "XMP-dc:Subject": ["a-keyword"] });
    md.set("b.jpg", { "XMP-dc:Subject": ["b-keyword"] });
    const items = buildNormaliseItems(
      ["a.jpg", "b.jpg"],
      { get: (p) => md.get(p) },
      {},
      ["keywords"],
    );
    expect(items).toHaveLength(2);
    expect(items[0].relPath).toBe("a.jpg");
    expect(items[1].relPath).toBe("b.jpg");
    expect(items[0].groupInputs.keywords?.dcSubject).toEqual(["a-keyword"]);
    expect(items[1].groupInputs.keywords?.dcSubject).toEqual(["b-keyword"]);
  });

  it("missing metadata for a path → groups still populated with empties", () => {
    const items = buildNormaliseItems(
      ["unknown.jpg"],
      { get: () => undefined },
      {},
      ALL_GROUPS,
    );
    const inp = items[0].groupInputs;
    expect(inp.keywords?.dcSubject).toEqual([]);
    expect(inp.creator?.creator).toEqual([]);
    expect(inp.copyright?.rights).toBeNull();
    expect(inp.dates?.fileStem).toBe("unknown");
  });

  it("draft store is consulted per path", () => {
    const items = buildNormaliseItems(
      ["a.jpg"],
      { get: () => ({ "XMP-dc:Title": "from-meta" }) },
      { "a.jpg": { "XMP-dc:Title": set("from-draft") } },
      ["title"],
    );
    expect(items[0].groupInputs.title?.title).toBe("from-draft");
  });
});
