import { describe, expect, it, vi } from "vitest";
import type {
  MetadataOccurrence,
  MetadataOccurrenceId,
  TagInfo,
  TagKind,
} from "../types";
import { normalizeMetadataOccurrencesFromTauri } from "../utils/scanEvents";

const id = (
  overrides: Partial<MetadataOccurrenceId> = {},
): MetadataOccurrenceId => ({
  document: null,
  path: "JPEG-APP1-IFD0",
  runtime_tag_id: "282",
  tag_id_scope: { table: "TestFixture::Runtime", tag_id: "282", index: null },
  copy: 0,
  ...overrides,
});

const tagInfo = (kind: TagKind = { kind: "Text" }): TagInfo => ({
  id: { table: "Exif::Main", tag_id: "282" },
  group: "IFD0",
  name: "XResolution",
  writable: true,
  kind,
  description: "Resolution",
  storage_count: "1",
});

const occurrence = (
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence => ({
  id: id(),
  value: { kind: "Text", value: "300 dpi" },
  tag_info: null,
  write_target: null,
  ...overrides,
  schema_id: overrides.schema_id ?? { table: "Exif::Main", tag_id: "282" },
});

describe("normalizeMetadataOccurrencesFromTauri", () => {
  it("preserves valid unresolved occurrences and null write targets", () => {
    const value = occurrence();
    expect(normalizeMetadataOccurrencesFromTauri([value])).toEqual([value]);
  });

  it("preserves resolved TagInfo, semantic values, and exact write targets", () => {
    const value = occurrence({
      value: { kind: "Integer", value: 300 },
      tag_info: tagInfo({ kind: "Integer", data: { min: 0, max: null } }),
      write_target: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "XResolution",
      },
    });
    expect(normalizeMetadataOccurrencesFromTauri([value])).toEqual([value]);
  });

  it("rejects the complete payload when TagInfo conflicts with the occurrence schema", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const valid = occurrence({ id: id({ copy: 1 }) });
    const mismatched = occurrence({
      tag_info: tagInfo(),
      schema_id: { table: "Exif::Other", tag_id: "282" },
    });

    expect(normalizeMetadataOccurrencesFromTauri([valid, mismatched])).toEqual(
      [],
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /occurrence ID.*JPEG-APP1-IFD0.*occurrence schema.*Exif::Other.*TagInfo schema.*Exif::Main/,
      ),
    );
    error.mockRestore();
  });

  it("keeps distinct occurrence IDs that share one exact schema", () => {
    const first = occurrence({ id: id({ path: "JPEG-APP1-IFD0" }) });
    const second = occurrence({
      id: id({ path: "JPEG-APP1-IFD1", copy: 2 }),
    });
    expect(normalizeMetadataOccurrencesFromTauri([second, first])).toEqual([
      first,
      second,
    ]);
  });

  it("keeps valid shared-guard variants while isolating malformed siblings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const values = [
      occurrence({ id: id({ copy: 0 }), value: { kind: "Integer", value: 1 } }),
      occurrence({ id: id({ copy: 1 }), value: { kind: "Real", value: 1.5 } }),
      occurrence({ id: id({ copy: 2 }), value: { kind: "Null" } }),
      occurrence({ id: id({ copy: 3 }), value: { kind: "Binary" } }),
      occurrence({
        id: id({ copy: 4 }),
        value: {
          kind: "Unknown",
          value: {
            raw: { nested: [null, true, 2, "raw"] },
            expected: null,
            reason: null,
          },
        },
      }),
    ];
    const invalid = [
      occurrence({
        id: id({ copy: 5 }),
        value: { kind: "Integer", value: 1.5 } as never,
      }),
      occurrence({
        id: id({ copy: 6 }),
        value: {
          kind: "Unknown",
          value: {
            raw: { invalid: undefined },
            expected: null,
            reason: null,
          },
        } as never,
      }),
    ];

    expect(
      normalizeMetadataOccurrencesFromTauri([...values, ...invalid]),
    ).toEqual(values);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[metadata] Dropped 2 invalid occurrence value(s)",
    );
    warn.mockRestore();
  });

  it("validates nested list and struct TagKind variants", () => {
    const nested: TagKind = {
      kind: "Bag",
      data: {
        kind: "Struct",
        data: { title: { kind: "Seq", data: { kind: "Text" } } },
      },
    };
    expect(
      normalizeMetadataOccurrencesFromTauri([
        occurrence({ tag_info: tagInfo(nested) }),
      ]),
    ).toHaveLength(1);
  });

  it.each([
    [
      "missing document",
      { ...occurrence(), id: { ...id(), document: undefined } },
    ],
    ["negative copy", occurrence({ id: id({ copy: -1 }) })],
    ["fractional copy", occurrence({ id: id({ copy: 1.5 }) })],
    [
      "invalid semantic value",
      { ...occurrence(), value: { kind: "Text", value: 3 } },
    ],
    [
      "invalid TagInfo",
      { ...occurrence(), tag_info: { ...tagInfo(), writable: "yes" } },
    ],
    [
      "invalid write target",
      { ...occurrence(), write_target: { group1: "IFD0" } },
    ],
  ])("discards %s", (_label, value) => {
    expect(normalizeMetadataOccurrencesFromTauri([value])).toEqual([]);
  });

  it("isolates invalid siblings and emits one warning with the drop count", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = occurrence();
    expect(
      normalizeMetadataOccurrencesFromTauri([
        { ...valid, id: { ...valid.id, copy: -1 } },
        valid,
      ]),
    ).toEqual([valid]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1"));
    warn.mockRestore();
  });

  it("drops one duplicate, keeps siblings sorted, warns once, and preserves input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = occurrence({ value: { kind: "Text", value: "first" } });
    const second = occurrence({ value: { kind: "Text", value: "second" } });
    const sibling = occurrence({ id: id({ copy: 1 }) });
    const input = [sibling, first, second];
    const before = structuredClone(input);

    expect(normalizeMetadataOccurrencesFromTauri(input)).toEqual([
      first,
      sibling,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[metadata] Dropped 1 invalid occurrence value(s)",
    );
    expect(input).toEqual(before);
    warn.mockRestore();
  });

  it("sorts by document, path, tag ID, and copy without using tokens", () => {
    const values = [
      occurrence({ id: id({ document: "b" }) }),
      occurrence({ id: id({ copy: 2 }) }),
      occurrence({ id: id({ runtime_tag_id: "100" }) }),
      occurrence({ id: id({ path: "A" }) }),
      occurrence({ id: id({ document: "a" }) }),
    ];
    expect(
      normalizeMetadataOccurrencesFromTauri(values).map((v) => v.id),
    ).toEqual([
      id({ path: "A" }),
      id({ runtime_tag_id: "100" }),
      id({ copy: 2 }),
      id({ document: "a" }),
      id({ document: "b" }),
    ]);
  });

  it("does not collide delimiter-like identity components", () => {
    const first = occurrence({ id: id({ path: "a|b", runtime_tag_id: "c" }) });
    const second = occurrence({ id: id({ path: "a", runtime_tag_id: "b|c" }) });
    expect(normalizeMetadataOccurrencesFromTauri([first, second])).toHaveLength(
      2,
    );
  });

  it("keeps IFD0 Copy0 and IFD1 Copy2 distinct", () => {
    const ifd0 = occurrence({ id: id({ path: "JPEG-APP1-IFD0" }) });
    const ifd1 = occurrence({
      id: id({ path: "JPEG-APP1-IFD1", copy: 2 }),
    });
    expect(normalizeMetadataOccurrencesFromTauri([ifd1, ifd0])).toEqual([
      ifd0,
      ifd1,
    ]);
  });
});
