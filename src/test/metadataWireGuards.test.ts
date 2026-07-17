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
  isMetadataOccurrence,
  isMetadataOccurrenceId,
  isJsonValue,
  isMetadataValue,
  isMetadataWriteTarget,
  isSchemaDefinitionId,
  metadataOccurrenceSchemaIdentityError,
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

describe("metadata occurrence wire guard", () => {
  const validOccurrence = () => ({
    id: existing().occurrence_id,
    schema_id: schema(),
    value: { kind: "Integer", value: 300 },
    tag_info: {
      id: schema(),
      group: "IFD0",
      name: "XResolution",
      writable: true,
      kind: { kind: "Integer", data: { min: null, max: null } },
      description: null,
    },
    write_target: { group1: "IFD0", tag_name: "XResolution" },
  });

  it("requires exactly the complete transient occurrence shape", () => {
    const value = validOccurrence();
    expect(isMetadataOccurrence(value)).toBe(true);
    const { schema_id: _missing, ...withoutSchema } = value;
    expect(isMetadataOccurrence(withoutSchema)).toBe(false);
    expect(isMetadataOccurrence({ ...value, schema_id: { table: 1 } })).toBe(
      false,
    );
    expect(isMetadataOccurrence({ ...value, extra: true })).toBe(false);
  });

  it("rejects conflicting TagInfo and reports the occurrence and both schema IDs", () => {
    const value = {
      ...validOccurrence(),
      tag_info: {
        ...validOccurrence().tag_info,
        id: { table: "Exif::Other", tag_id: "282", index: 0 },
      },
    };
    expect(isMetadataOccurrence(value)).toBe(false);
    expect(metadataOccurrenceSchemaIdentityError(value)).toEqual(
      expect.stringMatching(
        /JPEG-APP1-IFD0.*Exif::Main \/ 282.*Exif::Other \/ 282 \/ index 0/,
      ),
    );
  });

  it("accepts unresolved occurrences and duplicate schemas with distinct occurrence IDs", () => {
    const unresolved = {
      ...validOccurrence(),
      tag_info: null,
      write_target: null,
    };
    const sibling = {
      ...unresolved,
      id: { ...unresolved.id, path: "JPEG-APP1-IFD1", copy: 2 },
    };
    expect(isMetadataOccurrence(unresolved)).toBe(true);
    expect(isMetadataOccurrence(sibling)).toBe(true);
    expect(unresolved.schema_id).toEqual(sibling.schema_id);
    expect(unresolved.id).not.toEqual(sibling.id);
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

  it("distinguishes integer values from finite real values", () => {
    expect(isMetadataValue({ kind: "Integer", value: 1 })).toBe(true);
    expect(isMetadataValue({ kind: "Integer", value: -1 })).toBe(true);
    expect(isMetadataValue({ kind: "Integer", value: 1.5 })).toBe(false);
    expect(isMetadataValue({ kind: "Integer", value: Number.NaN })).toBe(false);
    expect(
      isMetadataValue({ kind: "Integer", value: Number.POSITIVE_INFINITY }),
    ).toBe(false);
    expect(isMetadataValue({ kind: "Real", value: 1.5 })).toBe(true);
  });

  it("requires exact unit-variant shapes", () => {
    expect(isMetadataValue({ kind: "Null" })).toBe(true);
    expect(isMetadataValue({ kind: "Binary" })).toBe(true);
    expect(isMetadataValue({ kind: "Null", value: "unexpected" })).toBe(false);
    expect(isMetadataValue({ kind: "Binary", value: {} })).toBe(false);
    expect(isMetadataValue({ kind: "Null", value: undefined })).toBe(false);
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

describe("recursive JSON-value wire guard", () => {
  it("accepts recursively JSON-compatible values", () => {
    for (const value of [
      null,
      true,
      12.5,
      "text",
      [null, false, 1, "nested", { deeper: [2] }],
      { nested: { array: ["value", 3] } },
    ]) {
      expect(isJsonValue(value)).toBe(true);
    }
  });

  it("rejects invalid primitive and nested values", () => {
    for (const value of [
      undefined,
      () => undefined,
      Symbol("invalid"),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      ["valid", undefined],
      { nested: { invalid: 1n } },
    ]) {
      expect(isJsonValue(value)).toBe(false);
    }
  });

  it("rejects cyclic objects without traversing prototypes", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);

    const inheritedInvalid = Object.create({ ignored: undefined }) as Record<
      string,
      unknown
    >;
    inheritedInvalid.own = "valid";
    expect(isJsonValue(inheritedInvalid)).toBe(true);
  });

  it("uses the JSON guard for Unknown.raw", () => {
    const unknown = (raw: unknown) => ({
      kind: "Unknown",
      value: { raw, expected: null, reason: null },
    });

    expect(isMetadataValue(unknown({ nested: [null, 1, "value"] }))).toBe(true);
    expect(isMetadataValue(unknown({ nested: undefined }))).toBe(false);
    expect(isMetadataValue(unknown(["valid", Number.NaN]))).toBe(false);
    expect(
      isMetadataValue({
        kind: "Unknown",
        value: { expected: null, reason: null },
      }),
    ).toBe(false);
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
