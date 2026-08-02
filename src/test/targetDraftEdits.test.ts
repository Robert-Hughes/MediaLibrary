import { describe, expect, it, vi } from "vitest";
import type {
  MetadataDraftEdit,
  MetadataTargetDraftEntry,
  MetadataDraftTarget,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import {
  TargetDraftEditsStore,
  metadataTargetDraftEntryEqualsExact,
  targetDraftCollectionEqualsExact,
  targetDraftsFromWire,
  targetDraftsToWire,
  validateTargetDraftCollection,
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
      runtime_tag_id: options.occurrenceTag ?? "282",
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: options.occurrenceTag ?? "282",
        index: null,
      },
      copy: options.copy ?? 0,
    },
    schema_id: schema(options.table, options.schemaTag, options.index),
    write_target: {
      group1: options.group1 ?? "IFD0",
      group7: "ID-Test",
      tag_name: options.tagName ?? "XResolution",
    },
  };
}

function created(
  id: SchemaDefinitionId = schema(),
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> {
  return {
    kind: "NewProperty",
    schema_id: id,
    write_target: {
      group1: "XMP-test",
      group7: "ID-Test",
      tag_name: "TestTag",
    },
  };
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
): MetadataTargetDraftEntry {
  return { target, edit };
}

function drafts(
  wire: Record<string, MetadataTargetDraftEntry[]>,
): TargetDraftEditsByFile {
  return targetDraftsFromWire(wire);
}

const reservedPaths = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
] as const;

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

describe("target draft target-aware wire conversion", () => {
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
      "file.jpg": [entry(existingTarget, nestedEdit), entry(newTarget)],
    });

    expect(Object.values(result["file.jpg"])).toEqual([
      entry(existingTarget, nestedEdit),
      entry(newTarget),
    ]);
    expect(
      result["file.jpg"][metadataDraftTargetSlotToken(existingTarget)],
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
      "file.jpg": [
        entry(first),
        entry(second),
        entry(created(first.schema_id)),
      ],
    });
    expect(Object.keys(result["file.jpg"])).toHaveLength(3);
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
        "file.jpg": [
          entry(newB),
          entry(existingB),
          entry(newA),
          entry(existingA),
        ],
      }),
    );

    expect(result["file.jpg"].map(({ target }) => target)).toEqual([
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
    const wire = { "file.jpg": [entry(created()), entry(existing())] };
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
      "file.jpg": targets.map((target) => entry(target)),
    });
    expect(Object.keys(result["file.jpg"])).toHaveLength(targets.length);
    expect(
      result["file.jpg"][metadataDraftTargetSlotToken(targets[3])],
    ).toBeDefined();
    expect(
      result["file.jpg"][metadataDraftTargetSlotToken(targets[4])],
    ).toBeDefined();
  });
});

describe("target draft target-aware reserved-path wire conversion", () => {
  it.each(reservedPaths)(
    "preserves %s through typed and unknown wire",
    (path) => {
      const prototypeBefore = Object.getOwnPropertyDescriptors(
        Object.prototype,
      );
      const reservedEntry = entry(
        created(schema("Reserved", path)),
        setEdit(path),
      );
      const siblingEntry = entry(existing(), setEdit("sibling"));
      const wire = Object.fromEntries([
        [path, [reservedEntry]],
        ["ordinary/file.jpg", [siblingEntry]],
      ]) as Record<string, MetadataTargetDraftEntry[]>;

      const typed = targetDraftsFromWire(wire);
      expect(Object.keys(typed)).toContain(path);
      expect(hasOwn(typed, path)).toBe(true);
      expect(
        typed[path][metadataDraftTargetSlotToken(reservedEntry.target)],
      ).toEqual(reservedEntry);
      expect(hasOwn(typed, "ordinary/file.jpg")).toBe(true);
      expect(Object.getPrototypeOf(typed)).toBe(Object.prototype);

      const outgoing = targetDraftsToWire(typed);
      expect(hasOwn(outgoing, path)).toBe(true);
      expect(outgoing[path]).toEqual([reservedEntry]);
      expect(hasOwn(outgoing, "ordinary/file.jpg")).toBe(true);
      expect(Object.getPrototypeOf(outgoing)).toBe(Object.prototype);

      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(
        prototypeBefore,
      );
    },
  );
});

describe("TargetDraftEditsStore basic state", () => {
  it("starts empty, silently resets, and gets one file", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getAllMetadata()).toEqual({});

    const initial = drafts({ "file.jpg": [entry(existing())] });
    store.resetMetadata(initial);

    expect(store.getMetadataFile("file.jpg")).toEqual(initial["file.jpg"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("sets existing and new targets", () => {
    const store = new TargetDraftEditsStore();
    const oldTarget = existing();
    const newTarget = created();
    expect(store.setMetadataTarget("file.jpg", oldTarget, setEdit("old"))).toBe(
      "written",
    );
    expect(store.setMetadataTarget("file.jpg", newTarget, setEdit("new"))).toBe(
      "written",
    );
    expect(Object.keys(store.getMetadataFile("file.jpg")!)).toHaveLength(2);
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

describe("TargetDraftEditsStore reserved paths", () => {
  it("does not expose inherited prototype names from an empty store", () => {
    const store = new TargetDraftEditsStore();
    for (const path of reservedPaths) {
      expect(store.getMetadataFile(path)).toBeUndefined();
    }
    expect(Object.keys(store.getAllMetadata())).toEqual([]);
  });

  it("stores exact own collections and retains one file for a second target", () => {
    const store = new TargetDraftEditsStore();
    const first = existing();
    const second = created();

    store.setMetadataTarget("__proto__", first, setEdit("first"));
    const firstCollection = store.getMetadataFile("__proto__")!;
    expect(hasOwn(store.getAllMetadata(), "__proto__")).toBe(true);
    expect(Object.keys(store.getAllMetadata())).toEqual(["__proto__"]);
    expect(firstCollection[metadataDraftTargetSlotToken(first)]).toEqual(
      entry(first, setEdit("first")),
    );

    store.setMetadataTarget("__proto__", second, setEdit("second"));
    expect(Object.keys(store.getAllMetadata())).toEqual(["__proto__"]);
    expect(Object.keys(store.getMetadataFile("__proto__")!)).toHaveLength(2);
    expect(store.getMetadataFile("__proto__")).not.toBe(firstCollection);

    store.setMetadataTarget("constructor", first, setEdit("constructor"));
    expect(hasOwn(store.getAllMetadata(), "constructor")).toBe(true);
    expect(store.getMetadataFile("constructor")).toEqual(
      Object.fromEntries([
        [
          metadataDraftTargetSlotToken(first),
          entry(first, setEdit("constructor")),
        ],
      ]),
    );
  });

  it("treats missing reserved-looking deletes as silent no-ops", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.deletePath("toString");
    store.deletePaths(["constructor", "prototype", "hasOwnProperty"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("deletes one stored reserved path with one notification", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("__proto__", existing(), setEdit("value"));
    const listener = vi.fn();
    store.subscribe(listener);

    store.deletePath("__proto__");

    expect(store.getMetadataFile("__proto__")).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith([
      { path: "__proto__", edits: undefined },
    ]);
  });

  it("deletes several reserved paths in one exact change list", () => {
    const store = new TargetDraftEditsStore();
    for (const path of reservedPaths) {
      store.setMetadataTarget(path, existing(), setEdit(path));
    }
    const listener = vi.fn();
    store.subscribe(listener);

    store.deletePaths(["constructor", "__proto__", "constructor"]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith([
      { path: "constructor", edits: undefined },
      { path: "__proto__", edits: undefined },
    ]);
    expect(store.getMetadataFile("constructor")).toBeUndefined();
    expect(store.getMetadataFile("__proto__")).toBeUndefined();
  });

  it("clear reports every exact reserved path once", () => {
    const store = new TargetDraftEditsStore();
    for (const path of reservedPaths) {
      store.setMetadataTarget(path, existing(), setEdit(path));
    }
    const listener = vi.fn();
    store.subscribe(listener);

    store.clear();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      reservedPaths.map((path) => ({ path, edits: undefined })),
    );
    expect(store.getAllMetadata()).toEqual({});
  });

  it("resets safely, stays atomic on failure, and retains unrelated references", () => {
    const store = new TargetDraftEditsStore();
    const initial = drafts(
      Object.fromEntries([
        ["__proto__", [entry(existing())]],
        ["constructor", [entry(created())]],
        ["ordinary.jpg", [entry(existing({ path: "IFD1" }))]],
      ]),
    );
    store.resetMetadata(initial);
    expect(hasOwn(store.getAllMetadata(), "__proto__")).toBe(true);
    expect(hasOwn(store.getAllMetadata(), "constructor")).toBe(true);

    const before = store.getAllMetadata();
    const ordinary = store.getMetadataFile("ordinary.jpg");
    const listener = vi.fn();
    store.subscribe(listener);
    const invalid = Object.fromEntries([
      ["__proto__", { wrong: entry(existing()) }],
    ]) as TargetDraftEditsByFile;
    expect(() => store.resetMetadata(invalid)).toThrow(/__proto__/);
    expect(store.getAllMetadata()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    store.setMetadataTarget("constructor", existing(), setEdit("changed"));
    expect(store.getMetadataFile("ordinary.jpg")).toBe(ordinary);
  });
});

describe("TargetDraftEditsStore slot replacement", () => {
  it("replaces edit, schema snapshot, and selector snapshot in one occurrence slot", () => {
    const store = new TargetDraftEditsStore();
    const original = existing();
    store.setMetadataTarget("file.jpg", original, setEdit("one"));

    store.setMetadataTarget(
      "file.jpg",
      structuredClone(original),
      setEdit("same snapshot"),
    );
    expect(Object.values(store.getMetadataFile("file.jpg")!)).toEqual([
      entry(original, setEdit("same snapshot")),
    ]);

    const changedSchema = existing({ table: "Other", schemaTag: "999" });
    store.setMetadataTarget("file.jpg", changedSchema, setEdit("two"));
    let stored = Object.values(store.getMetadataFile("file.jpg")!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(entry(changedSchema, setEdit("two")));

    const changedSelector = existing({
      group1: "IFD1",
      tagName: "YResolution",
    });
    store.setMetadataTarget("file.jpg", changedSelector, setEdit("three"));
    stored = Object.values(store.getMetadataFile("file.jpg")!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(entry(changedSelector, setEdit("three")));
  });

  it("keeps shared-schema IFD0/IFD1 occurrences and cross-variant targets separate", () => {
    const store = new TargetDraftEditsStore();
    const ifd0 = existing({ path: "IFD0", group1: "IFD0" });
    const ifd1 = existing({ path: "IFD1", group1: "IFD1" });
    store.setMetadataTarget("file.jpg", ifd0, setEdit("ifd0"));
    store.setMetadataTarget("file.jpg", ifd1, setEdit("ifd1"));
    store.setMetadataTarget(
      "file.jpg",
      created(ifd0.schema_id),
      setEdit("new"),
    );
    expect(Object.keys(store.getMetadataFile("file.jpg")!)).toHaveLength(3);
  });

  it("replaces two new-property targets for the same schema", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("file.jpg", created(), setEdit("one"));
    store.setMetadataTarget("file.jpg", created(), setEdit("two"));
    expect(Object.values(store.getMetadataFile("file.jpg")!)).toEqual([
      entry(created(), setEdit("two")),
    ]);
  });
});

describe("TargetDraftEditsStore redundant Set guard", () => {
  const list = (
    listKind: "Bag" | "Seq",
    items: MetadataValue[],
  ): MetadataValue => ({
    kind: "List",
    value: { list_kind: listKind, items },
  });

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

    expect(store.setMetadataTarget("file.jpg", ifd0, setEdit("ifd0"))).toBe(
      "redundant",
    );
    expect(
      store.setMetadataTarget("file.jpg", ifd1, setEdit("different")),
    ).toBe("written");
    expect(resolver.mock.calls[0][1]).toBe(ifd0);
    expect(resolver.mock.calls[1][1]).toBe(ifd1);
  });

  it("returns redundant without a draft, clears a same-slot draft, and writes differences", () => {
    const store = new TargetDraftEditsStore();
    const target = existing();
    store.setCurrentValueResolver(() => text("current"));
    expect(
      store.setMetadataTarget("file.jpg", target, setEdit("current")),
    ).toBe("redundant");
    expect(store.setMetadataTarget("file.jpg", target, setEdit("draft"))).toBe(
      "written",
    );
    expect(
      store.setMetadataTarget("file.jpg", target, setEdit("current")),
    ).toBe("cleared");
    expect(store.getMetadataFile("file.jpg")).toBeUndefined();
  });

  it("always writes Delete, ListAdd, and ListRemove", () => {
    for (const editValue of [deleteEdit, listAddEdit, listRemoveEdit]) {
      const store = new TargetDraftEditsStore();
      store.setCurrentValueResolver(() => editValue.value ?? undefined);
      expect(store.setMetadataTarget("file.jpg", existing(), editValue)).toBe(
        "written",
      );
    }
  });

  it("compares every list element, with ordered Seq and unordered Bag semantics", () => {
    const target = existing();
    const store = new TargetDraftEditsStore();
    store.setCurrentValueResolver(() =>
      list("Seq", [text("one"), text("two")]),
    );
    expect(
      store.setMetadataTarget(
        "file.jpg",
        target,
        setEdit(list("Seq", [text("one"), text("two")])),
      ),
    ).toBe("redundant");
    expect(
      store.setMetadataTarget(
        "file.jpg",
        target,
        setEdit(list("Seq", [text("two"), text("one")])),
      ),
    ).toBe("written");

    const bags = new TargetDraftEditsStore();
    bags.setCurrentValueResolver(() => list("Bag", [text("one"), text("two")]));
    expect(
      bags.setMetadataTarget(
        "file.jpg",
        target,
        setEdit(list("Bag", [text("two"), text("one")])),
      ),
    ).toBe("redundant");
    expect(
      bags.setMetadataTarget(
        "file.jpg",
        target,
        setEdit(list("Bag", [text("one"), text("changed")])),
      ),
    ).toBe("written");
  });

  it("ignores struct insertion order but detects a changed nested child", () => {
    const current: MetadataValue = {
      kind: "Struct",
      value: {
        alpha: text("a"),
        nested: list("Seq", [text("one"), text("two")]),
      },
    };
    const reordered: MetadataValue = {
      kind: "Struct",
      value: {
        nested: list("Seq", [text("one"), text("two")]),
        alpha: text("a"),
      },
    };
    const changed = structuredClone(reordered);
    if (changed.kind !== "Struct") throw new Error("Expected struct");
    changed.value.nested = list("Seq", [text("one"), text("changed")]);
    const store = new TargetDraftEditsStore();
    store.setCurrentValueResolver(() => current);
    expect(
      store.setMetadataTarget("file.jpg", existing(), setEdit(reordered)),
    ).toBe("redundant");
    expect(
      store.setMetadataTarget("file.jpg", existing(), setEdit(changed)),
    ).toBe("written");
  });
});

describe("TargetDraftEditsStore batch atomicity", () => {
  it("returns mixed outcomes in input order, notifies once, and skips all-no-op batches", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const redundant = existing({ path: "redundant" });
    const written = existing({ path: "written" });
    store.setCurrentValueResolver((_path, target) =>
      target.kind === "ExistingOccurrence" &&
      target.occurrence_id.path === "redundant"
        ? text("disk")
        : text("other"),
    );
    const results = store.setMetadataBatch("file.jpg", [
      entry(redundant, setEdit("disk")),
      entry(written, setEdit("draft")),
    ]);
    expect(results.map(({ outcome }) => outcome)).toEqual([
      "redundant",
      "written",
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();
    expect(store.setMetadataBatch("other.jpg", [])).toEqual([]);
    expect(
      store.setMetadataBatch("other.jpg", [entry(redundant, setEdit("disk"))]),
    ).toEqual([{ target: redundant, outcome: "redundant" }]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("writes a valid batch, notifies once, and preserves result input order", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const first = existing({ path: "IFD1", group1: "IFD1" });
    const second = existing({ path: "IFD0", group1: "IFD0" });
    const results = store.setMetadataBatch("file.jpg", [
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
        store.setMetadataBatch("file.jpg", [
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
      store.setMetadataBatch("file.jpg", [entry(created()), entry(created())]),
    ).toThrow(/Duplicate target draft slot in batch/);
    expect(store.getAllMetadata()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("accepts two shared-schema distinct occurrences", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch("file.jpg", [
      entry(existing({ path: "IFD0" })),
      entry(existing({ path: "IFD1", group1: "IFD1" })),
    ]);
    expect(Object.keys(store.getMetadataFile("file.jpg")!)).toHaveLength(2);
  });
});

describe("TargetDraftEditsStore notifications and immutability", () => {
  it("notifies once for a successful single mutation and not for a no-op delete", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setMetadataTarget("file.jpg", existing(), setEdit("one"));
    expect(listener).toHaveBeenCalledTimes(1);
    store.deleteTarget("file.jpg", existing({ path: "missing" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports unsubscribe and keeps reset silent", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.resetMetadata(drafts({ "file.jpg": [entry(existing())] }));
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

  it("deeply isolates complete targets, slot identity, and wire snapshots", () => {
    const store = new TargetDraftEditsStore();
    const target = existing({ document: "Doc1", copy: 2, index: 3 });
    const before = structuredClone(target);
    const originalSlot = metadataDraftTargetSlotToken(before);
    store.setMetadataTarget("file.jpg", target, setEdit("one"));
    expect(target).toEqual(before);

    target.occurrence_id.document = "Doc2";
    target.occurrence_id.path = "changed";
    target.occurrence_id.runtime_tag_id = "changed";
    target.occurrence_id.tag_id_scope.table = "Changed::Runtime";
    target.occurrence_id.tag_id_scope.tag_id = "changed";
    target.occurrence_id.tag_id_scope.index = 99;
    target.occurrence_id.copy = 99;
    target.schema_id.table = "changed";
    target.schema_id.tag_id = "changed";
    target.schema_id.index = 99;
    target.write_target.group1 = "changed";
    target.write_target.tag_name = "changed";

    const collection = store.getMetadataFile("file.jpg")!;
    expect(Object.keys(collection)).toEqual([originalSlot]);
    expect(collection[originalSlot].target).toEqual(before);
    expect(() =>
      validateTargetDraftCollection("file.jpg", collection),
    ).not.toThrow();
    expect(targetDraftsToWire(store.getAllMetadata())).toEqual({
      "file.jpg": [entry(before, setEdit("one"))],
    });
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

describe("TargetDraftEditsStore authoritative replacement", () => {
  it("handles empty replacement, exact no-op, and complete replacement", () => {
    const store = new TargetDraftEditsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.replaceMetadataFile("file.jpg", [])).toBe(false);

    const first = entry(existing(), setEdit("one"));
    expect(store.replaceMetadataFile("file.jpg", [first])).toBe(true);
    const snapshot = store.getAllMetadata();
    const collection = store.getMetadataFile("file.jpg");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      store.replaceMetadataFile("file.jpg", [structuredClone(first)]),
    ).toBe(false);
    expect(store.getAllMetadata()).toBe(snapshot);
    expect(store.getMetadataFile("file.jpg")).toBe(collection);

    const replacement = entry(created(), setEdit("two"));
    expect(store.replaceMetadataFile("file.jpg", [replacement])).toBe(true);
    expect(Object.values(store.getMetadataFile("file.jpg")!)).toEqual([
      replacement,
    ]);
    expect(store.replaceMetadataFile("file.jpg", [])).toBe(true);
    expect(store.getMetadataFile("file.jpg")).toBeUndefined();
  });

  it("uses complete target and exact edit equality", () => {
    const base = entry(
      existing(),
      setEdit({ kind: "Rational", value: { numerator: 1, denominator: 2 } }),
    );
    const changedTarget = entry(existing({ group1: "IFD1" }), base.edit);
    const changedValue = entry(
      existing(),
      setEdit({ kind: "Rational", value: { numerator: 2, denominator: 4 } }),
    );
    expect(
      metadataTargetDraftEntryEqualsExact(base, structuredClone(base)),
    ).toBe(true);
    expect(metadataTargetDraftEntryEqualsExact(base, changedTarget)).toBe(
      false,
    );
    expect(metadataTargetDraftEntryEqualsExact(base, changedValue)).toBe(false);
    expect(
      targetDraftCollectionEqualsExact(
        drafts({ p: [base] }).p,
        drafts({ p: [changedValue] }).p,
      ),
    ).toBe(false);
  });

  it("does not call the resolver and deeply isolates source mutations", () => {
    const store = new TargetDraftEditsStore();
    const resolver = vi.fn();
    store.setCurrentValueResolver(resolver);
    const source = entry(
      existing(),
      setEdit({
        kind: "Unknown",
        value: { expected: null, raw: { nested: [1, 2] }, reason: null },
      }),
    );
    const expected = structuredClone(source);
    store.replaceMetadataFile("file.jpg", [source]);
    source.target.schema_id.table = "mutated";
    if (source.edit.value?.kind === "Unknown")
      source.edit.value.value.raw = { changed: true };
    expect(Object.values(store.getMetadataFile("file.jpg")!)[0]).toEqual(
      expected,
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects duplicate entries atomically", () => {
    const store = new TargetDraftEditsStore();
    store.replaceMetadataFile("kept.jpg", [entry(created())]);
    const before = store.getAllMetadata();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.replaceMetadataFile("file.jpg", [
        entry(existing()),
        entry(existing({ table: "Other" })),
      ]),
    ).toThrow(/Duplicate/);
    expect(store.getAllMetadata()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports __proto__ and retains unrelated file references", () => {
    const store = new TargetDraftEditsStore();
    store.replaceMetadataFile("other.jpg", [entry(created())]);
    const other = store.getMetadataFile("other.jpg");
    expect(store.replaceMetadataFile("__proto__", [entry(existing())])).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(store.getAllMetadata(), "__proto__"),
    ).toBe(true);
    expect(store.getMetadataFile("other.jpg")).toBe(other);
  });
});

describe("TargetDraftEditsStore slot-based deletion and pruning", () => {
  it("deletes an existing slot using stale selector or schema snapshots", () => {
    for (const stale of [
      existing({ group1: "IFD1", tagName: "YResolution" }),
      existing({ table: "Other", schemaTag: "999" }),
    ]) {
      const store = new TargetDraftEditsStore();
      store.setMetadataTarget("file.jpg", existing(), setEdit("one"));
      store.deleteTarget("file.jpg", stale);
      expect(store.getMetadataFile("file.jpg")).toBeUndefined();
    }
  });

  it("does not cross-delete an existing and new target sharing a schema", () => {
    const store = new TargetDraftEditsStore();
    const oldTarget = existing();
    const newTarget = created(oldTarget.schema_id);
    store.setMetadataTarget("file.jpg", oldTarget, setEdit("old"));
    store.setMetadataTarget("file.jpg", newTarget, setEdit("new"));
    store.deleteTarget("file.jpg", newTarget);
    const remaining = Object.values(store.getMetadataFile("file.jpg")!);
    expect(remaining).toHaveLength(1);
    expect(metadataDraftTargetToken(remaining[0].target)).toBe(
      metadataDraftTargetToken(oldTarget),
    );
  });

  it("deletes several targets by their logical slots with one notification", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch("file.jpg", [
      entry(existing({ path: "IFD0" })),
      entry(existing({ path: "IFD1", group1: "IFD1" })),
      entry(created()),
    ]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.deleteTargets("file.jpg", [
      existing({ path: "IFD0", group1: "stale" }),
      created(),
    ]);

    expect(Object.keys(store.getMetadataFile("file.jpg")!)).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("prunes by logical slot identity", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("file.jpg", existing(), setEdit("one"));
    store.pruneTargets("file.jpg", [existing({ group1: "IFD1" })]);
    expect(store.getMetadataFile("file.jpg")).toBeUndefined();
  });
});
