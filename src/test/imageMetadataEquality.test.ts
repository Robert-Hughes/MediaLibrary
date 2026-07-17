// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MetadataOccurrence, MetadataOccurrences } from "../types";
import { metadataCollection } from "../utils/metadataCollection";
import {
  metadataCollectionsEqualExact,
  metadataOccurrencesEqualExact,
} from "../utils/imageMetadataEquality";

const occurrence = (): MetadataOccurrence => ({
  id: { document: null, path: "IFD0", tag_id: "282", copy: 0 },
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
  write_target: { group1: "IFD0", tag_name: "XResolution" },
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
          write_target: { group1: "IFD1", tag_name: "XResolution" },
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

  it("compares compatibility keys, schema identity, and exact values independent of record order", () => {
    const first = metadataCollection([
      { id: { table: "Exif::Main", tag_id: "282" }, value: occurrence().value },
      {
        id: { table: "XMP::Main", tag_id: "title" },
        value: { kind: "Text", value: "title" },
      },
    ]);
    const reordered = Object.fromEntries(
      Object.entries(structuredClone(first)).reverse(),
    );
    expect(metadataCollectionsEqualExact(first, reordered)).toBe(true);
    const changedSchema = metadataCollection([
      { id: { table: "Other", tag_id: "282" }, value: occurrence().value },
    ]);
    expect(
      metadataCollectionsEqualExact(
        metadataCollection([
          {
            id: { table: "Exif::Main", tag_id: "282" },
            value: occurrence().value,
          },
        ]),
        changedSchema,
      ),
    ).toBe(false);
    const changedValue = metadataCollection([
      {
        id: { table: "Exif::Main", tag_id: "282" },
        value: { kind: "Rational", value: { numerator: 2, denominator: 4 } },
      },
    ]);
    expect(
      metadataCollectionsEqualExact(
        metadataCollection([
          {
            id: { table: "Exif::Main", tag_id: "282" },
            value: occurrence().value,
          },
        ]),
        changedValue,
      ),
    ).toBe(false);
  });
});
