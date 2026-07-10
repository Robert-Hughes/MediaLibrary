import { useState, useEffect, useRef } from "react";
import type { MetadataDraftEdit, MetadataValue } from "../../types";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import { parseTimeOffset, formatTimeOffset } from "./editorHelpers";

interface Props {
  propertyKey: string;
  initialMetadataValue?: MetadataValue;
  onSave: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function TimeOffsetEditor({
  propertyKey,
  initialMetadataValue,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [value, setValue] = useState<string>(() => {
    if (initialMetadataValue && initialMetadataValue.kind === "TimeOffset") {
      return formatTimeOffset(initialMetadataValue.value);
    }
    return initialMetadataValue?.kind === "Text"
      ? initialMetadataValue.value
      : "";
  });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSave = () => {
    if (readOnly) return;
    const offset = parseTimeOffset(value);
    if (!offset) {
      setError(
        "Invalid offset format. Expected format like +01:00, -05:30, or Z",
      );
      return;
    }
    onSave({
      value: {
        kind: "TimeOffset",
        value: offset,
      },
      intent: "Set",
      display: formatTimeOffset(offset),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="dialog-overlay" data-testid="timeoffset-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <input
            ref={inputRef}
            type="text"
            className="dialog-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="e.g. +01:00, -05:30, Z"
            data-testid="timeoffset-editor-input"
          />
          <p className="dialog-hint">
            Enter offset as <code>+HH:MM</code>, <code>-HH:MM</code>, or{" "}
            <code>Z</code>.
          </p>
          {error && (
            <p className="dialog-error" data-testid="timeoffset-editor-error">
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
            data-testid="timeoffset-editor-save"
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
