import { useState, useEffect, useRef } from "react";
import { READ_ONLY_TOOLTIP } from "./editors/readOnlyMessages";

interface Props {
  propertyKey: string;
  initialValue: string;
  onSave: (newValue: string) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function ValueEditDialog({ propertyKey, initialValue, onSave, onCancel, headerHint, readOnly }: Props) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (!readOnly) onSave(value);
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
            data-testid="value-edit-input"
          />
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={() => onSave(value)}
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TOOLTIP : undefined}
            data-testid="value-edit-save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
