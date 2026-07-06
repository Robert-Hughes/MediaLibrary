// ── Metadata display helpers ─────────────────────────────────────────────

import type { ImageMetadataEntry, MetadataValue, TagInfo } from "./types";

export function displayStringOfMetadataDraft(
  d: import("./types").MetadataDraftEdit | undefined,
): string | null | undefined {
  if (d === undefined) return undefined;
  if (d.intent === "Delete") return null;
  if (d.display !== undefined && d.display !== null) return d.display;
  return metadataValueToDisplayString(d.value);
}

/** Stringify a MetadataValue for the `string | null` display path.
 *  Kept as a named shim so callers that carry display strings can be
 *  found by grep rather than by tracing every `metadataValueToDisplayString`
 *  call site. */
export function variantToDisplayString(
  v: ImageMetadataEntry | null | undefined,
): string {
  return metadataValueToDisplayString(v);
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

export function metadataValueToDisplayStringForTag(
  _key: string,
  v: MetadataValue | null | undefined,
  tagInfo?: TagInfo | null,
): string {
  if (tagInfo?.kind.kind !== "Enum") {
    return metadataValueToDisplayString(v);
  }

  const code = enumCodeFromMetadataValue(v);
  if (code === null) {
    return metadataValueToDisplayString(v);
  }

  const option = tagInfo.kind.data.options.find((o) => o.code === code);
  if (!option?.label) {
    return metadataValueToDisplayString(v);
  }

  return option.label;
}

function enumCodeFromMetadataValue(
  v: MetadataValue | null | undefined,
): string | null {
  if (v === null || v === undefined) return null;
  switch (v.kind) {
    case "Integer":
      return String(v.value);
    case "Text":
      return v.value;
    case "Real":
      return Number.isInteger(v.value) ? String(v.value) : null;
    default:
      return null;
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
