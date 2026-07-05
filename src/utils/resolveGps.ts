/**
 * Resolve a photo's effective GPS coordinates from drafts + metadata.
 *
 * The reverse-geocode flow asks the user to confirm sending GPS data
 * to a public endpoint. The lat/lon that ends up in that request must
 * reflect what the user currently *sees* — which means draft edits
 * take priority over the on-disk metadata, since the user may have
 * fixed a wrong GPS value but not yet applied it. See
 * `docs/REVERSE_GEOCODE_PLAN.md` §2.
 *
 * The frontend (not the backend) owns this precedence rule so the
 * backend never has to read the typed-draft store — it just trusts
 * the lat/lon it receives in `GeocodeRequestItem`.
 */
import type {
  ImageMetadataEntry,
  MetadataDraftEdit,
  MetadataValue,
  Variant,
} from "../types";

/**
 * Flat metadata bag — same shape as the `ImageMetadataStore.get()`
 * payload when present. The store also surfaces `"loading"`, which
 * callers must filter out before calling `resolveGps`.
 */
type MetadataBag = Record<string, ImageMetadataEntry>;

/**
 * GPS tag groups exiftool surfaces. `Composite` is the convenient
 * decimal-degrees view; the others are the per-format raw fields.
 * Listed in priority order — Composite preferred because it's already
 * decimal.
 */
const LAT_KEYS = [
  "Composite:GPSLatitude",
  "GPS:GPSLatitude",
  "XMP-exif:GPSLatitude",
  "EXIF:GPSLatitude",
  "QuickTime:GPSLatitude",
];
const LON_KEYS = [
  "Composite:GPSLongitude",
  "GPS:GPSLongitude",
  "XMP-exif:GPSLongitude",
  "EXIF:GPSLongitude",
  "QuickTime:GPSLongitude",
];
const LAT_REF_KEYS = [
  "GPS:GPSLatitudeRef",
  "XMP-exif:GPSLatitudeRef",
  "EXIF:GPSLatitudeRef",
];
const LON_REF_KEYS = [
  "GPS:GPSLongitudeRef",
  "XMP-exif:GPSLongitudeRef",
  "EXIF:GPSLongitudeRef",
];

/** Parse a single Variant into a positive magnitude. Handles number, DMS string, decimal string. */
function parseMagnitude(v: Variant): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const decimal = Number(trimmed);
  if (isFinite(decimal) && !Number.isNaN(decimal)) return decimal;
  // DMS form, e.g. `"51 deg 30' 0.55\" N"` — mirrors the Rust parser.
  const cleaned = trimmed
    .replace(/deg/gi, " ")
    .replace(/°/g, " ")
    .replace(/'/g, " ")
    .replace(/"/g, " ");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [d, m, s] = parts.slice(0, 3).map(Number);
  if (![d, m, s].every((n) => isFinite(n) && !Number.isNaN(n))) return null;
  return d + m / 60 + s / 3600;
}

/** Extract a hemisphere ref from a Variant ("N"/"S"/"E"/"W"). */
function parseRef(v: Variant): string | null {
  if (typeof v !== "string") return null;
  const r = v.trim().toUpperCase().charAt(0);
  return r === "N" || r === "S" || r === "E" || r === "W" ? r : null;
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

function gpsVariantFromMetadataEntry(
  value: ImageMetadataEntry | undefined,
): Variant | null {
  if (value === undefined || value === null) return null;
  if (!isMetadataValue(value)) return value;
  switch (value.kind) {
    case "Text":
    case "Integer":
    case "Real":
      return value.value;
    case "Rational":
      return value.value.denominator === 0
        ? null
        : value.value.numerator / value.value.denominator;
    default:
      return null;
  }
}

function gpsVariantFromMetadataValue(
  value: MetadataValue | null,
): Variant | null {
  if (value === null) return null;
  switch (value.kind) {
    case "Text":
    case "Integer":
    case "Real":
      return value.value;
    case "Rational":
      return value.value.denominator === 0
        ? null
        : value.value.numerator / value.value.denominator;
    default:
      return null;
  }
}

function extractValue(
  keys: string[],
  drafts: Record<string, MetadataDraftEdit> | undefined,
  metadata: MetadataBag | undefined,
): Variant | null {
  // Drafts win whether they are Set or Delete — a Delete-intent draft
  // means "this field is being removed", so we treat it as no value.
  for (const k of keys) {
    const d = drafts?.[k];
    if (d) {
      if (d.intent === "Delete") return null;
      const value = gpsVariantFromMetadataValue(d.value);
      if (value !== null) return value;
    }
  }
  for (const k of keys) {
    const v = gpsVariantFromMetadataEntry(metadata?.[k]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Resolve effective (lat, lon) decimal degrees for a photo, with
 * drafts winning over metadata.
 *
 * Returns `{ lat: null, lon: null }` when no usable GPS is available
 * anywhere. The geocode loop emits `no_gps` for that case rather than
 * failing the whole batch.
 */
export function resolveGps(
  drafts: Record<string, MetadataDraftEdit> | undefined,
  metadata: MetadataBag | undefined,
): { lat: number | null; lon: number | null } {
  const rawLat = extractValue(LAT_KEYS, drafts, metadata);
  const rawLon = extractValue(LON_KEYS, drafts, metadata);
  if (rawLat == null || rawLon == null) return { lat: null, lon: null };
  let lat = parseMagnitude(rawLat);
  let lon = parseMagnitude(rawLon);
  if (lat == null || lon == null) return { lat: null, lon: null };
  // Composite values are signed already; raw GPS:GPSLatitude is
  // positive magnitude with the sign carried by GPSLatitudeRef. Apply
  // refs only when the original value was a string (DMS) — Composite
  // returns a signed number directly.
  if (typeof rawLat === "string") {
    const ref = parseRef(extractValue(LAT_REF_KEYS, drafts, metadata) ?? null);
    if (ref === "S") lat = -Math.abs(lat);
    else if (ref === "N") lat = Math.abs(lat);
  }
  if (typeof rawLon === "string") {
    const ref = parseRef(extractValue(LON_REF_KEYS, drafts, metadata) ?? null);
    if (ref === "W") lon = -Math.abs(lon);
    else if (ref === "E") lon = Math.abs(lon);
  }
  return { lat, lon };
}
