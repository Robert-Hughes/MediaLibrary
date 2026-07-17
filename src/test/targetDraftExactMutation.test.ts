import { describe, expect, it, vi } from "vitest";
import {
  TargetDraftEditsStore,
  targetDraftsToWire,
  validateTargetDraftCollection,
} from "../targetDraftEdits";
import type { MetadataDraftEntryV5, MetadataDraftTarget } from "../types";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

function target(
  path: string,
  schema = "282",
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> {
  return {
    kind: "ExistingOccurrence",
    occurrence_id: {
      document: null,
      path,
      runtime_tag_id: schema,
      tag_id_scope: { table: "Exif::Main", tag_id: schema, index: null },
      copy: 0,
    },
    schema_id: { table: "Exif::Main", tag_id: schema },
    write_target: { group1: "IFD0", tag_name: `Tag${schema}` },
  };
}

function entry(
  currentTarget: MetadataDraftTarget,
  value = 1,
): MetadataDraftEntryV5 {
  return {
    target: currentTarget,
    edit: { intent: "Set", value: { kind: "Integer", value } },
  };
}

describe("TargetDraftEditsStore.applyExactMutationBatch", () => {
  it("applies mixed upsert/delete mutations across files with one notification", () => {
    const store = new TargetDraftEditsStore();
    const removed = target("remove");
    store.setMetadataTarget("a.jpg", removed, entry(removed).edit);
    const listener = vi.fn();
    store.subscribe(listener);
    const added = target("add", "283");
    expect(
      store.applyExactMutationBatch([
        { path: "a.jpg", upserts: [entry(added)], deletes: [removed] },
        { path: "b.jpg", upserts: [entry(target("b"))], deletes: [] },
      ]),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      listener.mock.calls[0][0].map((change: { path: string }) => change.path),
    ).toEqual(["a.jpg", "b.jpg"]);
  });

  it("returns false and emits nothing for an exact no-op", () => {
    const store = new TargetDraftEditsStore();
    const current = entry(target("same"));
    store.setMetadataBatch("a.jpg", [current]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(
      store.applyExactMutationBatch([
        { path: "a.jpg", upserts: [structuredClone(current)], deletes: [] },
      ]),
    ).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects changed deletion and upsert snapshots before mutation", () => {
    const store = new TargetDraftEditsStore();
    const current = target("same");
    store.setMetadataTarget("a.jpg", current, entry(current).edit);
    const before = structuredClone(store.getAllMetadata());
    expect(() =>
      store.applyExactMutationBatch([
        {
          path: "a.jpg",
          upserts: [],
          deletes: [
            {
              ...current,
              write_target: { ...current.write_target, group1: "IFD1" },
            },
          ],
        },
      ]),
    ).toThrow(/complete stored target snapshot/i);
    expect(() =>
      store.applyExactMutationBatch([
        {
          path: "a.jpg",
          upserts: [
            entry({
              ...current,
              schema_id: { ...current.schema_id, index: 0 },
            }),
          ],
          deletes: [],
        },
      ]),
    ).toThrow(/complete stored target snapshot/i);
    expect(store.getAllMetadata()).toEqual(before);
  });

  it("rejects duplicate slots, conflicts and duplicate paths", () => {
    const current = target("same");
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("a.jpg", current, entry(current).edit);
    expect(() =>
      store.applyExactMutationBatch([
        {
          path: "a.jpg",
          upserts: [entry(current), entry(current)],
          deletes: [],
        },
      ]),
    ).toThrow(/duplicate logical slot/i);
    expect(() =>
      store.applyExactMutationBatch([
        { path: "a.jpg", upserts: [entry(current)], deletes: [current] },
      ]),
    ).toThrow(/both deleted and upserted/i);
    expect(() =>
      store.applyExactMutationBatch([
        { path: "a.jpg", upserts: [], deletes: [] },
        { path: "a.jpg", upserts: [], deletes: [] },
      ]),
    ).toThrow(/duplicate path/i);
  });

  it("keeps an earlier valid file unchanged when a later file is invalid", () => {
    const store = new TargetDraftEditsStore();
    const existing = target("existing");
    store.setMetadataTarget("b.jpg", existing, entry(existing).edit);
    const before = structuredClone(store.getAllMetadata());
    expect(() =>
      store.applyExactMutationBatch([
        { path: "a.jpg", upserts: [entry(target("new"))], deletes: [] },
        { path: "b.jpg", upserts: [], deletes: [target("wrong")] },
      ]),
    ).toThrow();
    expect(store.getAllMetadata()).toEqual(before);
  });

  it("deeply isolates upsert and deletion inputs while preserving unrelated files", () => {
    const store = new TargetDraftEditsStore();
    const retained = entry(target("retained"));
    store.setMetadataBatch("retained.jpg", [retained]);
    const retainedCollection = store.getMetadataFile("retained.jpg");

    const deletedTarget = target("deleted");
    store.setMetadataTarget(
      "deleted.jpg",
      deletedTarget,
      entry(deletedTarget).edit,
    );
    const deletionInput = structuredClone(deletedTarget);
    const input = entry(target("reserved"));
    const expected = structuredClone(input);
    const originalSlot = metadataDraftTargetSlotToken(input.target);
    store.applyExactMutationBatch([
      { path: "__proto__", upserts: [input], deletes: [] },
      { path: "deleted.jpg", upserts: [], deletes: [deletionInput] },
    ]);

    if (input.target.kind !== "ExistingOccurrence") throw new Error();
    input.target.occurrence_id.tag_id_scope.table = "Changed::Runtime";
    input.target.occurrence_id.tag_id_scope.tag_id = "changed";
    input.target.occurrence_id.tag_id_scope.index = 7;
    input.target.schema_id.tag_id = "changed";
    input.edit.intent = "Delete";
    deletionInput.occurrence_id.tag_id_scope.table = "Changed::Deletion";
    deletionInput.occurrence_id.tag_id_scope.tag_id = "changed";
    deletionInput.occurrence_id.tag_id_scope.index = 8;

    const collection = store.getMetadataFile("__proto__")!;
    expect(Object.keys(collection)).toEqual([originalSlot]);
    expect(collection[originalSlot]).toEqual(expected);
    expect(() =>
      validateTargetDraftCollection("__proto__", collection),
    ).not.toThrow();
    expect(targetDraftsToWire(store.getAllMetadata()).__proto__).toEqual([
      expected,
    ]);
    expect(store.getMetadataFile("deleted.jpg")).toBeUndefined();
    expect(store.getMetadataFile("retained.jpg")).toBe(retainedCollection);
  });
});
