import { ModalDialog } from "../ModalDialog";
// Numerator/denominator editor for Rational tags.
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
//                                Save commits MetadataValue::Rational.
//   - Decimal mode (toggle):   single Real-style input, converted to a
//                                reduced MetadataValue::Rational.

import { useState, useEffect, useRef } from "react";
import type { MetadataDraftEdit, MetadataValue } from "../../types";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";

interface Props {
  propertyKey: string;
  initialMetadataValue?: MetadataValue;
  onSave: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

/** Convert a decimal to a reduced rational using a 1e6 denominator cap.
 *  Sufficient for shutter speeds and similar EXIF rationals; not arbitrary
 *  precision.  Returns (n, 1) for integers. */
function decimalToRational(d: number): { num: number; den: number } {
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
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

export function RationalEditor({
  propertyKey,
  initialMetadataValue,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const initial = (() => {
    if (initialMetadataValue) {
      if (initialMetadataValue.kind === "Rational") {
        const denominator = initialMetadataValue.value.denominator;
        return {
          num: initialMetadataValue.value.numerator,
          den: denominator === 0 ? 1 : denominator,
        };
      }
      if (
        initialMetadataValue.kind === "Integer" ||
        initialMetadataValue.kind === "Real"
      ) {
        return decimalToRational(initialMetadataValue.value);
      }
    }
    return { num: 0, den: 1 };
  })();
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

  const validate = ():
    | { ok: true; rational: { num: number; den: number } }
    | { ok: false; error: string } => {
    if (mode === "fraction") {
      const n = parseInt(num, 10);
      const d = parseInt(den, 10);
      if (!Number.isFinite(n) || !Number.isInteger(n))
        return { ok: false, error: "numerator must be an integer" };
      if (!Number.isFinite(d) || !Number.isInteger(d))
        return { ok: false, error: "denominator must be an integer" };
      if (d === 0) return { ok: false, error: "denominator cannot be zero" };
      const g = gcd(n, d);
      return { ok: true, rational: { num: n / g, den: d / g } };
    }
    const dec = parseFloat(decimal);
    if (!Number.isFinite(dec)) return { ok: false, error: "must be a number" };
    return { ok: true, rational: decimalToRational(dec) };
  };

  const handleSave = () => {
    if (readOnly) return;
    const result = validate();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Pretty form for the orange "pending" cell: the rational fraction.
    // For decimal-mode input we synthesise the fraction via decimalToRational;
    // for fraction-mode we use the user's literal num/den (preserves "1/8000"
    // even if the decimal would simplify oddly).
    let display: string;
    if (mode === "fraction") {
      const n = parseInt(num, 10);
      const d = parseInt(den, 10);
      display = d === 1 ? String(n) : `${n}/${d}`;
    } else {
      const r = result.rational;
      display = r.den === 1 ? String(r.num) : `${r.num}/${r.den}`;
    }
    onSave({
      value: {
        kind: "Rational",
        value: {
          numerator: result.rational.num,
          denominator: result.rational.den,
        },
      },
      intent: "Set",
      display,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  };

  // Live preview of the other shape so the user sees what they'll commit.
  let preview = "";
  if (mode === "fraction") {
    const n = parseInt(num, 10),
      d = parseInt(den, 10);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0)
      preview = `= ${n / d}`;
  } else {
    const dec = parseFloat(decimal);
    if (Number.isFinite(dec)) {
      const r = decimalToRational(dec);
      preview = `= ${r.num}/${r.den}`;
    }
  }

  return (
    <ModalDialog
      open
      onDismiss={onCancel}
      testId="rational-editor-overlay"
      aria-label={`Edit ${propertyKey}`}
    >
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <label>
              <input
                type="radio"
                checked={mode === "fraction"}
                onChange={() => switchTo("fraction")}
                data-testid="rational-editor-mode-fraction"
              />{" "}
              Fraction
            </label>
            <label>
              <input
                type="radio"
                checked={mode === "decimal"}
                onChange={() => switchTo("decimal")}
                data-testid="rational-editor-mode-decimal"
              />{" "}
              Decimal
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
                onChange={(e) => {
                  setNum(e.target.value);
                  setError(null);
                }}
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
                onChange={(e) => {
                  setDen(e.target.value);
                  setError(null);
                }}
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
              onChange={(e) => {
                setDecimal(e.target.value);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              data-testid="rational-editor-decimal"
              style={{ width: 240 }}
            />
          )}
          {preview && (
            <p className="dialog-hint" data-testid="rational-editor-preview">
              {preview}
            </p>
          )}
          {error && (
            <p className="dialog-error" data-testid="rational-editor-error">
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
            data-testid="rational-editor-save"
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TOOLTIP : undefined}
          >
            Save
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
