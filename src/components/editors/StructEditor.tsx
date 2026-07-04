// Generic struct editor for XMP / EXIF struct values.
//
// Phase 4 MVP scope: each top-level field of the struct is editable as a
// text value.  Nested objects/lists are rendered with a small inline
// preview and "Edit…" button that opens a recursive sub-dialog handling
// the inner Variant via the same router.  This is enough to read and
// modify e.g. face-region structs at field granularity without giving up
// generality — Phase 5 refinements can teach the field rows about the
// schema for known struct types (`mwg-rs:Region` field map).
//
// The output is always a `Variant::Object` shape with intent=Set.

import { useState } from "react";
import type { DraftEdit, Variant } from "../../types";
import { variantToDisplayString } from "../../draft";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";

interface Props {
  propertyKey: string;
  initialObject: Record<string, Variant>;
  /** Recursive editor entry — pass `TypedValueEditor` to support arbitrary nesting. */
  innerEditor?: (props: InnerEditorProps) => React.ReactNode;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export interface InnerEditorProps {
  propertyKey: string;
  initialVariant?: Variant;
  initialString: string;
  metadataForFile?: Record<string, Variant>;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
}

interface FieldRow {
  key: string;
  value: Variant;
}

function objectToRows(obj: Record<string, Variant>): FieldRow[] {
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

function rowsToObject(rows: FieldRow[]): Record<string, Variant> {
  const out: Record<string, Variant> = {};
  for (const r of rows) {
    if (r.key === "") continue;
    out[r.key] = r.value;
  }
  return out;
}

function isComplex(v: Variant): boolean {
  return Array.isArray(v) || (typeof v === "object" && v !== null);
}

export function StructEditor({
  propertyKey,
  initialObject,
  innerEditor,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [rows, setRows] = useState<FieldRow[]>(objectToRows(initialObject));
  const [newFieldKey, setNewFieldKey] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const updateRow = (idx: number, patch: Partial<FieldRow>) => {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const removeRow = (idx: number) => {
    setRows(rows.filter((_, i) => i !== idx));
  };

  const addRow = () => {
    const key = newFieldKey.trim();
    if (!key || rows.some((r) => r.key === key)) return;
    setRows([...rows, { key, value: "" }]);
    setNewFieldKey("");
  };

  const handleSave = () => {
    if (readOnly) return;
    onSave({ value: rowsToObject(rows), intent: "Set" });
  };

  // Inline sub-editor for complex values.
  const SubEditor = innerEditor;

  if (editingIndex !== null && SubEditor) {
    const row = rows[editingIndex];
    return (
      <SubEditor
        propertyKey={`${propertyKey}.${row.key}`}
        initialVariant={row.value}
        initialString={variantToDisplayString(row.value)}
        onSave={(edit: DraftEdit) => {
          const newValue: Variant =
            edit.intent === "Delete" ? "" : (edit.value ?? "");
          updateRow(editingIndex, { value: newValue });
          setEditingIndex(null);
        }}
        onCancel={() => setEditingIndex(null)}
      />
    );
  }

  return (
    <div className="dialog-overlay" data-testid="struct-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <div className="struct-editor-rows" data-testid="struct-editor-rows">
            {rows.length === 0 && (
              <p className="dialog-hint">No fields. Add one below.</p>
            )}
            {rows.map((row, idx) => (
              <div
                key={idx}
                className="struct-editor-row"
                data-testid="struct-editor-row"
              >
                <input
                  type="text"
                  className="struct-editor-key"
                  value={row.key}
                  onChange={(e) => updateRow(idx, { key: e.target.value })}
                  placeholder="field"
                  data-testid={`struct-editor-key-${idx}`}
                />
                {isComplex(row.value) ? (
                  <>
                    <span
                      className="struct-editor-complex-preview"
                      data-testid={`struct-editor-preview-${idx}`}
                    >
                      {variantToDisplayString(row.value).slice(0, 60)}
                    </span>
                    {SubEditor && (
                      <button
                        type="button"
                        className="dialog-btn dialog-btn-secondary"
                        onClick={() => setEditingIndex(idx)}
                        data-testid={`struct-editor-edit-${idx}`}
                      >
                        Edit…
                      </button>
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    className="struct-editor-value"
                    value={
                      typeof row.value === "string"
                        ? row.value
                        : String(row.value ?? "")
                    }
                    onChange={(e) => updateRow(idx, { value: e.target.value })}
                    data-testid={`struct-editor-value-${idx}`}
                  />
                )}
                <button
                  type="button"
                  className="struct-editor-remove"
                  onClick={() => removeRow(idx)}
                  aria-label={`Remove ${row.key}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="struct-editor-add">
            <input
              type="text"
              className="dialog-input"
              value={newFieldKey}
              onChange={(e) => setNewFieldKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRow();
                }
              }}
              placeholder="new field name"
              data-testid="struct-editor-new-key"
            />
            <button
              type="button"
              className="dialog-btn dialog-btn-secondary"
              onClick={addRow}
              data-testid="struct-editor-add-btn"
            >
              Add field
            </button>
          </div>
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
            data-testid="struct-editor-save"
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
