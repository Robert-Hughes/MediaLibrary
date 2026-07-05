// Temporal editor.  Each schema kind chooses the matching HTML input:
// date, time, or datetime-local. Save stores semantic temporal values and
// keeps the ExifTool storage string as display text for pending rows.

import { useState, useEffect, useRef } from "react";
import type { MetadataDraftEdit, MetadataValue } from "../../types";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import {
  timeOffset,
  toExiftoolDate,
  toExiftoolFormat,
  toExiftoolTime,
  toHtmlDate,
  toHtmlTime,
  toIsoLocal,
} from "./editorHelpers";

interface Props {
  propertyKey: string;
  mode?: "date" | "time" | "datetime";
  initialValue: string;
  onSave: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function DateTimeEditor({
  propertyKey,
  mode = "datetime",
  initialValue,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [value, setValue] = useState<string>(() => {
    if (mode === "date") return toHtmlDate(initialValue);
    if (mode === "time") return toHtmlTime(initialValue);
    return toIsoLocal(initialValue);
  });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const offsetRef = useRef(timeOffset(initialValue));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSave = () => {
    if (readOnly) return;
    const result =
      mode === "date"
        ? toExiftoolDate(value)
        : mode === "time"
          ? toExiftoolTime(value, offsetRef.current)
          : toExiftoolFormat(value);
    if (result === null) {
      setError(
        mode === "date"
          ? "invalid date"
          : mode === "time"
            ? "invalid time"
            : "invalid date/time",
      );
      return;
    }
    const semanticValue = metadataValueFromTemporalString(mode, result);
    if (!semanticValue) {
      setError("invalid semantic temporal value");
      return;
    }
    onSave({ value: semanticValue, intent: "Set", display: result });
  };

  const inputType =
    mode === "date" ? "date" : mode === "time" ? "time" : "datetime-local";
  const storageHint =
    mode === "date"
      ? "YYYY:MM:DD"
      : mode === "time"
        ? "HH:MM:SS"
        : "YYYY:MM:DD HH:MM:SS";

  return (
    <div className="dialog-overlay" data-testid="datetime-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <input
            ref={inputRef}
            type={inputType}
            step="1"
            className="dialog-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            data-testid="datetime-editor-input"
            data-temporal-mode={mode}
          />
          <p className="dialog-hint">
            Saved as <code>{storageHint}</code> in the file.
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

function metadataValueFromTemporalString(
  mode: "date" | "time" | "datetime",
  value: string,
): MetadataValue | null {
  if (mode === "date") return dateValueFromStorage(value);
  if (mode === "time") return timeValueFromStorage(value);
  const match = value.match(
    /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return {
    kind: "DateTime",
    value: {
      date: {
        year: Number(year),
        month: Number(month),
        day: Number(day),
      },
      time: {
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
        subsecond: null,
        offset: null,
      },
    },
  };
}

function dateValueFromStorage(value: string): MetadataValue | null {
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return {
    kind: "Date",
    value: {
      year: Number(year),
      month: Number(month),
      day: Number(day),
    },
  };
}

function timeValueFromStorage(value: string): MetadataValue | null {
  const match = value.match(
    /^(\d{2}):(\d{2}):(\d{2})(?:([+-])(\d{2}):?(\d{2}))?$/,
  );
  if (!match) return null;
  const [, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
  return {
    kind: "Time",
    value: {
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
      subsecond: null,
      offset: sign
        ? {
            sign: sign === "+" ? "Plus" : "Minus",
            hours: Number(offsetHours),
            minutes: Number(offsetMinutes),
          }
        : null,
    },
  };
}
