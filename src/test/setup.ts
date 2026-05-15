import "@testing-library/jest-dom";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

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
  try { localStorage.clear(); } catch { /* jsdom may have torn it down */ }
});

// jsdom does not implement IntersectionObserver — provide a no-op stub so
// components that use it can render without errors in tests.
// Individual tests that want to assert on observer behaviour can override
// this with vi.stubGlobal / vi.unstubAllGlobals.
if (typeof IntersectionObserver === "undefined") {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Mock @tanstack/react-virtual to render all items in tests (no virtualization)
// This allows tests to find all rows without needing to simulate scrolling
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
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
