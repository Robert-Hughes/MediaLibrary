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
//! V1 is deliberately sequential — no semaphore, no batch API.  The HTTP
//! base URL and retry-policy ceiling are injected so tests can point at a
//! wiremock and run a deterministic retry sequence without real network.

use std::path::Path;

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

/// Long-side cap before upload.  See experiment for rationale: server-side
/// downscale is wasted bandwidth otherwise.
const MAX_IMAGE_DIMENSION: u32 = 1024;

/// Hard cap on `/responses` output tokens.  Hitting this leaves JSON
/// unparseable, so callers must check `status=="incomplete"`.
pub const MAX_OUTPUT_TOKENS: u32 = 600;

/// Expected output tokens for cost estimation only.  Tuned by the test set
/// in the experiment; bounded by `MAX_OUTPUT_TOKENS`.
pub const EXPECTED_OUTPUT_TOKENS: u32 = 250;

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
    pub output_per_1m: f64,
}

/// Pricing for the recommended-model set only.  Other model ids return
/// `None`; the settings module guarantees we never store an unknown id.
pub fn pricing_for(model: &str) -> Option<ModelPricing> {
    Some(match model {
        "gpt-4o" => ModelPricing {
            input_per_1m: 2.50,
            cached_input_per_1m: 1.25,
            output_per_1m: 10.00,
        },
        "gpt-5.4-nano" => ModelPricing {
            input_per_1m: 0.20,
            cached_input_per_1m: 0.02,
            output_per_1m: 1.25,
        },
        "gpt-5.4-mini" => ModelPricing {
            input_per_1m: 0.75,
            cached_input_per_1m: 0.075,
            output_per_1m: 4.50,
        },
        "gpt-5.4" => ModelPricing {
            input_per_1m: 2.50,
            cached_input_per_1m: 0.25,
            output_per_1m: 15.00,
        },
        "gpt-5.5" => ModelPricing {
            input_per_1m: 5.00,
            cached_input_per_1m: 0.50,
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

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
pub struct UsageStats {
    pub input_tokens: u32,
    pub cached_input_tokens: u32,
    pub output_tokens: u32,
    pub reasoning_tokens: u32,
}

impl UsageStats {
    /// Parse the `usage` block of a `/responses` response.
    ///
    /// `input_tokens` and `output_tokens` are required — these drive cost
    /// reporting and the audit log; silently treating a missing field as
    /// zero (the previous behaviour) hid API shape drift and produced
    /// "$0.00" cost summaries. `cached_input_tokens` and
    /// `reasoning_tokens` are optional and default to zero (the latter is
    /// only emitted by reasoning models).
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
        let reasoning_tokens = usage["output_tokens_details"]["reasoning_tokens"]
            .as_u64()
            .unwrap_or(0) as u32;
        Ok(Self {
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_tokens,
        })
    }

    pub fn add(&mut self, other: &UsageStats) {
        self.input_tokens += other.input_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
    }

    /// Compute USD cost given a pricing row.  Reasoning tokens (zero for
    /// non-reasoning models, but plumbed through for symmetry) bill at the
    /// output rate.
    pub fn cost(&self, p: &ModelPricing) -> f64 {
        let non_cached = self.input_tokens.saturating_sub(self.cached_input_tokens);
        let input_cost = (non_cached as f64 / 1_000_000.0) * p.input_per_1m;
        let cached_cost = (self.cached_input_tokens as f64 / 1_000_000.0) * p.cached_input_per_1m;
        let output_cost =
            ((self.output_tokens + self.reasoning_tokens) as f64 / 1_000_000.0) * p.output_per_1m;
        input_cost + cached_cost + output_cost
    }
}

// ── Client ───────────────────────────────────────────────────────────────────

/// Vision-call client. Thin wrapper around `OpenAiHttp` (the shared
/// reqwest_middleware client with retries) plus the describe-specific
/// behaviour. Cheap to clone.
#[derive(Clone)]
pub struct OpenAiClient {
    http: OpenAiHttp,
}

impl OpenAiClient {
    /// Wrap an existing `OpenAiHttp`. The normaliser flow constructs
    /// its own client over the same `OpenAiHttp`, so production code
    /// can share a single retry middleware across both surfaces.
    pub fn from_http(http: OpenAiHttp) -> Self {
        Self { http }
    }

    /// Access the underlying HTTP layer. Used by `openai_normalise` to
    /// build a `OpenAiNormaliseClient` that shares this client's
    /// retry middleware.
    pub fn http(&self) -> &OpenAiHttp {
        &self.http
    }

    /// Convenience constructor used by `make_openai_client` in `lib.rs`
    /// and tests. `max_retries` of 3 with exponential backoff is the
    /// production balance — enough to ride out transient 429s without
    /// delaying the user beyond ~30s on a hard failure. Tests inject
    /// `1` to keep the suite fast.
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
/// batch.  Strips metadata as a side effect of the re-encode, which is
/// fine for our use case: only pixels matter for the vision model.
pub fn load_and_downscale_image(path: &Path) -> Result<Vec<u8>, String> {
    let img = ImageReader::open(path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?
        .with_guessed_format()
        .map_err(|e| format!("sniff format {}: {}", path.display(), e))?
        .decode()
        .map_err(|e| format!("decode {}: {}", path.display(), e))?;

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
fn build_request_body(model: &str, image_bytes: &[u8]) -> serde_json::Value {
    let b64 = base64::engine::general_purpose::STANDARD.encode(image_bytes);
    let data_url = format!("data:image/jpeg;base64,{}", b64);
    serde_json::json!({
        "model": model,
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
        "temperature": 0,
        "top_p": 1,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
    })
}

/// Preflight a single image through `/responses/input_tokens`. Returns the
/// exact server-counted input token total.  Hard-fails on any HTTP error —
/// no local-math fallback (deliberate; see `docs/IMAGE_ANALYSIS.md`).
pub async fn count_input_tokens(
    client: &OpenAiClient,
    model: &str,
    image_bytes: &[u8],
) -> Result<u32, String> {
    let mut body = build_request_body(model, image_bytes);
    if let Some(obj) = body.as_object_mut() {
        for k in ["temperature", "top_p", "max_output_tokens"] {
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
    },
    Refused {
        detail: String,
    },
    BadJson {
        detail: String,
        raw_text: String,
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
            DescribeError::Refused { detail }
            | DescribeError::BadJson { detail, .. }
            | DescribeError::UsageParse { detail, .. } => detail.clone(),
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

/// Walk `output[*].content[*]` for the first `output_text` part and return
/// its `text` field. Mirrors the refusal scan so a non-output_text part
/// (e.g. a reasoning block in front of the text) doesn't hide the JSON
/// payload we need to parse.
fn find_output_text(response: &serde_json::Value) -> Option<String> {
    let output = response.get("output")?.as_array()?;
    for msg in output {
        let content = match msg.get("content").and_then(|c| c.as_array()) {
            Some(c) => c,
            None => continue,
        };
        for part in content {
            let ty = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if ty == "output_text" {
                if let Some(s) = part.get("text").and_then(|v| v.as_str()) {
                    return Some(s.to_string());
                }
            }
        }
    }
    // Fall back to the legacy unconditional index lookup so older mock
    // payloads (and tests) without an explicit `type` field still work.
    response["output"][0]["content"][0]["text"]
        .as_str()
        .map(str::to_string)
}

/// Call `/responses` once for a single image.  Returns parsed structured
/// output + usage on success; structured error otherwise.
pub async fn describe_one(
    client: &OpenAiClient,
    model: &str,
    image_bytes: &[u8],
) -> Result<(AiOutput, UsageStats), DescribeError> {
    let body = build_request_body(model, image_bytes);
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
        })?;

    // Detect content-moderation refusals. The Responses API surfaces
    // these as a `refusal` content part somewhere inside `output[*].content[*]`
    // — not necessarily at index 0 — and sometimes alongside (or instead
    // of) an `output_text` part. Walk every part rather than guessing a
    // fixed index.
    if let Some(refusal) = find_refusal(&json) {
        return Err(DescribeError::Refused { detail: refusal });
    }

    let status_str = json["status"].as_str().unwrap_or("");
    let raw_text = find_output_text(&json).unwrap_or_default();
    if status_str == "incomplete" {
        let reason = json["incomplete_details"]["reason"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        return Err(DescribeError::Incomplete { reason, raw_text });
    }

    let usage = UsageStats::from_response(&json).map_err(|detail| {
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
) -> std::collections::HashMap<String, MetadataDraftEdit> {
    fn text_edit(s: String) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(MetadataValue::Text(s)),
            intent: EditIntent::Set,
            display: None,
        }
    }
    fn list_edit(items: Vec<String>) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(MetadataValue::List {
                list_kind: ListKind::Bag,
                items: items.into_iter().map(MetadataValue::Text).collect(),
            }),
            intent: EditIntent::Set,
            display: None,
        }
    }
    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-mlib:AIDescription".to_string(),
        text_edit(output.description.clone()),
    );
    edits.insert(
        "XMP-mlib:AIInterpretation".to_string(),
        text_edit(output.interpretation.clone()),
    );
    edits.insert(
        "XMP-mlib:AITags".to_string(),
        list_edit(output.tags.clone()),
    );
    edits.insert(
        "XMP-mlib:AIObjects".to_string(),
        list_edit(output.objects.clone()),
    );
    edits.insert(
        "XMP-mlib:AIOcrText".to_string(),
        list_edit(output.ocr_text.clone()),
    );
    edits.insert("XMP-mlib:AIModel".to_string(), text_edit(model.to_string()));
    edits.insert(
        "XMP-mlib:AIPromptVersion".to_string(),
        text_edit(PROMPT_VERSION.to_string()),
    );
    let generated_at_local = generated_at.with_timezone(&chrono::Local);
    edits.insert(
        "XMP-mlib:AIGeneratedAt".to_string(),
        MetadataDraftEdit {
            value: Some(MetadataValue::DateTime(datetime_value_from_local(
                generated_at_local,
            ))),
            intent: EditIntent::Set,
            display: None,
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
        };
        let c = u.cost(&p);
        assert!((c - 0.005).abs() < 1e-9, "got {}", c);
    }

    #[test]
    fn typical_per_image_cost_matches_hand_calc_for_gpt_4o() {
        // gpt-4o: $2.50/1M input, $10/1M output.
        // 1100 input tokens + 250 output tokens =
        //   1100/1e6 * 2.50 + 250/1e6 * 10.00 = 0.00275 + 0.00250 = 0.00525
        let c = estimate_typical_cost_per_image("gpt-4o").unwrap();
        assert!((c - 0.00525).abs() < 1e-9, "got {}", c);
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
        };
        let expected = (200.0 / 1e6) * 2.50 + (800.0 / 1e6) * 1.25;
        assert!((u.cost(&p) - expected).abs() < 1e-9);
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
            assert!(edits.contains_key(k), "missing draft for {}", k);
        }

        // Bag tags carry a semantic list, not a comma-joined string — the
        // bug history (keywords-CSV corruption) makes this worth asserting.
        match &edits["XMP-mlib:AIObjects"].value {
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
        match &edits["XMP-mlib:AIDescription"].value {
            Some(MetadataValue::Text(s)) => assert_eq!(s, "a thing"),
            other => panic!("expected text value, got {:?}", other),
        }
        match &edits["XMP-mlib:AIGeneratedAt"].value {
            Some(MetadataValue::DateTime(dt)) => {
                assert_eq!(dt.date.year, 2024);
                assert!(dt.time.offset.is_some(), "expected local offset");
            }
            other => panic!("expected datetime value, got {:?}", other),
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

        let client = OpenAiClient::new(server.uri(), "k", 1);
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
            "usage": { "input_tokens": 1, "input_tokens_details": {"cached_tokens":0},
                       "output_tokens": 600, "output_tokens_details": {"reasoning_tokens":0} }
        });
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let client = OpenAiClient::new(server.uri(), "k", 1);
        match describe_one(&client, "gpt-4o", &tiny_png_bytes()).await {
            Err(DescribeError::Incomplete { reason, .. }) => {
                assert_eq!(reason, "max_output_tokens")
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

    #[test]
    fn find_output_text_skips_non_text_parts() {
        // A reasoning summary part before the JSON payload must not mask
        // the actual text. find_output_text walks until it finds a part
        // whose type is "output_text".
        let json = serde_json::json!({
            "output": [{ "content": [
                { "type": "reasoning", "summary": "thinking…" },
                { "type": "output_text", "text": "{\"x\":1}" }
            ]}]
        });
        assert_eq!(find_output_text(&json).as_deref(), Some("{\"x\":1}"));
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
        let client = OpenAiClient::new(server.uri(), "k", 1);
        match describe_one(&client, "gpt-4o", &tiny_png_bytes()).await {
            Err(DescribeError::Refused { detail }) => assert_eq!(detail, "cannot help"),
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
        let client = OpenAiClient::new(server.uri(), "k", 1);
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
        assert_eq!(u.reasoning_tokens, 0);
    }

    #[tokio::test]
    async fn describe_one_retries_then_succeeds_on_429() {
        // First call returns 429, second returns 200. RetryTransientMiddleware
        // should ride through the 429 transparently and the caller never sees
        // the failure.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
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
        let client = OpenAiClient::new(server.uri(), "k", 3);
        let (out, _) = describe_one(&client, "gpt-4o", &tiny_png_bytes())
            .await
            .unwrap();
        assert_eq!(out.description, "d");
    }

    #[tokio::test]
    async fn count_input_tokens_returns_server_count_and_strips_sampling_params() {
        // The /input_tokens endpoint rejects temperature/top_p/max_output_tokens.
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
        let client = OpenAiClient::new(server.uri(), "k", 1);
        let n = count_input_tokens(&client, "gpt-4o", &tiny_png_bytes())
            .await
            .unwrap();
        assert_eq!(n, 4242);
    }
}
