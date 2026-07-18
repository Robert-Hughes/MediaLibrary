import { describe, expect, it } from "vitest";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
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

const ID: SchemaDefinitionId = { table: "XMP::dc", tag_id: "title" };
const text = (value: string): MetadataValue => ({ kind: "Text", value });

function occurrence(
  value: MetadataValue,
  options: { copy?: number; path?: string } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: options.path ?? `XMP-${options.copy ?? 0}`,
      runtime_tag_id: ID.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: ID.tag_id,
        index: null,
      },
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(ID),
    value: structuredClone(value),
    tag_info: {
      id: structuredClone(ID),
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind:
        value.kind === "List"
          ? { kind: "Bag", data: { kind: "Text" } }
          : { kind: "Text" },
      description: null,
      storage_count: undefined,
    },
    observed_selector: null,
    write_target: { group1: "XMP-dc", group7: "ID-Test", tag_name: "Title" },
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

function valueOf(collection: MetadataCollection): MetadataValue | undefined {
  const entry = metadataGet(collection, ID);
  if (!entry) return undefined;
  const { id: _id, ...value } = entry;
  return value as MetadataValue;
}

describe("buildEffectiveMetadataForFile", () => {
  it("derives one authoritative schema value", () => {
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [occurrence(text("disk"))],
          targetDrafts: undefined,
        }),
      ),
    ).toEqual(text("disk"));
  });

  it("treats differing same-schema occurrences as unavailable", () => {
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [
            occurrence(text("first"), { copy: 0 }),
            occurrence(text("second"), { copy: 1 }),
          ],
          targetDrafts: undefined,
        }),
      ),
    ).toBeUndefined();
  });

  it("overlays valid ExistingOccurrence Set and Delete", () => {
    const item = occurrence(text("disk"));
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [item],
          targetDrafts: targets(
            existingEntry(item, { intent: "Set", value: text("pending") }),
          ),
        }),
      ),
    ).toEqual(text("pending"));
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [item],
          targetDrafts: targets(
            existingEntry(item, { intent: "Delete", value: null }),
          ),
        }),
      ),
    ).toBeUndefined();
  });

  it("overlays a valid missing NewProperty Set", () => {
    const entry: MetadataDraftEntryV5 = {
      target: {
        kind: "NewProperty",
        schema_id: ID,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
      edit: { intent: "Set", value: text("new") },
    };
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [],
          targetDrafts: targets(entry),
        }),
      ),
    ).toEqual(text("new"));
  });

  it("ignores stale occurrence and selector snapshots", () => {
    const item = occurrence(text("disk"));
    const staleId = existingEntry(item, {
      intent: "Set",
      value: text("stale"),
    });
    if (staleId.target.kind !== "ExistingOccurrence") throw new Error();
    staleId.target.occurrence_id.copy = 99;
    const staleSelector = existingEntry(item, {
      intent: "Set",
      value: text("stale"),
    });
    if (staleSelector.target.kind !== "ExistingOccurrence") throw new Error();
    staleSelector.target.write_target.tag_name = "Changed";

    for (const targetDrafts of [targets(staleId), targets(staleSelector)]) {
      expect(
        valueOf(
          buildEffectiveMetadataForFile({ occurrences: [item], targetDrafts }),
        ),
      ).toEqual(text("disk"));
    }
  });

  it("does not apply an ExistingOccurrence edit to ambiguous schema values", () => {
    const first = occurrence(text("first"), { copy: 0 });
    const second = occurrence(text("second"), { copy: 1 });
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [first, second],
          targetDrafts: targets(
            existingEntry(first, { intent: "Set", value: text("pending") }),
          ),
        }),
      ),
    ).toBeUndefined();
  });

  it("computes exact ListAdd and ListRemove semantics", () => {
    const list: MetadataValue = {
      kind: "List",
      value: { list_kind: "Bag", items: [text("a"), text("b")] },
    };
    const item = occurrence(list);
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [item],
          targetDrafts: targets(
            existingEntry(item, { intent: "ListAdd", value: text("c") }),
          ),
        }),
      ),
    ).toEqual({
      kind: "List",
      value: { list_kind: "Bag", items: [text("a"), text("b"), text("c")] },
    });
    expect(
      valueOf(
        buildEffectiveMetadataForFile({
          occurrences: [item],
          targetDrafts: targets(
            existingEntry(item, { intent: "ListRemove", value: text("a") }),
          ),
        }),
      ),
    ).toEqual({
      kind: "List",
      value: { list_kind: "Bag", items: [text("b")] },
    });
  });

  it("does not mutate occurrences or target drafts", () => {
    const item = occurrence(text("disk"));
    const targetDrafts = targets(
      existingEntry(item, { intent: "Set", value: text("pending") }),
    );
    const snapshot = structuredClone({ item, targetDrafts });
    buildEffectiveMetadataForFile({ occurrences: [item], targetDrafts });
    expect({ item, targetDrafts }).toEqual(snapshot);
  });
});
