import { describe, expect, it } from "vitest";
import type {
  MetadataOccurrence,
  MetadataOccurrenceId,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolutionForSchema,
  resolveOccurrencesForSchema,
} from "../utils/metadataOccurrences";

const schemaId: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "282",
};

function tagInfo(id: SchemaDefinitionId = schemaId, writable = true): TagInfo {
  return {
    id,
    group: "IFD0",
    name: "XResolution",
    writable,
    kind: { kind: "Integer", data: { min: null, max: null } },
    description: null,
  };
}

function id(path: string, copy = 0): MetadataOccurrenceId {
  return {
    document: null,
    path,
    runtime_tag_id: "282",
    tag_id_scope: { table: "Exif::Main", tag_id: "282", index: null },
    copy,
  };
}

function occurrence(
  occurrenceId: MetadataOccurrenceId,
  value = 300,
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  return {
    id: occurrenceId,
    value: { kind: "Integer", value },
    tag_info: tagInfo(),
    observed_selector: null,
    write_target: null,
    ...overrides,
    schema_id: overrides.schema_id ?? overrides.tag_info?.id ?? schemaId,
  };
}

describe("schema occurrence resolution", () => {
  it("returns missing when no occurrence matches", () => {
    expect(resolveOccurrencesForSchema([], schemaId)).toEqual({
      kind: "missing",
    });
  });

  it("returns the original object for one exact schema match", () => {
    const value = occurrence(id("IFD0"));
    const resolution = resolveOccurrencesForSchema([value], schemaId);
    expect(resolution).toEqual({ kind: "unique", occurrence: value });
    if (resolution.kind === "unique") expect(resolution.occurrence).toBe(value);
  });

  it("returns multiple exact matches ordered by MetadataOccurrenceId", () => {
    const later = occurrence(id("IFD1", 2), 72);
    const earlier = occurrence(id("IFD0", 0), 300);
    const resolution = resolveOccurrencesForSchema([later, earlier], schemaId);
    expect(resolution.kind).toBe("multiple");
    if (resolution.kind === "multiple") {
      expect(resolution.occurrences).toEqual([earlier, later]);
    }
  });

  it("resolves unknown-schema occurrences by their explicit schema identity", () => {
    const unknown = occurrence(id("IFD0"), 300, { tag_info: null });
    expect(resolveOccurrencesForSchema([unknown], schemaId)).toEqual({
      kind: "unique",
      occurrence: unknown,
    });
  });

  it("does not match a different schema index", () => {
    const indexed = { ...schemaId, index: 1 };
    const value = occurrence(id("IFD0"), 300, {
      schema_id: indexed,
      tag_info: tagInfo(indexed),
    });
    expect(resolveOccurrencesForSchema([value], schemaId)).toEqual({
      kind: "missing",
    });
  });

  it("keeps identical values multiple", () => {
    const resolution = resolveOccurrencesForSchema(
      [occurrence(id("IFD0"), 300), occurrence(id("IFD1"), 300)],
      schemaId,
    );
    expect(resolution.kind).toBe("multiple");
  });

  it("does not prefer Copy0, IFD0, writable, or write-target-bearing matches", () => {
    const candidates = [
      occurrence(id("IFD0", 0)),
      occurrence(id("IFD1", 2), 72, {
        tag_info: tagInfo(schemaId, false),
      }),
      occurrence(id("IFD2", 3), 144, {
        observed_selector: null,
        write_target: {
          group1: "IFD2",
          group7: "ID-Test",
          tag_name: "XResolution",
        },
      }),
    ];
    const resolution = resolveOccurrencesForSchema(candidates, schemaId);
    expect(resolution.kind).toBe("multiple");
    if (resolution.kind === "multiple") {
      expect(resolution.occurrences).toHaveLength(3);
      expect(resolution.occurrences).toEqual(candidates);
    }
  });

  it("is independent of input ordering", () => {
    const first = occurrence(id("IFD0"));
    const second = occurrence(id("IFD1"), 72);
    const forward = resolveOccurrencesForSchema([first, second], schemaId);
    const reverse = resolveOccurrencesForSchema([second, first], schemaId);
    expect(forward).toEqual(reverse);
  });
});

describe("schema occurrence resolution index", () => {
  it("preserves original occurrence objects", () => {
    const first = occurrence(id("IFD0"));
    const second = occurrence(id("IFD1"), 72);
    const resolution = resolutionForSchema(
      buildSchemaOccurrenceResolutionIndex([second, first]),
      schemaId,
    );
    expect(resolution.kind).toBe("multiple");
    if (resolution.kind === "multiple") {
      expect(resolution.occurrences[0]).toBe(first);
      expect(resolution.occurrences[1]).toBe(second);
    }
  });

  it("does not collide delimiter-like schema values", () => {
    const left: SchemaDefinitionId = {
      table: "A:B",
      tag_id: "C",
      index: 1,
    };
    const right: SchemaDefinitionId = {
      table: "A",
      tag_id: "B:C",
      index: 1,
    };
    const leftOccurrence = occurrence(id("left"), 1, {
      tag_info: tagInfo(left),
    });
    const rightOccurrence = occurrence(id("right"), 2, {
      tag_info: tagInfo(right),
    });
    const index = buildSchemaOccurrenceResolutionIndex([
      rightOccurrence,
      leftOccurrence,
    ]);

    expect(resolutionForSchema(index, left)).toEqual({
      kind: "unique",
      occurrence: leftOccurrence,
    });
    expect(resolutionForSchema(index, right)).toEqual({
      kind: "unique",
      occurrence: rightOccurrence,
    });
  });

  it("returns an explicit missing variant for a missing map lookup", () => {
    const index = buildSchemaOccurrenceResolutionIndex([]);
    expect(resolutionForSchema(index, schemaId)).toEqual({ kind: "missing" });
  });

  it("includes unknown-schema occurrences and does not mutate the input", () => {
    const unknown = occurrence(id("unknown"), 1, { tag_info: null });
    const known = occurrence(id("known"), 2);
    const input = [unknown, known];
    const before = [...input];
    const index = buildSchemaOccurrenceResolutionIndex(input);

    expect(input).toEqual(before);
    expect(index.size).toBe(1);
    expect(resolutionForSchema(index, schemaId)).toEqual({
      kind: "multiple",
      occurrences: [known, unknown],
    });
  });
});
