// Phase 8.4 — numerator/denominator editor for Rational tags.
//
// Rational EXIF tags (ExposureTime, ShutterSpeedValue, FNumber-as-rational,
// some MakerNotes timing fields) are typically presented as `1/250`.  The
// previous Real-style single-input editor hid the rational nature: the user
// could only type a decimal, and a power-of-two shutter speed like `1/8000`
// became `0.000125`.
//
// This editor exposes both shapes:
//
//   - Fraction mode (default): two integer inputs `num` / `den`, den ≥ 1.
//                                Save commits Variant::Float(num/den).
//   - Decimal mode (toggle):   single Real-style input.  Same Float commit.
//
// Both modes round-trip through Variant::Float because exiftool's `-n` write
// path accepts either form for rational tags and stores the canonical
// rational it derives from the decimal — no information is lost on the
// fraction → decimal conversion at save time, and on the next read pass A
// will once again pretty-print the rational form.

import { useState, useEffect, useRef } from "react";
import type { DraftEdit, Variant } from "../../types";

interface Props {
  propertyKey: string;
  initialValue: string;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

/** Best-effort split of an initial value into num/den.  Accepts:
 *
 *   - `"1/250"`        → (1, 250)
 *   - `"0.004"`        → (1, 250) via decimal-to-rational with a 1e6 cap
 *   - `""` / unparseable → (1, 1) so the editor isn't empty.
 */
function initialFraction(s: string): { num: number; den: number } {
  const trimmed = s.trim();
  const slash = trimmed.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (slash) {
    const n = parseInt(slash[1], 10);
    const d = parseInt(slash[2], 10);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) {
      return { num: n, den: Math.abs(d) };
    }
  }
  const dec = parseFloat(trimmed);
  if (!Number.isFinite(dec)) return { num: 1, den: 1 };
  return decimalToRational(dec);
}

/** Convert a decimal to a reduced rational using a 1e6 denominator cap.
 *  Sufficient for shutter speeds and similar EXIF rationals; not arbitrary
 *  precision.  Returns (n, 1) for integers. */
export function decimalToRational(d: number): { num: number; den: number } {
  if (!Number.isFinite(d)) return { num: 0, den: 1 };
  if (Number.isInteger(d)) return { num: d, den: 1 };
  const sign = d < 0 ? -1 : 1;
  const v = Math.abs(d);
  // Try denominators up to 1e6 looking for the smallest that gives a near-
  // integer numerator.  Linear scan is fine at this size.
  const maxDen = 1_000_000;
  for (let den = 1; den <= maxDen; den *= 10) {
    const n = v * den;
    if (Math.abs(n - Math.round(n)) < 1e-9) {
      const num = Math.round(n);
      const g = gcd(num, den);
      return { num: sign * (num / g), den: den / g };
    }
  }
  // Fall back to a 1e6 denominator and reduce.
  const num = Math.round(v * maxDen);
  const g = gcd(num, maxDen);
  return { num: sign * (num / g), den: maxDen / g };
}

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b !== 0) { const t = b; b = a % b; a = t; }
  return a || 1;
}

export function RationalEditor({ propertyKey, initialValue, onSave, onCancel, headerHint, readOnly }: Props) {
  const initial = initialFraction(initialValue);
  const [mode, setMode] = useState<"fraction" | "decimal">("fraction");
  const [num, setNum] = useState<string>(String(initial.num));
  const [den, setDen] = useState<string>(String(initial.den));
  const [decimal, setDecimal] = useState<string>(
    String(initial.num / Math.max(1, initial.den)),
  );
  const [error, setError] = useState<string | null>(null);
  const numRef = useRef<HTMLInputElement>(null);
  const decRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "fraction") {
      numRef.current?.focus();
      numRef.current?.select();
    } else {
      decRef.current?.focus();
      decRef.current?.select();
    }
  }, [mode]);

  const switchTo = (next: "fraction" | "decimal") => {
    setError(null);
    if (next === "decimal") {
      const n = parseInt(num, 10);
      const d = parseInt(den, 10);
      if (Number.isFinite(n) && Number.isFinite(d) && d > 0) {
        setDecimal(String(n / d));
      }
    } else {
      const dec = parseFloat(decimal);
      if (Number.isFinite(dec)) {
        const r = decimalToRational(dec);
        setNum(String(r.num));
        setDen(String(r.den));
      }
    }
    setMode(next);
  };

  const validate = (): { ok: true; variant: Variant } | { ok: false; error: string } => {
    if (mode === "fraction") {
      const n = parseInt(num, 10);
      const d = parseInt(den, 10);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "numerator must be an integer" };
      if (!Number.isFinite(d) || !Number.isInteger(d)) return { ok: false, error: "denominator must be an integer" };
      if (d === 0) return { ok: false, error: "denominator cannot be zero" };
      return { ok: true, variant: n / d };
    }
    const dec = parseFloat(decimal);
    if (!Number.isFinite(dec)) return { ok: false, error: "must be a number" };
    return { ok: true, variant: dec };
  };

  const handleSave = () => {
    if (readOnly) return;
    const result = validate();
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

  // Live preview of the other shape so the user sees what they'll commit.
  let preview = "";
  if (mode === "fraction") {
    const n = parseInt(num, 10), d = parseInt(den, 10);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) preview = `= ${n / d}`;
  } else {
    const dec = parseFloat(decimal);
    if (Number.isFinite(dec)) {
      const r = decimalToRational(dec);
      preview = `= ${r.num}/${r.den}`;
    }
  }

  return (
    <div className="dialog-overlay" data-testid="rational-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
            <label>
              <input
                type="radio"
                checked={mode === "fraction"}
                onChange={() => switchTo("fraction")}
                data-testid="rational-editor-mode-fraction"
              />{" "}Fraction
            </label>
            <label>
              <input
                type="radio"
                checked={mode === "decimal"}
                onChange={() => switchTo("decimal")}
                data-testid="rational-editor-mode-decimal"
              />{" "}Decimal
            </label>
          </div>
          {mode === "fraction" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                ref={numRef}
                type="number"
                inputMode="numeric"
                step="1"
                className="dialog-input"
                value={num}
                onChange={(e) => { setNum(e.target.value); setError(null); }}
                onKeyDown={handleKeyDown}
                data-testid="rational-editor-num"
                style={{ width: 120 }}
              />
              <span>/</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min="1"
                className="dialog-input"
                value={den}
                onChange={(e) => { setDen(e.target.value); setError(null); }}
                onKeyDown={handleKeyDown}
                data-testid="rational-editor-den"
                style={{ width: 120 }}
              />
            </div>
          ) : (
            <input
              ref={decRef}
              type="number"
              inputMode="decimal"
              step="any"
              className="dialog-input"
              value={decimal}
              onChange={(e) => { setDecimal(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              data-testid="rational-editor-decimal"
              style={{ width: 240 }}
            />
          )}
          {preview && (
            <p className="dialog-hint" data-testid="rational-editor-preview">{preview}</p>
          )}
          {error && <p className="dialog-error" data-testid="rational-editor-error">{error}</p>}
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="rational-editor-save"
            disabled={readOnly}
            title={readOnly ? "Tag is read-only per ExifTool schema" : undefined}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
