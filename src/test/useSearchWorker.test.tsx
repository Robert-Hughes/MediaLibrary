import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useSearchWorker,
  type SearchWorkerLike,
} from "../hooks/useSearchWorker";
import {
  DraftEditsStore,
  ImageMetadataStore,
  type PhotoInfo,
} from "../types";
import { SearchIndex } from "../search/searchIndex";
import { makePhoto } from "./factories";
import type {
  SearchWorkerInbound,
  SearchWorkerOutbound,
} from "../workers/searchWorkerProtocol";

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
      case "CLEAR": this.index.clear(); return;
      case "INIT_PHOTOS": for (const p of msg.photos) this.index.setPhoto(p); return;
      case "INIT_META": for (const e of msg.entries) this.index.setMeta(e.path, e.meta); return;
      case "INIT_DRAFTS": for (const e of msg.entries) this.index.setDrafts(e.path, e.edits); return;
      case "UPSERT_PHOTO": this.index.setPhoto(msg.photo); return;
      case "UPSERT_META": this.index.setMeta(msg.path, msg.meta); return;
      case "UPSERT_DRAFTS": this.index.setDrafts(msg.path, msg.edits); return;
      case "DELETE_PATH": this.index.deletePath(msg.path); return;
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
        queueMicrotask(() => this.onmessage?.({ data: out } as MessageEvent<SearchWorkerOutbound>));
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
  const imageMetadataStore = initial.imageMetadataStore ?? new ImageMetadataStore();
  const draftEditsStore = initial.draftEditsStore ?? new DraftEditsStore();
  const args: HookArgs = {
    photos: initial.photos ?? [],
    imageMetadataStore,
    draftEditsStore,
    query: initial.query ?? "",
  };
  const { result, rerender } = renderHook(
    (props: HookArgs) =>
      useSearchWorker({
        ...props,
        debounceMs,
        createWorker: () => fake,
      }),
    { initialProps: args },
  );
  return { fake, result, rerender, imageMetadataStore, draftEditsStore };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("useSearchWorker", () => {
  it("posts CLEAR + INIT_* on mount and submits the initial query", async () => {
    const meta = new ImageMetadataStore();
    meta.add("a.jpg");
    meta.set("a.jpg", { "X:Y": "z" });
    const drafts = new DraftEditsStore();
    drafts.reset({ "a.jpg": { "Tag:A": { value: "v", intent: "Set" } } });
    const photos = [makePhoto({ relative_path: "a.jpg" })];

    const { fake, result } = setup({
      photos,
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "",
    });

    const types = fake.inbound.map((m) => m.type);
    expect(types).toContain("CLEAR");
    expect(types).toContain("INIT_PHOTOS");
    expect(types).toContain("INIT_META");
    expect(types).toContain("INIT_DRAFTS");
    expect(types).toContain("QUERY");
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg"])));
    expect(result.current.pending).toBe(false);
  });

  it("filtering by query produces the expected matched set", async () => {
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    meta.add("a.jpg"); meta.set("a.jpg", { "IFD0:Make": "Canon" });
    meta.add("b.jpg"); meta.set("b.jpg", { "IFD0:Make": "Sony" });
    const photos = [
      makePhoto({ relative_path: "a.jpg" }),
      makePhoto({ relative_path: "b.jpg" }),
    ];
    const { rerender, result } = setup({ photos, imageMetadataStore: meta, draftEditsStore: drafts, query: "" });
    rerender({ photos, imageMetadataStore: meta, draftEditsStore: drafts, query: "canon" });
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg"])));
  });

  it("re-submits the query when a new photo arrives mid-search and updates results", async () => {
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { fake, rerender, result } = setup({ photos, imageMetadataStore: meta, draftEditsStore: drafts, query: ".jpg" });
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg"])));
    const initialQueryCount = fake.inbound.filter((m) => m.type === "QUERY").length;

    const newPhotos = [...photos, makePhoto({ relative_path: "b.jpg" })];
    rerender({ photos: newPhotos, imageMetadataStore: meta, draftEditsStore: drafts, query: ".jpg" });
    const types = fake.inbound.map((m) => m.type);
    expect(types).toContain("UPSERT_PHOTO");
    expect(fake.inbound.filter((m) => m.type === "QUERY").length).toBeGreaterThan(initialQueryCount);
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg", "b.jpg"])));
  });

  it("forwards metadata mutations and refreshes results", async () => {
    const meta = new ImageMetadataStore();
    meta.add("a.jpg");
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { fake, result } = setup({ photos, imageMetadataStore: meta, query: "uniquemeta" });
    await waitFor(() => expect(result.current.matched).toEqual(new Set()));

    act(() => {
      meta.set("a.jpg", { "X:Y": "uniquemeta-found" });
    });
    expect(fake.inbound.some((m) => m.type === "UPSERT_META")).toBe(true);
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg"])));
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
      drafts.setTag("a.jpg", "Tag:A", { value: "v", intent: "Set" });
    });
    expect(fake.inbound.some((m) => m.type === "UPSERT_DRAFTS")).toBe(true);
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg"])));
  });

  it("posts DELETE_PATH when a photo is removed from the list", async () => {
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    const photos = [
      makePhoto({ relative_path: "a.jpg" }),
      makePhoto({ relative_path: "b.jpg" }),
    ];
    const { fake, rerender, result } = setup({ photos, imageMetadataStore: meta, draftEditsStore: drafts, query: "" });
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg", "b.jpg"])));
    rerender({
      photos: [photos[0]],
      imageMetadataStore: meta,
      draftEditsStore: drafts,
      query: "",
    });
    expect(fake.inbound.some((m) => m.type === "DELETE_PATH" && m.path === "b.jpg")).toBe(true);
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg"])));
  });

  it("ignores stale results when a newer query was already submitted", async () => {
    const meta = new ImageMetadataStore();
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { fake, result } = setup({ photos, imageMetadataStore: meta, query: "" });
    await waitFor(() => expect(result.current.matched).toEqual(new Set(["a.jpg"])));

    const before = result.current.matched;
    act(() => {
      fake.onmessage?.({
        data: { type: "RESULT", id: -999, matched: ["b.jpg"], hasEditsFilter: false },
      } as MessageEvent<SearchWorkerOutbound>);
    });
    expect(result.current.matched).toBe(before);
  });

  it("resets and re-inits when imageMetadataStore reference changes", async () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const drafts = new DraftEditsStore();
    const metaOld = new ImageMetadataStore();
    metaOld.add("a.jpg");
    const { fake, rerender } = setup({ photos, imageMetadataStore: metaOld, draftEditsStore: drafts, query: "" });
    await waitFor(() =>
      expect(fake.inbound.filter((m) => m.type === "CLEAR").length).toBeGreaterThan(0),
    );
    const clearCountBefore = fake.inbound.filter((m) => m.type === "CLEAR").length;

    const metaNew = new ImageMetadataStore();
    metaNew.add("a.jpg");
    metaNew.set("a.jpg", { "X:Y": "newscanmeta" });
    rerender({
      photos,
      imageMetadataStore: metaNew,
      draftEditsStore: drafts,
      query: "",
    });
    expect(fake.inbound.filter((m) => m.type === "CLEAR").length).toBe(clearCountBefore + 1);
    expect(fake.inbound.some((m) =>
      m.type === "INIT_META"
      && m.entries.some((e) => (e.meta as Record<string, unknown>)["X:Y"] === "newscanmeta"),
    )).toBe(true);
  });

  it("debounces user-typed queries", async () => {
    vi.useFakeTimers();
    const meta = new ImageMetadataStore();
    const drafts = new DraftEditsStore();
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const fake = new FakeWorker();
    const base = { photos, imageMetadataStore: meta, draftEditsStore: drafts } as const;
    const { rerender } = renderHook(
      (props: HookArgs) =>
        useSearchWorker({
          ...props,
          debounceMs: 100,
          createWorker: () => fake,
        }),
      { initialProps: { ...base, query: "" } as HookArgs },
    );
    const beforeCount = fake.inbound.filter((m) => m.type === "QUERY").length;
    act(() => {
      rerender({ ...base, query: "a" });
      rerender({ ...base, query: "ab" });
      rerender({ ...base, query: "abc" });
    });
    expect(fake.inbound.filter((m) => m.type === "QUERY").length).toBe(beforeCount);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(fake.inbound.filter((m) => m.type === "QUERY").length).toBe(beforeCount + 1);
    const queries = fake.inbound.filter((m) => m.type === "QUERY");
    const lastQuery = queries[queries.length - 1];
    expect(lastQuery && "query" in lastQuery && lastQuery.query).toBe("abc");
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
});
