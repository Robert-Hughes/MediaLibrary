// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MetadataOccurrence, MetadataOccurrences } from "../types";
import { metadataOccurrencesEqualExact } from "../utils/imageMetadataEquality";

const occurrence = (): MetadataOccurrence => ({
  id: {
    document: null,
    path: "IFD0",
    runtime_tag_id: "282",
    tag_id_scope: { table: "TestFixture::Runtime", tag_id: "282", index: null },
    copy: 0,
  },
  schema_id: { table: "Exif::Main", tag_id: "282" },
  value: { kind: "Rational", value: { numerator: 1, denominator: 2 } },
  tag_info: {
    id: { table: "Exif::Main", tag_id: "282" },
    group: "IFD0",
    name: "XResolution",
    writable: true,
    kind: { kind: "Rational" },
    description: null,
  },
  write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "XResolution" },
});

describe("exact image metadata equality", () => {
  it("compares every occurrence field and occurrence order", () => {
    const base: MetadataOccurrences = [
      occurrence(),
      { ...occurrence(), id: { ...occurrence().id, copy: 1 } },
    ];
    expect(metadataOccurrencesEqualExact(base, structuredClone(base))).toBe(
      true,
    );
    for (const changed of [
      [{ ...occurrence(), id: { ...occurrence().id, document: "Doc" } }],
      [{ ...occurrence(), id: { ...occurrence().id, copy: 2 } }],
      [
        {
          ...occurrence(),
          value: {
            kind: "Rational" as const,
            value: { numerator: 2, denominator: 4 },
          },
        },
      ],
      [
        {
          ...occurrence(),
          tag_info: { ...occurrence().tag_info!, name: "YResolution" },
        },
      ],
      [
        {
          ...occurrence(),
          write_target: {
            group1: "IFD1",
            group7: "ID-Test",
            tag_name: "XResolution",
          },
        },
      ],
    ])
      expect(metadataOccurrencesEqualExact([occurrence()], changed)).toBe(
        false,
      );
    expect(metadataOccurrencesEqualExact(base, [...base].reverse())).toBe(
      false,
    );
  });
});
