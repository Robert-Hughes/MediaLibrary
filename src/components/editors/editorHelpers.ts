import type {
  MetadataValue,
  EnumOption,
  TagKind,
  UtcOffsetValue,
} from "../../types";
import { metadataValueToDisplayString } from "../../draft";

// ── BagEditor Helpers ────────────────────────────────────────────────────────

/**
 * Best-effort initial-items extraction from whatever the caller has on hand:
 * a MetadataValue value, a plain-string display form, or undefined.
 */
export function initialItemsFrom(
  value: MetadataValue | null | undefined,
): string[] {
  if (value === null || value === undefined) return [];
  if (value.kind === "List") {
    return value.value.items
      .map((item) =>
        item.kind === "Text" ? item.value : metadataValueToDisplayString(item),
      )
      .filter((s) => s.length > 0);
  }
  if (value.kind === "Null") return [];
  const s = metadataValueToDisplayString(value);
  return s ? [s] : [];
}

// ── NestedListEditor Helpers ──────────────────────────────────────────────────

/** Coerce whatever the caller has into a MetadataValue[] suitable for editing. */
export function initialItemsFromMetadataValue(
  value: MetadataValue | undefined,
): MetadataValue[] {
  if (!value) return [];
  if (value.kind === "List") return value.value.items;
  if (value.kind === "Null") return [];
  return [value];
}

// ── DateTimeEditor Helpers ────────────────────────────────────────────────────

/** Convert `YYYY:MM:DD` or `YYYY-MM-DD` into the HTML date input value. */
export function toHtmlDate(s: string): string {
  if (!s) return "";
  const m = s.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${y}-${mo}-${d}`;
}

/** Convert the HTML date input string to IPTC/ExifTool date storage format. */
export function toExiftoolDate(s: string): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}:${mo}:${d}`;
}

/** Convert `HH:MM[:SS][±ZZ[:ZZ]]` into the HTML time input value. */
export function toHtmlTime(s: string): string {
  if (!s) return "";
  const m = s.trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  const [, h, mi, se] = m;
  return `${h}:${mi}:${se ?? "00"}`;
}

/** Extract an existing time-zone offset from an IPTC time value, if present. */
export function timeOffset(s: string): string {
  const m = s.trim().match(/([+-]\d{2}:?\d{2})$/);
  return m ? m[1] : "";
}

/**
 * Convert the HTML time input string to a time-only storage value, preserving
 * the original offset when one was present.
 */
export function toExiftoolTime(s: string, offset = ""): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, h, mi, se] = m;
  return `${h}:${mi}:${se ?? "00"}${offset}`;
}

/**
 * Convert exiftool's `YYYY:MM:DD HH:MM:SS[±ZZ:ZZ]` (or partial forms) into
 * the HTML datetime-local input value `YYYY-MM-DDTHH:MM:SS`.  Loses tz on
 * display; that's a known cost of using the standard input.
 */
export function toIsoLocal(s: string): string {
  if (!s) return "";
  // YYYY:MM:DD HH:MM:SS[.frac][±ZZ:ZZ] or ISO-like YYYY-MM-DDTHH:MM:SS.
  const m = s.match(
    /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!m) return "";
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se ?? "00"}`;
}

/**
 * Convert the HTML datetime-local input string to exiftool's canonical
 * format.  Returns `null` for invalid input.
 */
export function toExiftoolFormat(s: string): string | null {
  if (!s) return null;
  // Input: YYYY-MM-DDTHH:MM[:SS]
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}:${mo}:${d} ${h}:${mi}:${se ?? "00"}`;
}

export function initialCodeFrom(
  raw: MetadataValue | undefined,
  options: EnumOption[],
): string {
  // Prefer the raw value when it matches a known code or label.
  if (raw) {
    if (raw.kind === "Integer") {
      const s = String(raw.value);
      const byCode = options.find((o) => o.code === s);
      if (byCode) return byCode.code;
      return s;
    }
    if (raw.kind === "Text") {
      const s = raw.value;
      const byCode = options.find((o) => o.code === s);
      if (byCode) return byCode.code;
      const byLabel = options.find((o) => o.label === s);
      if (byLabel) return byLabel.code;
      return s;
    }
  }
  return options[0]?.code ?? "";
}

/** Construct a semantic starting value for a newly-added property. */
export function defaultMetadataValueForKind(kind: TagKind): MetadataValue {
  switch (kind.kind) {
    case "Text":
      return { kind: "Text", value: "" };
    case "LangAlt":
      return { kind: "LangAlt", value: { "x-default": "" } };
    case "Integer":
      return { kind: "Integer", value: kind.data.min ?? 0 };
    case "Real":
      return { kind: "Real", value: 0 };
    case "Rational":
      return { kind: "Rational", value: { numerator: 0, denominator: 1 } };
    case "Boolean":
      return { kind: "Bool", value: false };
    case "Date":
    case "Time":
    case "DateTime":
    case "TimeOffset":
      return { kind: "Null" };
    case "Enum": {
      const code = kind.data.options[0]?.code ?? "";
      return kind.data.repr === "Integer"
        ? { kind: "Integer", value: Number(code) || 0 }
        : { kind: "Text", value: code };
    }
    case "Bag":
    case "Seq":
    case "Alt":
      return {
        kind: "List",
        value: { list_kind: kind.kind, items: [] },
      };
    case "Struct":
      return { kind: "Struct", value: {} };
    case "Binary":
      return { kind: "Binary" };
    case "Unknown":
      return { kind: "Null" };
  }
}

/** Initial value for numeric controls, derived only from semantic metadata. */
export function numericInitialString(
  value: MetadataValue | undefined,
): string {
  if (!value || value.kind === "Null") return "";
  if (value.kind === "Integer" || value.kind === "Real") {
    return String(value.value);
  }
  if (value.kind === "Rational" && value.value.denominator !== 0) {
    return String(value.value.numerator / value.value.denominator);
  }
  return "";
}

/** Deliberate plain-text fallback for schema Text/unknown keys. */
export function textInitialString(value: MetadataValue | undefined): string {
  if (!value || value.kind === "Null") return "";
  if (value.kind === "Text") return value.value;
  return metadataValueToDisplayString(value);
}

// ── FlashEditor Helpers ───────────────────────────────────────────────────────

export interface FlashFields {
  fired: boolean;
  returnStatus: 0 | 2 | 3; // skip 1 (reserved)
  mode: 0 | 1 | 2 | 3;
  noFunction: boolean;
  redEye: boolean;
}

export function decodeFlashCode(code: number): FlashFields {
  return {
    fired: (code & 0b1) !== 0,
    returnStatus: ((code >> 1) & 0b11) as 0 | 2 | 3,
    mode: ((code >> 3) & 0b11) as 0 | 1 | 2 | 3,
    noFunction: (code & 0b100000) !== 0,
    redEye: (code & 0b1000000) !== 0,
  };
}

export function encodeFlashFields(f: FlashFields): number {
  return (
    (f.fired ? 1 : 0) |
    ((f.returnStatus & 0b11) << 1) |
    ((f.mode & 0b11) << 3) |
    (f.noFunction ? 0b100000 : 0) |
    (f.redEye ? 0b1000000 : 0)
  );
}

export const MODE_LABELS: Record<number, string> = {
  0: "Unknown",
  1: "Compulsory firing",
  2: "Compulsory suppression",
  3: "Auto",
};

export const RETURN_LABELS: Record<number, string> = {
  0: "No return detected",
  2: "Return not detected",
  3: "Return detected",
};

/**
 * Compose a human-readable description from the field bag — used for the
 * MetadataDraftEdit.display string so the pending-change cell shows "Flash fired,
 * Auto, Red-eye reduction" instead of a bare integer code.  Roughly mirrors
 * exiftool's PrintConv for the Flash tag.
 */
export function describeFlashCode(f: FlashFields): string {
  const parts: string[] = [];
  if (f.noFunction) {
    parts.push("No flash function");
  } else {
    parts.push(f.fired ? "Fired" : "Did not fire");
    if (f.mode !== 0) parts.push(MODE_LABELS[f.mode]);
    if (f.returnStatus !== 0) parts.push(RETURN_LABELS[f.returnStatus]);
    if (f.redEye) parts.push("Red-eye reduction");
  }
  return parts.join(", ");
}

// ── GpsEditor Helpers ─────────────────────────────────────────────────────────

/**
 * Format a decimal-degrees value plus hemisphere as exiftool's canonical
 * DMS display string, e.g. `51 deg 30' 26.16" N`.  Used for the
 * MetadataDraftEdit.display field so the pending-change cell shows the same form
 * the user would see in the read view (Pass A pretty output).
 */
export function decimalToDms(
  decimal: number,
  hemisphere: "N" | "S" | "E" | "W",
): string {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  const secStr = sec.toFixed(2).replace(/\.?0+$/, "");
  return `${deg} deg ${min}' ${secStr}" ${hemisphere}`;
}

/**
 * Best-effort extraction of decimal-degrees latitude from a metadata value.
 * exiftool emits either a raw decimal number (Pass B / `-n`) or a
 * DMS-formatted string ("51 deg 30' 26.16\" N").  The frontend currently
 * sees only the Pass A display path; the conversion handles both.
 */
export function parseDecimalDegrees(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isFinite(value) ? Math.abs(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Try plain number first.
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) return Math.abs(asNum);
  // DMS: `51 deg 30' 26.16" N` (or `S/E/W`).  exiftool's default form.
  const m = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*deg\s*(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)"\s*([NSEW])?/,
  );
  if (m) {
    const d = parseFloat(m[1]);
    const min = parseFloat(m[2]);
    const sec = parseFloat(m[3]);
    return d + min / 60 + sec / 3600;
  }
  return null;
}

export function gpsScalarFromMetadataValue(
  value: MetadataValue | undefined,
): string | number | null {
  if (!value) return null;
  switch (value.kind) {
    case "Real":
    case "Integer":
      return value.value;
    case "Text":
      return value.value;
    case "Rational":
      return value.value.denominator !== 0
        ? value.value.numerator / value.value.denominator
        : null;
    case "List": {
      const items = value.value.items;
      if (items.length === 1) return gpsScalarFromMetadataValue(items[0]);
      if (items.length === 3) {
        const degrees = gpsNumberFromMetadataValue(items[0]);
        const minutes = gpsNumberFromMetadataValue(items[1]);
        const seconds = gpsNumberFromMetadataValue(items[2]);
        if (degrees === null || minutes === null || seconds === null) {
          return null;
        }
        const sign = degrees < 0 ? -1 : 1;
        return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
      }
      return null;
    }
    default:
      return null;
  }
}

export function gpsNumberFromMetadataValue(
  value: MetadataValue | undefined,
): number | null {
  const scalar = gpsScalarFromMetadataValue(value);
  if (typeof scalar === "number")
    return Number.isFinite(scalar) ? scalar : null;
  if (typeof scalar !== "string") return null;
  const decimal = parseDecimalDegrees(scalar);
  if (decimal !== null) return decimal;
  const parsed = parseFloat(scalar);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Best-effort extraction of the hemisphere from a metadata value.  Falls
 * back to "N"/"E" when nothing parseable is found.
 */
export function parseHemisphere(
  value: unknown,
  axis: "lat" | "lon",
): "N" | "S" | "E" | "W" {
  const fallback: "N" | "E" = axis === "lat" ? "N" : "E";
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (axis === "lat" && (upper === "N" || upper === "S")) return upper;
    if (axis === "lon" && (upper === "E" || upper === "W")) return upper;
    // Look for trailing N/S/E/W in a DMS string.
    const m = value.trim().match(/([NSEW])\s*$/i);
    if (m) {
      const g = m[1].toUpperCase();
      if (axis === "lat" && (g === "N" || g === "S")) return g;
      if (axis === "lon" && (g === "E" || g === "W")) return g;
    }
  }
  if (typeof value === "number") {
    if (axis === "lat") return value < 0 ? "S" : "N";
    return value < 0 ? "W" : "E";
  }
  return fallback;
}

// ── LangAltEditor Helpers ─────────────────────────────────────────────────────

/** Extract initial per-language values from the metadata for this tag. */
export function initialLangsFrom(
  baseValue: MetadataValue | undefined,
  metadataForFile: Record<string, MetadataValue>,
  propertyKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};

  if (baseValue) {
    if (baseValue.kind === "LangAlt") {
      const res: Record<string, string> = {};
      for (const [lang, val] of Object.entries(baseValue.value)) {
        if (typeof val === "string") res[lang] = val;
      }
      return res;
    }
    if (baseValue.kind === "Text") {
      out["x-default"] = baseValue.value;
    }
  }

  for (const [key, value] of Object.entries(metadataForFile)) {
    if (key === propertyKey) continue;
    if (key.startsWith(propertyKey + "-")) {
      const lang = key.slice(propertyKey.length + 1);
      if (value.kind === "Text") {
        out[lang] = value.value;
      }
    }
  }
  return out;
}

// ── StructEditor Helpers ──────────────────────────────────────────────────────

/** Best-effort: turn whatever we have into an Object suitable for editing. */
export function initialObjectFrom(
  value: MetadataValue | undefined,
): Record<string, MetadataValue> {
  if (value && value.kind === "Struct") {
    const res: Record<string, MetadataValue> = {};
    for (const [key, val] of Object.entries(value.value)) {
      if (val !== undefined && val !== null) res[key] = val;
    }
    return res;
  }
  return {};
}

// ── EditorMetaHint Helpers ────────────────────────────────────────────────────

/**
 * Friendly one-line description of what kind of value a tag expects.
 * Mirrors METADATA_FORMATS_DESIGN.md §5 TagKind table.
 */
export function describeKind(kind: TagKind): string {
  switch (kind.kind) {
    case "Text":
      return "Text";
    case "LangAlt":
      return "Language-alternative text (multi-language)";
    case "Integer": {
      const { min, max } = kind.data;
      const bounds =
        (min !== null && min !== undefined) ||
        (max !== null && max !== undefined)
          ? ` (${min ?? "—"} … ${max ?? "—"})`
          : "";
      return `Integer${bounds}`;
    }
    case "Real":
      return "Real number";
    case "Rational":
      return "Rational number";
    case "Boolean":
      return "Boolean (true/false)";
    case "Date":
      return "Date";
    case "Time":
      return "Time";
    case "DateTime":
      return "Date/time";
    case "TimeOffset":
      return "Time offset";
    case "Enum":
      return `Enum (${kind.data.options.length} options)`;
    case "Bag":
      return `Bag — unordered list of ${describeKind(kind.data).toLowerCase()}`;
    case "Seq":
      return `Seq — ordered list of ${describeKind(kind.data).toLowerCase()}`;
    case "Alt":
      return `Alt — alternatives of ${describeKind(kind.data).toLowerCase()}`;
    case "Struct":
      return "Struct (nested object)";
    case "Binary":
      return "Binary (not editable)";
    case "Unknown":
      return "Unknown type";
  }
}

/**
 * Parse a timezone offset string (e.g. "+01:00", "-05:30", "Z") conservatively.
 * Returns null if the format is invalid.
 */
export function parseTimeOffset(s: string): UtcOffsetValue | null {
  const trimmed = s.trim();
  if (/^[zZ]$/.test(trimmed)) {
    return { sign: "Plus", hours: 0, minutes: 0 };
  }
  const match = trimmed.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const [, sign, hStr, mStr] = match;
  const hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);
  if (hours < 0 || hours > 14) return null;
  if (minutes < 0 || minutes > 59) return null;
  return {
    sign: sign === "+" ? "Plus" : "Minus",
    hours,
    minutes,
  };
}

/**
 * Format a UtcOffsetValue back into the "+HH:MM" format.
 */
export function formatTimeOffset(offset: UtcOffsetValue): string {
  const signStr = offset.sign === "Plus" ? "+" : "-";
  const hStr = String(offset.hours).padStart(2, "0");
  const mStr = String(offset.minutes).padStart(2, "0");
  return `${signStr}${hStr}:${mStr}`;
}
