import "@testing-library/jest-dom";
import { afterEach, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { SearchIndex } from "../search/searchIndex";

// jsdom exposes <dialog> but not its modal lifecycle. This deliberately models
// only the state and focus restoration our controlled wrapper depends on.
//
// IMPORTANT: the `close` event is dispatched in a later task via setTimeout,
// matching real-browser ordering.  Tests that depend on the close event must
// call `flushDialogCloseEvents()` to advance the timer.
const dialogOpeners = new WeakMap<HTMLDialogElement, HTMLElement | null>();
let previouslyFocused: HTMLElement | null = null;
let lastFocused: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    previouslyFocused = lastFocused;
    lastFocused = event.target as HTMLElement;
  });
}

const pendingDialogCloseTimers = new Set<number>();

/**
 * Flush all queued native `close` events from the dialog shim.
 *
 * Call this in tests that need to observe the close event (e.g. verifying
 * `onDismiss` was called after a native `dialog.close()`).
 */
export async function flushDialogCloseEvents() {
  const maxIterations = 20;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (pendingDialogCloseTimers.size === 0) return;

    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }

  if (pendingDialogCloseTimers.size === 0) return;

  throw new Error(
    `Dialog close timers did not settle after ${maxIterations} iterations`,
  );
}

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () {
    if (this.open) throw new DOMException("Dialog is already open");
    const active = document.activeElement as HTMLElement | null;
    dialogOpeners.set(this, this.contains(active) ? previouslyFocused : active);
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>(
      "[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )?.focus();
  };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.removeAttribute("open");
    dialogOpeners.get(this)?.focus();
    const timer = window.setTimeout(() => {
      pendingDialogCloseTimers.delete(timer);
      this.dispatchEvent(new Event("close"));
    }, 0);
    pendingDialogCloseTimers.add(timer);
  };
}

// jsdom does not implement the Popover API. Model only the controlled state
// used by the application error presenter.
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.showPopover = function () {
    if (this.dataset.popoverOpen === "true") {
      throw new DOMException("Popover is already open");
    }
    this.dataset.popoverOpen = "true";
    this.style.display = "block";
  };
  HTMLElement.prototype.hidePopover = function () {
    delete this.dataset.popoverOpen;
    this.style.display = "none";
  };
}

// user-event cannot ask jsdom's platform layer to issue a dialog close
// request, so translate Escape into the native event for legacy interaction
// tests. Application code still receives only `cancel`.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const dialogs = Array.from(
      document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
    );
    dialogs[dialogs.length - 1]?.dispatchEvent(
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
  });
}

// Unmount React trees between tests so the DOM doesn't bleed across
// `it()` blocks.  Without this, `screen.getByTestId(...)` in test N+1
// can hit elements left behind by test N and fail with confusing errors.
afterEach(async () => {
  cleanup();
  const [{ _clearTagInfoCache }, { _resetWritableSchemaDefinitionsCache }] =
    await Promise.all([
      import("../hooks/useTagInfo"),
      import("../hooks/useWritableSchemaDefinitions"),
    ]);
  _clearTagInfoCache();
  _resetWritableSchemaDefinitionsCache();
  // Cancel any unconsumed dialog close timers so they cannot leak into the
  // next test.  We cancel rather than flush to avoid dispatching events
  // after React cleanup (which would cause act() warnings).
  for (const timer of pendingDialogCloseTimers) {
    clearTimeout(timer);
  }
  pendingDialogCloseTimers.clear();
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
          for (const file of msg.files as Parameters<
            InstanceType<typeof SearchIndex>["setFile"]
          >[0][]) {
            this.index.setFile(file);
          }
          return;
        case "INIT_OCCURRENCES":
          this.index.setSchemaLabels(
            msg.schemaLabels as Parameters<
              InstanceType<typeof SearchIndex>["setSchemaLabels"]
            >[0],
          );
          for (const entry of msg.entries as Array<{
            path: string;
            occurrences: Parameters<
              InstanceType<typeof SearchIndex>["setOccurrences"]
            >[1];
          }>) {
            this.index.setOccurrences(entry.path, entry.occurrences);
          }
          return;
        case "INIT_DRAFTS":
          this.index.setSchemaLabels(
            msg.schemaLabels as Parameters<
              InstanceType<typeof SearchIndex>["setSchemaLabels"]
            >[0],
          );
          for (const entry of msg.entries as Array<{
            path: string;
            edits: Parameters<InstanceType<typeof SearchIndex>["setDrafts"]>[1];
          }>) {
            this.index.setDrafts(entry.path, entry.edits);
          }
          return;
        case "UPSERT_PHOTO":
          this.index.setFile(
            msg.file as Parameters<
              InstanceType<typeof SearchIndex>["setFile"]
            >[0],
          );
          return;
        case "UPSERT_OCCURRENCES":
          this.index.setSchemaLabels(
            msg.schemaLabels as Parameters<
              InstanceType<typeof SearchIndex>["setSchemaLabels"]
            >[0],
          );
          this.index.setOccurrences(
            msg.path as string,
            msg.occurrences as Parameters<
              InstanceType<typeof SearchIndex>["setOccurrences"]
            >[1],
          );
          return;
          return;
        case "UPSERT_DRAFTS":
          this.index.setSchemaLabels(
            msg.schemaLabels as Parameters<
              InstanceType<typeof SearchIndex>["setSchemaLabels"]
            >[0],
          );
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
          queueMicrotask(() => {
            this.onmessage?.({
              data: {
                type: "RESULT",
                id,
                matched: r.matched,
                hasEditsFilter: r.hasEditsFilter,
              },
            });
          });
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
const virtualizerScrollToIndex = vi.hoisted(() => vi.fn());

export function getVirtualizerScrollToIndexMock() {
  return virtualizerScrollToIndex;
}

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
      scrollToIndex: virtualizerScrollToIndex,
      measure: () => {},
    };
  },
}));
