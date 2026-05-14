// EXIF Flash bitfield editor.
//
// The EXIF Flash tag packs several flags into a single int8u value.  Bit
// layout from the EXIF specification (and exiftool's PrintConv tables):
//
//   bit 0          : Flash fired           (0 = no, 1 = yes)
//   bits 1–2       : Return status         (0 = no return, 2 = not detected, 3 = detected)
//   bits 3–4       : Flash mode            (0 = unknown, 1 = compulsory on,
//                                            2 = compulsory off, 3 = auto)
//   bit 5          : Flash function        (0 = present, 1 = no flash function)
//   bit 6          : Red-eye reduction     (0 = no, 1 = yes)
//
// Example: `25 = 0b0011001` = Fired + Mode=Auto. Matches the
// `flash_bitfield.jpg` fixture.
//
// The editor exposes each field separately and emits Variant::Integer with
// the recomputed code on save.

import { useState } from "react";
import type { DraftEdit } from "../../types";

interface Props {
  propertyKey: string;
  initialCode: number;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
}

interface FlashFields {
  fired: boolean;
  returnStatus: 0 | 2 | 3; // skip 1 (reserved)
  mode: 0 | 1 | 2 | 3;
  noFunction: boolean;
  redEye: boolean;
}

export function decodeFlashCode(code: number): FlashFields {
  return {
    fired: (code & 0b1) !== 0,
    returnStatus: ((code >> 1) & 0b11) as 0 | 2 | 3,
    mode: ((code >> 3) & 0b11) as 0 | 1 | 2 | 3,
    noFunction: (code & 0b100000) !== 0,
    redEye: (code & 0b1000000) !== 0,
  };
}

export function encodeFlashFields(f: FlashFields): number {
  return (
    (f.fired ? 1 : 0) |
    ((f.returnStatus & 0b11) << 1) |
    ((f.mode & 0b11) << 3) |
    (f.noFunction ? 0b100000 : 0) |
    (f.redEye ? 0b1000000 : 0)
  );
}

const MODE_LABELS: Record<number, string> = {
  0: "Unknown",
  1: "Compulsory firing",
  2: "Compulsory suppression",
  3: "Auto",
};

const RETURN_LABELS: Record<number, string> = {
  0: "No return detected",
  2: "Return not detected",
  3: "Return detected",
};

export function FlashEditor({ propertyKey, initialCode, onSave, onCancel }: Props) {
  const [fields, setFields] = useState<FlashFields>(decodeFlashCode(initialCode));

  const update = <K extends keyof FlashFields>(key: K, value: FlashFields[K]) => {
    setFields({ ...fields, [key]: value });
  };

  const code = encodeFlashFields(fields);

  const handleSave = () => {
    onSave({ value: code, intent: "Set" });
  };

  return (
    <div className="dialog-overlay" data-testid="flash-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        <div className="dialog-body">
          <div className="flash-editor-grid">
            <label>
              <input
                type="checkbox"
                checked={fields.fired}
                onChange={(e) => update("fired", e.target.checked)}
                data-testid="flash-editor-fired"
              />
              Flash fired
            </label>
            <label>
              <span>Mode:</span>
              <select
                value={fields.mode}
                onChange={(e) => update("mode", Number(e.target.value) as 0 | 1 | 2 | 3)}
                data-testid="flash-editor-mode"
              >
                {Object.entries(MODE_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Return:</span>
              <select
                value={fields.returnStatus}
                onChange={(e) => update("returnStatus", Number(e.target.value) as 0 | 2 | 3)}
                data-testid="flash-editor-return"
              >
                {Object.entries(RETURN_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={fields.noFunction}
                onChange={(e) => update("noFunction", e.target.checked)}
                data-testid="flash-editor-no-function"
              />
              No flash function (camera lacks flash)
            </label>
            <label>
              <input
                type="checkbox"
                checked={fields.redEye}
                onChange={(e) => update("redEye", e.target.checked)}
                data-testid="flash-editor-red-eye"
              />
              Red-eye reduction
            </label>
          </div>
          <p className="dialog-hint" data-testid="flash-editor-code-preview">
            Code: <code>{code}</code> (binary <code>{code.toString(2).padStart(7, "0")}</code>)
          </p>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog-btn dialog-btn-primary" onClick={handleSave} data-testid="flash-editor-save">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Recognise Flash tags by name.  Multiple group prefixes carry the same
 * conceptual tag (`EXIF:Flash`, `IFD0:Flash`, `MakerNotes:Flash` …) — match
 * any `*:Flash` so the editor lights up wherever exiftool exposes it.
 */
export function isFlashTag(key: string): boolean {
  return /^[\w-]+:Flash$/.test(key);
}
