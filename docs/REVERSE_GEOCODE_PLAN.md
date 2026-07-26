# Reverse Geocoding

Reverse Geocode sends each photo's effective GPS latitude/longitude to
OpenStreetMap Nominatim and stages the two exact API response bodies as
evidence. Images are never uploaded. Reverse Geocode deliberately does not
interpret or modify canonical/legacy location metadata.

## Requests and evidence

- endpoints: Nominatim `/reverse?format=geocodejson` and
  `/reverse?format=jsonv2`
- language preference: `en-GB,en;q=0.9`
- zoom fallback: GeocodeJSON is tried at 18, 16, 14, 12, 10 until a usable
  civic result is found; JSONv2 is then requested at the selected zoom
- rate limit: one Nominatim request per second
- cache: app-wide version-5 JSON cache, 50 m haversine matching, containing
  both exact response bodies
- no Overpass enrichment: a nearby POI is not necessarily where the camera
  was, and the two Nominatim formats already expose the selected feature and
  differently mapped address hierarchies

The normalization contract and rationale are in
[REVERSE_GEOCODE_MAPPING.md](REVERSE_GEOCODE_MAPPING.md).

## Draft behavior

Each success produces two Set drafts:

- `XMP-mlib:ReverseGeocodeGeocodeJSON`
- `XMP-mlib:ReverseGeocodeJSONv2`

Both are text fields containing the response body verbatim. Keeping separate
fields is intentionally simple, inspectable, and faithful to each provider
format. Reverse Geocode does not pre-resolve disagreements: that semantic
judgement belongs to Normalize Metadata.

An all-empty GeocodeJSON fallback sequence produces a `nominatim_empty`
failure and no drafts. Failure to obtain either required live response also
produces no drafts. Missing GPS produces `no_gps`. Existing
`LocationCreated`, EXIF GPS, and legacy flat location fields are never changed
by Reverse Geocode.

The Location normalizer owns interoperability with the older five XMP/IIM
pairs. See [NORMALISE_METADATA_PLAN.md](NORMALISE_METADATA_PLAN.md).

## Cancellation and cache

Cancellation is checked at image boundaries and before/after rate-limit waits.
Cache hits make no network request. Successful Nominatim results cache both
exact bodies so cached and live runs produce identical evidence drafts. The
camera coordinates remain authoritative in the photo metadata and are copied
into `LocationCreated` later by Normalize Metadata.

## Nominatim origin consistency

The public Nominatim endpoint is load-balanced, and reverse-geocode selection
can differ between its origin servers even when their replicated OSM data is
current. A reverse result is the closest _suitable indexed feature_ selected by
Nominatim; it is not necessarily the containing venue or the feature a person
would use to describe the photograph.

This was reproduced on 2026-07-26 for `IMG_0817.jpg` at approximately
51.515400, -0.145225:

| Origin                     | Zoom-18 reverse result                  |
| -------------------------- | --------------------------------------- |
| `dulcy.openstreetmap.org`  | `Winged Figure` (OSM node `6206953762`) |
| `vhagar.openstreetmap.org` | `John Lewis` (OSM way `45405645`)       |

Identical reverse requests sent directly to the two origins produced those
different results. This was not the MediaLibrary disk cache: the result was
reproduced after removing that cache and the new entry recorded a live
Nominatim request.

The evidence points to differing derived spatial/address indexes or reverse
ranking rather than ordinary replication lag:

- both origins' `/status?format=json` responses reported the same
  `data_updated` value, Nominatim version, and database version;
- `/lookup` on both origins found both OSM objects;
- both OSM objects predated the origins' reported database update;
- the origins nevertheless differed even in the artwork's derived address:
  `dulcy` associated it with 300 Oxford Street, while `vhagar` associated it
  with Holles Street.

The public response exposed the serving origin in the observational
`x-nominatim-server` header. That header is useful for diagnostics, although it
is not part of the GeocodeJSON data contract and should not drive metadata
mapping. Different URL encodings also produced different Fastly cache keys and
were routed to different origins during this investigation; URL spelling can
therefore make an origin-specific result appear stable.

Consequences for MediaLibrary:

- clearing the local geocode cache cannot fix an origin-specific index result;
- `geocoding.name` remains the selected feature name, not a guaranteed
  containing-venue name;
- do not add place-specific normalization or retry against named Nominatim
  origins to force a preferred answer;
- when diagnosing surprising live results, record the exact URL, query
  coordinates, zoom, response OSM identity, local-cache status, response time,
  and `x-nominatim-server` when available.

See Nominatim's
[reverse API documentation](https://nominatim.org/release-docs/latest/api/Reverse/)
for its closest-suitable-object semantics and
[status API documentation](https://nominatim.org/release-docs/latest/api/Status/)
for the meaning of `data_updated`.
