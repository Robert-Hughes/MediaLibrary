//! Text-only OpenAI client for the metadata-normaliser.
//!
//! See `docs/NORMALISE_METADATA_PLAN.md` §6. Two operations:
//!
//! - **Description merge** (Group B case-4): combine 2+ distinct
//!   description sources into a single factual paragraph, with location
//!   / keywords / date context to disambiguate.
//! - **Title generation** (Group C case-3): generate a short title-cased
//!   phrase from the canonical description + context.
//!
//! Both calls hit `/responses` with `text.format: { type: "json_schema" }`
//! so the response is shaped exactly `{ description }` / `{ title }`
//! without prompt-template plumbing.
//!
//! Image bytes are never sent — visual content is assumed already
//! distilled into the read-only `XMP-mlib:AI*` inputs.

use serde::Deserialize;

use crate::normalise::{
    AiCallUsage, DescriptionMergePrompt, NormaliseAiClient, TitleGenPrompt,
};
use crate::openai_describe::OpenAiClient;

/// Version stamp recorded in the audit log per AI call. Bump when
/// either prompt or schema changes; old log entries retain the prior
/// string for archaeology.
pub const NORMALISE_PROMPT_VERSION: &str = "v1";

const DESCRIPTION_SYSTEM_PROMPT: &str = "You normalise photo descriptions. \
Merge the source descriptions into a single factual paragraph in `x-default` English. \
Prefer concrete facts; drop marketing language and adjectives that aren't grounded in the inputs. \
Sentence case. No trailing exclamations. \
Use the location, keywords, and date as contextual hints to disambiguate but do not invent facts not supported by the source descriptions. \
If the sources conflict, prefer the more specific statement.";

const TITLE_SYSTEM_PROMPT: &str = "You generate a short photo title. \
≤8 words. Title case. No trailing punctuation. \
Use the description as the primary source; use location and keywords for disambiguation.";

/// Output-token caps for cost-estimation purposes. Mirror plan §6.
pub const DESCRIPTION_OUTPUT_TOKENS: u32 = 400;
pub const TITLE_OUTPUT_TOKENS: u32 = 30;

/// Synthetic typical cost shown next to each model in the settings
/// dropdown. Plan §6: assumes the worst case (both Group B and Group C
/// fire on the same photo) with median prompt sizes. The run-time
/// estimator (§7) computes exact costs from real prompts.
pub fn typical_normalise_cost_per_image(model: &str) -> Option<f64> {
    let p = crate::openai_describe::pricing_for(model)?;
    // Group B: ~800 input tokens (system + 3 description sources + AI
    // context + location + keywords + date), ~250 expected output.
    let b_in: f64 = 800.0;
    let b_out: f64 = 250.0;
    // Group C: ~300 input + ~15 output.
    let c_in: f64 = 300.0;
    let c_out: f64 = 15.0;
    Some(
        ((b_in + c_in) / 1_000_000.0) * p.input_per_1m
            + ((b_out + c_out) / 1_000_000.0) * p.output_per_1m,
    )
}

#[derive(Clone)]
pub struct OpenAiNormaliseClient {
    inner: OpenAiClient,
    model: String,
}

impl OpenAiNormaliseClient {
    pub fn new(inner: OpenAiClient, model: impl Into<String>) -> Self {
        Self { inner, model: model.into() }
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
    /// Build the JSON body for a Group B description-merge request.
    /// Exposed so the estimate phase can preflight the same body
    /// against `/responses/input_tokens` without dispatching.
    pub fn description_request_body(&self, prompt: &DescriptionMergePrompt) -> serde_json::Value {
        let user_payload = serde_json::to_value(prompt).unwrap_or(serde_json::json!({}));
        build_request_body(
            &self.model,
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
            &self.model,
            TITLE_SYSTEM_PROMPT,
            user_payload,
            title_schema(),
            "title_generation",
            TITLE_OUTPUT_TOKENS,
        )
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Preflight a built request body against `/responses/input_tokens`.
    /// Drops the runtime parameters (`temperature`, `top_p`,
    /// `max_output_tokens`) before posting — these are not accepted by
    /// the token-count endpoint. Mirrors the shape of
    /// `openai_describe::count_input_tokens`.
    pub async fn count_input_tokens(&self, body: &serde_json::Value) -> Result<u32, String> {
        let mut body = body.clone();
        if let Some(obj) = body.as_object_mut() {
            for k in ["temperature", "top_p", "max_output_tokens"] {
                obj.remove(k);
            }
        }
        let url = format!("{}/responses/input_tokens", self.inner.base_url());
        let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;
        let resp = self
            .inner
            .http()
            .post(&url)
            .bearer_auth(self.inner.api_key())
            .header("content-type", "application/json")
            .body(body_str)
            .send()
            .await
            .map_err(|e| format!("network error: {}", e))?;
        let status = resp.status();
        let text: String = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, text));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("bad JSON ({}): {}", e, text))?;
        json["input_tokens"]
            .as_u64()
            .map(|n| n as u32)
            .ok_or_else(|| format!("missing input_tokens in: {}", text))
    }
}

/// Extract the `usage` block from a `/responses` body. The Responses
/// API surfaces `usage.input_tokens` / `usage.output_tokens`; both
/// default to zero if missing so the audit log still records a row.
fn extract_usage(body: &serde_json::Value) -> AiCallUsage {
    let u = &body["usage"];
    AiCallUsage {
        input_tokens: u["input_tokens"].as_u64().unwrap_or(0) as u32,
        output_tokens: u["output_tokens"].as_u64().unwrap_or(0) as u32,
    }
}

#[async_trait::async_trait]
impl NormaliseAiClient for OpenAiNormaliseClient {
    async fn merge_description(
        &self,
        prompt: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), String> {
        let user_payload = serde_json::to_value(&prompt)
            .map_err(|e| format!("serialise merge prompt: {}", e))?;
        let body = build_request_body(
            &self.model,
            DESCRIPTION_SYSTEM_PROMPT,
            user_payload,
            description_schema(),
            "description_merge",
            DESCRIPTION_OUTPUT_TOKENS,
        );
        let response = post_responses(&self.inner, &body).await?;
        let usage = extract_usage(&response);
        let text = extract_structured_text(&response)?;
        let parsed: DescriptionReply = serde_json::from_str(&text)
            .map_err(|e| format!("bad description JSON: {} (raw: {})", e, text))?;
        Ok((parsed.description, usage))
    }

    async fn generate_title(
        &self,
        prompt: TitleGenPrompt,
    ) -> Result<(String, AiCallUsage), String> {
        let user_payload = serde_json::to_value(&prompt)
            .map_err(|e| format!("serialise title prompt: {}", e))?;
        let body = build_request_body(
            &self.model,
            TITLE_SYSTEM_PROMPT,
            user_payload,
            title_schema(),
            "title_generation",
            TITLE_OUTPUT_TOKENS,
        );
        let response = post_responses(&self.inner, &body).await?;
        let usage = extract_usage(&response);
        let text = extract_structured_text(&response)?;
        let parsed: TitleReply = serde_json::from_str(&text)
            .map_err(|e| format!("bad title JSON: {} (raw: {})", e, text))?;
        Ok((parsed.title, usage))
    }
}

/// POST to `/responses` and return the parsed JSON body. Surfaces HTTP
/// errors with a status + body excerpt so the caller's audit log can
/// record the failure mode.
async fn post_responses(
    client: &OpenAiClient,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    // OpenAiClient exposes `base_url` / `api_key` via its private state
    // — we re-derive the URL from the public constructor convention.
    // The describe-flow client builder is the only callsite that
    // constructs `OpenAiClient` today, and it uses the same base URL
    // we use here. Keep this in sync if that ever changes.
    let url = format!("{}/responses", client.base_url());
    let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.api_key())
        .header("content-type", "application/json")
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
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
        assert_eq!(
            body["text"]["format"]["schema"]["required"][0],
            "title"
        );
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
}
