import { useState, useEffect, useRef } from "react";

interface Props {
  propertyKey: string;
  initialValue: string;
  onSave: (newValue: string) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
}

export function ValueEditDialog({ propertyKey, initialValue, onSave, onCancel, headerHint }: Props) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      onSave(value);
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <input
            ref={inputRef}
            type="text"
            className="dialog-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog-btn dialog-btn-primary" onClick={() => onSave(value)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
