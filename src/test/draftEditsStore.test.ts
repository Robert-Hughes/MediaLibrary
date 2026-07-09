// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { DraftEditsStore } from "../types";
import type { MetadataDraftEdit, MetadataValue } from "../types";

const edit = (value: string): MetadataDraftEdit => ({
  value: { kind: "Text", value },
  intent: "Set",
});
const del: MetadataDraftEdit = { value: null, intent: "Delete" };
const listEdit = (items: string[]): MetadataDraftEdit => ({
  value: {
    kind: "List",
    value: {
      list_kind: "Unknown",
      items: items.map((value) => ({ kind: "Text", value })),
    },
  },
  intent: "Set",
});
const structEdit = (value: Record<string, number>): MetadataDraftEdit => ({
  value: {
    kind: "Struct",
    value: Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        { kind: "Integer", value: child },
      ]),
    ),
  },
  intent: "Set",
});
const textValue = (value: string): MetadataValue => ({ kind: "Text", value });
const listValue = (items: string[]): MetadataValue => ({
  kind: "List",
  value: {
    list_kind: "Unknown",
    items: items.map(textValue),
  },
});
const structValue = (value: Record<string, number>): MetadataValue => ({
  kind: "Struct",
  value: Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      { kind: "Integer", value: child },
    ]),
  ),
});

describe("DraftEditsStore", () => {
  describe("reset", () => {
    it("replaces snapshot silently (no subscriber notification)", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.resetMetadata({ "a.jpg": { tag: edit("v") } });
      expect(cb).not.toHaveBeenCalled();
      expect(store.getAllMetadata()).toEqual({ "a.jpg": { tag: edit("v") } });
    });
  });

  describe("setTag", () => {
    it("adds a tag to a new file", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.setMetadataTag("a.jpg", "X:Y", edit("v"));
      expect(store.getMetadataFile("a.jpg")).toEqual({ "X:Y": edit("v") });
      expect(cb).toHaveBeenCalledWith([
        { path: "a.jpg", edits: { "X:Y": edit("v") } },
      ]);
    });

    it("merges with existing tags", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      store.setMetadataTag("a.jpg", "B", edit("2"));
      expect(store.getMetadataFile("a.jpg")).toEqual({
        A: edit("1"),
        B: edit("2"),
      });
    });

    it("emits a new snapshot reference per mutation", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      const before = store.getAllMetadata();
      store.setMetadataTag("a.jpg", "B", edit("2"));
      expect(store.getAllMetadata()).not.toBe(before);
    });
  });

  describe("setBatch", () => {
    it("applies multiple tags atomically and fires once", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.setMetadataBatch("a.jpg", [
        { key: "GPS:Lat", edit: edit("1") },
        { key: "GPS:Lng", edit: edit("2") },
      ]);
      expect(store.getMetadataFile("a.jpg")).toEqual({
        "GPS:Lat": edit("1"),
        "GPS:Lng": edit("2"),
      });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("no-ops on empty edits array", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.setMetadataBatch("a.jpg", []);
      expect(cb).not.toHaveBeenCalled();
      expect(store.getMetadataFile("a.jpg")).toBeUndefined();
    });
  });

  describe("deleteTag", () => {
    it("removes one tag and keeps siblings", () => {
      const store = new DraftEditsStore();
      store.setMetadataBatch("a.jpg", [
        { key: "A", edit: edit("1") },
        { key: "B", edit: edit("2") },
      ]);
      const cb = vi.fn();
      store.subscribe(cb);
      store.deleteTag("a.jpg", "A");
      expect(store.getMetadataFile("a.jpg")).toEqual({ B: edit("2") });
      expect(cb).toHaveBeenCalledWith([
        { path: "a.jpg", edits: { B: edit("2") } },
      ]);
    });

    it("removes the file entry when last tag goes", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.deleteTag("a.jpg", "A");
      expect(store.getMetadataFile("a.jpg")).toBeUndefined();
      expect(cb).toHaveBeenCalledWith([{ path: "a.jpg", edits: undefined }]);
    });

    it("no-ops on unknown tag", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.deleteTag("a.jpg", "B");
      store.deleteTag("missing.jpg", "A");
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("deletePath / deletePaths / clear", () => {
    it("deletePath removes the file and fires undefined", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.deletePath("a.jpg");
      expect(store.getMetadataFile("a.jpg")).toBeUndefined();
      expect(cb).toHaveBeenCalledWith([{ path: "a.jpg", edits: undefined }]);
    });

    it("deletePath no-ops on missing file", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.deletePath("missing.jpg");
      expect(cb).not.toHaveBeenCalled();
    });

    it("deletePaths drops only existing paths and fires once", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      store.setMetadataTag("b.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.deletePaths(["a.jpg", "missing.jpg", "b.jpg"]);
      expect(store.getAllMetadata()).toEqual({});
      expect(cb).toHaveBeenCalledTimes(1);
      const changes = cb.mock.calls[0][0];
      expect(changes.map((c: { path: string }) => c.path).sort()).toEqual([
        "a.jpg",
        "b.jpg",
      ]);
      expect(
        changes.every((c: { edits: unknown }) => c.edits === undefined),
      ).toBe(true);
    });

    it("deletePaths no-ops on all-missing", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.deletePaths(["x", "y"]);
      expect(cb).not.toHaveBeenCalled();
    });

    it("clear empties and notifies for every prior path", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      store.setMetadataTag("b.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.clear();
      expect(store.getAllMetadata()).toEqual({});
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toHaveLength(2);
    });

    it("clear no-ops on empty store", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.clear();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("pruneTags", () => {
    it("drops listed tags only", () => {
      const store = new DraftEditsStore();
      store.setMetadataBatch("a.jpg", [
        { key: "A", edit: edit("1") },
        { key: "B", edit: del },
        { key: "C", edit: edit("3") },
      ]);
      store.pruneTags("a.jpg", ["A", "B"]);
      expect(store.getMetadataFile("a.jpg")).toEqual({ C: edit("3") });
    });

    it("removes file when pruning the last tag", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.pruneTags("a.jpg", ["A"]);
      expect(store.getMetadataFile("a.jpg")).toBeUndefined();
      expect(cb).toHaveBeenCalledWith([{ path: "a.jpg", edits: undefined }]);
    });

    it("no-ops when none of the listed tags exist", () => {
      const store = new DraftEditsStore();
      store.setMetadataTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.pruneTags("a.jpg", ["B", "C"]);
      expect(cb).not.toHaveBeenCalled();
    });

    it("no-ops on missing file", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.pruneTags("missing.jpg", ["A"]);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("subscribe", () => {
    it("returns an unsubscribe function", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      const unsub = store.subscribe(cb);
      store.setMetadataTag("a.jpg", "A", edit("1"));
      unsub();
      store.setMetadataTag("b.jpg", "A", edit("1"));
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("redundant-draft guard", () => {
    it("returns 'redundant' and writes nothing when new Set value equals current", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver((_p, t) =>
        t === "A" ? textValue("v") : undefined,
      );
      const cb = vi.fn();
      store.subscribe(cb);
      const outcome = store.setMetadataTag("a.jpg", "A", edit("v"));
      expect(outcome).toBe("redundant");
      expect(store.getMetadataFile("a.jpg")).toBeUndefined();
      expect(cb).not.toHaveBeenCalled();
    });

    it("returns 'cleared' and removes the existing draft when new Set value equals current", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver((_p, t) =>
        t === "A" ? textValue("v") : undefined,
      );
      // Stage a (different-from-current) draft first; resolver returns
      // "v" so a draft with "different" lands.
      const writeOutcome = store.setMetadataTag(
        "a.jpg",
        "A",
        edit("different"),
      );
      expect(writeOutcome).toBe("written");
      expect(store.getMetadataFile("a.jpg")).toEqual({ A: edit("different") });
      // Now apply a value that matches current — should clear the draft.
      const cb = vi.fn();
      store.subscribe(cb);
      const outcome = store.setMetadataTag("a.jpg", "A", edit("v"));
      expect(outcome).toBe("cleared");
      expect(store.getMetadataFile("a.jpg")).toBeUndefined();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("writes through when value differs from current", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => textValue("old"));
      expect(store.setMetadataTag("a.jpg", "A", edit("new"))).toBe("written");
      expect(store.getMetadataFile("a.jpg")).toEqual({ A: edit("new") });
    });

    it("writes through when no resolver is registered (back-compat)", () => {
      const store = new DraftEditsStore();
      expect(store.setMetadataTag("a.jpg", "A", edit("v"))).toBe("written");
      expect(store.getMetadataFile("a.jpg")).toEqual({ A: edit("v") });
    });

    it("does not suppress Delete intents even when current value is present", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => textValue("v"));
      expect(store.setMetadataTag("a.jpg", "A", del)).toBe("written");
      expect(store.getMetadataFile("a.jpg")).toEqual({ A: del });
    });

    it("setBatch returns per-key outcomes and notifies once when any survive", () => {
      const store = new DraftEditsStore();
      // current values: A="same", B undefined (absent), C="other"
      store.setCurrentValueResolver((_p, t) => {
        if (t === "A") return textValue("same");
        if (t === "C") return textValue("other");
        return undefined;
      });
      const cb = vi.fn();
      store.subscribe(cb);
      const results = store.setMetadataBatch("a.jpg", [
        { key: "A", edit: edit("same") }, // redundant
        { key: "B", edit: edit("new") }, // written
        { key: "C", edit: edit("changed") }, // written
      ]);
      expect(results).toEqual([
        { key: "A", outcome: "redundant" },
        { key: "B", outcome: "written" },
        { key: "C", outcome: "changed" === "changed" ? "written" : "written" },
      ]);
      expect(store.getMetadataFile("a.jpg")).toEqual({
        B: edit("new"),
        C: edit("changed"),
      });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("setBatch with every key redundant fires no notification", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver((_p, t) =>
        t === "A" ? textValue("v") : textValue("w"),
      );
      const cb = vi.fn();
      store.subscribe(cb);
      const results = store.setMetadataBatch("a.jpg", [
        { key: "A", edit: edit("v") },
        { key: "B", edit: edit("w") },
      ]);
      expect(results.every((r) => r.outcome === "redundant")).toBe(true);
      expect(cb).not.toHaveBeenCalled();
      expect(store.getMetadataFile("a.jpg")).toBeUndefined();
    });

    it("compares list-valued metadata element-wise", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => listValue(["a", "b", "c"]));
      // Identical list → redundant.
      expect(
        store.setMetadataTag("p.jpg", "K", listEdit(["a", "b", "c"])),
      ).toBe("redundant");
      // Reordered → written.
      expect(
        store.setMetadataTag("p.jpg", "K", listEdit(["c", "b", "a"])),
      ).toBe("written");
    });

    it("compares object-valued metadata order-independently", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => structValue({ a: 1, b: 2 }));
      expect(
        store.setMetadataTag("p.jpg", "K", structEdit({ b: 2, a: 1 })),
      ).toBe("redundant");
      expect(
        store.setMetadataTag("p.jpg", "K", structEdit({ a: 1, b: 3 })),
      ).toBe("written");
    });
  });
});
