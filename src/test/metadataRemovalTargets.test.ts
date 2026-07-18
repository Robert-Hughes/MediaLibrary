import { describe, expect, it } from "vitest";
import {
  MetadataRemovalTargetPlanError,
  planMetadataRemovalTargets,
  previewMetadataRemovalFiles,
  previewMetadataRemovalTargets,
} from "../metadataRemovalTargets";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
} from "../types";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

const id: SchemaDefinitionId = { table: "Exif::Main", tag_id: "282" };
const indexed: SchemaDefinitionId = { ...id, index: 0 };

function occurrence(
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: "JPEG-APP1-IFD0",
      runtime_tag_id: "282",
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: "282",
        index: null,
      },
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
    observed_selector: {
      group1: "IFD0",
      group7: "ID-Test",
      tag_name: "XResolution",
    },
    write_target: {
      group1: "IFD0",
      group7: "ID-Test",
      tag_name: "XResolution",
    },
    ...overrides,
    schema_id:
      overrides.schema_id ?? overrides.tag_info?.id ?? structuredClone(id),
  };
}

function target(source = occurrence()): MetadataDraftTarget {
  return {
    kind: "ExistingOccurrence",
    occurrence_id: structuredClone(source.id),
    schema_id: structuredClone(source.schema_id),
    write_target: structuredClone(source.write_target!),
  };
}

function owner(
  currentTarget: MetadataDraftTarget,
  edit: MetadataDraftEdit = {
    intent: "Set",
    value: { kind: "Integer", value: 301 },
  },
): TargetDraftCollection {
  return {
    [metadataDraftTargetSlotToken(currentTarget)]: {
      target: currentTarget,
      edit,
    },
  };
}

function plan(
  options: {
    ids?: SchemaDefinitionId[];
    occurrences?: MetadataOccurrence[] | "loading";
    targets?: TargetDraftCollection;
  } = {},
) {
  return planMetadataRemovalTargets({
    schemaIds: options.ids ?? [id],
    occurrences: options.occurrences ?? [occurrence()],
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

describe("planMetadataRemovalTargets", () => {
  it("plans a writable occurrence with its exact ID, embedded schema and runtime selector", () => {
    const source = occurrence({
      id: {
        document: "Doc1",
        path: "custom",
        runtime_tag_id: "runtime",
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: "runtime",
          index: null,
        },
        copy: 7,
      },
      tag_info: {
        ...occurrence().tag_info!,
        id: { ...id, index: 0 },
      },
      observed_selector: {
        group1: "IFD1",
        group7: "ID-Test",
        tag_name: "ExactName",
      },
      write_target: {
        group1: "IFD1",
        group7: "ID-Test",
        tag_name: "ExactName",
      },
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

  it("keeps a missing exact schema as a no-op when unknown rows reuse its local tag ID", () => {
    const unknown = occurrence({
      id: {
        document: null,
        path: "QuickTime-MovieHeader",
        runtime_tag_id: id.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: id.tag_id,
          index: null,
        },
        copy: 0,
      },
      tag_info: null,
      observed_selector: null,
      write_target: null,
      schema_id: { table: "Unknown::Runtime", tag_id: id.tag_id },
    });
    const before = structuredClone(unknown);
    expect(plan({ occurrences: [unknown] })).toEqual({
      upserts: [],
      deletes: [],
      noops: [id],
    });
    expect(unknown).toEqual(before);
  });

  it("does not select or mutate any of several unknown rows sharing a local tag ID", () => {
    const unknowns = [
      occurrence({
        id: {
          document: null,
          path: "MakerNotes-A",
          runtime_tag_id: "282",
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: "282",
            index: null,
          },
          copy: 0,
        },
        tag_info: null,
        observed_selector: null,
        write_target: null,
        schema_id: { table: "Unknown::MakerA", tag_id: id.tag_id },
      }),
      occurrence({
        id: {
          document: null,
          path: "MakerNotes-B",
          runtime_tag_id: "282",
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: "282",
            index: null,
          },
          copy: 1,
        },
        tag_info: null,
        observed_selector: null,
        write_target: null,
        schema_id: { table: "Unknown::MakerB", tag_id: id.tag_id },
      }),
    ];
    const before = structuredClone(unknowns);
    expect(plan({ occurrences: unknowns })).toEqual({
      upserts: [],
      deletes: [],
      noops: [id],
    });
    expect(unknowns).toEqual(before);
  });

  it("deletes the exact NewProperty owner for a missing field", () => {
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: structuredClone(id),
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const result = plan({ occurrences: [], targets: owner(created) });
    expect(result.deletes).toEqual([created]);
    expect(result.deletes[0]).not.toBe(created);
  });

  it("cancels an exact NewProperty owner despite unrelated unknown rows", () => {
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: structuredClone(id),
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const unknown = occurrence({
      tag_info: null,
      observed_selector: null,
      write_target: null,
      schema_id: { table: "Unknown::Runtime", tag_id: id.tag_id },
    });
    const result = plan({ occurrences: [unknown], targets: owner(created) });
    expect(result).toEqual({ upserts: [], deletes: [created], noops: [] });
  });

  it("rejects stale ExistingOccurrence ownership for a missing field", () => {
    expectCode(
      () => plan({ occurrences: [], targets: owner(target()) }),
      "stale-target-owner",
    );
  });

  it("still rejects stale ExistingOccurrence ownership alongside unknown rows", () => {
    expectCode(
      () =>
        plan({
          occurrences: [
            occurrence({
              tag_info: null,
              observed_selector: null,
              write_target: null,
              schema_id: { table: "Unknown::Runtime", tag_id: id.tag_id },
            }),
          ],
          targets: owner(target()),
        }),
      "stale-target-owner",
    );
  });

  it("creates exact Delete drafts for every same-schema occurrence", () => {
    const result = plan({
      occurrences: [
        occurrence(),
        occurrence({
          id: { ...occurrence().id, path: "JPEG-APP1-IFD1", copy: 2 },
        }),
      ],
    });
    expect(result.upserts).toHaveLength(2);
    expect(
      result.upserts.map(({ target }) => target.occurrence_id.path),
    ).toEqual(["JPEG-APP1-IFD0", "JPEG-APP1-IFD1"]);
  });

  it("leaves unknown rows read-only and rejects exact read-only or untargetable rows", () => {
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

  it("replaces an identical ExistingOccurrence owner with Delete", () => {
    const source = occurrence();
    const result = plan({ targets: owner(target(source)) });
    expect(result.upserts[0]).toEqual({
      target: target(source),
      edit: { intent: "Delete", value: null },
    });
  });

  it("treats an already staged exact Delete as a no-op without altering it", () => {
    const source = occurrence();
    const targets = owner(target(source), { intent: "Delete", value: null });
    const before = structuredClone(targets);
    expect(plan({ targets })).toEqual({
      upserts: [],
      deletes: [],
      noops: [id],
    });
    expect(targets).toEqual(before);
  });

  it("replaces identical Set and list edits with Delete", () => {
    expect(plan({ targets: owner(target()) }).upserts).toHaveLength(1);
    expect(
      plan({
        targets: owner(target(), {
          intent: "ListAdd",
          value: { kind: "Integer", value: 301 },
        }),
      }).upserts,
    ).toEqual([{ target: target(), edit: { intent: "Delete", value: null } }]);
  });

  it("cancels same-schema New Property targets and rejects a stale occurrence", () => {
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: id,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    expect(plan({ targets: owner(created) })).toMatchObject({
      upserts: [{ target: target(), edit: { intent: "Delete", value: null } }],
      deletes: [created],
    });
    const different = target(
      occurrence({ id: { ...occurrence().id, path: "different" } }),
    );
    expectCode(() => plan({ targets: owner(different) }), "stale-target-owner");
  });

  it("deletes one occurrence and cancels two independent creation destinations", () => {
    const first: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: id,
      write_target: {
        group1: "XMP-first",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const second: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: id,
      write_target: {
        group1: "XMP-second",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const result = plan({ targets: { ...owner(first), ...owner(second) } });
    expect(result.upserts).toEqual([
      { target: target(), edit: { intent: "Delete", value: null } },
    ]);
    expect(result.deletes).toEqual([first, second]);
  });

  it("handles independent exact owners and rejects duplicate input schemas", () => {
    const existing = target();
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: id,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const targets = { ...owner(existing), ...owner(created) };
    expect(plan({ targets })).toMatchObject({
      upserts: [{ target: existing }],
      deletes: [created],
    });
    expectCode(
      () => plan({ ids: [id, structuredClone(id)] }),
      "duplicate-schema",
    );
  });

  it("keeps absent index and index zero distinct", () => {
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: indexed,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
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

describe("target-aware removal previews", () => {
  it("derives delete, cancellation and no-op counts from the planner", () => {
    const createdId: SchemaDefinitionId = {
      table: "XMP::dc",
      tag_id: "subject",
    };
    const absentId: SchemaDefinitionId = {
      table: "XMP::dc",
      tag_id: "description",
    };
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: createdId,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    expect(
      previewMetadataRemovalTargets({
        schemaIds: [id, createdId, absentId],
        occurrences: [occurrence()],
        targetDrafts: owner(created),
      }),
    ).toEqual({
      existingFieldsToDelete: 1,
      stagedCreationsToCancel: 1,
      noOpFields: 1,
      affectedCount: 2,
    });
  });

  it("counts an existing exact Delete as a no-op", () => {
    expect(
      previewMetadataRemovalTargets({
        schemaIds: [id],
        occurrences: [occurrence()],
        targetDrafts: owner(target(), { intent: "Delete", value: null }),
      }),
    ).toEqual({
      existingFieldsToDelete: 0,
      stagedCreationsToCancel: 0,
      noOpFields: 1,
      affectedCount: 0,
    });
  });

  it("counts an exact existing Set draft as one Delete replacement", () => {
    expect(
      previewMetadataRemovalTargets({
        schemaIds: [id],
        occurrences: [occurrence()],
        targetDrafts: owner(target()),
      }),
    ).toEqual({
      existingFieldsToDelete: 1,
      stagedCreationsToCancel: 0,
      noOpFields: 0,
      affectedCount: 1,
    });
  });

  it("aggregates deduplicated files through exact plans", () => {
    const created = {
      kind: "NewProperty" as const,
      schema_id: id,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const occurrencesByPath = new Map([
      ["existing.jpg", [occurrence()]],
      ["created.jpg", []],
      ["absent.jpg", []],
    ]);
    const targetsByPath = new Map<string, TargetDraftCollection>([
      ["created.jpg", owner(created)],
    ]);
    expect(
      previewMetadataRemovalFiles({
        schemaId: id,
        relativePaths: [
          "existing.jpg",
          "created.jpg",
          "absent.jpg",
          "existing.jpg",
        ],
        targetDraftPersistence: { status: "ready" },
        occurrencesForPath: (path) => occurrencesByPath.get(path) ?? [],
        targetDraftsForPath: (path) => targetsByPath.get(path),
      }),
    ).toEqual({
      kind: "ready",
      photoCount: 3,
      affectedPhotoCount: 2,
      existingFieldsToDelete: 1,
      stagedCreationsToCancel: 1,
      noOpPhotoCount: 1,
    });
  });

  it("counts every exact same-schema occurrence across files", () => {
    const multiple = [
      occurrence(),
      occurrence({ id: { ...occurrence().id, path: "duplicate" } }),
    ];
    expect(
      previewMetadataRemovalFiles({
        schemaId: id,
        relativePaths: ["safe.jpg", "ambiguous.jpg", "later.jpg"],
        targetDraftPersistence: { status: "ready" },
        occurrencesForPath: (path) =>
          path === "ambiguous.jpg" ? multiple : [occurrence()],
        targetDraftsForPath: () => undefined,
      }),
    ).toEqual({
      kind: "ready",
      photoCount: 3,
      affectedPhotoCount: 3,
      existingFieldsToDelete: 4,
      stagedCreationsToCancel: 0,
      noOpPhotoCount: 0,
    });
  });
});
