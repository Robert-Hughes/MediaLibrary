import { useState, useRef, useEffect } from "react";
import { useTagInfo } from "../hooks/useTagInfo";
import { describeKind } from "./editors/EditorMetaHint";

interface Props {
  onSave: (key: string, value: string) => void;
  onCancel: () => void;
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
        <p
          className="dialog-hint editor-meta-hint editor-meta-hint-warning"
          data-testid="new-property-schema-unknown"
          style={{ color: "var(--accent-warning, #aa6)" }}
        >
          ⚠ <code>{lookupKey}</code> is not in ExifTool&apos;s writable schema.
          {" "}The edit will be sent as raw text and may be silently rejected by ExifTool.
        </p>
      );
    } else if (!tagInfo.writable) {
      schemaLine = (
        <p className="dialog-error editor-meta-hint" data-testid="new-property-schema-unwritable">
          <strong>
            <code>{tagInfo.group}:{tagInfo.name}</code> — {describeKind(tagInfo.kind)}
          </strong>
          {" · "}From ExifTool schema (read-only) — ExifTool will refuse to write this value.
        </p>
      );
    } else {
      schemaLine = (
        <p className="dialog-hint editor-meta-hint" data-testid="new-property-schema-info">
          <strong>
            <code>{tagInfo.group}:{tagInfo.name}</code> — {describeKind(tagInfo.kind)}
          </strong>
          {" · "}From ExifTool schema
          {tagInfo.description ? <><br />{tagInfo.description}</> : null}
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
