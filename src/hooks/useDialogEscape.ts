import { useEffect } from "react";

/**
 * Registers a `document`-level Escape key handler that fires `onEscape`
 * and calls `stopPropagation()` so parent overlays (e.g. the gallery)
 * don't also close in the same keystroke.
 *
 * Prefer this hook in dialog / editor components that render a
 * `.dialog-overlay` and need Escape-to-close behaviour.  Components
 * that already handle Escape via a React `onKeyDown` prop should call
 * `e.stopPropagation()` inline instead.
 */
export function useDialogEscape(onEscape: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onEscape]);
}
