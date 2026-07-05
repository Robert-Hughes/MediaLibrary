// Temporal editor.  Each schema kind chooses the matching HTML input:
// date, time, or datetime-local. Save stores semantic temporal values and
// keeps the ExifTool storage string as display text for pending rows.

import { useState, useEffect, useRef } from "react";
import type {
  MetadataDraftEdit,
  MetadataValue,
  UtcOffsetValue,
} from "../../types";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import {
  timeOffset,
  toExiftoolDate,
  toExiftoolFormat,
  toExiftoolTime,
  toHtmlDate,
  toHtmlTime,
  toIsoLocal,
  formatTimeOffset,
  parseTimeOffset,
} from "./editorHelpers";

interface Props {
  propertyKey: string;
  mode?: "date" | "time" | "datetime";
  initialMetadataValue?: MetadataValue;
  initialValue: string;
  onSave: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function DateTimeEditor({
  propertyKey,
  mode = "datetime",
  initialMetadataValue,
  initialValue,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [value, setValue] = useState<string>(() => {
    if (initialMetadataValue) {
      if (mode === "date" && initialMetadataValue.kind === "Date") {
        const { year, month, day } = initialMetadataValue.value;
        return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      if (mode === "time" && initialMetadataValue.kind === "Time") {
        const { hour, minute, second } = initialMetadataValue.value;
        return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
      }
      if (mode === "datetime" && initialMetadataValue.kind === "DateTime") {
        const { date, time } = initialMetadataValue.value;
        const dStr = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
        const tStr = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}:${String(time.second).padStart(2, "0")}`;
        return `${dStr}T${tStr}`;
      }
    }

    if (mode === "date") return toHtmlDate(initialValue);
    if (mode === "time") return toHtmlTime(initialValue);
    return toIsoLocal(initialValue);
  });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const initialOffset = (() => {
    if (initialMetadataValue) {
      if (
        initialMetadataValue.kind === "Time" &&
        initialMetadataValue.value.offset
      ) {
        return formatTimeOffset(initialMetadataValue.value.offset);
      }
      if (
        initialMetadataValue.kind === "DateTime" &&
        initialMetadataValue.value.time.offset
      ) {
        return formatTimeOffset(initialMetadataValue.value.time.offset);
      }
    }
    return timeOffset(initialValue);
  })();
  const offsetRef = useRef(initialOffset);

  const subsecondRef = useRef<string | null>(
    (() => {
      if (initialMetadataValue) {
        if (initialMetadataValue.kind === "Time") {
          return initialMetadataValue.value.subsecond;
        }
        if (initialMetadataValue.kind === "DateTime") {
          return initialMetadataValue.value.time.subsecond;
        }
      }
      const match = initialValue.match(/\.(\d+)/);
      return match ? match[1] : null;
    })(),
  );

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

    const semanticOffset = (() => {
      if (initialMetadataValue) {
        if (
          initialMetadataValue.kind === "Time" &&
          initialMetadataValue.value.offset
        ) {
          return initialMetadataValue.value.offset;
        }
        if (
          initialMetadataValue.kind === "DateTime" &&
          initialMetadataValue.value.time.offset
        ) {
          return initialMetadataValue.value.time.offset;
        }
      }
      if (offsetRef.current) {
        return parseTimeOffset(offsetRef.current);
      }
      return null;
    })();

    const semanticValue = metadataValueFromTemporalString(
      mode,
      result,
      subsecondRef.current,
      semanticOffset,
    );
    if (!semanticValue) {
      setError("invalid semantic temporal value");
      return;
    }

    let display = result;
    if (subsecondRef.current) {
      if (mode === "time") {
        const offsetStr = offsetRef.current;
        const timePart =
          offsetStr && result.endsWith(offsetStr)
            ? result.slice(0, -offsetStr.length)
            : result;
        display = `${timePart}.${subsecondRef.current}${offsetStr}`;
      } else if (mode === "datetime") {
        const offsetStr = semanticOffset
          ? formatTimeOffset(semanticOffset)
          : "";
        display = `${result}.${subsecondRef.current}${offsetStr}`;
      }
    } else {
      if (mode === "datetime" && semanticOffset) {
        display = `${result}${formatTimeOffset(semanticOffset)}`;
      }
    }

    onSave({ value: semanticValue, intent: "Set", display });
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
  subsecond: string | null = null,
  initialOffset: UtcOffsetValue | null = null,
): MetadataValue | null {
  if (mode === "date") return dateValueFromStorage(value);
  if (mode === "time")
    return timeValueFromStorage(value, subsecond, initialOffset);
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
        subsecond,
        offset: initialOffset,
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

function timeValueFromStorage(
  value: string,
  subsecond: string | null = null,
  initialOffset: UtcOffsetValue | null = null,
): MetadataValue | null {
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
      subsecond,
      offset: sign
        ? {
            sign: sign === "+" ? "Plus" : "Minus",
            hours: Number(offsetHours),
            minutes: Number(offsetMinutes),
          }
        : initialOffset,
    },
  };
}
