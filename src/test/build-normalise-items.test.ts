import { describe, it, expect } from "vitest";
import { mockMetadata } from "./factories";
import type {
  ImageMetadataEntry,
  MetadataDraftEdit,
  MetadataValue,
  NormaliseGroup,
} from "../types";
import {
  buildNormaliseItemForPhoto,
  buildNormaliseItems,
  resolveTag,
} from "../utils/buildNormaliseItems";

function set(value: MetadataValue): MetadataDraftEdit {
  return { value, intent: "Set" };
}

function text(value: string): MetadataValue {
  return { kind: "Text", value };
}

function listValue(items: string[]): MetadataValue {
  return {
    kind: "List",
    value: {
      list_kind: "Bag",
      items: items.map((value) => text(value)),
    },
  };
}

function del(): MetadataDraftEdit {
  return { value: null, intent: "Delete" };
}

describe("resolveTag", () => {
  it("draft Set wins over metadata", () => {
    const m = mockMetadata({ "XMP-dc:Title": "from-meta" });
    const d: Record<string, MetadataDraftEdit> = {
      "XMP-dc:Title": set(text("from-draft")),
    };
    expect(resolveTag(m, d, "XMP-dc:Title")).toEqual(text("from-draft"));
  });

  it("draft Delete masks metadata to null", () => {
    const m = mockMetadata({ "XMP-dc:Title": "from-meta" });
    const d: Record<string, MetadataDraftEdit> = { "XMP-dc:Title": del() };
    expect(resolveTag(m, d, "XMP-dc:Title")).toBeNull();
  });

  it("falls through to metadata when no draft", () => {
    const m = mockMetadata({ "XMP-dc:Title": "meta" });
    expect(resolveTag(m, undefined, "XMP-dc:Title")).toEqual(text("meta"));
  });

  it("falls through to semantic metadata when no draft", () => {
    const m = mockMetadata({
      "XMP-dc:Title": { kind: "Text", value: "meta" },
    });
    expect(resolveTag(m, undefined, "XMP-dc:Title")).toEqual({
      kind: "Text",
      value: "meta",
    });
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
    const m = mockMetadata({
      "XMP-lr:HierarchicalSubject": ["A|B|C"],
      "XMP-dc:Subject": ["C", "D"],
      "IPTC:Keywords": ["D"],
      "XMP-mlib:AITags": ["lion"],
      "XMP-mlib:AIObjects": ["statue"],
    });
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
    const m = mockMetadata({ "XMP-dc:Subject": ["meta"] });
    const d: Record<string, MetadataDraftEdit> = {
      "XMP-dc:Subject": set(listValue(["draft1", "draft2"])),
    };
    const item = buildNormaliseItemForPhoto("x.jpg", m, d, ["keywords"]);
    expect(item.groupInputs.keywords?.dcSubject).toEqual(["draft1", "draft2"]);
  });

  it("treats deleted-draft as empty", () => {
    const m = mockMetadata({ "XMP-dc:Subject": ["meta"] });
    const d: Record<string, MetadataDraftEdit> = { "XMP-dc:Subject": del() };
    const item = buildNormaliseItemForPhoto("x.jpg", m, d, ["keywords"]);
    expect(item.groupInputs.keywords?.dcSubject).toEqual([]);
  });

  it("promotes scalar string to single-entry list (exiftool quirk)", () => {
    // Exiftool sometimes emits a single-entry Bag as a scalar string;
    // the resolver must accept this and treat it as ["x"].
    const m = mockMetadata({ "XMP-dc:Subject": "lone-keyword" });
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, [
      "keywords",
    ]);
    expect(item.groupInputs.keywords?.dcSubject).toEqual(["lone-keyword"]);
  });

  it("packs semantic list values from scanner metadata", () => {
    const m = mockMetadata({
      "XMP-dc:Subject": {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [
            { kind: "Text", value: "semantic-a" },
            { kind: "Text", value: "semantic-b" },
          ],
        },
      },
    });
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, [
      "keywords",
    ]);
    expect(item.groupInputs.keywords?.dcSubject).toEqual([
      "semantic-a",
      "semantic-b",
    ]);
  });
});

describe("buildNormaliseItemForPhoto — creator", () => {
  it("packs Seq creator + scalar artist + Seq byline", () => {
    const m = mockMetadata({
      "XMP-dc:Creator": ["Alice", "Bob"],
      "IFD0:Artist": "Alice; Bob",
      "IPTC:By-line": ["Alice"],
    });
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
    const m = mockMetadata({
      "XMP-dc:Subject": ["a"],
      "XMP-dc:Creator": ["alice"],
    });
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
    const m = mockMetadata({
      "XMP-photoshop:City": "Paris",
      "IPTC:Country-PrimaryLocationCode": "FR",
    });
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
    const m = mockMetadata({
      "ExifIFD:DateTimeOriginal": "2024:06:15 14:30:45",
      "ExifIFD:OffsetTimeOriginal": "+01:00",
      "ExifIFD:CreateDate": "2024:06:15 14:30:45",
    });
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, ["dates"]);
    expect(item.groupInputs.dates?.dateTimeOriginal).toEqual({
      kind: "Text",
      value: "2024:06:15 14:30:45",
    });
    expect(item.groupInputs.dates?.offsetTimeOriginal).toEqual({
      kind: "Text",
      value: "+01:00",
    });
    expect(item.groupInputs.dates?.createDate).toEqual({
      kind: "Text",
      value: "2024:06:15 14:30:45",
    });
  });

  it("renders semantic date/time values for date normalisation inputs", () => {
    const m = mockMetadata({
      "IPTC:DateCreated": {
        kind: "Date",
        value: { year: 2024, month: 6, day: 15 },
      },
      "IPTC:TimeCreated": {
        kind: "Time",
        value: {
          hour: 14,
          minute: 30,
          second: 45,
          subsecond: null,
          offset: null,
        },
      },
      "ExifIFD:OffsetTimeOriginal": {
        kind: "TimeOffset",
        value: { sign: "Plus", hours: 1, minutes: 0 },
      },
    });
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, ["dates"]);
    expect(item.groupInputs.dates?.iptcDateCreated).toEqual({
      kind: "Date",
      value: { year: 2024, month: 6, day: 15 },
    });
    expect(item.groupInputs.dates?.iptcTimeCreated).toEqual({
      kind: "Time",
      value: {
        hour: 14,
        minute: 30,
        second: 45,
        subsecond: null,
        offset: null,
      },
    });
    expect(item.groupInputs.dates?.offsetTimeOriginal).toEqual({
      kind: "TimeOffset",
      value: { sign: "Plus", hours: 1, minutes: 0 },
    });
  });
});

describe("buildNormaliseItemForPhoto — semantic scalars", () => {
  it("uses x-default from LangAlt description metadata", () => {
    const m = mockMetadata({
      "XMP-dc:Description": {
        kind: "LangAlt",
        value: { "x-default": "Semantic caption", fr: "Legende" },
      },
    });
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, [
      "description",
    ]);
    expect(item.groupInputs.description?.description).toBe("Semantic caption");
  });

  it("does not flatten Unknown metadata into normalise text inputs", () => {
    const m = mockMetadata({
      "XMP-dc:Title": {
        kind: "Unknown",
        value: { expected: null, raw: "raw-title", reason: "no schema" },
      },
    });
    const item = buildNormaliseItemForPhoto("x.jpg", m, undefined, ["title"]);
    expect(item.groupInputs.title?.title).toBeNull();
  });
});

describe("buildNormaliseItems batch", () => {
  it("returns one item per supplied rel path", () => {
    const md = new Map<string, Record<string, ImageMetadataEntry>>();
    md.set("a.jpg", mockMetadata({ "XMP-dc:Subject": ["a-keyword"] }));
    md.set("b.jpg", mockMetadata({ "XMP-dc:Subject": ["b-keyword"] }));
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
      { get: () => mockMetadata({ "XMP-dc:Title": "from-meta" }) },
      { "a.jpg": { "XMP-dc:Title": set(text("from-draft")) } },
      ["title"],
    );
    expect(items[0].groupInputs.title?.title).toBe("from-draft");
  });
});
