# Reverse Geocoding

Reverse Geocode sends each photo's effective GPS latitude/longitude to
OpenStreetMap Nominatim and stages one structured
`XMP-iptcExt:LocationCreated` draft. Images are never uploaded.

## Request and mapping

- endpoint: Nominatim `/reverse?format=geocodejson`
- language preference: `en-GB,en;q=0.9`
- zoom fallback: 18, 16, 14, 12, 10 until a usable civic result is found
- rate limit: one Nominatim request per second
- cache: app-wide version-4 JSON cache, 50 m haversine matching
- no Overpass enrichment: a nearby POI is not necessarily where the camera
  was, while GeocodeJSON already supplies the selected feature's normalized
  `name`, hierarchy, and OSM identity

The exact field contract and rationale are in
[REVERSE_GEOCODE_MAPPING.md](REVERSE_GEOCODE_MAPPING.md).

## Draft behavior

Each success produces exactly one Set draft for
`XMP-iptcExt:LocationCreated`. The value is a Bag containing exactly one
Location structure. Replacing the parent is atomic, so missing members do not
leave stale address fragments behind.

An all-empty GeocodeJSON result produces a `nominatim_empty` failure and no
draft. Missing GPS produces `no_gps`. Existing EXIF GPS and legacy flat
location fields are never changed by Reverse Geocode.

The Location normalizer owns interoperability with the older five XMP/IIM
pairs. See [NORMALISE_METADATA_PLAN.md](NORMALISE_METADATA_PLAN.md).

## Cancellation and cache

Cancellation is checked at image boundaries and before/after rate-limit waits.
Cache hits make no network request. Successful Nominatim results are cached as
the structured candidate; the photo coordinates stay on the cache entry and
are reapplied from the current query so a nearby cache hit still records that
photo's own position.
