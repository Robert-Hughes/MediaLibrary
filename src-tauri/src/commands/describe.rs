//! AI image-description commands. Owns the per-image describe loop,
//! the cost-estimate preflight, and the cancel signal.
//!
//! See `docs/IMAGE_ANALYSIS.md` for design. The shared
//! `BatchProgressEmitter` carries the universal started/progress/
//! complete events; only the per-job `UsageSummary` and the estimate
//! events are describe-specific.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::batch_job;
use crate::commands::shared::{app_data_dir, make_openai_client, resolve_rel};
use crate::describe_log;
use crate::openai_describe;

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
}

#[derive(Clone, Serialize)]
struct DescribeEstimateErrorPayload {
    relative_path: String,
    message: String,
}

// `describe_retry` event surface deferred: reqwest_retry doesn't expose
// a per-attempt hook, so retries are visible in logs but not in the UI
// for V1. Adding a custom middleware that emits events is the natural
// follow-up (see docs/IMAGE_ANALYSIS.md "Rate-limit visibility" bullet).

// `describe_started`, `describe_progress`, `describe_complete` are
// emitted through `batch_job::BatchProgressEmitter` — the wire shape
// lives there. Only the per-job summary (token usage / cost) is
// describe-specific:

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    total_input_tokens: u32,
    total_cached_tokens: u32,
    total_output_tokens: u32,
    predicted_cost_usd: f64,
    actual_cost_usd: f64,
}

/// Preflight cost estimation phase.  Calls `/responses/input_tokens`
/// once per image; emits a progress event after each.  Hard-fails on
/// any error — no local-math fallback (V1 design decision).  Honours
/// the DescribeState cancellation flag at each image boundary.
#[tauri::command]
pub async fn estimate_describe_cost_cmd(
    folder_path: String,
    rel_paths: Vec<String>,
    app: AppHandle,
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    let cancel_flag = describe_state.install();
    let (client, s) = make_openai_client(&app)?;
    let pricing = openai_describe::pricing_for(&s.openai_model)
        .ok_or_else(|| format!("no pricing entry for model {}", s.openai_model))?;

    let total = rel_paths.len();
    log::info!(
        "[describe] estimate starting model={} total={}",
        s.openai_model,
        total
    );
    let _ = app.emit(
        "describe_estimate_started",
        DescribeEstimateStartedPayload { total },
    );

    let mut total_input_tokens: u64 = 0;
    for (index, rel) in rel_paths.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            describe_state.clear();
            return Err("Cancelled by user".into());
        }
        let current = index + 1;
        let abs = resolve_rel(&folder_path, rel);
        let bytes = openai_describe::load_and_downscale_image(&abs).map_err(|e| {
            let _ = app.emit(
                "describe_estimate_error",
                DescribeEstimateErrorPayload {
                    relative_path: rel.clone(),
                    message: e.clone(),
                },
            );
            format!("{}: {}", rel, e)
        })?;
        let n = openai_describe::count_input_tokens(&client, &s.openai_model, &bytes)
            .await
            .map_err(|e| {
                let _ = app.emit(
                    "describe_estimate_error",
                    DescribeEstimateErrorPayload {
                        relative_path: rel.clone(),
                        message: e.clone(),
                    },
                );
                format!("{}: {}", rel, e)
            })?;
        total_input_tokens += n as u64;
        let expected_cost = (n as f64 / 1_000_000.0) * pricing.input_per_1m
            + (openai_describe::EXPECTED_OUTPUT_TOKENS as f64 / 1_000_000.0)
                * pricing.output_per_1m;
        let _ = app.emit(
            "describe_estimate_progress",
            DescribeEstimateProgressPayload {
                current,
                total,
                relative_path: rel.clone(),
                input_tokens: n,
                expected_cost_usd: expected_cost,
            },
        );
    }

    let predicted_cost = (total_input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m
        + ((openai_describe::EXPECTED_OUTPUT_TOKENS as u64 * total as u64) as f64 / 1_000_000.0)
            * pricing.output_per_1m;
    let upper_bound = (total_input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m
        + ((openai_describe::MAX_OUTPUT_TOKENS as u64 * total as u64) as f64 / 1_000_000.0)
            * pricing.output_per_1m;
    log::info!(
        "[describe] estimate complete total_input_tokens={} predicted_cost_usd={:.6} upper_bound_cost_usd={:.6}",
        total_input_tokens, predicted_cost, upper_bound
    );
    let _ = app.emit(
        "describe_estimate_complete",
        DescribeEstimateCompletePayload {
            total_input_tokens,
            predicted_cost_usd: predicted_cost,
            upper_bound_cost_usd: upper_bound,
            model: s.openai_model.clone(),
        },
    );
    // The cancel flag installed for this estimate run is dropped: the
    // user is now in the awaiting-confirm phase. If they confirm, the
    // `describe_images_cmd` handler will install a fresh flag for the
    // run loop; if they cancel from the dialog before confirming, the
    // dialog simply closes — there's no in-flight work to signal.
    describe_state.clear();
    Ok(())
}

/// Predicted-cost recomputation used for the audit log; cheap, no
/// allocations.
fn predicted_cost(model_p: &openai_describe::ModelPricing, total_input: u64, n_images: u64) -> f64 {
    (total_input as f64 / 1_000_000.0) * model_p.input_per_1m
        + ((openai_describe::EXPECTED_OUTPUT_TOKENS as u64 * n_images) as f64 / 1_000_000.0)
            * model_p.output_per_1m
}

/// Main describe loop.  Sequential, per-image draft persistence,
/// cancellable between images.  Emits `describe_started`, per-image
/// `describe_progress`, optional `describe_retry`, then
/// `describe_complete` with the aggregate usage summary.
#[tauri::command]
pub async fn describe_images_cmd(
    folder_path: String,
    rel_paths: Vec<String>,
    app: AppHandle,
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    let cancel_flag = describe_state.install();
    let (client, s) = make_openai_client(&app)?;
    let pricing = openai_describe::pricing_for(&s.openai_model)
        .ok_or_else(|| format!("no pricing entry for model {}", s.openai_model))?;

    let total = rel_paths.len();
    log::info!(
        "[describe] starting describe model={} prompt_version={} total={}",
        s.openai_model,
        openai_describe::PROMPT_VERSION,
        total
    );
    let emitter = batch_job::BatchProgressEmitter::new(&app, "describe");
    emitter.started(total);

    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<batch_job::BatchFailureRow> = Vec::new();
    let mut log_errors: Vec<describe_log::DescribeLogError> = Vec::new();
    let mut aggregate = openai_describe::UsageStats::default();
    let mut total_input_for_predicted: u64 = 0;
    let mut current = 0usize;

    for rel in &rel_paths {
        if cancel_flag.load(Ordering::Relaxed) {
            log::info!("[describe] Cancelled at {}/{}", current, total);
            break;
        }
        current += 1;
        log::info!("[describe] ({}/{}) starting {}", current, total, rel);

        // Decode locally first so a corrupt file is reported without
        // incurring an API call.
        let abs = resolve_rel(&folder_path, rel);
        let bytes = match openai_describe::load_and_downscale_image(&abs) {
            Ok(b) => b,
            Err(e) => {
                log::warn!(
                    "[describe] ({}/{}) decode failed for {}: {}",
                    current,
                    total,
                    rel,
                    e
                );
                let kind = batch_job::BatchFailureKind::Decode;
                emitter.progress(current, total, rel, kind.as_wire(), Some(&e), None);
                failed.push(batch_job::BatchFailureRow {
                    relative_path: rel.clone(),
                    kind,
                    detail: e.clone(),
                });
                log_errors.push(describe_log::DescribeLogError {
                    relative_path: rel.clone(),
                    kind,
                    detail: e,
                });
                continue;
            }
        };

        match openai_describe::describe_one(&client, &s.openai_model, &bytes).await {
            Ok((output, usage)) => {
                aggregate.add(&usage);
                total_input_for_predicted += usage.input_tokens as u64;

                let edits = openai_describe::compose_metadata_draft_edits(
                    &s.openai_model,
                    &output,
                    chrono::Utc::now(),
                );
                log::info!(
                    "[describe] ({}/{}) ok {} input_tokens={} output_tokens={} tags={}",
                    current,
                    total,
                    rel,
                    usage.input_tokens,
                    usage.output_tokens,
                    edits.len()
                );
                emitter.progress_metadata(current, total, rel, "ok", None, Some(&edits));
                succeeded.push(rel.clone());
            }
            Err(e) => {
                let kind = e.kind();
                let detail = e.detail();
                log::warn!(
                    "[describe] ({}/{}) failed {} kind={} detail={}",
                    current,
                    total,
                    rel,
                    kind,
                    detail
                );
                emitter.progress(current, total, rel, kind.as_wire(), Some(&detail), None);
                failed.push(batch_job::BatchFailureRow {
                    relative_path: rel.clone(),
                    kind,
                    detail: detail.clone(),
                });
                log_errors.push(describe_log::DescribeLogError {
                    relative_path: rel.clone(),
                    kind,
                    detail,
                });
            }
        }
    }

    log::info!(
        "[describe] finished succeeded={} failed={} total_input_tokens={} total_output_tokens={}",
        succeeded.len(),
        failed.len(),
        aggregate.input_tokens,
        aggregate.output_tokens
    );

    let predicted = predicted_cost(&pricing, total_input_for_predicted, succeeded.len() as u64);
    let actual = aggregate.cost(&pricing);

    let usage_summary = UsageSummary {
        total_input_tokens: aggregate.input_tokens,
        total_cached_tokens: aggregate.cached_input_tokens,
        total_output_tokens: aggregate.output_tokens,
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
            total_output_tokens: aggregate.output_tokens,
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
    describe_state: State<'_, openai_describe::DescribeState>,
) -> Result<(), String> {
    describe_state.signal_cancel();
    Ok(())
}
