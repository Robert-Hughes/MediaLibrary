import { describe, expect, it } from "vitest";
import type {
  MetadataOccurrence,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import {
  buildSchemaDraftDisplayProjection,
  resolveExistingRowDraft,
  resolveSchemaDraftForPresentation,
  resolveSupplementalOccurrenceDraft,
} from "../targetDraftView";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
const schema: SchemaDefinitionId = { table: "Exif::Main", tag_id: "282" };
const occurrence: MetadataOccurrence = {
  id: {
    document: null,
    path: "JPEG-APP1-IFD0",
    runtime_tag_id: "282",
    tag_id_scope: { table: "TestFixture::Runtime", tag_id: "282", index: null },
    copy: 0,
  },
  schema_id: structuredClone(schema),
  value: { kind: "Integer", value: 300 },
  tag_info: {
    id: schema,
    group: "IFD0",
    name: "XResolution",
    writable: true,
    kind: { kind: "Integer", data: { min: null, max: null } },
    description: null,
  },
  write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "XResolution" },
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
      {
        kind: "NewProperty",
        schema_id: schema,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
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
      {
        ...target,
        write_target: {
          group1: "IFD1",
          group7: "ID-Test",
          tag_name: "Changed",
        },
      },
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
        collection({
          kind: "NewProperty",
          schema_id: schema,
          write_target: {
            group1: "XMP-test",
            group7: "ID-Test",
            tag_name: "TestTag",
          },
        }),
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
      schema_id: { ...schema, index: 0 },
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

describe("schema-keyed target draft presentation", () => {
  const token = schemaDefinitionIdToken(schema);
  const pending = {
    intent: "Set" as const,
    value: { kind: "Integer" as const, value: 301 },
  };
  const siblingOccurrence: MetadataOccurrence = {
    ...occurrence,
    id: { ...occurrence.id, path: "JPEG-APP1-IFD1", copy: 1 },
    value: { kind: "Integer", value: 72 },
    tag_info: { ...occurrence.tag_info!, group: "IFD1" },
    write_target: {
      group1: "IFD1",
      group7: "ID-Test",
      tag_name: "XResolution",
    },
  };
  const siblingTarget: Extract<
    MetadataDraftTarget,
    { kind: "ExistingOccurrence" }
  > = {
    kind: "ExistingOccurrence",
    occurrence_id: siblingOccurrence.id,
    schema_id: schema,
    write_target: siblingOccurrence.write_target!,
  };

  function draftsInOrder(...orderedTargets: MetadataDraftTarget[]) {
    const store = new TargetDraftEditsStore();
    for (const candidate of orderedTargets) {
      store.setMetadataTarget("a.jpg", candidate, pending);
    }
    return store.getMetadataFile("a.jpg");
  }

  it("returns no display draft for an empty exact-target collection", () => {
    expect(
      buildSchemaDraftDisplayProjection({
        occurrences: [],
        targetDrafts: {},
      }),
    ).toEqual({});
  });

  it("presents one safe NewProperty target", () => {
    const drafts = draftsInOrder({
      kind: "NewProperty",
      schema_id: schema,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    });
    const projection = buildSchemaDraftDisplayProjection({
      occurrences: [],
      targetDrafts: drafts,
    });
    expect(projection[token]?.edit).toEqual(pending);
  });

  it("presents one safe ExistingOccurrence target", () => {
    const projection = buildSchemaDraftDisplayProjection({
      occurrences: [occurrence],
      targetDrafts: draftsInOrder(target),
    });
    expect(projection[token]?.edit).toEqual(pending);
  });

  it("retains two same-schema exact targets but presents neither", () => {
    const drafts = draftsInOrder(target, siblingTarget)!;
    expect(Object.keys(drafts)).toHaveLength(2);
    expect(
      buildSchemaDraftDisplayProjection({
        occurrences: [occurrence, siblingOccurrence],
        targetDrafts: drafts,
      }),
    ).toEqual({});
  });

  it("is independent of same-schema target insertion order", () => {
    const forward = buildSchemaDraftDisplayProjection({
      occurrences: [occurrence, siblingOccurrence],
      targetDrafts: draftsInOrder(target, siblingTarget),
    });
    const reverse = buildSchemaDraftDisplayProjection({
      occurrences: [occurrence, siblingOccurrence],
      targetDrafts: draftsInOrder(siblingTarget, target),
    });
    expect(forward).toEqual({});
    expect(reverse).toEqual(forward);
  });

  it("does not present a stale selector snapshot", () => {
    const stale = {
      ...target,
      write_target: { ...target.write_target, group1: "IFD1" },
    };
    expect(
      buildSchemaDraftDisplayProjection({
        occurrences: [occurrence],
        targetDrafts: draftsInOrder(stale),
      }),
    ).toEqual({});
  });

  it("does not present a missing or duplicated exact occurrence", () => {
    const missing = resolveSchemaDraftForPresentation({
      schemaId: schema,
      occurrences: [],
      targetDrafts: draftsInOrder(target),
    });
    expect(missing).toMatchObject({ kind: "blocked" });

    const otherSchema = { ...schema, table: "Exif::Other" };
    const duplicateExactId: MetadataOccurrence = {
      ...occurrence,
      tag_info: { ...occurrence.tag_info!, id: otherSchema },
    };
    const duplicated = resolveSchemaDraftForPresentation({
      schemaId: schema,
      occurrences: [occurrence, duplicateExactId],
      targetDrafts: draftsInOrder(target),
    });
    expect(duplicated).toMatchObject({
      kind: "blocked",
      reason: "The exact occurrence ID is duplicated.",
    });
  });

  it("does not present an unverified target while occurrences are loading", () => {
    expect(
      buildSchemaDraftDisplayProjection({
        occurrences: "loading",
        targetDrafts: draftsInOrder(target),
      }),
    ).toEqual({});
  });
  it("returns detached display-projection snapshots", () => {
    const drafts = draftsInOrder({
      kind: "NewProperty",
      schema_id: schema,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    })!;
    const beforeDrafts = structuredClone(drafts);
    const projection = buildSchemaDraftDisplayProjection({
      occurrences: [],
      targetDrafts: drafts,
    });

    projection[token].id.table = "Mutated";
    if (projection[token].edit.value?.kind === "Integer") {
      projection[token].edit.value.value = 999;
    }

    expect(drafts).toEqual(beforeDrafts);
    expect(drafts[Object.keys(drafts)[0]].target.schema_id.table).toBe(
      "Exif::Main",
    );
  });

  it("does not present a NewProperty target over an authoritative occurrence", () => {
    expect(
      buildSchemaDraftDisplayProjection({
        occurrences: [occurrence],
        targetDrafts: draftsInOrder({
          kind: "NewProperty",
          schema_id: schema,
          write_target: {
            group1: "XMP-test",
            group7: "ID-Test",
            tag_name: "TestTag",
          },
        }),
      }),
    ).toEqual({});
  });
});
