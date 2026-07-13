import { describe, expect, it } from "vitest";
import type {
  MetadataDraftTarget,
  MetadataOccurrenceId,
  SchemaDefinitionId,
} from "../types";
import {
  compareMetadataDraftTargetsBySlot,
  metadataDraftTargetEquals,
} from "../utils/metadataDraftTarget";
import { compareSchemaDefinitionIds } from "../utils/schemaDefinitionId";

const schema = (
  table: string,
  tagId: string,
  index?: number,
): SchemaDefinitionId => ({
  table,
  tag_id: tagId,
  ...(index === undefined ? {} : { index }),
});

const occurrence = (
  overrides: Partial<MetadataOccurrenceId> = {},
): MetadataOccurrenceId => ({
  document: null,
  path: "JPEG-APP1-IFD0",
  tag_id: "282",
  copy: 0,
  ...overrides,
});

const existing = (
  overrides: Partial<
    Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }>
  > = {},
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> => ({
  kind: "ExistingOccurrence",
  occurrence_id: occurrence(),
  schema_id: schema("Exif::Main", "282"),
  write_target: { group1: "IFD0", tag_name: "XResolution" },
  ...overrides,
});

const created = (
  id: SchemaDefinitionId = schema("Exif::Main", "282"),
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> => ({
  kind: "NewProperty",
  schema_id: id,
});

describe("compareSchemaDefinitionIds", () => {
  it("orders table strings by Unicode scalar rather than UTF-16 code units", () => {
    expect(
      compareSchemaDefinitionIds(
        schema("\u{e000}", "1"),
        schema("\u{10000}", "1"),
      ),
    ).toBeLessThan(0);
  });

  it("orders tag IDs by Unicode scalar rather than UTF-16 code units", () => {
    expect(
      compareSchemaDefinitionIds(
        schema("table", "\u{e000}"),
        schema("table", "\u{10000}"),
      ),
    ).toBeLessThan(0);
  });

  it("orders an absent index before zero", () => {
    expect(
      compareSchemaDefinitionIds(
        schema("table", "tag"),
        schema("table", "tag", 0),
      ),
    ).toBeLessThan(0);
  });

  it("orders indexes numerically", () => {
    expect(
      compareSchemaDefinitionIds(
        schema("table", "tag", 2),
        schema("table", "tag", 10),
      ),
    ).toBeLessThan(0);
  });
});

describe("compareMetadataDraftTargetsBySlot", () => {
  it("orders existing occurrences before new properties", () => {
    expect(compareMetadataDraftTargetsBySlot(existing(), created())).toBe(-1);
    expect(compareMetadataDraftTargetsBySlot(created(), existing())).toBe(1);
  });

  it("orders existing targets only by occurrence ID", () => {
    const first = existing({ occurrence_id: occurrence({ path: "IFD0" }) });
    const second = existing({ occurrence_id: occurrence({ path: "IFD1" }) });
    expect(compareMetadataDraftTargetsBySlot(first, second)).toBeLessThan(0);
  });

  it("orders new properties only by schema ID", () => {
    expect(
      compareMetadataDraftTargetsBySlot(
        created(schema("A", "tag")),
        created(schema("B", "tag")),
      ),
    ).toBeLessThan(0);
  });

  it("ignores changed schema and selector snapshots for an existing slot", () => {
    const first = existing();
    const changedSchema = existing({
      schema_id: schema("Other", "999", 3),
    });
    const changedSelector = existing({
      write_target: { group1: "IFD1", tag_name: "YResolution" },
    });

    expect(compareMetadataDraftTargetsBySlot(first, changedSchema)).toBe(0);
    expect(compareMetadataDraftTargetsBySlot(first, changedSelector)).toBe(0);
    expect(metadataDraftTargetEquals(first, changedSchema)).toBe(false);
    expect(metadataDraftTargetEquals(first, changedSelector)).toBe(false);
  });

  it("does not mutate either input", () => {
    const left = existing();
    const right = created(schema("Exif::Main", "282", 0));
    const before = structuredClone({ left, right });

    compareMetadataDraftTargetsBySlot(left, right);

    expect({ left, right }).toEqual(before);
  });
});
