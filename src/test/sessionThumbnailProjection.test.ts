import { describe, expect, it, vi } from "vitest";
import { ThumbnailStore } from "../types";
import { projectSessionThumbnails } from "../sessionThumbnailProjection";

describe("session thumbnail projection", () => {
  it("projects loading and failed states without requesting payloads", async () => {
    const store = new ThumbnailStore();
    const invoke = vi.fn();

    await projectSessionThumbnails(
      7,
      [
        { relative_path: "loading.jpg", state: { status: "loading" } },
        {
          relative_path: "failed.jpg",
          state: { status: "failed" },
        },
      ],
      { store, invoke, isCurrentSession: () => true },
    );

    expect(store.get("loading.jpg")).toBe("loading");
    expect(store.get("failed.jpg")).toBe("failed");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("loads ready payloads and marks missing cache keys as failed", async () => {
    const store = new ThumbnailStore();
    const invoke = vi.fn().mockResolvedValue([
      { cache_key: "ready-key", thumbnail: "ready-data" },
      { cache_key: "unknown-key", thumbnail: "ignored" },
    ]);

    await projectSessionThumbnails(
      8,
      [
        {
          relative_path: "ready.jpg",
          state: { status: "ready", cache_key: "ready-key" },
        },
        {
          relative_path: "missing.jpg",
          state: { status: "ready", cache_key: "missing-key" },
        },
      ],
      { store, invoke, isCurrentSession: () => true },
    );

    expect(invoke).toHaveBeenCalledWith("get_media_library_thumbnails", {
      sessionId: 8,
      cacheKeys: ["ready-key", "missing-key"],
    });
    expect(store.get("ready.jpg")).toBe("ready-data");
    expect(store.get("missing.jpg")).toBe("failed");
  });

  it("does not install payloads after the session becomes stale", async () => {
    const store = new ThumbnailStore();
    const invoke = vi
      .fn()
      .mockResolvedValue([{ cache_key: "ready-key", thumbnail: "late-data" }]);

    await projectSessionThumbnails(
      9,
      [
        {
          relative_path: "ready.jpg",
          state: { status: "ready", cache_key: "ready-key" },
        },
      ],
      { store, invoke, isCurrentSession: () => false },
    );

    expect(store.get("ready.jpg")).toBe("loading");
  });
});
