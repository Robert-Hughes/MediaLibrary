import { useState, useRef, useEffect } from "react";
import { useTagInfo } from "../hooks/useTagInfo";
import type { TagKind } from "../types";

interface Props {
  onSave: (key: string, value: string) => void;
  onCancel: () => void;
}

/**
 * Friendly one-line description of what kind of value a tag expects.
 * Mirrors the design doc's TagKind table.  Used for the live schema-info
 * line under the key input.
 */
function describeKind(kind: TagKind): string {
  switch (kind.kind) {
    case "Text": return "Text";
    case "LangAlt": return "Language-alternative text (multi-language)";
    case "Integer": {
      const { min, max } = kind.data;
      const bounds = (min !== null && min !== undefined) || (max !== null && max !== undefined)
        ? ` (${min ?? "—"} … ${max ?? "—"})`
        : "";
      return `Integer${bounds}`;
    }
    case "Real": return "Real number";
    case "Rational": return "Rational number";
    case "Boolean": return "Boolean (true/false)";
    case "DateTime": return "Date/time";
    case "Enum": return `Enum (${kind.data.options.length} options)`;
    case "Bag": return `Bag (unordered list of ${describeKind(kind.data).toLowerCase()})`;
    case "Seq": return `Seq (ordered list of ${describeKind(kind.data).toLowerCase()})`;
    case "Alt": return `Alt (alternatives of ${describeKind(kind.data).toLowerCase()})`;
    case "Struct": return "Struct (nested object)";
    case "Binary": return "Binary (not editable)";
    case "Unknown": return "Unknown type";
  }
}

export function NewPropertyDialog({ onSave, onCancel }: Props) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const keyInputRef = useRef<HTMLInputElement>(null);

  // Only consult the registry once the user has typed a colon-shaped tag —
  // otherwise we pepper the backend with lookups for half-typed strings.
  const lookupKey = key.includes(":") ? key : "";
  const tagInfo = useTagInfo(lookupKey);

  useEffect(() => {
    keyInputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && key && value) {
      onSave(key, value);
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  // ── Schema-info line under the key input ───────────────────────────────
  let schemaLine: React.ReactNode = null;
  if (lookupKey && tagInfo !== "loading") {
    if (tagInfo === null) {
      schemaLine = (
        <p className="dialog-hint" data-testid="new-property-schema-unknown">
          Tag <code>{lookupKey}</code> is not in exiftool&apos;s writable schema.
          The edit will be sent as raw text and may be silently rejected by
          exiftool.
        </p>
      );
    } else if (!tagInfo.writable) {
      schemaLine = (
        <p className="dialog-error" data-testid="new-property-schema-unwritable">
          <strong>Tag <code>{lookupKey}</code> is not writable.</strong>
          {" "}exiftool will refuse to write this value.
        </p>
      );
    } else {
      schemaLine = (
        <p className="dialog-hint" data-testid="new-property-schema-info">
          <strong>{describeKind(tagInfo.kind)}</strong>
          {tagInfo.description ? ` — ${tagInfo.description}` : ""}
        </p>
      );
    }
  }

  const unwritable = tagInfo !== "loading" && tagInfo !== null && !tagInfo.writable;
  const disabled = !key || !value || unwritable;

  return (
    <div className="dialog-overlay">
      <div className="dialog-content">
        <h3>Add New Property</h3>
        <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", opacity: 0.8 }}>
              Key (e.g. XMP-dc:Description)
            </label>
            <input
              ref={keyInputRef}
              type="text"
              className="dialog-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="XMP-dc:Description"
              data-testid="new-property-key"
            />
            {schemaLine}
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", opacity: 0.8 }}>Value</label>
            <input
              type="text"
              className="dialog-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Value"
              data-testid="new-property-value"
            />
          </div>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={() => onSave(key, value)}
            disabled={disabled}
            data-testid="new-property-add"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
