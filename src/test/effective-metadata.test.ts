import { describe, expect, it } from "vitest";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  ImageMetadataEntry,
  MetadataDraftEntryV5,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { buildEffectiveMetadataForFile } from "../utils/effectiveMetadata";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetSlotToken,
} from "../utils/metadataDraftTarget";
import {
  metadataGet,
  type MetadataCollection,
} from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const ID: SchemaDefinitionId = { table: "XMP::dc", tag_id: "title" };
const OTHER: SchemaDefinitionId = {
  table: "XMP::dc",
  tag_id: "description",
};
const text = (value: string): MetadataValue => ({ kind: "Text", value });

function metadata(
  ...values: Array<[SchemaDefinitionId, MetadataValue]>
): MetadataCollection {
  return Object.fromEntries(
    values.map(([id, value]) => [
      schemaDefinitionIdToken(id),
      {
        ...structuredClone(value),
        id: structuredClone(id),
      } as ImageMetadataEntry,
    ]),
  );
}

function occurrence(
  id: SchemaDefinitionId,
  value: MetadataValue,
  options: { copy?: number; path?: string; tagName?: string } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: options.path ?? "JPEG-APP1-XMP",
      tag_id: id.tag_id,
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(id),
    value: structuredClone(value),
    tag_info: {
      id: structuredClone(id),
      group: "XMP-dc",
      name: id.tag_id,
      writable: true,
      kind: { kind: "Text" },
      description: null,
    },
    write_target: {
      group1: "XMP-dc",
      tag_name: options.tagName ?? id.tag_id,
    },
  };
}

function existingEntry(
  item: MetadataOccurrence,
  edit: MetadataDraftEntryV5["edit"],
): MetadataDraftEntryV5 {
  const target = existingOccurrenceTargetFromOccurrence(item);
  if (target.kind !== "targetable") throw new Error(target.reason);
  return { target: target.target, edit };
}

function targets(...entries: MetadataDraftEntryV5[]): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry) => [metadataDraftTargetSlotToken(entry.target), entry]),
  );
}

function valueOf(
  collection: MetadataCollection,
  id = ID,
): MetadataValue | undefined {
  const entry = metadataGet(collection, id);
  if (!entry) return undefined;
  const { id: _id, ...value } = entry;
  return value as MetadataValue;
}

describe("buildEffectiveMetadataForFile", () => {
  it("preserves compatibility-only values", () => {
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          metadata: metadata([ID, text("compatibility")]),
          occurrences: undefined,
          targetDrafts: undefined,
        }),
      ),
    ).toEqual(text("compatibility"));
  });

  it("overlays a uniquely resolved authoritative occurrence", () => {
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          metadata: metadata([ID, text("compatibility")]),
          occurrences: [occurrence(ID, text("authoritative"))],
          targetDrafts: undefined,
        }),
      ),
    ).toEqual(text("authoritative"));
  });

  it("never first-selects multiple occurrences and retains the compatibility projection", () => {
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          metadata: metadata([ID, text("compatibility")]),
          occurrences: [
            occurrence(ID, text("first"), { copy: 0 }),
            occurrence(ID, text("second"), { copy: 1 }),
          ],
          targetDrafts: undefined,
        }),
      ),
    ).toEqual(text("compatibility"));
  });

  it("overlays valid ExistingOccurrence Set and Delete", () => {
    const item = occurrence(ID, text("disk"));
    const setResult = buildEffectiveMetadataForFile({
      metadata: metadata([ID, text("compatibility")]),
      occurrences: [item],
      targetDrafts: targets(
        existingEntry(item, { intent: "Set", value: text("pending") }),
      ),
    });
    expect(valueOf(setResult)).toEqual(text("pending"));

    const deleteResult = buildEffectiveMetadataForFile({
      metadata: metadata([ID, text("compatibility")]),
      occurrences: [item],
      targetDrafts: targets(
        existingEntry(item, { intent: "Delete", value: null }),
      ),
    });
    expect(valueOf(deleteResult)).toBeUndefined();
  });

  it("overlays a valid missing NewProperty Set", () => {
    const entry: MetadataDraftEntryV5 = {
      target: { kind: "NewProperty", schema_id: ID },
      edit: { intent: "Set", value: text("new") },
    };
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          metadata: {},
          occurrences: [],
          targetDrafts: targets(entry),
        }),
      ),
    ).toEqual(text("new"));
  });

  it("ignores stale occurrence IDs and changed selector snapshots", () => {
    const item = occurrence(ID, text("disk"));
    const staleId = existingEntry(item, {
      intent: "Set",
      value: text("stale-id"),
    });
    if (staleId.target.kind !== "ExistingOccurrence") throw new Error();
    staleId.target.occurrence_id.copy = 99;
    const staleSelector = existingEntry(item, {
      intent: "Set",
      value: text("stale-selector"),
    });
    if (staleSelector.target.kind !== "ExistingOccurrence") throw new Error();
    staleSelector.target.write_target.tag_name = "Changed";

    for (const targetDrafts of [targets(staleId), targets(staleSelector)]) {
      expect(
        valueOf(
          buildEffectiveMetadataForFile({
            metadata: metadata([ID, text("compatibility")]),
            occurrences: [item],
            targetDrafts,
          }),
        ),
      ).toEqual(text("disk"));
    }
  });

  it("ignores multiple target owners for one exact schema", () => {
    const first = occurrence(ID, text("disk"), { copy: 0 });
    const second = occurrence(ID, text("other"), { copy: 1 });
    const result = buildEffectiveMetadataForFile({
      metadata: metadata([ID, text("compatibility")]),
      occurrences: [first],
      targetDrafts: targets(
        existingEntry(first, { intent: "Set", value: text("one") }),
        existingEntry(second, { intent: "Set", value: text("two") }),
      ),
    });
    expect(valueOf(result)).toEqual(text("disk"));
  });

  it("computes exact list add and remove semantics", () => {
    const list: MetadataValue = {
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [text("a"), text("b")],
      },
    };
    const item = occurrence(ID, list);
    const added = buildEffectiveMetadataForFile({
      metadata: metadata([ID, list]),
      occurrences: [item],
      targetDrafts: targets(
        existingEntry(item, { intent: "ListAdd", value: text("c") }),
      ),
    });
    expect(valueOf(added)).toEqual({
      kind: "List",
      value: { list_kind: "Bag", items: [text("a"), text("b"), text("c")] },
    });

    const removed = buildEffectiveMetadataForFile({
      metadata: metadata([ID, list]),
      occurrences: [item],
      targetDrafts: targets(
        existingEntry(item, { intent: "ListRemove", value: text("a") }),
      ),
    });
    expect(valueOf(removed)).toEqual({
      kind: "List",
      value: { list_kind: "Bag", items: [text("b")] },
    });
  });

  it("keeps absent index distinct from index zero", () => {
    const zero = { ...ID, index: 0 };
    const item = occurrence(ID, text("disk"));
    const newZero: MetadataDraftEntryV5 = {
      target: { kind: "NewProperty", schema_id: zero },
      edit: { intent: "Set", value: text("zero") },
    };
    const result = buildEffectiveMetadataForFile({
      metadata: metadata([ID, text("compatibility")]),
      occurrences: [item],
      targetDrafts: targets(newZero),
    });
    expect(valueOf(result, ID)).toEqual(text("disk"));
    expect(valueOf(result, zero)).toEqual(text("zero"));
  });

  it("does not mutate metadata, occurrences, or target drafts", () => {
    const base = metadata([ID, text("compatibility")], [OTHER, text("other")]);
    const item = occurrence(ID, text("disk"));
    const targetDrafts = targets(
      existingEntry(item, { intent: "Set", value: text("pending") }),
    );
    const snapshots = structuredClone({
      base,
      item,
      targetDrafts,
    });
    buildEffectiveMetadataForFile({
      metadata: base,
      occurrences: [item],
      targetDrafts,
    });
    expect({ base, item, targetDrafts }).toEqual(snapshots);
  });
});
