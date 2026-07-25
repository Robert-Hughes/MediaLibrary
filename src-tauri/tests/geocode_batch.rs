//! Integration tests for `geocode::run_geocode_batch`.
//!
//! The reverse-geocoding Tauri command (`geocode_images_cmd`) is mostly
//! wiring — app handle, app_data_dir, event emitter, cancellation
//! state. The interesting behaviour (loop accounting and end-of-batch
//! `cache_io` synthesis) lives in `run_geocode_batch` so we can drive
//! it without a Tauri runtime here.
//!
//! These tests cover the plan deviations the recent audit flagged that
//! aren't reachable from the unit tests in `geocode.rs`:
//!
//!   * `cache_io` failure-row synthesis when the end-of-batch cache
//!     save fails;
//!   * the happy-path source-counter accounting (sanity check that
//!     `Cache` / `Nominatim` route to distinct
//!     summary counters).

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use medialibrary_tauri_lib::batch_job::{BatchFailureKind, BatchFailureRow};
use medialibrary_tauri_lib::draft_edits::SchemaMetadataEditMap;
use medialibrary_tauri_lib::geocode::{
    self, GeocodeBatchOutcome, GeocodeClient, GeocodeEventSink, GeocodeRequestItem, GeocodeSummary,
};
use medialibrary_tauri_lib::geocode_cache::{CachedResult, GeocodeCacheEntry, GeocodeCacheFile};

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── Reusable test infrastructure ───────────────────────────────────────────
//
// `RecordingSink` is a `GeocodeEventSink` impl that appends every
// observed event to an in-memory log. Tests assert on the captured
// vector instead of a Tauri event bus.
//
// If/when describe.rs grows the same extracted-runner shape we should
// promote this (and the `respond_with_side_effect` helper below) into
// a `test_support` module that both batches can share — at that point
// the trait names will collide and a real abstraction will be worth
// the indirection. Until then keeping it local keeps the test
// dependency surface small.

// Fields not currently destructured are still captured so future
// tests can assert on them without changing the recorder.
#[allow(dead_code)]
#[derive(Debug, Clone)]
enum SinkEvent {
    Started {
        total: usize,
    },
    Progress {
        current: usize,
        total: usize,
        relative_path: String,
        status: String,
        error: Option<String>,
        edits: Option<SchemaMetadataEditMap>,
    },
    Complete {
        succeeded: Vec<String>,
        failed: Vec<BatchFailureRow>,
        summary: GeocodeSummary,
    },
}

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<SinkEvent>>,
}

impl RecordingSink {
    fn events(&self) -> Vec<SinkEvent> {
        self.events.lock().unwrap().clone()
    }

    /// Convenience: every `Progress` event seen, in order.
    fn progress_events(&self) -> Vec<SinkEvent> {
        self.events()
            .into_iter()
            .filter(|e| matches!(e, SinkEvent::Progress { .. }))
            .collect()
    }
}

impl GeocodeEventSink for RecordingSink {
    fn started(&self, total: usize) {
        self.events
            .lock()
            .unwrap()
            .push(SinkEvent::Started { total });
    }

    fn progress(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&medialibrary_tauri_lib::draft_edits::SchemaMetadataEditMap>,
    ) {
        self.events.lock().unwrap().push(SinkEvent::Progress {
            current,
            total,
            relative_path: relative_path.to_string(),
            status: status.to_string(),
            error: error.map(|s| s.to_string()),
            edits: edits.cloned(),
        });
    }

    fn complete(&self, succeeded: &[String], failed: &[BatchFailureRow], summary: &GeocodeSummary) {
        self.events.lock().unwrap().push(SinkEvent::Complete {
            succeeded: succeeded.to_vec(),
            failed: failed.to_vec(),
            summary: summary.clone(),
        });
    }
}

// `BatchFailureRow` is `Clone` but the sink's `events()` snapshot needs
// `to_vec()` on a slice of it, which requires `Clone`. Already covered
// by the existing `#[derive(Clone, Serialize)]` on the type.

/// Inputs and expected outputs for a typical batch — used by the
/// happy-path test below. Pulled out so the call graph is easy to
/// scan.
fn item(rel: &str, lat: f64, lon: f64) -> GeocodeRequestItem {
    GeocodeRequestItem {
        rel_path: rel.to_string(),
        lat: Some(lat),
        lon: Some(lon),
    }
}

fn item_no_gps(rel: &str) -> GeocodeRequestItem {
    GeocodeRequestItem {
        rel_path: rel.to_string(),
        lat: None,
        lon: None,
    }
}

/// Pre-populate a cache entry for the given coords with a minimal
/// addressful result so a `geocode_one` call will be served from the
/// cache (no network).
fn cache_with_entry(lat: f64, lon: f64, city: &str) -> GeocodeCacheFile {
    let mut c = GeocodeCacheFile::empty_current();
    c.upsert(GeocodeCacheEntry {
        lat,
        lon,
        queried_at: "2026-01-01T00:00:00Z".into(),
        source: "nominatim".into(),
        result: CachedResult {
            display_name: city.into(),
            location: None,
            city: Some(city.into()),
            state: None,
            country: Some("United Kingdom".into()),
            country_code: Some("GB".into()),
            location_id: None,
        },
    });
    c
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn happy_path_accounting_routes_each_source_to_its_summary_counter() {
    // Sanity check the runner's source-counter accounting. Three items:
    //   - one no-GPS (n_no_gps += 1, n_failed unchanged)
    //   - one cache hit (n_succeeded_from_cache += 1)
    //   - one cache miss → Nominatim (n_succeeded_from_nominatim += 1)
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/reverse"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "features": [{
                "properties": {
                    "geocoding": {
                        "type": "house",
                        "osm_key": "tourism",
                        "name": "Tower of London",
                        "city": "London",
                        "country": "United Kingdom",
                        "country_code": "gb"
                    }
                }
            }]
        })))
        .mount(&server)
        .await;
    let client = GeocodeClient::with_base(server.uri());

    // Cache pre-seeded for the (51.5, -0.1) coords — the third item's
    // (52.0, -1.0) will miss and hit the mock server.
    let mut cache = cache_with_entry(51.5, -0.1, "Westminster");

    let items = vec![
        item_no_gps("a.jpg"),
        item("b.jpg", 51.5, -0.1),
        item("c.jpg", 52.0, -1.0),
    ];
    let cancel = AtomicBool::new(false);
    let sink = RecordingSink::default();

    let outcome: GeocodeBatchOutcome =
        geocode::run_geocode_batch(&items, &client, &mut cache, &cancel, &sink, |_| Ok(())).await;

    assert_eq!(outcome.summary.n_no_gps, 1);
    assert_eq!(outcome.summary.n_succeeded_from_cache, 1);
    assert_eq!(outcome.summary.n_succeeded_from_nominatim, 1);
    assert_eq!(outcome.summary.n_failed, 0);
    assert_eq!(outcome.succeeded, vec!["b.jpg".to_string(), "c.jpg".into()]);
    assert_eq!(outcome.failed.len(), 1, "no_gps lives in failed[]");
    assert_eq!(outcome.failed[0].kind, BatchFailureKind::NoGps);

    // The sink must see started → 3× progress → complete in that
    // order. Cheap assertion that the runner doesn't accidentally
    // skip or duplicate boundary events.
    let events = sink.events();
    assert!(matches!(
        events.first(),
        Some(SinkEvent::Started { total: 3 })
    ));
    assert!(matches!(events.last(), Some(SinkEvent::Complete { .. })));
    assert_eq!(sink.progress_events().len(), 3);
}

#[tokio::test]
async fn cache_io_save_failure_appears_as_synthetic_failure_row() {
    // Plan §4 done-panel labels include `cache_io`. The runner emits
    // exactly one such row when the end-of-batch cache save closure
    // returns an Err, with a sentinel relative_path so the frontend
    // can label it without showing a real file path. No network
    // call is needed for this test — the item is served from the
    // cache.
    let mut cache = cache_with_entry(51.5, -0.1, "Westminster");
    let client = GeocodeClient::with_base("http://unused.invalid".into());
    let cancel = AtomicBool::new(false);
    let sink = RecordingSink::default();

    let outcome = geocode::run_geocode_batch(
        &[item("a.jpg", 51.5, -0.1)],
        &client,
        &mut cache,
        &cancel,
        &sink,
        |_| Err("disk full".into()),
    )
    .await;

    // The file itself succeeded — cache hit.
    assert_eq!(outcome.summary.n_succeeded_from_cache, 1);

    // And there's an extra synthetic failure row for the save miss.
    assert_eq!(
        outcome.summary.n_failed, 1,
        "cache_io contributes to n_failed"
    );
    let cache_io = outcome
        .failed
        .iter()
        .find(|f| f.kind == BatchFailureKind::CacheIo)
        .expect("cache_io row should be present");
    assert_eq!(cache_io.relative_path, "<geocache>");
    assert_eq!(cache_io.detail, "disk full");

    // The sink's `complete` event carries the same failed[] including
    // the cache_io row — the frontend reads complete and renders the
    // failure list off that payload, so the row must propagate.
    let events = sink.events();
    let last = events.last().expect("at least the complete event");
    if let SinkEvent::Complete {
        failed, summary, ..
    } = last
    {
        assert!(failed.iter().any(|f| f.kind == BatchFailureKind::CacheIo));
        assert_eq!(summary.n_failed, 1);
    } else {
        unreachable!("last event must be Complete");
    }
}
