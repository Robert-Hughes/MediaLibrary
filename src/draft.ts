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
      return renderLangAlt(v.value);
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
  key: string,
  v: MetadataValue | null | undefined,
  tagInfo?: TagInfo | null,
): string {
  const enumLabel = enumLabelFromSchema(v, tagInfo);
  if (enumLabel !== null) return enumLabel;

  const tagFormatted = formatKnownPhotoTag(key, v);
  if (tagFormatted !== null) return tagFormatted;

  return metadataValueToDisplayString(v);
}

function enumLabelFromSchema(
  v: MetadataValue | null | undefined,
  tagInfo?: TagInfo | null,
): string | null {
  if (tagInfo?.kind.kind !== "Enum") return null;

  const code = enumCodeFromMetadataValue(v);
  if (code === null) return null;

  const option = tagInfo.kind.data.options.find((o) => o.code === code);
  return option?.label ? option.label : null;
}

function formatKnownPhotoTag(
  key: string,
  v: MetadataValue | null | undefined,
): string | null {
  if (/^[\w-]+:GPSLatitude$/.test(key) || /^[\w-]+:GPSLongitude$/.test(key)) {
    return formatGpsCoordinate(v);
  }
  if (/^[\w-]+:GPSAltitude$/.test(key)) {
    return formatGpsAltitude(v);
  }

  switch (key) {
    case "ExifIFD:ExposureTime":
    case "Composite:ShutterSpeed":
      return formatExposureTime(v);
    case "ExifIFD:FNumber":
    case "Composite:Aperture":
      return formatAperture(v);
    case "ExifIFD:FocalLength":
    case "Composite:FocalLength":
    case "Composite:FocalLength35efl":
      return formatFocalLength(v);
    default:
      return null;
  }
}

function formatExposureTime(
  v: MetadataValue | null | undefined,
): string | null {
  const rational = rationalParts(v);
  if (rational !== null) {
    return `${rational.numerator}/${rational.denominator} s`;
  }

  const n = numericValue(v);
  if (n === null || n <= 0) return null;

  if (n < 1) {
    const reciprocal = 1 / n;
    const denominator = Math.round(reciprocal);
    if (denominator > 0 && Math.abs(reciprocal - denominator) < 0.01) {
      return `1/${denominator} s`;
    }
  }

  return `${trimNumber(n, 3)} s`;
}

function formatAperture(v: MetadataValue | null | undefined): string | null {
  const n = numericValue(v);
  if (n === null || n <= 0) return null;
  return `f/${trimNumber(n, 3)}`;
}

function formatFocalLength(v: MetadataValue | null | undefined): string | null {
  const n = numericValue(v);
  if (n === null || n <= 0) return null;
  return `${trimNumber(n, 2)} mm`;
}

function formatGpsCoordinate(
  v: MetadataValue | null | undefined,
): string | null {
  const n = gpsDecimalValue(v);
  if (n === null) return null;
  return `${trimNumber(n, 6)}°`;
}

function formatGpsAltitude(v: MetadataValue | null | undefined): string | null {
  const n = gpsDecimalValue(v);
  if (n === null) return null;
  return `${trimNumber(n, 2)} m`;
}

function gpsDecimalValue(v: MetadataValue | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const scalar = numericValue(v);
  if (scalar !== null) return scalar;
  if (v.kind !== "List") return null;

  const items = v.value.items;
  if (items.length === 1) return gpsDecimalValue(items[0]);
  if (items.length === 3) {
    const degrees = numericValue(items[0]);
    const minutes = numericValue(items[1]);
    const seconds = numericValue(items[2]);
    if (degrees === null || minutes === null || seconds === null) return null;
    const sign = degrees < 0 ? -1 : 1;
    return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
  }
  return null;
}

function numericValue(v: MetadataValue | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  switch (v.kind) {
    case "Integer":
    case "Real":
      return Number.isFinite(v.value) ? v.value : null;
    case "Rational":
      return v.value.denominator !== 0
        ? v.value.numerator / v.value.denominator
        : null;
    default:
      return null;
  }
}

function rationalParts(
  v: MetadataValue | null | undefined,
): { numerator: number; denominator: number } | null {
  if (v?.kind !== "Rational" || v.value.denominator === 0) return null;
  return v.value;
}

function trimNumber(value: number, maxDecimals = 2): string {
  return value.toFixed(maxDecimals).replace(/\.?0+$/, "");
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

function renderLangAlt(value: { [key in string]?: string }): string {
  const entries = Object.entries(value) as [string, string][];

  if (entries.length === 0) return "";

  if (entries.length === 1) {
    return entries[0][1];
  }

  return entries.map(([lang, text]) => `${lang}: ${text}`).join("; ");
}
