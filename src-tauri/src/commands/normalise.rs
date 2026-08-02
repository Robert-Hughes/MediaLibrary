//! Metadata-normalisation commands.
//!
//! See `docs/NORMALISE_METADATA_PLAN.md` §8. `normalise_metadata_cmd`
//! walks the supplied items through `normalise::process_image`, emits
//! per-item progress events, and accumulates a `NormaliseSummary`. §7
//! `estimate_normalise_cost_cmd` walks every image with a capturing
//! AI client that doesn't dispatch and preflights each fire-able AI
//! prompt through `/responses/input_tokens` for an exact cost preview.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::batch_audit_log;
use crate::batch_job;
use crate::commands::shared::{app_data_dir, make_openai_http};
use crate::normalise;
use crate::openai_describe;
use crate::openai_normalise;
use crate::settings::AiCostEstimateMode;

#[derive(Clone, Serialize)]
struct NormaliseEstimateStartedPayload {
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NormaliseEstimateProgressPayload {
    current: usize,
    total: usize,
    relative_path: String,
    /// Token total preflighted for this image across any AI calls that
    /// would fire (Groups B, C, and G).
    input_tokens: u32,
    /// True when this image would invoke Group B (description merge).
    fires_description_ai: bool,
    /// True when this image would invoke Group C (title generation).
    fires_title_ai: bool,
    /// True when this image would invoke Group G location resolution.
    fires_location_ai: bool,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct PerGroupOutcomeCounts {
    n_noop: u32,
    n_normalised_deterministic: u32,
    n_normalised_ai: u32,
    n_conflict: u32,
    /// Count of fields, summed across all images, that currently have
    /// a non-empty effective value and would be replaced by a
    /// different value (or removed). For AI-fired groups we don't know
    /// the eventual value, so we assume "always different".
    n_overwrites: u32,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct EstimateAiTokenBreakdown {
    description_input_tokens: u64,
    title_input_tokens: u64,
    location_input_tokens: u64,
    description_call_count: u32,
    title_call_count: u32,
    location_call_count: u32,
}

#[derive(Clone, Serialize)]
struct EstimatePricing {
    // Explicit renames: serde's camelCase derivation produces `inputPer1m`
    // (lowercase 'm') because '1' isn't a letter it can capitalise, which
    // would silently break the frontend cost recompute.
    #[serde(rename = "inputPer1M")]
    input_per_1m: f64,
    #[serde(rename = "cachedInputPer1M")]
    cached_input_per_1m: f64,
    #[serde(rename = "cacheWriteInputPer1M")]
    cache_write_input_per_1m: f64,
    #[serde(rename = "outputPer1M")]
    output_per_1m: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NormaliseEstimateCompletePayload {
    n_images_with_ai_b: u32,
    n_images_with_ai_c: u32,
    n_images_with_ai_g: u32,
    n_images_no_ai: u32,
    total_input_tokens: u64,
    predicted_cost_usd: f64,
    upper_bound_cost_usd: f64,
    model: String,
    location_model: String,
    /// Per-group outcome counts collected by walking every image
    /// through every group (regardless of user selection). Powers the
    /// confirm-phase outcome table; selection changes recompute cost
    /// client-side from `ai_token_breakdown` + `pricing` without
    /// re-walking.
    per_group_outcomes: BTreeMap<normalise::NormaliseGroup, PerGroupOutcomeCounts>,
    /// Files where existing effective IPTC is present without a UTF-8
    /// marker, independent of any semantic group selected in the dialog.
    iptc_utf8_base_applicable_paths: Vec<String>,
    /// Files where each semantic group actually emitted IPTC while the
    /// effective marker was not already UTF-8. The frontend unions the
    /// selected groups to keep IPTC UTF-8 applicability selection-aware.
    iptc_utf8_output_paths_by_group: BTreeMap<normalise::NormaliseGroup, Vec<String>>,
    /// AI input-token totals split by which AI branch fires. Frontend
    /// uses this to recompute cost when the user toggles Description /
    /// Title rows. `None` when the API key is missing (we still walk
    /// for outcome counts, but cannot preflight).
    ai_token_breakdown: Option<EstimateAiTokenBreakdown>,
    /// Pricing constants for the configured model. `None` when no
    /// preflight ran (no key, or no AI prompts captured).
    pricing: Option<EstimatePricing>,
    location_pricing: Option<EstimatePricing>,
    /// Output-token caps for client-side cost recomputation.
    expected_out_per_call_b: u32,
    max_out_per_call_b: u32,
    expected_out_per_call_c: u32,
    max_out_per_call_c: u32,
    expected_out_per_call_g: u32,
    max_out_per_call_g: u32,
    location_cache_prefix_tokens: u32,
    location_cache_partitions: u32,
}

#[derive(Clone, Serialize)]
struct NormaliseEstimateErrorPayload {
    relative_path: String,
    message: String,
}

/// Count fields in `group` whose current effective value (from the
/// per-image input bundle) is non-empty AND would be replaced by a
/// different value (or removed entirely) when the group fires. For
/// AI-fired groups (Description case 4, Title case 3) the eventual
/// value isn't known, so assume "always different" per spec.
///
/// `edits` is the full set of draft edits returned by
/// `process_image`; tags from different groups don't collide so we
/// pick out this group's writes by tag name.
fn count_overwrites_for_group(
    group: normalise::NormaliseGroup,
    inputs: &normalise::GroupInputs,
    edits: &crate::draft_edits::SchemaMetadataEditMap,
    fires_description_ai: bool,
    fires_title_ai: bool,
    fires_location_ai: bool,
) -> u32 {
    use crate::draft_edits::EditIntent;
    use crate::metadata_value::MetadataValue;
    use normalise::NormaliseGroup as G;

    let assume_ai = match group {
        G::Description => fires_description_ai,
        G::Title => fires_title_ai,
        G::Location => fires_location_ai,
        _ => false,
    };

    let scalar = |id: crate::tag_schema::SchemaDefinitionId, current: Option<&str>| -> u32 {
        let current = match current.filter(|s| !s.is_empty()) {
            Some(s) => s,
            None => return 0,
        };
        if assume_ai {
            return 1;
        }
        match edits.get(&id) {
            None => 0,
            Some(e) => match e.intent {
                EditIntent::Delete => 1,
                EditIntent::Set => match e.value.as_ref() {
                    Some(MetadataValue::Text(s)) if s == current => 0,
                    None => 0,
                    _ => 1,
                },
                _ => 0,
            },
        }
    };

    let scalar_value =
        |id: crate::tag_schema::SchemaDefinitionId, current: Option<&MetadataValue>| -> u32 {
            let current = match current {
                Some(MetadataValue::Null) | None => return 0,
                Some(MetadataValue::Text(s)) if s.is_empty() => return 0,
                Some(v) => v,
            };
            match edits.get(&id) {
                None => 0,
                Some(e) => match e.intent {
                    EditIntent::Delete => 1,
                    EditIntent::Set => match e.value.as_ref() {
                        Some(value) if value == current => 0,
                        None => 0,
                        _ => 1,
                    },
                    _ => 0,
                },
            }
        };

    let list = |id: crate::tag_schema::SchemaDefinitionId, current: &[String]| -> u32 {
        if current.is_empty() {
            return 0;
        }
        if assume_ai {
            return 1;
        }
        match edits.get(&id) {
            None => 0,
            Some(e) => match e.intent {
                EditIntent::Delete => 1,
                EditIntent::Set => match e.value.as_ref() {
                    Some(MetadataValue::List { items, .. }) => {
                        let same = items.len() == current.len()
                            && items
                                .iter()
                                .zip(current.iter())
                                .all(|(v, c)| matches!(v, MetadataValue::Text(s) if s == c));
                        if same {
                            0
                        } else {
                            1
                        }
                    }
                    None => 0,
                    _ => 1,
                },
                _ => 0,
            },
        }
    };

    match group {
        G::Keywords => match &inputs.keywords {
            None => 0,
            Some(b) => {
                list(
                    crate::known_ids::xmp_hierarchical_subject(),
                    &b.hierarchical_subject,
                ) + list(crate::known_ids::xmp_subject(), &b.dc_subject)
                    + list(crate::known_ids::iptc_keywords(), &b.iptc_keywords)
            }
        },
        G::Creator => match &inputs.creator {
            None => 0,
            Some(b) => {
                list(crate::known_ids::xmp_creator(), &b.creator)
                    + scalar(crate::known_ids::artist(), b.artist.as_deref())
                    + list(crate::known_ids::iptc_by_line(), &b.byline)
            }
        },
        G::Copyright => match &inputs.copyright {
            None => 0,
            Some(b) => {
                scalar(crate::known_ids::xmp_rights(), b.rights.as_deref())
                    + scalar(crate::known_ids::copyright(), b.exif_copyright.as_deref())
                    + scalar(
                        crate::known_ids::iptc_copyright(),
                        b.iptc_copyright.as_deref(),
                    )
            }
        },
        G::IptcUtf8 => match &inputs.iptc_utf8 {
            None
            | Some(normalise::IptcUtf8Input {
                has_iptc: false, ..
            }) => 0,
            Some(b) if matches!(b.coded_character_set.as_deref(), Some("UTF8" | "\u{1b}%G")) => 0,
            Some(b) => scalar(
                crate::known_ids::iptc_coded_character_set(),
                b.coded_character_set.as_deref(),
            ),
        },
        G::Headline => match &inputs.headline {
            None => 0,
            Some(b) => {
                scalar(
                    crate::known_ids::xmp_headline(),
                    b.photoshop_headline.as_deref(),
                ) + scalar(
                    crate::known_ids::iptc_headline(),
                    b.iptc_headline.as_deref(),
                )
            }
        },
        G::Title => match &inputs.title {
            None => 0,
            Some(b) => {
                scalar(crate::known_ids::xmp_title(), b.title.as_deref())
                    + scalar(
                        crate::known_ids::iptc_object_name(),
                        b.object_name.as_deref(),
                    )
            }
        },
        G::Location => match &inputs.location {
            None => 0,
            Some(b) => {
                scalar_value(
                    crate::known_ids::xmp_location_created(),
                    b.location_created.as_ref(),
                ) + scalar(crate::known_ids::xmp_location(), b.location_xmp.as_deref())
                    + scalar(
                        crate::known_ids::iptc_sub_location(),
                        b.location_iptc.as_deref(),
                    )
                    + scalar(crate::known_ids::xmp_city(), b.city_xmp.as_deref())
                    + scalar(crate::known_ids::iptc_city(), b.city_iptc.as_deref())
                    + scalar(crate::known_ids::xmp_state(), b.state_xmp.as_deref())
                    + scalar(
                        crate::known_ids::iptc_province_state(),
                        b.state_iptc.as_deref(),
                    )
                    + scalar(crate::known_ids::xmp_country(), b.country_xmp.as_deref())
                    + scalar(
                        crate::known_ids::iptc_country_name(),
                        b.country_iptc.as_deref(),
                    )
                    + scalar(
                        crate::known_ids::xmp_country_code(),
                        b.country_code_xmp.as_deref(),
                    )
                    + scalar(
                        crate::known_ids::iptc_country_code(),
                        b.country_code_iptc.as_deref(),
                    )
            }
        },
        G::Dates => match &inputs.dates {
            None => 0,
            Some(b) => {
                scalar_value(
                    crate::known_ids::date_time_original(),
                    b.date_time_original.as_ref(),
                ) + scalar_value(
                    crate::known_ids::xmp_date_created(),
                    b.photoshop_date_created.as_ref(),
                ) + scalar_value(
                    crate::known_ids::iptc_date_created(),
                    b.iptc_date_created.as_ref(),
                ) + scalar_value(
                    crate::known_ids::iptc_time_created(),
                    b.iptc_time_created.as_ref(),
                ) + scalar_value(crate::known_ids::create_date(), b.create_date.as_ref())
                    + scalar_value(
                        crate::known_ids::xmp_create_date(),
                        b.xmp_create_date.as_ref(),
                    )
                    + scalar_value(
                        crate::known_ids::iptc_digital_creation_date(),
                        b.iptc_digital_creation_date.as_ref(),
                    )
                    + scalar_value(
                        crate::known_ids::iptc_digital_creation_time(),
                        b.iptc_digital_creation_time.as_ref(),
                    )
            }
        },
        G::Description => match &inputs.description {
            None => 0,
            Some(b) => {
                scalar(
                    crate::known_ids::xmp_description(),
                    b.description.as_deref(),
                ) + scalar(
                    crate::known_ids::image_description(),
                    b.image_description.as_deref(),
                ) + scalar(
                    crate::known_ids::iptc_caption(),
                    b.caption_abstract.as_deref(),
                )
            }
        },
    }
}

/// Preflight cost estimation for `normalise_metadata_cmd`. Walks every
/// image with a `CapturingAiClient` so we know which AI calls would
/// fire; preflights each captured prompt against
/// `/responses/input_tokens` for an exact input-token count. Output
/// tokens use the per-prompt expected and worst-case caps to bracket
/// predicted vs upper-bound cost. Plan §7.
#[tauri::command]
pub async fn estimate_normalise_cost_cmd(
    session_id: u64,
    folder_path: String,
    items: Vec<normalise::NormaliseRequestItem>,
    enabled_groups: Vec<normalise::NormaliseGroup>,
    app: AppHandle,
    normalise_state: State<'_, normalise::NormaliseState>,
) -> Result<(), String> {
    let _ = folder_path;
    let _ = enabled_groups; // estimate always walks every group; selection is applied client-side
    let cancel_flag = normalise_state.install();

    let total = items.len();
    log::info!("[normalise] estimate starting total={}", total);
    let requested_paths = items.iter().map(|item| item.rel_path.clone()).collect();
    let emitter = batch_job::BatchProgressEmitter::begin(
        &app,
        "normalise",
        session_id,
        crate::session::MediaLibraryBatchOperationPhase::Estimating,
        requested_paths,
        Some(serde_json::to_value(&items).map_err(|error| error.to_string())?),
        None,
    )?;
    emitter.estimate_started(total);
    let _ = app.emit(
        "normalise_estimate_started",
        NormaliseEstimateStartedPayload { total },
    );

    // Always walk every group so the confirm-phase outcome table has
    // counts for every row. The user's selection is honoured client-
    // side: cost is recomputed from `ai_token_breakdown` + `pricing`.
    let all_groups: Vec<normalise::NormaliseGroup> = normalise::NormaliseGroup::ALL.to_vec();

    // Preflight client is optional: when no API key is configured we
    // still walk for outcome counts but emit `ai_token_breakdown=None`
    // so the frontend renders an "API key required" notice if the user
    // selects an AI group.
    let preflight = match make_openai_http(&app) {
        Ok((http, settings)) => {
            let metadata_model = settings.normalise_metadata_model.clone();
            let location_model = settings.normalise_location_model.clone();
            match (
                openai_describe::pricing_for(&metadata_model),
                openai_describe::pricing_for(&location_model),
            ) {
                (Some(metadata_pricing), Some(location_pricing)) => Some((
                    openai_normalise::OpenAiNormaliseClient::with_models(
                        http,
                        metadata_model.clone(),
                        location_model.clone(),
                    ),
                    metadata_model,
                    metadata_pricing,
                    location_model,
                    location_pricing,
                    settings.ai_cost_estimate_mode,
                )),
                _ => {
                    log::warn!(
                        "[normalise] estimate: missing pricing for metadata model {} or location model {}; skipping preflight",
                        metadata_model,
                        location_model
                    );
                    None
                }
            }
        }
        Err(e) => {
            log::info!("[normalise] estimate: preflight skipped ({})", e);
            None
        }
    };

    let mut per_group_outcomes: BTreeMap<normalise::NormaliseGroup, PerGroupOutcomeCounts> =
        BTreeMap::new();
    let mut description_input_tokens: u64 = 0;
    let mut title_input_tokens: u64 = 0;
    let mut location_input_tokens: u64 = 0;
    let mut n_images_with_ai_b: u32 = 0;
    let mut n_images_with_ai_c: u32 = 0;
    let mut n_images_with_ai_g: u32 = 0;
    let mut n_images_no_ai: u32 = 0;
    let mut iptc_utf8_base_applicable_paths = Vec::new();
    let mut iptc_utf8_output_paths_by_group: BTreeMap<normalise::NormaliseGroup, Vec<String>> =
        BTreeMap::new();
    for (index, item) in items.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            normalise_state.clear();
            emitter.fail("Cancelled by user");
            return Err("Cancelled by user".into());
        }
        let current = index + 1;

        let capturing = normalise::CapturingAiClient::default();
        let (edits, stats, _err, _calls) = normalise::process_image(
            item,
            &all_groups,
            Some(&capturing as &dyn normalise::NormaliseAiClient),
            Some(&cancel_flag),
        )
        .await;

        let description_prompts = capturing.description_prompts.lock().await.clone();
        let title_prompts = capturing.title_prompts.lock().await.clone();
        let location_prompts = capturing.location_prompts.lock().await.clone();
        let fires_description_ai = !description_prompts.is_empty();
        let fires_title_ai = !title_prompts.is_empty();
        let fires_location_ai = !location_prompts.is_empty();

        let iptc_input = item.group_inputs.iptc_utf8.as_ref();
        let marker_is_utf8 = iptc_input.is_some_and(|input| {
            matches!(
                input.coded_character_set.as_deref(),
                Some("UTF8" | "\u{1b}%G")
            )
        });
        if !marker_is_utf8 {
            if iptc_input.is_some_and(|input| input.has_iptc) {
                iptc_utf8_base_applicable_paths.push(item.rel_path.clone());
            }
            for group in &stats.iptc_output_groups {
                iptc_utf8_output_paths_by_group
                    .entry(*group)
                    .or_default()
                    .push(item.rel_path.clone());
            }
        }

        // Roll per-image stats into the outcome map. PerGroupStats
        // counters are 0/1 at the per-image scale; this turns them
        // into per-batch totals. Overwrites are computed here by
        // diffing the emitted drafts against the per-image input
        // bundle.
        for (group, gs) in &stats.per_group {
            let entry = per_group_outcomes.entry(*group).or_default();
            entry.n_noop += gs.n_noop;
            entry.n_normalised_deterministic += gs.n_normalised_deterministic;
            entry.n_normalised_ai += gs.n_normalised_ai;
            entry.n_conflict += gs.n_conflict_primary_won;
            // Only count overwrites when the group actually wrote
            // something (idempotency no-ops skip the comparison).
            if gs.n_normalised_deterministic + gs.n_normalised_ai > 0 {
                entry.n_overwrites += count_overwrites_for_group(
                    *group,
                    &item.group_inputs,
                    &edits,
                    fires_description_ai,
                    fires_title_ai,
                    fires_location_ai,
                );
            }
        }

        let mut per_image_input_tokens: u32 = 0;
        if let Some((normalise_client, _, _, _, _, estimate_mode)) = preflight.as_ref() {
            for prompt in &description_prompts {
                let n = match estimate_mode {
                    AiCostEstimateMode::Heuristic => {
                        openai_normalise::HEURISTIC_DESCRIPTION_INPUT_TOKENS
                    }
                    AiCostEstimateMode::Exact => {
                        let body = normalise_client.description_request_body(prompt);
                        normalise_client
                            .count_input_tokens(&body)
                            .await
                            .map_err(|e| {
                                let _ = app.emit(
                                    "normalise_estimate_error",
                                    NormaliseEstimateErrorPayload {
                                        relative_path: item.rel_path.clone(),
                                        message: e.clone(),
                                    },
                                );
                                let error = format!("{}: {}", item.rel_path, e);
                                emitter.fail(error.clone());
                                error
                            })?
                    }
                };
                description_input_tokens += n as u64;
                per_image_input_tokens = per_image_input_tokens.saturating_add(n);
            }
            for prompt in &title_prompts {
                let n = match estimate_mode {
                    AiCostEstimateMode::Heuristic => openai_normalise::HEURISTIC_TITLE_INPUT_TOKENS,
                    AiCostEstimateMode::Exact => {
                        let body = normalise_client.title_request_body(prompt);
                        normalise_client
                            .count_input_tokens(&body)
                            .await
                            .map_err(|e| {
                                let _ = app.emit(
                                    "normalise_estimate_error",
                                    NormaliseEstimateErrorPayload {
                                        relative_path: item.rel_path.clone(),
                                        message: e.clone(),
                                    },
                                );
                                let error = format!("{}: {}", item.rel_path, e);
                                emitter.fail(error.clone());
                                error
                            })?
                    }
                };
                title_input_tokens += n as u64;
                per_image_input_tokens = per_image_input_tokens.saturating_add(n);
            }
            for prompt in &location_prompts {
                let n = match estimate_mode {
                    AiCostEstimateMode::Heuristic => {
                        openai_normalise::HEURISTIC_LOCATION_INPUT_TOKENS
                    }
                    AiCostEstimateMode::Exact => {
                        let body = normalise_client.location_request_body(prompt);
                        normalise_client
                            .count_input_tokens(&body)
                            .await
                            .map_err(|e| {
                                let _ = app.emit(
                                    "normalise_estimate_error",
                                    NormaliseEstimateErrorPayload {
                                        relative_path: item.rel_path.clone(),
                                        message: e.clone(),
                                    },
                                );
                                let error = format!("{}: {}", item.rel_path, e);
                                emitter.fail(error.clone());
                                error
                            })?
                    }
                };
                location_input_tokens += n as u64;
                per_image_input_tokens = per_image_input_tokens.saturating_add(n);
            }
        }

        if fires_description_ai {
            n_images_with_ai_b += 1;
        }
        if fires_title_ai {
            n_images_with_ai_c += 1;
        }
        if fires_location_ai {
            n_images_with_ai_g += 1;
        }
        if !fires_description_ai && !fires_title_ai && !fires_location_ai {
            n_images_no_ai += 1;
        }

        emitter.estimate_progress(current, total, &item.rel_path, None);
        let _ = app.emit(
            "normalise_estimate_progress",
            NormaliseEstimateProgressPayload {
                current,
                total,
                relative_path: item.rel_path.clone(),
                input_tokens: per_image_input_tokens,
                fires_description_ai,
                fires_title_ai,
                fires_location_ai,
            },
        );
    }

    // Predicted = calibrated expected output plus the explicit location-cache
    // warm-up/read model. Upper = uncached input plus calibrated likely-high
    // output, not the deliberately generous runtime generation cap.
    let expected_out_per_call_b: u32 = openai_normalise::EXPECTED_DESCRIPTION_OUTPUT_TOKENS;
    let max_out_per_call_b: u32 = openai_normalise::ESTIMATED_UPPER_DESCRIPTION_OUTPUT_TOKENS;
    let expected_out_per_call_c: u32 = openai_normalise::EXPECTED_TITLE_OUTPUT_TOKENS;
    let max_out_per_call_c: u32 = openai_normalise::ESTIMATED_UPPER_TITLE_OUTPUT_TOKENS;
    let expected_out_per_call_g: u32 = openai_normalise::EXPECTED_LOCATION_OUTPUT_TOKENS;
    let max_out_per_call_g: u32 = openai_normalise::ESTIMATED_UPPER_LOCATION_OUTPUT_TOKENS;

    let total_input_tokens = description_input_tokens + title_input_tokens + location_input_tokens;
    let (
        predicted_cost,
        upper_bound,
        model_out,
        location_model_out,
        pricing_out,
        location_pricing_out,
        breakdown_out,
    ) = if let Some((_, model, pricing, location_model, location_pricing, _)) = preflight.as_ref() {
        let (metadata_predicted, metadata_upper) =
            openai_normalise::estimate_normalise_cost_from_tokens(
                model,
                description_input_tokens,
                title_input_tokens,
                n_images_with_ai_b,
                n_images_with_ai_c,
            )
            .inspect_err(|error| {
                emitter.fail(error.clone());
            })?;
        let (location_predicted, location_upper) =
            openai_normalise::estimate_location_cost_from_tokens(
                location_model,
                location_input_tokens,
                n_images_with_ai_g,
            )
            .inspect_err(|error| {
                emitter.fail(error.clone());
            })?;
        (
            metadata_predicted + location_predicted,
            metadata_upper + location_upper,
            model.clone(),
            location_model.clone(),
            Some(EstimatePricing {
                input_per_1m: pricing.input_per_1m,
                cached_input_per_1m: pricing.cached_input_per_1m,
                cache_write_input_per_1m: pricing.cache_write_input_per_1m,
                output_per_1m: pricing.output_per_1m,
            }),
            Some(EstimatePricing {
                input_per_1m: location_pricing.input_per_1m,
                cached_input_per_1m: location_pricing.cached_input_per_1m,
                cache_write_input_per_1m: location_pricing.cache_write_input_per_1m,
                output_per_1m: location_pricing.output_per_1m,
            }),
            Some(EstimateAiTokenBreakdown {
                description_input_tokens,
                title_input_tokens,
                location_input_tokens,
                description_call_count: n_images_with_ai_b,
                title_call_count: n_images_with_ai_c,
                location_call_count: n_images_with_ai_g,
            }),
        )
    } else {
        (0.0, 0.0, String::new(), String::new(), None, None, None)
    };

    log::info!(
        "[normalise] estimate complete b={} c={} g={} no_ai={} input_tokens={} predicted=${:.6} upper=${:.6}",
        n_images_with_ai_b, n_images_with_ai_c, n_images_with_ai_g, n_images_no_ai,
        total_input_tokens, predicted_cost, upper_bound,
    );
    let estimate = NormaliseEstimateCompletePayload {
        n_images_with_ai_b,
        n_images_with_ai_c,
        n_images_with_ai_g,
        n_images_no_ai,
        total_input_tokens,
        predicted_cost_usd: predicted_cost,
        upper_bound_cost_usd: upper_bound,
        model: model_out,
        location_model: location_model_out,
        per_group_outcomes,
        iptc_utf8_base_applicable_paths,
        iptc_utf8_output_paths_by_group,
        ai_token_breakdown: breakdown_out,
        pricing: pricing_out,
        location_pricing: location_pricing_out,
        expected_out_per_call_b,
        max_out_per_call_b,
        expected_out_per_call_c,
        max_out_per_call_c,
        expected_out_per_call_g,
        max_out_per_call_g,
        location_cache_prefix_tokens: openai_normalise::LOCATION_CACHE_PREFIX_TOKENS,
        location_cache_partitions: openai_normalise::LOCATION_CACHE_PARTITIONS,
    };
    emitter.estimate_complete(&estimate);
    let _ = app.emit("normalise_estimate_complete", estimate);
    normalise_state.clear();
    Ok(())
}

/// Normalise metadata for a batch of images.
#[tauri::command]
pub async fn normalise_metadata_cmd(
    session_id: u64,
    operation_id: String,
    enabled_groups: Vec<normalise::NormaliseGroup>,
    app: AppHandle,
    normalise_state: State<'_, normalise::NormaliseState>,
) -> Result<(), String> {
    let snapshot = app
        .state::<crate::session::MediaLibrarySessionState>()
        .snapshot();
    if snapshot.session_id != Some(session_id) {
        return Err("The media-library session changed before normalisation started".into());
    }
    let operation = snapshot
        .batch_operations
        .get("normalise")
        .filter(|operation| operation.operation_id == operation_id)
        .ok_or_else(|| "The normalise operation identity changed".to_string())?;
    let total = operation.total;
    let emitter = batch_job::BatchProgressEmitter::resume(
        &app,
        "normalise",
        session_id,
        operation_id,
        total,
        batch_job::GeneratedDraftProducer::Normalise {
            enabled_groups: enabled_groups.clone(),
        },
    )?;
    let retained_request = operation
        .request
        .clone()
        .ok_or_else(|| "The normalise operation has no retained request".to_string())
        .inspect_err(|error| {
            emitter.fail(error.clone());
        })?;
    let items: Vec<normalise::NormaliseRequestItem> = serde_json::from_value(retained_request)
        .map_err(|error| format!("The retained normalise request is invalid: {error}"))
        .inspect_err(|error| {
            emitter.fail(error.clone());
        })?;
    if items.len() != total {
        let error = "The retained normalise request count changed".to_string();
        emitter.fail(error.clone());
        return Err(error);
    }
    let cancel_flag = normalise_state.install();

    let settings = app_data_dir(&app)
        .ok()
        .and_then(|d| crate::settings::load_settings(&d).ok())
        .unwrap_or_default();
    let concurrency = std::num::NonZeroUsize::new(usize::from(settings.normalise_concurrency))
        .unwrap_or(std::num::NonZeroUsize::MIN);

    log::info!(
        "[normalise] starting total={} concurrency={} groups={:?}",
        total,
        concurrency,
        enabled_groups
    );

    // Plan §1 Groups B / C / G require an OpenAI key when their AI
    // branches fire. We construct the client up-front when either group
    // is enabled; per-image AI failures surface as failure rows instead
    // of aborting the batch.
    let wants_ai = enabled_groups.contains(&normalise::NormaliseGroup::Description)
        || enabled_groups.contains(&normalise::NormaliseGroup::Title)
        || enabled_groups.contains(&normalise::NormaliseGroup::Location);
    let ai_client: Option<openai_normalise::OpenAiNormaliseClient> = if wants_ai {
        match make_openai_http(&app) {
            Ok((http, settings)) => Some(openai_normalise::OpenAiNormaliseClient::with_models(
                http,
                settings.normalise_metadata_model.clone(),
                settings.normalise_location_model.clone(),
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

    emitter.started(total);

    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<batch_job::BatchFailureRow> = Vec::new();
    let mut summary = normalise::NormaliseSummary::default();
    let mut current = 0usize;
    let mut progress_batch = batch_job::EventBatch::new(20, Duration::from_millis(100), true);

    struct NormaliseItemOutcome {
        item: normalise::NormaliseRequestItem,
        edits: crate::draft_edits::SchemaMetadataEditMap,
        stats: normalise::PerImageStats,
        ai_err: Option<normalise::NormaliseAiError>,
        ai_calls: Vec<normalise::PerImageAiCall>,
    }

    let enabled_groups_arc = std::sync::Arc::new(enabled_groups);
    let ai_client_arc = std::sync::Arc::new(ai_client);

    let _ = batch_job::run_bounded(
        items,
        concurrency,
        cancel_flag,
        {
            let enabled_groups = enabled_groups_arc.clone();
            let ai_client = ai_client_arc.clone();
            move |item| {
                let enabled_groups = enabled_groups.clone();
                let ai_client = ai_client.clone();
                async move {
                    let ai_ref = ai_client
                        .as_ref()
                        .as_ref()
                        .map(|c| c as &dyn normalise::NormaliseAiClient);
                    let (edits, stats, ai_err, ai_calls) =
                        normalise::process_image(&item, &enabled_groups, ai_ref, None).await;
                    NormaliseItemOutcome {
                        item,
                        edits,
                        stats,
                        ai_err,
                        ai_calls,
                    }
                }
            }
        },
        |outcome| {
            current += 1;
            let rel = outcome.item.rel_path;
            let edits = outcome.edits;
            let stats = outcome.stats;
            let ai_err = outcome.ai_err;
            let ai_calls = outcome.ai_calls;

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
                            error: format!("{} pair(s) XMP↔IIM diverged; primary won", loc_conflicts,),
                            relative_path: rel.clone(),
                            ..Default::default()
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
                            ..Default::default()
                        };
                        let _ = batch_audit_log::append(&log_path, &entry);
                    }
                    for call in &ai_calls {
                        let model_name = ai_client_arc
                            .as_ref()
                            .as_ref()
                            .map(|client| {
                                if call.group == "location" {
                                    client.location_model()
                                } else {
                                    client.model()
                                }
                            })
                            .unwrap_or_default()
                            .to_string();
                        let pricing = openai_describe::pricing_for(&model_name);
                        let cost = pricing.map(|p| call.usage.cost(&p)).unwrap_or(0.0);
                        log::info!(
                            "[normalise] ai_call path={} group={} status={} input_tokens={} cached_tokens={} cache_write_tokens={} output_tokens={} reasoning_tokens={} non_reasoning_output_tokens={} service_tier={} reasoning_effort={} cost_usd={}",
                            rel,
                            call.group,
                            if call.error.is_some() { "failed" } else { "ok" },
                            call.usage.input_tokens,
                            call.usage.cached_input_tokens,
                            call.usage.cache_write_input_tokens,
                            call.usage.output_tokens,
                            call.usage.reasoning_tokens,
                            call.usage.non_reasoning_output_tokens(),
                            call.usage.service_tier,
                            call.usage.reasoning_effort,
                            cost
                        );
                        let entry = normalise::NormaliseAuditEntry {
                            ts: now.clone(),
                            model: model_name,
                            prompt_version: openai_normalise::NORMALISE_PROMPT_VERSION.to_string(),
                            group: call.group.to_string(),
                            input_tokens: call.usage.input_tokens,
                            cached_input_tokens: call.usage.cached_input_tokens,
                            cache_write_input_tokens: call.usage.cache_write_input_tokens,
                            output_tokens: call.usage.output_tokens,
                            reasoning_tokens: call.usage.reasoning_tokens,
                            non_reasoning_output_tokens: call.usage.non_reasoning_output_tokens(),
                            service_tier: call.usage.service_tier.clone(),
                            reasoning_effort: call.usage.reasoning_effort.clone(),
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
                    for call in &ai_calls {
                        let model_name = ai_client_arc
                            .as_ref()
                            .as_ref()
                            .map(|client| {
                                if call.group == "location" {
                                    client.location_model()
                                } else {
                                    client.model()
                                }
                            })
                            .unwrap_or_default();
                        let pricing = openai_describe::pricing_for(model_name);
                        let cost = pricing.map(|p| call.usage.cost(&p)).unwrap_or(0.0);
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
                log::warn!(
                    "[normalise] ({}/{}) AI failure for {}: {}",
                    current,
                    total,
                    rel,
                    detail
                );
                let progress = batch_job::BatchMetadataProgress::new(
                    current,
                    total,
                    rel.clone(),
                    kind.as_wire().to_string(),
                    Some(detail.clone()),
                    if all_noop { None } else { Some(&edits) },
                );
                if let Some(results) = progress_batch.push(progress) {
                    emitter.progress_metadata_batch(&results);
                }
                failed.push(batch_job::BatchFailureRow {
                    relative_path: rel.clone(),
                    kind,
                    detail,
                });
                return;
            }

            if all_noop {
                summary.n_skipped_all_normalised += 1;
            }
            let progress = batch_job::BatchMetadataProgress::new(
                current,
                total,
                rel.clone(),
                "ok".to_string(),
                None,
                if all_noop { None } else { Some(&edits) },
            );
            if let Some(results) = progress_batch.push(progress) {
                emitter.progress_metadata_batch(&results);
            }
            succeeded.push(rel);
        },
    )
    .await;
    if let Some(results) = progress_batch.flush() {
        emitter.progress_metadata_batch(&results);
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
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    normalise_state: State<'_, normalise::NormaliseState>,
) -> Result<(), String> {
    let snapshot = app
        .state::<crate::session::MediaLibrarySessionState>()
        .request_batch_operation_cancellation(session_id, &operation_id)?;
    let _ = app.emit(crate::session::SESSION_CHANGED_EVENT, snapshot);
    normalise_state.signal_cancel();
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroUsize;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn parallel_normalise_bounded_execution_and_out_of_order() {
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let active_count = Arc::new(AtomicUsize::new(0));
        let max_active_observed = Arc::new(AtomicUsize::new(0));
        let completed_order = Arc::new(std::sync::Mutex::new(Vec::new()));

        let items: Vec<normalise::NormaliseRequestItem> = (0..10)
            .map(|i| normalise::NormaliseRequestItem {
                rel_path: format!("{}.jpg", i),
                group_inputs: Default::default(),
            })
            .collect();

        let active_count_clone = active_count.clone();
        let max_active_observed_clone = max_active_observed.clone();
        let completed_order_clone = completed_order.clone();

        let concurrency = NonZeroUsize::new(4).unwrap();

        let _ = batch_job::run_bounded(
            items,
            concurrency,
            cancel_flag,
            move |item| {
                let active = active_count_clone.fetch_add(1, Ordering::SeqCst) + 1;
                let mut current_max = max_active_observed_clone.load(Ordering::SeqCst);
                while active > current_max {
                    match max_active_observed_clone.compare_exchange_weak(
                        current_max,
                        active,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    ) {
                        Ok(_) => break,
                        Err(actual) => current_max = actual,
                    }
                }
                let active_count = active_count_clone.clone();
                async move {
                    let item_num: usize =
                        item.rel_path.trim_end_matches(".jpg").parse().unwrap_or(0);
                    if item_num == 0 {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    } else {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    active_count.fetch_sub(1, Ordering::SeqCst);
                    item.rel_path
                }
            },
            |rel_path| {
                completed_order_clone.lock().unwrap().push(rel_path);
            },
        )
        .await;

        let completed = completed_order.lock().unwrap().clone();
        assert_eq!(completed.len(), 10);
        assert!(max_active_observed.load(Ordering::SeqCst) <= 4);
        let pos_0 = completed.iter().position(|r| r == "0.jpg").unwrap();
        let pos_1 = completed.iter().position(|r| r == "1.jpg").unwrap();
        assert!(
            pos_1 < pos_0,
            "Item 1 should complete before Item 0 due to simulated latency"
        );
    }
}
