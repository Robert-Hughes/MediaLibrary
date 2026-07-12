import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  toSearchDraftEntries,
  toSearchMetadataState,
  useSearchWorker,
  type SearchWorkerLike,
} from "../hooks/useSearchWorker";
import { DraftEditsStore, ImageMetadataStore, type PhotoInfo } from "../types";
import { SearchIndex } from "../search/searchIndex";
import { makePhoto, mockDraftsByFile, mockMetadata, testId } from "./factories";
import type {
  SearchWorkerInbound,
  SearchWorkerOutbound,
} from "../workers/searchWorkerProtocol";
import { invoke } from "@tauri-apps/api/core";
import { _clearTagInfoCache } from "../hooks/useTagInfo";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/**
 * In-thread fake that routes messages synchronously through a real
 * SearchIndex.  Records every inbound message so tests can assert wire
 * traffic.
 */
class FakeWorker implements SearchWorkerLike {
  index = new SearchIndex();
  inbound: SearchWorkerInbound[] = [];
  onmessage: ((ev: MessageEvent<SearchWorkerOutbound>) => void) | null = null;
  terminated = false;

  postMessage(msg: SearchWorkerInbound) {
    this.inbound.push(msg);
    switch (msg.type) {
      case "CLEAR":
        this.index.clear();
        return;
      case "INIT_PHOTOS":
        for (const p of msg.photos) this.index.setPhoto(p);
        return;
      case "INIT_META":
        this.index.setSchemaLabels(msg.schemaLabels);
        for (const e of msg.entries) this.index.setMeta(e.path, e.meta);
        return;
      case "INIT_DRAFTS":
        this.index.setSchemaLabels(msg.schemaLabels);
        for (const e of msg.entries) this.index.setDrafts(e.path, e.edits);
        return;
      case "UPSERT_PHOTO":
        this.index.setPhoto(msg.photo);
        return;
      case "UPSERT_META":
        this.index.setSchemaLabels(msg.schemaLabels);
        this.index.setMeta(msg.path, msg.meta);
        return;
      case "UPSERT_DRAFTS":
        this.index.setSchemaLabels(msg.schemaLabels);
        this.index.setDrafts(msg.path, msg.edits);
        return;
      case "DELETE_PATH":
        this.index.deletePath(msg.path);
        return;
      case "QUERY": {
        const r = this.index.query(msg.query);
        const out: SearchWorkerOutbound = {
          type: "RESULT",
          id: msg.id,
          matched: r.matched,
          hasEditsFilter: r.hasEditsFilter,
        };
        // Dispatch via microtask to mimic real Worker async boundary.
        // Synchronous dispatch put React 19 setState calls inside store-
        // callback contexts, which interacted badly with auto-batching and
        // caused runaway memory growth across the suite.
        queueMicrotask(() =>
          this.onmessage?.({ data: out } as MessageEvent<SearchWorkerOutbound>),
        );
        return;
      }
    }
  }

  terminate() {
    this.terminated = true;
  }
}

interface HookArgs {
  photos: PhotoInfo[];
  imageMetadataStore: ImageMetadataStore;
  draftEditsStore: DraftEditsStore;
  query: string;
}

function setup(initial: Partial<HookArgs> = {}, debounceMs = 0) {
  const fake = new FakeWorker();
  const imageMetadataStore =
    initial.imageMetadataStore ?? new ImageMetadataStore();
  const draftEditsStore = initial.draftEditsStore ?? new DraftEditsStore();
  const args: HookArgs = {
    photos: initial.photos ?? [],
    imageMetadataStore,
    draftEditsStore,
    query: initial.query ?? "",
  };
  const { result, rerender, unmount } = renderHook(
    (props: HookArgs) =>
      useSearchWorker({
        ...props,
        debounceMs,
        createWorker: () => fake,
      }),
    { initialProps: args },
  );
  return {
    fake,
    result,
    rerender,
    unmount,
    imageMetadataStore,
    draftEditsStore,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  _clearTagInfoCache();
  vi.mocked(invoke).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSearchWorker", () => {
  it("posts CLEAR + INIT_* on mount and submits the initial query", async () => {
    const meta = new ImageMetadataStore();
    meta.add("a.jpg");
    meta.set("a.jpg", mockMetadata({ "X:Y": "z" }));
    const drafts = new DraftEditsStore();
    drafts.resetMetadata(
      mockDraftsByFile({
        "a.jpg": {
          "Tag:A": { value: { kind: "Text", value: "v" }, intent: "Set" },
        },
      }),
    );
    const photos = [makePhoto({ relative_path: "a.jpg" })];

    const { fake, result } = setup({
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "",
    });

    await waitFor(() => {
      const types = fake.inbound.map((m) => m.type);
      expect(types).toContain("CLEAR");
      expect(types).toContain("INIT_PHOTOS");
      expect(types).toContain("INIT_META");
      expect(types).toContain("INIT_DRAFTS");
      expect(types).toContain("QUERY");
    });
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );
    expect(result.current.pending).toBe(false);
  });

  it("filtering by query produces the expected matched set", async () => {
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    meta.add("a.jpg");
    meta.set("a.jpg", mockMetadata({ "IFD0:Make": "Canon" }));
    meta.add("b.jpg");
    meta.set("b.jpg", mockMetadata({ "IFD0:Make": "Sony" }));
    const photos = [
      makePhoto({ relative_path: "a.jpg" }),
      makePhoto({ relative_path: "b.jpg" }),
    ];
    const { rerender, result } = setup({
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "",
    });
    rerender({
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "canon",
    });
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );
  });

  it("re-submits the query when a new photo arrives mid-search and updates results", async () => {
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { fake, rerender, result } = setup({
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: ".jpg",
    });
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );
    const initialQueryCount = fake.inbound.filter(
      (m) => m.type === "QUERY",
    ).length;

    const newPhotos = [...photos, makePhoto({ relative_path: "b.jpg" })];
    rerender({
      photos: newPhotos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: ".jpg",
    });
    const types = fake.inbound.map((m) => m.type);
    expect(types).toContain("UPSERT_PHOTO");
    expect(
      fake.inbound.filter((m) => m.type === "QUERY").length,
    ).toBeGreaterThan(initialQueryCount);
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg", "b.jpg"])),
    );
  });

  it("forwards metadata mutations and refreshes results", async () => {
    const meta = new ImageMetadataStore();
    meta.add("a.jpg");
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { fake, result } = setup({
      photos,
      imageMetadataStore: meta,
      query: "uniquemeta",
    });
    await waitFor(() => expect(result.current.matched).toEqual(new Set()));

    act(() => {
      meta.set("a.jpg", mockMetadata({ "X:Y": "uniquemeta-found" }));
    });
    await waitFor(() =>
      expect(fake.inbound.some((m) => m.type === "UPSERT_META")).toBe(true),
    );
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );
  });

  it("forwards draft mutations and refreshes results", async () => {
    const drafts = new DraftEditsStore();
    const meta = new ImageMetadataStore();
    meta.add("a.jpg");
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { fake, result } = setup({
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "has:edits",
    });
    await waitFor(() => expect(result.current.matched).toEqual(new Set()));

    act(() => {
      drafts.setMetadataTag("a.jpg", testId("Tag:A"), {
        value: { kind: "Text", value: "v" },
        intent: "Set",
      });
    });
    await waitFor(() =>
      expect(fake.inbound.some((m) => m.type === "UPSERT_DRAFTS")).toBe(true),
    );
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );
  });

  it("posts DELETE_PATH when a photo is removed from the list", async () => {
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    const photos = [
      makePhoto({ relative_path: "a.jpg" }),
      makePhoto({ relative_path: "b.jpg" }),
    ];
    const { fake, rerender, result } = setup({
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "",
    });
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg", "b.jpg"])),
    );
    rerender({
      photos: [photos[0]],
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "",
    });
    expect(
      fake.inbound.some((m) => m.type === "DELETE_PATH" && m.path === "b.jpg"),
    ).toBe(true);
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );
  });

  it("ignores stale results when a newer query was already submitted", async () => {
    const meta = new ImageMetadataStore();
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { fake, result } = setup({
      photos,
      imageMetadataStore: meta,
      query: "",
    });
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );

    const before = result.current.matched;
    act(() => {
      fake.onmessage?.({
        data: {
          type: "RESULT",
          id: -999,
          matched: ["b.jpg"],
          hasEditsFilter: false,
        },
      } as MessageEvent<SearchWorkerOutbound>);
    });
    expect(result.current.matched).toBe(before);
  });

  it("resets and re-inits when imageMetadataStore reference changes", async () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const drafts = new DraftEditsStore();
    const metaOld = new ImageMetadataStore();
    metaOld.add("a.jpg");
    const { fake, rerender } = setup({
      photos,
      imageMetadataStore: metaOld,
      draftEditsStore: drafts,
      query: "",
    });
    await waitFor(() =>
      expect(
        fake.inbound.filter((m) => m.type === "CLEAR").length,
      ).toBeGreaterThan(0),
    );
    const clearCountBefore = fake.inbound.filter(
      (m) => m.type === "CLEAR",
    ).length;

    const metaNew = new ImageMetadataStore();
    metaNew.add("a.jpg");
    metaNew.set("a.jpg", mockMetadata({ "X:Y": "newscanmeta" }));
    rerender({
      photos,
      imageMetadataStore: metaNew,
      draftEditsStore: drafts,
      query: "",
    });
    expect(fake.inbound.filter((m) => m.type === "CLEAR").length).toBe(
      clearCountBefore + 1,
    );
    await waitFor(() =>
      expect(
        fake.inbound.some(
          (m) =>
            m.type === "INIT_META" &&
            m.entries.some((e) => {
              if (e.meta === "loading") return false;
              const val = e.meta.find(
                ({ id }) =>
                  id.table === testId("X:Y").table &&
                  id.tag_id === testId("X:Y").tag_id,
              )?.value;
              return val?.kind === "Text" && val.value === "newscanmeta";
            }),
        ),
      ).toBe(true),
    );
    await act(async () => {});
  });

  it("debounces user-typed queries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const fake = new FakeWorker();
    const base = {
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
    } as const;
    const { rerender } = renderHook(
      (props: HookArgs) =>
        useSearchWorker({
          ...props,
          debounceMs: 100,
          createWorker: () => fake,
        }),
      { initialProps: { ...base, query: "" } as HookArgs },
    );
    await act(async () => {});

    const beforeCount = fake.inbound.filter((m) => m.type === "QUERY").length;
    act(() => {
      rerender({ ...base, query: "a" });
      rerender({ ...base, query: "ab" });
      rerender({ ...base, query: "abc" });
    });
    expect(fake.inbound.filter((m) => m.type === "QUERY").length).toBe(
      beforeCount,
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(fake.inbound.filter((m) => m.type === "QUERY").length).toBe(
      beforeCount + 1,
    );
    const queries = fake.inbound.filter((m) => m.type === "QUERY");
    const lastQuery = queries[queries.length - 1];
    expect(lastQuery && "query" in lastQuery && lastQuery.query).toBe("abc");
    await act(async () => {});
    vi.useRealTimers();
  });

  it("terminates the worker on unmount", () => {
    const fake = new FakeWorker();
    const { unmount } = renderHook(() =>
      useSearchWorker({
        photos: [],
        imageMetadataStore: new ImageMetadataStore(),
        draftEditsStore: new DraftEditsStore(),
        query: "",
        debounceMs: 0,
        createWorker: () => fake,
      }),
    );
    expect(fake.terminated).toBe(false);
    unmount();
    expect(fake.terminated).toBe(true);
  });

  it("converts metadata and drafts to structured exact-ID entries", () => {
    const metadata = toSearchMetadataState(mockMetadata({ "X:Y": "value" }));
    const draftCollection = mockDraftsByFile({
      "a.jpg": { "Tag:A": "draft" },
    })["a.jpg"];
    const drafts = toSearchDraftEntries(draftCollection);

    expect(metadata).toEqual([
      { id: testId("X:Y"), value: { kind: "Text", value: "value" } },
    ]);
    expect(drafts).toEqual([
      {
        id: testId("Tag:A"),
        edit: { value: { kind: "Text", value: "draft" }, intent: "Set" },
      },
    ]);
  });

  it("cold-start batches exact IDs and sends labels with structured entries", async () => {
    const metaId = testId("X:Y");
    const draftId = testId("Tag:A");
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        id: metaId,
        group: "X",
        name: "Y",
        writable: true,
        kind: { kind: "Text" },
        description: "Metadata label",
      },
      {
        id: draftId,
        group: "Tag",
        name: "A",
        writable: true,
        kind: { kind: "Text" },
        description: "Draft label",
      },
    ]);
    const meta = new ImageMetadataStore();
    meta.set("a.jpg", mockMetadata({ "X:Y": "value" }));
    const drafts = new DraftEditsStore();
    drafts.resetMetadata(mockDraftsByFile({ "a.jpg": { "Tag:A": "draft" } }));
    _clearTagInfoCache();
    const { fake } = setup({
      photos: [makePhoto({ relative_path: "a.jpg" })],
      imageMetadataStore: meta,
      draftEditsStore: drafts,
    });

    expect(fake.inbound.some((message) => message.type === "INIT_META")).toBe(
      false,
    );
    await waitFor(() =>
      expect(fake.inbound.some((message) => message.type === "INIT_META")).toBe(
        true,
      ),
    );
    expect(invoke).toHaveBeenCalledWith("get_tag_infos", {
      ids: [metaId, draftId],
    });
    const initMeta = fake.inbound.find(
      (message) => message.type === "INIT_META",
    );
    const initDrafts = fake.inbound.find(
      (message) => message.type === "INIT_DRAFTS",
    );
    expect(initMeta).toMatchObject({
      entries: [{ path: "a.jpg", meta: [{ id: metaId }] }],
      schemaLabels: [{ id: metaId, group: "X", name: "Y" }],
    });
    expect(initDrafts).toMatchObject({
      entries: [{ path: "a.jpg", edits: [{ id: draftId }] }],
      schemaLabels: [{ id: draftId, group: "Tag", name: "A" }],
    });
    expect(
      fake.inbound.some(
        (message) =>
          (message as { type: string }).type === "UPSERT_SCHEMA_LABELS",
      ),
    ).toBe(false);
  });

  it("recovers the unchanged initial metadata and drafts after enrichment retries", async () => {
    const metaId = testId("X:Y");
    const draftId = testId("Tag:A");
    let failInitial!: (reason: Error) => void;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke)
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failInitial = reject;
        }),
      )
      .mockResolvedValueOnce([
        {
          id: metaId,
          group: "X",
          name: "Y",
          writable: true,
          kind: { kind: "Text" },
          description: null,
        },
        {
          id: draftId,
          group: "Tag",
          name: "A",
          writable: true,
          kind: { kind: "Text" },
          description: null,
        },
      ]);
    const meta = new ImageMetadataStore();
    meta.set("a.jpg", mockMetadata({ "X:Y": "loaded metadata" }));
    const drafts = new DraftEditsStore();
    drafts.resetMetadata(
      mockDraftsByFile({ "a.jpg": { "Tag:A": "loaded draft" } }),
    );
    _clearTagInfoCache();

    const { fake } = setup({
      photos: [makePhoto({ relative_path: "a.jpg" })],
      imageMetadataStore: meta,
      draftEditsStore: drafts,
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      failInitial(new Error("offline"));
    });

    expect(fake.inbound.some((message) => message.type === "INIT_META")).toBe(
      false,
    );
    expect(fake.inbound.some((message) => message.type === "INIT_DRAFTS")).toBe(
      false,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(
      fake.inbound.filter((message) => message.type === "INIT_META"),
    ).toMatchObject([
      { entries: [{ path: "a.jpg" }], schemaLabels: [{ id: metaId }] },
    ]);
    expect(
      fake.inbound.filter((message) => message.type === "INIT_DRAFTS"),
    ).toMatchObject([
      { entries: [{ path: "a.jpg" }], schemaLabels: [{ id: draftId }] },
    ]);
  });

  it("cancels a pending initial replay retry on cleanup", async () => {
    let failInitial!: (reason: Error) => void;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failInitial = reject;
      }),
    );
    const meta = new ImageMetadataStore();
    meta.set("a.jpg", mockMetadata({ "X:Y": "loaded" }));
    _clearTagInfoCache();
    const { unmount } = setup({ imageMetadataStore: meta });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      failInitial(new Error("offline"));
    });

    unmount();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("excludes a stale initial path when the retried replay completes", async () => {
    const id = testId("X:Y");
    let failInitial!: (reason: Error) => void;
    let finishRetry!: (value: unknown) => void;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke)
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failInitial = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishRetry = resolve;
        }),
      );
    const meta = new ImageMetadataStore();
    meta.set("a.jpg", mockMetadata({ "X:Y": "old" }));
    _clearTagInfoCache();
    const { fake } = setup({ imageMetadataStore: meta });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      failInitial(new Error("offline"));
    });

    act(() => meta.set("a.jpg", mockMetadata({ "X:Y": "new" })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    finishRetry([
      {
        id,
        group: "X",
        name: "Y",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
    ]);
    await act(async () => {});

    const initMeta = fake.inbound.find(
      (message) => message.type === "INIT_META",
    );
    expect(initMeta).toMatchObject({ entries: [] });
    expect(
      fake.inbound.some(
        (message) =>
          message.type === "UPSERT_META" &&
          message.meta !== "loading" &&
          message.meta.some(
            ({ value }) => value.kind === "Text" && value.value === "new",
          ),
      ),
    ).toBe(true);
  });

  it("caps persistent initial replay failures at a five-second retry interval", async () => {
    let failInitial!: (reason: Error) => void;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke)
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failInitial = reject;
        }),
      )
      .mockRejectedValue(new Error("offline"));
    const meta = new ImageMetadataStore();
    meta.set("a.jpg", mockMetadata({ "X:Y": "loaded" }));
    _clearTagInfoCache();
    setup({ imageMetadataStore: meta });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      failInitial(new Error("offline"));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(invoke).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(invoke).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it("stores combined-message labels once before rebuilding every path", () => {
    const id = testId("X:Y");
    const label = {
      id,
      group: "Friendly",
      name: "Label",
      description: null,
    };
    const fake = new FakeWorker();
    fake.postMessage({
      type: "INIT_PHOTOS",
      photos: [
        {
          relative_path: "a.jpg",
          filename: "a.jpg",
          date_modified: null,
          date_created: null,
        },
        {
          relative_path: "b.jpg",
          filename: "b.jpg",
          date_modified: null,
          date_created: null,
        },
      ],
    });
    const labels = vi.spyOn(fake.index, "setSchemaLabels");
    const metadata = vi.spyOn(fake.index, "setMeta");
    fake.postMessage({
      type: "INIT_META",
      entries: [
        {
          path: "a.jpg",
          meta: toSearchMetadataState(mockMetadata({ "X:Y": "one" })),
        },
        {
          path: "b.jpg",
          meta: toSearchMetadataState(mockMetadata({ "X:Y": "two" })),
        },
      ],
      schemaLabels: [label],
    });

    expect(labels).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(labels.mock.invocationCallOrder[0]).toBeLessThan(
      metadata.mock.invocationCallOrder[0],
    );
    expect(new Set(fake.index.query("Friendly:Label").matched)).toEqual(
      new Set(["a.jpg", "b.jpg"]),
    );

    labels.mockClear();
    const drafts = vi.spyOn(fake.index, "setDrafts");
    fake.postMessage({
      type: "INIT_DRAFTS",
      entries: [
        {
          path: "a.jpg",
          edits: [
            {
              id,
              edit: {
                value: { kind: "Text", value: "draft one" },
                intent: "Set",
              },
            },
          ],
        },
        {
          path: "b.jpg",
          edits: [
            {
              id,
              edit: {
                value: { kind: "Text", value: "draft two" },
                intent: "Set",
              },
            },
          ],
        },
      ],
      schemaLabels: [label],
    });
    expect(labels).toHaveBeenCalledTimes(1);
    expect(drafts).toHaveBeenCalledTimes(2);
    expect(labels.mock.invocationCallOrder[0]).toBeLessThan(
      drafts.mock.invocationCallOrder[0],
    );
  });

  it("stores UPSERT labels before rebuilding the affected path", () => {
    const fake = new FakeWorker();
    const id = testId("X:Y");
    const labels = vi.spyOn(fake.index, "setSchemaLabels");
    const metadata = vi.spyOn(fake.index, "setMeta");

    fake.postMessage({
      type: "UPSERT_META",
      path: "a.jpg",
      meta: toSearchMetadataState(mockMetadata({ "X:Y": "value" })),
      schemaLabels: [
        { id, group: "Friendly", name: "Label", description: null },
      ],
    });

    expect(labels).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(labels.mock.invocationCallOrder[0]).toBeLessThan(
      metadata.mock.invocationCallOrder[0],
    );
  });

  it("drops stale metadata enrichment and posts only the newest revision", async () => {
    const id = testId("X:Y");
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const meta = new ImageMetadataStore();
    const oldMeta = mockMetadata({ "X:Y": "old" });
    const newMeta = mockMetadata({ "X:Y": "new" });
    _clearTagInfoCache();
    const { fake } = setup({ imageMetadataStore: meta });
    await waitFor(() =>
      expect(fake.inbound.some((message) => message.type === "INIT_META")).toBe(
        true,
      ),
    );
    fake.inbound.length = 0;

    act(() => meta.set("a.jpg", oldMeta));
    act(() => meta.set("a.jpg", newMeta));
    expect(fake.inbound.some((message) => message.type === "UPSERT_META")).toBe(
      false,
    );
    finish([
      {
        id,
        group: "X",
        name: "Y",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
    ]);

    await waitFor(() => {
      const updates = fake.inbound.filter(
        (message) => message.type === "UPSERT_META",
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        meta: [{ value: { kind: "Text", value: "new" } }],
      });
    });
  });

  it("drops stale draft enrichment and late results after termination", async () => {
    const id = testId("Tag:A");
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const drafts = new DraftEditsStore();
    const { fake, unmount } = setup({ draftEditsStore: drafts });
    await waitFor(() =>
      expect(
        fake.inbound.some((message) => message.type === "INIT_DRAFTS"),
      ).toBe(true),
    );
    fake.inbound.length = 0;

    act(() =>
      drafts.setMetadataTag("a.jpg", id, {
        value: { kind: "Text", value: "old" },
        intent: "Set",
      }),
    );
    act(() =>
      drafts.setMetadataTag("a.jpg", id, {
        value: { kind: "Text", value: "new" },
        intent: "Set",
      }),
    );
    expect(
      fake.inbound.some((message) => message.type === "UPSERT_DRAFTS"),
    ).toBe(false);
    unmount();
    finish([
      {
        id,
        group: "Tag",
        name: "A",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
    ]);
    await act(async () => {});
    expect(
      fake.inbound.some((message) => message.type === "UPSERT_DRAFTS"),
    ).toBe(false);
  });

  it("retries a failed enrichment on a later update", async () => {
    const id = testId("X:Y");
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([
        {
          id,
          group: "X",
          name: "Y",
          writable: true,
          kind: { kind: "Text" },
          description: null,
        },
      ]);
    const meta = new ImageMetadataStore();
    const firstMeta = mockMetadata({ "X:Y": "first" });
    const secondMeta = mockMetadata({ "X:Y": "second" });
    _clearTagInfoCache();
    const { fake } = setup({ imageMetadataStore: meta });
    await waitFor(() =>
      expect(fake.inbound.some((message) => message.type === "INIT_META")).toBe(
        true,
      ),
    );
    fake.inbound.length = 0;

    act(() => meta.set("a.jpg", firstMeta));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(fake.inbound.some((message) => message.type === "UPSERT_META")).toBe(
      false,
    );
    act(() => meta.set("a.jpg", secondMeta));
    await waitFor(() =>
      expect(
        fake.inbound.some((message) => message.type === "UPSERT_META"),
      ).toBe(true),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
