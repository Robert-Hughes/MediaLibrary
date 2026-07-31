import { describe, expect, it, vi } from "vitest";
import { FileMetadataOccurrencesStore } from "../types";
import { resolveExactMetadataOccurrence } from "../utils/metadataOccurrences";

describe("FileMetadataOccurrencesStore", () => {
  it("reads unknown paths as loading and add preserves completed results", () => {
    const store = new FileMetadataOccurrencesStore();
    expect(store.get("a.jpg")).toBe("loading");
    store.add("a.jpg");
    expect(store.getSnapshot("a.jpg")()).toBe("loading");
    store.set("a.jpg", []);
    store.add("a.jpg");
    expect(store.get("a.jpg")).toEqual([]);
  });

  it("sets and looks up exact paths, with empty arrays representing completion", () => {
    const store = new FileMetadataOccurrencesStore();
    store.add("folder/a.jpg");
    store.set("folder/a.jpg", []);
    expect(store.get("folder/a.jpg")).toEqual([]);
    expect(store.get("a.jpg")).toBe("loading");
    expect([...store.entries()]).toEqual([["folder/a.jpg", []]]);
  });

  it("notifies only subscribers for the changed path and cleans up", () => {
    const store = new FileMetadataOccurrencesStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribe = store.subscribe("a.jpg", a);
    store.subscribe("b.jpg", b);
    store.add("a.jpg");
    store.add("b.jpg");
    store.set("a.jpg", []);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    unsubscribe();
    store.set("a.jpg", []);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("invalidates a loaded path without asserting an empty occurrence collection", () => {
    const store = new FileMetadataOccurrencesStore();
    const listener = vi.fn();
    store.add("a.jpg");
    store.set("a.jpg", []);
    store.subscribe("a.jpg", listener);
    store.invalidate("a.jpg");
    expect(store.get("a.jpg")).toBe("loading");
    expect(listener).toHaveBeenCalledTimes(1);
    store.invalidate("a.jpg");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a replacement scan can use a fresh independent store", () => {
    const oldStore = new FileMetadataOccurrencesStore();
    oldStore.add("old.jpg");
    oldStore.set("old.jpg", []);
    const replacement = new FileMetadataOccurrencesStore();
    expect(replacement).not.toBe(oldStore);
    expect(replacement.get("old.jpg")).toBe("loading");
    expect([...replacement.entries()]).toEqual([]);
  });
});

describe("exact occurrence lookup", () => {
  const value = {
    id: {
      document: null,
      path: "IFD0",
      runtime_tag_id: "1",
      tag_id_scope: { table: "TestFixture::Runtime", tag_id: "1", index: null },
      copy: 0,
    },
    schema_id: { table: "Unknown::Table", tag_id: "1" },
    value: { kind: "Text" as const, value: "value" },
    tag_info: null,
    observed_selector: null,
    write_target: null,
  };

  it("returns missing, unique, and duplicate exact-ID results", () => {
    expect(resolveExactMetadataOccurrence([], value.id)).toEqual({
      kind: "missing",
    });
    expect(resolveExactMetadataOccurrence([value], value.id)).toEqual({
      kind: "unique",
      occurrence: value,
    });
    expect(
      resolveExactMetadataOccurrence([value, structuredClone(value)], value.id),
    ).toMatchObject({ kind: "duplicate", occurrences: [value, value] });
  });
});
