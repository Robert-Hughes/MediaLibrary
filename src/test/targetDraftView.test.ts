import { describe, expect, it } from "vitest";
import type {
  MetadataOccurrence,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import {
  resolveExistingRowDraft,
  resolveSupplementalOccurrenceDraft,
} from "../targetDraftView";

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
    expect(resolveSupplementalOccurrenceDraft(occurrence, undefined)).toEqual({
      kind: "none",
    });
  });

  it("returns only an identical complete ExistingOccurrence target", () => {
    expect(
      resolveSupplementalOccurrenceDraft(occurrence, collection(target)),
    ).toMatchObject({ kind: "target", entry: { target } });
  });

  it("keeps a NewProperty owner separate from an exact occurrence", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        collection({ kind: "NewProperty", schema_id: schema }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("keeps a different same-schema occurrence owner separate", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        collection({
          ...target,
          occurrence_id: { ...target.occurrence_id, copy: 1 },
        }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("blocks changed schema and selector snapshots", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        collection({ ...target, schema_id: { ...schema, index: 0 } }),
      ),
    ).toMatchObject({ kind: "blocked" });
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        collection({
          ...target,
          write_target: { ...target.write_target, group1: "IFD1" },
        }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  it("selects only the exact owner among same-schema siblings", () => {
    expect(
      resolveSupplementalOccurrenceDraft(
        occurrence,
        collection(target, {
          ...target,
          occurrence_id: { ...target.occurrence_id, copy: 1 },
        }),
      ),
    ).toMatchObject({ kind: "target", entry: { target } });
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
      resolveSupplementalOccurrenceDraft(occurrence, collection(indexedTarget)),
    ).toMatchObject({ kind: "blocked" });
    expect(
      resolveSupplementalOccurrenceDraft(
        indexedOccurrence,
        collection(indexedTarget),
      ),
    ).toMatchObject({ kind: "target" });
  });

  it("does not mutate occurrence or target drafts", () => {
    const sourceOccurrence = structuredClone(occurrence);
    const drafts = collection(target)!;
    const beforeOccurrence = structuredClone(sourceOccurrence);
    const beforeTargets = structuredClone(drafts);
    resolveSupplementalOccurrenceDraft(sourceOccurrence, drafts);
    expect(sourceOccurrence).toEqual(beforeOccurrence);
    expect(drafts).toEqual(beforeTargets);
  });
});
