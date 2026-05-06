import { describe, it, expect, vi } from "vitest";
import { ThumbnailStore, ImageMetadataStore } from "../types";

describe("ThumbnailStore subscriber lifecycle", () => {
  it("notifies the subscriber when set is called", () => {
    const store = new ThumbnailStore();
    store.add("a.jpg");
    const cb = vi.fn();
    store.subscribe("a.jpg", cb);
    store.set("a.jpg", "data");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("does not notify after unsubscribe", () => {
    const store = new ThumbnailStore();
    store.add("a.jpg");
    const cb = vi.fn();
    const unsubscribe = store.subscribe("a.jpg", cb);
    unsubscribe();
    store.set("a.jpg", "data");
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribing the last subscriber removes the empty Set from the map", () => {
    const store = new ThumbnailStore();
    store.add("a.jpg");
    const unsubscribe = store.subscribe("a.jpg", () => {});
    unsubscribe();

    // Without the cleanup, an empty Set lingers per path — for a 10k-photo
    // library after the user has scrolled through, this is 10k empty Sets.
    const internal = (store as unknown as { subscribers: Map<string, Set<unknown>> }).subscribers;
    expect(internal.has("a.jpg")).toBe(false);
  });

  it("only the last unsubscribe removes the entry", () => {
    const store = new ThumbnailStore();
    store.add("a.jpg");
    const u1 = store.subscribe("a.jpg", () => {});
    const u2 = store.subscribe("a.jpg", () => {});
    u1();
    const internal = (store as unknown as { subscribers: Map<string, Set<unknown>> }).subscribers;
    expect(internal.has("a.jpg")).toBe(true);
    u2();
    expect(internal.has("a.jpg")).toBe(false);
  });
});

describe("ImageMetadataStore subscriber lifecycle", () => {
  it("unsubscribing the last subscriber removes the empty Set from the map", () => {
    const store = new ImageMetadataStore();
    store.add("a.jpg");
    const unsubscribe = store.subscribe("a.jpg", () => {});
    unsubscribe();
    const internal = (store as unknown as { subscribers: Map<string, Set<unknown>> }).subscribers;
    expect(internal.has("a.jpg")).toBe(false);
  });
});
