import { afterEach, describe, expect, it } from "vitest";
import { installAltTextSelectionMode } from "../textSelectionMode";

describe("Alt text-selection mode", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.classList.remove("text-selection-mode");
  });

  it("enables selection while Alt is held and disables it on release", () => {
    cleanup = installAltTextSelectionMode(document, window);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
    expect(document.body).toHaveClass("text-selection-mode");

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    expect(document.body).not.toHaveClass("text-selection-mode");
  });

  it("clears selection mode when the window loses focus", () => {
    cleanup = installAltTextSelectionMode(document, window);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));

    window.dispatchEvent(new Event("blur"));

    expect(document.body).not.toHaveClass("text-selection-mode");
  });

  it("cleans up listeners and the body class", () => {
    cleanup = installAltTextSelectionMode(document, window);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));

    cleanup();
    cleanup = undefined;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));

    expect(document.body).not.toHaveClass("text-selection-mode");
  });
});
