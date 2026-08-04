//! Reverse-geocoding pipeline.
//!
//! Given `(lat, lon)` for a file, call OpenStreetMap Nominatim's
//! GeocodeJSON and JSONv2 endpoints and preserve both exact response bodies
//! in `XMP-mlib`. Normalize Metadata later interprets that evidence into the
//! canonical IPTC Extension `LocationCreated` structure.
//!
//! ## Coherent-replacement rule (important!)
//!
//! `compose_geocode_edits` replaces both evidence fields together. It never
//! writes `LocationCreated` or the ten legacy location mirrors.
//!
//! ## All-empty result is a failure, not a success
//!
//! If Nominatim returns nothing usable across the §1 tag group (ocean
//! coords, bad GPS, an over-zoomed point with no civic context), the
//! caller treats it as a `nominatim_empty` failure and writes **no**
//! drafts. The reason is the same as above in reverse: silently
//! returning "success with empty drafts" would mass-clear the user's
//! carefully curated existing location tags whenever the GPS happened
//! to be bogus.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::country_code::xmp_country_code_projection;
use crate::draft_edits::{EditIntent, MetadataDraftEdit, SchemaMetadataEditMap};
use crate::geocode_cache::{CachedResult, GeocodeCacheEntry, GeocodeCacheFile};
use crate::metadata_value::MetadataValue;
use crate::{known_ids, tag_schema::SchemaDefinitionId};

// ── Wire types for the geocode_files_cmd Tauri command ─────────────────────
//
// Lives here (not lib.rs) so the batch runner can reference them
// without a circular dependency. Public so integration tests can
// build inputs.

/// One item in a `geocode_files_cmd` invocation.
///
/// The frontend resolves draft-GPS-vs-metadata-GPS precedence (see
/// plan §2) before sending; the backend trusts the lat/lon it
/// receives and emits `no_gps` per-item failures for missing pairs.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeocodeRequestItem {
    pub rel_path: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

/// Per-job summary for the `geocode_complete` event. Explicit
/// per-source counters as documented in the plan (§4); the frontend
/// renders the breakdown so the user sees what came from cache vs.
/// the network.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeocodeSummary {
    pub n_succeeded_from_nominatim: u32,
    pub n_succeeded_from_cache: u32,
    pub n_no_gps: u32,
    pub n_failed: u32,
}

/// Default endpoints — not user-configurable in V1 (see plan §10).
pub const NOMINATIM_BASE_URL: &str = "https://nominatim.openstreetmap.org";
pub const NOMINATIM_REVERSE_ZOOMS: &[u8] = &[18, 16, 14, 12, 10];
pub const NOMINATIM_ACCEPT_LANGUAGE: &str = "en-GB,en;q=0.9";

/// Required by Nominatim's usage policy. Bundles the crate version so
/// it's clear which build is hitting the server during a debugging
/// session, and the repo URL from Cargo.toml so the contact link
/// resolves to a real maintained project rather than a placeholder.
pub fn default_user_agent() -> String {
    format!(
        "MediaLibrary/{} ({})",
        env!("CARGO_PKG_VERSION"),
        env!("CARGO_PKG_REPOSITORY"),
    )
}

// ── Rate limiting ───────────────────────────────────────────────────────────
//
// Nominatim's usage policy is "at most one request per second".

/// Minimum spacing between consecutive requests to the same host.
pub const RATE_LIMIT_INTERVAL: Duration = Duration::from_millis(1000);

/// Nominatim token bucket for the geocode batch loop.
///
/// One instance lives for the duration of a single batch (constructed
/// in `geocode_files_cmd`, dropped at the end). Each host's last-call
#[derive(Default)]
pub struct GeocodeRateLimiter {
    last_nominatim: Option<std::time::Instant>,
}

impl GeocodeRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sleep, if necessary, so the next Nominatim call is at least
    /// `RATE_LIMIT_INTERVAL` after the previous one. Stamps the new
    /// `last_nominatim` to "now" after waking so the caller doesn't
    /// need to remember to update it.
    pub async fn wait_nominatim(&mut self) {
        Self::wait_for(&mut self.last_nominatim).await;
    }

    async fn wait_for(slot: &mut Option<std::time::Instant>) {
        if let Some(prev) = *slot {
            let elapsed = prev.elapsed();
            if elapsed < RATE_LIMIT_INTERVAL {
                tokio::time::sleep(RATE_LIMIT_INTERVAL - elapsed).await;
            }
        }
        *slot = Some(std::time::Instant::now());
    }
}

// ── GPS parsing ──────────────────────────────────────────────────────────────

/// Parse a GPS coordinate from either a decimal string ("51.500153") or
/// the ExifTool DMS form (`"51 deg 30' 0.55\" N"`). Returns `None` for
/// anything we can't make sense of — the caller emits `no_gps`.
pub fn parse_gps(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if let Ok(n) = trimmed.parse::<f64>() {
        return Some(n);
    }
    // DMS form. Strip the unit decorations the way the Python reference
    // script does, then split on whitespace.
    let cleaned = trimmed.replace("deg", " ").replace(['\'', '"', '°'], " ");
    let parts: Vec<&str> = cleaned.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let deg: f64 = parts[0].parse().ok()?;
    let min: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    let r = parts[3].to_ascii_uppercase();
    let mag = deg + min / 60.0 + sec / 3600.0;
    Some(if r == "S" || r == "W" { -mag } else { mag })
}

// ── Address shape ────────────────────────────────────────────────────────────

/// GeocodeJSON's normalized location hierarchy for the selected feature.
///
/// These are the schema-defined GeocodeJSON properties we need for the
/// existing five semantic location fields plus the context that explains
/// them. Keeping this typed avoids returning to the former free-form
/// Nominatim `address` key precedence.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GeocodeJsonAddress {
    #[serde(rename = "type")]
    pub result_type: Option<String>,
    pub osm_key: Option<String>,
    pub osm_type: Option<String>,
    pub osm_id: Option<u64>,
    pub name: Option<String>,
    pub street: Option<String>,
    pub locality: Option<String>,
    pub district: Option<String>,
    pub city: Option<String>,
    pub county: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    #[serde(default)]
    pub admin: std::collections::BTreeMap<String, String>,
}

/// GeocodeJSON narrowed to the IPTC LocationCreated members we can map
/// without guessing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AddressFields {
    /// Specific named place (building, POI, road as last resort).
    pub location: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    /// ISO 3166-1 alpha-2, uppercased.
    pub country_code: Option<String>,
    pub location_id: Option<String>,
    /// Original photo coordinates. Nominatim feature geometry may point at a
    /// centroid or entrance, so it must not replace the camera position.
    pub gps_latitude: f64,
    pub gps_longitude: f64,
}

impl AddressFields {
    /// True when at least one §1-relevant field carries a value. Used to
    /// detect the "Nominatim returned nothing usable" failure mode.
    pub fn has_any_usable(&self) -> bool {
        self.location.is_some()
            || self.city.is_some()
            || self.state.is_some()
            || self.country.is_some()
            || self.country_code.is_some()
    }

    /// Build a human-readable display name from the populated fields,
    /// most-specific first.
    pub fn display_name(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for s in [
            self.location.as_deref(),
            self.city.as_deref(),
            self.state.as_deref(),
            self.country.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if !s.is_empty() && !parts.contains(&s) {
                parts.push(s);
            }
        }
        parts.join(", ")
    }
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.as_ref().filter(|value| !value.is_empty()).cloned()
}

/// Project GeocodeJSON into the LocationCreated members that also have
/// legacy XMP/IIM projections.
///
/// The intentionally small mapping is evidence-backed and place-agnostic:
/// `name ?? street`, `city`, `state ?? admin.level4`, `country`, and the
/// uppercased country code. We do not promote locality/district/county into
/// City and do not normalize individual place names (for example London),
/// because those operations change meaning rather than response shape. See
/// `docs/REVERSE_GEOCODE_MAPPING.md`.
pub fn map_geocodejson(addr: &GeocodeJsonAddress, lat: f64, lon: f64) -> AddressFields {
    let location = non_empty(&addr.name).or_else(|| non_empty(&addr.street));
    let city = non_empty(&addr.city);
    let state = non_empty(&addr.state).or_else(|| {
        addr.admin
            .get("level4")
            .filter(|value| !value.is_empty())
            .cloned()
    });
    let country = non_empty(&addr.country);
    let country_code = non_empty(&addr.country_code).map(|code| xmp_country_code_projection(&code));
    let location_id = match (non_empty(&addr.osm_type), addr.osm_id) {
        (Some(osm_type), Some(osm_id)) => Some(format!(
            "https://www.openstreetmap.org/{}/{}",
            osm_type.to_ascii_lowercase(),
            osm_id
        )),
        _ => None,
    };
    AddressFields {
        location,
        city,
        state,
        country,
        country_code,
        location_id,
        gps_latitude: lat,
        gps_longitude: lon,
    }
}

// ── Source tag for cache/summary ─────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeocodeSource {
    /// Hit the in-memory cache (haversine < 50 m of a prior result).
    Cache,
    /// Live Nominatim call.
    Nominatim,
}

impl GeocodeSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            GeocodeSource::Cache => "cache",
            GeocodeSource::Nominatim => "nominatim",
        }
    }
}

// ── Draft composer ───────────────────────────────────────────────────────────

/// Build the set of target tag keys that geocoding writes drafts for.
/// Returned in a stable order purely for readability; semantically it's
/// a set.
pub fn geocode_target_tags() -> [SchemaDefinitionId; 2] {
    [
        known_ids::mlib_reverse_geocode_geocode_json(),
        known_ids::mlib_reverse_geocode_json_v2(),
    ]
}

/// Compose the two raw-evidence drafts for a geocoded file.
pub fn compose_geocode_edits(geocode_json: &str, json_v2: &str) -> SchemaMetadataEditMap {
    let mut edits = SchemaMetadataEditMap::new();
    edits.insert(
        known_ids::mlib_reverse_geocode_geocode_json(),
        MetadataDraftEdit {
            value: Some(MetadataValue::Text(geocode_json.to_string())),
            intent: EditIntent::Set,
        },
    );
    edits.insert(
        known_ids::mlib_reverse_geocode_json_v2(),
        MetadataDraftEdit {
            value: Some(MetadataValue::Text(json_v2.to_string())),
            intent: EditIntent::Set,
        },
    );
    edits
}

// ── HTTP client / queries ────────────────────────────────────────────────────

/// Thin reqwest client wrapper preset with our User-Agent.
#[derive(Clone)]
pub struct GeocodeClient {
    pub nominatim_base: String,
    pub http: reqwest::Client,
}

impl GeocodeClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(default_user_agent())
            .build()
            .expect("reqwest client construction never fails with default config");
        Self {
            nominatim_base: NOMINATIM_BASE_URL.into(),
            http,
        }
    }

    /// Override the base URL (test-only convenience).
    pub fn with_base(nominatim_base: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(default_user_agent())
            .build()
            .expect("reqwest client construction never fails with default config");
        Self {
            nominatim_base,
            http,
        }
    }
}

impl Default for GeocodeClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Geocode failure kinds. The frontend's friendly-label map renders
/// each of these as a human string — keep the `kind()` strings in
/// sync with `friendlyFailureLabel` in
/// `src/components/GeocodeProgressDialog.tsx`.
#[derive(Debug, Clone)]
pub enum GeocodeError {
    /// The file had no usable GPS in metadata or drafts. Surfaced
    /// separately from network errors because it's expected and
    /// non-noisy.
    NoGps,
    /// Nominatim returned an empty `address` block (ocean, etc.). We
    /// treat this as a failure rather than emitting empty drafts.
    /// See file-level doc-comment.
    NominatimEmpty {
        detail: String,
    },
    Http {
        status: u16,
        body: String,
    },
    Network(String),
    /// The cancellation flag was observed flipped while this file was
    /// in flight (between sub-calls, or right before a network call).
    /// Plan §8: the in-flight file surfaces as a `cancelled` failure
    /// rather than disappearing silently when the loop breaks.
    Cancelled,
    /// Cache file could not be read or written. Currently emitted only
    /// from the batch-end save path; surfaced as a synthetic
    /// per-batch failure row so the user knows their cache won't
    /// survive a restart.
    CacheIo(String),
}

impl GeocodeError {
    pub fn kind(&self) -> crate::batch_job::BatchFailureKind {
        use crate::batch_job::BatchFailureKind as K;
        match self {
            GeocodeError::NoGps => K::NoGps,
            GeocodeError::NominatimEmpty { .. } => K::NominatimEmpty,
            GeocodeError::Http { .. } => K::Http,
            GeocodeError::Network(_) => K::Network,
            GeocodeError::Cancelled => K::Cancelled,
            GeocodeError::CacheIo(_) => K::CacheIo,
        }
    }
    pub fn detail(&self) -> String {
        match self {
            GeocodeError::NoGps => "no GPS coordinates".into(),
            GeocodeError::NominatimEmpty { detail } => detail.clone(),
            GeocodeError::Http { status, body } => format!("HTTP {}: {}", status, body),
            GeocodeError::Network(s) => s.clone(),
            GeocodeError::Cancelled => "cancelled by user".into(),
            GeocodeError::CacheIo(s) => s.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GeocodeResult {
    pub geocode_json: String,
    pub json_v2: String,
    pub display_name: String,
    pub source: GeocodeSource,
    pub query_lat: f64,
    pub query_lon: f64,
}

#[derive(Debug, Clone)]
pub struct NominatimReverseResponse {
    pub zoom: u8,
    pub address: GeocodeJsonAddress,
    pub preview: String,
    pub raw_body: String,
}

#[derive(Debug, Deserialize)]
struct GeocodeJsonEnvelope {
    #[serde(default)]
    features: Vec<GeocodeJsonFeature>,
}

#[derive(Debug, Deserialize)]
struct GeocodeJsonFeature {
    properties: GeocodeJsonProperties,
}

#[derive(Debug, Deserialize)]
struct GeocodeJsonProperties {
    geocoding: GeocodeJsonAddress,
}

fn truncate_for_log(value: &str, max_chars: usize) -> String {
    let mut out: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

fn nominatim_response_preview(json: &serde_json::Value) -> String {
    let error = json
        .get("error")
        .and_then(|v| v.as_str())
        .map(|s| truncate_for_log(s, 120));
    let geocoding = json.pointer("/features/0/properties/geocoding");
    let geocoding_keys = geocoding
        .and_then(|v| v.as_object())
        .map(|obj| {
            let mut keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
            keys.sort_unstable();
            keys.join(",")
        })
        .unwrap_or_default();
    let raw = serde_json::to_string(json)
        .map(|s| truncate_for_log(&s, 240))
        .unwrap_or_else(|_| "<unserializable>".into());
    format!(
        "error={} geocoding={} geocoding_keys=[{}] raw={}",
        error
            .as_ref()
            .map(|s| format!("true({})", s))
            .unwrap_or_else(|| "false".into()),
        geocoding.is_some(),
        geocoding_keys,
        raw
    )
}

/// Call Nominatim `/reverse` once at the requested zoom. Returns the
/// normalized GeocodeJSON location plus a compact response preview.
pub async fn nominatim_reverse(
    client: &GeocodeClient,
    lat: f64,
    lon: f64,
    zoom: u8,
) -> Result<NominatimReverseResponse, GeocodeError> {
    let url = format!(
        "{}/reverse?format=geocodejson&lat={:.7}&lon={:.7}&zoom={}&addressdetails=1",
        client.nominatim_base, lat, lon, zoom
    );
    let resp = client
        .http
        .get(&url)
        .query(&[("accept-language", NOMINATIM_ACCEPT_LANGUAGE)])
        .send()
        .await
        .map_err(|e| GeocodeError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(GeocodeError::Http {
            status: status.as_u16(),
            body: text,
        });
    }
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        GeocodeError::Network(format!("nominatim bad JSON: {} (body: {})", e, text))
    })?;
    let preview = nominatim_response_preview(&json);
    let envelope: GeocodeJsonEnvelope = serde_json::from_value(json).map_err(|e| {
        GeocodeError::Network(format!(
            "nominatim bad GeocodeJSON shape: {} (body: {})",
            e, text
        ))
    })?;
    Ok(NominatimReverseResponse {
        zoom,
        address: envelope
            .features
            .into_iter()
            .next()
            .map(|feature| feature.properties.geocoding)
            .unwrap_or_default(),
        preview,
        raw_body: text,
    })
}

/// Fetch the companion JSONv2 response for the zoom selected by the
/// GeocodeJSON fallback loop. The response body is deliberately not mapped:
/// it is durable evidence for the Normalize AI step.
pub async fn nominatim_reverse_jsonv2(
    client: &GeocodeClient,
    lat: f64,
    lon: f64,
    zoom: u8,
) -> Result<String, GeocodeError> {
    let url = format!(
        "{}/reverse?format=jsonv2&lat={:.7}&lon={:.7}&zoom={}&addressdetails=1",
        client.nominatim_base, lat, lon, zoom
    );
    let resp = client
        .http
        .get(&url)
        .query(&[("accept-language", NOMINATIM_ACCEPT_LANGUAGE)])
        .send()
        .await
        .map_err(|e| GeocodeError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(GeocodeError::Http {
            status: status.as_u16(),
            body: text,
        });
    }
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| {
        GeocodeError::Network(format!("nominatim bad JSONv2 JSON: {} (body: {})", e, text))
    })?;
    Ok(text)
}

/// Cache → Nominatim. The rate limiter is borrowed `&mut` so a single
/// instance per batch keeps state across calls.
///
/// `cancel_flag` is polled before every potentially-slow step
/// (rate-limit sleep and network call) so a user pressing Cancel surfaces as a
/// `Cancelled` failure for the in-flight file rather than waiting
/// for the next image boundary. Plan §8.
pub async fn geocode_one(
    client: &GeocodeClient,
    cache: &mut GeocodeCacheFile,
    limiter: &mut GeocodeRateLimiter,
    cancel_flag: &std::sync::atomic::AtomicBool,
    lat: f64,
    lon: f64,
) -> Result<GeocodeResult, GeocodeError> {
    use std::sync::atomic::Ordering;
    let cancelled = || cancel_flag.load(Ordering::Relaxed);

    // Cache hit short-circuits all network calls — no rate-limit spend.
    if let Some(entry) = cache.lookup(lat, lon) {
        let r = entry.result.clone();
        return Ok(GeocodeResult {
            geocode_json: r.geocode_json,
            json_v2: r.json_v2,
            display_name: r.display_name,
            source: GeocodeSource::Cache,
            query_lat: lat,
            query_lon: lon,
        });
    }

    let mut selected: Option<(AddressFields, u8, String)> = None;
    let mut empty_previews: Vec<String> = Vec::new();
    for zoom in NOMINATIM_REVERSE_ZOOMS {
        if cancelled() {
            return Err(GeocodeError::Cancelled);
        }
        limiter.wait_nominatim().await;
        // The sleep itself can run for ~1 s — re-check after waking so a
        // cancel issued during the sleep doesn't waste a network call.
        if cancelled() {
            return Err(GeocodeError::Cancelled);
        }
        let response = nominatim_reverse(client, lat, lon, *zoom).await?;
        let parsed = map_geocodejson(&response.address, lat, lon);
        if parsed.has_any_usable() {
            selected = Some((parsed, response.zoom, response.raw_body));
            break;
        }
        log::warn!(
            "[geocode] nominatim unusable lat={:.6} lon={:.6} zoom={} preview={}",
            lat,
            lon,
            response.zoom,
            response.preview
        );
        empty_previews.push(format!("zoom {}: {}", response.zoom, response.preview));
    }

    let (parsed, selected_zoom, geocode_json) = match selected {
        Some(result) => result,
        None => {
            let zooms = NOMINATIM_REVERSE_ZOOMS
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(",");
            return Err(GeocodeError::NominatimEmpty {
                detail: format!(
                    "Nominatim returned no usable address for lat={:.6} lon={:.6}; no usable address at zooms {}; previews: {}",
                    lat,
                    lon,
                    zooms,
                    empty_previews.join(" | ")
                ),
            });
        }
    };
    let source = GeocodeSource::Nominatim;
    log::info!(
        "[geocode] nominatim usable lat={:.6} lon={:.6} zoom={}",
        lat,
        lon,
        selected_zoom
    );

    if cancelled() {
        return Err(GeocodeError::Cancelled);
    }
    limiter.wait_nominatim().await;
    if cancelled() {
        return Err(GeocodeError::Cancelled);
    }
    let json_v2 = nominatim_reverse_jsonv2(client, lat, lon, selected_zoom).await?;

    let display_name = parsed.display_name();
    let entry = GeocodeCacheEntry {
        lat,
        lon,
        queried_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        source: source.as_str().into(),
        result: CachedResult {
            display_name: display_name.clone(),
            geocode_json: geocode_json.clone(),
            json_v2: json_v2.clone(),
        },
    };
    cache.upsert(entry);

    Ok(GeocodeResult {
        geocode_json,
        json_v2,
        display_name,
        source,
        query_lat: lat,
        query_lon: lon,
    })
}

// ── Cancellation flag ───────────────────────────────────────────────────────

/// Geocode-specific cancellation state.
///
/// Newtype around `BatchJobCancelState` rather than an alias: Tauri
/// keys its `State<T>` registry by `TypeId`, so two distinct alias
/// names for the same struct would collide at startup. A newtype gives
/// each batch job its own `TypeId` while keeping the shared lifecycle
/// code.
#[derive(Default)]
pub struct GeocodeState(crate::batch_job::BatchJobCancelState);

impl GeocodeState {
    pub fn install(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.0.install()
    }
    pub fn clear(&self) {
        self.0.clear();
    }
    pub fn signal_cancel(&self) -> bool {
        self.0.signal_cancel()
    }
}

// ── Batch runner ────────────────────────────────────────────────────────────
//
// The reverse-geocoding command in `lib.rs` is mostly Tauri wiring
// (AppHandle, State, app_data_dir) wrapped around a pure async loop:
// for each item, decide GPS, call `geocode_one`, emit progress, build
// a per-batch summary. The Tauri half is unreachable from integration
// tests; the loop half is exactly where the plan deviations we care
// about live (mid-pipeline cancel surfacing as a per-file
// `cancelled` failure row, end-of-batch `cache_io` synthesis, summary
// accounting). Extracting the loop into `run_geocode_batch` lets us
// drive it from a `tests/` integration test with a wiremock server
// and a recording sink, without needing a Tauri runtime.

/// Sink for events the batch runner emits during a run.
///
/// Production wires this to a `BatchProgressEmitter` (which forwards
/// to Tauri events). Tests implement it as an in-memory accumulator
/// so they can assert exactly which events the runner produced.
///
/// The trait deliberately mirrors `BatchProgressEmitter`'s three
/// methods so a future migration to a fully-shared sink layer is a
/// straight rename rather than a redesign.
pub trait GeocodeEventSink {
    fn started(&self, total: usize);
    fn progress(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&SchemaMetadataEditMap>,
    );
    fn complete(
        &self,
        succeeded: &[String],
        failed: &[crate::batch_job::BatchFailureRow],
        summary: &GeocodeSummary,
    );
}

/// Outcome of a single batch run. Returned from `run_geocode_batch`
/// so the Tauri command can clear cancel state and log the result,
/// and so tests can assert on the final counts without relying on
/// the sink's recorded events alone.
pub struct GeocodeBatchOutcome {
    pub succeeded: Vec<String>,
    pub failed: Vec<crate::batch_job::BatchFailureRow>,
    pub summary: GeocodeSummary,
}

/// Run the reverse-geocoding batch loop.
///
/// Sequential per-item loop with per-host rate limiting (see
/// `GeocodeRateLimiter`). Cache hits skip both buckets and the
/// network entirely. Failures (no-GPS, network, Nominatim-empty,
/// mid-pipeline cancellation) become per-file entries in the
/// returned `failed` vec and are mirrored to the sink via
/// `progress(..., status, ...)`. The cancel flag is polled at the
/// top of every iteration **and** between sub-calls inside
/// `geocode_one`; mid-file cancel surfaces as a `Cancelled` failure
/// for the in-flight file so it shows up in the done panel rather
/// than the loop breaking silently.
///
/// `save_cache` is invoked once after the loop drains. Failures
/// there become a synthetic `cache_io` failure row attached to a
/// sentinel `<geocache>` relative path so the user sees a labelled
/// entry in the done panel; per-file drafts already emitted are not
/// affected because the typed-draft store is independent of the
/// network cache.
pub async fn run_geocode_batch<S, F>(
    items: &[GeocodeRequestItem],
    client: &GeocodeClient,
    cache: &mut GeocodeCacheFile,
    cancel_flag: &std::sync::atomic::AtomicBool,
    sink: &S,
    save_cache: F,
) -> GeocodeBatchOutcome
where
    S: GeocodeEventSink + ?Sized,
    F: FnOnce(&GeocodeCacheFile) -> Result<(), String>,
{
    use std::sync::atomic::Ordering;
    let total = items.len();
    sink.started(total);

    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<crate::batch_job::BatchFailureRow> = Vec::new();
    let mut summary = GeocodeSummary::default();
    let mut current = 0usize;
    let mut limiter = GeocodeRateLimiter::new();

    for item in items {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }
        current += 1;
        let rel = item.rel_path.clone();

        let (lat, lon) = match (item.lat, item.lon) {
            (Some(lat), Some(lon)) => (lat, lon),
            _ => {
                sink.progress(
                    current,
                    total,
                    &rel,
                    crate::batch_job::BatchFailureKind::NoGps.as_wire(),
                    Some("no GPS coordinates"),
                    None,
                );
                failed.push(crate::batch_job::BatchFailureRow {
                    relative_path: rel,
                    kind: crate::batch_job::BatchFailureKind::NoGps,
                    detail: "no GPS coordinates".into(),
                });
                summary.n_no_gps += 1;
                continue;
            }
        };

        log::info!(
            "[geocode] ({}/{}) resolving {} lat={:.6} lon={:.6}",
            current,
            total,
            rel,
            lat,
            lon
        );

        match geocode_one(client, cache, &mut limiter, cancel_flag, lat, lon).await {
            Ok(result) => {
                let edits = compose_geocode_edits(&result.geocode_json, &result.json_v2);
                log::info!(
                    "[geocode] ({}/{}) ok {} source={} display={}",
                    current,
                    total,
                    rel,
                    result.source.as_str(),
                    result.display_name
                );
                sink.progress(current, total, &rel, "ok", None, Some(&edits));
                succeeded.push(rel);
                match result.source {
                    GeocodeSource::Cache => summary.n_succeeded_from_cache += 1,
                    GeocodeSource::Nominatim => summary.n_succeeded_from_nominatim += 1,
                }
            }
            Err(e) => {
                let kind = e.kind();
                let detail = e.detail();
                log::warn!(
                    "[geocode] ({}/{}) failed {} kind={} detail={}",
                    current,
                    total,
                    rel,
                    kind,
                    detail
                );
                sink.progress(current, total, &rel, kind.as_wire(), Some(&detail), None);
                failed.push(crate::batch_job::BatchFailureRow {
                    relative_path: rel,
                    kind,
                    detail,
                });
                summary.n_failed += 1;
            }
        }
    }

    if let Err(e) = save_cache(cache) {
        log::warn!("[geocode] cache save failed: {}", e);
        failed.push(crate::batch_job::BatchFailureRow {
            relative_path: "<geocache>".into(),
            kind: crate::batch_job::BatchFailureKind::CacheIo,
            detail: e,
        });
        summary.n_failed += 1;
    }

    sink.complete(&succeeded, &failed, &summary);

    GeocodeBatchOutcome {
        succeeded,
        failed,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn geocodejson_body(geocoding: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "features": [{
                "properties": {
                    "geocoding": geocoding
                }
            }]
        })
    }

    #[test]
    fn parse_gps_decimal_round_trip() {
        assert_eq!(parse_gps("51.5"), Some(51.5));
        assert_eq!(parse_gps("-0.126"), Some(-0.126));
    }

    #[test]
    fn parse_gps_dms_north_and_south() {
        // 51 deg 30' 0.55" N → 51 + 30/60 + 0.55/3600 = 51.50015277…
        let n = parse_gps("51 deg 30' 0.55\" N").unwrap();
        assert!((n - 51.500152_77).abs() < 1e-6, "got {}", n);
        let s = parse_gps("33 deg 51' 30\" S").unwrap();
        assert!(s < 0.0);
        assert!((s + 33.858_333).abs() < 1e-4, "got {}", s);
    }

    #[test]
    fn parse_gps_dms_west_is_negative() {
        let w = parse_gps("0 deg 7' 34.49\" W").unwrap();
        assert!(w < 0.0);
    }

    #[test]
    fn parse_gps_returns_none_for_garbage() {
        assert!(parse_gps("").is_none());
        assert!(parse_gps("not a coord").is_none());
        assert!(parse_gps("51 deg").is_none());
    }

    #[test]
    fn map_geocodejson_prefers_name_over_street() {
        let addr = GeocodeJsonAddress {
            name: Some("Tower of London".into()),
            street: Some("Tower Hill".into()),
            city: Some("London".into()),
            country: Some("United Kingdom".into()),
            country_code: Some("gb".into()),
            ..Default::default()
        };
        let f = map_geocodejson(&addr, 51.5, -0.07);
        assert_eq!(f.location.as_deref(), Some("Tower of London"));
        assert_eq!(f.country_code.as_deref(), Some("GB"));
    }

    #[test]
    fn map_geocodejson_falls_back_to_street() {
        let addr = GeocodeJsonAddress {
            street: Some("Oakdale Road".into()),
            city: Some("York".into()),
            country: Some("United Kingdom".into()),
            country_code: Some("gb".into()),
            ..Default::default()
        };
        let f = map_geocodejson(&addr, 53.9, -1.1);
        assert_eq!(f.location.as_deref(), Some("Oakdale Road"));
        assert_eq!(f.city.as_deref(), Some("York"));
    }

    #[test]
    fn map_geocodejson_uses_admin_level4_when_state_is_absent() {
        let addr = GeocodeJsonAddress {
            city: Some("Tokyo".into()),
            country: Some("Japan".into()),
            admin: std::collections::BTreeMap::from([("level4".into(), "Tokyo".into())]),
            ..Default::default()
        };
        let parsed = map_geocodejson(&addr, 35.6, 139.7);
        assert_eq!(parsed.city.as_deref(), Some("Tokyo"));
        assert_eq!(parsed.state.as_deref(), Some("Tokyo"));
    }

    #[test]
    fn map_geocodejson_does_not_promote_district_or_locality_to_city() {
        let addr = GeocodeJsonAddress {
            locality: Some("Takanawa 4".into()),
            district: Some("Minato".into()),
            ..Default::default()
        };
        let parsed = map_geocodejson(&addr, 35.6, 139.7);
        assert_eq!(parsed.city, None);
    }

    #[test]
    fn has_any_usable_detects_empty_address() {
        let empty = AddressFields::default();
        assert!(!empty.has_any_usable());
        let one = AddressFields {
            country: Some("X".into()),
            ..AddressFields::default()
        };
        assert!(one.has_any_usable());
    }

    #[test]
    fn compose_geocode_edits_writes_both_raw_responses_verbatim() {
        let geocode_json = "{\n  \"features\": []\n}";
        let json_v2 = "{\"display_name\":\"Tower of London\"}";
        let edits = compose_geocode_edits(geocode_json, json_v2);
        assert_eq!(edits.len(), 2);
        assert_eq!(
            edits[&known_ids::mlib_reverse_geocode_geocode_json()].value,
            Some(MetadataValue::Text(geocode_json.into()))
        );
        assert_eq!(
            edits[&known_ids::mlib_reverse_geocode_json_v2()].value,
            Some(MetadataValue::Text(json_v2.into()))
        );
        assert!(edits
            .values()
            .all(|edit| matches!(edit.intent, EditIntent::Set)));
    }

    #[test]
    fn geocode_targets_only_the_two_evidence_fields() {
        assert_eq!(
            geocode_target_tags(),
            [
                known_ids::mlib_reverse_geocode_geocode_json(),
                known_ids::mlib_reverse_geocode_json_v2(),
            ]
        );
    }

    #[test]
    fn map_geocodejson_preserves_query_coordinates_and_osm_id() {
        let addr = GeocodeJsonAddress {
            osm_type: Some("node".into()),
            osm_id: Some(42),
            country: Some("Japan".into()),
            ..Default::default()
        };
        let parsed = map_geocodejson(&addr, 35.62857, 139.7367);
        assert_eq!(parsed.gps_latitude, 35.62857);
        assert_eq!(parsed.gps_longitude, 139.7367);
        assert_eq!(
            parsed.location_id.as_deref(),
            Some("https://www.openstreetmap.org/node/42")
        );
    }

    #[tokio::test]
    async fn nominatim_reverse_parses_geocodejson_feature() {
        let server = MockServer::start().await;
        let body = geocodejson_body(serde_json::json!({
            "type": "house",
            "osm_key": "tourism",
            "name": "Tower of London",
            "city": "London",
            "country": "United Kingdom",
            "country_code": "gb"
        }));
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .and(query_param("format", "geocodejson"))
            .and(query_param("accept-language", NOMINATIM_ACCEPT_LANGUAGE))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = GeocodeClient::with_base(server.uri());
        let raw = nominatim_reverse(&client, 51.5, -0.07, 18).await.unwrap();
        let parsed = map_geocodejson(&raw.address, 51.5, -0.07);
        assert_eq!(parsed.location.as_deref(), Some("Tower of London"));
        assert_eq!(parsed.country_code.as_deref(), Some("GB"));
    }

    #[tokio::test]
    async fn nominatim_reverse_jsonv2_preserves_exact_body() {
        let server = MockServer::start().await;
        let body = "{\n  \"display_name\": \"Ely\",\n  \"address\": {\"country_code\":\"gb\"}\n}";
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .and(query_param("format", "jsonv2"))
            .and(query_param("zoom", "16"))
            .and(query_param("accept-language", NOMINATIM_ACCEPT_LANGUAGE))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/json"))
            .mount(&server)
            .await;

        let client = GeocodeClient::with_base(server.uri());
        let raw = nominatim_reverse_jsonv2(&client, 52.4, 0.26, 16)
            .await
            .unwrap();
        assert_eq!(raw, body);
    }

    #[tokio::test]
    async fn geocode_one_returns_nominatim_empty_when_geocodejson_yields_nothing() {
        // An ocean coord may return no feature. The empty normalized
        // location must surface as a failure (not write empty drafts!)
        // so the user's existing tags aren't mass-cleared.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "features": []
            })))
            .mount(&server)
            .await;
        let client = GeocodeClient::with_base(server.uri());
        let mut cache = GeocodeCacheFile::empty_current();
        let mut limiter = GeocodeRateLimiter::new();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        match geocode_one(&client, &mut cache, &mut limiter, &cancel, 0.0, 0.0).await {
            Err(GeocodeError::NominatimEmpty { detail }) => {
                assert!(detail.contains("lat=0.000000"), "detail={}", detail);
                assert!(detail.contains("lon=0.000000"), "detail={}", detail);
                assert!(detail.contains("zooms 18,16,14,12,10"), "detail={}", detail);
            }
            other => panic!("expected NominatimEmpty, got {:?}", other),
        }
        assert!(cache.entries.is_empty(), "must not cache empty results");
    }

    #[tokio::test]
    async fn geocode_one_falls_back_to_lower_zoom_when_zoom_18_is_unusable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .and(query_param("zoom", "18"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "Unable to geocode"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .and(query_param("zoom", "16"))
            .respond_with(ResponseTemplate::new(200).set_body_json(geocodejson_body(
                serde_json::json!({
                    "city": "York",
                    "country": "United Kingdom",
                    "country_code": "gb"
                }),
            )))
            .mount(&server)
            .await;

        let client = GeocodeClient::with_base(server.uri());
        let mut cache = GeocodeCacheFile::empty_current();
        let mut limiter = GeocodeRateLimiter::new();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let result = geocode_one(
            &client,
            &mut cache,
            &mut limiter,
            &cancel,
            53.983856,
            -1.100918,
        )
        .await
        .unwrap();

        assert_eq!(result.source, GeocodeSource::Nominatim);
        assert!(result.geocode_json.contains("York"));
        assert!(!result.json_v2.is_empty());
        assert_eq!(cache.entries.len(), 1);
        assert!((cache.entries[0].lat - 53.983856).abs() < 1e-6);
        assert!((cache.entries[0].lon + 1.100918).abs() < 1e-6);
    }

    #[tokio::test]
    async fn geocode_one_sends_original_signed_longitude_to_nominatim() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .and(query_param("lat", "53.9838560"))
            .and(query_param("lon", "-1.1009180"))
            .and(query_param("zoom", "18"))
            .respond_with(ResponseTemplate::new(200).set_body_json(geocodejson_body(
                serde_json::json!({
                    "city": "York",
                    "country": "United Kingdom",
                    "country_code": "gb"
                }),
            )))
            .mount(&server)
            .await;

        let client = GeocodeClient::with_base(server.uri());
        let mut cache = GeocodeCacheFile::empty_current();
        let mut limiter = GeocodeRateLimiter::new();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let result = geocode_one(
            &client,
            &mut cache,
            &mut limiter,
            &cancel,
            53.983856,
            -1.100918,
        )
        .await
        .unwrap();

        assert!(result.geocode_json.contains("York"));
    }

    #[tokio::test]
    async fn geocode_one_uses_cache_when_within_radius() {
        // No mock server needed — if the cache hit short-circuits, no
        // network call happens. Set the cache up with a result for a
        // London-ish coord, then ask for one ~20 m away.
        let mut cache = GeocodeCacheFile::empty_current();
        cache.upsert(GeocodeCacheEntry {
            lat: 51.5001,
            lon: -0.1262,
            queried_at: "2026-01-01T00:00:00Z".into(),
            source: "nominatim".into(),
            result: CachedResult {
                display_name: "Westminster, London".into(),
                geocode_json: r#"{"features":[{"properties":{"geocoding":{"name":"Big Ben"}}}]}"#
                    .into(),
                json_v2: r#"{"display_name":"Big Ben, London"}"#.into(),
            },
        });
        // Bogus URL — must NOT be hit.
        let client = GeocodeClient::with_base("http://127.0.0.1:1".into());
        let mut limiter = GeocodeRateLimiter::new();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let result = geocode_one(&client, &mut cache, &mut limiter, &cancel, 51.5002, -0.1262)
            .await
            .unwrap();
        assert_eq!(result.source, GeocodeSource::Cache);
        assert!(result.geocode_json.contains("Big Ben"));
    }

    #[tokio::test]
    async fn geocode_one_returns_cancelled_when_flag_flips_before_nominatim() {
        // Plan §8: cancel between sub-calls must surface as a per-file
        // Cancelled failure rather than the loop breaking silently.
        // Easiest mid-file cancel to verify: flag already true on
        // entry, cache miss, so the very first cancel check fires
        // before any network call. No mock server needed — if we
        // reached the network we'd hit "http://unused".
        let client = GeocodeClient::with_base("http://unused".into());
        let mut cache = GeocodeCacheFile::empty_current();
        let mut limiter = GeocodeRateLimiter::new();
        let cancel = std::sync::atomic::AtomicBool::new(true);
        match geocode_one(&client, &mut cache, &mut limiter, &cancel, 1.0, 2.0).await {
            Err(GeocodeError::Cancelled) => {}
            other => panic!("expected Cancelled, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn rate_limiter_spaces_consecutive_calls_per_host() {
        // Consecutive Nominatim calls enforce RATE_LIMIT_INTERVAL.
        // Tolerance is generous because Windows timer resolution is
        // ~15 ms and CI runners can be even noisier.
        let tolerance = std::time::Duration::from_millis(50);
        let mut limiter = GeocodeRateLimiter::new();

        // First call is free (no prior stamp).
        let t = std::time::Instant::now();
        limiter.wait_nominatim().await;
        assert!(
            t.elapsed() < tolerance,
            "first nominatim call should not sleep, got {:?}",
            t.elapsed()
        );

        // Second call waits the interval.
        let t = std::time::Instant::now();
        limiter.wait_nominatim().await;
        let nominatim_gap = t.elapsed();
        assert!(
            nominatim_gap >= RATE_LIMIT_INTERVAL - tolerance,
            "nominatim bucket should enforce interval, got {:?}",
            nominatim_gap
        );
    }
}
