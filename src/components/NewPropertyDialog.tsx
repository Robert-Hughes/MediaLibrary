import { useState, useRef, useEffect } from "react";

interface Props {
  onSave: (key: string, value: string) => void;
  onCancel: () => void;
}

export function NewPropertyDialog({ onSave, onCancel }: Props) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const keyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    keyInputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && key && value) {
      onSave(key, value);
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog-content">
        <h3>Add New Property</h3>
        <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", opacity: 0.8 }}>Key (e.g. XMP-dc:Description)</label>
            <input
              ref={keyInputRef}
              type="text"
              className="dialog-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="XMP-dc:Description"
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", opacity: 0.8 }}>Value</label>
            <input
              type="text"
              className="dialog-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Value"
            />
          </div>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button 
            className="dialog-btn dialog-btn-primary" 
            onClick={() => onSave(key, value)}
            disabled={!key || !value}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
