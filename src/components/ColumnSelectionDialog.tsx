import { useState, useEffect } from "react";
import { DEFAULT_COLUMNS, DEFAULT_OS_COLUMNS } from "../utils/columnConfig";

interface Props {
  allKeys: Array<{ key: string; count: number }>;
  visibleColumns: string[];
  visibleOSColumns: string[];
  onSave: (columns: string[], osColumns: string[], resetWidths?: boolean) => void;
  onClose: () => void;
}

export function ColumnSelectionDialog({ allKeys, visibleColumns, visibleOSColumns, onSave, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(visibleColumns));
  const [selectedOS, setSelectedOS] = useState<Set<string>>(new Set(visibleOSColumns));
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [resetWidths, setResetWidths] = useState(false);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSave(Array.from(selected), Array.from(selectedOS), resetWidths);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selected, selectedOS, onSave, onClose]);

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
    setSelected(new Set(allKeys.map(k => k.key)));
    setSelectedOS(new Set(["date_modified", "date_created"]));
  };

  const deselectAll = () => {
    setSelected(new Set());
    setSelectedOS(new Set());
  };

  const resetToDefaults = () => {
    setSelected(new Set(DEFAULT_COLUMNS));
    setSelectedOS(new Set(DEFAULT_OS_COLUMNS));
    setResetWidths(true);
  };

  // Sort keys alphabetically instead of by frequency
  const sortedKeys = [...allKeys].sort((a, b) => a.key.localeCompare(b.key));

  const lowerSearch = searchTerm.toLowerCase();

  // Filter keys based on search term
  const filteredKeys = sortedKeys.filter(({ key }) =>
    key.toLowerCase().includes(lowerSearch)
  );

  const osColumns = [
    { key: "date_modified", label: "Date Modified" },
    { key: "date_created", label: "Date Created" },
  ];
  const filteredOSColumns = osColumns.filter(({ key, label }) =>
    key.toLowerCase().includes(lowerSearch) || label.toLowerCase().includes(lowerSearch)
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

          {/* OS Metadata Section — hidden entirely when search filters out all OS columns */}
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

          {/* Image Metadata Section */}
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
          <button className="btn-primary" onClick={() => onSave(Array.from(selected), Array.from(selectedOS), resetWidths)}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}
