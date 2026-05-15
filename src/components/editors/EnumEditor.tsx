// Dropdown editor for Enum tags (Orientation, Flash mode, WhiteBalance, …).
//
// The schema gives us the full `(code, label)` list.  Draft stores the code
// (integer or string) directly so write-back can pass it to exiftool with
// `-n` for Enum<Integer> or as-is for Enum<String>.
//
// Out-of-spec values (`Orientation = 9` in a weird file) fall through to a
// raw "Custom…" code entry so the user can still edit without losing the
// existing value.

import { useEffect, useState } from "react";
import type { DraftEdit, EnumOption, EnumRepr, Variant } from "../../types";

interface Props {
  propertyKey: string;
  repr: EnumRepr;
  options: EnumOption[];
  initialCode: string;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
}

export function EnumEditor({ propertyKey, repr, options, initialCode, onSave, onCancel, headerHint }: Props) {
  const [selected, setSelected] = useState<string>(initialCode);
  const [customMode, setCustomMode] = useState<boolean>(!options.some((o) => o.code === initialCode));
  const [customValue, setCustomValue] = useState<string>(initialCode);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const handleSave = () => {
    const code = customMode ? customValue.trim() : selected;
    if (!code) return;
    const variant: Variant = repr === "Integer" ? Number(code) : code;
    onSave({ value: variant, intent: "Set" });
  };

  return (
    <div className="dialog-overlay" data-testid="enum-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          {!customMode && (
            <select
              className="enum-editor-select"
              value={selected}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setCustomMode(true);
                } else {
                  setSelected(e.target.value);
                }
              }}
              data-testid="enum-editor-select"
            >
              {options.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label} ({o.code})
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
          )}
          {customMode && (
            <div>
              <input
                type="text"
                className="dialog-input"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                placeholder={repr === "Integer" ? "Enter a numeric code" : "Enter a string value"}
                data-testid="enum-editor-custom"
              />
              <button
                type="button"
                className="dialog-btn dialog-btn-secondary"
                onClick={() => setCustomMode(false)}
                style={{ marginTop: 8 }}
              >
                ← Back to list
              </button>
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="enum-editor-save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Extract the current code (raw or pretty label) from whatever we have. */
export function initialCodeFrom(
  raw: Variant | undefined,
  display: Variant | undefined,
  options: EnumOption[],
): string {
  // Prefer the raw value: it's already the code form.
  if (raw !== undefined && raw !== null && !Array.isArray(raw) && typeof raw !== "object") {
    return String(raw);
  }
  // Look up the display label in the options table.
  if (typeof display === "string") {
    const match = options.find((o) => o.label === display);
    if (match) return match.code;
    return display;
  }
  if (typeof display === "number") return String(display);
  return options[0]?.code ?? "";
}
