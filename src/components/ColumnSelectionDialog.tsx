import { useState } from "react";

interface Props {
  allKeys: Array<{ key: string; count: number }>;
  visibleColumns: string[];
  visibleOSColumns: string[];
  onSave: (columns: string[], osColumns: string[]) => void;
  onClose: () => void;
}

export function ColumnSelectionDialog({ allKeys, visibleColumns, visibleOSColumns, onSave, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(visibleColumns));
  const [selectedOS, setSelectedOS] = useState<Set<string>>(new Set(visibleOSColumns));

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

  // Sort keys by frequency (descending), then alphabetically
  const sortedKeys = [...allKeys].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.key.localeCompare(b.key);
  });

  return (
    <div className="dialog-overlay" onClick={onClose} data-testid="column-dialog-overlay">
      <div className="dialog-content column-dialog" onClick={(e) => e.stopPropagation()} data-testid="column-dialog">
        <div className="dialog-header">
          <h2 className="dialog-title">Select Columns</h2>
          <button className="dialog-close-btn" onClick={onClose}>&times;</button>
        </div>
        
        <div className="dialog-body column-list-area">
          <p className="dialog-hint">Choose which columns to display in the photo list.</p>
          
          {/* OS Metadata Section */}
          <div className="column-section">
            <h3 className="column-section-title">OS Metadata</h3>
            <div className="column-list">
              <label className="column-item">
                <input
                  type="checkbox"
                  checked={selectedOS.has("date_modified")}
                  onChange={() => toggleOS("date_modified")}
                  className="column-checkbox"
                />
                <span className="column-label">Date Modified</span>
              </label>
              <label className="column-item">
                <input
                  type="checkbox"
                  checked={selectedOS.has("date_created")}
                  onChange={() => toggleOS("date_created")}
                  className="column-checkbox"
                />
                <span className="column-label">Date Created</span>
              </label>
            </div>
          </div>

          {/* Image Metadata Section */}
          <div className="column-section">
            <h3 className="column-section-title">Image Metadata</h3>
            <div className="column-list">
              {sortedKeys.map(({ key, count }) => (
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
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => onSave(Array.from(selected), Array.from(selectedOS))}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}
