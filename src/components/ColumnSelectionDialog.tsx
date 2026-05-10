import { useState, useEffect } from "react";
import { DEFAULT_VISIBLE_COLUMNS, OS_COLUMN_KEYS } from "../utils/columnConfig";
import type { VisibleColumn } from "../types";

interface Props {
  allKeys: Array<{ key: string; count: number }>;
  visibleColumns: VisibleColumn[];
  onSave: (columns: VisibleColumn[], resetWidths?: boolean) => void;
  onClose: () => void;
}

const OS_OPTIONS = [
  { key: "date_modified", label: "Date Modified" },
  { key: "date_created", label: "Date Created" },
];

/**
 * Build the saved column array from selected sets.
 *
 * Existing entries (still selected) keep their original order so reorders
 * survive a save. Newly checked entries are appended in section order:
 * OS first, then image (matching the default layout).
 */
function mergeSelection(
  existing: VisibleColumn[],
  selectedOS: Set<string>,
  selectedImage: Set<string>,
): VisibleColumn[] {
  const kept = existing.filter((c) =>
    c.kind === "os" ? selectedOS.has(c.key) : selectedImage.has(c.key),
  );
  const keptKeys = new Set(kept.map((c) => c.key));
  const additions: VisibleColumn[] = [];
  for (const key of OS_COLUMN_KEYS) {
    if (selectedOS.has(key) && !keptKeys.has(key)) additions.push({ key, kind: "os" });
  }
  for (const key of selectedImage) {
    if (!keptKeys.has(key)) additions.push({ key, kind: "image" });
  }
  return [...kept, ...additions];
}

export function ColumnSelectionDialog({ allKeys, visibleColumns, onSave, onClose }: Props) {
  const initialOS = new Set(visibleColumns.filter((c) => c.kind === "os").map((c) => c.key));
  const initialImage = new Set(visibleColumns.filter((c) => c.kind === "image").map((c) => c.key));
  const [selectedOS, setSelectedOS] = useState<Set<string>>(initialOS);
  const [selected, setSelected] = useState<Set<string>>(initialImage);
  // Order basis for the saved array: usually mirrors the prop, but the
  // "Default" button swaps it to DEFAULT_VISIBLE_COLUMNS so default ordering
  // takes effect even if the user had reordered columns previously.
  const [orderBasis, setOrderBasis] = useState<VisibleColumn[]>(visibleColumns);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [resetWidths, setResetWidths] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSave(mergeSelection(orderBasis, selectedOS, selected), resetWidths);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selected, selectedOS, onSave, onClose, orderBasis, resetWidths]);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const toggleOS = (key: string) => {
    const next = new Set(selectedOS);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedOS(next);
  };

  const selectAll = () => {
    setSelected(new Set(allKeys.map((k) => k.key)));
    setSelectedOS(new Set(OS_COLUMN_KEYS));
  };

  const deselectAll = () => {
    setSelected(new Set());
    setSelectedOS(new Set());
  };

  const resetToDefaults = () => {
    setSelected(new Set(DEFAULT_VISIBLE_COLUMNS.filter((c) => c.kind === "image").map((c) => c.key)));
    setSelectedOS(new Set(DEFAULT_VISIBLE_COLUMNS.filter((c) => c.kind === "os").map((c) => c.key)));
    setOrderBasis(DEFAULT_VISIBLE_COLUMNS);
    setResetWidths(true);
  };

  const sortedKeys = [...allKeys].sort((a, b) => a.key.localeCompare(b.key));

  const lowerSearch = searchTerm.toLowerCase();

  const filteredKeys = sortedKeys.filter(({ key }) =>
    key.toLowerCase().includes(lowerSearch),
  );

  const filteredOSColumns = OS_OPTIONS.filter(({ key, label }) =>
    key.toLowerCase().includes(lowerSearch) || label.toLowerCase().includes(lowerSearch),
  );

  return (
    <div className="dialog-overlay" onClick={onClose} data-testid="column-dialog-overlay">
      <div className="dialog-content column-dialog" onClick={(e) => e.stopPropagation()} data-testid="column-dialog">
        <div className="dialog-header">
          <h2 className="dialog-title">Select Columns</h2>
          <button className="dialog-close-btn" onClick={onClose}>&times;</button>
        </div>

        <div className="dialog-body column-list-area">
          <p className="dialog-hint">Choose which columns to display in the photo list.</p>

          <div className="column-actions">
            <button className="btn-secondary btn-small" onClick={selectAll}>Select All</button>
            <button className="btn-secondary btn-small" onClick={deselectAll}>Deselect All</button>
            <button className="btn-secondary btn-small" onClick={resetToDefaults}>Default</button>
          </div>

          <div className="column-search">
            <input
              type="text"
              placeholder="Search columns..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="column-search-input"
            />
          </div>

          {filteredOSColumns.length > 0 && (
            <div className="column-section">
              <h3 className="column-section-title">OS Metadata</h3>
              <div className="column-list">
                {filteredOSColumns.map(({ key, label }) => (
                  <label key={key} className="column-item">
                    <input
                      type="checkbox"
                      checked={selectedOS.has(key)}
                      onChange={() => toggleOS(key)}
                      className="column-checkbox"
                    />
                    <span className="column-label">{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="column-section">
            <h3 className="column-section-title">Image Metadata</h3>
            <div className="column-list">
              {filteredKeys.map(({ key, count }) => (
                <label key={key} className="column-item">
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => toggle(key)}
                    className="column-checkbox"
                  />
                  <span className="column-label">{key}</span>
                  <span className="column-count">({count} files)</span>
                </label>
              ))}
              {filteredKeys.length === 0 && filteredOSColumns.length === 0 && searchTerm && (
                <div className="no-results">No columns match your search.</div>
              )}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => onSave(mergeSelection(orderBasis, selectedOS, selected), resetWidths)}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
