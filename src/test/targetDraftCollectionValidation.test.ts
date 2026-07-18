import { describe, expect, it, vi } from "vitest";
import type {
  MetadataTargetDraftEntry,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  targetDraftsToWire,
  validateTargetDraftCollection,
  type TargetDraftCollection,
} from "../targetDraftEdits";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

const schema = (tagId = "282"): SchemaDefinitionId => ({
  table: "Exif::Main",
  tag_id: tagId,
});

const target = (path = "JPEG-APP1-IFD0"): MetadataDraftTarget => ({
  kind: "ExistingOccurrence",
  occurrence_id: {
    document: null,
    path,
    runtime_tag_id: "282",
    tag_id_scope: { table: "Exif::Main", tag_id: "282", index: null },
    copy: 0,
  },
  schema_id: schema(),
  write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "XResolution" },
});

const entry = (valueTarget = target()): MetadataTargetDraftEntry => ({
  target: valueTarget,
  edit: { intent: "Set", value: { kind: "Integer", value: 300 } },
});

const collection = (
  ...entries: MetadataTargetDraftEntry[]
): TargetDraftCollection =>
  Object.fromEntries(
    entries.map((value) => [metadataDraftTargetSlotToken(value.target), value]),
  );

describe("target-aware collection validation", () => {
  it("accepts correctly keyed collections", () => {
    expect(() =>
      validateTargetDraftCollection("photo.jpg", collection(entry())),
    ).not.toThrow();
  });

  it("rejects an incorrect record key with full context", () => {
    const value = entry();
    expect(() =>
      validateTargetDraftCollection("folder/photo.jpg", { wrong: value }),
    ).toThrow(
      /folder\/photo\.jpg.*wrong.*expected slot token.*complete target/,
    );
  });

  it("rejects duplicate logical slots under different malformed keys", () => {
    const first = entry();
    const second = entry(structuredClone(first.target));
    expect(() =>
      validateTargetDraftCollection("photo.jpg", { first, second }),
    ).toThrow(
      /supplied record key.*expected slot token.*complete target.*duplicate target/,
    );
  });

  it("targetDraftsToWire validates the whole input before conversion", () => {
    const drafts = {
      "a-valid.jpg": collection(entry()),
      "z-invalid.jpg": { wrong: entry(target("JPEG-APP1-IFD1")) },
    };
    const before = structuredClone(drafts);
    expect(() => targetDraftsToWire(drafts)).toThrow(/z-invalid\.jpg/);
    expect(drafts).toEqual(before);
  });

  it("failed reset is atomic and silent", () => {
    const store = new TargetDraftEditsStore();
    store.resetMetadata({ "before.jpg": collection(entry()) });
    const before = store.getAllMetadata();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(() =>
      store.resetMetadata({ "bad.jpg": { wrong: entry() } }),
    ).toThrow(/bad\.jpg/);
    expect(store.getAllMetadata()).toBe(before);
    expect(store.getAllMetadata()).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("valid reset stays silent and defensively clones target snapshots", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const value = entry();
    const initial = { "photo.jpg": collection(value) };
    store.resetMetadata(initial);

    expect(listener).not.toHaveBeenCalled();
    expect(store.getAllMetadata()).not.toBe(initial);
    expect(
      Object.values(store.getMetadataFile("photo.jpg")!)[0].target,
    ).not.toBe(value.target);
  });

  it("retains strict typed-wire duplicate rejection", () => {
    const value = entry();
    expect(() =>
      targetDraftsFromWire({
        "photo.jpg": [
          value,
          { ...value, target: structuredClone(value.target) },
        ],
      }),
    ).toThrow(/Duplicate target draft slot/);
  });
});
