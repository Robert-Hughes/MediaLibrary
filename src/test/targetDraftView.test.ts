import { describe, expect, it } from "vitest";
import type {
  MetadataDraftCollection,
  MetadataOccurrence,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import {
  resolveExistingRowDraft,
  resolveSupplementalOccurrenceDraft,
} from "../targetDraftView";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const schema: SchemaDefinitionId = { table: "Exif::Main", tag_id: "282" };
const occurrence: MetadataOccurrence = {
  id: { document: null, path: "JPEG-APP1-IFD0", tag_id: "282", copy: 0 },
  value: { kind: "Integer", value: 300 },
  tag_info: {
    id: schema,
    group: "IFD0",
    name: "XResolution",
    writable: true,
    kind: { kind: "Integer", data: { min: null, max: null } },
    description: null,
  },
  write_target: { group1: "IFD0", tag_name: "XResolution" },
};
const target: Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> = {
  kind: "ExistingOccurrence",
  occurrence_id: occurrence.id,
  schema_id: schema,
  write_target: occurrence.write_target!,
};

describe("existing row draft resolution", () => {
  it("prefers an exact legacy owner without converting it", () => {
    const legacy: MetadataDraftCollection = {
      [schemaDefinitionIdToken(schema)]: {
        id: schema,
        edit: { intent: "Set", value: { kind: "Integer", value: 301 } },
      },
    };
    expect(
      resolveExistingRowDraft(
        schema,
        { kind: "unique", occurrence },
        legacy,
        undefined,
      ),
    ).toMatchObject({ kind: "legacy" });
  });

  it("returns only the complete exact ExistingOccurrence target", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("a.jpg", target, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    expect(
      resolveExistingRowDraft(
        schema,
        { kind: "unique", occurrence },
        undefined,
        store.getMetadataFile("a.jpg"),
      ),
    ).toMatchObject({ kind: "target" });
  });

  it("blocks NewProperty, stale snapshots, and same-schema multiplicity", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(
      "new.jpg",
      { kind: "NewProperty", schema_id: schema },
      { intent: "Set", value: { kind: "Integer", value: 301 } },
    );
    expect(
      resolveExistingRowDraft(
        schema,
        { kind: "unique", occurrence },
        undefined,
        store.getMetadataFile("new.jpg"),
      ),
    ).toMatchObject({ kind: "blocked" });

    const stale = new TargetDraftEditsStore();
    stale.setMetadataTarget(
      "stale.jpg",
      { ...target, write_target: { group1: "IFD1", tag_name: "Changed" } },
      { intent: "Set", value: { kind: "Integer", value: 301 } },
    );
    expect(
      resolveExistingRowDraft(
        schema,
        { kind: "unique", occurrence },
        undefined,
        stale.getMetadataFile("stale.jpg"),
      ),
    ).toMatchObject({ kind: "blocked" });

    stale.setMetadataTarget(
      "stale.jpg",
      {
        ...target,
        occurrence_id: { ...target.occurrence_id, path: "JPEG-APP1-IFD1" },
      },
      { intent: "Set", value: { kind: "Integer", value: 72 } },
    );
    expect(
      resolveExistingRowDraft(
        schema,
        { kind: "unique", occurrence },
        undefined,
        stale.getMetadataFile("stale.jpg"),
      ),
    ).toMatchObject({ kind: "blocked", conflictingTargets: expect.any(Array) });
  });
});

describe("supplemental occurrence draft resolution", () => {
  const edit = {
    intent: "Set" as const,
    value: { kind: "Integer" as const, value: 301 },
  };

  function collection(...targets: MetadataDraftTarget[]) {
    const store = new TargetDraftEditsStore();
    for (const candidate of targets) {
      store.setMetadataTarget("a.jpg", candidate, edit);
    }
    return store.getMetadataFile("a.jpg");
  }

  it("returns none when no owner exists", () => {
    expect(
      resolveSupplementalOccurrenceDraft(occurrence, undefined, undefined),
    ).toEqual({ kind: "none" });
  });

  it("returns only an identical complete ExistingOccurrence target", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        undefined,
        collection(target),
      ),
    ).toMatchObject({ kind: "target", entry: { target } });
  });

  it("blocks exact legacy and NewProperty owners", () => {
    const legacy: MetadataDraftCollection = {
      [schemaDefinitionIdToken(schema)]: { id: schema, edit },
    };
    expect(
      resolveSupplementalOccurrenceDraft(occurrence, legacy, undefined),
    ).toMatchObject({ kind: "blocked" });
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        undefined,
        collection({ kind: "NewProperty", schema_id: schema }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  it("blocks a different same-schema occurrence owner", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        undefined,
        collection({
          ...target,
          occurrence_id: { ...target.occurrence_id, copy: 1 },
        }),
      ),
    ).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("Another concrete occurrence"),
    });
  });

  it("blocks changed schema and selector snapshots", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        undefined,
        collection({ ...target, schema_id: { ...schema, index: 0 } }),
      ),
    ).toMatchObject({ kind: "blocked" });
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        undefined,
        collection({
          ...target,
          write_target: { ...target.write_target, group1: "IFD1" },
        }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  it("blocks multiple same-schema target owners", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        undefined,
        collection(target, {
          ...target,
          occurrence_id: { ...target.occurrence_id, copy: 1 },
        }),
      ),
    ).toMatchObject({
      kind: "blocked",
      conflictingTargets: expect.arrayContaining([
        expect.objectContaining({ target }),
      ]),
    });
  });

  it("keeps absent schema index distinct from zero", () => {
    const indexedOccurrence: MetadataOccurrence = {
      ...occurrence,
      tag_info: {
        ...occurrence.tag_info!,
        id: { ...schema, index: 0 },
      },
    };
    const indexedTarget: Extract<
      MetadataDraftTarget,
      { kind: "ExistingOccurrence" }
    > = { ...target, schema_id: { ...schema, index: 0 } };
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        undefined,
        collection(indexedTarget),
      ),
    ).toMatchObject({ kind: "blocked" });
    expect(
      resolveSupplementalOccurrenceDraft(
        indexedOccurrence,
        undefined,
        collection(indexedTarget),
      ),
    ).toMatchObject({ kind: "target" });
  });

  it("does not mutate occurrence, legacy drafts, or target drafts", () => {
    const sourceOccurrence = structuredClone(occurrence);
    const legacy: MetadataDraftCollection = {};
    const drafts = collection(target)!;
    const beforeOccurrence = structuredClone(sourceOccurrence);
    const beforeLegacy = structuredClone(legacy);
    const beforeTargets = structuredClone(drafts);
    resolveSupplementalOccurrenceDraft(sourceOccurrence, legacy, drafts);
    expect(sourceOccurrence).toEqual(beforeOccurrence);
    expect(legacy).toEqual(beforeLegacy);
    expect(drafts).toEqual(beforeTargets);
  });
});
