// Numeric editor for Integer / Real / Rational tags.
//
// Phase 4 minimum: single numeric input with optional bounds enforcement
// (Integer min/max from the schema).  Rational tags get the same control
// for now; a num/den toggle is a follow-up refinement.

import { useState, useEffect, useRef } from "react";
import type { DraftEdit, Variant } from "../../types";

interface Props {
  propertyKey: string;
  kind: "Integer" | "Real" | "Rational";
  min?: number | null;
  max?: number | null;
  initialValue: string;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
}

export function NumericEditor({ propertyKey, kind, min, max, initialValue, onSave, onCancel, headerHint }: Props) {
  const [value, setValue] = useState<string>(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const validate = (s: string): { ok: true; variant: Variant } | { ok: false; error: string } => {
    const trimmed = s.trim();
    if (trimmed === "") return { ok: false, error: "value is empty" };
    if (kind === "Integer") {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, error: "must be an integer" };
      }
      if (min !== null && min !== undefined && n < min) {
        return { ok: false, error: `must be ≥ ${min}` };
      }
      if (max !== null && max !== undefined && n > max) {
        return { ok: false, error: `must be ≤ ${max}` };
      }
      return { ok: true, variant: n };
    }
    // Real or Rational: accept any finite float.  Rational num/den toggle is
    // a follow-up.
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return { ok: false, error: "must be a number" };
    }
    return { ok: true, variant: n };
  };

  const handleSave = () => {
    const result = validate(value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSave({ value: result.variant, intent: "Set" });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="dialog-overlay" data-testid="numeric-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <input
            ref={inputRef}
            type="number"
            inputMode={kind === "Integer" ? "numeric" : "decimal"}
            step={kind === "Integer" ? "1" : "any"}
            min={min ?? undefined}
            max={max ?? undefined}
            className="dialog-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            data-testid="numeric-editor-input"
          />
          {error && <p className="dialog-error" data-testid="numeric-editor-error">{error}</p>}
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="numeric-editor-save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
