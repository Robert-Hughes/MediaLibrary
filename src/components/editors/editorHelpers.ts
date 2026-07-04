import type { Variant, EnumOption, TagKind } from "../../types";
import { gpsTagGroup } from "../../metadata/tag_overrides";

// ── BagEditor Helpers ────────────────────────────────────────────────────────

/**
 * Best-effort initial-items extraction from whatever the caller has on hand:
 * a Variant value, the legacy comma-joined display string, or undefined.
 */
export function initialItemsFrom(
  value: Variant | string | null | undefined,
): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : String(v)))
      .filter((s) => s.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // bool/number/object: not list-shaped; treat as a single chip if non-empty.
  const s = String(value);
  return s ? [s] : [];
}

// ── NestedListEditor Helpers ──────────────────────────────────────────────────

/** Coerce whatever the caller has into a Variant[] suitable for editing. */
export function initialItemsFromVariant(value: Variant | undefined): Variant[] {
  if (Array.isArray(value)) return value.slice();
  if (value === null || value === undefined) return [];
  // Single non-list value treated as a one-item list (matches verifier's
  // scalar↔list promotion).
  return [value];
}

// ── DateTimeEditor Helpers ────────────────────────────────────────────────────

/**
 * Convert exiftool's `YYYY:MM:DD HH:MM:SS[±ZZ:ZZ]` (or partial forms) into
 * the HTML datetime-local input value `YYYY-MM-DDTHH:MM:SS`.  Loses tz on
 * display; that's a known cost of using the standard input.
 */
export function toIsoLocal(s: string): string {
  if (!s) return "";
  // YYYY:MM:DD HH:MM:SS[.frac][±ZZ:ZZ]
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
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

// ── EnumEditor Helpers ────────────────────────────────────────────────────────

/** Extract the current code (raw or pretty label) from whatever we have. */
export function initialCodeFrom(
  raw: Variant | undefined,
  display: Variant | undefined,
  options: EnumOption[],
): string {
  // Prefer the raw value when it matches a known code or label.  ExifTool
  // often hands back the pretty label as the variant (no `-n`), so always
  // probe the options table before falling back to the raw string — otherwise
  // EnumEditor opens in Custom mode for in-spec values.
  if (
    raw !== undefined &&
    raw !== null &&
    !Array.isArray(raw) &&
    typeof raw !== "object"
  ) {
    const s = String(raw);
    const byCode = options.find((o) => o.code === s);
    if (byCode) return byCode.code;
    const byLabel = options.find((o) => o.label === s);
    if (byLabel) return byLabel.code;
    return s;
  }
  // Look up the display label in the options table.
  if (typeof display === "string") {
    const match = options.find((o) => o.label === display);
    if (match) return match.code;
    return display;
  }
  if (typeof display === "number") return String(display);
  return options[0]?.code ?? "";
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
 * DraftEdit.display string so the pending-change cell shows "Flash fired,
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

export const gpsGroupFor = gpsTagGroup;

/**
 * Format a decimal-degrees value plus hemisphere as exiftool's canonical
 * DMS display string, e.g. `51 deg 30' 26.16" N`.  Used for the
 * DraftEdit.display field so the pending-change cell shows the same form
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
      else if (
        value !== null &&
        value !== undefined &&
        !Array.isArray(value) &&
        typeof value !== "object"
      ) {
        out[lang] = String(value);
      }
    }
  }
  return out;
}

// ── StructEditor Helpers ──────────────────────────────────────────────────────

/** Best-effort: turn whatever we have into an Object suitable for editing. */
export function initialObjectFrom(
  value: Variant | undefined,
): Record<string, Variant> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, Variant>;
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
    case "DateTime":
      return "Date/time";
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
