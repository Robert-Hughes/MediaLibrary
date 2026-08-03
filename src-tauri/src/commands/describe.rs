//! AI image-description commands. Owns the per-image describe loop,
//! the cost-estimate preflight, and the cancel signal.
//!
//! See `docs/IMAGE_ANALYSIS.md` for design. The shared
//! `BatchProgressEmitter` carries the universal started/progress/
//! complete events; only the per-job `UsageSummary` and the estimate
//! events are describe-specific.

use std::num::NonZeroUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::batch_job;
use crate::commands::shared::{app_data_dir, make_openai_http, resolve_rel};
use crate::describe_log;
use crate::openai_describe;
use crate::settings::{self, AiCostEstimateMode};

#[derive(Clone, Serialize)]
struct DescribeEstimateStartedPayload {
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DescribeEstimateProgressPayload {
    current: usize,
    total: usize,
    relative_path: String,
    input_tokens: u32,
    expected_cost_usd: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DescribeEstimateCompletePayload {
    total_input_tokens: u64,
    predicted_cost_usd: f64,
    upper_bound_cost_usd: f64,
    model: String,
    estimate_mode: AiCostEstimateMode,
}

#[derive(Clone, Serialize)]
struct DescribeEstimateErrorPayload {
    relative_path: String,
    message: String,
}

// The shared OpenAI transport logs retry attempts and coordinates
// task-local cooldowns across these workers.

// `describe_started`, `describe_progress`, `describe_complete` are
// emitted through `batch_job::BatchProgressEmitter` — the wire shape
// lives there. Only the per-job summary (token usage / cost) is
// describe-specific:

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    total_input_tokens: u32,
    total_cached_tokens: u32,
    total_cache_write_tokens: u32,
    total_output_tokens: u32,
    total_reasoning_tokens: u32,
    total_non_reasoning_output_tokens: u32,
    service_tier: String,
    reasoning_effort: String,
    predicted_cost_usd: f64,
    actual_cost_usd: f64,
}

#[derive(Clone)]
struct DescribeWorkItem {
    input_index: usize,
    total: usize,
    relative_path: String,
}

struct DescribeItemSuccess {
    edits: crate::draft_edits::SchemaMetadataEditMap,
    usage: openai_describe::UsageStats,
}

struct DescribeItemFailure {
    kind: batch_job::BatchFailureKind,
    detail: String,
    usage: Option<openai_describe::UsageStats>,
}

struct DescribeItemOutcome {
    item: DescribeWorkItem,
    api_dispatched: bool,
    result: Result<DescribeItemSuccess, DescribeItemFailure>,
}

#[derive(Default)]
struct DescribeBatchOutcome {
    succeeded: Vec<String>,
    failed: Vec<batch_job::BatchFailureRow>,
    log_errors: Vec<describe_log::DescribeLogError>,
    aggregate: openai_describe::UsageStats,
    dispatched_api_calls: usize,
}

trait DescribeEventSink {
    fn started(&self, total: usize);
    fn progress(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&crate::draft_edits::SchemaMetadataEditMap>,
    );
}

impl DescribeEventSink for batch_job::BatchProgressEmitter<'_> {
    fn started(&self, total: usize) {
        batch_job::BatchProgressEmitter::started(self, total);
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
        self.progress_metadata(current, total, relative_path, status, error, edits);
    }
}

async fn process_describe_item(
    folder_path: Arc<String>,
    client: openai_describe::OpenAiDescribeClient,
    model: Arc<String>,
    batch_started_at: std::time::Instant,
    item: DescribeWorkItem,
) -> DescribeItemOutcome {
    let preprocess_started_at = std::time::Instant::now();
    log::info!(
        "[describe] stage=preprocess_start input={}/{} elapsed_ms={} file={}",
        item.input_index,
        item.total,
        batch_started_at.elapsed().as_millis(),
        item.relative_path
    );
    let abs = resolve_rel(folder_path.as_str(), &item.relative_path);
    let bytes =
        match tokio::task::spawn_blocking(move || openai_describe::load_and_downscale_image(&abs))
            .await
        {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(detail)) => {
                return DescribeItemOutcome {
                    item,
                    api_dispatched: false,
                    result: Err(DescribeItemFailure {
                        kind: batch_job::BatchFailureKind::Decode,
                        detail,
                        usage: None,
                    }),
                };
            }
            Err(error) => {
                return DescribeItemOutcome {
                    item,
                    api_dispatched: false,
                    result: Err(DescribeItemFailure {
                        kind: batch_job::BatchFailureKind::Decode,
                        detail: format!("image preprocessing worker failed: {error}"),
                        usage: None,
                    }),
                };
            }
        };
    log::info!(
        "[describe] stage=preprocess_complete input={}/{} elapsed_ms={} stage_ms={} jpeg_bytes={} file={}",
        item.input_index,
        item.total,
        batch_started_at.elapsed().as_millis(),
        preprocess_started_at.elapsed().as_millis(),
        bytes.len(),
        item.relative_path
    );

    let api_started_at = std::time::Instant::now();
    log::info!(
        "[describe] stage=api_dispatch input={}/{} elapsed_ms={} file={}",
        item.input_index,
        item.total,
        batch_started_at.elapsed().as_millis(),
        item.relative_path
    );
    let result = match openai_describe::describe_one(&client, model.as_str(), &bytes).await {
        Ok((output, usage)) => Ok(DescribeItemSuccess {
            edits: openai_describe::compose_metadata_draft_edits(
                model.as_str(),
                &output,
                chrono::Utc::now(),
            ),
            usage,
        }),
        Err(error) => Err(DescribeItemFailure {
            kind: error.kind(),
            detail: error.detail(),
            usage: error.usage().cloned(),
        }),
    };
    log::info!(
        "[describe] stage=api_complete input={}/{} elapsed_ms={} stage_ms={} file={}",
        item.input_index,
        item.total,
        batch_started_at.elapsed().as_millis(),
        api_started_at.elapsed().as_millis(),
        item.relative_path
    );

    DescribeItemOutcome {
        item,
        api_dispatched: true,
        result,
    }
}

async fn run_describe_batch<P, ProcessFuture, S>(
    items: Vec<DescribeWorkItem>,
    concurrency: NonZeroUsize,
    cancel_flag: Arc<std::sync::atomic::AtomicBool>,
    processor: P,
    sink: &S,
) -> Result<DescribeBatchOutcome, String>
where
    P: Fn(DescribeWorkItem) -> ProcessFuture + Send + Sync + 'static,
    ProcessFuture: std::future::Future<Output = DescribeItemOutcome> + Send + 'static,
    S: DescribeEventSink + ?Sized,
{
    let total = items.len();
    sink.started(total);
    let mut completed = 0usize;
    let mut batch = DescribeBatchOutcome::default();

    batch_job::run_bounded(
        items,
        concurrency,
        cancel_flag,
        processor,
        |outcome| {
            completed += 1;
            if outcome.api_dispatched {
                batch.dispatched_api_calls += 1;
            }
            let input_index = outcome.item.input_index;
            let relative_path = outcome.item.relative_path;

            match outcome.result {
                Ok(success) => {
                    batch.aggregate.add(&success.usage);
                    log::info!(
                        "[describe] completion={}/{} input={}/{} ok {} input_tokens={} cached_tokens={} cache_write_tokens={} output_tokens={} reasoning_tokens={} non_reasoning_output_tokens={} service_tier={} reasoning_effort={} tags={}",
                        completed,
                        total,
                        input_index,
                        total,
                        relative_path,
                        success.usage.input_tokens,
                        success.usage.cached_input_tokens,
                        success.usage.cache_write_input_tokens,
                        success.usage.output_tokens,
                        success.usage.reasoning_tokens,
                        success.usage.non_reasoning_output_tokens(),
                        success.usage.service_tier,
                        success.usage.reasoning_effort,
                        success.edits.len()
                    );
                    sink.progress(
                        completed,
                        total,
                        &relative_path,
                        "ok",
                        None,
                        Some(&success.edits),
                    );
                    batch.succeeded.push(relative_path);
                }
                Err(failure) => {
                    if let Some(usage) = &failure.usage {
                        batch.aggregate.add(usage);
                        log::warn!(
                            "[describe] completion={}/{} input={}/{} failed {} kind={} detail={} input_tokens={} cached_tokens={} cache_write_tokens={} output_tokens={} reasoning_tokens={} non_reasoning_output_tokens={} service_tier={} reasoning_effort={}",
                            completed,
                            total,
                            input_index,
                            total,
                            relative_path,
                            failure.kind,
                            failure.detail,
                            usage.input_tokens,
                            usage.cached_input_tokens,
                            usage.cache_write_input_tokens,
                            usage.output_tokens,
                            usage.reasoning_tokens,
                            usage.non_reasoning_output_tokens(),
                            usage.service_tier,
                            usage.reasoning_effort
                        );
                    } else {
                        log::warn!(
                            "[describe] completion={}/{} input={}/{} failed {} kind={} detail={} usage=unavailable",
                            completed,
                            total,
                            input_index,
                            total,
                            relative_path,
                            failure.kind,
                            failure.detail
                        );
                    }
                    sink.progress(
                        completed,
                        total,
                        &relative_path,
                        failure.kind.as_wire(),
                        Some(&failure.detail),
                        None,
                    );
                    batch.failed.push(batch_job::BatchFailureRow {
                        relative_path: relative_path.clone(),
                        kind: failure.kind,
                        detail: failure.detail.clone(),
                    });
                    batch.log_errors.push(describe_log::DescribeLogError {
                        relative_path,
                        kind: failure.kind,
                        detail: failure.detail,
                        usage: failure.usage,
                    });
                }
            }
        },
    )
    .await?;

    Ok(batch)
}

/// Preflight cost estimation phase. Heuristic mode is local-only and emits
/// synthetic per-image progress. Exact mode preserves the original
/// `/responses/input_tokens` call once per image and hard-fails on errors.
#[tauri::command]
pub async fn estimate_describe_cost_cmd(
    session_id: u64,
    rel_paths: Vec<String>,
    app: AppHandle,
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    let snapshot = app
        .state::<crate::session::MediaLibrarySessionState>()
        .snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != crate::session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before estimation started".into());
    }
    let folder_path = snapshot
        .folder
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let total = rel_paths.len();
    let emitter = batch_job::BatchProgressEmitter::begin(
        &app,
        "describe",
        session_id,
        crate::session::MediaLibraryBatchOperationPhase::Estimating,
        rel_paths.clone(),
        Some(serde_json::to_value(&rel_paths).map_err(|error| error.to_string())?),
        None,
    )?;
    let settings_dir = app_data_dir(&app).inspect_err(|error| emitter.fail(error.clone()))?;
    let s =
        settings::load_settings(&settings_dir).inspect_err(|error| emitter.fail(error.clone()))?;
    if s.openai_api_key.trim().is_empty() {
        describe_state.clear();
        let error = "OpenAI API key is not configured. Open Settings to enter your key.";
        emitter.fail(error);
        return Err(error.into());
    }
    openai_describe::pricing_for(&s.openai_model)
        .ok_or_else(|| format!("no pricing entry for model {}", s.openai_model))
        .inspect_err(|error| emitter.fail(error.clone()))?;
    let cancel_flag = describe_state.install();

    log::info!(
        "[describe] estimate starting model={} mode={:?} total={}",
        s.openai_model,
        s.ai_cost_estimate_mode,
        total
    );
    emitter.estimate_started(total);
    let _ = crate::emit_frontend_event(
        &app,
        "describe_estimate_started",
        DescribeEstimateStartedPayload { total },
    );

    if s.ai_cost_estimate_mode == AiCostEstimateMode::Heuristic {
        let total_input_tokens = openai_describe::heuristic_describe_input_tokens(total);
        let (predicted_cost, upper_bound) =
            openai_describe::estimate_describe_cost_from_input_tokens(
                &s.openai_model,
                total_input_tokens,
                total,
            )
            .inspect_err(|error| {
                emitter.fail(error.clone());
            })?;
        log::info!(
            "[describe] heuristic estimate complete total_input_tokens={} predicted_cost_usd={:.6} upper_bound_cost_usd={:.6}",
            total_input_tokens, predicted_cost, upper_bound
        );
        let estimate = DescribeEstimateCompletePayload {
            total_input_tokens,
            predicted_cost_usd: predicted_cost,
            upper_bound_cost_usd: upper_bound,
            model: s.openai_model.clone(),
            estimate_mode: s.ai_cost_estimate_mode,
        };
        emitter.estimate_complete(&estimate);
        emitter.emit_projection_event("estimate_complete", &estimate);
        /* replaced payload */
        if false {
            let _ = DescribeEstimateCompletePayload {
                total_input_tokens,
                predicted_cost_usd: predicted_cost,
                upper_bound_cost_usd: upper_bound,
                model: s.openai_model.clone(),
                estimate_mode: s.ai_cost_estimate_mode,
            };
        }
        describe_state.clear();
        return Ok(());
    }

    let (http, _) = make_openai_http(&app).inspect_err(|error| {
        emitter.fail(error.clone());
    })?;
    let client = openai_describe::OpenAiDescribeClient::from_http(http);
    let pricing = openai_describe::pricing_for(&s.openai_model)
        .ok_or_else(|| format!("no pricing entry for model {}", s.openai_model))?;
    let mut total_input_tokens: u64 = 0;
    for (index, rel) in rel_paths.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            describe_state.clear();
            emitter.fail("Cancelled by user");
            return Err("Cancelled by user".into());
        }
        let current = index + 1;
        let abs = resolve_rel(&folder_path, rel);
        let bytes = openai_describe::load_and_downscale_image(&abs).map_err(|e| {
            emitter.emit_projection_event(
                "estimate_error",
                &DescribeEstimateErrorPayload {
                    relative_path: rel.clone(),
                    message: e.clone(),
                },
            );
            let error = format!("{}: {}", rel, e);
            emitter.fail(error.clone());
            error
        })?;
        let n = openai_describe::count_input_tokens(&client, &s.openai_model, &bytes)
            .await
            .map_err(|e| {
                emitter.emit_projection_event(
                    "estimate_error",
                    &DescribeEstimateErrorPayload {
                        relative_path: rel.clone(),
                        message: e.clone(),
                    },
                );
                let error = format!("{}: {}", rel, e);
                emitter.fail(error.clone());
                error
            })?;
        total_input_tokens += n as u64;
        let expected_cost = (n as f64 / 1_000_000.0) * pricing.input_per_1m
            + (openai_describe::EXPECTED_OUTPUT_TOKENS as f64 / 1_000_000.0)
                * pricing.output_per_1m;
        emitter.estimate_progress(current, total, rel, None);
        emitter.emit_projection_event(
            "estimate_progress",
            &DescribeEstimateProgressPayload {
                current,
                total,
                relative_path: rel.clone(),
                input_tokens: n,
                expected_cost_usd: expected_cost,
            },
        );
    }

    let (predicted_cost, upper_bound) = openai_describe::estimate_describe_cost_from_input_tokens(
        &s.openai_model,
        total_input_tokens,
        total,
    )
    .inspect_err(|error| {
        emitter.fail(error.clone());
    })?;
    log::info!(
        "[describe] estimate complete total_input_tokens={} predicted_cost_usd={:.6} upper_bound_cost_usd={:.6}",
        total_input_tokens, predicted_cost, upper_bound
    );
    let estimate = DescribeEstimateCompletePayload {
        total_input_tokens,
        predicted_cost_usd: predicted_cost,
        upper_bound_cost_usd: upper_bound,
        model: s.openai_model.clone(),
        estimate_mode: s.ai_cost_estimate_mode,
    };
    emitter.estimate_complete(&estimate);
    emitter.emit_projection_event("estimate_complete", &estimate);
    if false {
        let _ = DescribeEstimateCompletePayload {
            total_input_tokens,
            predicted_cost_usd: predicted_cost,
            upper_bound_cost_usd: upper_bound,
            model: s.openai_model.clone(),
            estimate_mode: s.ai_cost_estimate_mode,
        };
    }
    // The cancel flag installed for this estimate run is dropped: the
    // user is now in the awaiting-confirm phase. If they confirm, the
    // `describe_images_cmd` handler will install a fresh flag for the
    // run loop; if they cancel from the dialog before confirming, the
    // dialog simply closes — there's no in-flight work to signal.
    describe_state.clear();
    Ok(())
}

/// Main describe loop. Runs a bounded number of image requests concurrently,
/// emits progress in completion order, and finishes with the aggregate usage
/// summary.
#[tauri::command]
pub async fn describe_images_cmd(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    let snapshot = app
        .state::<crate::session::MediaLibrarySessionState>()
        .snapshot();
    if snapshot.session_id != Some(session_id) {
        return Err("The media-library session changed before description started".into());
    }
    let operation = snapshot
        .batch_operations
        .get("describe")
        .filter(|operation| operation.operation_id == operation_id)
        .ok_or_else(|| "The description operation identity changed".to_string())?;
    let rel_paths = operation.requested_paths.clone();
    let folder_path = snapshot
        .folder
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let total = rel_paths.len();
    let emitter = batch_job::BatchProgressEmitter::resume(
        &app,
        "describe",
        session_id,
        operation_id,
        total,
        None,
        batch_job::GeneratedDraftProducer::Describe,
    )?;
    let (http, s) = make_openai_http(&app).inspect_err(|error| {
        emitter.fail(error.clone());
    })?;
    let client = openai_describe::OpenAiDescribeClient::from_http(http);
    let pricing = openai_describe::pricing_for(&s.openai_model)
        .ok_or_else(|| format!("no pricing entry for model {}", s.openai_model))
        .inspect_err(|error| {
            emitter.fail(error.clone());
        })?;
    let cancel_flag = describe_state.install();

    let describe_concurrency = usize::from(s.describe_concurrency);
    log::info!(
        "[describe] starting describe model={} prompt_version={} total={} concurrency={}",
        s.openai_model,
        openai_describe::PROMPT_VERSION,
        total,
        describe_concurrency
    );
    let folder_path = Arc::new(folder_path);
    let model = Arc::new(s.openai_model.clone());
    let batch_started_at = std::time::Instant::now();
    let items = rel_paths
        .into_iter()
        .enumerate()
        .map(|(index, relative_path)| DescribeWorkItem {
            input_index: index + 1,
            total,
            relative_path,
        })
        .collect();
    let processor = move |item| {
        process_describe_item(
            folder_path.clone(),
            client.clone(),
            model.clone(),
            batch_started_at,
            item,
        )
    };
    let batch = match run_describe_batch(
        items,
        NonZeroUsize::new(describe_concurrency)
            .expect("settings validation guarantees non-zero describe concurrency"),
        cancel_flag.clone(),
        processor,
        &emitter,
    )
    .await
    {
        Ok(batch) => batch,
        Err(error) => {
            describe_state.clear();
            emitter.fail(error.clone());
            return Err(error);
        }
    };
    let DescribeBatchOutcome {
        succeeded,
        failed,
        log_errors,
        aggregate,
        dispatched_api_calls,
    } = batch;

    if cancel_flag.load(Ordering::Relaxed) {
        log::info!(
            "[describe] cancelled after completing {}/{}",
            succeeded.len() + failed.len(),
            total
        );
    }

    log::info!(
        "[describe] finished succeeded={} failed={} total_input_tokens={} cached_tokens={} cache_write_tokens={} total_output_tokens={} reasoning_tokens={} non_reasoning_output_tokens={} service_tier={} reasoning_effort={}",
        succeeded.len(),
        failed.len(),
        aggregate.input_tokens,
        aggregate.cached_input_tokens,
        aggregate.cache_write_input_tokens,
        aggregate.output_tokens,
        aggregate.reasoning_tokens,
        aggregate.non_reasoning_output_tokens(),
        aggregate.service_tier,
        aggregate.reasoning_effort
    );

    let (predicted, _) = openai_describe::estimate_describe_cost_from_input_tokens(
        &s.openai_model,
        aggregate.input_tokens as u64,
        dispatched_api_calls,
    )
    .inspect_err(|error| {
        emitter.fail(error.clone());
    })?;
    let actual = aggregate.cost(&pricing);

    let usage_summary = UsageSummary {
        total_input_tokens: aggregate.input_tokens,
        total_cached_tokens: aggregate.cached_input_tokens,
        total_cache_write_tokens: aggregate.cache_write_input_tokens,
        total_output_tokens: aggregate.output_tokens,
        total_reasoning_tokens: aggregate.reasoning_tokens,
        total_non_reasoning_output_tokens: aggregate.non_reasoning_output_tokens(),
        service_tier: aggregate.service_tier.clone(),
        reasoning_effort: aggregate.reasoning_effort.clone(),
        predicted_cost_usd: predicted,
        actual_cost_usd: actual,
    };

    // Audit log — best-effort, never fails the command.
    if let Ok(dir) = app_data_dir(&app) {
        let entry = describe_log::DescribeLogEntry {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            model: s.openai_model.clone(),
            prompt_version: openai_describe::PROMPT_VERSION.to_string(),
            n_images: total,
            n_succeeded: succeeded.len(),
            n_failed: failed.len(),
            total_input_tokens: aggregate.input_tokens,
            total_cached_tokens: aggregate.cached_input_tokens,
            total_cache_write_tokens: aggregate.cache_write_input_tokens,
            total_output_tokens: aggregate.output_tokens,
            total_reasoning_tokens: aggregate.reasoning_tokens,
            total_non_reasoning_output_tokens: aggregate.non_reasoning_output_tokens(),
            service_tier: aggregate.service_tier.clone(),
            reasoning_effort: aggregate.reasoning_effort.clone(),
            predicted_cost_usd: predicted,
            actual_cost_usd: actual,
            errors: log_errors,
        };
        if let Err(e) = describe_log::append(&dir, &entry) {
            log::warn!("[describe] Audit-log append failed: {}", e);
        }
    }

    describe_state.clear();
    emitter.complete(&succeeded, &failed, &usage_summary);
    Ok(())
}

#[tauri::command]
pub fn cancel_describe_cmd(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    // Signal the in-flight runner before touching the session: a racing
    // dismiss can remove the operation before this mutation runs, and the
    // runner must still observe cancellation so it stops at its next item
    // boundary instead of completing and resurrecting the dialog.
    describe_state.signal_cancel();
    app.state::<crate::session::MediaLibrarySessionState>()
        .request_batch_operation_cancellation(session_id, &operation_id)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex;
    use std::time::Duration;

    #[derive(Default)]
    struct RecordingSink {
        started: Mutex<Vec<usize>>,
        progress: Mutex<Vec<(usize, String, String)>>,
    }

    impl DescribeEventSink for RecordingSink {
        fn started(&self, total: usize) {
            self.started.lock().unwrap().push(total);
        }

        fn progress(
            &self,
            current: usize,
            _total: usize,
            relative_path: &str,
            status: &str,
            _error: Option<&str>,
            _edits: Option<&crate::draft_edits::SchemaMetadataEditMap>,
        ) {
            self.progress.lock().unwrap().push((
                current,
                relative_path.to_string(),
                status.to_string(),
            ));
        }
    }

    fn work_items(count: usize) -> Vec<DescribeWorkItem> {
        (0..count)
            .map(|index| DescribeWorkItem {
                input_index: index + 1,
                total: count,
                relative_path: format!("{index}.jpg"),
            })
            .collect()
    }

    #[tokio::test]
    async fn concurrent_batch_is_bounded_and_aggregates_out_of_order_results() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let invocations = Arc::new(Mutex::new(Vec::new()));
        let active_for_processor = active.clone();
        let peak_for_processor = peak.clone();
        let invocations_for_processor = invocations.clone();
        let sink = RecordingSink::default();

        let outcome = run_describe_batch(
            work_items(5),
            NonZeroUsize::new(3).unwrap(),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            move |item| {
                let active = active_for_processor.clone();
                let peak = peak_for_processor.clone();
                let invocations = invocations_for_processor.clone();
                async move {
                    invocations.lock().unwrap().push(item.relative_path.clone());
                    let now_active = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    peak.fetch_max(now_active, AtomicOrdering::SeqCst);
                    let delay_ms = match item.input_index {
                        1 => 80,
                        2 => 10,
                        3 => 40,
                        _ => 5,
                    };
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    active.fetch_sub(1, AtomicOrdering::SeqCst);

                    let result = if item.input_index == 3 {
                        Err(DescribeItemFailure {
                            kind: batch_job::BatchFailureKind::Network,
                            detail: "simulated network failure".into(),
                            usage: Some(openai_describe::UsageStats {
                                input_tokens: 30,
                                output_tokens: 3,
                                ..Default::default()
                            }),
                        })
                    } else {
                        Ok(DescribeItemSuccess {
                            edits: Default::default(),
                            usage: openai_describe::UsageStats {
                                input_tokens: item.input_index as u32 * 10,
                                output_tokens: item.input_index as u32,
                                ..Default::default()
                            },
                        })
                    };
                    DescribeItemOutcome {
                        item,
                        api_dispatched: true,
                        result,
                    }
                }
            },
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(peak.load(AtomicOrdering::SeqCst), 3);
        assert_eq!(sink.started.lock().unwrap().as_slice(), &[5]);
        let progress = sink.progress.lock().unwrap().clone();
        assert_eq!(
            progress.iter().map(|row| row.0).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
        assert_ne!(
            progress
                .iter()
                .map(|row| row.1.as_str())
                .collect::<Vec<_>>(),
            vec!["0.jpg", "1.jpg", "2.jpg", "3.jpg", "4.jpg"]
        );
        assert_eq!(
            invocations
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<HashSet<_>>(),
            (0..5).map(|index| format!("{index}.jpg")).collect()
        );
        assert_eq!(outcome.dispatched_api_calls, 5);
        assert_eq!(outcome.succeeded.len(), 4);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].relative_path, "2.jpg");
        assert_eq!(outcome.aggregate.input_tokens, 150);
        assert_eq!(outcome.aggregate.output_tokens, 15);
    }

    #[tokio::test]
    async fn concurrency_one_preserves_input_order() {
        let sink = RecordingSink::default();
        let outcome = run_describe_batch(
            work_items(3),
            NonZeroUsize::new(1).unwrap(),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            |item| async move {
                DescribeItemOutcome {
                    item,
                    api_dispatched: true,
                    result: Ok(DescribeItemSuccess {
                        edits: Default::default(),
                        usage: Default::default(),
                    }),
                }
            },
            &sink,
        )
        .await
        .unwrap();

        assert_eq!(
            sink.progress
                .lock()
                .unwrap()
                .iter()
                .map(|row| row.1.clone())
                .collect::<Vec<_>>(),
            vec!["0.jpg", "1.jpg", "2.jpg"]
        );
        assert_eq!(outcome.succeeded, vec!["0.jpg", "1.jpg", "2.jpg"]);
    }
}
