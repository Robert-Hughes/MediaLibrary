/**
 * ContextMenu viewport-fit tests: a right-click near the bottom-right
 * edge of the window must not get clipped — the menu flips to the
 * cursor's top-left so its full content stays visible.
 */
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextMenu } from "../components/ContextMenu";

beforeEach(() => {
  cleanup();
  // jsdom reports both dimensions as 0; pin a real viewport for the test.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
});

function options(n = 3) {
  return Array.from({ length: n }, (_, i) => ({ label: `Item ${i}`, onClick: vi.fn() }));
}

function mockMenuSize(width: number, height: number) {
  // jsdom doesn't run layout, so the menu reports 0×0 by default.  Stub
  // getBoundingClientRect to assert positioning logic with realistic dims.
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("context-menu")) {
      return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => "" } as DOMRect;
    }
    return original.call(this);
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

describe("ContextMenu viewport fit", () => {
  it("renders at the cursor when there is room", () => {
    const restore = mockMenuSize(200, 120);
    try {
      render(<ContextMenu x={100} y={100} options={options()} onClose={() => {}} />);
      const menu = screen.getByTestId("context-menu");
      expect(menu.style.left).toBe("100px");
      expect(menu.style.top).toBe("100px");
    } finally { restore(); }
  });

  it("flips left when the cursor is near the right edge", () => {
    const restore = mockMenuSize(200, 120);
    try {
      render(<ContextMenu x={750} y={100} options={options()} onClose={() => {}} />);
      const menu = screen.getByTestId("context-menu");
      // 750 + 200 > 800 → flip: left = max(4, 750 - 200) = 550
      expect(menu.style.left).toBe("550px");
      expect(menu.style.top).toBe("100px");
    } finally { restore(); }
  });

  it("flips up when the cursor is near the bottom edge", () => {
    const restore = mockMenuSize(200, 120);
    try {
      render(<ContextMenu x={100} y={560} options={options()} onClose={() => {}} />);
      const menu = screen.getByTestId("context-menu");
      // 560 + 120 > 600 → flip: top = max(4, 560 - 120) = 440
      expect(menu.style.top).toBe("440px");
      expect(menu.style.left).toBe("100px");
    } finally { restore(); }
  });

  it("flips both ways near the bottom-right corner", () => {
    const restore = mockMenuSize(200, 120);
    try {
      render(<ContextMenu x={750} y={560} options={options()} onClose={() => {}} />);
      const menu = screen.getByTestId("context-menu");
      expect(menu.style.left).toBe("550px");
      expect(menu.style.top).toBe("440px");
    } finally { restore(); }
  });
});
