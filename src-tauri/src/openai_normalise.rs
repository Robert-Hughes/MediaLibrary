//! Text-only OpenAI client for the metadata-normaliser.
//!
//! See `docs/NORMALISE_METADATA_PLAN.md` §6. Three operations:
//!
//! - **Description merge/generation** (Group B case-2 and case-5): combine 2+ distinct
//!   description sources or generate from AI-derived context (when targets are empty)
//!   into a single factual paragraph, with location / keywords / date context to disambiguate.
//! - **Title generation** (Group C case-3): generate a short title-cased
//!   phrase from the canonical description + context.
//! - **Location resolution** (Group G): interpret raw GeocodeJSON and JSONv2
//!   evidence when LocationCreated is absent.
//!
//! All calls hit `/responses` with
//! `text.format: { type: "json_schema" }`, sharing one strict structured
//! response builder and the same transport/error/usage conventions.
//!
//! Image bytes are never sent — visual content is assumed already
//! distilled into the read-only `XMP-mlib:AI*` inputs.

use serde::Deserialize;

use crate::normalise::{
    AiCallUsage, DescriptionMergePrompt, LocationAiResult, LocationResolvePrompt,
    NormaliseAiClient, NormaliseAiError, TitleGenPrompt,
};
use crate::openai_http::OpenAiHttp;
use crate::openai_request::{
    apply_responses_model_parameters, find_output_text, LOW_REASONING_EFFORT,
};

/// Version stamp recorded in the audit log per AI call. Bump when
/// either prompt or schema changes; old log entries retain the prior
/// string for archaeology.
pub const NORMALISE_PROMPT_VERSION: &str = "v7";

const DESCRIPTION_SYSTEM_PROMPT: &str = "You generate or normalise a factual photo description for a personal media library. \
Produce a single factual paragraph in `x-default` English. \
Prefer existing human-authored description sources when present. \
When no human description source is present, use AI-derived context such as `XMP-mlib:AIDescription`, `XMP-mlib:AIInterpretation`, `XMP-mlib:AIOcrText`, and `XMP-mlib:AIObjects`. \
Use location, keywords, and date only as contextual hints. \
Do not invent facts not supported by the supplied inputs. \
Keep it concise, factual, sentence-cased, and non-marketing. \
If sources conflict, prefer the more specific or better-supported statement. \
If an interpretation field contains speculation/mood/intent, only include it if it is clearly useful and phrase it cautiously; otherwise omit it.";

const TITLE_SYSTEM_PROMPT: &str = "You generate a short photo title. \
≤8 words. Title case. No trailing punctuation. \
Use the description as the primary source; use location and keywords for disambiguation.";

const LOCATION_SYSTEM_PROMPT: &str = r#"Convert compact evidence from matching Nominatim formats into one IPTC LocationCreated object. Reconcile both sources without automatic precedence. Return conventional English or commonly anglicised names.
LocationName is a distinct named venue, site, building, landmark, attraction, or geographic feature. A settlement belongs only in City; an ordinary road/path belongs only in Sublocation.
Sublocation: prefer an agreed house-number + road, then an agreed road/path, then a supported neighbourhood or site distinct from City and LocationName. If the sources disagree on the road/address, use neither; fall back to an agreed containing place or null. Do not append City, ProvinceState, or CountryName.
City is the ordinary populated locality: city, town, village, hamlet, or municipality. Prefer explicit populated-place fields. Nominatim values labelled city may actually be councils, districts, communities, or municipal units; interpret them rather than copying mechanically. City must be an explicit supplied locality or a conventional translation, transliteration, or shortening of one; never introduce a different locality name absent from the evidence. Never use a county or unrelated administrative district. For a compound community or municipal-unit label, prefer its primary conventional settlement when that shortening is unambiguous. In the pattern `X-Y Community/Municipal Unit` together with `Municipality of X - Z`, use X as City. Return null when no populated locality is supported.
ProvinceState is the conventional first-order state, province, or region above City, not a county or state district. Remove formatter wrappers such as "Region of" when appropriate.
CountryName is the conventional English country name. WorldRegion must be a stable broad region determined by CountryName: identical countries must produce identical regions; use Europe for European countries rather than subregions such as Southern Europe.
Preserve complete supported proper names, including meaningful qualifiers in parentheses. Use conventional English title capitalization for LocationName without changing its words. Translate or transliterate generic/non-English place wording when the conventional English form is clear. Do not add explanatory wording.
place_rank describes granularity, not confidence; search_importance is only a weak prominence hint. Return null only when evidence is genuinely insufficient.
Before returning, enforce these routing invariants:
- LocationName is null when its only candidate is the City/settlement or an ordinary road/path.
- Sublocation is distinct from both City and LocationName; otherwise it is null.
- When road/address evidence conflicts, do not use either road, but retain an agreed supported neighbourhood or site distinct from City when one exists.

Decision reference:
First classify every candidate by what the evidence says it is, not merely by the field in which a formatter placed it. A populated settlement can be City. A state, province, region, county, district, council, community, civil parish, or other administrative container is not automatically a populated settlement. A venue, building, attraction, monument, fort, hospital, club, station, airport, bridge, or named natural feature can be LocationName. A numbered address, road, lane, path, pedestrian way, or road-like square belongs in Sublocation. A neighbourhood, suburb, quarter, or named site may be Sublocation when it is useful below City.

Then reconcile the two sources. Agreement is strong evidence. When one source is more specific, use that detail only if it is compatible with the other source. When two road names or house-number-and-road combinations conflict, reject both conflicting address candidates. Continue checking their shared neighbourhood, site, populated locality, region, and country instead of discarding all location information. Never combine pieces from conflicting addresses into a new address.

Keep the fields semantic and non-redundant. LocationName identifies what the photo location is; Sublocation says where within the populated locality it is; City is the populated locality; ProvinceState is the first-order division; CountryName is the country; WorldRegion is the stable broad region. Do not move a value into another field merely to avoid null. Do not repeat a venue as Sublocation, repeat City as Sublocation or LocationName, or build comma-separated chains containing higher-level fields.

Use ranking metadata only as supporting context. A detailed place_rank can indicate a finer feature without proving that its name is correct. Higher search_importance can help choose between otherwise equally supported named features, but cannot override source conflict or change a road into a landmark. Preserve evidence-backed spelling and meaningful qualifiers. Conventional translation, transliteration, capitalization, and removal of administrative wrappers are allowed; invention of an unsupported locality is not.

When a field has no supported candidate after this process, return null for that field rather than borrowing a value from another level.

Name handling reference:
Treat a supplied full proper name as an atomic value unless the instructions explicitly permit translation, transliteration, or removal of an administrative wrapper. Keep meaningful text in parentheses and preserve its words and internal capitalization; title capitalization applies to the main English LocationName, not to descriptive text inside parentheses. Do not silently shorten a venue, replace it with a broader complex, expand an acronym, or add a category word that the evidence did not supply. If both sources give variants of a name, prefer the complete compatible variant. If the variants are genuinely different rather than spelling or language variants, do not splice them together.

Hierarchy reference:
Work from the most specific feature outward, but fill each output independently according to its semantic role. A detailed feature can coexist with a containing road, neighbourhood, settlement, region, and country. Specificity does not justify promoting an administrative unit into City or a road into LocationName. Conversely, prominence does not justify discarding a supported detailed feature. Null is correct when the required semantic level is absent, even if adjacent levels are well supported.

Consistency reference:
Apply the same country spelling and WorldRegion mapping throughout the batch. Resolve equivalent source labels the same way when their retained evidence is identical. Prefer a stable literal result over stylistic variation in punctuation or explanatory wording. Return only the six schema fields; the application adds coordinates, country code, and OpenStreetMap identifiers separately."#;

/// Output-token caps for cost-estimation purposes. Mirror plan §6.
pub const DESCRIPTION_OUTPUT_TOKENS: u32 = 400;
pub const TITLE_OUTPUT_TOKENS: u32 = 30;
pub const LOCATION_OUTPUT_TOKENS: u32 = 1_000;
/// Expected output usage calibrated from successful v6 audit rows and the v11
/// location corpus. These are estimates, not runtime generation limits.
pub const EXPECTED_DESCRIPTION_OUTPUT_TOKENS: u32 = 75;
pub const EXPECTED_TITLE_OUTPUT_TOKENS: u32 = 22;
pub const EXPECTED_LOCATION_OUTPUT_TOKENS: u32 = 120;
/// Likely upper output usage used by the confirmation UI. Runtime caps remain
/// deliberately higher so rare reasoning spikes are not truncated.
pub const ESTIMATED_UPPER_DESCRIPTION_OUTPUT_TOKENS: u32 = 150;
pub const ESTIMATED_UPPER_TITLE_OUTPUT_TOKENS: u32 = 30;
pub const ESTIMATED_UPPER_LOCATION_OUTPUT_TOKENS: u32 = 400;
pub const LOCATION_CACHE_PREFIX_TOKENS: u32 = 1_306;
pub const LOCATION_CACHE_PARTITIONS: u32 = 8;
pub const HEURISTIC_DESCRIPTION_INPUT_TOKENS: u32 = 450;
pub const HEURISTIC_TITLE_INPUT_TOKENS: u32 = 215;
pub const HEURISTIC_LOCATION_INPUT_TOKENS: u32 = 1_565;

/// Synthetic typical cost shown next to each model in the settings
/// dropdown. Plan §6: assumes the worst case (both Group B and Group C
/// fire on the same photo) with median prompt sizes. The run-time
/// estimator (§7) computes exact costs from real prompts.
pub fn typical_normalise_cost_per_image(model: &str) -> Option<f64> {
    let p = crate::openai_describe::pricing_for(model)?;
    let b_in = HEURISTIC_DESCRIPTION_INPUT_TOKENS as f64;
    let b_out = EXPECTED_DESCRIPTION_OUTPUT_TOKENS as f64;
    let c_in = HEURISTIC_TITLE_INPUT_TOKENS as f64;
    let c_out = EXPECTED_TITLE_OUTPUT_TOKENS as f64;
    Some(
        ((b_in + c_in) / 1_000_000.0) * p.input_per_1m
            + ((b_out + c_out) / 1_000_000.0) * p.output_per_1m,
    )
}

pub fn typical_location_normalise_cost_per_image(model: &str) -> Option<f64> {
    let pricing = crate::openai_describe::pricing_for(model)?;
    Some(
        (HEURISTIC_LOCATION_INPUT_TOKENS as f64 / 1_000_000.0) * pricing.input_per_1m
            + (EXPECTED_LOCATION_OUTPUT_TOKENS as f64 / 1_000_000.0) * pricing.output_per_1m,
    )
}

pub fn estimate_normalise_cost_from_tokens(
    model: &str,
    description_input_tokens: u64,
    title_input_tokens: u64,
    description_call_count: u32,
    title_call_count: u32,
) -> Result<(f64, f64), String> {
    let p = crate::openai_describe::pricing_for(model)
        .ok_or_else(|| format!("no pricing entry for model {}", model))?;
    let total_input_tokens = description_input_tokens + title_input_tokens;
    let predicted_out_total = description_call_count as u64
        * EXPECTED_DESCRIPTION_OUTPUT_TOKENS as u64
        + title_call_count as u64 * EXPECTED_TITLE_OUTPUT_TOKENS as u64;
    let upper_out_total = description_call_count as u64
        * ESTIMATED_UPPER_DESCRIPTION_OUTPUT_TOKENS as u64
        + title_call_count as u64 * ESTIMATED_UPPER_TITLE_OUTPUT_TOKENS as u64;
    let input_cost = (total_input_tokens as f64 / 1_000_000.0) * p.input_per_1m;
    let predicted = input_cost + (predicted_out_total as f64 / 1_000_000.0) * p.output_per_1m;
    let upper = input_cost + (upper_out_total as f64 / 1_000_000.0) * p.output_per_1m;
    Ok((predicted, upper))
}

pub fn estimate_location_cost_from_tokens(
    model: &str,
    input_tokens: u64,
    call_count: u32,
) -> Result<(f64, f64), String> {
    let pricing = crate::openai_describe::pricing_for(model)
        .ok_or_else(|| format!("no pricing entry for model {}", model))?;
    let cache_writes = call_count.min(LOCATION_CACHE_PARTITIONS) as u64;
    let cache_reads = call_count.saturating_sub(LOCATION_CACHE_PARTITIONS) as u64;
    let (cached_tokens, cache_write_tokens) = if model.starts_with("gpt-5.6") {
        (
            cache_reads * u64::from(LOCATION_CACHE_PREFIX_TOKENS),
            cache_writes * u64::from(LOCATION_CACHE_PREFIX_TOKENS),
        )
    } else {
        (0, 0)
    };
    let non_cached_tokens = input_tokens
        .saturating_sub(cached_tokens)
        .saturating_sub(cache_write_tokens);
    let predicted_input_cost = (non_cached_tokens as f64 / 1_000_000.0) * pricing.input_per_1m
        + (cached_tokens as f64 / 1_000_000.0) * pricing.cached_input_per_1m
        + (cache_write_tokens as f64 / 1_000_000.0) * pricing.cache_write_input_per_1m;
    let uncached_input_cost = (input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m;
    let predicted = predicted_input_cost
        + (call_count as f64 * EXPECTED_LOCATION_OUTPUT_TOKENS as f64 / 1_000_000.0)
            * pricing.output_per_1m;
    let upper = uncached_input_cost
        + (call_count as f64 * ESTIMATED_UPPER_LOCATION_OUTPUT_TOKENS as f64 / 1_000_000.0)
            * pricing.output_per_1m;
    Ok((predicted, upper))
}

#[derive(Clone)]
pub struct OpenAiNormaliseClient {
    http: OpenAiHttp,
    metadata_model: String,
    location_model: String,
}

impl OpenAiNormaliseClient {
    /// Construct over a task-local shared HTTP transport.
    pub fn new(http: OpenAiHttp, model: impl Into<String>) -> Self {
        let model = model.into();
        Self {
            http,
            metadata_model: model.clone(),
            location_model: model,
        }
    }

    pub fn with_models(
        http: OpenAiHttp,
        metadata_model: impl Into<String>,
        location_model: impl Into<String>,
    ) -> Self {
        Self {
            http,
            metadata_model: metadata_model.into(),
            location_model: location_model.into(),
        }
    }

    /// Explicit alias retained for tests that emphasize transport injection.
    pub fn from_http(http: OpenAiHttp, model: impl Into<String>) -> Self {
        Self::new(http, model)
    }
}

#[derive(Debug, Deserialize)]
struct DescriptionReply {
    description: String,
}

#[derive(Debug, Deserialize)]
struct TitleReply {
    title: String,
}

/// Body for `/responses` text-only call.
fn build_request_body(
    model: &str,
    system_prompt: &str,
    user_payload: serde_json::Value,
    schema: serde_json::Value,
    schema_name: &str,
    max_output_tokens: u32,
) -> serde_json::Value {
    let mut request = serde_json::json!({
        "model": model,
        "service_tier": "default",
        "input": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": serde_json::to_string(&user_payload).unwrap_or_default() }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "schema": schema,
                "strict": true
            }
        },
        "max_output_tokens": max_output_tokens,
    });
    // Luna performed best in the controlled title/description corpus with
    // reasoning disabled. This also keeps the small title token budget entirely
    // available for the structured response instead of hidden reasoning tokens.
    let reasoning_effort = model.starts_with("gpt-5.6").then_some("none");
    apply_responses_model_parameters(&mut request, model, reasoning_effort);
    request
}

fn description_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["description"],
        "properties": {
            "description": { "type": "string" }
        }
    })
}

fn title_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title"],
        "properties": {
            "title": { "type": "string" }
        }
    })
}

fn location_schema() -> serde_json::Value {
    let nullable_string = || serde_json::json!({ "type": ["string", "null"] });
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "sublocation", "city", "provinceState", "countryName",
            "worldRegion", "locationName"
        ],
        "properties": {
            "sublocation": nullable_string(),
            "city": nullable_string(),
            "provinceState": nullable_string(),
            "countryName": nullable_string(),
            "worldRegion": nullable_string(),
            "locationName": nullable_string()
        }
    })
}

fn location_cache_partition(evidence: &str) -> u8 {
    (evidence.bytes().fold(0_u32, |hash, byte| {
        hash.wrapping_mul(16_777_619) ^ u32::from(byte)
    }) % LOCATION_CACHE_PARTITIONS) as u8
}

fn build_location_request_body(model: &str, evidence: &str) -> serde_json::Value {
    let cache_key = format!(
        "medialibrary-location-{}-{}",
        NORMALISE_PROMPT_VERSION,
        location_cache_partition(evidence)
    );
    let system_content = if model.starts_with("gpt-5.6") {
        serde_json::json!([{
            "type": "input_text",
            "text": LOCATION_SYSTEM_PROMPT,
            "prompt_cache_breakpoint": { "mode": "explicit" }
        }])
    } else {
        serde_json::json!(LOCATION_SYSTEM_PROMPT)
    };
    let mut request = serde_json::json!({
        "model": model,
        "service_tier": "default",
        "input": [
            { "role": "system", "content": system_content },
            { "role": "user", "content": evidence }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "location_resolution",
                "schema": location_schema(),
                "strict": true
            }
        },
        "max_output_tokens": LOCATION_OUTPUT_TOKENS,
        "prompt_cache_key": cache_key,
    });
    if model.starts_with("gpt-5.6") {
        request["prompt_cache_options"] = serde_json::json!({ "mode": "explicit" });
    }
    apply_responses_model_parameters(&mut request, model, Some(LOW_REASONING_EFFORT));
    request
}

/// Extract the structured-output payload from a `/responses` JSON body.
///
/// The Responses API embeds the JSON content as a string in
/// `output[].content[].text`. Reasoning models can put a reasoning item before
/// the assistant message, so use the shared traversal rather than fixed
/// indices.
fn extract_structured_text(body: &serde_json::Value) -> Result<String, String> {
    find_output_text(body)
        .ok_or_else(|| format!("missing output[*].content[*].output_text in: {}", body))
}

impl OpenAiNormaliseClient {
    /// Build the JSON body for a Group B description-merge/generation request.
    /// Exposed so the estimate phase can preflight the same body
    /// against `/responses/input_tokens` without dispatching.
    pub fn description_request_body(&self, prompt: &DescriptionMergePrompt) -> serde_json::Value {
        let user_payload = serde_json::to_value(prompt).unwrap_or(serde_json::json!({}));
        build_request_body(
            &self.metadata_model,
            DESCRIPTION_SYSTEM_PROMPT,
            user_payload,
            description_schema(),
            "description_merge",
            DESCRIPTION_OUTPUT_TOKENS,
        )
    }

    /// Build the JSON body for a Group C title-generation request.
    pub fn title_request_body(&self, prompt: &TitleGenPrompt) -> serde_json::Value {
        let user_payload = serde_json::to_value(prompt).unwrap_or(serde_json::json!({}));
        build_request_body(
            &self.metadata_model,
            TITLE_SYSTEM_PROMPT,
            user_payload,
            title_schema(),
            "title_generation",
            TITLE_OUTPUT_TOKENS,
        )
    }

    pub fn location_request_body(&self, prompt: &LocationResolvePrompt) -> serde_json::Value {
        build_location_request_body(&self.location_model, &prompt.evidence)
    }

    pub fn model(&self) -> &str {
        &self.metadata_model
    }

    pub fn location_model(&self) -> &str {
        &self.location_model
    }

    /// Preflight a built request body against `/responses/input_tokens`.
    /// Drops runtime parameters before posting — these are not accepted by
    /// the token-count endpoint. Mirrors the shape of
    /// `openai_describe::count_input_tokens`.
    pub async fn count_input_tokens(&self, body: &serde_json::Value) -> Result<u32, String> {
        let mut body = body.clone();
        if let Some(obj) = body.as_object_mut() {
            for k in [
                "temperature",
                "top_p",
                "max_output_tokens",
                "service_tier",
                "prompt_cache_key",
                "prompt_cache_options",
            ] {
                obj.remove(k);
            }
        }
        let (status, text) = self.http.post_responses_input_tokens(&body).await?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, text));
        }
        let json: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("bad JSON ({}): {}", e, text))?;
        json["input_tokens"]
            .as_u64()
            .map(|n| n as u32)
            .ok_or_else(|| format!("missing input_tokens in: {}", text))
    }
}

/// Extract the `usage` block from a `/responses` body. The Responses
/// API surfaces `usage.input_tokens` / `usage.output_tokens`; both are
/// required so response-shape drift cannot silently produce a zero-cost row.
fn extract_usage(body: &serde_json::Value) -> Result<AiCallUsage, String> {
    AiCallUsage::from_response(body)
}

#[async_trait::async_trait]
impl NormaliseAiClient for OpenAiNormaliseClient {
    async fn merge_description(
        &self,
        prompt: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), NormaliseAiError> {
        let user_payload = serde_json::to_value(&prompt)
            .map_err(|e| NormaliseAiError::from(format!("serialise merge prompt: {}", e)))?;
        let body = build_request_body(
            &self.metadata_model,
            DESCRIPTION_SYSTEM_PROMPT,
            user_payload,
            description_schema(),
            "description_merge",
            DESCRIPTION_OUTPUT_TOKENS,
        );
        let response = post_responses(&self.http, &body)
            .await
            .map_err(NormaliseAiError::from)?;
        let usage = extract_usage(&response).map_err(NormaliseAiError::from)?;
        let text = extract_structured_text(&response)
            .map_err(|e| NormaliseAiError::from(e).with_usage(usage.clone()))?;
        let parsed: DescriptionReply = serde_json::from_str(&text).map_err(|e| {
            NormaliseAiError::from(format!("bad description JSON: {} (raw: {})", e, text))
                .with_usage(usage.clone())
        })?;
        Ok((parsed.description, usage))
    }

    async fn generate_title(
        &self,
        prompt: TitleGenPrompt,
    ) -> Result<(String, AiCallUsage), NormaliseAiError> {
        let user_payload = serde_json::to_value(&prompt)
            .map_err(|e| NormaliseAiError::from(format!("serialise title prompt: {}", e)))?;
        let body = build_request_body(
            &self.metadata_model,
            TITLE_SYSTEM_PROMPT,
            user_payload,
            title_schema(),
            "title_generation",
            TITLE_OUTPUT_TOKENS,
        );
        let response = post_responses(&self.http, &body)
            .await
            .map_err(NormaliseAiError::from)?;
        let usage = extract_usage(&response).map_err(NormaliseAiError::from)?;
        let text = extract_structured_text(&response)
            .map_err(|e| NormaliseAiError::from(e).with_usage(usage.clone()))?;
        let parsed: TitleReply = serde_json::from_str(&text).map_err(|e| {
            NormaliseAiError::from(format!("bad title JSON: {} (raw: {})", e, text))
                .with_usage(usage.clone())
        })?;
        Ok((parsed.title, usage))
    }

    async fn resolve_location(
        &self,
        prompt: LocationResolvePrompt,
    ) -> Result<(LocationAiResult, AiCallUsage), NormaliseAiError> {
        let body = build_location_request_body(&self.location_model, &prompt.evidence);
        let response = post_responses(&self.http, &body)
            .await
            .map_err(NormaliseAiError::from)?;
        let usage = extract_usage(&response).map_err(NormaliseAiError::from)?;
        let text = extract_structured_text(&response)
            .map_err(|e| NormaliseAiError::from(e).with_usage(usage.clone()))?;
        let parsed: LocationAiResult = serde_json::from_str(&text).map_err(|e| {
            NormaliseAiError::from(format!("bad location JSON: {} (raw: {})", e, text))
                .with_usage(usage.clone())
        })?;
        Ok((parsed, usage))
    }
}

/// POST to `/responses` via the shared `OpenAiHttp` and return the
/// parsed JSON body. Surfaces HTTP errors with a status + body
/// excerpt so `NormaliseAiError::from_client_string` can classify them.
async fn post_responses(
    http: &OpenAiHttp,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (status, text) = http.post_responses(body).await?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| format!("bad JSON ({}): {}", e, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_request_body_has_strict_schema() {
        let body = build_request_body(
            "gpt-5.4-nano",
            DESCRIPTION_SYSTEM_PROMPT,
            serde_json::json!({"foo": "bar"}),
            description_schema(),
            "description_merge",
            400,
        );
        assert_eq!(body["model"], "gpt-5.4-nano");
        assert_eq!(body["service_tier"], "default");
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["text"]["format"]["strict"], true);
        assert_eq!(body["text"]["format"]["name"], "description_merge");
        assert_eq!(
            body["text"]["format"]["schema"]["required"][0],
            "description"
        );
        assert_eq!(body["max_output_tokens"], 400);
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn luna_metadata_requests_disable_reasoning() {
        let body = build_request_body(
            "gpt-5.6-luna",
            DESCRIPTION_SYSTEM_PROMPT,
            serde_json::json!({}),
            description_schema(),
            "description_merge",
            DESCRIPTION_OUTPUT_TOKENS,
        );
        assert_eq!(body["reasoning"]["effort"], "none");
    }

    #[test]
    fn title_request_body_has_short_token_cap() {
        let body = build_request_body(
            "gpt-5.4-nano",
            TITLE_SYSTEM_PROMPT,
            serde_json::json!({}),
            title_schema(),
            "title_generation",
            TITLE_OUTPUT_TOKENS,
        );
        assert_eq!(body["max_output_tokens"], TITLE_OUTPUT_TOKENS);
        assert_eq!(body["text"]["format"]["schema"]["required"][0], "title");
    }

    #[test]
    fn location_request_uses_location_model_and_nullable_strict_schema() {
        let client = OpenAiNormaliseClient {
            http: OpenAiHttp::new("http://localhost", "test", 0),
            metadata_model: "gpt-5.4-nano".into(),
            location_model: "gpt-5.6-luna".into(),
        };
        let body = client.location_request_body(&LocationResolvePrompt {
            evidence: "feature:\n  type: \"museum\"".into(),
        });
        assert_eq!(body["model"], "gpt-5.6-luna");
        assert_eq!(body["max_output_tokens"], LOCATION_OUTPUT_TOKENS);
        assert_eq!(body["reasoning"]["effort"], LOW_REASONING_EFFORT);
        assert_eq!(body["prompt_cache_options"]["mode"], "explicit");
        assert!(body["prompt_cache_key"]
            .as_str()
            .unwrap()
            .starts_with("medialibrary-location-v7-"));
        assert_eq!(
            body["input"][0]["content"][0]["prompt_cache_breakpoint"]["mode"],
            "explicit"
        );
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert_eq!(body["text"]["format"]["name"], "location_resolution");
        assert_eq!(body["text"]["format"]["strict"], true);
        assert_eq!(
            body["text"]["format"]["schema"]["required"],
            serde_json::json!([
                "sublocation",
                "city",
                "provinceState",
                "countryName",
                "worldRegion",
                "locationName"
            ])
        );
        assert_eq!(
            body["text"]["format"]["schema"]["properties"]["city"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert_eq!(
            body["input"][1]["content"].as_str().unwrap(),
            "feature:\n  type: \"museum\""
        );
        let system_prompt = body["input"][0]["content"][0]["text"].as_str().unwrap();
        assert!(system_prompt.contains("compact evidence"));
        assert!(system_prompt.contains("without automatic precedence"));
        assert!(system_prompt.contains("city, town, village, hamlet"));
        assert!(system_prompt.contains("place_rank describes granularity, not confidence"));
        assert!(system_prompt.contains("Sublocation is distinct from both City and LocationName"));
    }

    #[test]
    fn normalise_cost_math_matches_hand_calc_for_gpt_4o() {
        let (predicted, upper) =
            estimate_normalise_cost_from_tokens("gpt-4o", 800, 300, 1, 1).unwrap();
        let expected_predicted = (1100.0 / 1e6) * 2.50 + (97.0 / 1e6) * 10.00;
        let expected_upper = (1100.0 / 1e6) * 2.50 + (180.0 / 1e6) * 10.00;
        assert!((predicted - expected_predicted).abs() < 1e-9);
        assert!((upper - expected_upper).abs() < 1e-9);
    }

    #[test]
    fn location_cost_estimate_models_partitioned_cache_warmup_and_hits() {
        let calls = 10;
        let input_tokens = 15_650;
        let (predicted, upper) =
            estimate_location_cost_from_tokens("gpt-5.6-luna", input_tokens, calls).unwrap();
        let write_tokens = 8.0 * f64::from(LOCATION_CACHE_PREFIX_TOKENS);
        let cached_tokens = 2.0 * f64::from(LOCATION_CACHE_PREFIX_TOKENS);
        let uncached_tokens = input_tokens as f64 - write_tokens - cached_tokens;
        let expected_predicted = (uncached_tokens / 1e6) * 0.20
            + (cached_tokens / 1e6) * 0.02
            + (write_tokens / 1e6) * 0.25
            + (calls as f64 * f64::from(EXPECTED_LOCATION_OUTPUT_TOKENS) / 1e6) * 1.20;
        let expected_upper = (input_tokens as f64 / 1e6) * 0.20
            + (calls as f64 * f64::from(ESTIMATED_UPPER_LOCATION_OUTPUT_TOKENS) / 1e6) * 1.20;
        assert!((predicted - expected_predicted).abs() < 1e-9);
        assert!((upper - expected_upper).abs() < 1e-9);
    }

    #[test]
    fn extract_structured_text_handles_happy_path() {
        let body = serde_json::json!({
            "output": [{
                "content": [{
                    "type": "output_text",
                    "text": "{\"description\":\"merged\"}"
                }]
            }]
        });
        let text = extract_structured_text(&body).unwrap();
        assert_eq!(text, "{\"description\":\"merged\"}");
    }

    #[test]
    fn extract_structured_text_handles_reasoning_before_message() {
        let body = serde_json::json!({
            "output": [
                {
                    "content": [],
                    "type": "reasoning"
                },
                {
                    "content": [{
                        "type": "output_text",
                        "text": "{\"city\":\"York\"}"
                    }],
                    "type": "message"
                }
            ]
        });

        let text = extract_structured_text(&body).unwrap();
        assert_eq!(text, "{\"city\":\"York\"}");
    }

    #[test]
    fn extract_structured_text_errors_when_missing() {
        let body = serde_json::json!({ "output": [] });
        let err = extract_structured_text(&body).expect_err("must error");
        assert!(err.contains("missing"));
    }

    #[test]
    fn extract_usage_requires_top_level_token_counts_and_keeps_details() {
        let body = serde_json::json!({
            "service_tier": "default",
            "reasoning": {"effort": "medium"},
            "usage": {
                "input_tokens": 50,
                "input_tokens_details": {"cached_tokens": 10, "cache_write_tokens": 5},
                "output_tokens": 30,
                "output_tokens_details": {"reasoning_tokens": 20}
            }
        });
        let usage = extract_usage(&body).unwrap();
        assert_eq!(usage.cached_input_tokens, 10);
        assert_eq!(usage.cache_write_input_tokens, 5);
        assert_eq!(usage.reasoning_tokens, 20);
        assert_eq!(usage.service_tier, "default");
        assert_eq!(usage.reasoning_effort, "medium");

        let err = extract_usage(&serde_json::json!({"usage": {"output_tokens": 1}}))
            .expect_err("missing input must not silently become zero");
        assert!(err.contains("input_tokens"));
    }
}
