import { describe, expect, it } from "vitest";
import type {
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import {
  buildSchemaValueResolutionIndex,
  resolveSchemaValue,
  resolutionOccurrenceTokens,
  schemaMetadataCollectionFromOccurrences,
} from "../utils/schemaMetadataProjection";
import { metadataGet } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const schema = (tagId = "title", index?: number): SchemaDefinitionId => ({
  table: "XMP::dc",
  tag_id: tagId,
  ...(index === undefined ? {} : { index }),
});

const text = (value: string): MetadataValue => ({ kind: "Text", value });

function occurrence(
  id: SchemaDefinitionId,
  value: MetadataValue,
  options: { path?: string; copy?: number } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: options.path ?? `XMP-${options.copy ?? 0}`,
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(id),
    value: structuredClone(value),
    tag_info: null,
    write_target: null,
  };
}

function valueFor(
  occurrences: MetadataOccurrence[],
  id: SchemaDefinitionId,
): MetadataValue | undefined {
  const entry = metadataGet(
    schemaMetadataCollectionFromOccurrences(occurrences),
    id,
  );
  if (!entry) return undefined;
  const { id: _id, ...value } = entry;
  return value as MetadataValue;
}

describe("schemaMetadataProjection", () => {
  it("projects a unique occurrence without mutating input", () => {
    const id = schema();
    const input = [occurrence(id, text("hello"))];
    const snapshot = structuredClone(input);

    expect(valueFor(input, id)).toEqual(text("hello"));
    expect(resolveSchemaValue(input, id)).toMatchObject({
      kind: "value",
      source: "single",
      value: text("hello"),
    });
    expect(input).toEqual(snapshot);
  });

  it("collapses identical ordinary values deterministically", () => {
    const id = schema();
    const first = occurrence(id, text("same"), { path: "B", copy: 2 });
    const second = occurrence(id, text("same"), { path: "A", copy: 0 });

    const forward = resolveSchemaValue([first, second], id);
    const reversed = resolveSchemaValue([second, first], id);

    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({
      kind: "value",
      source: "identical",
      value: text("same"),
    });
    expect(resolutionOccurrenceTokens(forward)).toEqual([
      '[null,"A","title",["TestFixture::Runtime","title",null],0]',
      '[null,"B","title",["TestFixture::Runtime","title",null],2]',
    ]);
  });

  it("omits conflicting ordinary values with complete occurrence evidence", () => {
    const id = schema();
    const resolution = resolveSchemaValue(
      [
        occurrence(id, text("first"), { path: "IFD0" }),
        occurrence(id, text("second"), { path: "IFD1", copy: 1 }),
      ],
      id,
    );

    expect(resolution).toMatchObject({
      kind: "ambiguous",
      reason: "Schema occurrences contain different wire values.",
    });
    expect(resolutionOccurrenceTokens(resolution)).toHaveLength(2);
    expect(
      metadataGet(
        schemaMetadataCollectionFromOccurrences([
          occurrence(id, text("first"), { path: "IFD0" }),
          occurrence(id, text("second"), { path: "IFD1", copy: 1 }),
        ]),
        id,
      ),
    ).toBeUndefined();
  });

  it("merges compatible LangAlt values and rejects conflicts or mixed kinds", () => {
    const id = schema();
    const lang = (path: string, value: Record<string, string>) =>
      occurrence(id, { kind: "LangAlt", value }, { path });

    expect(
      valueFor(
        [lang("fr", { fr: "Bonjour" }), lang("en", { en: "Hello" })],
        id,
      ),
    ).toEqual({
      kind: "LangAlt",
      value: { en: "Hello", fr: "Bonjour" },
    });
    expect(
      resolveSchemaValue(
        [lang("a", { en: "Hello" }), lang("b", { en: "Hello" })],
        id,
      ),
    ).toMatchObject({ kind: "value", source: "lang-alt" });
    expect(
      resolveSchemaValue(
        [lang("a", { en: "Hello" }), lang("b", { en: "Different" })],
        id,
      ),
    ).toMatchObject({
      kind: "ambiguous",
      reason: "LangAlt language 'en' has conflicting text.",
    });
    expect(
      resolveSchemaValue(
        [
          lang("a", { en: "Hello" }),
          occurrence(id, text("ordinary"), { path: "parent" }),
        ],
        id,
      ),
    ).toMatchObject({
      kind: "ambiguous",
      reason: "Schema occurrences mix ordinary and LangAlt values.",
    });
  });

  it("keeps absent index and index zero as separate schema identities", () => {
    const absent = schema("title");
    const zero = schema("title", 0);
    const index = buildSchemaValueResolutionIndex([
      occurrence(absent, text("absent"), { path: "A" }),
      occurrence(zero, text("zero"), { path: "B" }),
    ]);

    expect(index.size).toBe(2);
    expect(index.get(schemaDefinitionIdToken(absent))).toMatchObject({
      kind: "value",
      value: text("absent"),
    });
    expect(index.get(schemaDefinitionIdToken(zero))).toMatchObject({
      kind: "value",
      value: text("zero"),
    });
  });

  it("uses structural wire equality for Unknown raw objects", () => {
    const id = schema("unknown");
    const unknown = (path: string, raw: Record<string, unknown>) =>
      occurrence(
        id,
        { kind: "Unknown", value: { expected: null, raw, reason: null } },
        { path },
      );

    expect(
      resolveSchemaValue(
        [unknown("A", { a: 1, b: 2 }), unknown("B", { b: 2, a: 1 })],
        id,
      ),
    ).toMatchObject({ kind: "value", source: "identical" });
    expect(
      resolveSchemaValue([unknown("A", { a: 1 }), unknown("B", { a: 2 })], id),
    ).toMatchObject({ kind: "ambiguous" });
  });
});
