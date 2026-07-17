import { describe, expect, it } from "vitest";
import {
  DESCRIBE_TARGET_TAGS,
  GeneratedTargetDraftPlanError,
  planGeneratedTargetDraftBatchV5,
  type GeneratedMetadataProducerV5,
} from "../generatedTargetDrafts";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataDraftEntry,
  MetadataDraftEntryV5,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { GEOCODE_TARGET_TAGS, NORMALISE_TARGET_TAGS_BY_GROUP } from "../types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetSlotToken,
} from "../utils/metadataDraftTarget";

const text = (value: string): MetadataValue => ({ kind: "Text", value });
const set = (value: string): MetadataDraftEdit => ({
  intent: "Set",
  value: text(value),
});
const del = (): MetadataDraftEdit => ({ intent: "Delete", value: null });

function occurrence(
  id: SchemaDefinitionId,
  value = "current",
  options: {
    copy?: number;
    path?: string;
    writable?: boolean;
    tagInfo?: boolean;
    writeTarget?: boolean;
    schemaId?: SchemaDefinitionId;
  } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: options.path ?? "JPEG-APP1-XMP",
      tag_id: id.tag_id,
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(options.schemaId ?? id),
    value: text(value),
    tag_info:
      options.tagInfo === false
        ? null
        : {
            id: structuredClone(id),
            group: "Test",
            name: id.tag_id,
            writable: options.writable ?? true,
            kind: { kind: "Text" },
            description: null,
          },
    write_target:
      options.writeTarget === false
        ? null
        : { group1: "XMP-test", tag_name: id.tag_id },
  };
}

function targetEntry(
  item: MetadataOccurrence,
  edit: MetadataDraftEdit,
): MetadataDraftEntryV5 {
  const resolution = existingOccurrenceTargetFromOccurrence(item);
  if (resolution.kind !== "targetable") throw new Error(resolution.reason);
  return { target: resolution.target, edit: structuredClone(edit) };
}

function targetCollection(
  ...entries: MetadataDraftEntryV5[]
): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry) => [
      metadataDraftTargetSlotToken(entry.target),
      structuredClone(entry),
    ]),
  );
}

function plan(options: {
  producer?: GeneratedMetadataProducerV5;
  edits?: MetadataDraftEntry[];
  occurrences?: MetadataOccurrence[] | "loading";
  targetDrafts?: TargetDraftCollection;
}) {
  return planGeneratedTargetDraftBatchV5({
    producer: options.producer ?? { kind: "describe" },
    edits: options.edits ?? [],
    occurrences: options.occurrences ?? [],
    targetDrafts: options.targetDrafts,
  });
}

function expectCode(
  run: () => unknown,
  code: GeneratedTargetDraftPlanError["code"],
) {
  try {
    run();
    throw new Error("Expected generated target planning to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(GeneratedTargetDraftPlanError);
    expect((error as GeneratedTargetDraftPlanError).code).toBe(code);
  }
}

describe("planGeneratedTargetDraftBatchV5", () => {
  it("returns an empty plan for empty edits with loaded occurrences", () => {
    expect(plan({ occurrences: [occurrence(ID.mlibAiDescription)] })).toEqual({
      upserts: [],
      deletes: [],
      noops: [],
    });
  });

  it("returns an empty plan for empty edits while occurrences are loading", () => {
    expect(plan({ occurrences: "loading" })).toEqual({
      upserts: [],
      deletes: [],
      noops: [],
    });
  });

  it("ignores ambiguous target-aware owners for an empty edit batch", () => {
    const first = occurrence(ID.mlibAiDescription, "a", { copy: 0 });
    const second = occurrence(ID.mlibAiDescription, "b", { copy: 1 });
    expect(
      plan({
        targetDrafts: targetCollection(
          targetEntry(first, set("one")),
          targetEntry(second, set("two")),
        ),
      }),
    ).toEqual({ upserts: [], deletes: [], noops: [] });
  });

  it("does not mutate any input while returning an empty plan", () => {
    const producer: GeneratedMetadataProducerV5 = {
      kind: "normalise",
      enabledGroups: ["title"],
    };
    const occurrences = [occurrence(ID.mlibAiDescription)];
    const targetDrafts = targetCollection(
      targetEntry(occurrences[0], set("target")),
    );
    const before = structuredClone({
      producer,
      occurrences,
      targetDrafts,
    });

    expect(plan({ producer, occurrences, targetDrafts })).toEqual({
      upserts: [],
      deletes: [],
      noops: [],
    });
    expect({ producer, occurrences, targetDrafts }).toEqual(before);
  });

  it("does not construct or validate a producer allowlist for empty edits", () => {
    expect(
      plan({
        producer: {
          kind: "normalise",
          enabledGroups: ["not-a-normalise-group" as never],
        },
        occurrences: "loading",
      }),
    ).toEqual({ upserts: [], deletes: [], noops: [] });
  });

  it("creates an exact ExistingOccurrence target for a unique writable occurrence", () => {
    const item = occurrence(ID.mlibAiDescription);
    const result = plan({
      edits: [{ id: ID.mlibAiDescription, edit: set("generated") }],
      occurrences: [item],
    });
    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0].target).toMatchObject({
      kind: "ExistingOccurrence",
      occurrence_id: item.id,
      schema_id: ID.mlibAiDescription,
      write_target: item.write_target,
    });
  });

  it("creates an exact NewProperty target when the schema is missing", () => {
    const result = plan({
      edits: [{ id: ID.mlibAiDescription, edit: set("generated") }],
    });
    expect(result.upserts[0].target).toEqual({
      kind: "NewProperty",
      schema_id: ID.mlibAiDescription,
    });
  });

  it("accepts every exact describe output schema and no namespace prefix shortcut", () => {
    const result = plan({
      edits: DESCRIBE_TARGET_TAGS.map((id) => ({ id, edit: set(id.tag_id) })),
    });
    expect(result.upserts).toHaveLength(DESCRIBE_TARGET_TAGS.length);
    expectCode(
      () =>
        plan({
          edits: [
            {
              id: { table: "UserDefined::mlib", tag_id: "ForeignField" },
              edit: set("x"),
            },
          ],
        }),
      "schema_not_allowed",
    );
  });

  it("accepts the exact geocode set including deliberate Delete intents", () => {
    const result = plan({
      producer: { kind: "geocode" },
      edits: GEOCODE_TARGET_TAGS.map((id, index) => ({
        id,
        edit: index === 0 ? del() : set(id.tag_id),
      })),
    });
    expect(result.upserts).toHaveLength(GEOCODE_TARGET_TAGS.length - 1);
    expect(result.noops).toEqual([GEOCODE_TARGET_TAGS[0]]);
  });

  it("restricts normalise output to the immutable enabled-group union", () => {
    const allowed = NORMALISE_TARGET_TAGS_BY_GROUP.title[0];
    const disabled = NORMALISE_TARGET_TAGS_BY_GROUP.description[0];
    expect(
      plan({
        producer: { kind: "normalise", enabledGroups: ["title"] },
        edits: [{ id: allowed, edit: set("title") }],
      }).upserts,
    ).toHaveLength(1);
    expectCode(
      () =>
        plan({
          producer: { kind: "normalise", enabledGroups: ["title"] },
          edits: [
            { id: allowed, edit: set("title") },
            { id: disabled, edit: set("description") },
          ],
        }),
      "schema_not_allowed",
    );
  });

  it("rejects duplicate exact schema IDs before resolving any target", () => {
    expectCode(
      () =>
        plan({
          edits: [
            { id: ID.mlibAiDescription, edit: set("one") },
            { id: ID.mlibAiDescription, edit: set("two") },
          ],
        }),
      "duplicate_schema",
    );
  });

  it("requires authoritative occurrences to be loaded", () => {
    expectCode(
      () =>
        plan({
          edits: [{ id: ID.mlibAiDescription, edit: set("x") }],
          occurrences: "loading",
        }),
      "occurrences_loading",
    );
  });

  it("rejects multiple authoritative occurrences without selecting one", () => {
    expectCode(
      () =>
        plan({
          edits: [{ id: ID.mlibAiDescription, edit: set("x") }],
          occurrences: [
            occurrence(ID.mlibAiDescription, "a", { copy: 0 }),
            occurrence(ID.mlibAiDescription, "b", { copy: 1 }),
          ],
        }),
      "multiple_occurrences",
    );
  });

  it("rejects read-only and selector-less exact occurrences", () => {
    expectCode(
      () =>
        plan({
          edits: [{ id: ID.mlibAiDescription, edit: set("x") }],
          occurrences: [
            occurrence(ID.mlibAiDescription, "a", { writable: false }),
          ],
        }),
      "occurrence_not_targetable",
    );
    expectCode(
      () =>
        plan({
          edits: [{ id: ID.mlibAiDescription, edit: set("x") }],
          occurrences: [
            occurrence(ID.mlibAiDescription, "a", { writeTarget: false }),
          ],
        }),
      "occurrence_not_targetable",
    );
  });

  it("treats unknown occurrences with matching runtime tag IDs as unrelated", () => {
    const result = plan({
      edits: [{ id: ID.mlibAiDescription, edit: set("x") }],
      occurrences: [
        occurrence(ID.mlibAiDescription, "unknown", {
          tagInfo: false,
          schemaId: {
            table: "Unknown::Runtime",
            tag_id: ID.mlibAiDescription.tag_id,
          },
        }),
      ],
    });
    expect(result.upserts[0].target.kind).toBe("NewProperty");
  });

  it("allows replacing one complete equal target owner", () => {
    const item = occurrence(ID.mlibAiDescription);
    const owner = targetEntry(item, set("old"));
    const result = plan({
      edits: [{ id: ID.mlibAiDescription, edit: set("new") }],
      occurrences: [item],
      targetDrafts: targetCollection(owner),
    });
    expect(result.upserts[0].target).toEqual(owner.target);
    expect(result.upserts[0].edit).toEqual(set("new"));
  });

  it("rejects a different occurrence owner or target variant mismatch", () => {
    const current = occurrence(ID.mlibAiDescription, "current", { copy: 0 });
    const sibling = occurrence(ID.mlibAiDescription, "sibling", { copy: 1 });
    expectCode(
      () =>
        plan({
          edits: [{ id: ID.mlibAiDescription, edit: set("new") }],
          occurrences: [current],
          targetDrafts: targetCollection(targetEntry(sibling, set("old"))),
        }),
      "target_owner_mismatch",
    );
    expectCode(
      () =>
        plan({
          edits: [{ id: ID.mlibAiDescription, edit: set("new") }],
          occurrences: [current],
          targetDrafts: targetCollection({
            target: {
              kind: "NewProperty",
              schema_id: ID.mlibAiDescription,
            },
            edit: set("old"),
          }),
        }),
      "target_owner_mismatch",
    );
  });

  it("rejects multiple target owners for one exact schema", () => {
    const first = occurrence(ID.mlibAiDescription, "a", { copy: 0 });
    const second = occurrence(ID.mlibAiDescription, "b", { copy: 1 });
    expectCode(
      () =>
        plan({
          edits: [{ id: ID.mlibAiDescription, edit: set("new") }],
          occurrences: [first],
          targetDrafts: targetCollection(
            targetEntry(first, set("one")),
            targetEntry(second, set("two")),
          ),
        }),
      "multiple_target_owners",
    );
  });

  it("plans exact no-op for an identical owner and edit", () => {
    const item = occurrence(ID.mlibAiDescription, "current");
    const owner = targetEntry(item, set("pending"));
    const result = plan({
      edits: [{ id: ID.mlibAiDescription, edit: set("pending") }],
      occurrences: [item],
      targetDrafts: targetCollection(owner),
    });
    expect(result).toEqual({
      upserts: [],
      deletes: [],
      noops: [ID.mlibAiDescription],
    });
  });

  it("does not stage a Set equal to the authoritative value", () => {
    const item = occurrence(ID.mlibAiDescription, "same");
    const result = plan({
      edits: [{ id: ID.mlibAiDescription, edit: set("same") }],
      occurrences: [item],
    });
    expect(result.upserts).toEqual([]);
    expect(result.noops).toEqual([ID.mlibAiDescription]);
  });

  it("clears an exact pending owner when generated Set restores disk value", () => {
    const item = occurrence(ID.mlibAiDescription, "disk");
    const owner = targetEntry(item, set("pending"));
    const result = plan({
      edits: [{ id: ID.mlibAiDescription, edit: set("disk") }],
      occurrences: [item],
      targetDrafts: targetCollection(owner),
    });
    expect(result.deletes).toEqual([owner.target]);
    expect(result.upserts).toEqual([]);
  });

  it("makes missing Delete a no-op or cancels the exact NewProperty owner", () => {
    const schema = GEOCODE_TARGET_TAGS[0];
    const noOwner = plan({
      producer: { kind: "geocode" },
      edits: [{ id: schema, edit: del() }],
    });
    expect(noOwner.noops).toEqual([schema]);

    const owner: MetadataDraftEntryV5 = {
      target: { kind: "NewProperty", schema_id: schema },
      edit: set("pending"),
    };
    const cancellation = plan({
      producer: { kind: "geocode" },
      edits: [{ id: schema, edit: del() }],
      targetDrafts: targetCollection(owner),
    });
    expect(cancellation.deletes).toEqual([owner.target]);
  });

  it("rejects stale ExistingOccurrence ownership when the schema is now missing", () => {
    const schema = GEOCODE_TARGET_TAGS[0];
    const stale = targetEntry(occurrence(schema), set("old"));
    expectCode(
      () =>
        plan({
          producer: { kind: "geocode" },
          edits: [{ id: schema, edit: del() }],
          targetDrafts: targetCollection(stale),
        }),
      "stale_target_owner",
    );
  });

  it("keeps absent schema index distinct from index zero", () => {
    const absent = ID.mlibAiDescription;
    const zero = { ...ID.mlibAiDescription, index: 0 };
    expectCode(
      () =>
        plan({
          edits: [
            { id: absent, edit: set("allowed") },
            { id: zero, edit: set("foreign") },
          ],
        }),
      "schema_not_allowed",
    );
  });

  it("rejects out-of-contract intents and malformed Set/Delete payloads", () => {
    expectCode(
      () =>
        plan({
          edits: [
            {
              id: ID.mlibAiDescription,
              edit: { intent: "Delete", value: null },
            },
          ],
        }),
      "intent_not_allowed",
    );
    expectCode(
      () =>
        plan({
          edits: [
            {
              id: ID.mlibAiDescription,
              edit: { intent: "Set", value: null },
            },
          ],
        }),
      "invalid_entry",
    );
  });

  it("validates a mixed batch completely and returns no partial plan", () => {
    expectCode(
      () =>
        plan({
          edits: [
            { id: ID.mlibAiDescription, edit: set("valid") },
            { id: ID.xmpTitle, edit: set("foreign") },
          ],
        }),
      "schema_not_allowed",
    );
  });

  it("defensively isolates input IDs, targets and edits from outputs", () => {
    const id = structuredClone(ID.mlibAiDescription);
    const edit = set("generated");
    const item = occurrence(id);
    const result = plan({ edits: [{ id, edit }], occurrences: [item] });

    id.tag_id = "mutated";
    (edit.value as Extract<MetadataValue, { kind: "Text" }>).value = "mutated";
    item.id.path = "mutated";
    expect(result.upserts[0].target.schema_id.tag_id).toBe("AIDescription");
    expect(result.upserts[0].edit).toEqual(set("generated"));
    expect(result.upserts[0].target).toMatchObject({
      occurrence_id: { path: "JPEG-APP1-XMP" },
    });

    result.upserts[0].target.schema_id.tag_id = "output-mutated";
    expect(id.tag_id).toBe("mutated");
  });
});
