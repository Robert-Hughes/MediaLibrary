import { describe, expect, it } from "vitest";
import type {
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import {
  existingOccurrenceDraftTarget,
  existingOccurrenceTargetFromOccurrence,
  newPropertyDraftTarget,
} from "../utils/metadataDraftTarget";
import { tagInfoSupportsMetadataWrite } from "../utils/metadataWriteSupport";

const id: SchemaDefinitionId = { table: "Test::Main", tag_id: "1" };

function info(kind: TagKind, writable = true): TagInfo {
  return {
    id: structuredClone(id),
    group: "Test",
    name: "Field",
    writable,
    kind,
    description: null,
    storage_count: undefined,
  };
}

function occurrence(kind: TagKind): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: "Test",
      runtime_tag_id: "1",
      tag_id_scope: { table: "TestFixture::Runtime", tag_id: "1", index: null },
      copy: 0,
    },
    schema_id: structuredClone(id),
    value: { kind: "Text", value: "value" },
    tag_info: info(kind),
    write_target: { group1: "Test", tag_name: "Field" },
  };
}

describe("metadata write-kind support", () => {
  const supportedKinds: TagKind[] = [
    { kind: "Text" },
    { kind: "LangAlt" },
    { kind: "Integer", data: { min: null, max: null } },
    { kind: "Real" },
    { kind: "Rational" },
    { kind: "Boolean" },
    { kind: "Date" },
    { kind: "Time" },
    { kind: "DateTime" },
    { kind: "TimeOffset" },
    { kind: "Enum", data: { repr: "String", options: [] } },
    { kind: "Bag", data: { kind: "Text" } },
    { kind: "Seq", data: { kind: "Text" } },
    { kind: "Alt", data: { kind: "Text" } },
    { kind: "Struct", data: {} },
  ];

  it.each(supportedKinds)("supports writable $kind schemas", (kind) => {
    expect(tagInfoSupportsMetadataWrite(info(kind))).toBe(true);
  });

  it.each([{ kind: "Binary" }, { kind: "Unknown" }] satisfies TagKind[])(
    "rejects manually writable $kind schemas at every target boundary",
    (kind) => {
      const tagInfo = info(kind);
      const current = occurrence(kind);

      expect(tagInfoSupportsMetadataWrite(tagInfo)).toBe(false);
      expect(existingOccurrenceTargetFromOccurrence(current)).toMatchObject({
        kind: "read-only",
        reason: expect.stringContaining("unsupported"),
      });
      expect(existingOccurrenceDraftTarget(current)).toEqual({
        kind: "unavailable",
        reason: "unsupported_schema_kind",
      });
      expect(newPropertyDraftTarget(tagInfo)).toEqual({
        kind: "unavailable",
        reason: "unsupported_schema_kind",
      });
    },
  );

  it("rejects read-only schemas independently of kind support", () => {
    expect(tagInfoSupportsMetadataWrite(info({ kind: "Text" }, false))).toBe(
      false,
    );
    expect(newPropertyDraftTarget(info({ kind: "Text" }, false))).toEqual({
      kind: "unavailable",
      reason: "read_only_schema",
    });
  });
});
