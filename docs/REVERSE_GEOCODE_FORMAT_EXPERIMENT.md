# Reverse-Geocode Format Experiment

This experiment compares Nominatim `geocodejson` with `jsonv2` for the same
20 photo coordinates. It was run on 2026-07-26 at zoom 18 with the
`en-GB,en;q=0.9` language preference.

The previously discussed 20-photo filename list was not retained as an
artifact, so this is a reconstructed, reproducible sample. It covers every
year from 2007 through 2015 that contains GPS-tagged JPEGs, with varied
coordinates where possible. The three JPEGs in the 2007 folder have no GPS.
The sample explicitly includes every photo investigated as problematic in the
session:

- `2012/IMAG0391.jpg` — structured ExifTool write failure;
- `2013/IMG_0817.jpg` — John Lewis versus Winged Figure;
- `2014/IMG_1087.jpg` — Ely versus East Cambridgeshire;
- `2015/IMG_1213.jpg` — Japanese names and Minato/Tokyo.

## Method

For each file, the experiment read the embedded XMP and IIM location fields
with ExifTool, then made two rate-limited calls to the public Nominatim reverse
endpoint:

1. `format=geocodejson`, mapped with the current MediaLibrary rules;
2. `format=jsonv2`, mapped with this conservative candidate:
   - Sublocation: top-level selected feature `name`, else `address.road`;
   - City: `address.city`, then `town`, `village`, or `hamlet`;
   - Province/State: `address.state`, then `province` or `region`;
   - Country and code: `address.country` and uppercase `country_code`.

Every response recorded `x-nominatim-server` and the selected OSM type/ID.
Although load balancing sent paired calls to various origins, both formats
selected the same OSM object in all 20 cases. The observed differences below
are therefore formatter/mapping differences, not different reverse selections.

## Results

The table shows the embedded XMP values before staging and the relevant
candidate fields. Blank means absent.

| Year | File                  | Embedded Sublocation                           | Embedded City  | Selected Sublocation                           | GeocodeJSON City    | GeocodeJSON District | JSONv2 City candidate |
| ---: | --------------------- | ---------------------------------------------- | -------------- | ---------------------------------------------- | ------------------- | -------------------- | --------------------- |
| 2008 | `SDC13584.jpg`        | Emmanuel College                               | Cambridge      | Saint Andrew's Street                          | Cambridge           | Petersfield          | Cambridge             |
| 2008 | `IMG_7459.jpg`        | Oakdale Road                                   | York           | Oakdale Road                                   | York                | Clifton Without      | York                  |
| 2010 | `Image0804.jpg`       | Fairfield                                      | Derbyshire     | Broadwalk                                      | High Peak           | Fairfield            | High Peak             |
| 2010 | `Image0926.jpg`       | Petersfield                                    | Cambridgeshire | Trumpington Street                             | Cambridge           | Petersfield          | Cambridge             |
| 2011 | `Image0963.jpg`       | B6160                                          | Bolton Abbey   | B6160                                          | Bolton Abbey        |                      | Bolton Abbey          |
| 2011 | `Image0970.jpg`       | Duncan Road                                    | Sheffield      | Duncan Road                                    | Sheffield           | Crookes              | Sheffield             |
| 2012 | `IMAG0379.jpg`        |                                                |                | Westfield Stratford City                       | Greater London      | Stratford            | Greater London        |
| 2012 | `IMAG0391.jpg`        | Student Recruitment, Marketing, and Admissions | Sheffield      | Student Recruitment, Marketing, and Admissions | Sheffield           | Netherthorpe         | Sheffield             |
| 2012 | `IMAG0405.jpg`        | B1257                                          | Chop Gate      | B1257                                          | Chop Gate           | Bilsdale Midcable    | Chop Gate             |
| 2013 | `IMG_0817.jpg`        | John Lewis                                     | Greater London | Winged Figure                                  | Greater London      | Mayfair              | City of Westminster   |
| 2013 | `IMG_0651.jpg`        | North Marine Promenade                         | Bridlington    | North Marine Promenade                         | Bridlington         | Old Town             | Bridlington           |
| 2013 | `f47348112.jpg`       | A57                                            | Bassetlaw      | A57                                            | Bassetlaw           | Worksop              | Bassetlaw             |
| 2014 | `IMG_1087.jpg`        | Ely Cathedral                                  | Ely            | Ely Cathedral                                  | East Cambridgeshire | Ely                  | Ely                   |
| 2014 | `IMG_1054.jpg`        | Coble Landing                                  | Filey          | Coble Landing                                  | Filey               | The Pastures         | Filey                 |
| 2014 | `IMG_1124.jpg`        | IWM Duxford                                    | Cambridge      | IWM Duxford                                    | Cambridge           | Duxford              | Cambridge             |
| 2015 | `IMG_1213.jpg`        |                                                |                | Seria                                          | Tokyo               | Minato               | Minato                |
| 2015 | `IMG_1215_stitch.jpg` |                                                |                | Osaka Shiyakusho-nai Post Office               | Osaka               | Kita Ward            | Osaka                 |
| 2015 | `IMG_1267.jpg`        |                                                |                | Fukuoka Airport                                | Fukuoka             | Hakata Ward          | Fukuoka               |
| 2015 | `IMG_1283.jpg`        |                                                |                | Narita International Airport                   | Narita              |                      | Narita                |
| 2015 | `IMG_1322.jpg`        |                                                |                | HMS Wellington                                 | Greater London      | Covent Garden        | City of London        |

Aggregate comparison:

| Comparison                      |                Result |
| ------------------------------- | --------------------: |
| Same selected OSM object        |                 20/20 |
| Same mapped Sublocation         |                 20/20 |
| Same mapped City                |                 16/20 |
| Same mapped Province/State      |                 19/20 |
| Same mapped Country             |                 20/20 |
| Same mapped country code        |                 20/20 |
| Non-empty embedded City matched | 11/14 for each format |

The embedded-match count is descriptive, not a correctness score: some
embedded values were themselves produced by older geocoding behavior.

## The four City differences

### `IMG_1087.jpg`: JSONv2 is more useful

GeocodeJSON flattens the address hierarchy to:

- `district = Ely`
- `city = East Cambridgeshire`

JSONv2 preserves Nominatim's OSM-aware label `city = Ely`. This agrees with
ordinary meaning and the IPTC City field; East Cambridgeshire is a local
government district.

### `IMG_1213.jpg`: GeocodeJSON is more useful

GeocodeJSON returns:

- `district = Minato`
- `city = Tokyo`
- `state = Tokyo`

JSONv2 returns `city = Minato`, no state/province name, and only the
administrative code `JP-13`. For this metadata model, GeocodeJSON produces the
more recognizable City and a usable Province/State.

### `IMG_0817.jpg`: neither format fixes the POI

Both formats selected the same `Winged Figure` OSM node, so changing output
format cannot restore John Lewis. They differ only in City:

- GeocodeJSON: `Greater London`
- JSONv2: `City of Westminster`

This is independent of the origin-server reverse-selection inconsistency
documented in [REVERSE_GEOCODE_PLAN.md](REVERSE_GEOCODE_PLAN.md).

### `IMG_1322.jpg`: different levels of London

Both formats selected HMS Wellington:

- GeocodeJSON: `Greater London`
- JSONv2: `City of London`

This is another hierarchy-policy difference rather than a different result
object.

## Other mapping findings

Using JSONv2's top-level selected-feature `name` is important. The former
MediaLibrary whitelist of address keys would regress four sample
Sublocations:

- `IMAG0391.jpg`: the office name would become Western Bank;
- `IMG_1267.jpg`: Fukuoka Airport would become the Japanese road name;
- `IMG_1283.jpg`: Narita International Airport would be lost;
- `IMG_1322.jpg`: HMS Wellington would become Victoria Embankment.

The candidate JSONv2 Province/State mapping must include `province`, not just
`state` and `region`. That recovers Osaka, Fukuoka, and Chiba Prefectures.
Tokyo remains absent by name in JSONv2; it supplies only `JP-13`. GeocodeJSON
supplies `state = Tokyo`.

JSONv2 may expose several settlement-like fields at once. Examples include:

- `Image0804.jpg`: `city = High Peak`, `town = Buxton`,
  `suburb = Fairfield`;
- `f47348112.jpg`: `city = Bassetlaw`, `town = Worksop`,
  `suburb = Manton`;
- `IMG_1124.jpg`: `city = Cambridge`, `village = Duxford`.

Consequently, even the apparently conservative
`city ?? town ?? village ?? hamlet` rule is a policy choice. It preserves the
larger address City when present; preferring the most specific settlement
would instead produce Buxton, Worksop, and Duxford.

## Interpretation

The sample does not support a simple claim that JSONv2 is better than
GeocodeJSON:

- JSONv2 fixes Ely and exposes useful OSM-oriented settlement labels;
- GeocodeJSON gives the more useful Tokyo/Minato hierarchy and more complete
  Japanese Province/State names;
- both formats agree on most rows;
- neither format addresses origin-specific selection of the wrong nearby POI.

This evidence led to the evidence-first design: Reverse Geocode now stores
both exact response bodies rather than choosing either formatter's hierarchy.
When `LocationCreated` is absent, Normalize Metadata asks a configurable
text-only model to interpret the two responses using explicit IPTC field
definitions. The app still supplies coordinates, OSM identifiers, country-code
agreement, and legacy projection deterministically. This retains the
complementary evidence without adding country- or place-specific mapping
rules.
