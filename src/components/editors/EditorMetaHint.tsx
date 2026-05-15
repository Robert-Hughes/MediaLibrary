// Shared header banner shown above every draft-edit dialog.
//
// Single source of truth for two facts the user wants to see before changing
// a value:
//
//   1. What datatype the editor expects (Text, Bag of Text, Rational,
//      DateTime, the EXIF Flash bitfield, …).
//   2. Whether the tag is in ExifTool's writable schema, or being treated as
//      free text because we have no schema entry.
//
// Rendered by `TypedValueEditor` once per open and threaded into each editor
// component via the optional `headerHint` prop so it always sits in the same
// place — between the `<h3>Edit …</h3>` line and the dialog body.
//
// Also exported from here so `NewPropertyDialog` can render the same banner
// for the "type the key first" flow.

import type { TagInfo, TagKind } from "../../types";

/**
 * Friendly one-line description of what kind of value a tag expects.
 * Mirrors METADATA_FORMATS_DESIGN.md §5 TagKind table.
 */
export function describeKind(kind: TagKind): string {
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
    case "Bag": return `Bag — unordered list of ${describeKind(kind.data).toLowerCase()}`;
    case "Seq": return `Seq — ordered list of ${describeKind(kind.data).toLowerCase()}`;
    case "Alt": return `Alt — alternatives of ${describeKind(kind.data).toLowerCase()}`;
    case "Struct": return "Struct (nested object)";
    case "Binary": return "Binary (not editable)";
    case "Unknown": return "Unknown type";
  }
}

export type EditorMetaSource =
  | { kind: "schema"; tag: TagInfo; override?: string }
  | { kind: "synthetic"; label: string; description: string }
  | { kind: "unknown"; treatedAs?: string }
  | { kind: "loading" };

interface Props {
  source: EditorMetaSource;
}

/**
 * Banner shown at the top of every draft-edit dialog.  Always rendered in
 * the same slot (right under the `<h3>`) so the user can tell at a glance
 * what datatype they're editing and whether the schema knows about the tag.
 */
export function EditorMetaHint({ source }: Props) {
  if (source.kind === "loading") {
    return (
      <p className="dialog-hint editor-meta-hint" data-testid="editor-meta-hint" data-source="loading">
        Looking up schema…
      </p>
    );
  }

  if (source.kind === "unknown") {
    return (
      <p
        className="dialog-hint editor-meta-hint editor-meta-hint-warning"
        data-testid="editor-meta-hint"
        data-source="unknown"
        style={{ color: "var(--accent-warning, #aa6)" }}
      >
        ⚠ Not in ExifTool's writable schema.
        {" "}Treated as {source.treatedAs ?? "raw text"} — your edit may be silently rejected by ExifTool.
      </p>
    );
  }

  if (source.kind === "synthetic") {
    return (
      <p
        className="dialog-hint editor-meta-hint"
        data-testid="editor-meta-hint"
        data-source="synthetic"
      >
        <strong>{source.label}</strong> — {source.description}
      </p>
    );
  }

  // source.kind === "schema"
  const { tag, override } = source;
  const readOnly = !tag.writable;
  return (
    <p
      className={
        "dialog-hint editor-meta-hint" + (readOnly ? " editor-meta-hint-warning" : "")
      }
      data-testid="editor-meta-hint"
      data-source="schema"
      data-readonly={readOnly ? "true" : "false"}
      style={readOnly ? { color: "var(--accent-warning, #aa6)" } : undefined}
    >
      {readOnly ? "⚠ " : null}
      <strong>
        <code>{tag.group}:{tag.name}</code> — {describeKind(tag.kind)}
      </strong>
      {" · "}From ExifTool schema
      {readOnly ? " — read-only, saves will be rejected" : ""}
      {override ? ` · ${override}` : ""}
      {tag.description ? <><br />{tag.description}</> : null}
    </p>
  );
}
