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
// The editor exposes each field separately and emits MetadataValue::Integer with
// the recomputed code on save.

import { useState } from "react";
import type { MetadataDraftEdit } from "../../types";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import type { FlashFields } from "./editorHelpers";
import {
  decodeFlashCode,
  encodeFlashFields,
  describeFlashCode,
  MODE_LABELS,
  RETURN_LABELS,
} from "./editorHelpers";

interface Props {
  propertyKey: string;
  initialCode: number;
  onSave: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function FlashEditor({
  propertyKey,
  initialCode,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [fields, setFields] = useState<FlashFields>(
    decodeFlashCode(initialCode),
  );

  const update = <K extends keyof FlashFields>(
    key: K,
    value: FlashFields[K],
  ) => {
    setFields({ ...fields, [key]: value });
  };

  const code = encodeFlashFields(fields);

  const handleSave = () => {
    if (readOnly) return;
    onSave({
      value: { kind: "Integer", value: code },
      intent: "Set",
      display: describeFlashCode(fields),
    });
  };

  return (
    <div className="dialog-overlay" data-testid="flash-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
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
                onChange={(e) =>
                  update("mode", Number(e.target.value) as 0 | 1 | 2 | 3)
                }
                data-testid="flash-editor-mode"
              >
                {Object.entries(MODE_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Return:</span>
              <select
                value={fields.returnStatus}
                onChange={(e) =>
                  update("returnStatus", Number(e.target.value) as 0 | 2 | 3)
                }
                data-testid="flash-editor-return"
              >
                {Object.entries(RETURN_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
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
            Code: <code>{code}</code> (binary{" "}
            <code>{code.toString(2).padStart(7, "0")}</code>)
          </p>
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
            data-testid="flash-editor-save"
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
