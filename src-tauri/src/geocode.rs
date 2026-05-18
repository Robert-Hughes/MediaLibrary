//! Reverse-geocoding pipeline.
//!
//! Given `(lat, lon)` for a photo, return human-readable address fields
//! by calling OpenStreetMap Nominatim, optionally refining with Overpass
//! when Nominatim's result is generic. The output is composed into a
//! set of draft edits targeting the conventional industry-standard
//! XMP-iptcCore / XMP-photoshop / legacy-IPTC location tags — see
//! `docs/REVERSE_GEOCODE_PLAN.md` §1 for the tag list and rationale.
//!
//! ## Coherent-replacement rule (important!)
//!
//! `compose_geocode_edits` emits a draft entry for **every** target tag
//! every time, not just the ones the geocoder happened to return. Tags
//! with data become Set drafts; tags the geocoder didn't return become
//! Delete drafts. This is deliberate: a partial replace would leave
//! stale fields from a previous run hanging around (e.g. existing
//! `City=York` surviving a new geocode that legitimately resolved to
//! `Country=France` only), so the file would end up internally
//! inconsistent. See `docs/REVERSE_GEOCODE_PLAN.md` §1 "Coherent-
//! replacement rule" for the full discussion.
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

use crate::draft_edits::{DraftEdit, EditIntent};
use crate::geocode_cache::{
    GeocodeCacheEntry, GeocodeCacheFile, CachedResult,
};
use crate::scanner::Variant;

/// Default endpoints — not user-configurable in V1 (see plan §10).
pub const NOMINATIM_BASE_URL: &str = "https://nominatim.openstreetmap.org";
pub const OVERPASS_BASE_URL: &str = "https://overpass-api.de/api/interpreter";

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
// Nominatim's usage policy is "at most one request per second"; Overpass's
// own guidance is the same order of magnitude. The plan §7 calls out
// *separate* per-host buckets so an Overpass call doesn't share its budget
// with the next Nominatim call (and vice versa) — Overpass only fires on
// the fallback path, so coupling the two would burn an unnecessary second
// of latency on every Overpass image even though the next Nominatim call
// is genuinely fresh from Nominatim's perspective.

/// Minimum spacing between consecutive requests to the same host.
pub const RATE_LIMIT_INTERVAL: Duration = Duration::from_millis(1000);

/// Per-host token bucket for the geocode batch loop.
///
/// One instance lives for the duration of a single batch (constructed
/// in `geocode_images_cmd`, dropped at the end). Each host's last-call
/// instant is tracked independently so the Nominatim and Overpass
/// schedules don't bleed into each other.
#[derive(Default)]
pub struct GeocodeRateLimiter {
    last_nominatim: Option<std::time::Instant>,
    last_overpass: Option<std::time::Instant>,
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

    /// Same idea for Overpass — separate bucket from Nominatim.
    pub async fn wait_overpass(&mut self) {
        Self::wait_for(&mut self.last_overpass).await;
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
    let cleaned = trimmed
        .replace("deg", " ")
        .replace('\'', " ")
        .replace('"', " ")
        .replace('°', " ");
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

/// Parsed Nominatim `address` block, narrowed to the fields we map to
/// industry-standard location tags.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AddressFields {
    /// Specific named place (building, POI, road as last resort). Maps
    /// to `XMP-iptcCore:Location` + `IPTC:Sub-location`.
    pub location: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    /// ISO 3166-1 alpha-2, uppercased.
    pub country_code: Option<String>,
    pub postcode: Option<String>,
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
            || self.postcode.is_some()
    }

    /// Build a human-readable display name from the populated fields,
    /// most-specific first.
    pub fn display_name(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for v in [
            self.location.as_deref(),
            self.city.as_deref(),
            self.state.as_deref(),
            self.country.as_deref(),
        ] {
            if let Some(s) = v {
                if !s.is_empty() && !parts.contains(&s) {
                    parts.push(s);
                }
            }
        }
        parts.join(", ")
    }
}

/// Flatten Nominatim's `address` object (a free-form `serde_json::Value`)
/// into our six-field shape, picking the most specific available value
/// for each slot per the precedence table in the plan.
pub fn flatten_address(addr: &serde_json::Value) -> AddressFields {
    // Pick the first non-empty key in priority order. Nominatim's
    // hierarchy varies wildly by place type so we walk a deliberate
    // priority list rather than trusting any single key.
    fn pick<'a>(addr: &'a serde_json::Value, keys: &[&str]) -> Option<String> {
        for k in keys {
            if let Some(s) = addr.get(*k).and_then(|v| v.as_str()) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    }
    let location = pick(
        addr,
        &[
            "building", "tourism", "amenity", "leisure", "historic", "shop",
            "memorial", "man_made",
        ],
    )
    .or_else(|| pick(addr, &["road"]));
    let city = pick(
        addr,
        &["city", "town", "village", "hamlet", "municipality", "suburb"],
    );
    let state = pick(addr, &["state", "region"]);
    let country = pick(addr, &["country"]);
    let country_code = pick(addr, &["country_code"]).map(|c| c.to_ascii_uppercase());
    let postcode = pick(addr, &["postcode"]);
    AddressFields {
        location,
        city,
        state,
        country,
        country_code,
        postcode,
    }
}

/// True when Nominatim's result is too generic to be useful — we got a
/// road or nothing for `location`, and no other named-feature signal.
/// The caller then tries Overpass for a nearby named POI.
pub fn should_use_overpass_fallback(addr: &serde_json::Value, parsed: &AddressFields) -> bool {
    // If any named-feature key was picked up by the flattener, we're
    // already specific enough. Detect that by re-running the same head
    // of the priority list as `flatten_address`.
    let named_keys = [
        "building", "tourism", "amenity", "leisure", "historic", "shop",
        "memorial", "man_made",
    ];
    for k in named_keys {
        if addr.get(k).and_then(|v| v.as_str()).map_or(false, |s| !s.is_empty()) {
            return false;
        }
    }
    // Otherwise we fall back when we have at least a road but no named
    // POI — i.e. the result is just an address on a street. With
    // nothing at all, Overpass is unlikely to help either, so don't
    // burn the call.
    parsed.location.is_some()
}

// ── Source tag for cache/summary ─────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeocodeSource {
    /// Hit the in-memory cache (haversine < 50 m of a prior result).
    Cache,
    /// Live Nominatim call, no Overpass refinement.
    Nominatim,
    /// Live Nominatim + Overpass call (Overpass found a named feature
    /// for the `location` slot).
    NominatimPlusOverpass,
}

impl GeocodeSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            GeocodeSource::Cache => "cache",
            GeocodeSource::Nominatim => "nominatim",
            GeocodeSource::NominatimPlusOverpass => "nominatim+overpass",
        }
    }
}

// ── Draft composer ───────────────────────────────────────────────────────────

/// Build the set of target tag keys that geocoding writes drafts for.
/// Returned in a stable order purely for readability; semantically it's
/// a set.
pub fn geocode_target_tags() -> [&'static str; 10] {
    [
        "XMP-iptcCore:Location",
        "XMP-photoshop:City",
        "XMP-photoshop:State",
        "XMP-photoshop:Country",
        "XMP-iptcCore:CountryCode",
        "IPTC:Sub-location",
        "IPTC:City",
        "IPTC:Province-State",
        "IPTC:Country-PrimaryLocationName",
        "IPTC:Country-PrimaryLocationCode",
    ]
}

/// Compose draft edits for a geocoded image.
///
/// IMPORTANT: emits an entry for **every** target tag — Set when data
/// is present, Delete when not. See file-level doc-comment "Coherent-
/// replacement rule" for why. Callers must NOT call this for an all-
/// empty `AddressFields`: that case is the `nominatim_empty` failure
/// and writes no drafts (see file-level doc-comment "All-empty result
/// is a failure, not a success").
pub fn compose_geocode_edits(
    addr: &AddressFields,
) -> std::collections::HashMap<String, DraftEdit> {
    debug_assert!(
        addr.has_any_usable(),
        "compose_geocode_edits called on an empty address — callers must \
         surface nominatim_empty as a failure instead. See file-level \
         doc-comment."
    );

    fn set_text(s: &str) -> DraftEdit {
        DraftEdit {
            value: Some(Variant::String(s.to_string())),
            intent: EditIntent::Set,
            display: None,
        }
    }
    fn delete_field() -> DraftEdit {
        // Delete-intent on a tag tells the apply pipeline to remove the
        // field rather than write an empty string. Why a remove and not
        // a literal "": downstream tools treat empty string and absent
        // differently, and the user's intent is "this group is now
        // governed by the new geocode" — a clean removal is more
        // honest than smuggling in empty values.
        DraftEdit {
            value: None,
            intent: EditIntent::Delete,
            display: None,
        }
    }

    // Helper that emits one Set/Delete pair across a paired (XMP, IPTC)
    // tag mirror. Keeping them paired in code makes the
    // coherent-replacement intent obvious to a reader and keeps the
    // legacy IIM mirror in lockstep with the XMP source of truth.
    let mut edits = std::collections::HashMap::new();
    let mut put = |xmp: &str, iptc: &str, value: Option<&str>| {
        let (a, b) = match value {
            Some(v) => (set_text(v), set_text(v)),
            None => (delete_field(), delete_field()),
        };
        edits.insert(xmp.to_string(), a);
        edits.insert(iptc.to_string(), b);
    };

    put("XMP-iptcCore:Location", "IPTC:Sub-location", addr.location.as_deref());
    put("XMP-photoshop:City", "IPTC:City", addr.city.as_deref());
    put("XMP-photoshop:State", "IPTC:Province-State", addr.state.as_deref());
    put(
        "XMP-photoshop:Country",
        "IPTC:Country-PrimaryLocationName",
        addr.country.as_deref(),
    );
    put(
        "XMP-iptcCore:CountryCode",
        "IPTC:Country-PrimaryLocationCode",
        addr.country_code.as_deref(),
    );
    edits
}

// ── HTTP client / queries ────────────────────────────────────────────────────

/// Thin reqwest client wrapper preset with our User-Agent.
#[derive(Clone)]
pub struct GeocodeClient {
    pub nominatim_base: String,
    pub overpass_base: String,
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
            overpass_base: OVERPASS_BASE_URL.into(),
            http,
        }
    }

    /// Override base URLs (test-only convenience).
    pub fn with_bases(nominatim_base: String, overpass_base: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(default_user_agent())
            .build()
            .expect("reqwest client construction never fails with default config");
        Self {
            nominatim_base,
            overpass_base,
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
/// each of these as a human string.
#[derive(Debug, Clone)]
pub enum GeocodeError {
    /// The image had no usable GPS in metadata or drafts. Surfaced
    /// separately from network errors because it's expected and
    /// non-noisy.
    NoGps,
    /// Nominatim returned an empty `address` block (ocean, etc.). We
    /// treat this as a failure rather than emitting empty drafts.
    /// See file-level doc-comment.
    NominatimEmpty,
    Http { status: u16, body: String },
    Network(String),
}

impl GeocodeError {
    pub fn kind(&self) -> &'static str {
        match self {
            GeocodeError::NoGps => "no_gps",
            GeocodeError::NominatimEmpty => "nominatim_empty",
            GeocodeError::Http { .. } => "http",
            GeocodeError::Network(_) => "network",
        }
    }
    pub fn detail(&self) -> String {
        match self {
            GeocodeError::NoGps => "no GPS coordinates".into(),
            GeocodeError::NominatimEmpty => "Nominatim returned no usable address".into(),
            GeocodeError::Http { status, body } => format!("HTTP {}: {}", status, body),
            GeocodeError::Network(s) => s.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GeocodeResult {
    pub address: AddressFields,
    pub display_name: String,
    pub source: GeocodeSource,
    pub query_lat: f64,
    pub query_lon: f64,
}

/// Call Nominatim `/reverse` once. Returns the raw `address` JSON
/// object (not the parsed AddressFields — caller flattens, so it can
/// also pass the raw addr into `should_use_overpass_fallback`).
pub async fn nominatim_reverse(
    client: &GeocodeClient,
    lat: f64,
    lon: f64,
) -> Result<serde_json::Value, GeocodeError> {
    let url = format!(
        "{}/reverse?format=json&lat={}&lon={}&zoom=18&addressdetails=1",
        client.nominatim_base, lat, lon
    );
    let resp = client
        .http
        .get(&url)
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
    Ok(json.get("address").cloned().unwrap_or(serde_json::Value::Null))
}

/// Call Overpass for the nearest named feature within 30 m. Returns
/// the feature's `name` tag (and a hint at its type, for cache
/// inspection) on success, or `Ok(None)` if there's no useful feature.
pub async fn overpass_named_nearby(
    client: &GeocodeClient,
    lat: f64,
    lon: f64,
) -> Result<Option<String>, GeocodeError> {
    // Overpass QL: nodes within 30 m carrying any of the named-feature
    // tags, requiring `name` to be set. We sort client-side by raw
    // distance off the returned `lat/lon`.
    let ql = format!(
        "[out:json][timeout:25];\
         (node(around:30,{lat},{lon})[name][~\"^(tourism|amenity|historic|leisure|building|shop|memorial)$\"~\".\"];);\
         out tags center;",
        lat = lat,
        lon = lon,
    );
    let resp = client
        .http
        .post(&client.overpass_base)
        .header("content-type", "text/plain")
        .body(ql)
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
        GeocodeError::Network(format!("overpass bad JSON: {} (body: {})", e, text))
    })?;
    let elements = json.get("elements").and_then(|v| v.as_array());
    let elements = match elements {
        Some(e) => e,
        None => return Ok(None),
    };
    // Pick nearest by haversine to the original query coordinates.
    use crate::geocode_cache::haversine_meters;
    let mut best: Option<(f64, String)> = None;
    for el in elements {
        let elat = el.get("lat").and_then(|v| v.as_f64());
        let elon = el.get("lon").and_then(|v| v.as_f64());
        let name = el
            .get("tags")
            .and_then(|t| t.get("name"))
            .and_then(|v| v.as_str());
        if let (Some(elat), Some(elon), Some(name)) = (elat, elon, name) {
            let d = haversine_meters(lat, lon, elat, elon);
            if best.as_ref().map(|(b, _)| d < *b).unwrap_or(true) {
                best = Some((d, name.to_string()));
            }
        }
    }
    Ok(best.map(|(_, n)| n))
}

/// Cache → Nominatim → optional Overpass. Owns the per-host rate-limit
/// sleeps so the caller doesn't have to predict whether the Overpass
/// path will fire. The rate limiter is borrowed `&mut` so a single
/// instance per batch keeps state across calls.
pub async fn geocode_one(
    client: &GeocodeClient,
    cache: &mut GeocodeCacheFile,
    limiter: &mut GeocodeRateLimiter,
    lat: f64,
    lon: f64,
) -> Result<GeocodeResult, GeocodeError> {
    // Cache hit short-circuits all network calls — no rate-limit spend.
    if let Some(entry) = cache.lookup(lat, lon) {
        let r = entry.result.clone();
        return Ok(GeocodeResult {
            address: AddressFields {
                location: r.location,
                city: r.city,
                state: r.state,
                country: r.country,
                country_code: r.country_code,
                postcode: r.postcode,
            },
            display_name: r.display_name,
            source: GeocodeSource::Cache,
            query_lat: lat,
            query_lon: lon,
        });
    }

    limiter.wait_nominatim().await;
    let raw_addr = nominatim_reverse(client, lat, lon).await?;
    let mut parsed = flatten_address(&raw_addr);
    let mut source = GeocodeSource::Nominatim;

    // Overpass refinement for generic Nominatim results. Separate
    // bucket — see GeocodeRateLimiter doc-comment.
    if should_use_overpass_fallback(&raw_addr, &parsed) {
        limiter.wait_overpass().await;
        if let Ok(Some(name)) = overpass_named_nearby(client, lat, lon).await {
            parsed.location = Some(name);
            source = GeocodeSource::NominatimPlusOverpass;
        }
    }

    if !parsed.has_any_usable() {
        return Err(GeocodeError::NominatimEmpty);
    }

    let display_name = parsed.display_name();
    let entry = GeocodeCacheEntry {
        lat,
        lon,
        queried_at: chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        source: source.as_str().into(),
        result: CachedResult {
            display_name: display_name.clone(),
            location: parsed.location.clone(),
            city: parsed.city.clone(),
            state: parsed.state.clone(),
            country: parsed.country.clone(),
            country_code: parsed.country_code.clone(),
            postcode: parsed.postcode.clone(),
        },
    };
    cache.upsert(entry);

    Ok(GeocodeResult {
        address: parsed,
        display_name,
        source,
        query_lat: lat,
        query_lon: lon,
    })
}

// ── Cancellation flag ───────────────────────────────────────────────────────

/// Geocode-specific cancellation state. Aliased to the shared
/// `BatchJobCancelState` (same install/clear/signal pattern as
/// DescribeState) — but a distinct Tauri-managed instance so
/// cancelling a geocode batch does not affect a parallel describe
/// batch, and vice versa.
pub type GeocodeState = crate::batch_job::BatchJobCancelState;

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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
    fn flatten_address_prefers_named_feature_over_road() {
        let addr = serde_json::json!({
            "tourism": "Tower of London",
            "road": "Tower Hill",
            "city": "London",
            "country": "United Kingdom",
            "country_code": "gb"
        });
        let f = flatten_address(&addr);
        assert_eq!(f.location.as_deref(), Some("Tower of London"));
        assert_eq!(f.country_code.as_deref(), Some("GB"));
    }

    #[test]
    fn flatten_address_falls_back_to_road_when_no_named_feature() {
        let addr = serde_json::json!({
            "road": "Oakdale Road",
            "city": "York",
            "country": "United Kingdom",
            "country_code": "gb"
        });
        let f = flatten_address(&addr);
        assert_eq!(f.location.as_deref(), Some("Oakdale Road"));
        assert_eq!(f.city.as_deref(), Some("York"));
    }

    #[test]
    fn should_use_overpass_fallback_when_only_road_is_known() {
        let addr = serde_json::json!({
            "road": "Some Street",
            "city": "City"
        });
        let parsed = flatten_address(&addr);
        assert!(should_use_overpass_fallback(&addr, &parsed));
    }

    #[test]
    fn should_skip_overpass_when_named_feature_already_present() {
        let addr = serde_json::json!({
            "tourism": "X Museum",
            "road": "Y Road"
        });
        let parsed = flatten_address(&addr);
        assert!(!should_use_overpass_fallback(&addr, &parsed));
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
    fn compose_geocode_edits_writes_set_drafts_for_present_fields() {
        let addr = AddressFields {
            location: Some("Tower of London".into()),
            city: Some("London".into()),
            state: None,
            country: Some("United Kingdom".into()),
            country_code: Some("GB".into()),
            postcode: None,
        };
        let edits = compose_geocode_edits(&addr);
        // Every target tag appears.
        for k in geocode_target_tags() {
            assert!(edits.contains_key(k), "missing {}", k);
        }
        // Present field → Set.
        match &edits["XMP-iptcCore:Location"].intent {
            EditIntent::Set => {}
            other => panic!("expected Set, got {:?}", other),
        }
        match &edits["XMP-iptcCore:Location"].value {
            Some(Variant::String(s)) => assert_eq!(s, "Tower of London"),
            other => panic!("expected String, got {:?}", other),
        }
        // IPTC mirror agrees with XMP source of truth.
        match &edits["IPTC:Sub-location"].value {
            Some(Variant::String(s)) => assert_eq!(s, "Tower of London"),
            other => panic!("expected String, got {:?}", other),
        }
    }

    #[test]
    fn compose_geocode_edits_writes_delete_drafts_for_absent_fields() {
        // The coherent-replacement rule: absent fields produce
        // Delete-intent drafts, not omissions. This test pins that
        // behaviour because the alternative ("omit empty") leaves
        // stale fields from earlier runs in place.
        let addr = AddressFields {
            country: Some("X".into()),
            ..AddressFields::default()
        };
        let edits = compose_geocode_edits(&addr);
        for k in ["XMP-iptcCore:Location", "XMP-photoshop:City", "XMP-photoshop:State"] {
            assert!(edits.contains_key(k), "missing {}", k);
            assert!(
                matches!(edits[k].intent, EditIntent::Delete),
                "expected Delete intent for {}, got {:?}",
                k,
                edits[k].intent
            );
            assert!(edits[k].value.is_none(), "Delete should carry no value");
        }
        // And the IPTC mirrors get the same treatment.
        for k in ["IPTC:Sub-location", "IPTC:City", "IPTC:Province-State"] {
            assert!(
                matches!(edits[k].intent, EditIntent::Delete),
                "expected Delete intent for {}",
                k
            );
        }
    }

    #[tokio::test]
    async fn nominatim_reverse_parses_address_block() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "display_name": "Tower Hill, London",
            "address": {
                "tourism": "Tower of London",
                "city": "London",
                "country": "United Kingdom",
                "country_code": "gb"
            }
        });
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = GeocodeClient::with_bases(server.uri(), "http://unused".into());
        let raw = nominatim_reverse(&client, 51.5, -0.07).await.unwrap();
        let parsed = flatten_address(&raw);
        assert_eq!(parsed.location.as_deref(), Some("Tower of London"));
        assert_eq!(parsed.country_code.as_deref(), Some("GB"));
    }

    #[tokio::test]
    async fn geocode_one_returns_nominatim_empty_when_address_block_yields_nothing() {
        // An ocean coord — Nominatim sometimes returns an `address`
        // object with only metadata keys like `iso3166-2-lvl4` and no
        // civic context. Our flattener produces an empty AddressFields,
        // which the caller must surface as a failure (not write empty
        // drafts!) so the user's existing tags aren't mass-cleared.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/reverse"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "address": {}
            })))
            .mount(&server)
            .await;
        let client = GeocodeClient::with_bases(server.uri(), "http://unused".into());
        let mut cache = GeocodeCacheFile::default_v1();
        let mut limiter = GeocodeRateLimiter::new();
        match geocode_one(&client, &mut cache, &mut limiter, 0.0, 0.0).await {
            Err(GeocodeError::NominatimEmpty) => {}
            other => panic!("expected NominatimEmpty, got {:?}", other),
        }
        assert!(cache.entries.is_empty(), "must not cache empty results");
    }

    #[tokio::test]
    async fn geocode_one_uses_cache_when_within_radius() {
        // No mock server needed — if the cache hit short-circuits, no
        // network call happens. Set the cache up with a result for a
        // London-ish coord, then ask for one ~20 m away.
        let mut cache = GeocodeCacheFile::default_v1();
        cache.upsert(GeocodeCacheEntry {
            lat: 51.5001,
            lon: -0.1262,
            queried_at: "2026-01-01T00:00:00Z".into(),
            source: "nominatim".into(),
            result: CachedResult {
                display_name: "Westminster, London".into(),
                location: Some("Big Ben".into()),
                city: Some("London".into()),
                state: None,
                country: Some("United Kingdom".into()),
                country_code: Some("GB".into()),
                postcode: None,
            },
        });
        // Bogus URL — must NOT be hit.
        let client = GeocodeClient::with_bases(
            "http://127.0.0.1:1".into(),
            "http://127.0.0.1:1".into(),
        );
        let mut limiter = GeocodeRateLimiter::new();
        let result = geocode_one(&client, &mut cache, &mut limiter, 51.5002, -0.1262)
            .await
            .unwrap();
        assert_eq!(result.source, GeocodeSource::Cache);
        assert_eq!(result.address.location.as_deref(), Some("Big Ben"));
    }

    #[tokio::test]
    async fn rate_limiter_spaces_consecutive_calls_per_host() {
        // Two properties to pin: each bucket enforces RATE_LIMIT_INTERVAL
        // between its own consecutive calls, AND the two buckets are
        // independent — calls on one don't consume the other's budget.
        // Tolerance is generous because Windows timer resolution is
        // ~15 ms and CI runners can be even noisier.
        let tolerance = std::time::Duration::from_millis(50);
        let mut limiter = GeocodeRateLimiter::new();

        // Property 1: first call on each bucket is free (no prior stamp).
        let t = std::time::Instant::now();
        limiter.wait_nominatim().await;
        assert!(
            t.elapsed() < tolerance,
            "first nominatim call should not sleep, got {:?}",
            t.elapsed()
        );

        // Property 2: second call on the same bucket waits the interval.
        let t = std::time::Instant::now();
        limiter.wait_nominatim().await;
        let nominatim_gap = t.elapsed();
        assert!(
            nominatim_gap >= RATE_LIMIT_INTERVAL - tolerance,
            "nominatim bucket should enforce interval, got {:?}",
            nominatim_gap
        );

        // Property 3: the FIRST overpass call must NOT wait, even though
        // two Nominatim calls already happened. This is the key
        // independence assertion — a shared bucket would force this
        // call to sleep too.
        let t = std::time::Instant::now();
        limiter.wait_overpass().await;
        assert!(
            t.elapsed() < tolerance,
            "first overpass call must be independent of nominatim budget, got {:?}",
            t.elapsed()
        );

        // Property 4: second overpass call waits its own interval.
        let t = std::time::Instant::now();
        limiter.wait_overpass().await;
        let overpass_gap = t.elapsed();
        assert!(
            overpass_gap >= RATE_LIMIT_INTERVAL - tolerance,
            "overpass bucket should enforce interval, got {:?}",
            overpass_gap
        );
    }
}
