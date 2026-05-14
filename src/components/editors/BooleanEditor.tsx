// Tri-state Boolean editor: true / false / unset (which Delete-intents the tag).
// Phase 4 minimum.

import { useState } from "react";
import type { DraftEdit } from "../../types";

interface Props {
  propertyKey: string;
  initialValue: boolean | null;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
}

export function BooleanEditor({ propertyKey, initialValue, onSave, onCancel }: Props) {
  const [value, setValue] = useState<boolean | null>(initialValue);

  const handleSave = () => {
    if (value === null) {
      onSave({ value: null, intent: "Delete" });
    } else {
      onSave({ value, intent: "Set" });
    }
  };

  return (
    <div className="dialog-overlay" data-testid="boolean-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        <div className="dialog-body">
          <div className="boolean-editor-radios">
            <label>
              <input
                type="radio"
                checked={value === true}
                onChange={() => setValue(true)}
                data-testid="boolean-editor-true"
              />
              True
            </label>
            <label>
              <input
                type="radio"
                checked={value === false}
                onChange={() => setValue(false)}
                data-testid="boolean-editor-false"
              />
              False
            </label>
            <label>
              <input
                type="radio"
                checked={value === null}
                onChange={() => setValue(null)}
                data-testid="boolean-editor-unset"
              />
              Unset (remove)
            </label>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="boolean-editor-save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
