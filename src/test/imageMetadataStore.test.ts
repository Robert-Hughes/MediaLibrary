import { describe, it, expect, vi } from "vitest";
import { ImageMetadataStore } from "../types";

describe("ImageMetadataStore.subscribeAll", () => {
  it("fires on add() with 'loading'", () => {
    const store = new ImageMetadataStore();
    const cb = vi.fn();
    store.subscribeAll(cb);
    store.add("a.jpg");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("a.jpg", "loading");
  });

  it("does not re-fire on add() for an existing path", () => {
    const store = new ImageMetadataStore();
    const cb = vi.fn();
    store.add("a.jpg");
    store.subscribeAll(cb);
    store.add("a.jpg");
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires on set() with the new value", () => {
    const store = new ImageMetadataStore();
    store.add("a.jpg");
    const cb = vi.fn();
    store.subscribeAll(cb);
    const meta = { "IFD0:Make": "Sony" };
    store.set("a.jpg", meta);
    expect(cb).toHaveBeenCalledWith("a.jpg", meta);
  });

  it("supports multiple global subscribers and unsubscribe", () => {
    const store = new ImageMetadataStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = store.subscribeAll(a);
    store.subscribeAll(b);
    store.add("x.jpg");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    store.add("y.jpg");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("per-path subscribers still fire independently of global subscribers", () => {
    const store = new ImageMetadataStore();
    const perPath = vi.fn();
    const global = vi.fn();
    store.add("a.jpg");
    store.subscribe("a.jpg", perPath);
    store.subscribeAll(global);
    store.set("a.jpg", { "X:Y": "z" });
    expect(perPath).toHaveBeenCalledTimes(1);
    expect(global).toHaveBeenCalledTimes(1);
  });
});

describe("ImageMetadataStore.entries", () => {
  it("yields every stored (path, value) pair", () => {
    const store = new ImageMetadataStore();
    store.add("a.jpg");
    store.add("b.jpg");
    store.set("b.jpg", { "X:Y": "1" });
    const out = Array.from(store.entries());
    expect(out).toHaveLength(2);
    expect(out.find(([p]) => p === "a.jpg")?.[1]).toBe("loading");
    expect(out.find(([p]) => p === "b.jpg")?.[1]).toEqual({ "X:Y": "1" });
  });
});
