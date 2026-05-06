import { describe, it, expect, vi } from "vitest";
import { selectVisibleNeedingLoad } from "../components/PhotoList";

function makeStore(loaded: Set<string>) {
  return {
    get: (path: string) => (loaded.has(path) ? "data" : "loading"),
  };
}

describe("selectVisibleNeedingLoad", () => {
  it("returns paths in the iteration order of the visible collection", () => {
    const visible = new Set(["c.jpg", "a.jpg", "b.jpg"]); // insertion order != alphabetic
    const thumbs = makeStore(new Set());
    const metadata = makeStore(new Set());
    expect(selectVisibleNeedingLoad(visible, thumbs, metadata)).toEqual(["c.jpg", "a.jpg", "b.jpg"]);
  });

  it("excludes paths that have both thumbnail and metadata loaded", () => {
    const visible = new Set(["a.jpg", "b.jpg", "c.jpg"]);
    const thumbs = makeStore(new Set(["b.jpg"]));
    const metadata = makeStore(new Set(["b.jpg"]));
    expect(selectVisibleNeedingLoad(visible, thumbs, metadata)).toEqual(["a.jpg", "c.jpg"]);
  });

  it("includes paths missing only metadata", () => {
    const visible = new Set(["a.jpg"]);
    const thumbs = makeStore(new Set(["a.jpg"]));
    const metadata = makeStore(new Set());
    expect(selectVisibleNeedingLoad(visible, thumbs, metadata)).toEqual(["a.jpg"]);
  });

  it("includes paths missing only the thumbnail", () => {
    const visible = new Set(["a.jpg"]);
    const thumbs = makeStore(new Set());
    const metadata = makeStore(new Set(["a.jpg"]));
    expect(selectVisibleNeedingLoad(visible, thumbs, metadata)).toEqual(["a.jpg"]);
  });

  it("only consults stores for visible paths, not for any wider collection", () => {
    // Regression: the original notify() iterated photosRef.current (the full
    // list, up to 10k) and filtered by visibleRef.has().  This test proves the
    // helper only consults the stores for visible paths — i.e. it iterates
    // `visible`, not some broader set.
    const visible = new Set(["a.jpg"]);
    const thumbsGet = vi.fn().mockReturnValue("data"); // not loading -> falls through to metadata
    const metadataGet = vi.fn().mockReturnValue("loading");
    selectVisibleNeedingLoad(visible, { get: thumbsGet }, { get: metadataGet });
    expect(thumbsGet).toHaveBeenCalledTimes(1);
    expect(thumbsGet).toHaveBeenCalledWith("a.jpg");
    expect(metadataGet).toHaveBeenCalledTimes(1);
    expect(metadataGet).toHaveBeenCalledWith("a.jpg");
  });

  it("scales with visible.size, not with the total library size", () => {
    // If the helper were accidentally re-implemented as a filter over a much
    // larger collection, the call count would balloon.  Asserting on the call
    // count is a structural check that the iteration source is `visible`.
    const visible = new Set(["v1", "v2", "v3"]);
    const thumbsGet = vi.fn().mockReturnValue("data"); // skip short-circuit
    const metadataGet = vi.fn().mockReturnValue("loading");
    selectVisibleNeedingLoad(visible, { get: thumbsGet }, { get: metadataGet });
    expect(thumbsGet).toHaveBeenCalledTimes(visible.size);
    expect(metadataGet).toHaveBeenCalledTimes(visible.size);
  });

  it("returns an empty array when nothing is visible", () => {
    expect(selectVisibleNeedingLoad(new Set(), makeStore(new Set()), makeStore(new Set()))).toEqual([]);
  });
});
