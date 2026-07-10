// Generic editor for Bag/Seq/Alt of non-scalar inner kinds: Bag<Struct>
// (face regions), Bag<LangAlt>, Seq<Struct>, Bag<Bag<...>>, etc.
//
// METADATA_FORMATS_DESIGN.md §5 promises "no depth limit" recursive
// composition: a Bag<Struct> renders as a chip-list of expandable
// sub-forms, a Seq<LangAlt> as an ordered list of language-tab strips, a
// Struct whose field is itself a Bag<Text> as a sub-form containing a
// chip editor.  This editor delivers the list half of that promise; each
// item delegates back to TypedValueEditor (`innerEditor` prop) for the
// inner kind, which can itself recurse.
//
// BagEditor handles Bag/Seq of scalar inner (Text/Integer/Real/Boolean)
// because the chip representation is the right UX for those.  Anything
// non-scalar lands here.

import { useState } from "react";
import type {
  ListKind,
  MetadataDraftEdit,
  TagKind,
  MetadataValue,
} from "../../types";
import { metadataValueToDisplayString } from "../../draft";
import type { InnerEditorProps } from "./StructEditor";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";

interface Props {
  propertyKey: string;
  /** The Bag/Seq/Alt kind whose inner is non-scalar. */
  kind: TagKind;
  initialItems: MetadataValue[];
  /** Recursive editor entry — pass `TypedValueEditor`. */
  innerEditor: (props: InnerEditorProps) => React.ReactNode;
  onSave: (edit: MetadataDraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

/** Construct an empty MetadataValue appropriate for `inner` so "Add item" produces
 *  something the recursive sub-editor can populate. */
function emptyMetadataValueFor(inner: TagKind): MetadataValue {
  switch (inner.kind) {
    case "LangAlt":
      // x-default explicit per design §5 LangAlt rules.
      return { kind: "LangAlt", value: { "x-default": "" } };
    case "Struct":
      return { kind: "Struct", value: {} };
    case "Bag":
    case "Seq":
    case "Alt":
      return {
        kind: "List",
        value: {
          list_kind:
            inner.kind === "Bag" || inner.kind === "Seq" || inner.kind === "Alt"
              ? inner.kind
              : "Unknown",
          items: [],
        },
      };
    case "Boolean":
      return { kind: "Bool", value: false };
    case "Integer":
      return { kind: "Integer", value: 0 };
    case "Real":
      return { kind: "Real", value: 0 };
    case "Rational":
      return { kind: "Rational", value: { numerator: 0, denominator: 1 } };
    case "Date":
      return { kind: "Date", value: { year: 0, month: 1, day: 1 } };
    case "Time":
      return {
        kind: "Time",
        value: { hour: 0, minute: 0, second: 0, subsecond: null, offset: null },
      };
    case "DateTime":
      return {
        kind: "DateTime",
        value: {
          date: { year: 0, month: 1, day: 1 },
          time: {
            hour: 0,
            minute: 0,
            second: 0,
            subsecond: null,
            offset: null,
          },
        },
      };
    case "Text":
    case "Unknown":
    default:
      return { kind: "Text", value: "" };
  }
}

function shortLabel(v: MetadataValue, idx: number): string {
  if (v === null || v === undefined) return `Item ${idx + 1}`;
  // Prefer a Name field if it's a struct with one (face regions, IPTC
  // contributor blocks, etc.) — falls back to a generic display string.
  if (v.kind === "Struct") {
    const obj = v.value;
    for (const key of ["Name", "name", "x-default", "Title", "title"]) {
      const candidate = obj[key];
      if (
        candidate &&
        candidate.kind === "Text" &&
        candidate.value.trim() !== ""
      )
        return candidate.value;
    }
  }
  const s = metadataValueToDisplayString(v);
  return s ? s.slice(0, 80) : `Item ${idx + 1}`;
}

function listKindOf(kind: TagKind): ListKind {
  return kind.kind === "Bag" || kind.kind === "Seq" || kind.kind === "Alt"
    ? kind.kind
    : "Unknown";
}

export function NestedListEditor({
  propertyKey,
  kind,
  initialItems,
  innerEditor: SubEditor,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [items, setItems] = useState<MetadataValue[]>(initialItems);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const innerKind: TagKind | null =
    kind.kind === "Bag" || kind.kind === "Seq" || kind.kind === "Alt"
      ? kind.data
      : null;
  const ordered = kind.kind === "Seq";

  const updateItem = (idx: number, value: MetadataValue) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? value : it)));
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveItem = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.slice();
    const [picked] = next.splice(idx, 1);
    next.splice(target, 0, picked);
    setItems(next);
  };

  const addItem = () => {
    if (!innerKind) return;
    const fresh = emptyMetadataValueFor(innerKind);
    setItems((prev) => [...prev, fresh]);
    setEditingIndex(items.length); // open the new item for editing immediately
  };

  const handleSave = () => {
    if (readOnly) return;
    onSave({
      value: {
        kind: "List",
        value: {
          list_kind: listKindOf(kind),
          items: items,
        },
      },
      intent: "Set",
    });
  };

  // ── Sub-editor view ──────────────────────────────────────────────────
  if (editingIndex !== null && innerKind) {
    const value = items[editingIndex];
    return (
      <SubEditor
        propertyKey={`${propertyKey}[${editingIndex}]`}
        initialMetadataValue={value}
        schemaOverride={innerKind}
        onSaveMetadata={(edit: MetadataDraftEdit) => {
          const newValue: MetadataValue =
            edit.intent === "Delete"
              ? emptyMetadataValueFor(innerKind)
              : (edit.value ?? emptyMetadataValueFor(innerKind));
          updateItem(editingIndex, newValue);
          setEditingIndex(null);
        }}
        onCancel={() => setEditingIndex(null)}
      />
    );
  }

  return (
    <div className="dialog-overlay" data-testid="nested-list-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          {items.length === 0 && (
            <p className="dialog-hint" data-testid="nested-list-editor-empty">
              No items. Add one below.
            </p>
          )}
          <ul
            className="nested-list-editor-items"
            data-testid="nested-list-editor-items"
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {items.map((item, idx) => (
              <li
                key={idx}
                data-testid="nested-list-editor-item"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 0",
                  borderBottom: "1px solid var(--border-subtle, #ddd)",
                }}
              >
                {ordered && (
                  <>
                    <button
                      type="button"
                      aria-label={`Move item ${idx + 1} up`}
                      title="Move up"
                      disabled={idx === 0}
                      onClick={() => moveItem(idx, -1)}
                      data-testid="nested-list-editor-up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move item ${idx + 1} down`}
                      title="Move down"
                      disabled={idx === items.length - 1}
                      onClick={() => moveItem(idx, 1)}
                      data-testid="nested-list-editor-down"
                    >
                      ↓
                    </button>
                  </>
                )}
                <span
                  style={{
                    flex: 1,
                    fontFamily: "monospace",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  data-testid="nested-list-editor-summary"
                  title={shortLabel(item, idx)}
                >
                  {shortLabel(item, idx)}
                </span>
                <button
                  type="button"
                  className="dialog-btn dialog-btn-secondary"
                  onClick={() => setEditingIndex(idx)}
                  data-testid="nested-list-editor-edit"
                >
                  Edit…
                </button>
                <button
                  type="button"
                  aria-label={`Remove item ${idx + 1}`}
                  onClick={() => removeItem(idx)}
                  data-testid="nested-list-editor-remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="dialog-btn dialog-btn-secondary"
            onClick={addItem}
            data-testid="nested-list-editor-add"
            style={{ marginTop: 8 }}
          >
            + Add item
          </button>
          {ordered && items.length > 1 && (
            <p className="dialog-hint">Order matters — use ↑ / ↓ to reorder.</p>
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
            data-testid="nested-list-editor-save"
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
