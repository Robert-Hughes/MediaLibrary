import { describe, expect, it } from "vitest";
import {
  DESCRIBE_TARGET_TAGS,
  GeneratedTargetDraftPlanError,
  planGeneratedTargetDraftBatch,
  type GeneratedMetadataProducer,
} from "../generatedTargetDrafts";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  SchemaMetadataEdit,
  MetadataTargetDraftEntry,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { GEOCODE_TARGET_TAGS, NORMALISE_TARGET_TAGS_BY_GROUP } from "../types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetSlotToken,
  newPropertyDraftTarget,
} from "../utils/metadataDraftTarget";

const text = (value: string): MetadataValue => ({ kind: "Text", value });
const set = (value: string): MetadataDraftEdit => ({
  intent: "Set",
  value: text(value),
});
const del = (): MetadataDraftEdit => ({ intent: "Delete", value: null });

function schemaInfo(
  id: SchemaDefinitionId,
  options: { group?: string; name?: string } = {},
): TagInfo {
  return {
    id: structuredClone(id),
    group: options.group ?? "Test",
    name: options.name ?? id.tag_id,
    writable: true,
    kind: { kind: "Text" },
    description: null,
  };
}

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
  const writeTarget =
    options.writeTarget === false
      ? null
      : { group1: "XMP-test", group7: "ID-Test", tag_name: id.tag_id };
  return {
    id: {
      document: null,
      path: options.path ?? "JPEG-APP1-XMP",
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
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
    observed_selector: structuredClone(writeTarget),
    write_target: structuredClone(writeTarget),
  };
}

function targetEntry(
  item: MetadataOccurrence,
  edit: MetadataDraftEdit,
): MetadataTargetDraftEntry {
  const resolution = existingOccurrenceTargetFromOccurrence(item);
  if (resolution.kind !== "targetable") throw new Error(resolution.reason);
  return { target: resolution.target, edit: structuredClone(edit) };
}

function targetCollection(
  ...entries: MetadataTargetDraftEntry[]
): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry) => [
      metadataDraftTargetSlotToken(entry.target),
      structuredClone(entry),
    ]),
  );
}

function plan(options: {
  producer?: GeneratedMetadataProducer;
  edits?: SchemaMetadataEdit[];
  occurrences?: MetadataOccurrence[] | "loading";
  targetDrafts?: TargetDraftCollection;
  writableSchemaDefinitions?: TagInfo[];
}) {
  const edits = options.edits ?? [];
  return planGeneratedTargetDraftBatch({
    producer: options.producer ?? { kind: "describe" },
    edits,
    occurrences: options.occurrences ?? [],
    targetDrafts: options.targetDrafts,
    writableSchemaDefinitions:
      options.writableSchemaDefinitions ??
      edits.map(({ schema_id }) => schemaInfo(schema_id)),
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

describe("planGeneratedTargetDraftBatch", () => {
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
    const producer: GeneratedMetadataProducer = {
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
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("generated") }],
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
    const definition = schemaInfo(ID.mlibAiDescription, {
      group: "XMP-custom",
      name: "CustomDescription",
    });
    const result = plan({
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("generated") }],
      writableSchemaDefinitions: [definition],
    });
    expect(result.upserts[0].target).toEqual({
      kind: "NewProperty",
      schema_id: ID.mlibAiDescription,
      write_target: {
        group1: "XMP-custom",
        group7: "ID-AIDescription",
        tag_name: "CustomDescription",
      },
    });
  });

  it("derives the IPTC CodedCharacterSet target from its exact schema definition", () => {
    const result = plan({
      producer: { kind: "normalise", enabledGroups: ["iptc_utf8"] },
      edits: [
        {
          schema_id: ID.iptcCodedCharacterSet,
          edit: set("UTF8"),
        },
      ],
      writableSchemaDefinitions: [
        schemaInfo(ID.iptcCodedCharacterSet, {
          group: "IPTC",
          name: "CodedCharacterSet",
        }),
      ],
    });

    expect(result.upserts[0].target).toEqual({
      kind: "NewProperty",
      schema_id: ID.iptcCodedCharacterSet,
      write_target: {
        group1: "IPTC",
        group7: "ID-90",
        tag_name: "CodedCharacterSet",
      },
    });
  });

  it("rejects a missing property when its exact writable schema definition is unavailable", () => {
    expectCode(
      () =>
        plan({
          edits: [{ schema_id: ID.mlibAiDescription, edit: set("generated") }],
          writableSchemaDefinitions: [],
        }),
      "schema_definition_missing",
    );
  });

  it("accepts every exact describe output schema and no namespace prefix shortcut", () => {
    const result = plan({
      edits: DESCRIBE_TARGET_TAGS.map((schema_id) => ({
        schema_id,
        edit: set(schema_id.tag_id),
      })),
    });
    expect(result.upserts).toHaveLength(DESCRIBE_TARGET_TAGS.length);
    expectCode(
      () =>
        plan({
          edits: [
            {
              schema_id: { table: "UserDefined::mlib", tag_id: "ForeignField" },
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
      edits: GEOCODE_TARGET_TAGS.map((schema_id, index) => ({
        schema_id,
        edit: index === 0 ? del() : set(schema_id.tag_id),
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
        edits: [{ schema_id: allowed, edit: set("title") }],
      }).upserts,
    ).toHaveLength(1);
    expectCode(
      () =>
        plan({
          producer: { kind: "normalise", enabledGroups: ["title"] },
          edits: [
            { schema_id: allowed, edit: set("title") },
            { schema_id: disabled, edit: set("description") },
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
            { schema_id: ID.mlibAiDescription, edit: set("one") },
            { schema_id: ID.mlibAiDescription, edit: set("two") },
          ],
        }),
      "duplicate_schema",
    );
  });

  it("requires authoritative occurrences to be loaded", () => {
    expectCode(
      () =>
        plan({
          edits: [{ schema_id: ID.mlibAiDescription, edit: set("x") }],
          occurrences: "loading",
        }),
      "occurrences_loading",
    );
  });

  it("rejects multiple authoritative occurrences without selecting one", () => {
    expectCode(
      () =>
        plan({
          edits: [{ schema_id: ID.mlibAiDescription, edit: set("x") }],
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
          edits: [{ schema_id: ID.mlibAiDescription, edit: set("x") }],
          occurrences: [
            occurrence(ID.mlibAiDescription, "a", { writable: false }),
          ],
        }),
      "occurrence_not_targetable",
    );
    expectCode(
      () =>
        plan({
          edits: [{ schema_id: ID.mlibAiDescription, edit: set("x") }],
          occurrences: [
            occurrence(ID.mlibAiDescription, "a", { writeTarget: false }),
          ],
        }),
      "occurrence_not_targetable",
    );
  });

  it("treats unknown occurrences with matching runtime tag IDs as unrelated", () => {
    const result = plan({
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("x") }],
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
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("new") }],
      occurrences: [item],
      targetDrafts: targetCollection(owner),
    });
    expect(result.upserts[0].target).toEqual(owner.target);
    expect(result.upserts[0].edit).toEqual(set("new"));
  });

  it("ignores same-schema owners that do not match the planned target", () => {
    const current = occurrence(ID.mlibAiDescription, "current", { copy: 0 });
    const sibling = occurrence(ID.mlibAiDescription, "sibling", { copy: 1 });
    const siblingResult = plan({
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("new") }],
      occurrences: [current],
      targetDrafts: targetCollection(targetEntry(sibling, set("old"))),
    });
    expect(siblingResult.upserts[0].target).toEqual(
      targetEntry(current, set("new")).target,
    );

    const customDestination: MetadataTargetDraftEntry = {
      target: {
        kind: "NewProperty",
        schema_id: ID.mlibAiDescription,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
      edit: set("old"),
    };
    const newPropertyResult = plan({
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("new") }],
      occurrences: [current],
      targetDrafts: targetCollection(customDestination),
    });
    expect(newPropertyResult.upserts[0].target.kind).toBe("ExistingOccurrence");
  });

  it("acts only on the exact planned owner among same-schema siblings", () => {
    const first = occurrence(ID.mlibAiDescription, "a", { copy: 0 });
    const second = occurrence(ID.mlibAiDescription, "b", { copy: 1 });
    const result = plan({
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("new") }],
      occurrences: [first],
      targetDrafts: targetCollection(
        targetEntry(first, set("one")),
        targetEntry(second, set("two")),
      ),
    });
    expect(result.upserts).toEqual([targetEntry(first, set("new"))]);
  });

  it("plans exact no-op for an identical owner and edit", () => {
    const item = occurrence(ID.mlibAiDescription, "current");
    const owner = targetEntry(item, set("pending"));
    const result = plan({
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("pending") }],
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
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("same") }],
      occurrences: [item],
    });
    expect(result.upserts).toEqual([]);
    expect(result.noops).toEqual([ID.mlibAiDescription]);
  });

  it("clears an exact pending owner when generated Set restores disk value", () => {
    const item = occurrence(ID.mlibAiDescription, "disk");
    const owner = targetEntry(item, set("pending"));
    const result = plan({
      edits: [{ schema_id: ID.mlibAiDescription, edit: set("disk") }],
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
      edits: [{ schema_id: schema, edit: del() }],
    });
    expect(noOwner.noops).toEqual([schema]);

    const customOwner: MetadataTargetDraftEntry = {
      target: {
        kind: "NewProperty",
        schema_id: schema,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
      edit: set("pending"),
    };
    const cancellation = plan({
      producer: { kind: "geocode" },
      edits: [{ schema_id: schema, edit: del() }],
      targetDrafts: targetCollection(customOwner),
    });
    expect(cancellation.deletes).toEqual([]);
    expect(cancellation.noops).toEqual([schema]);

    const defaultTarget = newPropertyDraftTarget(schemaInfo(schema));
    if (defaultTarget.kind !== "available") {
      throw new Error(defaultTarget.reason);
    }
    const exactOwner: MetadataTargetDraftEntry = {
      target: defaultTarget.target,
      edit: set("pending"),
    };
    const exactCancellation = plan({
      producer: { kind: "geocode" },
      edits: [{ schema_id: schema, edit: del() }],
      targetDrafts: targetCollection(customOwner, exactOwner),
    });
    expect(exactCancellation.deletes).toEqual([exactOwner.target]);
  });

  it("does not redirect a missing-schema Delete to a stale occurrence owner", () => {
    const schema = GEOCODE_TARGET_TAGS[0];
    const stale = targetEntry(occurrence(schema), set("old"));
    const result = plan({
      producer: { kind: "geocode" },
      edits: [{ schema_id: schema, edit: del() }],
      targetDrafts: targetCollection(stale),
    });
    expect(result.deletes).toEqual([]);
    expect(result.noops).toEqual([schema]);
  });

  it("keeps absent schema index distinct from index zero", () => {
    const absent = ID.mlibAiDescription;
    const zero = { ...ID.mlibAiDescription, index: 0 };
    expectCode(
      () =>
        plan({
          edits: [
            { schema_id: absent, edit: set("allowed") },
            { schema_id: zero, edit: set("foreign") },
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
              schema_id: ID.mlibAiDescription,
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
              schema_id: ID.mlibAiDescription,
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
            { schema_id: ID.mlibAiDescription, edit: set("valid") },
            { schema_id: ID.xmpTitle, edit: set("foreign") },
          ],
        }),
      "schema_not_allowed",
    );
  });

  it("defensively isolates input IDs, targets and edits from outputs", () => {
    const id = structuredClone(ID.mlibAiDescription);
    const edit = set("generated");
    const item = occurrence(id);
    const result = plan({
      edits: [{ schema_id: id, edit }],
      occurrences: [item],
    });

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
