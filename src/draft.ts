// ── Draft-edit helpers (Phase 3b) ─────────────────────────────────────────────
//
// The frontend draft layer still carries generated `DraftEdit` values
// internally while the Tauri persistence/apply boundary uses semantic
// `MetadataDraftEdit` values. These helpers bridge the remaining legacy UI
// display shape and the editor-facing generated draft shape.
//
// Storage uses the typed shape so when typed editors arrive they have
// somewhere to write.  Display derives the legacy shape on the fly.

import type {
  DraftEdit,
  EditIntent,
  ImageMetadataEntry,
  MetadataValue,
  Variant,
} from "./types";

export type TypedDraftEditsByFile = Record<string, Record<string, DraftEdit>>;
export type LegacyDraftEditsByFile = Record<
  string,
  Record<string, string | null>
>;

/**
 * Render the display string for a draft.
 *
 * Returns:
 * - `undefined` if no draft exists for the key
 * - `null`      if the draft is a Delete intent (UI shows "—" / strikethrough)
 * - otherwise   the editor-supplied pretty form (`d.display`) when present,
 *               else a generic stringification of the Variant value
 */
export function displayStringOf(
  d: DraftEdit | undefined,
): string | null | undefined {
  if (d === undefined) return undefined;
  if (d.intent === "Delete") return null;
  if (d.display !== undefined && d.display !== null) return d.display;
  return variantToDisplayString(d.value);
}

/** Wrap a legacy `string | null` edit into the typed shape. */
export function draftFromLegacyString(v: string | null): DraftEdit {
  if (v === null) {
    return { value: null, intent: "Delete" as EditIntent };
  }
  return { value: v, intent: "Set" as EditIntent };
}

/** Stringify a Variant for the legacy `string | null` display path. */
export function variantToDisplayString(
  v: ImageMetadataEntry | null | undefined,
): string {
  if (v === null || v === undefined) return "";
  if (isMetadataValue(v)) return metadataValueToDisplayString(v);
  if (Array.isArray(v)) return v.map(variantToDisplayString).join(", ");
  if (typeof v === "object") {
    return Object.entries(v)
      .map(([k, vv]) => `${k}: ${variantToDisplayString(vv as Variant)}`)
      .join("; ");
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return String(v);
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function metadataValueToDisplayString(
  v: MetadataValue | null | undefined,
): string {
  if (v === null || v === undefined) return "";
  switch (v.kind) {
    case "Null":
      return "";
    case "Text":
    case "Integer":
    case "Real":
      return String(v.value);
    case "Bool":
      return v.value ? "true" : "false";
    case "Rational":
      return `${v.value.numerator}/${v.value.denominator}`;
    case "Date":
      return `${pad(v.value.year, 4)}:${pad(v.value.month)}:${pad(v.value.day)}`;
    case "Time":
      return renderMetadataTime(v.value);
    case "DateTime":
      return `${metadataValueToDisplayString({
        kind: "Date",
        value: v.value.date,
      })} ${renderMetadataTime(v.value.time)}`;
    case "TimeOffset":
      return renderMetadataOffset(v.value);
    case "LangAlt":
      return Object.entries(v.value)
        .map(([lang, value]) => `${lang}: ${value}`)
        .join("; ");
    case "List":
      return v.value.items.map(metadataValueToDisplayString).join(", ");
    case "Struct":
      return Object.entries(v.value)
        .map(([key, value]) => `${key}: ${metadataValueToDisplayString(value)}`)
        .join("; ");
    case "Binary":
      return "<binary>";
    case "Unknown":
      return JSON.stringify(v.value.raw);
  }
}

function renderMetadataTime(
  v: Extract<MetadataValue, { kind: "Time" }>["value"],
): string {
  const subsecond = v.subsecond ? `.${v.subsecond}` : "";
  const offset = v.offset ? renderMetadataOffset(v.offset) : "";
  return `${pad(v.hour)}:${pad(v.minute)}:${pad(v.second)}${subsecond}${offset}`;
}

function renderMetadataOffset(
  v: Extract<MetadataValue, { kind: "TimeOffset" }>["value"],
): string {
  const sign = v.sign === "Plus" ? "+" : "-";
  return `${sign}${pad(v.hours)}:${pad(v.minutes)}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Convert the typed map into the legacy display shape used by existing
 * components that still read `Record<string, Record<string, string | null>>`.
 *
 * Drafts with no real change (undefined intent) are dropped.
 */
export function mapTypedToLegacy(
  typed: TypedDraftEditsByFile,
): LegacyDraftEditsByFile {
  const out: LegacyDraftEditsByFile = {};
  for (const [file, edits] of Object.entries(typed)) {
    const fileOut: Record<string, string | null> = {};
    for (const [key, d] of Object.entries(edits)) {
      if (d.intent === "Delete") {
        fileOut[key] = null;
      } else if (d.display !== undefined && d.display !== null) {
        fileOut[key] = d.display;
      } else {
        fileOut[key] = variantToDisplayString(d.value);
      }
    }
    if (Object.keys(fileOut).length > 0) {
      out[file] = fileOut;
    }
  }
  return out;
}

/** Convert legacy load result (as returned by Tauri) into typed storage shape. */
export function mapLegacyToTyped(
  legacy: LegacyDraftEditsByFile,
): TypedDraftEditsByFile {
  const out: TypedDraftEditsByFile = {};
  for (const [file, edits] of Object.entries(legacy ?? {})) {
    const fileOut: Record<string, DraftEdit> = {};
    for (const [key, v] of Object.entries(edits)) {
      fileOut[key] = draftFromLegacyString(v);
    }
    out[file] = fileOut;
  }
  return out;
}

/**
 * Derive the legacy per-file map of `string | null` values for one file.
 * Used by App.tsx when threading drafts down into components that still
 * consume the legacy shape.
 */
export function deriveLegacyFileEdits(
  typedFile: Record<string, DraftEdit> | undefined,
): Record<string, string | null> {
  if (!typedFile) return {};
  const out: Record<string, string | null> = {};
  for (const [key, d] of Object.entries(typedFile)) {
    if (d.intent === "Delete") {
      out[key] = null;
    } else if (d.display !== undefined && d.display !== null) {
      out[key] = d.display;
    } else {
      out[key] = variantToDisplayString(d.value);
    }
  }
  return out;
}
