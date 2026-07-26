# Reverse-Geocode Evidence and Location Normalization

## Why the API responses are not mapped directly

Nominatim GeocodeJSON and JSONv2 are views over the same selected OSM feature,
but their formatters assign address hierarchy rows differently. Neither
formatter is universally better for photographic metadata:

- JSONv2 called Ely the city where GeocodeJSON called East Cambridgeshire the
  city and Ely the district.
- GeocodeJSON preserved Tokyo as the city/state where JSONv2 called Minato the
  city and exposed Tokyo only as `JP-13`.
- both formats can select a nearby feature that is technically suitable for
  reverse lookup but is not the venue a person would use to describe a photo.

Hard-coded field precedence therefore encodes accidental formatter semantics.
Place-specific corrections such as a London rule are explicitly excluded.
Instead, Reverse Geocode preserves both raw responses and Normalize Metadata
performs the semantic interpretation.

## Evidence storage

The exact response bodies are stored independently:

| Read-only normalization input        | Meaning                             |
| ------------------------------------ | ----------------------------------- |
| `XMP-mlib:ReverseGeocodeGeocodeJSON` | Exact `format=geocodejson` response |
| `XMP-mlib:ReverseGeocodeJSONv2`      | Exact `format=jsonv2` response      |

Two plain text fields were chosen over a wrapper structure or one field per
Nominatim property. This keeps the XMP contract small, retains fields that may
become useful later, and lets the model reason over the provider formats
without MediaLibrary maintaining another partial address schema.

## Normalize Location decision order

1. If exactly one valid `LocationCreated` structure exists, it is
   authoritative. AI is not called, even when newer evidence exists.
2. If `LocationCreated` is absent and either evidence field is non-empty, the
   configured location-normalization model receives the available response
   strings verbatim and returns the human-facing members.
3. If neither evidence field exists, the existing five XMP/IIM pairs seed
   `LocationCreated` deterministically; XMP wins a disagreement.
4. Multiple or malformed `LocationCreated` structures remain a manual
   ambiguity. AI must not discard or silently choose one.

This mirrors Title normalization: AI fills a missing canonical value from
available evidence, but an existing canonical value is trusted. No additional
model/prompt provenance is written. Clearing `LocationCreated` is therefore
the explicit way to request reinterpretation of stored evidence.

## AI and deterministic responsibilities

The AI returns nullable human-facing strings:

- `Sublocation`
- `City`
- `ProvinceState`
- `CountryName`
- `WorldRegion`
- `LocationName`

The system prompt defines canonical selection rules for their IPTC meanings,
requests English or commonly anglicised names, permits supported metropolitan
combinations such as `Minato, Tokyo`, and requires null rather than invention
when the responses do not support a field. It also separates populated places
from administrative districts, prefers first-order regions for
`ProvinceState`, and fixes house-number-plus-road formatting. A strict OpenAI
Structured Outputs schema enforces the response shape; schema compliance does
not replace semantic testing, which is why the model remains a user setting.

MediaLibrary deterministically supplies:

- `GPSLatitude`, `GPSLongitude`, `GPSAltitude`, and `GPSAltitudeRef` from the
  photo metadata;
- `LocationId` as the deduplicated bag of valid OSM identities exposed by
  either response;
- `CountryCode` only when the valid ISO 3166-1 alpha-2 values supplied by the
  responses agree.

## Legacy projection

After creating or reading canonical `LocationCreated`, Normalize projects its
five overlapping members:

| `LocationCreated`                             | XMP mirror                 | IPTC/IIM mirror                    |
| --------------------------------------------- | -------------------------- | ---------------------------------- |
| `LocationName`, falling back to `Sublocation` | `XMP-iptcCore:Location`    | `IPTC:Sub-location`                |
| `City`                                        | `XMP-photoshop:City`       | `IPTC:City`                        |
| `ProvinceState`                               | `XMP-photoshop:State`      | `IPTC:Province-State`              |
| `CountryName`                                 | `XMP-photoshop:Country`    | `IPTC:Country-PrimaryLocationName` |
| `CountryCode`                                 | `XMP-iptcCore:CountryCode` | `IPTC:Country-PrimaryLocationCode` |

Projection is deliberately deterministic: the most useful legacy location
label is `LocationName` when present, otherwise `Sublocation`; other values are
copied, whitespace and country-code representation are normalized, and only
the required 32-character IPTC Sublocation limit loses detail. Richer members
remain in `LocationCreated` because the legacy fields have no equivalents.

## Known consequence

If both responses select `Winged Figure` and no response mentions John Lewis,
the model cannot recover John Lewis from those two inputs. Existing legacy
fields are deliberately not supplied to the AI when reverse-geocode evidence
is present; fresh evidence wins only while `LocationCreated` is absent. This
trade-off keeps the prompt contract simple and predictable.
