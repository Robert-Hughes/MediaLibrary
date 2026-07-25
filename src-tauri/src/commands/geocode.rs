//! Reverse-geocode command. The actual loop, per-host rate limiting,
//! mid-pipeline cancel handling and `cache_io` synthesis live in
//! `crate::geocode` so they can be exercised from integration tests
//! without a Tauri runtime; this file owns the Tauri glue (state +
//! event sink).

use tauri::{AppHandle, State};

use crate::batch_job;
use crate::commands::shared::app_data_dir;
use crate::geocode::{self, GeocodeRequestItem, GeocodeSummary};
use crate::geocode_cache;

/// Reverse-geocode a batch of images. This command owns the Tauri
/// cancellation flag, loads/saves the on-disk cache, and adapts the
/// shared `BatchProgressEmitter` to the runner's `GeocodeEventSink`
/// trait.
#[tauri::command]
pub async fn geocode_images_cmd(
    folder_path: String,
    items: Vec<GeocodeRequestItem>,
    app: AppHandle,
    geocode_state: State<'_, geocode::GeocodeState>,
) -> Result<(), String> {
    let _ = folder_path; // resolution happens client-side; included for symmetry with describe.
    let cancel_flag = geocode_state.install();
    let client = geocode::GeocodeClient::new();
    let app_data = app_data_dir(&app).ok();
    let mut cache = match &app_data {
        Some(dir) => geocode_cache::load(dir),
        None => geocode_cache::GeocodeCacheFile::empty_current(),
    };

    log::info!("[geocode] starting total={}", items.len());

    let sink = TauriGeocodeSink {
        emitter: batch_job::BatchProgressEmitter::new(&app, "geocode"),
    };

    let outcome =
        geocode::run_geocode_batch(&items, &client, &mut cache, &cancel_flag, &sink, |c| {
            match &app_data {
                // No app_data_dir → don't try to persist. The batch loop's
                // typed-draft emissions still landed in the frontend store;
                // we just can't memoise this batch's results across
                // restarts.
                Some(dir) => geocode_cache::save(dir, c),
                None => Ok(()),
            }
        })
        .await;

    log::info!(
        "[geocode] finished succeeded={} failed={} no_gps={} from_cache={} from_nominatim={}",
        outcome.succeeded.len(),
        outcome.summary.n_failed,
        outcome.summary.n_no_gps,
        outcome.summary.n_succeeded_from_cache,
        outcome.summary.n_succeeded_from_nominatim,
    );

    geocode_state.clear();
    Ok(())
}

/// Bridge from the runner's sink trait to the Tauri event emitter.
/// Kept inline at the call site (rather than in `batch_job.rs`)
/// because the sink trait is per-job — describe will get its own when
/// its loop is similarly extracted.
struct TauriGeocodeSink<'a> {
    emitter: batch_job::BatchProgressEmitter<'a>,
}

impl<'a> geocode::GeocodeEventSink for TauriGeocodeSink<'a> {
    fn started(&self, total: usize) {
        self.emitter.started(total);
    }
    fn progress(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&crate::draft_edits::SchemaMetadataEditMap>,
    ) {
        self.emitter
            .progress_metadata(current, total, relative_path, status, error, edits);
    }
    fn complete(
        &self,
        succeeded: &[String],
        failed: &[batch_job::BatchFailureRow],
        summary: &GeocodeSummary,
    ) {
        self.emitter.complete(succeeded, failed, summary);
    }
}

#[tauri::command]
pub fn cancel_geocode_cmd(geocode_state: State<'_, geocode::GeocodeState>) -> Result<(), String> {
    geocode_state.signal_cancel();
    Ok(())
}
