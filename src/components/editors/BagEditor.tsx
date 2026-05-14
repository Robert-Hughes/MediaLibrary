// Chip editor for Bag<Text> tags (XMP-dc:Subject, IPTC:Keywords, etc.).
//
// First concrete typed editor (Phase 4 MVP).  Emits a typed DraftEdit with
// value = Variant::List([Variant::String, …]) and intent = Set.  Replaces the
// keywords-CSV corruption mode of the legacy text input by maintaining
// chip-level identity.

import { useState, useEffect, useRef } from "react";
import type { DraftEdit, Variant } from "../../types";

interface Props {
  propertyKey: string;
  /** Initial chips, parsed from either a Variant::List or a comma-joined string. */
  initialItems: string[];
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
}

export function BagEditor({ propertyKey, initialItems, onSave, onCancel }: Props) {
  const [items, setItems] = useState<string[]>(initialItems);
  const [draftItem, setDraftItem] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commitDraftItem = () => {
    const trimmed = draftItem.trim();
    if (!trimmed) return;
    if (items.includes(trimmed)) {
      setDraftItem("");
      return;
    }
    setItems([...items, trimmed]);
    setDraftItem("");
  };

  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraftItem();
    } else if (e.key === "Backspace" && !draftItem && items.length > 0) {
      e.preventDefault();
      removeItem(items.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const handleSave = () => {
    // If the user typed without pressing Enter, fold the pending text in.
    let final = items;
    const trimmed = draftItem.trim();
    if (trimmed && !final.includes(trimmed)) {
      final = [...final, trimmed];
    }
    const list: Variant = final.map((s) => s as Variant);
    onSave({ value: list, intent: "Set" });
  };

  return (
    <div className="dialog-overlay" data-testid="bag-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        <div className="dialog-body">
          <div className="bag-editor-chips" data-testid="bag-editor-chips">
            {items.map((item, idx) => (
              <span key={`${item}-${idx}`} className="bag-editor-chip" data-testid="bag-editor-chip">
                <span className="bag-editor-chip-text">{item}</span>
                <button
                  type="button"
                  className="bag-editor-chip-remove"
                  aria-label={`Remove ${item}`}
                  onClick={() => removeItem(idx)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              type="text"
              className="bag-editor-input"
              value={draftItem}
              placeholder={items.length === 0 ? "Add items…" : "Add another…"}
              onChange={(e) => setDraftItem(e.target.value)}
              onKeyDown={handleInputKeyDown}
              onBlur={commitDraftItem}
              data-testid="bag-editor-input"
            />
          </div>
          <p className="dialog-hint">
            Press Enter or comma to add an item. Backspace on an empty input removes the last item.
          </p>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="bag-editor-save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Best-effort initial-items extraction from whatever the caller has on hand:
 * a Variant value, the legacy comma-joined display string, or undefined.
 */
export function initialItemsFrom(value: Variant | string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : String(v)))
      .filter((s) => s.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // bool/number/object: not list-shaped; treat as a single chip if non-empty.
  const s = String(value);
  return s ? [s] : [];
}
