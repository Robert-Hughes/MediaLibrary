//! Persistent app-wide reverse-geocoding cache.
//!
//! Reverse-geocoding hits a public Nominatim endpoint that is rate-limited
//! to 1 request per second. A typical photo library has photos clustered
//! around a handful of common locations (home, workplace, regular travel
//! destinations), so most batches resolve to a small number of unique
//! coordinates. Caching turns a 5-minute batch into a few seconds for the
//! second run.
//!
//! Storage: a single JSON file at `<app_data_dir>/geocache.json`. The
//! format is intentionally human-readable so the user can inspect or
//! prune it by hand. The full file is rewritten atomically after a batch
//! finishes; per-entry append-on-write would be cheaper but a batch is
//! typically <100 net network calls so the simple approach is fine.
//!
//! Lookup: linear scan with haversine distance < 50 m. The 50 m threshold
//! is inherited from the original `Update Metadata Scripts/geocode_batch.py`
//! and was chosen because Nominatim returns the *feature's* coordinates,
//! not the query's — two photos taken from a few metres apart at the same
//! venue should share a cache entry.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Haversine match radius for cache hits, in metres. See module doc.
pub const CACHE_MATCH_RADIUS_M: f64 = 50.0;

/// File name under app_data_dir.
pub const CACHE_FILE_NAME: &str = "geocache.json";

/// Versioned JSON cache file.
///
/// `version` lets us evolve the schema later (e.g. add a TTL field)
/// without silently mis-reading old caches. A future load that sees an
/// unknown version starts from empty and overwrites on next save.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GeocodeCacheFile {
    pub version: u32,
    pub entries: Vec<GeocodeCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeocodeCacheEntry {
    pub lat: f64,
    pub lon: f64,
    pub queried_at: String,
    pub source: String,
    pub result: CachedResult,
}

/// The cached portion of a `GeocodeResult` — everything except the
/// query coordinates (which live on the enclosing entry).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedResult {
    pub display_name: String,
    pub location: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub postcode: Option<String>,
}

pub const CACHE_VERSION: u32 = 1;

/// Compute great-circle distance between two coordinate pairs, in metres.
///
/// Earth radius 6_371_000 m matches the Python reference script and
/// the typical Nominatim documentation example; the choice is within
/// the noise floor for a 50 m match radius.
pub fn haversine_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let (lat1r, lat2r) = (lat1 * to_rad, lat2 * to_rad);
    let dlat = (lat2 - lat1) * to_rad;
    let dlon = (lon2 - lon1) * to_rad;
    let a = (dlat / 2.0).sin().powi(2)
        + lat1r.cos() * lat2r.cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();
    6_371_000.0 * c
}

pub fn cache_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CACHE_FILE_NAME)
}

/// Load the cache from disk. Returns `Ok(empty)` for "file missing" or
/// "unknown version" so a corrupt/old cache never blocks a batch — the
/// worst case is one cold pass that repopulates it.
pub fn load(app_data_dir: &Path) -> GeocodeCacheFile {
    let path = cache_path(app_data_dir);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return GeocodeCacheFile::default_v1(),
    };
    match serde_json::from_slice::<GeocodeCacheFile>(&bytes) {
        Ok(f) if f.version == CACHE_VERSION => f,
        _ => GeocodeCacheFile::default_v1(),
    }
}

impl GeocodeCacheFile {
    pub fn default_v1() -> Self {
        Self {
            version: CACHE_VERSION,
            entries: Vec::new(),
        }
    }

    /// Look up the first cache entry within `CACHE_MATCH_RADIUS_M` of
    /// `(lat, lon)`. Linear scan — fine up to a few thousand entries.
    pub fn lookup(&self, lat: f64, lon: f64) -> Option<&GeocodeCacheEntry> {
        self.entries
            .iter()
            .find(|e| haversine_meters(lat, lon, e.lat, e.lon) < CACHE_MATCH_RADIUS_M)
    }

    pub fn upsert(&mut self, entry: GeocodeCacheEntry) {
        // Drop any prior near-match so the new entry replaces it
        // rather than accumulating duplicates from repeat geocoding.
        self.entries
            .retain(|e| haversine_meters(entry.lat, entry.lon, e.lat, e.lon) >= CACHE_MATCH_RADIUS_M);
        self.entries.push(entry);
    }
}

/// Persist the cache atomically: write to a temp file in the same
/// directory, then rename over the destination. A crash mid-write
/// leaves the previous good copy in place.
pub fn save(app_data_dir: &Path, file: &GeocodeCacheFile) -> Result<(), String> {
    fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("create app_data_dir: {}", e))?;
    let dest = cache_path(app_data_dir);
    let tmp = dest.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(file)
        .map_err(|e| format!("serialize geocache: {}", e))?;
    fs::write(&tmp, &json).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &dest)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), dest.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haversine_zero_distance_is_zero() {
        let d = haversine_meters(51.5, -0.12, 51.5, -0.12);
        assert!(d.abs() < 1e-6, "got {}", d);
    }

    #[test]
    fn haversine_one_degree_latitude_is_about_111km() {
        // Sanity check the haversine implementation. One degree of
        // latitude is ~111_320 m anywhere on Earth.
        let d = haversine_meters(0.0, 0.0, 1.0, 0.0);
        assert!((d - 111_195.0).abs() < 500.0, "got {}", d);
    }

    #[test]
    fn haversine_50m_radius_boundary_for_central_london() {
        // ~40 m apart in central London — within radius.
        // 0.0003 deg lat ≈ 33 m.
        let near = haversine_meters(51.5001, -0.1262, 51.5004, -0.1262);
        assert!(near < CACHE_MATCH_RADIUS_M, "expected hit, got {}", near);
        // ~80 m apart — outside radius.
        let far = haversine_meters(51.5001, -0.1262, 51.5008, -0.1262);
        assert!(far > CACHE_MATCH_RADIUS_M, "expected miss, got {}", far);
    }

    #[test]
    fn lookup_returns_match_within_radius() {
        let mut c = GeocodeCacheFile::default_v1();
        c.entries.push(GeocodeCacheEntry {
            lat: 51.5001,
            lon: -0.1262,
            queried_at: "2026-01-01T00:00:00Z".into(),
            source: "nominatim".into(),
            result: CachedResult {
                display_name: "Westminster".into(),
                location: None,
                city: Some("Westminster".into()),
                state: None,
                country: None,
                country_code: None,
                postcode: None,
            },
        });
        let hit = c.lookup(51.5002, -0.1262);
        assert!(hit.is_some());
        assert!(c.lookup(52.0, -1.0).is_none());
    }

    #[test]
    fn upsert_replaces_nearby_entry() {
        let mut c = GeocodeCacheFile::default_v1();
        let mk = |lat: f64, name: &str| GeocodeCacheEntry {
            lat,
            lon: -0.1262,
            queried_at: "2026-01-01T00:00:00Z".into(),
            source: "nominatim".into(),
            result: CachedResult {
                display_name: name.into(),
                location: None,
                city: None,
                state: None,
                country: None,
                country_code: None,
                postcode: None,
            },
        };
        c.upsert(mk(51.5001, "first"));
        c.upsert(mk(51.5002, "second"));
        assert_eq!(c.entries.len(), 1, "near-duplicate should replace");
        assert_eq!(c.entries[0].result.display_name, "second");
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = GeocodeCacheFile::default_v1();
        c.upsert(GeocodeCacheEntry {
            lat: 1.0,
            lon: 2.0,
            queried_at: "2026-01-01T00:00:00Z".into(),
            source: "nominatim+overpass".into(),
            result: CachedResult {
                display_name: "X".into(),
                location: Some("Tower".into()),
                city: Some("London".into()),
                state: None,
                country: Some("United Kingdom".into()),
                country_code: Some("GB".into()),
                postcode: None,
            },
        });
        save(dir.path(), &c).unwrap();
        let back = load(dir.path());
        assert_eq!(back.entries.len(), 1);
        assert_eq!(back.entries[0].result.location.as_deref(), Some("Tower"));
        assert_eq!(back.entries[0].source, "nominatim+overpass");
    }

    #[test]
    fn load_returns_empty_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let c = load(dir.path());
        assert_eq!(c.entries.len(), 0);
        assert_eq!(c.version, CACHE_VERSION);
    }

    #[test]
    fn load_returns_empty_on_unknown_version() {
        // A future version on disk shouldn't crash a current binary —
        // we just start cold and overwrite on next save.
        let dir = tempfile::tempdir().unwrap();
        let path = cache_path(dir.path());
        fs::write(&path, br#"{"version": 999, "entries": []}"#).unwrap();
        let c = load(dir.path());
        assert_eq!(c.entries.len(), 0);
        assert_eq!(c.version, CACHE_VERSION);
    }
}
