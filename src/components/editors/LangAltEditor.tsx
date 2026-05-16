// LangAlt editor for `XMP-dc:Description`, `XMP-dc:Title`, etc.
//
// XMP language-alternative arrays have one default language (`x-default`)
// and zero or more named-language alternatives.  This editor exposes them
// as a tab strip: one tab per language, each with its own textarea.
//
// On save, the draft carries `Variant::Object` keyed by language code, with
// `x-default` explicit.  Write-back (Phase 5) emits one
// `-TAG-lang=value` argv per language.

import { useState } from "react";
import type { DraftEdit, Variant } from "../../types";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";

interface Props {
  propertyKey: string;
  initialLangs: Record<string, string>;
  onSave: (edit: DraftEdit) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function LangAltEditor({ propertyKey, initialLangs, onSave, onCancel, headerHint, readOnly }: Props) {
  // Always carry an x-default tab.
  const initial: Record<string, string> = { "x-default": "", ...initialLangs };
  const [langs, setLangs] = useState<Record<string, string>>(initial);
  const [activeLang, setActiveLang] = useState<string>(
    Object.keys(initial).includes("x-default") ? "x-default" : Object.keys(initial)[0] ?? "x-default",
  );
  const [newLang, setNewLang] = useState<string>("");

  const setValue = (lang: string, value: string) => {
    setLangs({ ...langs, [lang]: value });
  };

  const addLang = () => {
    const lang = newLang.trim();
    if (!lang || langs[lang] !== undefined) return;
    setLangs({ ...langs, [lang]: "" });
    setActiveLang(lang);
    setNewLang("");
  };

  const removeLang = (lang: string) => {
    if (lang === "x-default") return; // x-default is mandatory
    const next = { ...langs };
    delete next[lang];
    setLangs(next);
    if (activeLang === lang) setActiveLang("x-default");
  };

  const handleSave = () => {
    if (readOnly) return;
    // Drop empty entries except x-default (we always emit it).
    const out: Record<string, Variant> = {};
    for (const [lang, value] of Object.entries(langs)) {
      if (value.trim() === "" && lang !== "x-default") continue;
      out[lang] = value;
    }
    onSave({ value: out, intent: "Set" });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="dialog-overlay" data-testid="langalt-editor-overlay" onKeyDown={handleKeyDown}>
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <div className="langalt-editor-tabs" data-testid="langalt-editor-tabs">
            {Object.keys(langs).map((lang) => (
              <button
                key={lang}
                type="button"
                className={
                  "langalt-editor-tab" + (lang === activeLang ? " langalt-editor-tab--active" : "")
                }
                onClick={() => setActiveLang(lang)}
                data-testid={`langalt-editor-tab-${lang}`}
              >
                {lang}
                {lang !== "x-default" && (
                  <span
                    role="button"
                    className="langalt-editor-tab-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeLang(lang);
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            <div className="langalt-editor-add">
              <input
                type="text"
                className="langalt-editor-add-input"
                placeholder="Add lang (e.g. en, fr)"
                value={newLang}
                onChange={(e) => setNewLang(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addLang();
                  }
                }}
                data-testid="langalt-editor-add-input"
              />
              <button
                type="button"
                className="dialog-btn dialog-btn-secondary"
                onClick={addLang}
                data-testid="langalt-editor-add-btn"
              >
                Add
              </button>
            </div>
          </div>
          <textarea
            className="langalt-editor-textarea"
            value={langs[activeLang] ?? ""}
            onChange={(e) => setValue(activeLang, e.target.value)}
            data-testid="langalt-editor-textarea"
            rows={4}
          />
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="langalt-editor-save"
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

/** Extract initial per-language values from the metadata for this tag. */
export function initialLangsFrom(
  baseValue: Variant | undefined,
  metadataForFile: Record<string, Variant>,
  propertyKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};

  // Case A: the value itself is an Object keyed by language (with -struct).
  if (baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)) {
    for (const [k, v] of Object.entries(baseValue)) {
      if (typeof v === "string") out[k] = v;
      else if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  }

  // Case B: separate keys per language (`Description`, `Description-en`, …).
  if (typeof baseValue === "string") {
    out["x-default"] = baseValue;
  } else if (typeof baseValue === "number" || typeof baseValue === "boolean") {
    out["x-default"] = String(baseValue);
  }
  for (const [key, value] of Object.entries(metadataForFile)) {
    if (key === propertyKey) continue;
    if (key.startsWith(propertyKey + "-")) {
      const lang = key.slice(propertyKey.length + 1);
      if (typeof value === "string") out[lang] = value;
      else if (value !== null && value !== undefined && !Array.isArray(value) && typeof value !== "object") {
        out[lang] = String(value);
      }
    }
  }
  return out;
}
