import { describe, expect, it } from "vitest";
import type {
  MetadataOccurrence,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import {
  buildSchemaDraftDisplayProjection,
  resolveSchemaDraftForPresentation,
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
  observed_selector: {
    group1: "IFD0",
    group7: "ID-Test",
    tag_name: "XResolution",
  },
  write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "XResolution" },
};
const target: Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> = {
  kind: "ExistingOccurrence",
  occurrence_id: occurrence.id,
  schema_id: schema,
  write_target: occurrence.write_target!,
};

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
    observed_selector: {
      group1: "IFD1",
      group7: "ID-Test",
      tag_name: "XResolution",
    },
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
