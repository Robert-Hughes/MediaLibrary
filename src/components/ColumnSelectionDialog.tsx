import { useState } from "react";

interface Props {
  allKeys: Array<{ key: string; count: number }>;
  visibleColumns: string[];
  onSave: (columns: string[]) => void;
  onClose: () => void;
}

export function ColumnSelectionDialog({ allKeys, visibleColumns, onSave, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(visibleColumns));

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
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
          <p className="dialog-hint">Choose which image metadata fields to display as columns.</p>
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

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => onSave(Array.from(selected))}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}
