import "@testing-library/jest-dom";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { SearchIndex } from "../search/searchIndex";

// Unmount React trees between tests so the DOM doesn't bleed across
// `it()` blocks.  Without this, `screen.getByTestId(...)` in test N+1
// can hit elements left behind by test N and fail with confusing errors.
afterEach(() => {
  cleanup();
  // Components persist UI preferences (e.g. GalleryView's
  // gallery-info-toggle state, GALLERY_DETAILS_VISIBLE_KEY) to localStorage.
  // jsdom shares one localStorage across every test in the file, so a
  // toggle in test N flipped the persisted value and test N+1 mounts with
  // a non-default initial state.  The discardAllBtn flake in
  // draft-metadata-editing.test.tsx ("can edit and discard…") came from
  // exactly this: the first gallery-info-toggle click persisted "1", the
  // close-then-reopen restored details=visible, and the second toggle
  // click hid the details pane — making the discard-all button absent.
  // Wiping localStorage between tests gives every test the production-
  // default initial UI state.
  try {
    localStorage.clear();
  } catch {
    /* jsdom may have torn it down */
  }
});

// jsdom does not implement IntersectionObserver — provide a no-op stub so
// components that use it can render without errors in tests.
// Individual tests that want to assert on observer behaviour can override
// this with vi.stubGlobal / vi.unstubAllGlobals.
if (typeof IntersectionObserver === "undefined") {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
}

// jsdom does not implement Web Workers.  The production hook spawns a
// search worker via `new Worker(...)`, so tests need *some* Worker
// implementation.  We install an in-thread shim that runs the same
// SearchIndex code path the real worker would, dispatching RESULT
// messages via setTimeout(0) to mimic the asynchronous postMessage
// boundary.  Integration tests can rely on search filtering exactly the
// way the production app does it.
//
// Tests that need finer control over wire traffic (`useSearchWorker.test`)
// inject their own fake via the hook's `createWorker` arg and never reach
// this shim.
if (typeof Worker === "undefined") {
  class InThreadSearchWorker {
    private index = new SearchIndex();
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: unknown = null;

    postMessage(rawMsg: unknown) {
      const msg = rawMsg as { type: string } & Record<string, unknown>;
      switch (msg.type) {
        case "CLEAR":
          this.index.clear();
          return;
        case "INIT_PHOTOS":
          for (const p of msg.photos as Parameters<
            InstanceType<typeof SearchIndex>["setPhoto"]
          >[0][]) {
            this.index.setPhoto(p);
          }
          return;
        case "INIT_META":
          for (const e of msg.entries as {
            path: string;
            meta: Parameters<InstanceType<typeof SearchIndex>["setMeta"]>[1];
          }[]) {
            this.index.setMeta(e.path, e.meta);
          }
          return;
        case "INIT_DRAFTS":
          for (const e of msg.entries as {
            path: string;
            edits: Parameters<InstanceType<typeof SearchIndex>["setDrafts"]>[1];
          }[]) {
            this.index.setDrafts(e.path, e.edits);
          }
          return;
        case "UPSERT_PHOTO":
          this.index.setPhoto(
            msg.photo as Parameters<
              InstanceType<typeof SearchIndex>["setPhoto"]
            >[0],
          );
          return;
        case "UPSERT_META":
          this.index.setMeta(
            msg.path as string,
            msg.meta as Parameters<
              InstanceType<typeof SearchIndex>["setMeta"]
            >[1],
          );
          return;
        case "UPSERT_DRAFTS":
          this.index.setDrafts(
            msg.path as string,
            msg.edits as Parameters<
              InstanceType<typeof SearchIndex>["setDrafts"]
            >[1],
          );
          return;
        case "DELETE_PATH":
          this.index.deletePath(msg.path as string);
          return;
        case "QUERY": {
          const id = msg.id as number;
          const r = this.index.query(msg.query as string);
          setTimeout(() => {
            this.onmessage?.({
              data: {
                type: "RESULT",
                id,
                matched: r.matched,
                hasEditsFilter: r.hasEditsFilter,
              },
            });
          }, 0);
          return;
        }
      }
    }

    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }

  (globalThis as unknown as Record<string, unknown>).Worker =
    InThreadSearchWorker;
}

// Mock @tanstack/react-virtual to render all items in tests (no virtualization)
// This allows tests to find all rows without needing to simulate scrolling
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: () => number;
  }) => {
    const size = estimateSize();
    // Return a mock virtualizer that renders all items
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      start: index * size,
      size,
      end: (index + 1) * size,
      key: index,
    }));

    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * size,
      scrollToIndex: () => {},
      measure: () => {},
    };
  },
}));
