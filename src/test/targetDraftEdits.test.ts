import { describe, expect, it, vi } from "vitest";
import type {
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  targetDraftsToWire,
  type TargetDraftEditsByFile,
} from "../targetDraftEdits";
import {
  metadataDraftTargetSlotToken,
  metadataDraftTargetToken,
} from "../utils/metadataDraftTarget";

interface ExistingOptions {
  document?: string | null;
  path?: string;
  occurrenceTag?: string;
  copy?: number;
  table?: string;
  schemaTag?: string;
  index?: number;
  group1?: string;
  tagName?: string;
}

function schema(
  table = "Exif::Main",
  tagId = "282",
  index?: number,
): SchemaDefinitionId {
  return {
    table,
    tag_id: tagId,
    ...(index === undefined ? {} : { index }),
  };
}

function existing(
  options: ExistingOptions = {},
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> {
  return {
    kind: "ExistingOccurrence",
    occurrence_id: {
      document: options.document ?? null,
      path: options.path ?? "JPEG-APP1-IFD0",
      tag_id: options.occurrenceTag ?? "282",
      copy: options.copy ?? 0,
    },
    schema_id: schema(options.table, options.schemaTag, options.index),
    write_target: {
      group1: options.group1 ?? "IFD0",
      tag_name: options.tagName ?? "XResolution",
    },
  };
}

function created(
  id: SchemaDefinitionId = schema(),
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> {
  return { kind: "NewProperty", schema_id: id };
}

function text(value: string): MetadataValue {
  return { kind: "Text", value };
}

function setEdit(value: string | MetadataValue): MetadataDraftEdit {
  return {
    value: typeof value === "string" ? text(value) : value,
    intent: "Set",
  };
}

const deleteEdit: MetadataDraftEdit = { value: null, intent: "Delete" };
const listAddEdit: MetadataDraftEdit = {
  value: text("item"),
  intent: "ListAdd",
};
const listRemoveEdit: MetadataDraftEdit = {
  value: text("item"),
  intent: "ListRemove",
};

function entry(
  target: MetadataDraftTarget,
  edit: MetadataDraftEdit = setEdit("value"),
): MetadataDraftEntryV5 {
  return { target, edit };
}

function drafts(
  wire: Record<string, MetadataDraftEntryV5[]>,
): TargetDraftEditsByFile {
  return targetDraftsFromWire(wire);
}

describe("target draft v5 wire conversion", () => {
  it("loads existing, new-property, and mixed entries while preserving snapshots", () => {
    const existingTarget = existing({
      document: "Doc1",
      copy: 2,
      index: 0,
      group1: "IFD1",
      tagName: "YResolution",
    });
    const nestedEdit = setEdit({
      kind: "Struct",
      value: {
        nested: {
          kind: "List",
          value: { list_kind: "Seq", items: [text("one"), text("two")] },
        },
      },
    });
    const newTarget = created(schema("XMP::Main", "title"));

    const result = targetDraftsFromWire({
      "photo.jpg": [entry(existingTarget, nestedEdit), entry(newTarget)],
    });

    expect(Object.values(result["photo.jpg"])).toEqual([
      entry(existingTarget, nestedEdit),
      entry(newTarget),
    ]);
    expect(
      result["photo.jpg"][metadataDraftTargetSlotToken(existingTarget)],
    ).toEqual(entry(existingTarget, nestedEdit));
  });

  it("omits empty per-file collections", () => {
    expect(targetDraftsFromWire({ "empty.jpg": [] })).toEqual({});
    expect(targetDraftsToWire({ "empty.jpg": {} })).toEqual({});
  });

  it("rejects identical and changed-snapshot duplicate existing slots", () => {
    const original = existing();
    const changedSchema = existing({ table: "Other", schemaTag: "999" });
    const changedSelector = existing({
      group1: "IFD1",
      tagName: "YResolution",
    });

    for (const duplicate of [
      structuredClone(original),
      changedSchema,
      changedSelector,
    ]) {
      expect(() =>
        targetDraftsFromWire({
          "duplicate.jpg": [entry(original), entry(duplicate)],
        }),
      ).toThrow(/duplicate\.jpg.*ExistingOccurrence/i);
    }
  });

  it("rejects a duplicate new-property schema", () => {
    const target = created();
    expect(() =>
      targetDraftsFromWire({
        "duplicate.jpg": [entry(target), entry(structuredClone(target))],
      }),
    ).toThrow(/Duplicate target draft slot/);
  });

  it("accepts shared-schema occurrences and cross-variant shared schemas", () => {
    const first = existing({ path: "JPEG-APP1-IFD0" });
    const second = existing({ path: "JPEG-APP1-IFD1", group1: "IFD1" });
    const result = targetDraftsFromWire({
      "photo.jpg": [
        entry(first),
        entry(second),
        entry(created(first.schema_id)),
      ],
    });
    expect(Object.keys(result["photo.jpg"])).toHaveLength(3);
  });

  it("sorts files by Unicode scalar order", () => {
    const result = targetDraftsToWire(
      drafts({
        "\u{10000}.jpg": [entry(created(schema("B", "1")))],
        "\u{e000}.jpg": [entry(created(schema("A", "1")))],
      }),
    );
    expect(Object.keys(result)).toEqual(["\u{e000}.jpg", "\u{10000}.jpg"]);
  });

  it("sorts entries by logical slot rather than insertion or snapshot order", () => {
    const newB = created(schema("B", "tag"));
    const newA = created(schema("A", "tag"));
    const existingB = existing({ path: "IFD1", table: "Z" });
    const existingA = existing({ path: "IFD0", table: "Z" });
    const result = targetDraftsToWire(
      drafts({
        "photo.jpg": [
          entry(newB),
          entry(existingB),
          entry(newA),
          entry(existingA),
        ],
      }),
    );

    expect(result["photo.jpg"].map(({ target }) => target)).toEqual([
      existingA,
      existingB,
      newA,
      newB,
    ]);
  });

  it("produces identical output regardless of record insertion order", () => {
    const a = entry(existing({ path: "IFD0" }), setEdit("a"));
    const b = entry(created(schema("B", "tag")), setEdit("b"));
    const first = drafts({ "z.jpg": [b, a], "a.jpg": [a, b] });
    const second = drafts({ "a.jpg": [b, a], "z.jpg": [a, b] });
    expect(targetDraftsToWire(first)).toEqual(targetDraftsToWire(second));
  });

  it("does not mutate source wire arrays or source collections", () => {
    const wire = { "photo.jpg": [entry(created()), entry(existing())] };
    const wireBefore = structuredClone(wire);
    const collection = targetDraftsFromWire(wire);
    const collectionBefore = structuredClone(collection);

    targetDraftsToWire(collection);

    expect(wire).toEqual(wireBefore);
    expect(collection).toEqual(collectionBefore);
  });

  it("keeps absent index distinct from zero and handles delimiter/non-BMP identities", () => {
    const targets = [
      created(schema("A:B", "C")),
      created(schema("A", "B:C")),
      created(schema("\u{10000}", "tag")),
      created(schema("table", "tag")),
      created(schema("table", "tag", 0)),
    ];
    const result = targetDraftsFromWire({
      "photo.jpg": targets.map((target) => entry(target)),
    });
    expect(Object.keys(result["photo.jpg"])).toHaveLength(targets.length);
    expect(
      result["photo.jpg"][metadataDraftTargetSlotToken(targets[3])],
    ).toBeDefined();
    expect(
      result["photo.jpg"][metadataDraftTargetSlotToken(targets[4])],
    ).toBeDefined();
  });
});

describe("TargetDraftEditsStore basic state", () => {
  it("starts empty, silently resets, and gets one file", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getAllMetadata()).toEqual({});

    const initial = drafts({ "photo.jpg": [entry(existing())] });
    store.resetMetadata(initial);

    expect(store.getMetadataFile("photo.jpg")).toEqual(initial["photo.jpg"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("sets existing and new targets", () => {
    const store = new TargetDraftEditsStore();
    const oldTarget = existing();
    const newTarget = created();
    expect(
      store.setMetadataTarget("photo.jpg", oldTarget, setEdit("old")),
    ).toBe("written");
    expect(
      store.setMetadataTarget("photo.jpg", newTarget, setEdit("new")),
    ).toBe("written");
    expect(Object.keys(store.getMetadataFile("photo.jpg")!)).toHaveLength(2);
  });

  it("deletes one path, several paths, and clears", () => {
    const store = new TargetDraftEditsStore();
    store.resetMetadata(
      drafts({
        "a.jpg": [entry(existing())],
        "b.jpg": [entry(created())],
        "c.jpg": [entry(existing({ path: "IFD1" }))],
      }),
    );
    store.deletePath("a.jpg");
    expect(store.getMetadataFile("a.jpg")).toBeUndefined();
    store.deletePaths(["b.jpg"]);
    expect(store.getMetadataFile("b.jpg")).toBeUndefined();
    store.clear();
    expect(store.getAllMetadata()).toEqual({});
  });
});

describe("TargetDraftEditsStore slot replacement", () => {
  it("replaces edit, schema snapshot, and selector snapshot in one occurrence slot", () => {
    const store = new TargetDraftEditsStore();
    const original = existing();
    store.setMetadataTarget("photo.jpg", original, setEdit("one"));

    store.setMetadataTarget(
      "photo.jpg",
      structuredClone(original),
      setEdit("same snapshot"),
    );
    expect(Object.values(store.getMetadataFile("photo.jpg")!)).toEqual([
      entry(original, setEdit("same snapshot")),
    ]);

    const changedSchema = existing({ table: "Other", schemaTag: "999" });
    store.setMetadataTarget("photo.jpg", changedSchema, setEdit("two"));
    let stored = Object.values(store.getMetadataFile("photo.jpg")!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(entry(changedSchema, setEdit("two")));

    const changedSelector = existing({
      group1: "IFD1",
      tagName: "YResolution",
    });
    store.setMetadataTarget("photo.jpg", changedSelector, setEdit("three"));
    stored = Object.values(store.getMetadataFile("photo.jpg")!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(entry(changedSelector, setEdit("three")));
  });

  it("keeps shared-schema IFD0/IFD1 occurrences and cross-variant targets separate", () => {
    const store = new TargetDraftEditsStore();
    const ifd0 = existing({ path: "IFD0", group1: "IFD0" });
    const ifd1 = existing({ path: "IFD1", group1: "IFD1" });
    store.setMetadataTarget("photo.jpg", ifd0, setEdit("ifd0"));
    store.setMetadataTarget("photo.jpg", ifd1, setEdit("ifd1"));
    store.setMetadataTarget(
      "photo.jpg",
      created(ifd0.schema_id),
      setEdit("new"),
    );
    expect(Object.keys(store.getMetadataFile("photo.jpg")!)).toHaveLength(3);
  });

  it("replaces two new-property targets for the same schema", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("photo.jpg", created(), setEdit("one"));
    store.setMetadataTarget("photo.jpg", created(), setEdit("two"));
    expect(Object.values(store.getMetadataFile("photo.jpg")!)).toEqual([
      entry(created(), setEdit("two")),
    ]);
  });
});

describe("TargetDraftEditsStore redundant Set guard", () => {
  it("passes complete targets and can distinguish IFD0 from IFD1", () => {
    const store = new TargetDraftEditsStore();
    const resolver = vi.fn((_path: string, target: MetadataDraftTarget) =>
      target.kind === "ExistingOccurrence" &&
      target.write_target.group1 === "IFD0"
        ? text("ifd0")
        : text("ifd1"),
    );
    store.setCurrentValueResolver(resolver);
    const ifd0 = existing({ path: "IFD0", group1: "IFD0" });
    const ifd1 = existing({ path: "IFD1", group1: "IFD1" });

    expect(store.setMetadataTarget("photo.jpg", ifd0, setEdit("ifd0"))).toBe(
      "redundant",
    );
    expect(
      store.setMetadataTarget("photo.jpg", ifd1, setEdit("different")),
    ).toBe("written");
    expect(resolver.mock.calls[0][1]).toBe(ifd0);
    expect(resolver.mock.calls[1][1]).toBe(ifd1);
  });

  it("returns redundant without a draft, clears a same-slot draft, and writes differences", () => {
    const store = new TargetDraftEditsStore();
    const target = existing();
    store.setCurrentValueResolver(() => text("current"));
    expect(
      store.setMetadataTarget("photo.jpg", target, setEdit("current")),
    ).toBe("redundant");
    expect(store.setMetadataTarget("photo.jpg", target, setEdit("draft"))).toBe(
      "written",
    );
    expect(
      store.setMetadataTarget("photo.jpg", target, setEdit("current")),
    ).toBe("cleared");
    expect(store.getMetadataFile("photo.jpg")).toBeUndefined();
  });

  it("always writes Delete, ListAdd, and ListRemove", () => {
    for (const editValue of [deleteEdit, listAddEdit, listRemoveEdit]) {
      const store = new TargetDraftEditsStore();
      store.setCurrentValueResolver(() => editValue.value ?? undefined);
      expect(store.setMetadataTarget("photo.jpg", existing(), editValue)).toBe(
        "written",
      );
    }
  });
});

describe("TargetDraftEditsStore batch atomicity", () => {
  it("writes a valid batch, notifies once, and preserves result input order", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const first = existing({ path: "IFD1", group1: "IFD1" });
    const second = existing({ path: "IFD0", group1: "IFD0" });
    const results = store.setMetadataBatch("photo.jpg", [
      entry(first, setEdit("one")),
      entry(second, setEdit("two")),
    ]);

    expect(results.map(({ target }) => target)).toEqual([first, second]);
    expect(results.map(({ outcome }) => outcome)).toEqual([
      "written",
      "written",
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate existing slots before mutation, including changed snapshots", () => {
    const duplicates = [
      existing(),
      existing({ table: "Other" }),
      existing({ group1: "IFD1" }),
    ];
    for (const duplicate of duplicates) {
      const store = new TargetDraftEditsStore();
      store.resetMetadata(drafts({ "kept.jpg": [entry(created())] }));
      const before = store.getAllMetadata();
      const listener = vi.fn();
      store.subscribe(listener);

      expect(() =>
        store.setMetadataBatch("photo.jpg", [
          entry(existing()),
          entry(duplicate),
        ]),
      ).toThrow(/Duplicate target draft slot in batch/);
      expect(store.getAllMetadata()).toBe(before);
      expect(listener).not.toHaveBeenCalled();
    }
  });

  it("rejects duplicate new-property slots before mutation", () => {
    const store = new TargetDraftEditsStore();
    const before = store.getAllMetadata();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.setMetadataBatch("photo.jpg", [entry(created()), entry(created())]),
    ).toThrow(/Duplicate target draft slot in batch/);
    expect(store.getAllMetadata()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("accepts two shared-schema distinct occurrences", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch("photo.jpg", [
      entry(existing({ path: "IFD0" })),
      entry(existing({ path: "IFD1", group1: "IFD1" })),
    ]);
    expect(Object.keys(store.getMetadataFile("photo.jpg")!)).toHaveLength(2);
  });
});

describe("TargetDraftEditsStore notifications and immutability", () => {
  it("notifies once for a successful single mutation and not for a no-op delete", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setMetadataTarget("photo.jpg", existing(), setEdit("one"));
    expect(listener).toHaveBeenCalledTimes(1);
    store.deleteTarget("photo.jpg", existing({ path: "missing" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports unsubscribe and keeps reset silent", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.resetMetadata(drafts({ "photo.jpg": [entry(existing())] }));
    unsubscribe();
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it("deletes several paths with one change list", () => {
    const store = new TargetDraftEditsStore();
    store.resetMetadata(
      drafts({ "a.jpg": [entry(existing())], "b.jpg": [entry(created())] }),
    );
    const listener = vi.fn();
    store.subscribe(listener);
    store.deletePaths(["a.jpg", "b.jpg"]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([
      { path: "a.jpg", edits: undefined },
      { path: "b.jpg", edits: undefined },
    ]);
  });

  it("does not mutate source targets and isolates stored target snapshots", () => {
    const store = new TargetDraftEditsStore();
    const target = existing();
    const before = structuredClone(target);
    store.setMetadataTarget("photo.jpg", target, setEdit("one"));
    expect(target).toEqual(before);

    target.occurrence_id.path = "changed";
    target.schema_id.table = "changed";
    target.write_target.group1 = "changed";
    const stored = Object.values(store.getMetadataFile("photo.jpg")!)[0].target;
    expect(stored).toEqual(before);
  });

  it("replaces snapshot references while retaining unrelated file references", () => {
    const store = new TargetDraftEditsStore();
    store.resetMetadata(
      drafts({ "a.jpg": [entry(existing())], "b.jpg": [entry(created())] }),
    );
    const before = store.getAllMetadata();
    const unrelated = before["b.jpg"];
    store.setMetadataTarget("a.jpg", existing(), setEdit("changed"));
    expect(store.getAllMetadata()).not.toBe(before);
    expect(store.getMetadataFile("b.jpg")).toBe(unrelated);
  });
});

describe("TargetDraftEditsStore slot-based deletion and pruning", () => {
  it("deletes an existing slot using stale selector or schema snapshots", () => {
    for (const stale of [
      existing({ group1: "IFD1", tagName: "YResolution" }),
      existing({ table: "Other", schemaTag: "999" }),
    ]) {
      const store = new TargetDraftEditsStore();
      store.setMetadataTarget("photo.jpg", existing(), setEdit("one"));
      store.deleteTarget("photo.jpg", stale);
      expect(store.getMetadataFile("photo.jpg")).toBeUndefined();
    }
  });

  it("does not cross-delete an existing and new target sharing a schema", () => {
    const store = new TargetDraftEditsStore();
    const oldTarget = existing();
    const newTarget = created(oldTarget.schema_id);
    store.setMetadataTarget("photo.jpg", oldTarget, setEdit("old"));
    store.setMetadataTarget("photo.jpg", newTarget, setEdit("new"));
    store.deleteTarget("photo.jpg", newTarget);
    const remaining = Object.values(store.getMetadataFile("photo.jpg")!);
    expect(remaining).toHaveLength(1);
    expect(metadataDraftTargetToken(remaining[0].target)).toBe(
      metadataDraftTargetToken(oldTarget),
    );
  });

  it("deletes several targets by their logical slots with one notification", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch("photo.jpg", [
      entry(existing({ path: "IFD0" })),
      entry(existing({ path: "IFD1", group1: "IFD1" })),
      entry(created()),
    ]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.deleteTargets("photo.jpg", [
      existing({ path: "IFD0", group1: "stale" }),
      created(),
    ]);

    expect(Object.keys(store.getMetadataFile("photo.jpg")!)).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("prunes by logical slot identity", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("photo.jpg", existing(), setEdit("one"));
    store.pruneTargets("photo.jpg", [existing({ group1: "IFD1" })]);
    expect(store.getMetadataFile("photo.jpg")).toBeUndefined();
  });
});
