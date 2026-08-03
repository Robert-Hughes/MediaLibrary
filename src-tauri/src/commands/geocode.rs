//! Reverse-geocode command. The actual loop, per-host rate limiting,
//! mid-pipeline cancel handling and `cache_io` synthesis live in
//! `crate::geocode` so they can be exercised from integration tests
//! without a Tauri runtime; this file owns the Tauri glue (state +
//! event sink).

use tauri::{AppHandle, Manager, State};

use crate::batch_job;
use crate::commands::shared::app_data_dir;
use crate::geocode::{self, GeocodeRequestItem, GeocodeSummary};
use crate::geocode_cache;

#[tauri::command]
pub fn prepare_geocode_images_cmd(
    session_id: u64,
    items: Vec<GeocodeRequestItem>,
    app: AppHandle,
) -> Result<(), String> {
    let requested_paths = items.iter().map(|item| item.rel_path.clone()).collect();
    let emitter = batch_job::BatchProgressEmitter::begin(
        &app,
        "geocode",
        session_id,
        crate::session::MediaLibraryBatchOperationPhase::AwaitingConfirm,
        requested_paths,
        Some(serde_json::to_value(items).map_err(|error| error.to_string())?),
        None,
    )?;
    emitter.estimate_complete(&serde_json::Value::Null);
    Ok(())
}

/// Reverse-geocode a batch of images. This command owns the Tauri
/// cancellation flag, loads/saves the on-disk cache, and adapts the
/// shared `BatchProgressEmitter` to the runner's `GeocodeEventSink`
/// trait.
#[tauri::command]
pub async fn geocode_images_cmd(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    geocode_state: State<'_, geocode::GeocodeState>,
) -> Result<(), String> {
    let snapshot = app
        .state::<crate::session::MediaLibrarySessionState>()
        .snapshot();
    if snapshot.session_id != Some(session_id) {
        return Err("The media-library session changed before geocoding started".into());
    }
    let operation = snapshot
        .batch_operations
        .get("geocode")
        .filter(|operation| operation.operation_id == operation_id)
        .ok_or_else(|| "The geocode operation identity changed".to_string())?;
    let total = operation.total;
    let emitter = batch_job::BatchProgressEmitter::resume(
        &app,
        "geocode",
        session_id,
        operation_id,
        total,
        None,
        batch_job::GeneratedDraftProducer::Geocode,
    )?;
    let items: Vec<GeocodeRequestItem> = serde_json::from_value(
        operation
            .request
            .clone()
            .ok_or_else(|| "The geocode operation request is unavailable".to_string())
            .inspect_err(|error| emitter.fail(error.clone()))?,
    )
    .map_err(|error| format!("The retained geocode request is invalid: {error}"))
    .inspect_err(|error| emitter.fail(error.clone()))?;
    if items.len() != total {
        let error = "The retained geocode request count changed".to_string();
        emitter.fail(error.clone());
        return Err(error);
    }
    let cancel_flag = geocode_state.install();
    let client = geocode::GeocodeClient::new();
    let app_data = app_data_dir(&app).ok();
    let mut cache = match &app_data {
        Some(dir) => geocode_cache::load(dir),
        None => geocode_cache::GeocodeCacheFile::empty_current(),
    };

    log::info!("[geocode] starting total={}", items.len());

    let sink = TauriGeocodeSink { emitter };

    let outcome =
        geocode::run_geocode_batch(&items, &client, &mut cache, &cancel_flag, &sink, |c| {
            match &app_data {
                // No app_data_dir means this batch cannot be memoised across
                // restarts; generated drafts are still staged by Rust.
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
pub fn cancel_geocode_cmd(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    geocode_state: State<'_, geocode::GeocodeState>,
) -> Result<(), String> {
    let snapshot = app
        .state::<crate::session::MediaLibrarySessionState>()
        .request_batch_operation_cancellation(session_id, &operation_id)?;
    let _ = crate::emit_frontend_event(&app, crate::session::SESSION_CHANGED_EVENT, snapshot);
    geocode_state.signal_cancel();
    Ok(())
}
