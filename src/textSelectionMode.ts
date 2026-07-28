const TEXT_SELECTION_MODE_CLASS = "text-selection-mode";

/**
 * Makes displayed application text selectable only while Alt is held.
 * Editable controls remain selectable through CSS regardless of this mode.
 */
export function installAltTextSelectionMode(
  doc: Document,
  win: Window,
): () => void {
  const disable = () => doc.body.classList.remove(TEXT_SELECTION_MODE_CLASS);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Alt") {
      doc.body.classList.add(TEXT_SELECTION_MODE_CLASS);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Alt") disable();
  };
  const onVisibilityChange = () => {
    if (doc.visibilityState !== "visible") disable();
  };

  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("keyup", onKeyUp);
  win.addEventListener("blur", disable);
  doc.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    win.removeEventListener("keydown", onKeyDown);
    win.removeEventListener("keyup", onKeyUp);
    win.removeEventListener("blur", disable);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    disable();
  };
}
