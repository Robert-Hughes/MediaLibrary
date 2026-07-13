import { describe, expect, it } from "vitest";
import type {
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataWriteTarget,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  existingOccurrenceDraftTarget,
  metadataDraftTargetEquals,
  metadataDraftTargetSchemaId,
  metadataDraftTargetToken,
  newPropertyDraftTarget,
} from "../utils/metadataDraftTarget";

const schemaId = (index?: number): SchemaDefinitionId => ({
  table: "Exif::Main",
  tag_id: "282",
  ...(index === undefined ? {} : { index }),
});

const tagInfo = (
  writable = true,
  id: SchemaDefinitionId = schemaId(),
): TagInfo => ({
  id,
  group: "SchemaGroupMustNotBecomeTarget",
  name: "FriendlyNameMustNotBecomeTarget",
  writable,
  kind: { kind: "Rational" },
  description: null,
});

const occurrenceId = (
  overrides: Partial<MetadataOccurrenceId> = {},
): MetadataOccurrenceId => ({
  document: null,
  path: "JPEG-APP1-IFD0",
  tag_id: "282",
  copy: 0,
  ...overrides,
});

const writeTarget = (
  overrides: Partial<MetadataWriteTarget> = {},
): MetadataWriteTarget => ({
  group1: "IFD0",
  tag_name: "XResolution",
  ...overrides,
});

const occurrence = (
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence => ({
  id: occurrenceId(),
  value: { kind: "Integer", value: 300 },
  tag_info: tagInfo(),
  write_target: writeTarget(),
  ...overrides,
});

function availableExisting(
  value: MetadataOccurrence = occurrence(),
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> {
  const resolution = existingOccurrenceDraftTarget(value);
  expect(resolution.kind).toBe("available");
  if (resolution.kind !== "available") throw new Error("target unavailable");
  return resolution.target;
}

function availableNew(
  info: TagInfo = tagInfo(),
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> {
  const resolution = newPropertyDraftTarget(info);
  expect(resolution.kind).toBe("available");
  if (resolution.kind !== "available") throw new Error("target unavailable");
  return resolution.target;
}

describe("metadata draft target construction", () => {
  it("constructs an existing target with every original exact domain ID", () => {
    const source = occurrence({
      id: occurrenceId({ document: "Doc1", copy: 2 }),
      tag_info: tagInfo(true, schemaId(0)),
      write_target: writeTarget({ group1: "IFD1" }),
    });

    const target = availableExisting(source);
    expect(target).toEqual({
      kind: "ExistingOccurrence",
      occurrence_id: source.id,
      schema_id: source.tag_info!.id,
      write_target: source.write_target,
    });
    expect(target.occurrence_id).not.toBe(source.id);
    expect(target.schema_id).not.toBe(source.tag_info!.id);
    expect(target.write_target).not.toBe(source.write_target);
  });

  it("rejects an unknown-schema occurrence", () => {
    expect(
      existingOccurrenceDraftTarget(occurrence({ tag_info: null })),
    ).toEqual({ kind: "unavailable", reason: "unknown_schema" });
  });

  it("rejects a read-only existing occurrence", () => {
    expect(
      existingOccurrenceDraftTarget(occurrence({ tag_info: tagInfo(false) })),
    ).toEqual({ kind: "unavailable", reason: "read_only_schema" });
  });

  it("rejects an existing occurrence without an exact write target", () => {
    expect(
      existingOccurrenceDraftTarget(occurrence({ write_target: null })),
    ).toEqual({ kind: "unavailable", reason: "missing_write_target" });
  });

  it("constructs a new property from only the exact writable schema", () => {
    const info = tagInfo(true, schemaId(0));
    expect(newPropertyDraftTarget(info)).toEqual({
      kind: "available",
      target: { kind: "NewProperty", schema_id: info.id },
    });
  });

  it("rejects a read-only new property", () => {
    expect(newPropertyDraftTarget(tagInfo(false))).toEqual({
      kind: "unavailable",
      reason: "read_only_schema",
    });
  });

  it("does not mutate or retain mutable nested source objects", () => {
    const source = occurrence({ tag_info: tagInfo(true, schemaId(3)) });
    const before = structuredClone(source);
    const target = availableExisting(source);
    target.occurrence_id.path = "changed target path";
    target.schema_id.table = "changed target table";
    target.write_target.group1 = "changed target group";

    expect(source).toEqual(before);
  });
});

describe("metadata draft target access and identity helpers", () => {
  it("returns the exact schema object for both variants", () => {
    const existing = availableExisting();
    const created = availableNew(tagInfo(true, schemaId(0)));

    expect(metadataDraftTargetSchemaId(existing)).toBe(existing.schema_id);
    expect(metadataDraftTargetSchemaId(created)).toBe(created.schema_id);
  });

  it("compares identical targets equally", () => {
    const target = availableExisting();
    expect(metadataDraftTargetEquals(target, structuredClone(target))).toBe(
      true,
    );
  });

  it("distinguishes occurrence paths and copy numbers", () => {
    const base = availableExisting();
    const differentPath = availableExisting(
      occurrence({ id: occurrenceId({ path: "JPEG-APP1-IFD1" }) }),
    );
    const differentCopy = availableExisting(
      occurrence({ id: occurrenceId({ copy: 2 }) }),
    );

    expect(metadataDraftTargetEquals(base, differentPath)).toBe(false);
    expect(metadataDraftTargetEquals(base, differentCopy)).toBe(false);
  });

  it("distinguishes schema indexes", () => {
    const absent = availableNew(tagInfo(true, schemaId()));
    const zero = availableNew(tagInfo(true, schemaId(0)));
    expect(metadataDraftTargetEquals(absent, zero)).toBe(false);
  });

  it("distinguishes family-1 groups and exact write tag names", () => {
    const base = availableExisting();
    const group = availableExisting(
      occurrence({ write_target: writeTarget({ group1: "IFD1" }) }),
    );
    const name = availableExisting(
      occurrence({ write_target: writeTarget({ tag_name: "YResolution" }) }),
    );

    expect(metadataDraftTargetEquals(base, group)).toBe(false);
    expect(metadataDraftTargetEquals(base, name)).toBe(false);
  });

  it("never compares existing and new variants equally", () => {
    expect(metadataDraftTargetEquals(availableExisting(), availableNew())).toBe(
      false,
    );
  });

  it("produces stable structured tokens for both variants", () => {
    const existing = availableExisting();
    const created = availableNew();

    expect(metadataDraftTargetToken(existing)).toBe(
      metadataDraftTargetToken(structuredClone(existing)),
    );
    expect(metadataDraftTargetToken(created)).toBe(
      metadataDraftTargetToken(structuredClone(created)),
    );
    expect(JSON.parse(metadataDraftTargetToken(existing))).toEqual([
      "ExistingOccurrence",
      [null, "JPEG-APP1-IFD0", "282", 0],
      ["Exif::Main", "282", null],
      ["IFD0", "XResolution"],
    ]);
    expect(JSON.parse(metadataDraftTargetToken(created))).toEqual([
      "NewProperty",
      ["Exif::Main", "282", null],
    ]);
    expect(metadataDraftTargetToken(existing)).not.toBe(
      metadataDraftTargetToken(created),
    );
  });

  it("does not collide on delimiter-like values", () => {
    const left = availableNew(
      tagInfo(true, { table: "A:B", tag_id: "C", index: 1 }),
    );
    const right = availableNew(
      tagInfo(true, { table: "A", tag_id: "B:C", index: 1 }),
    );
    expect(metadataDraftTargetToken(left)).not.toBe(
      metadataDraftTargetToken(right),
    );
  });

  it("keeps non-BMP and control-character strings unambiguous", () => {
    const left = availableExisting(
      occurrence({
        id: occurrenceId({ path: "\u{1f4f7}\u0000/path", tag_id: "tag\nname" }),
      }),
    );
    const right = availableExisting(
      occurrence({
        id: occurrenceId({
          path: "\u{1f4f7}",
          tag_id: "\u0000/path/tag\nname",
        }),
      }),
    );
    expect(metadataDraftTargetToken(left)).not.toBe(
      metadataDraftTargetToken(right),
    );
    expect(JSON.parse(metadataDraftTargetToken(left))[1]).toEqual([
      null,
      "\u{1f4f7}\u0000/path",
      "tag\nname",
      0,
    ]);
  });

  it("normalises absent, undefined, and null indexes apart from index zero", () => {
    const absent = availableNew(tagInfo(true, schemaId()));
    const explicitUndefined = availableNew(
      tagInfo(true, {
        table: "Exif::Main",
        tag_id: "282",
        index: undefined,
      }),
    );
    const explicitNull = availableNew(
      tagInfo(true, {
        table: "Exif::Main",
        tag_id: "282",
        index: null,
      } as unknown as SchemaDefinitionId),
    );
    const zero = availableNew(tagInfo(true, schemaId(0)));

    expect(metadataDraftTargetToken(absent)).toBe(
      metadataDraftTargetToken(explicitUndefined),
    );
    expect(metadataDraftTargetToken(absent)).toBe(
      metadataDraftTargetToken(explicitNull),
    );
    expect(metadataDraftTargetToken(absent)).not.toBe(
      metadataDraftTargetToken(zero),
    );
    expect(metadataDraftTargetEquals(absent, explicitNull)).toBe(true);
    expect(metadataDraftTargetEquals(absent, zero)).toBe(false);
  });
});
