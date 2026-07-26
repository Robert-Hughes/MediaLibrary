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
use crate::openai_describe::OpenAiClient;
use crate::openai_http::OpenAiHttp;

/// Version stamp recorded in the audit log per AI call. Bump when
/// either prompt or schema changes; old log entries retain the prior
/// string for archaeology.
pub const NORMALISE_PROMPT_VERSION: &str = "v3";

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

const LOCATION_SYSTEM_PROMPT: &str = "You resolve two raw Nominatim reverse-geocode responses into the human-facing members of one IPTC Extension LocationCreated structure for a personal photo library. \
Return English or commonly anglicised place names. Reconcile the GeocodeJSON and JSONv2 hierarchies using their full contents and ordinary geographic meaning; neither format has automatic precedence. \
Sublocation is the specific named venue, building, landmark, campus area, street, or neighbourhood where the photo was made. \
City is the useful human-facing settlement or metropolitan locality; it need not follow Nominatim's field label mechanically, and may combine supported components such as `Minato, Tokyo` when that is clearest. \
ProvinceState is the first useful regional or state-level division above City. \
CountryName is the conventional English country name. \
WorldRegion is a broad geographic region such as Europe or East Asia, but must be null unless it is directly supported or unambiguous from the supplied country. \
LocationName is a useful overall name for the created location, but should be null when it would merely duplicate another field. \
Use only facts supported by the responses. Return null for a field that cannot be set accurately. Do not return coordinates, country codes, or identifiers; the application supplies those deterministically.";

/// Output-token caps for cost-estimation purposes. Mirror plan §6.
pub const DESCRIPTION_OUTPUT_TOKENS: u32 = 400;
pub const TITLE_OUTPUT_TOKENS: u32 = 30;
pub const LOCATION_OUTPUT_TOKENS: u32 = 250;
pub const EXPECTED_DESCRIPTION_OUTPUT_TOKENS: u32 = 250;
pub const EXPECTED_TITLE_OUTPUT_TOKENS: u32 = 15;
pub const EXPECTED_LOCATION_OUTPUT_TOKENS: u32 = 100;
pub const HEURISTIC_DESCRIPTION_INPUT_TOKENS: u32 = 800;
pub const HEURISTIC_TITLE_INPUT_TOKENS: u32 = 300;
pub const HEURISTIC_LOCATION_INPUT_TOKENS: u32 = 2_000;

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
    let upper_out_total = description_call_count as u64 * DESCRIPTION_OUTPUT_TOKENS as u64
        + title_call_count as u64 * TITLE_OUTPUT_TOKENS as u64;
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
    let input_cost = (input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m;
    let predicted = input_cost
        + (call_count as f64 * EXPECTED_LOCATION_OUTPUT_TOKENS as f64 / 1_000_000.0)
            * pricing.output_per_1m;
    let upper = input_cost
        + (call_count as f64 * LOCATION_OUTPUT_TOKENS as f64 / 1_000_000.0) * pricing.output_per_1m;
    Ok((predicted, upper))
}

#[derive(Clone)]
pub struct OpenAiNormaliseClient {
    http: OpenAiHttp,
    metadata_model: String,
    location_model: String,
}

impl OpenAiNormaliseClient {
    /// Construct from an `OpenAiClient` so production code shares the
    /// same retry middleware between describe and normalise.
    pub fn new(inner: OpenAiClient, model: impl Into<String>) -> Self {
        let model = model.into();
        Self {
            http: inner.http().clone(),
            metadata_model: model.clone(),
            location_model: model,
        }
    }

    pub fn with_models(
        inner: OpenAiClient,
        metadata_model: impl Into<String>,
        location_model: impl Into<String>,
    ) -> Self {
        Self {
            http: inner.http().clone(),
            metadata_model: metadata_model.into(),
            location_model: location_model.into(),
        }
    }

    /// Construct directly over an `OpenAiHttp`. Used by tests that
    /// don't need the describe-flow wrapper.
    pub fn from_http(http: OpenAiHttp, model: impl Into<String>) -> Self {
        let model = model.into();
        Self {
            http,
            metadata_model: model.clone(),
            location_model: model,
        }
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
    serde_json::json!({
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
        "temperature": 0,
        "top_p": 1,
        "max_output_tokens": max_output_tokens,
    })
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

/// Extract the structured-output payload from a `/responses` JSON body.
///
/// The Responses API embeds the JSON content as a string in
/// `output[].content[].text`; per `openai_describe::extract_text`,
/// `output[0].content[0].text` works for the happy path.
fn extract_structured_text(body: &serde_json::Value) -> Result<String, String> {
    body["output"][0]["content"][0]["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("missing output[0].content[0].text in: {}", body))
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
        let user_payload = serde_json::to_value(prompt).unwrap_or(serde_json::json!({}));
        build_request_body(
            &self.location_model,
            LOCATION_SYSTEM_PROMPT,
            user_payload,
            location_schema(),
            "location_resolution",
            LOCATION_OUTPUT_TOKENS,
        )
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
            for k in ["temperature", "top_p", "max_output_tokens", "service_tier"] {
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
        let user_payload = serde_json::to_value(&prompt)
            .map_err(|e| NormaliseAiError::from(format!("serialise location prompt: {}", e)))?;
        let body = build_request_body(
            &self.location_model,
            LOCATION_SYSTEM_PROMPT,
            user_payload,
            location_schema(),
            "location_resolution",
            LOCATION_OUTPUT_TOKENS,
        );
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
            geocode_json: Some(r#"{"features":[]}"#.into()),
            json_v2: None,
        });
        assert_eq!(body["model"], "gpt-5.6-luna");
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
        assert!(body["input"][1]["content"]
            .as_str()
            .unwrap()
            .contains(r#"\"features\""#));
    }

    #[test]
    fn normalise_cost_math_matches_hand_calc_for_gpt_4o() {
        let (predicted, upper) =
            estimate_normalise_cost_from_tokens("gpt-4o", 800, 300, 1, 1).unwrap();
        let expected_predicted = (1100.0 / 1e6) * 2.50 + (265.0 / 1e6) * 10.00;
        let expected_upper = (1100.0 / 1e6) * 2.50 + (430.0 / 1e6) * 10.00;
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
