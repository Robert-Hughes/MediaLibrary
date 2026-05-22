import { describe, it, expect, vi } from "vitest";
import { DraftEditsStore } from "../types";
import type { DraftEdit } from "../types";

const edit = (value: string): DraftEdit => ({ value, intent: "Set" });
const del: DraftEdit = { value: null, intent: "Delete" };

describe("DraftEditsStore", () => {
  describe("reset", () => {
    it("replaces snapshot silently (no subscriber notification)", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.reset({ "a.jpg": { tag: edit("v") } });
      expect(cb).not.toHaveBeenCalled();
      expect(store.getAll()).toEqual({ "a.jpg": { tag: edit("v") } });
    });
  });

  describe("setTag", () => {
    it("adds a tag to a new file", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.setTag("a.jpg", "X:Y", edit("v"));
      expect(store.getFile("a.jpg")).toEqual({ "X:Y": edit("v") });
      expect(cb).toHaveBeenCalledWith([{ path: "a.jpg", edits: { "X:Y": edit("v") } }]);
    });

    it("merges with existing tags", () => {
      const store = new DraftEditsStore();
      store.setTag("a.jpg", "A", edit("1"));
      store.setTag("a.jpg", "B", edit("2"));
      expect(store.getFile("a.jpg")).toEqual({ A: edit("1"), B: edit("2") });
    });

    it("emits a new snapshot reference per mutation", () => {
      const store = new DraftEditsStore();
      store.setTag("a.jpg", "A", edit("1"));
      const before = store.getAll();
      store.setTag("a.jpg", "B", edit("2"));
      expect(store.getAll()).not.toBe(before);
    });
  });

  describe("setBatch", () => {
    it("applies multiple tags atomically and fires once", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.setBatch("a.jpg", [
        { key: "GPS:Lat", edit: edit("1") },
        { key: "GPS:Lng", edit: edit("2") },
      ]);
      expect(store.getFile("a.jpg")).toEqual({ "GPS:Lat": edit("1"), "GPS:Lng": edit("2") });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("no-ops on empty edits array", () => {
      const store = new DraftEditsStore();
      const cb = vi.fn();
      store.subscribe(cb);
      store.setBatch("a.jpg", []);
      expect(cb).not.toHaveBeenCalled();
      expect(store.getFile("a.jpg")).toBeUndefined();
    });
  });

  describe("deleteTag", () => {
    it("removes one tag and keeps siblings", () => {
      const store = new DraftEditsStore();
      store.setBatch("a.jpg", [{ key: "A", edit: edit("1") }, { key: "B", edit: edit("2") }]);
      const cb = vi.fn();
      store.subscribe(cb);
      store.deleteTag("a.jpg", "A");
      expect(store.getFile("a.jpg")).toEqual({ B: edit("2") });
      expect(cb).toHaveBeenCalledWith([{ path: "a.jpg", edits: { B: edit("2") } }]);
    });

    it("removes the file entry when last tag goes", () => {
      const store = new DraftEditsStore();
      store.setTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.deleteTag("a.jpg", "A");
      expect(store.getFile("a.jpg")).toBeUndefined();
      expect(cb).toHaveBeenCalledWith([{ path: "a.jpg", edits: undefined }]);
    });

    it("no-ops on unknown tag", () => {
      const store = new DraftEditsStore();
      store.setTag("a.jpg", "A", edit("1"));
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
      store.setTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.deletePath("a.jpg");
      expect(store.getFile("a.jpg")).toBeUndefined();
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
      store.setTag("a.jpg", "A", edit("1"));
      store.setTag("b.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.deletePaths(["a.jpg", "missing.jpg", "b.jpg"]);
      expect(store.getAll()).toEqual({});
      expect(cb).toHaveBeenCalledTimes(1);
      const changes = cb.mock.calls[0][0];
      expect(changes.map((c: { path: string }) => c.path).sort()).toEqual(["a.jpg", "b.jpg"]);
      expect(changes.every((c: { edits: unknown }) => c.edits === undefined)).toBe(true);
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
      store.setTag("a.jpg", "A", edit("1"));
      store.setTag("b.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.clear();
      expect(store.getAll()).toEqual({});
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
      store.setBatch("a.jpg", [
        { key: "A", edit: edit("1") },
        { key: "B", edit: del },
        { key: "C", edit: edit("3") },
      ]);
      store.pruneTags("a.jpg", ["A", "B"]);
      expect(store.getFile("a.jpg")).toEqual({ C: edit("3") });
    });

    it("removes file when pruning the last tag", () => {
      const store = new DraftEditsStore();
      store.setTag("a.jpg", "A", edit("1"));
      const cb = vi.fn();
      store.subscribe(cb);
      store.pruneTags("a.jpg", ["A"]);
      expect(store.getFile("a.jpg")).toBeUndefined();
      expect(cb).toHaveBeenCalledWith([{ path: "a.jpg", edits: undefined }]);
    });

    it("no-ops when none of the listed tags exist", () => {
      const store = new DraftEditsStore();
      store.setTag("a.jpg", "A", edit("1"));
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
      store.setTag("a.jpg", "A", edit("1"));
      unsub();
      store.setTag("b.jpg", "A", edit("1"));
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("redundant-draft guard", () => {
    it("returns 'redundant' and writes nothing when new Set value equals current", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver((_p, t) => (t === "A" ? "v" : undefined));
      const cb = vi.fn();
      store.subscribe(cb);
      const outcome = store.setTag("a.jpg", "A", edit("v"));
      expect(outcome).toBe("redundant");
      expect(store.getFile("a.jpg")).toBeUndefined();
      expect(cb).not.toHaveBeenCalled();
    });

    it("returns 'cleared' and removes the existing draft when new Set value equals current", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver((_p, t) => (t === "A" ? "v" : undefined));
      // Stage a (different-from-current) draft first; resolver returns
      // "v" so a draft with "different" lands.
      const writeOutcome = store.setTag("a.jpg", "A", edit("different"));
      expect(writeOutcome).toBe("written");
      expect(store.getFile("a.jpg")).toEqual({ A: edit("different") });
      // Now apply a value that matches current — should clear the draft.
      const cb = vi.fn();
      store.subscribe(cb);
      const outcome = store.setTag("a.jpg", "A", edit("v"));
      expect(outcome).toBe("cleared");
      expect(store.getFile("a.jpg")).toBeUndefined();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("writes through when value differs from current", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => "old");
      expect(store.setTag("a.jpg", "A", edit("new"))).toBe("written");
      expect(store.getFile("a.jpg")).toEqual({ A: edit("new") });
    });

    it("writes through when no resolver is registered (back-compat)", () => {
      const store = new DraftEditsStore();
      expect(store.setTag("a.jpg", "A", edit("v"))).toBe("written");
      expect(store.getFile("a.jpg")).toEqual({ A: edit("v") });
    });

    it("does not suppress Delete intents even when current value is present", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => "v");
      expect(store.setTag("a.jpg", "A", del)).toBe("written");
      expect(store.getFile("a.jpg")).toEqual({ A: del });
    });

    it("setBatch returns per-key outcomes and notifies once when any survive", () => {
      const store = new DraftEditsStore();
      // current values: A="same", B undefined (absent), C="other"
      store.setCurrentValueResolver((_p, t) => {
        if (t === "A") return "same";
        if (t === "C") return "other";
        return undefined;
      });
      const cb = vi.fn();
      store.subscribe(cb);
      const results = store.setBatch("a.jpg", [
        { key: "A", edit: edit("same") },    // redundant
        { key: "B", edit: edit("new") },     // written
        { key: "C", edit: edit("changed") }, // written
      ]);
      expect(results).toEqual([
        { key: "A", outcome: "redundant" },
        { key: "B", outcome: "written" },
        { key: "C", outcome: "changed" === "changed" ? "written" : "written" },
      ]);
      expect(store.getFile("a.jpg")).toEqual({
        B: edit("new"),
        C: edit("changed"),
      });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("setBatch with every key redundant fires no notification", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver((_p, t) => (t === "A" ? "v" : "w"));
      const cb = vi.fn();
      store.subscribe(cb);
      const results = store.setBatch("a.jpg", [
        { key: "A", edit: edit("v") },
        { key: "B", edit: edit("w") },
      ]);
      expect(results.every((r) => r.outcome === "redundant")).toBe(true);
      expect(cb).not.toHaveBeenCalled();
      expect(store.getFile("a.jpg")).toBeUndefined();
    });

    it("compares list-valued Variants element-wise", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => ["a", "b", "c"]);
      // Identical list → redundant.
      expect(
        store.setTag("p.jpg", "K", { value: ["a", "b", "c"], intent: "Set" }),
      ).toBe("redundant");
      // Reordered → written.
      expect(
        store.setTag("p.jpg", "K", { value: ["c", "b", "a"], intent: "Set" }),
      ).toBe("written");
    });

    it("compares object-valued Variants order-independently", () => {
      const store = new DraftEditsStore();
      store.setCurrentValueResolver(() => ({ a: 1, b: 2 }));
      expect(
        store.setTag("p.jpg", "K", { value: { b: 2, a: 1 }, intent: "Set" }),
      ).toBe("redundant");
      expect(
        store.setTag("p.jpg", "K", { value: { a: 1, b: 3 }, intent: "Set" }),
      ).toBe("written");
    });
  });
});
