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
 * Places a collection of longitudes on the smallest possible span of adjacent
 * world copies while preserving the input order.
 *
 * The largest gap determines the unused side of the globe. Its opposite arc's
 * centre is then passed through the same nearest-copy calculation used by the
 * interactive GPS map. Keeping the selected start value directly avoids
 * reconstructing it with `% 360`, which can move a boundary by a floating-point
 * rounding error and send otherwise-nearby coordinates to different worlds.
 */
export function getCompactDisplayLongitudes(
  longitudes: readonly number[],
): number[] {
  if (longitudes.length === 0) return [];
  if (longitudes.length === 1) {
    return [normaliseLongitude(longitudes[0])];
  }

  const values = longitudes
    .map((longitude) => normaliseLongitude(longitude))
    .map((longitude) => (longitude < 0 ? longitude + 360 : longitude))
    .sort((left, right) => left - right);

  let largestGap = -1;
  let largestGapIndex = 0;
  for (let index = 0; index < values.length; index += 1) {
    const next =
      index === values.length - 1 ? values[0] + 360 : values[index + 1];
    const gap = next - values[index];
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }

  const arcStart = values[(largestGapIndex + 1) % values.length];
  const arcCenter = arcStart + (360 - largestGap) / 2;
  return longitudes.map((longitude) =>
    getNearestEquivalentLongitude(normaliseLongitude(longitude), arcCenter),
  );
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
