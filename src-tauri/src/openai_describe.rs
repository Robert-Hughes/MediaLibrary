//! OpenAI Responses-API client for per-image description generation.
//!
//! See `docs/IMAGE_ANALYSIS.md` for the V1 scope. In short:
//!
//! - Each image is loaded, downscaled to 1024px long side, JPEG-encoded at
//!   q=85, base64-inlined into a `/responses` request alongside a strict
//!   JSON-schema constraint.
//! - The preflight step calls `/responses/input_tokens` to get an exact
//!   token count and computes a cost estimate from a hard-coded pricing
//!   table covering the recommended-model set.
//! - On success, structured fields land in the typed-draft store under the
//!   `XMP-mlib:*` namespace so the existing apply pipeline can write them.
//!
//! Image requests are dispatched through the command layer's bounded async
//! runner. The HTTP base URL and retry-policy ceiling are injected so tests
//! can point at a wiremock and run deterministic retry sequences without a
//! real network.

use std::{collections::HashSet, path::Path};

use base64::Engine;
use chrono::{Datelike, Offset, Timelike};
use image::io::Reader as ImageReader;
use serde::{Deserialize, Serialize};
use std::io::Cursor;

use crate::draft_edits::{EditIntent, MetadataDraftEdit};
use crate::metadata_value::{
    DateTimeValue, DateValue, ListKind, MetadataValue, OffsetSign, TimeValue, UtcOffsetValue,
};
use crate::openai_http::OpenAiHttp;
use crate::openai_request::{
    apply_responses_model_parameters, find_output_text, LOW_REASONING_EFFORT,
};

/// Long-side cap before upload.  See experiment for rationale: server-side
/// downscale is wasted bandwidth otherwise.
const MAX_IMAGE_DIMENSION: u32 = 1024;

/// Hard cap on `/responses` output tokens.  Hitting this leaves JSON
/// unparseable, so callers must check `status=="incomplete"`.
pub const MAX_OUTPUT_TOKENS: u32 = 1200;
pub const DESCRIBE_REASONING_EFFORT: &str = LOW_REASONING_EFFORT;

/// Expected output tokens for cost estimation only.  Tuned by the test set
/// in the experiment; bounded by `MAX_OUTPUT_TOKENS`.
/// Expected total output (visible structured output plus hidden reasoning).
/// Rounded upward from the successful-call average in the July 2026
/// gpt-5.6-luna batch to allow for its capped long-output tail.
pub const EXPECTED_OUTPUT_TOKENS: u32 = 280;

/// Representative input-token count for one downscaled (≤1024px) image
/// plus the system prompt. Used only by the model-dropdown cost preview,
/// where we don't have a real image to call `/responses/input_tokens`
/// against. Real per-run estimates still use the exact server count.
/// Calibrated against gpt-4o for a typical landscape 1024×768 photo
/// (~870 image tokens + ~230 instruction tokens).
pub const TYPICAL_INPUT_TOKENS_PER_IMAGE: u32 = 1100;

/// Estimate the cost of describing one typical image with `model`.  Used by
/// the Settings dropdown to give users a ballpark before they commit.
/// Returns `None` when the model has no pricing entry — callers render the
/// model id without a cost suffix in that case.
pub fn estimate_typical_cost_per_image(model: &str) -> Option<f64> {
    let p = pricing_for(model)?;
    let input = (TYPICAL_INPUT_TOKENS_PER_IMAGE as f64 / 1_000_000.0) * p.input_per_1m;
    let output = (EXPECTED_OUTPUT_TOKENS as f64 / 1_000_000.0) * p.output_per_1m;
    Some(input + output)
}

pub fn heuristic_describe_input_tokens(n_images: usize) -> u64 {
    TYPICAL_INPUT_TOKENS_PER_IMAGE as u64 * n_images as u64
}

pub fn estimate_describe_cost_from_input_tokens(
    model: &str,
    total_input_tokens: u64,
    n_images: usize,
) -> Result<(f64, f64), String> {
    let p = pricing_for(model).ok_or_else(|| format!("no pricing entry for model {}", model))?;
    let input_cost = (total_input_tokens as f64 / 1_000_000.0) * p.input_per_1m;
    let predicted_output_tokens = EXPECTED_OUTPUT_TOKENS as u64 * n_images as u64;
    let max_output_tokens = MAX_OUTPUT_TOKENS as u64 * n_images as u64;
    let predicted = input_cost + (predicted_output_tokens as f64 / 1_000_000.0) * p.output_per_1m;
    let upper = input_cost + (max_output_tokens as f64 / 1_000_000.0) * p.output_per_1m;
    Ok((predicted, upper))
}

/// Prompt + schema version.  Bump when either changes so the audit log and
/// the `XMP-mlib:AIPromptVersion` written to each file can distinguish
/// runs.
pub const PROMPT_VERSION: &str = "v1";

/// Re-exported for callers that still reference the old name.
pub use crate::openai_http::DEFAULT_BASE_URL;

/// System-level prompt sent in `instructions`.  Adds an explicit cap on OCR
/// transcription length (see `docs/IMAGE_ANALYSIS.md`) so document-heavy
/// images don't blow past `max_output_tokens`.
pub const SYSTEM_INSTRUCTIONS: &str = "\
You describe images for a personal media library. Your output is consumed \
by both software (for indexing and search) and a human (for browsing), so \
it should be informative and engaging — not robotically factual. \
\
For `description`: 2-4 sentences in present tense. Lead with the most \
salient content. **Name landmarks, famous buildings, sculptures, locations, \
and recognizable activities by their proper names when you are confident** \
— e.g. 'London Eye' not 'ferris wheel', 'Tower of London' not 'castle', \
'St Pancras Renaissance Hotel' not 'red-brick building', 'punting' not \
'paddling a boat', 'The Meeting Place statue' not 'bronze sculpture of two \
people'. Fall back to generic terms only when you are not confident. Do \
not start with filler ('The image shows', 'This is a photo of', 'I can see') \
— begin directly with the description. Keep `description` factual: what is \
actually present in the image. Speculation about intent, meaning, or \
emotion goes in `interpretation`, not here. \
\
For `tags`: lowercase, hyphenated, single-concept search terms a photographer \
would use to organise the image — subject ('portrait', 'landscape', \
'still-life'), setting ('beach', 'urban', 'indoor'), notable content \
('sunset', 'crowd', 'wedding'), style ('black-and-white', 'long-exposure', \
'macro'), and **specific places, landmarks, or named activities when known** \
('london-eye', 'st-pancras', 'thames', 'punting'). Aim for 5-15 tags. \
\
For `ocr_text`: each distinct text region transcribed verbatim, as its own \
entry. If the image contains many text regions or block text longer than \
~50 words (e.g. document scans, dense signs, screenshots of articles), \
transcribe only the largest or most prominent regions and add a final \
entry `\"[...and additional text omitted]\"` rather than transcribing the \
full text. Empty array if no text. \
\
For `interpretation`: ONE short sentence (or empty string) of explicitly \
labelled speculation about the photographer's intent, the mood, or the \
emotional tone of the image. Use hedging language ('appears', 'likely', \
'seems', 'mood is'). Leave empty if nothing meaningful can be said. \
\
If the image is blank, blurry, or unidentifiable, say so plainly in the \
description.";

// ── Pricing ──────────────────────────────────────────────────────────────────

/// Pricing entry for a single recommended model (USD per 1M tokens).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPricing {
    pub input_per_1m: f64,
    pub cached_input_per_1m: f64,
    pub cache_write_input_per_1m: f64,
    pub output_per_1m: f64,
}

/// Pricing for the recommended-model set only.  Other model ids return
/// `None`; the settings module guarantees we never store an unknown id.
pub fn pricing_for(model: &str) -> Option<ModelPricing> {
    Some(match model {
        "gpt-5.6-luna" => ModelPricing {
            input_per_1m: 0.20,
            cached_input_per_1m: 0.02,
            cache_write_input_per_1m: 0.25,
            output_per_1m: 1.20,
        },
        "gpt-5.6-terra" => ModelPricing {
            input_per_1m: 2.00,
            cached_input_per_1m: 0.20,
            cache_write_input_per_1m: 2.50,
            output_per_1m: 12.00,
        },
        "gpt-5.6-sol" => ModelPricing {
            input_per_1m: 5.00,
            cached_input_per_1m: 0.50,
            cache_write_input_per_1m: 6.25,
            output_per_1m: 30.00,
        },
        "gpt-4o" => ModelPricing {
            input_per_1m: 2.50,
            cached_input_per_1m: 1.25,
            cache_write_input_per_1m: 2.50,
            output_per_1m: 10.00,
        },
        "gpt-5.4-nano" => ModelPricing {
            input_per_1m: 0.20,
            cached_input_per_1m: 0.02,
            cache_write_input_per_1m: 0.20,
            output_per_1m: 1.25,
        },
        "gpt-5.4-mini" => ModelPricing {
            input_per_1m: 0.75,
            cached_input_per_1m: 0.075,
            cache_write_input_per_1m: 0.75,
            output_per_1m: 4.50,
        },
        "gpt-5.4" => ModelPricing {
            input_per_1m: 2.50,
            cached_input_per_1m: 0.25,
            cache_write_input_per_1m: 2.50,
            output_per_1m: 15.00,
        },
        "gpt-5.5" => ModelPricing {
            input_per_1m: 5.00,
            cached_input_per_1m: 0.50,
            cache_write_input_per_1m: 5.00,
            output_per_1m: 30.00,
        },
        _ => return None,
    })
}

// ── AI output schema ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiOutput {
    pub description: String,
    pub objects: Vec<String>,
    pub tags: Vec<String>,
    pub ocr_text: Vec<String>,
    pub interpretation: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageStats {
    pub input_tokens: u32,
    pub cached_input_tokens: u32,
    pub cache_write_input_tokens: u32,
    pub output_tokens: u32,
    pub reasoning_tokens: u32,
    pub service_tier: String,
    pub reasoning_effort: String,
}

impl UsageStats {
    /// Parse the `usage` block of a `/responses` response.
    ///
    /// `input_tokens` and `output_tokens` are required — these drive cost
    /// reporting and the audit log; silently treating a missing field as
    /// zero (the previous behaviour) hid API shape drift and produced
    /// "$0.00" cost summaries. Detail counters and response metadata are
    /// optional and default to zero / empty for older model response shapes.
    pub fn from_response(response: &serde_json::Value) -> Result<Self, String> {
        let usage = response
            .get("usage")
            .ok_or_else(|| "response.usage missing — cost reporting cannot proceed".to_string())?;
        let input_tokens = usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "usage.input_tokens missing or not a number".to_string())?
            as u32;
        let output_tokens = usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "usage.output_tokens missing or not a number".to_string())?
            as u32;
        let cached_input_tokens = usage["input_tokens_details"]["cached_tokens"]
            .as_u64()
            .unwrap_or(0) as u32;
        let cache_write_input_tokens = usage["input_tokens_details"]["cache_write_tokens"]
            .as_u64()
            .unwrap_or(0) as u32;
        let reasoning_tokens = usage["output_tokens_details"]["reasoning_tokens"]
            .as_u64()
            .unwrap_or(0) as u32;
        if cached_input_tokens.saturating_add(cache_write_input_tokens) > input_tokens {
            return Err(format!(
                "usage input detail tokens exceed input_tokens: cached={} cache_write={} input={}",
                cached_input_tokens, cache_write_input_tokens, input_tokens
            ));
        }
        if reasoning_tokens > output_tokens {
            return Err(format!(
                "usage reasoning_tokens exceeds output_tokens: reasoning={} output={}",
                reasoning_tokens, output_tokens
            ));
        }
        Ok(Self {
            input_tokens,
            cached_input_tokens,
            cache_write_input_tokens,
            output_tokens,
            reasoning_tokens,
            service_tier: response["service_tier"].as_str().unwrap_or("").to_string(),
            reasoning_effort: response["reasoning"]["effort"]
                .as_str()
                .unwrap_or("")
                .to_string(),
        })
    }

    pub fn add(&mut self, other: &UsageStats) {
        self.input_tokens += other.input_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.cache_write_input_tokens += other.cache_write_input_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
        merge_response_label(&mut self.service_tier, &other.service_tier);
        merge_response_label(&mut self.reasoning_effort, &other.reasoning_effort);
    }

    pub fn non_reasoning_output_tokens(&self) -> u32 {
        self.output_tokens.saturating_sub(self.reasoning_tokens)
    }

    /// Compute USD cost given a pricing row. `reasoning_tokens` is a subset
    /// of `output_tokens`, so it is logged separately but never added again.
    pub fn cost(&self, p: &ModelPricing) -> f64 {
        let non_cached = self
            .input_tokens
            .saturating_sub(self.cached_input_tokens)
            .saturating_sub(self.cache_write_input_tokens);
        let input_cost = (non_cached as f64 / 1_000_000.0) * p.input_per_1m;
        let cached_cost = (self.cached_input_tokens as f64 / 1_000_000.0) * p.cached_input_per_1m;
        let cache_write_cost =
            (self.cache_write_input_tokens as f64 / 1_000_000.0) * p.cache_write_input_per_1m;
        let output_cost = (self.output_tokens as f64 / 1_000_000.0) * p.output_per_1m;
        input_cost + cached_cost + cache_write_cost + output_cost
    }
}

fn merge_response_label(aggregate: &mut String, next: &str) {
    if next.is_empty() || aggregate == next || aggregate == "mixed" {
        return;
    }
    if aggregate.is_empty() {
        *aggregate = next.to_string();
    } else {
        *aggregate = "mixed".to_string();
    }
}

// ── Client ───────────────────────────────────────────────────────────────────

/// Describe-specific client over the shared OpenAI transport.
#[derive(Clone)]
pub struct OpenAiDescribeClient {
    http: OpenAiHttp,
}

impl OpenAiDescribeClient {
    /// Wrap a task-local `OpenAiHttp`.
    pub fn from_http(http: OpenAiHttp) -> Self {
        Self { http }
    }

    /// Convenience constructor for tests and manual diagnostics.
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>, max_retries: u32) -> Self {
        Self {
            http: OpenAiHttp::new(base_url, api_key, max_retries),
        }
    }
}

// ── Image loading ────────────────────────────────────────────────────────────

/// Resize-and-encode an image to JPEG bytes suitable for inline upload.
///
/// Decode failures are returned as an error (commonly: HEIC, RAW, broken
/// JPEG headers) — the caller marks the image failed and continues the
/// batch. EXIF orientation is applied to the pixels before resizing. The
/// re-encode then strips metadata, which is fine because the resulting pixels
/// are already display-oriented.
pub fn load_and_downscale_image(path: &Path) -> Result<Vec<u8>, String> {
    let orientation = crate::image_orientation::primary_orientation(path).unwrap_or(1);
    let img = ImageReader::open(path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?
        .with_guessed_format()
        .map_err(|e| format!("sniff format {}: {}", path.display(), e))?
        .decode()
        .map_err(|e| format!("decode {}: {}", path.display(), e))?;
    let img = crate::image_orientation::apply(img, orientation);

    let (w, h) = (img.width(), img.height());
    let resized = if w.max(h) > MAX_IMAGE_DIMENSION {
        img.resize(
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img
    };
    let rgb = resized.to_rgb8();
    let mut buf = Vec::new();
    {
        let mut cursor = Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 85);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ColorType::Rgb8,
            )
            .map_err(|e| format!("encode jpeg {}: {}", path.display(), e))?;
    }
    Ok(buf)
}

fn description_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "description": { "type": "string" },
            "objects": { "type": "array", "items": { "type": "string" } },
            "tags": { "type": "array", "items": { "type": "string" } },
            "ocr_text": { "type": "array", "items": { "type": "string" } },
            "interpretation": { "type": "string" }
        },
        "required": ["description", "objects", "tags", "ocr_text", "interpretation"],
        "additionalProperties": false
    })
}

/// Build the `/responses` request body for a single image.
/// Build the exact production Responses API body for one preprocessed image.
/// Exposed for the experiment harness so cache and model evaluations do not
/// drift from production request semantics.
pub fn build_describe_request_body(model: &str, image_bytes: &[u8]) -> serde_json::Value {
    let b64 = base64::engine::general_purpose::STANDARD.encode(image_bytes);
    let data_url = format!("data:image/jpeg;base64,{}", b64);
    let mut request = serde_json::json!({
        "model": model,
        "service_tier": "default",
        "instructions": SYSTEM_INSTRUCTIONS,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_image", "image_url": data_url }]
        }],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "image_description",
                "strict": true,
                "schema": description_schema()
            }
        },
        "max_output_tokens": MAX_OUTPUT_TOKENS,
    });

    // Reasoning tokens share MAX_OUTPUT_TOKENS with the visible JSON. At
    // medium effort, seven production images spent most of the 1,200-token
    // budget on hidden reasoning and were truncated before completing the
    // short schema. Low preserves reasoning while reserving enough budget
    // for the user-visible description fields.
    apply_responses_model_parameters(&mut request, model, Some(DESCRIBE_REASONING_EFFORT));
    apply_responses_model_parameters(&mut request, model, Some(DESCRIBE_REASONING_EFFORT));

    if model.starts_with("gpt-5.6") {
        // GPT-5.6 implicit caching anchors at the changing image message, so
        // unique-photo workloads pay cache-write rates without useful reuse.
        // Explicit mode disables that implicit breakpoint. We deliberately add
        // no explicit breakpoint: the reusable instructions/schema prefix is
        // below the 1,024-token cache minimum, so a breakpoint would not help.
        request["prompt_cache_options"] = serde_json::json!({
            "mode": "explicit",
            "ttl": "30m"
        });
    }

    request
}

/// Preflight a single image through `/responses/input_tokens`. Returns the
/// exact server-counted input token total.  Hard-fails on any HTTP error —
/// no local-math fallback (deliberate; see `docs/IMAGE_ANALYSIS.md`).
pub async fn count_input_tokens(
    client: &OpenAiDescribeClient,
    model: &str,
    image_bytes: &[u8],
) -> Result<u32, String> {
    let mut body = build_describe_request_body(model, image_bytes);
    if let Some(obj) = body.as_object_mut() {
        for k in [
            "temperature",
            "top_p",
            "max_output_tokens",
            "service_tier",
            "reasoning",
        ] {
            obj.remove(k);
        }
    }
    let (status, text) = client
        .http
        .post_responses_input_tokens(&body)
        .await
        .map_err(|e| format!("token preflight {}", e))?;
    if !status.is_success() {
        return Err(format!("token preflight HTTP {}: {}", status, text));
    }
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("token preflight bad JSON: {} (body: {})", e, text))?;
    json["input_tokens"]
        .as_u64()
        .map(|n| n as u32)
        .ok_or_else(|| format!("token preflight response missing input_tokens: {}", text))
}

/// Per-image outcome of a describe call.
#[derive(Debug, Clone)]
pub enum DescribeError {
    Decode(String),
    HttpError {
        status: u16,
        body: String,
    },
    Network(String),
    Incomplete {
        reason: String,
        raw_text: String,
        usage: Option<UsageStats>,
    },
    Refused {
        detail: String,
        usage: Option<UsageStats>,
    },
    BadJson {
        detail: String,
        raw_text: String,
        usage: Option<UsageStats>,
    },
    /// `usage` block missing or malformed in an otherwise-successful
    /// response. Surfaced separately from BadJson so the GUI and audit
    /// log can flag a cost-reporting gap without conflating it with the
    /// model returning unparseable content.
    UsageParse {
        detail: String,
        raw_text: String,
    },
}

impl DescribeError {
    pub fn kind(&self) -> crate::batch_job::BatchFailureKind {
        use crate::batch_job::BatchFailureKind as K;
        match self {
            DescribeError::Decode(_) => K::Decode,
            DescribeError::HttpError { .. } => K::Http,
            DescribeError::Network(_) => K::Network,
            DescribeError::Incomplete { .. } => K::Incomplete,
            DescribeError::Refused { .. } => K::Refused,
            DescribeError::BadJson { .. } => K::BadJson,
            DescribeError::UsageParse { .. } => K::UsageParse,
        }
    }
    pub fn detail(&self) -> String {
        match self {
            DescribeError::Decode(s) | DescribeError::Network(s) => s.clone(),
            DescribeError::HttpError { status, body } => format!("HTTP {}: {}", status, body),
            DescribeError::Incomplete { reason, .. } => format!("response truncated: {}", reason),
            DescribeError::Refused { detail, .. }
            | DescribeError::BadJson { detail, .. }
            | DescribeError::UsageParse { detail, .. } => detail.clone(),
        }
    }

    /// Usage can be present even when an otherwise billable API response is
    /// incomplete, refused, or contains malformed structured output.
    pub fn usage(&self) -> Option<&UsageStats> {
        match self {
            DescribeError::Incomplete { usage, .. }
            | DescribeError::Refused { usage, .. }
            | DescribeError::BadJson { usage, .. } => usage.as_ref(),
            _ => None,
        }
    }
}

/// Walk `output[*].content[*]` looking for a refusal part. Refusals can
/// appear at any index and may be encoded as either `{"type":"refusal",
/// "refusal":"…"}` or, in some shapes, with the text in a `text` field
/// when the type is `refusal`. Returns the first non-empty refusal text.
fn find_refusal(response: &serde_json::Value) -> Option<String> {
    let output = response.get("output")?.as_array()?;
    for msg in output {
        let content = match msg.get("content").and_then(|c| c.as_array()) {
            Some(c) => c,
            None => continue,
        };
        for part in content {
            if let Some(s) = part.get("refusal").and_then(|v| v.as_str()) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
            if part.get("type").and_then(|v| v.as_str()) == Some("refusal") {
                if let Some(s) = part.get("text").and_then(|v| v.as_str()) {
                    if !s.is_empty() {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Call `/responses` once for a single image.  Returns parsed structured
/// output + usage on success; structured error otherwise.
pub async fn describe_one(
    client: &OpenAiDescribeClient,
    model: &str,
    image_bytes: &[u8],
) -> Result<(AiOutput, UsageStats), DescribeError> {
    let body = build_describe_request_body(model, image_bytes);
    let (status, text) = client
        .http
        .post_responses(&body)
        .await
        .map_err(DescribeError::Network)?;
    if !status.is_success() {
        return Err(DescribeError::HttpError {
            status: status.as_u16(),
            body: text,
        });
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| DescribeError::BadJson {
            detail: e.to_string(),
            raw_text: text.clone(),
            usage: None,
        })?;

    // Parse usage before classifying semantic failures: incomplete and
    // refused responses are still billable and commonly include usage.
    let usage_result = UsageStats::from_response(&json);

    // Detect content-moderation refusals. The Responses API surfaces
    // these as a `refusal` content part somewhere inside `output[*].content[*]`
    // — not necessarily at index 0 — and sometimes alongside (or instead
    // of) an `output_text` part. Walk every part rather than guessing a
    // fixed index.
    if let Some(refusal) = find_refusal(&json) {
        return Err(DescribeError::Refused {
            detail: refusal,
            usage: usage_result.ok(),
        });
    }

    let status_str = json["status"].as_str().unwrap_or("");
    let raw_text = find_output_text(&json).unwrap_or_default();
    if status_str == "incomplete" {
        let reason = json["incomplete_details"]["reason"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        return Err(DescribeError::Incomplete {
            reason,
            raw_text,
            usage: usage_result.ok(),
        });
    }

    let usage = usage_result.map_err(|detail| {
        log::warn!(
            "[describe] usage parse failed; cost reporting will be incomplete: {} (body: {})",
            detail,
            text
        );
        DescribeError::UsageParse {
            detail,
            raw_text: text.clone(),
        }
    })?;
    let parsed: AiOutput = serde_json::from_str(&raw_text).map_err(|e| DescribeError::BadJson {
        detail: e.to_string(),
        raw_text: raw_text.clone(),
        usage: Some(usage.clone()),
    })?;
    Ok((parsed, usage))
}

// ── Drafts composition ──────────────────────────────────────────────────────

fn utc_offset_from_seconds(seconds: i32) -> UtcOffsetValue {
    let sign = if seconds < 0 {
        OffsetSign::Minus
    } else {
        OffsetSign::Plus
    };
    let abs = seconds.unsigned_abs();
    UtcOffsetValue {
        sign,
        hours: (abs / 3600) as u8,
        minutes: ((abs % 3600) / 60) as u8,
    }
}

fn datetime_value_from_local(generated_at: chrono::DateTime<chrono::Local>) -> DateTimeValue {
    DateTimeValue {
        date: DateValue {
            year: generated_at.year(),
            month: generated_at.month() as u8,
            day: generated_at.day() as u8,
        },
        time: TimeValue {
            hour: generated_at.hour() as u8,
            minute: generated_at.minute() as u8,
            second: generated_at.second() as u8,
            subsecond: None,
            offset: Some(utc_offset_from_seconds(
                generated_at.offset().fix().local_minus_utc(),
            )),
        },
    }
}

/// Convert an `AiOutput` into the semantic draft edits for one image. Maps
/// each field onto its `XMP-mlib:*` tag.
pub fn compose_metadata_draft_edits(
    model: &str,
    output: &AiOutput,
    generated_at: chrono::DateTime<chrono::Utc>,
) -> crate::draft_edits::SchemaMetadataEditMap {
    fn text_edit(s: String) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(MetadataValue::Text(s)),
            intent: EditIntent::Set,
        }
    }
    fn list_edit(items: Vec<String>) -> MetadataDraftEdit {
        let mut seen = HashSet::new();
        let items = items
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .filter(|item| seen.insert(item.clone()))
            .map(MetadataValue::Text)
            .collect();
        MetadataDraftEdit {
            value: Some(MetadataValue::List {
                list_kind: ListKind::Bag,
                items,
            }),
            intent: EditIntent::Set,
        }
    }
    let mut edits = crate::draft_edits::SchemaMetadataEditMap::new();
    edits.insert(
        crate::known_ids::mlib_ai_description(),
        text_edit(output.description.clone()),
    );
    edits.insert(
        crate::known_ids::mlib_ai_interpretation(),
        text_edit(output.interpretation.clone()),
    );
    edits.insert(
        crate::known_ids::mlib_ai_tags(),
        list_edit(output.tags.clone()),
    );
    edits.insert(
        crate::known_ids::mlib_ai_objects(),
        list_edit(output.objects.clone()),
    );
    edits.insert(
        crate::known_ids::mlib_ai_ocr_text(),
        list_edit(output.ocr_text.clone()),
    );
    edits.insert(
        crate::known_ids::mlib_ai_model(),
        text_edit(model.to_string()),
    );
    edits.insert(
        crate::known_ids::mlib_ai_prompt_version(),
        text_edit(PROMPT_VERSION.to_string()),
    );
    let generated_at_local = generated_at.with_timezone(&chrono::Local);
    edits.insert(
        crate::known_ids::mlib_ai_generated_at(),
        MetadataDraftEdit {
            value: Some(MetadataValue::DateTime(datetime_value_from_local(
                generated_at_local,
            ))),
            intent: EditIntent::Set,
        },
    );
    edits
}

// ── Cancellation flag ───────────────────────────────────────────────────────

/// Describe-specific cancellation state.
///
/// Newtype around `BatchJobCancelState` rather than an alias: Tauri
/// keys its `State<T>` registry by `TypeId`, so two distinct alias
/// names for the same struct collide at startup. A newtype gives each
/// batch job its own `TypeId` while keeping the shared lifecycle code.
#[derive(Default)]
pub struct DescribeState(crate::batch_job::BatchJobCancelState);

impl DescribeState {
    pub fn install(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.0.install()
    }
    pub fn clear(&self) {
        self.0.clear();
    }
    pub fn signal_cancel(&self) -> bool {
        self.0.signal_cancel()
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn tiny_png_bytes() -> Vec<u8> {
        // 2x2 red PNG, just enough for `image` crate to decode.
        let mut img = image::RgbImage::new(2, 2);
        for p in img.pixels_mut() {
            *p = image::Rgb([255, 0, 0]);
        }
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    }

    #[test]
    fn image_preprocessing_applies_primary_exif_orientation() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test_images/orientation_rotate90.jpg");
        let bytes = load_and_downscale_image(&path).expect("preprocess orientation fixture");
        let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
            .expect("preprocessed output should be a JPEG");

        assert_eq!(
            (image.width(), image.height()),
            (68, 100),
            "the 100x68 stored pixels have EXIF orientation 6"
        );
    }

    #[test]
    fn gpt_5_6_reduced_pricing_matches_current_rate_card() {
        let luna = pricing_for("gpt-5.6-luna").unwrap();
        assert_eq!(luna.input_per_1m, 0.20);
        assert_eq!(luna.cached_input_per_1m, 0.02);
        assert_eq!(luna.cache_write_input_per_1m, 0.25);
        assert_eq!(luna.output_per_1m, 1.20);

        let terra = pricing_for("gpt-5.6-terra").unwrap();
        assert_eq!(terra.input_per_1m, 2.00);
        assert_eq!(terra.cached_input_per_1m, 0.20);
        assert_eq!(terra.cache_write_input_per_1m, 2.50);
        assert_eq!(terra.output_per_1m, 12.00);
    }

    #[test]
    fn pricing_has_entry_for_every_recommended_model() {
        // The settings module promises load_settings will never return an
        // unpriced model. Enforce that promise from the pricing side too:
        // if a model is added to RECOMMENDED_MODELS without a pricing row,
        // catch it here rather than at runtime in the cost estimator.
        for &m in crate::settings::RECOMMENDED_MODELS {
            assert!(
                pricing_for(m).is_some(),
                "missing pricing entry for recommended model {}",
                m
            );
        }
    }

    #[test]
    fn cost_math_matches_hand_calc() {
        // 1k input tokens at $2.5/1M + 250 output tokens at $10/1M
        //  = 0.0025 + 0.0025 = 0.005
        let p = pricing_for("gpt-4o").unwrap();
        let u = UsageStats {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: 250,
            reasoning_tokens: 0,
            ..Default::default()
        };
        let c = u.cost(&p);
        assert!((c - 0.005).abs() < 1e-9, "got {}", c);
    }

    #[test]
    fn typical_per_image_cost_matches_hand_calc_for_gpt_4o() {
        // gpt-4o: $2.50/1M input, $10/1M output.
        // 1100 input tokens + 280 total output tokens =
        //   1100/1e6 * 2.50 + 280/1e6 * 10.00 = 0.00275 + 0.00280 = 0.00555
        let c = estimate_typical_cost_per_image("gpt-4o").unwrap();
        assert!((c - 0.00555).abs() < 1e-9, "got {}", c);
    }

    #[test]
    fn heuristic_describe_cost_math_matches_hand_calc_for_two_images() {
        let total_input = heuristic_describe_input_tokens(2);
        assert_eq!(total_input, 2200);
        let (predicted, upper) =
            estimate_describe_cost_from_input_tokens("gpt-4o", total_input, 2).unwrap();
        let expected_predicted = (2200.0 / 1e6) * 2.50 + (560.0 / 1e6) * 10.00;
        let expected_upper = (2200.0 / 1e6) * 2.50 + (2400.0 / 1e6) * 10.00;
        assert!((predicted - expected_predicted).abs() < 1e-9);
        assert!((upper - expected_upper).abs() < 1e-9);
    }

    #[test]
    fn typical_per_image_cost_returns_none_for_unknown_model() {
        // Avoids the Settings dropdown silently rendering "$0/image" for a
        // model we don't price — the caller must decide how to display it.
        assert!(estimate_typical_cost_per_image("not-a-real-model").is_none());
    }

    #[test]
    fn typical_per_image_cost_is_defined_for_every_recommended_model() {
        // Parallel guard to `pricing_has_entry_for_every_recommended_model`:
        // if a model joins the recommended set, the dropdown estimator must
        // know about it too.
        for &m in crate::settings::RECOMMENDED_MODELS {
            assert!(
                estimate_typical_cost_per_image(m).is_some(),
                "missing typical cost for recommended model {}",
                m
            );
        }
    }

    #[test]
    fn cached_tokens_use_cached_rate_for_their_share() {
        // 800 cached + 200 non-cached at gpt-4o ($2.5 + $1.25 cached) plus 0 output.
        let p = pricing_for("gpt-4o").unwrap();
        let u = UsageStats {
            input_tokens: 1000,
            cached_input_tokens: 800,
            output_tokens: 0,
            reasoning_tokens: 0,
            ..Default::default()
        };
        let expected = (200.0 / 1e6) * 2.50 + (800.0 / 1e6) * 1.25;
        assert!((u.cost(&p) - expected).abs() < 1e-9);
    }

    #[test]
    fn reasoning_tokens_are_not_billed_twice() {
        let p = pricing_for("gpt-5.6-luna").unwrap();
        let u = UsageStats {
            output_tokens: 1186,
            reasoning_tokens: 1024,
            ..Default::default()
        };
        let expected = (1186.0 / 1e6) * 1.2;
        assert!((u.cost(&p) - expected).abs() < 1e-12);
        assert_eq!(u.non_reasoning_output_tokens(), 162);
    }

    #[test]
    fn gpt_5_6_cache_reads_and_writes_use_distinct_rates() {
        let p = pricing_for("gpt-5.6-luna").unwrap();
        let u = UsageStats {
            input_tokens: 1000,
            cached_input_tokens: 300,
            cache_write_input_tokens: 200,
            ..Default::default()
        };
        let expected = (500.0 / 1e6) * 0.20 + (300.0 / 1e6) * 0.02 + (200.0 / 1e6) * 0.25;
        assert!((u.cost(&p) - expected).abs() < 1e-12);
    }

    #[test]
    fn gpt_5_describe_requests_low_reasoning_effort() {
        let body = build_describe_request_body("gpt-5.6-luna", &tiny_png_bytes());
        assert_eq!(body["prompt_cache_options"]["mode"], "explicit");
        assert_eq!(body["prompt_cache_options"]["ttl"], "30m");
        assert!(body.to_string().find("prompt_cache_breakpoint").is_none());
        assert_eq!(body["reasoning"]["effort"], "low");
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
    }

    #[test]
    fn non_reasoning_describe_model_omits_reasoning_config() {
        let body = build_describe_request_body("gpt-4o", &tiny_png_bytes());
        assert!(body.get("prompt_cache_options").is_none());
        assert!(body.get("reasoning").is_none());
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["top_p"], 1);
    }

    #[test]
    fn compose_metadata_draft_edits_maps_every_field_to_mlib_namespace() {
        let out = AiOutput {
            description: "a thing".into(),
            objects: vec!["a".into(), "b".into()],
            tags: vec!["x".into()],
            ocr_text: vec![],
            interpretation: "looks calm".into(),
        };
        let ts = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
            chrono::DateTime::parse_from_rfc3339("2024-06-01T12:34:56Z")
                .unwrap()
                .naive_utc(),
            chrono::Utc,
        );
        let edits = compose_metadata_draft_edits("gpt-4o", &out, ts);

        // Every expected key is present.
        for k in [
            "XMP-mlib:AIDescription",
            "XMP-mlib:AIInterpretation",
            "XMP-mlib:AITags",
            "XMP-mlib:AIObjects",
            "XMP-mlib:AIOcrText",
            "XMP-mlib:AIModel",
            "XMP-mlib:AIPromptVersion",
            "XMP-mlib:AIGeneratedAt",
        ] {
            assert!(
                edits.contains_key(&crate::known_ids::test_id(k)),
                "missing draft for {}",
                k
            );
        }

        // Bag tags carry a semantic list, not a comma-joined string — the
        // bug history (keywords-CSV corruption) makes this worth asserting.
        match &edits[&crate::known_ids::mlib_ai_objects()].value {
            Some(MetadataValue::List { list_kind, items }) => {
                assert_eq!(*list_kind, ListKind::Bag);
                assert_eq!(
                    items,
                    &vec![
                        MetadataValue::Text("a".to_string()),
                        MetadataValue::Text("b".to_string())
                    ]
                );
            }
            other => panic!("expected semantic list, got {:?}", other),
        }
        match &edits[&crate::known_ids::mlib_ai_description()].value {
            Some(MetadataValue::Text(s)) => assert_eq!(s, "a thing"),
            other => panic!("expected text value, got {:?}", other),
        }
        match &edits[&crate::known_ids::mlib_ai_generated_at()].value {
            Some(MetadataValue::DateTime(dt)) => {
                assert_eq!(dt.date.year, 2024);
                assert!(dt.time.offset.is_some(), "expected local offset");
            }
            other => panic!("expected datetime value, got {:?}", other),
        }
    }

    #[test]
    fn compose_metadata_draft_edits_cleans_ai_list_items() {
        let out = AiOutput {
            description: String::new(),
            objects: vec![],
            tags: vec![
                " shoppers ".into(),
                " ".into(),
                "shoppers".into(),
                "\tcar-park\r\n".into(),
            ],
            ocr_text: vec![],
            interpretation: String::new(),
        };
        let generated_at = chrono::DateTime::parse_from_rfc3339("2024-06-01T12:34:56Z")
            .unwrap()
            .with_timezone(&chrono::Utc);

        let edits = compose_metadata_draft_edits("gpt-4o", &out, generated_at);

        match &edits[&crate::known_ids::mlib_ai_tags()].value {
            Some(MetadataValue::List { list_kind, items }) => {
                assert_eq!(*list_kind, ListKind::Bag);
                assert_eq!(
                    items,
                    &vec![
                        MetadataValue::Text("shoppers".to_string()),
                        MetadataValue::Text("car-park".to_string()),
                    ]
                );
            }
            other => panic!("expected semantic list, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn describe_one_parses_happy_path_response() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "status": "completed",
            "output": [{
                "content": [{
                    "type": "output_text",
                    "text": "{\"description\":\"d\",\"objects\":[\"o\"],\"tags\":[\"t\"],\"ocr_text\":[],\"interpretation\":\"\"}"
                }]
            }],
            "usage": {
                "input_tokens": 1234,
                "input_tokens_details": { "cached_tokens": 0 },
                "output_tokens": 56,
                "output_tokens_details": { "reasoning_tokens": 0 }
            }
        });
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = OpenAiDescribeClient::new(server.uri(), "k", 1);
        let (out, usage) = describe_one(&client, "gpt-4o", &tiny_png_bytes())
            .await
            .unwrap();
        assert_eq!(out.description, "d");
        assert_eq!(usage.input_tokens, 1234);
        assert_eq!(usage.output_tokens, 56);
    }

    #[tokio::test]
    async fn describe_one_returns_incomplete_when_status_is_incomplete() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": [{ "content": [{ "type": "output_text", "text": "{\"descr" }] }],
            "service_tier": "default",
            "reasoning": {"effort": "medium"},
            "usage": { "input_tokens": 10,
                       "input_tokens_details": {"cached_tokens":2,"cache_write_tokens":3},
                       "output_tokens": 600, "output_tokens_details": {"reasoning_tokens":550} }
        });
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let client = OpenAiDescribeClient::new(server.uri(), "k", 1);
        match describe_one(&client, "gpt-4o", &tiny_png_bytes()).await {
            Err(DescribeError::Incomplete { reason, usage, .. }) => {
                assert_eq!(reason, "max_output_tokens");
                let usage = usage.expect("billable incomplete response keeps usage");
                assert_eq!(usage.cached_input_tokens, 2);
                assert_eq!(usage.cache_write_input_tokens, 3);
                assert_eq!(usage.output_tokens, 600);
                assert_eq!(usage.reasoning_tokens, 550);
                assert_eq!(usage.non_reasoning_output_tokens(), 50);
                assert_eq!(usage.service_tier, "default");
                assert_eq!(usage.reasoning_effort, "medium");
            }
            other => panic!("expected Incomplete, got {:?}", other),
        }
    }

    #[test]
    fn find_refusal_locates_refusal_at_non_zero_content_index() {
        // Real-world shape: a reasoning model can prepend other content
        // parts before the refusal. The previous index-0 lookup missed
        // refusals when content[0] was, say, a reasoning summary.
        let json = serde_json::json!({
            "output": [{ "content": [
                { "type": "output_text", "text": "" },
                { "type": "refusal", "refusal": "cannot help" }
            ]}]
        });
        assert_eq!(find_refusal(&json).as_deref(), Some("cannot help"));
    }

    #[test]
    fn find_refusal_returns_none_when_no_refusal_present() {
        let json = serde_json::json!({
            "output": [{ "content": [{ "type": "output_text", "text": "ok" }] }]
        });
        assert!(find_refusal(&json).is_none());
    }

    #[tokio::test]
    async fn describe_one_returns_refused_when_refusal_field_present() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "status": "completed",
            "output": [{ "content": [{ "type": "refusal", "refusal": "cannot help" }] }],
            "usage": { "input_tokens": 1, "input_tokens_details": {"cached_tokens":0},
                       "output_tokens": 0, "output_tokens_details": {"reasoning_tokens":0} }
        });
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let client = OpenAiDescribeClient::new(server.uri(), "k", 1);
        match describe_one(&client, "gpt-4o", &tiny_png_bytes()).await {
            Err(DescribeError::Refused { detail, .. }) => assert_eq!(detail, "cannot help"),
            other => panic!("expected Refused, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn describe_one_returns_usage_parse_when_usage_block_is_missing() {
        // Defensive: if OpenAI changes the response shape, cost reporting
        // must fail loudly rather than silently report $0. The audit log
        // and the per-image failure list both rely on this error path.
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "status": "completed",
            "output": [{ "content": [{ "type": "output_text",
                "text": "{\"description\":\"d\",\"objects\":[],\"tags\":[],\"ocr_text\":[],\"interpretation\":\"\"}" }] }]
            // usage intentionally absent
        });
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let client = OpenAiDescribeClient::new(server.uri(), "k", 1);
        match describe_one(&client, "gpt-4o", &tiny_png_bytes()).await {
            Err(DescribeError::UsageParse { detail, .. }) => {
                assert!(detail.contains("usage"), "got: {}", detail);
            }
            other => panic!("expected UsageParse, got {:?}", other),
        }
    }

    #[test]
    fn from_response_returns_err_when_input_tokens_missing() {
        // Targeted at the parser itself rather than the full HTTP path, so
        // future shape changes are diagnosed without spinning up a mock.
        let json = serde_json::json!({
            "usage": { "output_tokens": 42, "input_tokens_details": {} }
        });
        let err = UsageStats::from_response(&json).expect_err("must fail on missing input_tokens");
        assert!(err.contains("input_tokens"), "got: {}", err);
    }

    #[test]
    fn from_response_tolerates_missing_optional_sub_blocks() {
        // cached/reasoning details are model-specific and may be absent;
        // these legitimate gaps should not break cost reporting.
        let json = serde_json::json!({
            "usage": { "input_tokens": 100, "output_tokens": 20 }
        });
        let u = UsageStats::from_response(&json).expect("required fields present");
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 20);
        assert_eq!(u.cached_input_tokens, 0);
        assert_eq!(u.cache_write_input_tokens, 0);
        assert_eq!(u.reasoning_tokens, 0);
        assert!(u.service_tier.is_empty());
        assert!(u.reasoning_effort.is_empty());
    }

    #[test]
    fn from_response_rejects_overlapping_input_detail_totals() {
        let json = serde_json::json!({
            "usage": {
                "input_tokens": 100,
                "input_tokens_details": {"cached_tokens": 80, "cache_write_tokens": 30},
                "output_tokens": 1
            }
        });
        let err = UsageStats::from_response(&json).expect_err("detail total must fit input");
        assert!(err.contains("exceed input_tokens"), "got: {}", err);
    }

    #[tokio::test]
    async fn describe_one_retries_then_succeeds_on_429() {
        // First call returns a retryable OpenAI TPM limit, second returns 200.
        // The shared transport should ride through it transparently.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(429).set_body_json(serde_json::json!({
                "error": {"code": "rate_limit_exceeded"}
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "completed",
                "output": [{ "content": [{ "type": "output_text",
                    "text": "{\"description\":\"d\",\"objects\":[],\"tags\":[],\"ocr_text\":[],\"interpretation\":\"\"}" }] }],
                "usage": { "input_tokens": 1, "input_tokens_details": {"cached_tokens":0},
                           "output_tokens": 1, "output_tokens_details": {"reasoning_tokens":0} }
            })))
            .mount(&server).await;
        let client = OpenAiDescribeClient::new(server.uri(), "k", 3);
        let (out, _) = describe_one(&client, "gpt-4o", &tiny_png_bytes())
            .await
            .unwrap();
        assert_eq!(out.description, "d");
    }

    /// Manual diagnostic for a previously capped production image. Kept
    /// ignored so ordinary test runs remain offline and deterministic.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    #[ignore = "live OpenAI diagnostic; sends one local image"]
    async fn live_reproduce_previous_max_output_tokens_failure() {
        let app_data = std::path::PathBuf::from(
            std::env::var("APPDATA").expect("APPDATA must be available on Windows"),
        )
        .join("com.xman2.medialibrary");
        let settings = crate::settings::load_settings(&app_data).expect("load app settings");
        let image_paths: Vec<std::path::PathBuf> =
            if let Some(paths) = std::env::var_os("MEDIALIBRARY_LIVE_IMAGES") {
                std::env::split_paths(&paths).collect()
            } else {
                vec![std::path::PathBuf::from(
                    std::env::var_os("MEDIALIBRARY_LIVE_IMAGE")
                        .expect("set MEDIALIBRARY_LIVE_IMAGE or MEDIALIBRARY_LIVE_IMAGES"),
                )]
            };
        assert!(!image_paths.is_empty(), "at least one image is required");
        let client = OpenAiDescribeClient::new(DEFAULT_BASE_URL, &settings.openai_api_key, 1);

        for image_path in image_paths {
            let bytes = load_and_downscale_image(&image_path).expect("load diagnostic image");
            match describe_one(&client, &settings.openai_model, &bytes).await {
                Ok((output, usage)) => eprintln!(
                    "LIVE_RESULT_JSON {}",
                    serde_json::json!({
                        "path": image_path,
                        "status": "completed",
                        "usage": usage,
                        "non_reasoning_output_tokens": usage.non_reasoning_output_tokens(),
                        "output": output,
                    })
                ),
                Err(error) => {
                    eprintln!(
                        "LIVE_RESULT_JSON {}",
                        serde_json::json!({
                            "path": image_path,
                            "status": "failed",
                            "kind": error.kind(),
                            "detail": error.detail(),
                            "usage": error.usage(),
                        })
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn count_input_tokens_returns_server_count_and_strips_sampling_params() {
        // The /input_tokens endpoint rejects runtime-only response parameters.
        // We must strip them before sending. Mock asserts on the body shape
        // by responding to ANY POST, but the contract is that the request
        // succeeds, which it wouldn't against the real API if we forgot the
        // strip. Here we just assert the server count comes back through.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses/input_tokens"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "input_tokens": 4242
            })))
            .mount(&server)
            .await;
        let client = OpenAiDescribeClient::new(server.uri(), "k", 1);
        let n = count_input_tokens(&client, "gpt-4o", &tiny_png_bytes())
            .await
            .unwrap();
        assert_eq!(n, 4242);
    }
}
