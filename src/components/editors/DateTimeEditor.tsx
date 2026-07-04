// DateTime editor.  exiftool's canonical format is
//   YYYY:MM:DD HH:MM:SS±ZZ:ZZ
// We emit that format on save.  The input uses the HTML datetime-local
// control, which yields ISO `YYYY-MM-DDTHH:MM:SS` (no tz).  We convert.

import { useState, useEffect, useRef } from "react";
import type { DraftEdit } from "../../types";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import { toIsoLocal, toExiftoolFormat } from "./editorHelpers";

interface Props {
  propertyKey: string;
  initialValue: string;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function DateTimeEditor({
  propertyKey,
  initialValue,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [value, setValue] = useState<string>(toIsoLocal(initialValue));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSave = () => {
    if (readOnly) return;
    const result = toExiftoolFormat(value);
    if (result === null) {
      setError("invalid date/time");
      return;
    }
    onSave({ value: result, intent: "Set" });
  };

  return (
    <div className="dialog-overlay" data-testid="datetime-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <input
            ref={inputRef}
            type="datetime-local"
            step="1"
            className="dialog-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            data-testid="datetime-editor-input"
          />
          <p className="dialog-hint">
            Saved as <code>YYYY:MM:DD HH:MM:SS</code> in the file.
          </p>
          {error && (
            <p className="dialog-error" data-testid="datetime-editor-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button
            className="dialog-btn dialog-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="datetime-editor-save"
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TOOLTIP : undefined}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
