// Generic struct editor for XMP / EXIF struct values.
//
// Struct rows store `MetadataValue`. Non-text values are edited through
// recursive semantic editors (by opening a recursive sub-dialog handling
// the inner `MetadataValue` via the same router). This is enough to read and
// modify e.g. face-region structs at field granularity without giving up
// generality. Saving emits a semantic `MetadataValue::Struct` with intent=Set.
//
// Future work includes introducing schema-aware struct field kinds.

import { useState } from "react";
import type { MetadataDraftEdit, MetadataValue, TagKind } from "../../types";
import { metadataValueToDisplayString } from "../../draft";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import type { InheritedEditorSchema } from "./editorSchema";
import { useDialogEscape } from "../../hooks/useDialogEscape";

interface Props {
  propertyKey: string;
  initialObject: Record<string, MetadataValue>;
  fieldKinds?: Record<string, TagKind | undefined>;
  /** Recursive editor entry — pass `TypedValueEditor` to support arbitrary nesting. */
  innerEditor?: (props: InnerEditorProps) => React.ReactNode;
  onSave: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export interface InnerEditorProps {
  propertyKey: string;
  initialMetadataValue?: MetadataValue;
  schemaOverride?: InheritedEditorSchema;
  metadataForFile?: Record<string, MetadataValue>;
  onSaveMetadata: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
}

interface FieldRow {
  key: string;
  value: MetadataValue;
}

function objectToRows(obj: Record<string, MetadataValue>): FieldRow[] {
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

function rowsToObject(rows: FieldRow[]): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  for (const r of rows) {
    if (r.key === "") continue;
    out[r.key] = r.value;
  }
  return out;
}

function usesSubEditor(v: MetadataValue, fieldKind?: TagKind): boolean {
  if (fieldKind) return fieldKind.kind !== "Text";
  return v.kind !== "Text";
}

export function StructEditor({
  propertyKey,
  initialObject,
  fieldKinds,
  innerEditor,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [rows, setRows] = useState<FieldRow[]>(objectToRows(initialObject));
  const [newFieldKey, setNewFieldKey] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  useDialogEscape(onCancel);

  const updateRow = (idx: number, patch: Partial<FieldRow>) => {
    setRows((current) =>
      current.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  };

  const removeRow = (idx: number) => {
    setRows((current) => current.filter((_, i) => i !== idx));
  };

  const addRow = () => {
    const key = newFieldKey.trim();
    if (!key || rows.some((r) => r.key === key)) return;
    setRows([...rows, { key, value: { kind: "Text", value: "" } }]);
    setNewFieldKey("");
  };

  const handleSave = () => {
    if (readOnly) return;
    onSave({
      value: {
        kind: "Struct",
        value: rowsToObject(rows),
      },
      intent: "Set",
    });
  };

  // Inline sub-editor for complex values.
  const SubEditor = innerEditor;

  if (editingIndex !== null && SubEditor) {
    const row = rows[editingIndex];
    return (
      <SubEditor
        propertyKey={`${propertyKey}.${row.key}`}
        initialMetadataValue={row.value}
        schemaOverride={
          fieldKinds?.[row.key]
            ? {
                kind: fieldKinds[row.key]!,
                readOnly: Boolean(readOnly),
                sourceLabel: propertyKey,
              }
            : undefined
        }
        onSaveMetadata={(edit: MetadataDraftEdit) => {
          if (edit.intent === "Delete") {
            removeRow(editingIndex);
          } else {
            updateRow(editingIndex, {
              value: edit.value ?? row.value,
            });
          }
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
                  disabled={readOnly}
                />
                {usesSubEditor(row.value, fieldKinds?.[row.key]) ? (
                  <>
                    <span
                      className="struct-editor-complex-preview"
                      data-testid={`struct-editor-preview-${idx}`}
                    >
                      {metadataValueToDisplayString(row.value).slice(0, 60)}
                    </span>
                    {SubEditor && (
                      <button
                        type="button"
                        className="dialog-btn dialog-btn-secondary"
                        onClick={() => setEditingIndex(idx)}
                        data-testid={`struct-editor-edit-${idx}`}
                        disabled={readOnly}
                      >
                        Edit…
                      </button>
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    className="struct-editor-value"
                    value={row.value.kind === "Text" ? row.value.value : ""}
                    onChange={(e) =>
                      updateRow(idx, {
                        value: { kind: "Text", value: e.target.value },
                      })
                    }
                    data-testid={`struct-editor-value-${idx}`}
                    disabled={readOnly}
                  />
                )}
                <button
                  type="button"
                  className="struct-editor-remove"
                  onClick={() => removeRow(idx)}
                  aria-label={`Remove ${row.key}`}
                  disabled={readOnly}
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
              disabled={readOnly}
            />
            <button
              type="button"
              className="dialog-btn dialog-btn-secondary"
              onClick={addRow}
              data-testid="struct-editor-add-btn"
              disabled={readOnly}
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
