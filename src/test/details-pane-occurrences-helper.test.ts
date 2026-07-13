import { describe, expect, it } from "vitest";
import type {
  MetadataValue,
  MetadataOccurrence,
  MetadataOccurrenceId,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { metadataCollection, metadataGet } from "../utils/metadataCollection";
import {
  overlayUniqueOccurrenceValues,
  supplementalResolvedMetadataOccurrences,
} from "../utils/detailsPaneHelpers";
import { buildSchemaOccurrenceResolutionIndex } from "../utils/metadataOccurrences";

const schemaId: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "282",
};
const tagInfo: TagInfo = {
  id: schemaId,
  group: "IFD0",
  name: "XResolution",
  writable: true,
  kind: { kind: "Integer", data: { min: null, max: null } },
  description: null,
};

function occurrence(
  id: MetadataOccurrenceId,
  value: number,
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  return {
    id,
    value: { kind: "Integer", value },
    tag_info: tagInfo,
    write_target: { group1: "IFD0", tag_name: "XResolution" },
    ...overrides,
  };
}

const ifd0 = (copy = 0): MetadataOccurrenceId => ({
  document: null,
  path: "JPEG-APP1-IFD0",
  tag_id: "282",
  copy,
});
const ifd1 = (copy = 2): MetadataOccurrenceId => ({
  document: null,
  path: "JPEG-APP1-IFD1",
  tag_id: "282",
  copy,
});

function supplemental(
  occurrences: readonly MetadataOccurrence[],
  legacyMetadata: Parameters<typeof supplementalResolvedMetadataOccurrences>[1],
) {
  return supplementalResolvedMetadataOccurrences(
    occurrences,
    legacyMetadata,
    buildSchemaOccurrenceResolutionIndex(occurrences),
  );
}

function occurrenceWithValue(
  id: MetadataOccurrenceId,
  value: MetadataValue,
  info: TagInfo | null = tagInfo,
): MetadataOccurrence {
  return {
    id,
    value,
    tag_info: info,
    write_target: null,
  };
}

function overlay(
  legacyMetadata: Parameters<typeof overlayUniqueOccurrenceValues>[0],
  occurrences: readonly MetadataOccurrence[],
) {
  return overlayUniqueOccurrenceValues(
    legacyMetadata,
    buildSchemaOccurrenceResolutionIndex(occurrences),
  );
}

describe("overlayUniqueOccurrenceValues", () => {
  it("replaces a differing legacy value for a unique occurrence", () => {
    const legacy = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);

    expect(
      metadataGet(
        overlay(legacy, [
          occurrenceWithValue(ifd0(), { kind: "Integer", value: 301 }),
        ]),
        schemaId,
      ),
    ).toEqual({ kind: "Integer", value: 301, id: schemaId });
  });

  it("adds a unique occurrence that is absent from legacy metadata", () => {
    expect(
      metadataGet(
        overlay({}, [
          occurrenceWithValue(ifd0(), { kind: "Integer", value: 301 }),
        ]),
        schemaId,
      ),
    ).toEqual({ kind: "Integer", value: 301, id: schemaId });
  });

  it("retains the legacy value for a missing resolution", () => {
    const legacy = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);
    expect(metadataGet(overlay(legacy, []), schemaId)).toBe(
      metadataGet(legacy, schemaId),
    );
  });

  it("retains the compatibility aggregate for a multiple resolution", () => {
    const legacy = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);
    const result = overlay(legacy, [
      occurrenceWithValue(ifd0(), { kind: "Integer", value: 301 }),
      occurrenceWithValue(ifd1(), { kind: "Integer", value: 302 }),
    ]);
    expect(metadataGet(result, schemaId)).toBe(metadataGet(legacy, schemaId));
  });

  it("adds nothing for a multiple resolution without a legacy entry", () => {
    const result = overlay({}, [
      occurrenceWithValue(ifd0(), { kind: "Integer", value: 301 }),
      occurrenceWithValue(ifd1(), { kind: "Integer", value: 302 }),
    ]);
    expect(metadataGet(result, schemaId)).toBeUndefined();
    expect(result).toEqual({});
  });

  it("does not collapse identical multiple values into an authoritative value", () => {
    const result = overlay({}, [
      occurrenceWithValue(ifd0(), { kind: "Integer", value: 301 }),
      occurrenceWithValue(ifd1(), { kind: "Integer", value: 301 }),
    ]);
    expect(metadataGet(result, schemaId)).toBeUndefined();
  });

  it("ignores unknown-schema occurrences", () => {
    const legacy = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);
    const result = overlay(legacy, [
      occurrenceWithValue(ifd0(), { kind: "Integer", value: 999 }, null),
    ]);
    expect(result).toEqual(legacy);
  });

  it("keeps absent and zero schema indexes distinct", () => {
    const unindexedId = { ...schemaId };
    const zeroIndexId = { ...schemaId, index: 0 };
    const unindexedInfo = { ...tagInfo, id: unindexedId };
    const zeroIndexInfo = { ...tagInfo, id: zeroIndexId };
    const result = overlay({}, [
      occurrenceWithValue(
        ifd0(),
        { kind: "Integer", value: 301 },
        unindexedInfo,
      ),
      occurrenceWithValue(
        ifd1(),
        { kind: "Integer", value: 302 },
        zeroIndexInfo,
      ),
    ]);

    expect(metadataGet(result, unindexedId)).toEqual({
      kind: "Integer",
      value: 301,
      id: unindexedId,
    });
    expect(metadataGet(result, zeroIndexId)).toEqual({
      kind: "Integer",
      value: 302,
      id: zeroIndexId,
    });
    expect(Object.keys(result)).toHaveLength(2);
  });

  it("does not mutate legacy metadata or occurrences", () => {
    const legacy = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);
    const occurrences = [
      occurrenceWithValue(ifd0(), { kind: "Integer", value: 301 }),
    ];
    const legacySnapshot = structuredClone(legacy);
    const occurrencesSnapshot = structuredClone(occurrences);

    const result = overlay(legacy, occurrences);

    expect(result).not.toBe(legacy);
    expect(legacy).toEqual(legacySnapshot);
    expect(occurrences).toEqual(occurrencesSnapshot);
  });

  it("preserves nested semantic values exactly without string round-tripping", () => {
    const value: MetadataValue = {
      kind: "List",
      value: {
        list_kind: "Seq",
        items: [
          {
            kind: "Struct",
            value: { nested: { kind: "Integer", value: 301 } },
          },
        ],
      },
    };
    const result = overlay({}, [occurrenceWithValue(ifd0(), value)]);
    const overlaid = metadataGet(result, schemaId);

    expect(overlaid).toEqual({ ...value, id: schemaId });
    expect(overlaid?.kind).toBe("List");
    if (overlaid?.kind !== "List") throw new Error("expected List overlay");
    expect(overlaid.value).toBe(value.value);
  });
});

describe("supplementalResolvedMetadataOccurrences", () => {
  it("returns a resolved occurrence only when its exact schema is absent", () => {
    const value = occurrence(ifd0(), 300);
    expect(supplemental([value], {})).toHaveLength(1);

    const legacy = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);
    expect(supplemental([value], legacy)).toEqual([]);
  });

  it("retains shared-schema occurrences, distinct or identical values, and domain IDs", () => {
    const a = occurrence(ifd0(), 300);
    const b = occurrence(ifd1(), 72, {
      write_target: { group1: "IFD1", tag_name: "XResolution" },
    });
    const distinct = supplemental([b, a], {});
    expect(distinct.map((entry) => entry.value)).toEqual(["300", "72"]);
    expect(distinct.map((entry) => entry.occurrence.id)).toEqual([a.id, b.id]);
    expect(distinct[0].occurrence).toBe(a);

    const identical = supplemental(
      [occurrence(ifd0(), 300), occurrence(ifd1(), 300)],
      {},
    );
    expect(identical).toHaveLength(2);
  });

  it("includes every multiple occurrence even when legacy metadata has the schema", () => {
    const a = occurrence(ifd0(), 300);
    const b = occurrence(ifd1(), 300);
    const legacy = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);

    const entries = supplemental([b, a], legacy);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.occurrence)).toEqual([a, b]);
  });

  it("orders by MetadataOccurrenceId and keeps IFD0 Copy0 distinct from IFD1 Copy2", () => {
    const entries = supplemental(
      [
        occurrence(ifd1(), 72, {
          write_target: { group1: "IFD1", tag_name: "XResolution" },
        }),
        occurrence(ifd0(), 300),
      ],
      {},
    );
    expect(entries.map((entry) => entry.occurrence.id)).toEqual([
      ifd0(),
      ifd1(),
    ]);
    expect(new Set(entries.map((entry) => entry.identityToken)).size).toBe(2);
    expect(entries[0].origin).toContain("primary");
    expect(entries[1].origin).toContain("Copy2");
  });

  it("excludes unresolved occurrences", () => {
    expect(
      supplemental([occurrence(ifd0(), 300, { tag_info: null })], {}),
    ).toEqual([]);
  });

  it("uses the write target runtime group and searches every occurrence coordinate", () => {
    const entry = supplemental(
      [
        occurrence(
          {
            document: "Doc1",
            path: "JPEG-APP1-IFD1",
            tag_id: "282",
            copy: 2,
          },
          72,
          { write_target: { group1: "IFD1", tag_name: "XResolution" } },
        ),
      ],
      {},
    )[0];
    expect(entry.origin).toBe("IFD1 · JPEG-APP1-IFD1 · Copy2 · Doc1");
    for (const text of [
      "XResolution",
      "72",
      "IFD1:XResolution",
      "Doc1",
      "JPEG-APP1-IFD1",
      "282",
      "2",
      "Copy2",
    ]) {
      expect(entry.searchText).toContain(text);
    }
  });

  it("labels a missing write target as a schema-group display fallback", () => {
    const entry = supplemental(
      [occurrence(ifd0(), 300, { write_target: null })],
      {},
    )[0];
    expect(entry.origin).toContain("IFD0");
    expect(entry.originTitle).toContain("Schema-group display fallback");
    expect(entry.originTitle).toContain("not a claimed runtime location");
  });
});
