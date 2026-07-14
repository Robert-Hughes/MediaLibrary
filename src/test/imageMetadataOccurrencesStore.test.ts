import { describe, expect, it, vi } from "vitest";
import { ImageMetadataOccurrencesStore } from "../types";

describe("ImageMetadataOccurrencesStore", () => {
  it("reads unknown paths as loading and add preserves completed results", () => {
    const store = new ImageMetadataOccurrencesStore();
    expect(store.get("a.jpg")).toBe("loading");
    store.add("a.jpg");
    expect(store.getSnapshot("a.jpg")()).toBe("loading");
    store.set("a.jpg", []);
    store.add("a.jpg");
    expect(store.get("a.jpg")).toEqual([]);
  });

  it("sets and looks up exact paths, with empty arrays representing completion", () => {
    const store = new ImageMetadataOccurrencesStore();
    store.set("folder/a.jpg", []);
    expect(store.get("folder/a.jpg")).toEqual([]);
    expect(store.get("a.jpg")).toBe("loading");
    expect([...store.entries()]).toEqual([["folder/a.jpg", []]]);
  });

  it("notifies only subscribers for the changed path and cleans up", () => {
    const store = new ImageMetadataOccurrencesStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribe = store.subscribe("a.jpg", a);
    store.subscribe("b.jpg", b);
    store.set("a.jpg", []);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    unsubscribe();
    store.set("a.jpg", []);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("invalidates a loaded path without asserting an empty occurrence collection", () => {
    const store = new ImageMetadataOccurrencesStore();
    const listener = vi.fn();
    store.set("a.jpg", []);
    store.subscribe("a.jpg", listener);
    store.invalidate("a.jpg");
    expect(store.get("a.jpg")).toBe("loading");
    expect(listener).toHaveBeenCalledTimes(1);
    store.invalidate("a.jpg");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a replacement scan can use a fresh independent store", () => {
    const oldStore = new ImageMetadataOccurrencesStore();
    oldStore.set("old.jpg", []);
    const replacement = new ImageMetadataOccurrencesStore();
    expect(replacement).not.toBe(oldStore);
    expect(replacement.get("old.jpg")).toBe("loading");
    expect([...replacement.entries()]).toEqual([]);
  });
});
