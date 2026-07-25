# Reverse-Geocode Metadata Mapping

MediaLibrary requests Nominatim's GeocodeJSON response in English and replaces
`XMP-iptcExt:LocationCreated` with exactly one structured location. Reverse
Geocode does not write the older flat XMP/IPTC fields; Normalise Location
projects the compatible members to them.

## GeocodeJSON to LocationCreated

| LocationCreated member        | GeocodeJSON source                 | Reason                                                                                        |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `Sublocation`                 | `name`, else `street`              | The selected named feature is the most specific place; a street is the conservative fallback. |
| `City`                        | `city`                             | `locality`, `district`, and `county` have different meanings and are not promoted.            |
| `ProvinceState`               | `state`, else `admin.level4`       | The numbered admin hierarchy is the only structural state fallback.                           |
| `CountryName`                 | `country`                          | GeocodeJSON's normalized country label.                                                       |
| `CountryCode`                 | uppercase `country_code`           | ISO 3166-1 alpha-2 semantic value.                                                            |
| `LocationId`                  | OSM URL from `osm_type` + `osm_id` | A stable, inspectable identifier for the selected feature.                                    |
| `GPSLatitude`, `GPSLongitude` | original photo/query coordinates   | Feature geometry may be a centroid or entrance; it must not replace the camera position.      |

`LocationName` and `WorldRegion` remain unset because GeocodeJSON does not
provide an unambiguous mapping for them. There are no place-specific aliases
or corrections (including no London special case).

The whole `LocationCreated` bag is replaced atomically with one structure.
Omitted members therefore cannot retain stale data from an earlier geocode.
An all-empty civic result is a failure and creates no draft.

## Normalisation contract

`LocationCreated` is repeatable in IPTC Extension. MediaLibrary uses it as the
canonical source only when exactly one structure is present:

- its five overlapping members (`Sublocation`, `City`, `ProvinceState`,
  `CountryName`, `CountryCode`) are projected to the five XMP/IIM pairs;
- a missing member clears both corresponding flat fields;
- GPS and `LocationId` remain only in the structure;
- multiple or malformed structures are left unchanged because selecting one
  would discard meaning.

When `LocationCreated` is absent, the existing XMP-wins conflict policy derives
the five semantic values from the flat pairs, creates one structure containing
only those values, and synchronizes the pairs. This makes the next pass
idempotent.

The cache is version 4 because it stores the structured candidate, including
the OSM identifier. Older projections are discarded rather than mixed with the
new semantics.
