import "@testing-library/jest-dom";
import { vi } from "vitest";

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
  useVirtualizer: ({ count }: { count: number }) => {
    // Return a mock virtualizer that renders all items
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      start: index * 80,
      size: 80,
      end: (index + 1) * 80,
      key: index,
    }));
    
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * 80,
      scrollToIndex: () => {},
    };
  },
}));
