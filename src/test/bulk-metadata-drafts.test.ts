import { describe, expect, it } from "vitest";
import type {
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import {
  BulkMetadataDraftPlanError,
  planBulkMetadataDraftBatch,
} from "../bulkMetadataDrafts";
import { metadataEditCapabilities } from "../metadataEditCapabilities";
import { mergeMetadataValueExactly } from "../metadataValueMerge";
import { occurrenceFromSchemaValue } from "./occurrenceFixtures";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { family7GroupFromSchemaId } from "../utils/metadataWriteTarget";

const id: SchemaDefinitionId = {
  table: "XMP::dc",
  tag_id: "subject",
};

function info(kind: TagKind = { kind: "Text" }): TagInfo {
  return {
    id: structuredClone(id),
    group: "XMP-dc",
    name: "Subject",
    writable: true,
    kind,
    description: null,
    storage_count: undefined,
  };
}

function text(value: string): MetadataValue {
  return { kind: "Text", value };
}

function bag(...values: string[]): MetadataValue {
  return {
    kind: "List",
    value: { list_kind: "Bag", items: values.map(text) },
  };
}

function occurrence(
  value: MetadataValue,
  ordinal: number,
  group1: string,
): MetadataOccurrence {
  const item = occurrenceFromSchemaValue(id, value, ordinal);
  item.tag_info = info(
    value.kind === "List"
      ? { kind: "Bag", data: { kind: "Text" } }
      : value.kind === "LangAlt"
        ? { kind: "LangAlt" }
        : { kind: "Text" },
  );
  item.observed_selector = {
    group1,
    group7: family7GroupFromSchemaId(id),
    tag_name: "Subject",
  };
  item.write_target = structuredClone(item.observed_selector);
  return item;
}

function targetFor(item: MetadataOccurrence): MetadataDraftTarget {
  return {
    kind: "ExistingOccurrence",
    occurrence_id: structuredClone(item.id),
    schema_id: structuredClone(item.schema_id),
    write_target: structuredClone(item.write_target!),
  };
}

function drafts(
  entries: Array<{
    target: MetadataDraftTarget;
    edit: { intent: "Set" | "Delete"; value: MetadataValue | null };
  }>,
): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry) => [metadataDraftTargetSlotToken(entry.target), entry]),
  );
}

describe("metadataEditCapabilities", () => {
  it("centralises collection merge support", () => {
    expect(
      metadataEditCapabilities(info({ kind: "Bag", data: { kind: "Text" } })),
    ).toEqual({ groupedEditor: null, mergeMode: "list-union" });
    expect(metadataEditCapabilities(info({ kind: "LangAlt" }))).toEqual({
      groupedEditor: null,
      mergeMode: "lang-alt",
    });
    expect(metadataEditCapabilities(info())).toEqual({
      groupedEditor: null,
      mergeMode: null,
    });
  });
});

describe("mergeMetadataValueExactly", () => {
  it("unions collection items without duplicates", () => {
    expect(
      mergeMetadataValueExactly(
        { kind: "Bag", data: { kind: "Text" } },
        bag("existing", "shared"),
        bag("shared", "added"),
      ),
    ).toEqual({ kind: "merged", value: bag("existing", "shared", "added") });
  });

  it("overwrites matching LangAlt languages and preserves the others", () => {
    expect(
      mergeMetadataValueExactly(
        { kind: "LangAlt" },
        { kind: "LangAlt", value: { en: "Cat", fr: "Chat" } },
        { kind: "LangAlt", value: { en: "Kitten", de: "Kätzchen" } },
      ),
    ).toEqual({
      kind: "merged",
      value: {
        kind: "LangAlt",
        value: { en: "Kitten", fr: "Chat", de: "Kätzchen" },
      },
    });
  });
});

describe("planBulkMetadataDraftBatch", () => {
  it("sets every exact occurrence and creates the property on missing files", () => {
    const first = occurrence(text("one"), 0, "IFD0");
    const second = occurrence(text("two"), 1, "IFD1");

    const plan = planBulkMetadataDraftBatch({
      files: [
        {
          relativePath: "duplicates.jpg",
          occurrences: [first, second],
          targetDrafts: undefined,
        },
        {
          relativePath: "missing.jpg",
          occurrences: [],
          targetDrafts: undefined,
        },
      ],
      request: {
        operation: "Set",
        tagInfo: info(),
        edit: { intent: "Set", value: text("replacement") },
        merge: false,
      },
    });

    expect(plan.mutations).toHaveLength(2);
    expect(plan.mutations[0].upserts).toHaveLength(2);
    expect(
      plan.mutations[0].upserts.every(
        (entry) => entry.target.kind === "ExistingOccurrence",
      ),
    ).toBe(true);
    expect(plan.mutations[1].upserts).toHaveLength(1);
    expect(plan.mutations[1].upserts[0].target.kind).toBe("NewProperty");
    expect(plan.preview).toMatchObject({
      affectedPhotoCount: 2,
      existingOccurrencesSet: 2,
      newPropertiesSet: 1,
    });
  });

  it("merges against the current effective draft value", () => {
    const item = occurrence(bag("disk"), 0, "XMP-dc");
    const target = targetFor(item);
    const plan = planBulkMetadataDraftBatch({
      files: [
        {
          relativePath: "merged.jpg",
          occurrences: [item],
          targetDrafts: drafts([
            {
              target,
              edit: { intent: "Set", value: bag("disk", "draft") },
            },
          ]),
        },
      ],
      request: {
        operation: "Set",
        tagInfo: info({ kind: "Bag", data: { kind: "Text" } }),
        edit: { intent: "Set", value: bag("draft", "added") },
        merge: true,
      },
    });

    expect(plan.mutations[0].upserts[0].edit).toEqual({
      intent: "Set",
      value: bag("disk", "draft", "added"),
    });
  });

  it("deletes all exact occurrences and cancels staged creations", () => {
    const first = occurrence(text("one"), 0, "IFD0");
    const second = occurrence(text("two"), 1, "IFD1");
    const newTarget: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: structuredClone(id),
      write_target: {
        group1: "XMP-dc",
        group7: family7GroupFromSchemaId(id),
        tag_name: "Subject",
      },
    };
    const plan = planBulkMetadataDraftBatch({
      files: [
        {
          relativePath: "delete.jpg",
          occurrences: [first, second],
          targetDrafts: drafts([
            {
              target: newTarget,
              edit: { intent: "Set", value: text("pending") },
            },
          ]),
        },
      ],
      request: { operation: "Delete", schemaId: id },
    });

    expect(plan.mutations[0].upserts).toHaveLength(2);
    expect(plan.mutations[0].deletes).toEqual([newTarget]);
    expect(plan.preview).toMatchObject({
      existingOccurrencesDeleted: 2,
      stagedCreationsCancelled: 1,
    });
  });

  it("rejects the whole plan when any occurrence is not targetable", () => {
    const good = occurrence(text("one"), 0, "IFD0");
    const blocked = occurrence(text("two"), 1, "IFD1");
    blocked.tag_info = { ...info(), writable: false };

    expect(() =>
      planBulkMetadataDraftBatch({
        files: [
          {
            relativePath: "good.jpg",
            occurrences: [good],
            targetDrafts: undefined,
          },
          {
            relativePath: "blocked.jpg",
            occurrences: [blocked],
            targetDrafts: undefined,
          },
        ],
        request: {
          operation: "Set",
          tagInfo: info(),
          edit: { intent: "Set", value: text("replacement") },
          merge: false,
        },
      }),
    ).toThrow(BulkMetadataDraftPlanError);
  });
});
