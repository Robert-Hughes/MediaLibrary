import { describe, expect, it } from "vitest";
import type {
  MetadataDraftCollection,
  MetadataOccurrence,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import { resolveExistingRowDraft } from "../targetDraftView";
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
