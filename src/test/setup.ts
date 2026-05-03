import "@testing-library/jest-dom";

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
