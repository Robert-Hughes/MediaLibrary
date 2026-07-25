// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { FileMetadataOccurrencesStore, ThumbnailStore } from "../types";
import { occurrenceFromSchemaValue } from "./occurrenceFixtures";

const occurrence = occurrenceFromSchemaValue(
  { table: "XMP::dc", tag_id: "title" },
  { kind: "Text", value: "Title" },
);

describe("ThumbnailStore subscriber lifecycle", () => {
  it("notifies until unsubscribed and cleans the final subscriber set", () => {
    const store = new ThumbnailStore();
    store.add("a.jpg");
    const callback = vi.fn();
    const unsubscribe = store.subscribe("a.jpg", callback);
    store.set("a.jpg", "data");
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
    store.set("a.jpg", "replacement");
    expect(callback).toHaveBeenCalledOnce();
    const internal = (
      store as unknown as { subscribers: Map<string, Set<unknown>> }
    ).subscribers;
    expect(internal.has("a.jpg")).toBe(false);
  });
});

describe("FileMetadataOccurrencesStore subscriptions", () => {
  it("preserves per-path subscriptions and cleans the final subscriber set", () => {
    const store = new FileMetadataOccurrencesStore();
    store.add("a.jpg");
    const callback = vi.fn();
    const unsubscribe = store.subscribe("a.jpg", callback);
    store.set("a.jpg", [occurrence]);
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
    store.invalidate("a.jpg");
    expect(callback).toHaveBeenCalledOnce();
    const internal = (
      store as unknown as { subscribers: Map<string, Set<unknown>> }
    ).subscribers;
    expect(internal.has("a.jpg")).toBe(false);
  });

  it("notifies global subscribers for add, set, invalidate and each clear path", () => {
    const store = new FileMetadataOccurrencesStore();
    const callback = vi.fn();
    store.subscribeAll(callback);

    store.add("a.jpg");
    store.add("a.jpg");
    store.set("a.jpg", [occurrence]);
    store.set("a.jpg", store.get("a.jpg"));
    store.invalidate("a.jpg");
    store.invalidate("a.jpg");
    store.add("b.jpg");
    store.clear();
    store.clear();

    expect(callback.mock.calls).toEqual([
      ["a.jpg", "loading"],
      ["a.jpg", [occurrence]],
      ["a.jpg", "loading"],
      ["b.jpg", "loading"],
      ["a.jpg", "loading"],
      ["b.jpg", "loading"],
    ]);
  });

  it("stops global notifications after unsubscribe", () => {
    const store = new FileMetadataOccurrencesStore();
    const callback = vi.fn();
    const unsubscribe = store.subscribeAll(callback);
    unsubscribe();
    store.add("a.jpg");
    expect(callback).not.toHaveBeenCalled();
  });
});
