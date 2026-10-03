import { describe, expect, it, vi } from "vitest";
import { ThumbnailStore } from "../types";
import {
  createSessionThumbnailProjector,
  projectSessionThumbnails,
} from "../sessionThumbnailProjection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function ready(path: string, key: string) {
  return {
    relative_path: path,
    state: { status: "ready" as const, cache_key: key },
  };
}

describe("independent thumbnail loader", () => {
  it("bounds requests, keeps one in flight, and yields between batches", async () => {
    const store = new ThumbnailStore();
    const requests = Array.from({ length: 3 }, () => deferred<unknown>());
    const invoke = vi
      .fn()
      .mockImplementation(() => requests[invoke.mock.calls.length - 1].promise);
    const pause = deferred<void>();
    const yieldToBrowser = vi
      .fn()
      .mockImplementationOnce(() => pause.promise)
      .mockResolvedValue(undefined);
    const loader = createSessionThumbnailProjector({
      store,
      invoke,
      isCurrentSession: () => true,
      onError: vi.fn(),
      yieldToBrowser,
    });
    loader.project(
      1,
      Array.from({ length: 123 }, (_, index) =>
        ready(`${index}.jpg`, `key-${index}`),
      ),
    );
    expect(invoke).toHaveBeenCalledOnce();
    requests[0].resolve([]);
    await vi.waitFor(() => expect(yieldToBrowser).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledOnce();
    pause.resolve();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    requests[1].resolve([]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    requests[2].resolve([]);
    expect(invoke.mock.calls.map(([, args]) => args.cacheKeys.length)).toEqual([
      50, 50, 23,
    ]);
    await vi.waitFor(() => expect(store.get("122.jpg")).toBe("failed"));
  });

  it("coalesces queued versions and rejects superseded in-flight payloads", async () => {
    const store = new ThumbnailStore();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const invoke = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const loader = createSessionThumbnailProjector({
      store,
      invoke,
      isCurrentSession: () => true,
      onError: vi.fn(),
      yieldToBrowser: async () => {},
    });
    loader.project(1, [ready("a.jpg", "old")]);
    loader.project(1, [
      ready("a.jpg", "intermediate"),
      ready("b.jpg", "obsolete"),
    ]);
    loader.project(1, [
      ready("a.jpg", "latest"),
      { relative_path: "b.jpg", state: { status: "failed" } },
    ]);
    first.resolve([{ cache_key: "old", thumbnail: "old-data" }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(store.get("a.jpg")).toBe("loading");
    expect(store.get("b.jpg")).toBe("failed");
    expect(invoke.mock.calls[1][1].cacheKeys).toEqual(["latest"]);
    second.resolve([{ cache_key: "latest", thumbnail: "latest-data" }]);
    await vi.waitFor(() => expect(store.get("a.jpg")).toBe("latest-data"));
  });

  it("ignores the replaced session and continues loading the new session", async () => {
    const store = new ThumbnailStore();
    let activeSession = 1;
    const first = deferred<unknown>();
    const invoke = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ cache_key: "new", thumbnail: "new-data" }]);
    const loader = createSessionThumbnailProjector({
      store,
      invoke,
      isCurrentSession: (id) => id === activeSession,
      onError: vi.fn(),
      yieldToBrowser: async () => {},
    });
    loader.project(1, [ready("a.jpg", "old")]);
    activeSession = 2;
    loader.project(2, [ready("a.jpg", "new")]);
    first.resolve([{ cache_key: "old", thumbnail: "old-data" }]);
    await vi.waitFor(() => expect(store.get("a.jpg")).toBe("new-data"));
    expect(invoke.mock.calls[1][1].sessionId).toBe(2);
  });

  it("reports failed downloads and can process a subsequent request", async () => {
    const store = new ThumbnailStore();
    const failure = new Error("transport failed");
    const onError = vi.fn();
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([{ cache_key: "retry", thumbnail: "retry-data" }]);
    const loader = createSessionThumbnailProjector({
      store,
      invoke,
      isCurrentSession: () => true,
      onError,
    });
    loader.project(1, [ready("a.jpg", "first")]);
    await vi.waitFor(() => expect(store.get("a.jpg")).toBe("failed"));
    expect(onError).toHaveBeenCalledWith(failure);
    loader.project(1, [ready("a.jpg", "retry")]);
    await vi.waitFor(() => expect(store.get("a.jpg")).toBe("retry-data"));
  });
});

describe("session thumbnail projection", () => {
  it("bounds recovery requests and installs each chunk before fetching the next", async () => {
    const store = new ThumbnailStore();
    const entries = Array.from({ length: 123 }, (_, index) => ({
      relative_path: `${index}.jpg`,
      state: { status: "ready" as const, cache_key: `key-${index}` },
    }));
    const invoke = vi.fn(
      async (_cmd: string, args?: Record<string, unknown>) => {
        const keys = args!.cacheKeys as string[];
        expect(keys.length).toBeLessThanOrEqual(50);
        if (keys[0] === "key-50")
          expect(store.get("49.jpg")).toBe("data-key-49");
        return keys.map((key) => ({
          cache_key: key,
          thumbnail: `data-${key}`,
        }));
      },
    );

    await projectSessionThumbnails(8, entries, {
      store,
      invoke,
      isCurrentSession: () => true,
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    for (let index = 0; index < entries.length; index++) {
      expect(store.get(`${index}.jpg`)).toBe(`data-key-${index}`);
    }
  });

  it("stops requesting subsequent chunks when the session becomes stale", async () => {
    const store = new ThumbnailStore();
    const entries = Array.from({ length: 123 }, (_, index) => ({
      relative_path: `${index}.jpg`,
      state: { status: "ready" as const, cache_key: `key-${index}` },
    }));
    const invoke = vi.fn().mockResolvedValue([]);
    await projectSessionThumbnails(8, entries, {
      store,
      invoke,
      isCurrentSession: () => false,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.get("0.jpg")).toBe("loading");
  });

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
