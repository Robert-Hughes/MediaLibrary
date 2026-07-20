// ── Metadata display helpers ─────────────────────────────────────────────

import type { MetadataValue, SchemaDefinitionId, TagInfo } from "./types";
import { GPS_IDS, KNOWN_METADATA_IDS, isKnownId } from "./metadata/knownIds";
import { isFlashTag } from "./metadata/tag_overrides";
import { decodeFlashCode, describeFlashCode } from "./metadata/flash";

export interface MetadataValueFormatInput {
  value: MetadataValue | null | undefined;
  schemaId?: SchemaDefinitionId;
  tagInfo?: Pick<TagInfo, "kind"> | null;
}

/** Canonical user-facing presentation for a semantic metadata value. */
export function formatMetadataValue({
  value,
  schemaId,
  tagInfo,
}: MetadataValueFormatInput): string {
  const enumLabel = enumLabelFromSchema(value, tagInfo);
  if (enumLabel !== null) return enumLabel;

  if (schemaId) {
    const tagFormatted = formatKnownPhotoTag(schemaId, value);
    if (tagFormatted !== null) return tagFormatted;

    const flashFormatted = formatFlash(schemaId, value);
    if (flashFormatted !== null) return flashFormatted;
  }

  return formatMetadataValueFallback(value);
}

function formatMetadataValueFallback(
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
      return `${formatMetadataValueFallback({
        kind: "Date",
        value: v.value.date,
      })} ${renderMetadataTime(v.value.time)}`;
    case "TimeOffset":
      return renderMetadataOffset(v.value);
    case "LangAlt":
      return renderLangAlt(v.value);
    case "List":
      return v.value.items.map(formatMetadataValueFallback).join(", ");
    case "Struct":
      return Object.entries(v.value)
        .map(([key, value]) => `${key}: ${formatMetadataValueFallback(value)}`)
        .join("; ");
    case "Binary":
      return "<binary>";
    case "Unknown":
      return JSON.stringify(v.value.raw);
  }
}

export function metadataValueToDiagnosticString(
  v: MetadataValue | null | undefined,
): string {
  if (v === null || v === undefined) return "";
  switch (v.kind) {
    case "Null":
      return "Null";
    case "Text":
      return `Text(${quote(v.value)})`;
    case "Integer":
      return `Integer(${v.value})`;
    case "Real":
      return `Real(${v.value})`;
    case "Bool":
      return `Bool(${v.value ? "true" : "false"})`;
    case "Rational":
      return `Rational(${v.value.numerator}/${v.value.denominator})`;
    case "Date":
      return `Date(${formatMetadataValueFallback(v)})`;
    case "Time":
      return `Time(${formatMetadataValueFallback(v)})`;
    case "DateTime":
      return `DateTime(${formatMetadataValueFallback(v)})`;
    case "TimeOffset":
      return `TimeOffset(${formatMetadataValueFallback(v)})`;
    case "LangAlt":
      return `LangAlt{${Object.entries(v.value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}: ${quote(value ?? "")}`)
        .join(", ")}}`;
    case "List":
      return `List<${v.value.list_kind}>[${v.value.items
        .map(metadataValueToDiagnosticString)
        .join(", ")}]`;
    case "Struct":
      return `Struct{${Object.entries(v.value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, value]) => `${key}: ${metadataValueToDiagnosticString(value)}`,
        )
        .join(", ")}}`;
    case "Binary":
      return "Binary";
    case "Unknown": {
      const expected = v.value.expected
        ? `expected=${diagnosticPreview(v.value.expected)}`
        : "expected=null";
      const reason = v.value.reason ? ` reason=${quote(v.value.reason)}` : "";
      return `Unknown(${expected}${reason} raw=${diagnosticPreview(v.value.raw)})`;
    }
  }
}

function enumLabelFromSchema(
  v: MetadataValue | null | undefined,
  tagInfo?: Pick<TagInfo, "kind"> | null,
): string | null {
  if (tagInfo?.kind.kind !== "Enum") return null;

  const code = enumCodeFromMetadataValue(v);
  if (code === null) return null;

  const option = tagInfo.kind.data.options.find((o) => o.code === code);
  return option?.label ? option.label : null;
}

function formatFlash(
  id: SchemaDefinitionId,
  value: MetadataValue | null | undefined,
): string | null {
  if (!isFlashTag(id)) return null;
  const code = enumCodeFromMetadataValue(value);
  if (code === null) return null;
  const numericCode = Number(code);
  if (!Number.isInteger(numericCode)) return null;
  return describeFlashCode(decodeFlashCode(numericCode));
}

function formatKnownPhotoTag(
  id: SchemaDefinitionId,
  v: MetadataValue | null | undefined,
): string | null {
  if (isKnownId(id, GPS_IDS.latitudeRef)) {
    const code = enumCodeFromMetadataValue(v);
    return code === "N" ? "North" : code === "S" ? "South" : null;
  }
  if (isKnownId(id, GPS_IDS.longitudeRef)) {
    const code = enumCodeFromMetadataValue(v);
    return code === "E" ? "East" : code === "W" ? "West" : null;
  }
  if (isKnownId(id, GPS_IDS.altitudeRef)) {
    const code = enumCodeFromMetadataValue(v);
    return code === "0"
      ? "Above Sea Level"
      : code === "1"
        ? "Below Sea Level"
        : null;
  }
  if (
    [GPS_IDS.latitude, GPS_IDS.longitude].some((known) => isKnownId(id, known))
  ) {
    return formatGpsCoordinate(v);
  }
  if (isKnownId(id, GPS_IDS.altitude)) {
    return formatGpsAltitude(v);
  }

  if (isKnownId(id, KNOWN_METADATA_IDS.exposureTime))
    return formatExposureTime(v);
  if (isKnownId(id, KNOWN_METADATA_IDS.fNumber)) return formatAperture(v);
  if (isKnownId(id, KNOWN_METADATA_IDS.focalLength))
    return formatFocalLength(v);
  return null;
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

function quote(value: string): string {
  return JSON.stringify(value);
}

function diagnosticPreview(value: unknown): string {
  const rendered =
    typeof value === "string"
      ? quote(value)
      : (JSON.stringify(value) ?? String(value));
  return rendered.length > 160 ? `${rendered.slice(0, 157)}...` : rendered;
}
