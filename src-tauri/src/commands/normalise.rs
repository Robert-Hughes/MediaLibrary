//! Metadata-normalisation commands.
//!
//! See `docs/NORMALISE_METADATA_PLAN.md` §8. `normalise_metadata_cmd`
//! walks the supplied items through `normalise::process_image`, emits
//! per-item progress events, and accumulates a `NormaliseSummary`. §7
//! `estimate_normalise_cost_cmd` walks every image with a capturing
//! AI client that doesn't dispatch and preflights each fire-able AI
//! prompt through `/responses/input_tokens` for an exact cost preview.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::batch_audit_log;
use crate::batch_job;
use crate::commands::shared::{app_data_dir, make_openai_client};
use crate::normalise;
use crate::openai_describe;
use crate::openai_normalise;

#[derive(Clone, Serialize)]
struct NormaliseEstimateStartedPayload { total: usize }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NormaliseEstimateProgressPayload {
    current: usize,
    total: usize,
    relative_path: String,
    /// Token total preflighted for this image across any AI calls that
    /// would fire (Group B + Group C).
    input_tokens: u32,
    /// True when this image would invoke Group B (description merge).
    fires_description_ai: bool,
    /// True when this image would invoke Group C (title generation).
    fires_title_ai: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NormaliseEstimateCompletePayload {
    n_images_with_ai_b: u32,
    n_images_with_ai_c: u32,
    n_images_no_ai: u32,
    total_input_tokens: u64,
    predicted_cost_usd: f64,
    upper_bound_cost_usd: f64,
    model: String,
}

#[derive(Clone, Serialize)]
struct NormaliseEstimateErrorPayload { relative_path: String, message: String }

/// Preflight cost estimation for `normalise_metadata_cmd`. Walks every
/// image with a `CapturingAiClient` so we know which AI calls would
/// fire; preflights each captured prompt against
/// `/responses/input_tokens` for an exact input-token count. Output
/// tokens use the per-prompt expected and worst-case caps to bracket
/// predicted vs upper-bound cost. Plan §7.
#[tauri::command]
pub async fn estimate_normalise_cost_cmd(
    folder_path: String,
    items: Vec<normalise::NormaliseRequestItem>,
    enabled_groups: Vec<normalise::NormaliseGroup>,
    app: AppHandle,
    normalise_state: State<'_, normalise::NormaliseState>,
) -> Result<(), String> {
    let _ = folder_path;
    let cancel_flag = normalise_state.install();

    let wants_ai = enabled_groups.contains(&normalise::NormaliseGroup::Description)
        || enabled_groups.contains(&normalise::NormaliseGroup::Title);
    let total = items.len();
    log::info!(
        "[normalise] estimate starting total={} wants_ai={}",
        total, wants_ai
    );
    let _ = app.emit(
        "normalise_estimate_started",
        NormaliseEstimateStartedPayload { total },
    );

    // No AI groups enabled → estimate is trivially zero; jump straight
    // to the complete event so the frontend transitions to awaiting-
    // confirm without a preflight round-trip.
    if !wants_ai {
        let _ = app.emit("normalise_estimate_complete", NormaliseEstimateCompletePayload {
            n_images_with_ai_b: 0,
            n_images_with_ai_c: 0,
            n_images_no_ai: total as u32,
            total_input_tokens: 0,
            predicted_cost_usd: 0.0,
            upper_bound_cost_usd: 0.0,
            model: String::new(),
        });
        normalise_state.clear();
        return Ok(());
    }

    let (client, settings) = make_openai_client(&app).map_err(|e| {
        // Per plan §13: surface the missing-key case to every image so
        // the dialog opens in `done` with a clear failure breakdown.
        let _ = app.emit("normalise_estimate_error", NormaliseEstimateErrorPayload {
            relative_path: "(batch)".to_string(), message: e.clone(),
        });
        normalise_state.clear();
        e
    })?;
    let model = settings.normalise_metadata_model.clone();
    let pricing = openai_describe::pricing_for(&model)
        .ok_or_else(|| format!("no pricing entry for model {}", model))?;
    let normalise_client = openai_normalise::OpenAiNormaliseClient::new(client, model.clone());

    let mut total_input_tokens: u64 = 0;
    let mut n_images_with_ai_b: u32 = 0;
    let mut n_images_with_ai_c: u32 = 0;
    let mut n_images_no_ai: u32 = 0;
    let mut current = 0usize;

    for item in &items {
        if cancel_flag.load(Ordering::Relaxed) {
            normalise_state.clear();
            return Err("Cancelled by user".into());
        }
        current += 1;

        let capturing = normalise::CapturingAiClient::default();
        let (_e, _s, _err, _calls) = normalise::process_image(
            item,
            &enabled_groups,
            Some(&capturing as &dyn normalise::NormaliseAiClient),
            Some(&cancel_flag),
        )
        .await;

        let description_prompts = capturing.description_prompts.lock().await.clone();
        let title_prompts = capturing.title_prompts.lock().await.clone();
        let fires_description_ai = !description_prompts.is_empty();
        let fires_title_ai = !title_prompts.is_empty();

        let mut per_image_input_tokens: u32 = 0;
        for prompt in &description_prompts {
            let body = normalise_client.description_request_body(prompt);
            let n = normalise_client.count_input_tokens(&body).await.map_err(|e| {
                let _ = app.emit("normalise_estimate_error", NormaliseEstimateErrorPayload {
                    relative_path: item.rel_path.clone(), message: e.clone(),
                });
                format!("{}: {}", item.rel_path, e)
            })?;
            per_image_input_tokens = per_image_input_tokens.saturating_add(n);
        }
        for prompt in &title_prompts {
            let body = normalise_client.title_request_body(prompt);
            let n = normalise_client.count_input_tokens(&body).await.map_err(|e| {
                let _ = app.emit("normalise_estimate_error", NormaliseEstimateErrorPayload {
                    relative_path: item.rel_path.clone(), message: e.clone(),
                });
                format!("{}: {}", item.rel_path, e)
            })?;
            per_image_input_tokens = per_image_input_tokens.saturating_add(n);
        }

        if fires_description_ai { n_images_with_ai_b += 1; }
        if fires_title_ai { n_images_with_ai_c += 1; }
        if !fires_description_ai && !fires_title_ai { n_images_no_ai += 1; }
        total_input_tokens += per_image_input_tokens as u64;

        let _ = app.emit("normalise_estimate_progress", NormaliseEstimateProgressPayload {
            current, total, relative_path: item.rel_path.clone(),
            input_tokens: per_image_input_tokens,
            fires_description_ai, fires_title_ai,
        });
    }

    // Predicted = expected-output tokens. Upper bound = max-output tokens.
    // Output-token-only spread per plan §7 ("predicted vs upper bound
    // reflects only output-token uncertainty").
    let expected_out_per_call_b: u32 = 250;
    let max_out_per_call_b: u32 = openai_normalise::DESCRIPTION_OUTPUT_TOKENS;
    let expected_out_per_call_c: u32 = 15;
    let max_out_per_call_c: u32 = openai_normalise::TITLE_OUTPUT_TOKENS;
    let predicted_out_total =
        n_images_with_ai_b as u64 * expected_out_per_call_b as u64
            + n_images_with_ai_c as u64 * expected_out_per_call_c as u64;
    let upper_out_total =
        n_images_with_ai_b as u64 * max_out_per_call_b as u64
            + n_images_with_ai_c as u64 * max_out_per_call_c as u64;
    let predicted_cost = (total_input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m
        + (predicted_out_total as f64 / 1_000_000.0) * pricing.output_per_1m;
    let upper_bound = (total_input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m
        + (upper_out_total as f64 / 1_000_000.0) * pricing.output_per_1m;

    log::info!(
        "[normalise] estimate complete b={} c={} no_ai={} input_tokens={} predicted=${:.6} upper=${:.6}",
        n_images_with_ai_b, n_images_with_ai_c, n_images_no_ai,
        total_input_tokens, predicted_cost, upper_bound,
    );
    let _ = app.emit("normalise_estimate_complete", NormaliseEstimateCompletePayload {
        n_images_with_ai_b, n_images_with_ai_c, n_images_no_ai,
        total_input_tokens,
        predicted_cost_usd: predicted_cost,
        upper_bound_cost_usd: upper_bound,
        model,
    });
    normalise_state.clear();
    Ok(())
}

/// Normalise metadata for a batch of images.
#[tauri::command]
pub async fn normalise_metadata_cmd(
    folder_path: String,
    items: Vec<normalise::NormaliseRequestItem>,
    enabled_groups: Vec<normalise::NormaliseGroup>,
    app: AppHandle,
    normalise_state: State<'_, normalise::NormaliseState>,
) -> Result<(), String> {
    let _ = folder_path; // resolution happens client-side
    let cancel_flag = normalise_state.install();
    let total = items.len();
    log::info!("[normalise] starting total={} groups={:?}", total, enabled_groups);

    // Plan §1 Group B / Group C require an OpenAI key when their AI
    // branches fire. We construct the client up-front when either group
    // is enabled; per-image AI failures surface as failure rows instead
    // of aborting the batch.
    let wants_ai = enabled_groups.contains(&normalise::NormaliseGroup::Description)
        || enabled_groups.contains(&normalise::NormaliseGroup::Title);
    let ai_client: Option<openai_normalise::OpenAiNormaliseClient> = if wants_ai {
        match make_openai_client(&app) {
            Ok((client, settings)) => Some(openai_normalise::OpenAiNormaliseClient::new(
                client,
                settings.normalise_metadata_model.clone(),
            )),
            Err(e) => {
                log::warn!(
                    "[normalise] AI client unavailable ({}); per-image AI branches will fail",
                    e
                );
                None
            }
        }
    } else {
        None
    };

    let emitter = batch_job::BatchProgressEmitter::new(&app, "normalise");
    emitter.started(total);

    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<batch_job::BatchFailureRow> = Vec::new();
    let mut summary = normalise::NormaliseSummary::default();
    let mut current = 0usize;

    for item in &items {
        if cancel_flag.load(Ordering::Relaxed) {
            log::info!("[normalise] cancelled at {}/{}", current, total);
            break;
        }
        current += 1;
        let rel = item.rel_path.clone();
        let ai_ref = ai_client.as_ref().map(|c| c as &dyn normalise::NormaliseAiClient);
        let (edits, stats, ai_err, ai_calls) =
            normalise::process_image(item, &enabled_groups, ai_ref, Some(&cancel_flag)).await;
        summary.accumulate(&stats);
        let all_noop = edits.is_empty();

        // Plan §6: append one audit-log row per AI call (success or
        // failure). Audit failures are logged-and-swallowed — they
        // should not abort the user's batch.
        let loc_conflicts = stats
            .per_group
            .get(&normalise::NormaliseGroup::Location)
            .map(|s| s.n_location_xmp_iim_conflict)
            .unwrap_or(0);
        let date_conflicts = stats
            .per_group
            .get(&normalise::NormaliseGroup::Dates)
            .map(|s| s.n_date_conflict)
            .unwrap_or(0);
        let needs_conflict_rows = loc_conflicts > 0 || date_conflicts > 0;
        if !ai_calls.is_empty() || needs_conflict_rows {
            if let Ok(app_dir) = app_data_dir(&app) {
                let log_path = app_dir.join("normalise_audit.jsonl");
                let now = chrono::Utc::now().to_rfc3339();
                let model_name = ai_client.as_ref().map(|c| c.model().to_string())
                    .unwrap_or_default();
                let pricing = openai_describe::pricing_for(&model_name);
                // Conflict-counter rows (user-requested archaeology).
                if loc_conflicts > 0 {
                    let entry = normalise::NormaliseAuditEntry {
                        ts: now.clone(),
                        model: String::new(),
                        prompt_version: openai_normalise::NORMALISE_PROMPT_VERSION.to_string(),
                        group: "location_conflict".into(),
                        input_tokens: 0,
                        output_tokens: 0,
                        cost_usd: 0.0,
                        error: format!(
                            "{} pair(s) XMP↔IIM diverged; primary won",
                            loc_conflicts,
                        ),
                        relative_path: rel.clone(),
                    };
                    let _ = batch_audit_log::append(&log_path, &entry);
                }
                if date_conflicts > 0 {
                    let entry = normalise::NormaliseAuditEntry {
                        ts: now.clone(),
                        model: String::new(),
                        prompt_version: openai_normalise::NORMALISE_PROMPT_VERSION.to_string(),
                        group: "date_conflict".into(),
                        input_tokens: 0,
                        output_tokens: 0,
                        cost_usd: 0.0,
                        error: format!(
                            "{} date sub-group(s) diverged; primary won",
                            date_conflicts,
                        ),
                        relative_path: rel.clone(),
                    };
                    let _ = batch_audit_log::append(&log_path, &entry);
                }
                for call in &ai_calls {
                    let cost = pricing
                        .map(|p| {
                            (call.usage.input_tokens as f64 / 1_000_000.0) * p.input_per_1m
                                + (call.usage.output_tokens as f64 / 1_000_000.0) * p.output_per_1m
                        })
                        .unwrap_or(0.0);
                    let entry = normalise::NormaliseAuditEntry {
                        ts: now.clone(),
                        model: model_name.clone(),
                        prompt_version: openai_normalise::NORMALISE_PROMPT_VERSION.to_string(),
                        group: call.group.to_string(),
                        input_tokens: call.usage.input_tokens,
                        output_tokens: call.usage.output_tokens,
                        cost_usd: cost,
                        error: call.error.clone().unwrap_or_default(),
                        relative_path: rel.clone(),
                    };
                    // Plan §10: roll each AI call's cost into the
                    // whole-batch totals so the done panel can show
                    // `aiCostTotalUsd` / `aiCallsTotal`.
                    summary.record_ai_call(cost);
                    if let Err(e) = batch_audit_log::append(&log_path, &entry) {
                        log::warn!("[normalise] audit-log append failed for {}: {}", rel, e);
                    }
                }
            } else {
                // No app-data dir: still record cost into the summary
                // so the done panel doesn't lose the AI-cost total.
                let model_name = ai_client.as_ref().map(|c| c.model().to_string())
                    .unwrap_or_default();
                let pricing = openai_describe::pricing_for(&model_name);
                for call in &ai_calls {
                    let cost = pricing
                        .map(|p| {
                            (call.usage.input_tokens as f64 / 1_000_000.0) * p.input_per_1m
                                + (call.usage.output_tokens as f64 / 1_000_000.0) * p.output_per_1m
                        })
                        .unwrap_or(0.0);
                    summary.record_ai_call(cost);
                }
            }
        }

        if let Some(err) = ai_err {
            // Plan §8: AI failures do not abort the batch; non-AI
            // groups for the same image still wrote their drafts.
            // Surface as a per-image failure row in addition to the
            // succeeded edits.
            let detail = err.detail.clone();
            let kind = err.kind;
            log::warn!("[normalise] ({}/{}) AI failure for {}: {}", current, total, rel, detail);
            if all_noop {
                emitter.progress(current, total, &rel, kind.as_wire(), Some(&detail), None);
            } else {
                emitter.progress(
                    current,
                    total,
                    &rel,
                    kind.as_wire(),
                    Some(&detail),
                    Some(&edits),
                );
            }
            failed.push(batch_job::BatchFailureRow {
                relative_path: rel.clone(),
                kind,
                detail,
            });
            continue;
        }

        if all_noop {
            summary.n_skipped_all_normalised += 1;
            emitter.progress(current, total, &rel, "ok", None, None);
        } else {
            emitter.progress(current, total, &rel, "ok", None, Some(&edits));
        }
        succeeded.push(rel);
    }
    summary.n_succeeded = succeeded.len() as u32;
    summary.n_failed = failed.len() as u32;

    let groups_normalised_total: u32 = summary
        .per_group
        .values()
        .map(|s| s.n_normalised_deterministic + s.n_normalised_ai)
        .sum();
    log::info!(
        "[normalise] finished succeeded={} failed={} groups_normalised_total={} ai_calls={} ai_cost=${:.6}",
        summary.n_succeeded, summary.n_failed, groups_normalised_total,
        summary.ai_calls_total, summary.ai_cost_total_usd,
    );

    normalise_state.clear();
    emitter.complete(&succeeded, &failed, &summary);
    Ok(())
}

#[tauri::command]
pub fn cancel_normalise_cmd(
    normalise_state: State<'_, normalise::NormaliseState>,
) -> Result<(), String> {
    normalise_state.signal_cancel();
    Ok(())
}
