# Reverse Geocoding — Implementation Plan

Add reverse-geocoding to Media Library. GPS coordinates from each image are sent
to OpenStreetMap Nominatim (with Overpass fallback for named POIs) and the
result is written as **draft edits** to industry-standard XMP/IPTC location
tags. Architecture mirrors the AI-description flow; substantial code is shared.

## 1. Target tags (industry-standard, no `mlib:` namespace)

Drafts are proposed for the conventional Lightroom / Photoshop / IPTC location
fields. These are the same fields written by every mainstream tagger
(Lightroom, Bridge, Photo Mechanic, digiKam, ExifTool's `-Country` shortcut).

| Tag                                | Source from Nominatim address                                                     | Notes                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `XMP-iptcCore:Location`            | `building` ∪ `tourism` ∪ `amenity` ∪ `leisure` ∪ `historic` ∪ `shop`, else `road` | "Sub-location" / specific named place. Falls back to road if no named POI. Overpass result, when used, populates this field. |
| `XMP-photoshop:City`               | `city` ∪ `town` ∪ `village` ∪ `hamlet` ∪ `suburb`                                 |                                                                                                                              |
| `XMP-photoshop:State`              | `state`                                                                           |                                                                                                                              |
| `XMP-photoshop:Country`            | `country`                                                                         |                                                                                                                              |
| `XMP-iptcCore:CountryCode`         | `country_code` (uppercased — ISO 3166-1 alpha-2)                                  | App semantic value, e.g. `GB`.                                                                                               |
| `IPTC:Sub-location`                | mirror of `XMP-iptcCore:Location`                                                 | Legacy IPTC IIM mirror.                                                                                                      |
| `IPTC:City`                        | mirror of `XMP-photoshop:City`                                                    |                                                                                                                              |
| `IPTC:Province-State`              | mirror of `XMP-photoshop:State`                                                   |                                                                                                                              |
| `IPTC:Country-PrimaryLocationName` | mirror of `XMP-photoshop:Country`                                                 |                                                                                                                              |
| `IPTC:Country-PrimaryLocationCode` | fixed-width legacy IPTC projection of `XMP-iptcCore:CountryCode`                  | Alpha-2 value right-padded for two-character ASCII codes, e.g. `GB `. This is not alpha-3 conversion.                        |

Rationale for IPTC IIM mirroring: it's the convention enforced by most apps
(IPTC fields are stored in two parallel places — XMP and legacy IIM — and tools
expect them to agree). ExifTool will write both when given the XMP keys, but
making the mirrors explicit drafts means the user sees what's being written and
can opt out per-field. `IPTC:Country-PrimaryLocationCode` is the one
tag-specific exception to byte-for-byte mirroring: the app keeps the country
code semantic value as ISO alpha-2 (`GB`) and writes the legacy IPTC fixed-width
storage projection (`GB `). It does not perform an alpha-2 to alpha-3 lookup.

### Coherent-replacement rule for empty fields

For each successful geocode, the draft set is an **atomic, complete
replacement** of the §1 location-tag group. Every §1 tag gets a draft entry:

- Field has data → set-value draft.
- Field is absent from the geocoder's response → **remove-tag draft**
  (deletes the field on apply, not an empty-string write).

Rationale: if the existing on-disk metadata says
`City=York, State=England, Country=UK` and the new geocode result legitimately
returns only `Country=France` (e.g. corrected GPS), an "omit empty" rule
would leave `City=York` in place — the file would end up claiming York is in
France. Emitting remove-drafts for the absent fields keeps the location group
internally consistent.

A delete-draft is used rather than writing literal empty strings because
downstream tools treat empty-string and absent differently; a clean removal
matches the user's intent ("clear this group, then write the geocoded
values").

**All-empty result** (Nominatim returned nothing usable for any §1 field —
ocean coords, bad GPS, etc.) is treated as a **`nominatim_empty` failure**,
not a success. **No drafts written.** The image surfaces in the
failure list in the done panel. This avoids the surprise behaviour of mass-
clearing a user's manually-curated location tags because the GPS was bogus.

**Code-comment requirement:** the draft composer in
`src-tauri/src/geocode.rs` (`compose_geocode_edits`) and its corresponding
test must carry a comment explaining this rationale — the coherent-replacement
rule and the all-empty-as-failure decision — so a future reader doesn't
"helpfully" switch back to omit-empty without understanding the trade-off.
Same comment summarised in `useGeocodeImages` / dialog confirm-panel copy
near the overwrite-warning wording.

**Existing GPS coords are never modified.** Reverse-geocoding never proposes
GPS rewrites — that is a separate, manual concern.

**Existing user-set values are still draft-overwritten** on confirm — the
overwrite warning (§5) is the user's chance to bail out before that happens.

## 2. GPS source — respect drafts

For each selected image, derive the (lat, lon) used for the Nominatim query
from, in priority order:

1. Draft edits for `GPS:GPSLatitude` / `GPS:GPSLongitude` (or any group
   variant — `XMP-exif:GPSLatitude`, `Composite:GPSLatitude`, …) if present
   in the typed draft store.
2. Otherwise, the loaded image metadata (`Composite:GPSLatitude` /
   `Composite:GPSLongitude`).

If still missing → emit `geocode_progress` with `status: "no_gps"` for that
image and continue. No noisy failure; counted in the final summary.

DMS strings (`51 deg 30' 0.55" N`) and decimal both supported. Parsing logic
ported from `Update Metadata Scripts/geocode_batch.py`.

## 3. Backend: shared "batch image job" abstraction

The describe flow's command shape (start → estimate → confirm → run → done,
with cancel) is reused. The describe code is refactored to extract the generic
loop, and geocode plugs in alongside.

### Refactor

- **New `src-tauri/src/batch_job.rs`.** Defines:
  - `trait BatchJob` with `event_prefix() -> &'static str`,
    `async fn process_one(&self, ctx: &JobCtx, rel: &str) -> Result<Edits, JobError>`.
  - `async fn run_batch_loop<J: BatchJob>(app, folder, rel_paths, cancel_flag, job)`
    — the sequential loop, per-image cancel check, emit `${prefix}_started` /
    `${prefix}_progress` / `${prefix}_complete`, summary aggregation hook.
  - Failure shape `JobError { kind: String, detail: String }` (already
    matches the describe wire format).
- **`src-tauri/src/openai_describe.rs`** keeps the OpenAI-specific bits;
  the loop logic in `lib.rs` collapses to constructing an
  `OpenAIDescribeJob` and calling `run_batch_loop`. Cost estimate stays
  as a separate command (no analogue for geocode).
- **`DescribeState` is renamed `BatchJobCancelState<DescribeMarker>`** —
  or, simpler, mirrored: `DescribeState` and `GeocodeState` stay as distinct
  per-job cancel-flag holders. Two short types is less generic-soup than one
  marker-parameterised type, and the cancellation flags are genuinely
  independent.

The describe loop in `lib.rs` shrinks; the geocode loop is a thin call into
the same shared function. No describe behaviour changes from the user's
perspective.

### Geocode-specific backend

- **`src-tauri/src/geocode.rs`**:
  - `parse_gps(value) -> Option<f64>` — DMS + decimal.
  - `haversine_meters(lat1, lon1, lat2, lon2) -> f64`.
  - `flatten_address(address) -> AddressFields` — typed output (location,
    city, state, country, country_code, postcode) using the precedence
    table from §1.
  - `async fn nominatim_reverse(client, lat, lon) -> Result<NominatimResp, GeocodeError>`.
  - `async fn overpass_named_nearby(client, lat, lon, radius_m) -> Result<Option<OverpassFeature>, GeocodeError>`.
  - `should_use_overpass_fallback(addr: &AddressFields) -> bool` — true
    when `location` is empty or fell back to `road` only, and no named POI
    came back from Nominatim.
  - `async fn geocode_one(client, cache, lat, lon) -> Result<GeocodeResult, GeocodeError>`:
    1. Cache lookup with haversine < 50 m → return cached + mark `source = Cache`.
    2. Nominatim call. 1 req/s rate limiter.
    3. If quality check fails → Overpass call (`[out:json];node(around:30,LAT,LON)[name][~"^(tourism|amenity|historic|leisure|building|shop)$"~"."];out tags;`); take nearest named feature; merge `name` into `location` field; set `source = NominatimPlusOverpass`.
    4. Insert into cache.
  - `compose_geocode_edits(result) -> HashMap<String, MetadataDraftEdit>` — emits
    the tags listed in §1. For every §1 tag: set-value draft if data is
    present, remove-tag draft if not (coherent-replacement rule, see §1).
    Carry a doc-comment summarising the rationale (atomic replacement of
    the location group; prevents drift where stale City=York survives a
    geocode that now returns Country=France only). Type for set-value
    drafts is `text` (strings).
  - **All-empty handling:** caller (`GeocodeJob::process_one`) checks
    whether the parsed address has at least one usable §1 field before
    calling `compose_geocode_edits`. If none, return
    `GeocodeError { kind: "nominatim_empty", … }` so the image surfaces as
    a failure with no drafts written. Doc-comment at the check explaining
    why: bogus GPS or ocean coords would otherwise mass-clear a user's
    manually-curated location tags.
  - `GeocodeSource` enum: `Cache | Nominatim | NominatimPlusOverpass`.
- **`src-tauri/src/geocode_cache.rs`**:
  - JSON-backed cache stored at `<app_data_dir>/geocache.json`.
  - Schema:
    ```json
    {
      "version": 1,
      "entries": [
        {
          "lat": 51.500153,
          "lon": -0.1262361,
          "queried_at": "2026-05-17T12:34:56Z",
          "source": "nominatim",
          "result": {/* AddressFields + display_name */}
        }
      ]
    }
    ```
  - Coords stored at 7-dp precision.
  - Match: haversine < 50 m linear scan (fine up to ~10k entries; revisit
    later if it grows).
  - Save atomically (temp file + rename) after each batch; not after each
    entry.
  - Held in `tauri::State` as `Mutex<GeocodeCache>`.
- **Commands** in `src-tauri/src/lib.rs`:
  - `geocode_images_cmd(folder_path, rel_paths)` — installs cancel flag,
    constructs `GeocodeJob`, calls `run_batch_loop`. Job's `process_one`
    reads GPS (including drafts — front end passes the merged coordinates
    in the rel_paths payload, see below), calls `geocode_one`, returns
    edits.
  - `cancel_geocode_cmd()` — flips the flag.
  - **GPS-with-drafts handoff:** the cleanest way to "respect drafts" is
    to have the front end pass `Vec<{rel_path: String, lat: f64, lon: f64}>`
    rather than just paths. That way the front end (which already owns the
    typed draft store) resolves draft-vs-metadata precedence once, and the
    backend never needs to read the typed-draft JSONL. Images with no GPS
    appear with `lat: null, lon: null` and the backend emits `status: "no_gps"`.
    Wire type: `Vec<GeocodeRequestItem>` where `GeocodeRequestItem = { rel_path, lat: Option<f64>, lon: Option<f64> }`.

## 4. Frontend: shared dialog + hook

### Refactor

- **New `src/hooks/useBatchImageJob.ts`** — generic over estimate payload `E`
  and summary payload `S`. Phases `estimating | awaiting-confirm | running | done`,
  with `estimating` optional (skipped if the supplied config has no estimate
  command). Owns Tauri subs for `${prefix}_*` events.
- **`useDescribeImages`** reduces to a thin wrapper that wires the describe
  estimate/run commands, event prefix `"describe"`, and the describe summary
  shape. Behaviour identical.
- **`useGeocodeImages`** — wrapper supplying prefix `"geocode"`, no
  estimate command (hook jumps straight to `awaiting-confirm` with the data
  the caller passes to `start`), and the geocode summary shape.
- **New `src/components/BatchJobDialog.tsx`** — extracts the chrome from
  `DescribeProgressDialog`. Phase header text, the confirm-panel body, and
  the done-summary body are render-slot props. Estimating panel renders only
  if the hook reports an estimating phase. `RunningProgressPanel` keeps doing
  the running phase (no change there).
- **`DescribeProgressDialog`** becomes a thin wrapper supplying the cost
  panel + describe done summary; existing test selectors preserved with the
  same `testidPrefix`.
- **New `GeocodeProgressDialog`** — wrapper supplying the geocode confirm
  panel and geocode done summary.

### Geocode dialog content

**Awaiting-confirm panel:**

> Ready to reverse-geocode **N images** using OpenStreetMap Nominatim, with
> Overpass fallback for named buildings and POIs.
>
> The **GPS coordinates** of each image will be sent to
> `nominatim.openstreetmap.org` and (when needed)
> `overpass-api.de`. The images themselves are **not** uploaded. There is
> no cost.
>
> The following draft tags will be proposed per image, where data is available:
>
> - `XMP-iptcCore:Location` and `IPTC:Sub-location`
> - `XMP-photoshop:City` and `IPTC:City`
> - `XMP-photoshop:State` and `IPTC:Province-State`
> - `XMP-photoshop:Country` and `IPTC:Country-PrimaryLocationName`
> - `XMP-iptcCore:CountryCode` and fixed-width `IPTC:Country-PrimaryLocationCode`
>
> **Existing GPS values will not be modified.** No file is changed on disk
> until you apply drafts.
>
> _(If any selected images lack GPS:)_ X of N selected images have no GPS
> coordinates and will be skipped.

Buttons: `Cancel` / `Confirm and geocode`.

**Running panel:** reuses `RunningProgressPanel` with `noun="image"`. Footer:
"Each result lands in drafts as soon as it arrives. Cancelling preserves
results already returned."

**Done panel:**

- `Completed: K/N succeeded` (plus red `M failed` if any).
- Explicit summary line:
  `Cache hits: nSucceededFromCache · Nominatim: nSucceededFromNominatim · Nominatim+Overpass: nSucceededFromOverpass · No GPS: nNoGps · Failed: nFailed`.
- `FailureList` with friendly labels:
  - `no_gps` → "No GPS coordinates"
  - `nominatim_empty` → "Nominatim returned no address"
  - `http` → "Network request failed"
  - `network` → "Network error"
  - `cache_io` → "Could not read or write the geocache file"
  - `cancelled` → "Cancelled"
  - default → raw kind
- `Close` button.

### Summary wire shape

```ts
interface GeocodeSummary {
  nSucceededFromNominatim: number;
  nSucceededFromCache: number;
  nSucceededFromOverpass: number; // = "nominatim+overpass" — Overpass alone is not a primary mode
  nNoGps: number;
  nFailed: number;
}
```

Explicit per-source counters as requested. `nSucceededFromOverpass` covers
the combined Nominatim+Overpass path (Overpass is only ever a refinement of a
Nominatim result, never the primary geocoder).

## 5. Overwrite warning — multi-select aware

Mirror the AI-description pattern in both `DetailsPane` and the
`PhotoList` context menu.

**Definition of "already has reverse-geocoding data":** any of the §1 target
keys present in the image's metadata **or** in its draft set
(`typedDraftEdits` ∪ `draftEdits[relPath]`).

### `DetailsPane` (single image)

If image has any §1 key in metadata or drafts:

> This image already has location data. Reverse-geocoding will overwrite all
> location fields with drafts — fields the geocoder doesn't return will be
> cleared. Continue?

Title: `Overwrite location data?`, kind `warning`. Same `ask()` helper as
describe.

### `PhotoList` context menu (multi-select)

Count selected paths that have any §1 key in metadata or drafts. If `existing > 0`:

- **All selected have existing:**
  `All N selected photos already have location data. Reverse-geocoding will overwrite all location fields with drafts — fields the geocoder doesn't return will be cleared. Continue?`
- **Some selected have existing:**
  `X of N selected photos already have location data. Reverse-geocoding will overwrite all location fields with drafts for those photos — fields the geocoder doesn't return will be cleared. Continue?`
- **Single selected with existing:**
  `This photo already has location data. Reverse-geocoding will overwrite all location fields with drafts — fields the geocoder doesn't return will be cleared. Continue?`

Same message shape as the AI-description warning at
`src/components/PhotoList.tsx:846-849`.

### Context menu visibility

`Reverse Geocode…` menu entry is **always visible** when one or more photos
are selected. No GPS-presence filter on the entry — the user runs the
operation and the per-image `no_gps` failures surface in the done panel. This
is simpler and matches user comment.

`DetailsPane` button is always enabled when the panel is showing an image —
clicking with no GPS immediately yields a one-image batch with a single
`no_gps` failure, which is acceptable.

## 6. UI wiring (summary)

- `App.tsx`:
  - `const geocode = useGeocodeImages({ onApplyEdits: setDraftBatch })`.
  - Render `<GeocodeProgressDialog state={geocode.state} … />` when
    `geocode.open`.
  - `onGeocode={(relPaths) => geocode.actions.start(state.folder, buildGeocodeItems(relPaths))}`
    where `buildGeocodeItems` resolves GPS from typed-draft ∪ metadata as
    per §2.
- `PhotoList.tsx`: add `Reverse Geocode… (N photos)` context-menu entry
  next to the AI description entry, with the multi-select overwrite
  confirmation from §5.
- `DetailsPane.tsx`: add `Reverse Geocode…` button next to the AI
  description button, with the single-image overwrite confirmation from §5.
- `GalleryView.tsx`: thread an `onGeocode?: (relPath: string) => void` prop
  down to its embedded `DetailsPane`.

## 7. Rate limiting and concurrency

Sequential loop in `run_batch_loop` (same as describe). Cache hits return
without an HTTP call and without sleeping. Network calls each pass through a
1 req/s token-bucket per host:

- `nominatim.openstreetmap.org` — shared bucket across all requests in the
  loop.
- `overpass-api.de` — separate bucket; Overpass calls only fire when
  fallback triggers.

User-Agent: `MediaLibrary/<crate version> (https://github.com/<owner>/<repo>)`
— Nominatim ToS requires a contact, so a repo URL goes in the UA.

## 8. Cancellation

`GeocodeState` cancel flag mirrors `DescribeState`. Loop checks at each image
boundary, **and** between Nominatim and Overpass sub-calls. `cancel_geocode_cmd`
flips it. Dialog cancel UX mirrors describe:

- In `awaiting-confirm`: close immediately.
- In `running`: button shows "Cancelling…" until `geocode_complete` fires.

## 9. Cache key precision

7-dp lat/lon, 50 m haversine match radius. Two photos taken from opposite
sides of a 40 m building share a cache entry — this is the intended behaviour
inherited from the 2010 script and the user has confirmed it is acceptable.

## 10. Files touched / created

**Refactor (shared abstraction):**

- `src/hooks/useDescribeImages.ts` — reduce to thin wrapper.
- `src/hooks/useBatchImageJob.ts` — new generic hook.
- `src/components/BatchJobDialog.tsx` — new generic dialog.
- `src/components/DescribeProgressDialog.tsx` — thin wrapper over
  `BatchJobDialog`, supplying describe slots.
- `src-tauri/src/batch_job.rs` — new generic loop.
- `src-tauri/src/lib.rs` — describe commands re-implemented over
  `batch_job::run_batch_loop`; register geocode state and cache.

**New (geocode-specific):**

- `src-tauri/src/geocode.rs` — DMS/decimal parse, haversine, Nominatim
  client, Overpass client, address flattener, draft composer, `GeocodeJob`.
- `src-tauri/src/geocode_cache.rs` — JSON cache I/O and haversine lookup.
- `src/hooks/useGeocodeImages.ts` — thin wrapper over `useBatchImageJob`.
- `src/components/GeocodeProgressDialog.tsx` — slots for `BatchJobDialog`.
- `src/types.ts` — `GeocodeProgressState`, `GeocodeFailure`, `GeocodeSummary`,
  `GeocodeRequestItem`.

**Wiring:**

- `src/App.tsx` — hook, dialog, prop plumbing.
- `src/components/DetailsPane.tsx` — button + overwrite warning.
- `src/components/PhotoList.tsx` — context-menu entry + overwrite warning.
- `src/components/GalleryView.tsx` — prop plumbing.

**Tests:**

- `src/test/geocode-flow.test.tsx` — mirror `describe-flow.test.tsx`.
- `src/test/details-pane-geocode.test.tsx` — button visible always;
  single-image overwrite warning fires when any §1 key present in metadata
  or drafts.
- `src/test/photolist-geocode-contextmenu.test.tsx` — context-menu entry
  visible regardless of GPS presence; multi-select overwrite warning
  messages (all / some / single).
- `src-tauri/src/geocode.rs` unit tests — DMS parse, decimal parse,
  haversine accuracy, address flattener precedence, Overpass-fallback
  trigger conditions, cache 50 m radius hit/miss boundary, draft composer
  emits remove-drafts for absent §1 fields (coherent-replacement), all-empty
  geocode response returns `nominatim_empty` failure and writes zero drafts,
  mocked Nominatim 200 / 404 / empty body.
- `src-tauri/src/batch_job.rs` unit tests — generic loop emits expected
  events, honours cancel between items.
