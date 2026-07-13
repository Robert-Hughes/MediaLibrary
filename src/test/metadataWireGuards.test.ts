import { describe, expect, it } from "vitest";
import type {
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import { targetDraftsFromUnknownWire } from "../targetDraftEdits";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import {
  isMetadataDraftEdit,
  isMetadataDraftEntryV5,
  isMetadataDraftTarget,
  isMetadataOccurrenceId,
  isMetadataValue,
  isMetadataWriteTarget,
  isSchemaDefinitionId,
} from "../utils/metadataWireGuards";

const schema = (index?: number): SchemaDefinitionId => ({
  table: "Exif::Main",
  tag_id: "282",
  ...(index === undefined ? {} : { index }),
});

const existing = (): Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
> => ({
  kind: "ExistingOccurrence",
  occurrence_id: {
    document: null,
    path: "JPEG-APP1-IFD0",
    tag_id: "282",
    copy: 0,
  },
  schema_id: schema(),
  write_target: { group1: "IFD0", tag_name: "XResolution" },
});

const created = (): Extract<MetadataDraftTarget, { kind: "NewProperty" }> => ({
  kind: "NewProperty",
  schema_id: schema(),
});

const edit = (overrides: Record<string, unknown> = {}): MetadataDraftEdit =>
  ({
    intent: "Set",
    value: { kind: "Text", value: "value" },
    ...overrides,
  }) as MetadataDraftEdit;

const entry = (
  target: MetadataDraftTarget = existing(),
): MetadataDraftEntryV5 => ({ target, edit: edit() });

describe("metadata identity wire guards", () => {
  it("accepts valid identities and write targets", () => {
    expect(isSchemaDefinitionId(schema())).toBe(true);
    expect(isSchemaDefinitionId({ ...schema(), index: null })).toBe(true);
    expect(isMetadataOccurrenceId(existing().occurrence_id)).toBe(true);
    expect(isMetadataWriteTarget(existing().write_target)).toBe(true);
  });

  it("rejects invalid occurrence fields and u32 copies", () => {
    const id = existing().occurrence_id;
    for (const invalid of [
      { ...id, document: 1 },
      { ...id, path: null },
      { ...id, copy: -1 },
      { ...id, copy: 1.5 },
      { ...id, copy: 0x1_0000_0000 },
    ]) {
      expect(isMetadataOccurrenceId(invalid)).toBe(false);
    }
  });

  it("rejects invalid schema indexes and write targets", () => {
    expect(isSchemaDefinitionId({ ...schema(), index: -1 })).toBe(false);
    expect(isSchemaDefinitionId({ ...schema(), index: 1.5 })).toBe(false);
    expect(isSchemaDefinitionId({ ...schema(), index: 0x1_0000_0000 })).toBe(
      false,
    );
    expect(isMetadataWriteTarget({ group1: "IFD0" })).toBe(false);
    expect(isMetadataWriteTarget({ group1: 1, tag_name: "XResolution" })).toBe(
      false,
    );
  });
});

describe("schema-v5 target and edit wire guards", () => {
  it("accepts complete existing and new-property targets", () => {
    expect(isMetadataDraftTarget(existing())).toBe(true);
    expect(isMetadataDraftTarget(created())).toBe(true);
  });

  it("does not infer missing or unknown target kinds", () => {
    expect(isMetadataDraftTarget({ schema_id: schema() })).toBe(false);
    expect(isMetadataDraftTarget({ kind: "Other", schema_id: schema() })).toBe(
      false,
    );
  });

  it("rejects incomplete existing targets", () => {
    const target = existing();
    expect(
      isMetadataDraftTarget({
        ...target,
        occurrence_id: { ...target.occurrence_id, path: 1 },
      }),
    ).toBe(false);
    expect(isMetadataDraftTarget({ ...target, write_target: {} })).toBe(false);
  });

  it("accepts every edit intent, null values, and optional string display", () => {
    for (const intent of ["Set", "Delete", "ListAdd", "ListRemove"]) {
      expect(isMetadataDraftEdit({ intent, value: null })).toBe(true);
      expect(
        isMetadataDraftEdit({ intent, value: null, display: "label" }),
      ).toBe(true);
    }
  });

  it("accepts nested semantic values through the shared validator", () => {
    const value = {
      kind: "Struct",
      value: {
        nested: {
          kind: "List",
          value: {
            list_kind: "Seq",
            items: [
              { kind: "Rational", value: { numerator: 1, denominator: 2 } },
            ],
          },
        },
      },
    };
    expect(isMetadataValue(value)).toBe(true);
    expect(isMetadataDraftEdit({ intent: "Set", value })).toBe(true);
  });

  it("rejects invalid intents, values, displays, and missing values", () => {
    expect(isMetadataDraftEdit({ intent: "Replace", value: null })).toBe(false);
    expect(
      isMetadataDraftEdit({
        intent: "Set",
        value: { kind: "Rational", value: { numerator: 1, denominator: 0 } },
      }),
    ).toBe(false);
    expect(
      isMetadataDraftEdit({ intent: "Set", value: null, display: 1 }),
    ).toBe(false);
    expect(isMetadataDraftEdit({ intent: "Set" })).toBe(false);
  });

  it("requires both a valid target and edit for entries", () => {
    expect(isMetadataDraftEntryV5(entry())).toBe(true);
    expect(isMetadataDraftEntryV5({ target: existing(), edit: {} })).toBe(
      false,
    );
    expect(isMetadataDraftEntryV5({ target: {}, edit: edit() })).toBe(false);
  });
});

describe("targetDraftsFromUnknownWire", () => {
  it("rejects malformed top-level and per-file values", () => {
    for (const raw of [null, [], "wire", 1]) {
      expect(() => targetDraftsFromUnknownWire(raw)).toThrow(
        /expected an object/,
      );
    }
    expect(() => targetDraftsFromUnknownWire({ "photo.jpg": {} })).toThrow(
      /photo\.jpg.*expected an array/,
    );
  });

  it("reports the path and index of an invalid entry", () => {
    expect(() =>
      targetDraftsFromUnknownWire({
        "folder/photo.jpg": [entry(), { target: existing(), edit: {} }],
      }),
    ).toThrow(/folder\/photo\.jpg.*array index 1/);
  });

  it("rejects one bad sibling without returning a partial collection", () => {
    const raw = {
      "valid.jpg": [entry()],
      "bad.jpg": [{ target: created(), edit: { intent: "Set", value: 4 } }],
    };
    expect(() => targetDraftsFromUnknownWire(raw)).toThrow(/bad\.jpg/);
  });

  it("delegates duplicate logical-slot rejection to the typed converter", () => {
    const target = existing();
    expect(() =>
      targetDraftsFromUnknownWire({
        "duplicate.jpg": [entry(target), entry(structuredClone(target))],
      }),
    ).toThrow(/Duplicate target draft slot/);
  });

  it("loads empty objects and omits empty file arrays", () => {
    expect(targetDraftsFromUnknownWire({})).toEqual({});
    expect(targetDraftsFromUnknownWire({ "empty.jpg": [] })).toEqual({});
  });

  it("creates a correctly keyed target-aware collection", () => {
    const target = existing();
    const loaded = targetDraftsFromUnknownWire({
      "photo.jpg": [entry(target)],
    });
    expect(loaded["photo.jpg"][metadataDraftTargetSlotToken(target)]).toEqual(
      entry(target),
    );
  });
});
