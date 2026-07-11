/**
 * Normalises longitude to the interval [-180, 180):
 * - 180 becomes -180
 * - -180 remains -180
 * - Deterministically maps all other values within [-180, 180)
 * - Avoids returning -0.
 */
export function normaliseLongitude(longitude: number): number {
  if (longitude >= -180 && longitude < 180) {
    return Object.is(longitude, -0) ? 0 : longitude;
  }
  const normalised = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalised, -0) ? 0 : normalised;
}

/**
 * Formats coordinate values to 7 decimal places, removing trailing zeros, avoiding -0.
 */
export function formatCoordinate(value: number): string {
  const formatted = value.toFixed(7).replace(/\.?0+$/, "");
  return formatted === "-0" || formatted === "" ? "0" : formatted;
}

/**
 * Calculates the equivalent longitude nearest to the map's current center to avoid
 * marker disappearances in repeated-world viewports:
 * lon + Math.round((centerLon - lon) / 360) * 360
 */
export function getNearestEquivalentLongitude(
  lon: number,
  centerLon: number,
): number {
  const k = Math.round((centerLon - lon) / 360);
  const result = lon + k * 360;
  return Object.is(result, -0) ? 0 : result;
}

/**
 * Returns true if both coordinates are finite numbers and latitude is in [-90, 90].
 *
 * NOTE: Longitude range validation is intentionally omitted here because longitude is
 * subsequently canonicalised (e.g. by normaliseLongitude) for repeated-world rendering.
 */
export function isValidCoordinate(
  lat: number | null | undefined,
  lon: number | null | undefined,
): boolean {
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    return false;
  }
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90
  );
}
