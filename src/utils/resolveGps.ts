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
import type { MetadataValue, SchemaDefinitionId } from "../types";
import type { SchemaDraftDisplayProjection } from "../targetDraftView";
import { GPS_IDS, KNOWN_METADATA_IDS } from "../metadata/knownIds";
import { metadataGet, type MetadataCollection } from "./metadataCollection";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

/**
 * Flat schema-view bag derived from authoritative occurrences. Callers must
 * exclude loading state before constructing it.
 */
type MetadataBag = MetadataCollection;
type GpsScalar = string | number;
type SelectedGpsValue = { id: SchemaDefinitionId; value: GpsScalar };

/**
 * GPS tag groups exiftool surfaces. `Composite` is the convenient
 * decimal-degrees view; the others are the per-format raw fields.
 * Listed in priority order — Composite preferred because it's already
 * decimal.
 */
const LAT_IDS = [KNOWN_METADATA_IDS.compositeGpsLatitude, GPS_IDS.latitude];
const LON_IDS = [KNOWN_METADATA_IDS.compositeGpsLongitude, GPS_IDS.longitude];
const LAT_REF_IDS = [GPS_IDS.latitudeRef];
const LON_REF_IDS = [GPS_IDS.longitudeRef];

/** Parse a single GPS scalar into a positive magnitude. Handles number, DMS string, decimal string. */
function parseMagnitude(v: GpsScalar): number | null {
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

/** Extract a hemisphere ref from a GPS scalar ("N"/"S"/"E"/"W"). */
function parseRef(v: GpsScalar | null): string | null {
  if (v === null) return null;
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

function gpsScalarFromMetadataEntry(
  value: MetadataValue | undefined,
): GpsScalar | null {
  if (value === undefined || value === null) return null;
  if (!isMetadataValue(value)) return value;
  return gpsScalarFromMetadataValue(value);
}

function gpsScalarFromMetadataValue(
  value: MetadataValue | null,
): GpsScalar | null {
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
    case "List":
      return value.value.items.length === 1
        ? gpsScalarFromMetadataValue(value.value.items[0])
        : null;
    default:
      return null;
  }
}

function extractValue(
  ids: readonly SchemaDefinitionId[],
  drafts: SchemaDraftDisplayProjection | undefined,
  metadata: MetadataBag | undefined,
): SelectedGpsValue | null {
  // Drafts win whether they are Set or Delete — a Delete-intent draft
  // means "this field is being removed", so we treat it as no value.
  for (const id of ids) {
    const d = drafts?.[schemaDefinitionIdToken(id)]?.edit;
    if (d) {
      if (d.intent === "Delete") return null;
      const value = gpsScalarFromMetadataValue(d.value);
      if (value !== null) return { id, value };
    }
  }
  for (const id of ids) {
    const v = gpsScalarFromMetadataEntry(
      metadata ? metadataGet(metadata, id) : undefined,
    );
    if (v !== null) return { id, value: v };
  }
  return null;
}

function extractScalar(
  ids: readonly SchemaDefinitionId[],
  drafts: SchemaDraftDisplayProjection | undefined,
  metadata: MetadataBag | undefined,
): GpsScalar | null {
  return extractValue(ids, drafts, metadata)?.value ?? null;
}

function isCompositeGpsId(id: SchemaDefinitionId): boolean {
  return id.table === "Composite";
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
  drafts: SchemaDraftDisplayProjection | undefined,
  metadata: MetadataBag | undefined,
): { lat: number | null; lon: number | null } {
  const rawLat = extractValue(LAT_IDS, drafts, metadata);
  const rawLon = extractValue(LON_IDS, drafts, metadata);
  if (rawLat == null || rawLon == null) return { lat: null, lon: null };
  let lat = parseMagnitude(rawLat.value);
  let lon = parseMagnitude(rawLon.value);
  if (lat == null || lon == null) return { lat: null, lon: null };
  // Composite values are signed already; raw GPS/XMP/EXIF latitude and
  // longitude values carry their sign in the paired hemisphere ref.
  if (!isCompositeGpsId(rawLat.id)) {
    const ref = parseRef(extractScalar(LAT_REF_IDS, drafts, metadata));
    if (ref === "S") lat = -Math.abs(lat);
    else if (ref === "N") lat = Math.abs(lat);
  }
  if (!isCompositeGpsId(rawLon.id)) {
    const ref = parseRef(extractScalar(LON_REF_IDS, drafts, metadata));
    if (ref === "W") lon = -Math.abs(lon);
    else if (ref === "E") lon = Math.abs(lon);
  }
  return { lat, lon };
}
