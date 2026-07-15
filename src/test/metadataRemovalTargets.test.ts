import { describe, expect, it } from "vitest";
import {
  MetadataRemovalTargetPlanError,
  planMetadataRemovalTargetsV5,
} from "../metadataRemovalTargets";
import type {
  MetadataDraftCollection,
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
} from "../types";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "282" };
const indexed: SchemaDefinitionId = { ...id, index: 0 };

function occurrence(
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: "JPEG-APP1-IFD0",
      tag_id: "282",
      copy: 0,
    },
    value: { kind: "Integer", value: 300 },
    tag_info: {
      id: structuredClone(id),
      group: "IFD0",
      name: "XResolution",
      writable: true,
      kind: { kind: "Integer", data: { min: null, max: null } },
      description: null,
    },
    write_target: { group1: "IFD0", tag_name: "XResolution" },
    ...overrides,
  };
}

function target(source = occurrence()): MetadataDraftTarget {
  return {
    kind: "ExistingOccurrence",
    occurrence_id: structuredClone(source.id),
    schema_id: structuredClone(source.tag_info!.id),
    write_target: structuredClone(source.write_target!),
  };
}

function owner(currentTarget: MetadataDraftTarget) {
  return {
    [metadataDraftTargetSlotToken(currentTarget)]: {
      target: currentTarget,
      edit: {
        intent: "Set" as const,
        value: { kind: "Integer" as const, value: 301 },
      },
    },
  };
}

function plan(
  options: {
    ids?: SchemaDefinitionId[];
    occurrences?: MetadataOccurrence[] | "loading";
    legacy?: MetadataDraftCollection;
    targets?: ReturnType<typeof owner>;
  } = {},
) {
  return planMetadataRemovalTargetsV5({
    schemaIds: options.ids ?? [id],
    occurrences: options.occurrences ?? [occurrence()],
    legacyDrafts: options.legacy,
    targetDrafts: options.targets,
  });
}

function expectCode(
  fn: () => unknown,
  code: MetadataRemovalTargetPlanError["code"],
) {
  expect(fn).toThrowError(MetadataRemovalTargetPlanError);
  try {
    fn();
  } catch (error) {
    expect((error as MetadataRemovalTargetPlanError).code).toBe(code);
  }
}

describe("planMetadataRemovalTargetsV5", () => {
  it("plans a writable occurrence with its exact ID, embedded schema and runtime selector", () => {
    const source = occurrence({
      id: { document: "Doc1", path: "custom", tag_id: "runtime", copy: 7 },
      tag_info: {
        ...occurrence().tag_info!,
        id: { ...id, index: 0 },
      },
      write_target: { group1: "IFD1", tag_name: "ExactName" },
    });
    const result = plan({ ids: [indexed], occurrences: [source] });
    expect(result.upserts).toEqual([
      { target: target(source), edit: { intent: "Delete", value: null } },
    ]);
  });

  it("treats a genuinely missing field as a cloned no-op", () => {
    const result = plan({ occurrences: [] });
    expect(result).toEqual({ upserts: [], deletes: [], noops: [id] });
    expect(result.noops[0]).not.toBe(id);
  });

  it("deletes the exact NewProperty owner for a missing field", () => {
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: structuredClone(id),
    };
    const result = plan({ occurrences: [], targets: owner(created) });
    expect(result.deletes).toEqual([created]);
    expect(result.deletes[0]).not.toBe(created);
  });

  it("rejects stale ExistingOccurrence ownership for a missing field", () => {
    expectCode(
      () => plan({ occurrences: [], targets: owner(target()) }),
      "stale-target-owner",
    );
  });

  it("rejects multiple occurrences without first-selecting", () => {
    expectCode(
      () =>
        plan({
          occurrences: [
            occurrence(),
            occurrence({
              id: { ...occurrence().id, path: "JPEG-APP1-IFD1", copy: 2 },
            }),
          ],
        }),
      "multiple-occurrences",
    );
  });

  it("rejects missing TagInfo, read-only TagInfo and a missing write target", () => {
    expectCode(
      () => plan({ occurrences: [occurrence({ tag_info: null })] }),
      "untargetable-occurrence",
    );
    expectCode(
      () =>
        plan({
          occurrences: [
            occurrence({
              tag_info: { ...occurrence().tag_info!, writable: false },
            }),
          ],
        }),
      "untargetable-occurrence",
    );
    expectCode(
      () => plan({ occurrences: [occurrence({ write_target: null })] }),
      "untargetable-occurrence",
    );
  });

  it("rejects an exact legacy owner and preserves both inputs", () => {
    const legacy: MetadataDraftCollection = {
      [schemaDefinitionIdToken(id)]: {
        id,
        edit: { intent: "Delete", value: null },
      },
    };
    const targets = owner(target());
    const before = structuredClone({ legacy, targets });
    expectCode(() => plan({ legacy, targets }), "legacy-owner");
    expect({ legacy, targets }).toEqual(before);
  });

  it("replaces an identical ExistingOccurrence owner with Delete", () => {
    const source = occurrence();
    const result = plan({ targets: owner(target(source)) });
    expect(result.upserts[0]).toEqual({
      target: target(source),
      edit: { intent: "Delete", value: null },
    });
  });

  it("rejects NewProperty/existing and different-occurrence ownership", () => {
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: id,
    };
    expectCode(
      () => plan({ targets: owner(created) }),
      "incompatible-target-owner",
    );
    const different = target(
      occurrence({ id: { ...occurrence().id, path: "different" } }),
    );
    expectCode(
      () => plan({ targets: owner(different) }),
      "incompatible-target-owner",
    );
  });

  it("rejects multiple target owners and duplicate input schemas", () => {
    const existing = target();
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: id,
    };
    const targets = { ...owner(existing), ...owner(created) };
    expectCode(() => plan({ targets }), "multiple-target-owners");
    expectCode(
      () => plan({ ids: [id, structuredClone(id)] }),
      "duplicate-schema",
    );
  });

  it("keeps absent index and index zero distinct", () => {
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: indexed,
    };
    expect(plan({ occurrences: [], targets: owner(created) }).noops).toEqual([
      id,
    ]);
  });

  it("rejects loading and empty requests before planning", () => {
    expectCode(() => plan({ occurrences: "loading" }), "occurrences-loading");
    expectCode(() => plan({ ids: [] }), "empty-request");
  });

  it("clones outputs and mutates no inputs", () => {
    const source = occurrence();
    const ids = [structuredClone(id)];
    const before = structuredClone({ source, ids });
    const result = plan({ ids, occurrences: [source] });
    result.upserts[0].target.occurrence_id.path = "changed";
    result.upserts[0].target.schema_id.tag_id = "changed";
    result.upserts[0].target.write_target.group1 = "changed";
    expect({ source, ids }).toEqual(before);
  });
});
