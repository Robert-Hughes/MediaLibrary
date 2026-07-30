//! AI infrastructure shared by Group B (Description), Group C (Title),
//! and Group G (Location).
//!
//! `NormaliseAiClient` is the injection seam — production wires
//! `OpenAiNormaliseClient` (see `openai_normalise.rs`); tests
//! substitute in mocks. `CapturingAiClient` is a deterministic stand-in
//! used by the cost-estimate phase to walk Groups B / C / G without
//! dispatching real HTTP calls.
//!
//! `NormaliseAuditEntry` is the JSONL row shape persisted by the
//! dispatcher; `PerImageAiCall` is the in-memory record returned by
//! the per-image walker so the dispatcher can append exactly one row
//! per AI call.

use serde::{Deserialize, Serialize};

/// Typed AI failure surfaced by Groups B / C / G up to the dispatcher.
/// Mapped to a `BatchFailureKind` so per-image failure rows preserve
/// the failure mode (rate-limit, transport, bad JSON, missing key).
#[derive(Debug, Clone)]
pub struct NormaliseAiError {
    pub kind: crate::batch_job::BatchFailureKind,
    pub detail: String,
    pub usage: Option<AiCallUsage>,
}

impl NormaliseAiError {
    pub fn key_missing() -> Self {
        Self {
            kind: crate::batch_job::BatchFailureKind::AiKeyMissing,
            detail: "OpenAI API key is not configured. Open Settings to enter your key.".into(),
            usage: None,
        }
    }

    /// Classify a `String` error returned by `NormaliseAiClient` calls
    /// into a typed BatchFailureKind. Recognises `HTTP 429` for rate
    /// limiting, `HTTP <other>` and `network error:` prefixes for
    /// transport failures, schema-shaped strings for malformed
    /// responses, and falls back to `AiCallFailed` otherwise.
    pub fn from_client_string(detail: String) -> Self {
        use crate::batch_job::BatchFailureKind as K;
        let kind = if detail.starts_with("HTTP 429") {
            K::AiRateLimited
        } else if detail.starts_with("HTTP ") || detail.starts_with("network error:") {
            K::AiCallFailed
        } else if detail.starts_with("missing output[")
            || detail.starts_with("bad description JSON")
            || detail.starts_with("bad title JSON")
            || detail.starts_with("bad location JSON")
            || detail.starts_with("bad JSON")
        {
            K::AiSchemaInvalid
        } else {
            K::AiCallFailed
        };
        Self {
            kind,
            detail,
            usage: None,
        }
    }

    pub fn with_usage(mut self, usage: AiCallUsage) -> Self {
        self.usage = Some(usage);
        self
    }
}

impl From<String> for NormaliseAiError {
    fn from(detail: String) -> Self {
        Self::from_client_string(detail)
    }
}

impl From<&str> for NormaliseAiError {
    fn from(detail: &str) -> Self {
        Self::from_client_string(detail.to_string())
    }
}

/// Per-call token usage returned by `NormaliseAiClient` implementors.
/// Mock clients can return `Default::default()`; the production
/// `OpenAiNormaliseClient` parses these out of the `/responses`
/// response body so the audit log can record real cost.
pub type AiCallUsage = crate::openai_describe::UsageStats;

/// Per-AI-call record returned by `process_image` so the dispatcher
/// can append a row to the JSONL audit log for each one. Includes
/// successful calls (with usage) and failed calls (with detail).
#[derive(Debug, Clone)]
pub struct PerImageAiCall {
    /// `"description"` (Group B) or `"title"` (Group C).
    pub group: &'static str,
    pub usage: AiCallUsage,
    /// `None` on success; `Some(detail)` when the call failed.
    pub error: Option<String>,
}

/// Audit-log row recorded for one AI call. Written to a JSONL file by
/// the dispatcher; shape matches plan §6 "cost audit".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct NormaliseAuditEntry {
    pub ts: String,
    pub model: String,
    pub prompt_version: String,
    /// `"description"` (Group B) or `"title"` (Group C).
    pub group: String,
    pub input_tokens: u32,
    #[serde(default)]
    pub cached_input_tokens: u32,
    #[serde(default)]
    pub cache_write_input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default)]
    pub reasoning_tokens: u32,
    #[serde(default)]
    pub non_reasoning_output_tokens: u32,
    #[serde(default)]
    pub service_tier: String,
    #[serde(default)]
    pub reasoning_effort: String,
    pub cost_usd: f64,
    /// Empty string on success; failure detail otherwise.
    pub error: String,
    pub relative_path: String,
}

/// AI-call inputs passed to the Description merge prompt builder.
/// Surfaced separately so tests can inspect the prompt without a real
/// HTTP client.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct DescriptionMergePrompt {
    pub description_sources: std::collections::BTreeMap<String, String>,
    pub ai_context: std::collections::BTreeMap<String, serde_json::Value>,
    pub location: serde_json::Value,
    pub keywords: Vec<String>,
    pub date: Option<String>,
}

/// Title-generation prompt body.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct TitleGenPrompt {
    pub description: String,
    pub location: serde_json::Value,
    pub keywords: Vec<String>,
}

/// Compact, labelled reverse-geocode evidence supplied to the location
/// resolver. Raw Nominatim documents remain in `LocationInput` for
/// deterministic identifiers and are projected into this text before AI.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct LocationResolvePrompt {
    pub evidence: String,
}

/// Human-facing LocationCreated members selected or composed by AI. Factual
/// identifiers and camera coordinates are added deterministically by the app.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocationAiResult {
    pub sublocation: Option<String>,
    pub city: Option<String>,
    pub province_state: Option<String>,
    pub country_name: Option<String>,
    pub world_region: Option<String>,
    pub location_name: Option<String>,
}

/// Trait that an injected AI client implements for Group B (and Group
/// C). Tests substitute a mock; production wires
/// `OpenAiNormaliseClient` (see `openai_normalise.rs`).
#[async_trait::async_trait]
pub trait NormaliseAiClient: Send + Sync {
    /// Returns the canonical merged/generated Description plus per-call token
    /// usage. Errors are surfaced to the caller and turned into
    /// per-image failure rows.
    async fn merge_description(
        &self,
        prompt: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), NormaliseAiError>;

    /// Generate a short title from a description + context. Case-3
    /// Title AI path.
    async fn generate_title(
        &self,
        prompt: TitleGenPrompt,
    ) -> Result<(String, AiCallUsage), NormaliseAiError>;

    /// Resolve raw Nominatim responses into the human-facing members of one
    /// canonical LocationCreated structure.
    async fn resolve_location(
        &self,
        _prompt: LocationResolvePrompt,
    ) -> Result<(LocationAiResult, AiCallUsage), NormaliseAiError> {
        Err(NormaliseAiError::from(
            "location resolution is not implemented by this AI client",
        ))
    }
}

/// Captures the prompts that would have fired so the estimate phase
/// (plan §7) can preflight them against `/responses/input_tokens`
/// without actually dispatching. Returns deterministic stand-ins from
/// the trait calls so the dispatcher can still walk Group C with a
/// plausible description canonical when Group B is in case-2 or case-5.
#[derive(Default)]
pub struct CapturingAiClient {
    pub description_prompts: tokio::sync::Mutex<Vec<DescriptionMergePrompt>>,
    pub title_prompts: tokio::sync::Mutex<Vec<TitleGenPrompt>>,
    pub location_prompts: tokio::sync::Mutex<Vec<LocationResolvePrompt>>,
}

#[async_trait::async_trait]
impl NormaliseAiClient for CapturingAiClient {
    async fn merge_description(
        &self,
        p: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), NormaliseAiError> {
        let mut stand_in = p
            .description_sources
            .values()
            .find(|s| !s.is_empty())
            .cloned()
            .unwrap_or_default();
        if stand_in.is_empty() {
            stand_in = "Placeholder description.".to_string();
        }
        self.description_prompts.lock().await.push(p);
        Ok((stand_in, AiCallUsage::default()))
    }

    async fn generate_title(
        &self,
        p: TitleGenPrompt,
    ) -> Result<(String, AiCallUsage), NormaliseAiError> {
        let stand_in = p
            .description
            .split_whitespace()
            .take(8)
            .collect::<Vec<_>>()
            .join(" ");
        self.title_prompts.lock().await.push(p);
        Ok((stand_in, AiCallUsage::default()))
    }

    async fn resolve_location(
        &self,
        p: LocationResolvePrompt,
    ) -> Result<(LocationAiResult, AiCallUsage), NormaliseAiError> {
        self.location_prompts.lock().await.push(p);
        Ok((
            LocationAiResult {
                city: Some("Placeholder city".into()),
                country_name: Some("Placeholder country".into()),
                ..Default::default()
            },
            AiCallUsage::default(),
        ))
    }
}
