import { useState, useRef, useEffect, useMemo } from "react";
import { useTagInfo } from "../hooks/useTagInfo";
import { useSchemaTagNames } from "../hooks/useSchemaTagNames";
import { describeKind } from "./editors/EditorMetaHint";
import { filterTagsByFilename } from "../utils/tagGroupApplicability";

interface Props {
  /**
   * Called once the user has chosen a writable key.  The parent is
   * expected to swap in a `TypedValueEditor` for that key so the user
   * gets a schema-appropriate editor (numeric / boolean / Bag / GPS /
   * Flash / …) instead of a generic string box.
   */
  onSave: (key: string) => void;
  onCancel: () => void;
  existingKeys?: ReadonlySet<string>;
  /** Filename of the photo being edited.  Drives file-type filtering of
   * the autocomplete suggestions so a JPEG doesn't surface Vorbis tags. */
  filename?: string;
}

export function NewPropertyDialog({ onSave, onCancel, existingKeys, filename }: Props) {
  const [key, setKey] = useState("");
  const keyInputRef = useRef<HTMLInputElement>(null);

  // Only consult the registry once the user has typed a colon-shaped tag —
  // otherwise we pepper the backend with lookups for half-typed strings.
  const lookupKey = key.includes(":") ? key : "";
  const tagInfo = useTagInfo(lookupKey);

  const allTagNames = useSchemaTagNames();

  const suggestions = useMemo(() => {
    if (allTagNames === "loading" || !key) return [];
    const lower = key.toLowerCase();
    const applicable = filterTagsByFilename(allTagNames, filename);
    return applicable.filter((t) => t.toLowerCase().includes(lower));
  }, [allTagNames, key, filename]);

  useEffect(() => {
    keyInputRef.current?.focus();
  }, []);

  const unwritable = tagInfo !== "loading" && tagInfo !== null && !tagInfo.writable;
  const disabled = !key || unwritable;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !disabled) {
      onSave(key);
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

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

  const isDuplicate = !!key && !!existingKeys?.has(key);

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
              list="schema-tag-names"
              className="dialog-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="XMP-dc:Description"
              data-testid="new-property-key"
              autoComplete="off"
            />
            <datalist id="schema-tag-names">
              {suggestions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            {isDuplicate && (
              <p
                className="dialog-hint editor-meta-hint editor-meta-hint-warning"
                data-testid="new-property-duplicate-warning"
                style={{ color: "var(--accent-warning, #aa6)" }}
              >
                ⚠ <code>{key}</code> already exists in this image&apos;s metadata.
                {" "}Saving will overwrite the existing value.
              </p>
            )}
            {schemaLine}
          </div>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={() => onSave(key)}
            disabled={disabled}
            data-testid="new-property-next"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
