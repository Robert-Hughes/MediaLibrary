//! AI infrastructure shared by Group B (Description) and Group C
//! (Title).
//!
//! `NormaliseAiClient` is the injection seam — production wires
//! `OpenAiNormaliseClient` (see `openai_normalise.rs`); tests
//! substitute in mocks. `CapturingAiClient` is a deterministic stand-in
//! used by the cost-estimate phase to walk Group B / Group C without
//! dispatching real HTTP calls.
//!
//! `NormaliseAuditEntry` is the JSONL row shape persisted by the
//! dispatcher; `PerImageAiCall` is the in-memory record returned by
//! the per-image walker so the dispatcher can append exactly one row
//! per AI call.

use serde::Serialize;

/// Typed AI failure surfaced by Group B / Group C up to the dispatcher.
/// Mapped to a `BatchFailureKind` so per-image failure rows preserve
/// the failure mode (rate-limit, transport, bad JSON, missing key).
#[derive(Debug, Clone)]
pub struct NormaliseAiError {
    pub kind: crate::batch_job::BatchFailureKind,
    pub detail: String,
}

impl NormaliseAiError {
    pub fn key_missing() -> Self {
        Self {
            kind: crate::batch_job::BatchFailureKind::AiKeyMissing,
            detail: "OpenAI API key is not configured. Open Settings to enter your key.".into(),
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
            || detail.starts_with("bad JSON")
        {
            K::AiSchemaInvalid
        } else {
            K::AiCallFailed
        };
        Self { kind, detail }
    }
}

/// Per-call token usage returned by `NormaliseAiClient` implementors.
/// Mock clients can return `Default::default()`; the production
/// `OpenAiNormaliseClient` parses these out of the `/responses`
/// response body so the audit log can record real cost.
#[derive(Debug, Clone, Default)]
pub struct AiCallUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NormaliseAuditEntry {
    pub ts: String,
    pub model: String,
    pub prompt_version: String,
    /// `"description"` (Group B) or `"title"` (Group C).
    pub group: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
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

/// Trait that an injected AI client implements for Group B (and Group
/// C). Tests substitute a mock; production wires
/// `OpenAiNormaliseClient` (see `openai_normalise.rs`).
#[async_trait::async_trait]
pub trait NormaliseAiClient: Send + Sync {
    /// Returns the canonical merged description plus per-call token
    /// usage. Errors are surfaced to the caller and turned into
    /// per-image failure rows.
    async fn merge_description(
        &self,
        prompt: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), String>;

    /// Generate a short title from a description + context. Case-3
    /// Title AI path.
    async fn generate_title(&self, prompt: TitleGenPrompt)
        -> Result<(String, AiCallUsage), String>;
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
}

#[async_trait::async_trait]
impl NormaliseAiClient for CapturingAiClient {
    async fn merge_description(
        &self,
        p: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), String> {
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

    async fn generate_title(&self, p: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
        let stand_in = p
            .description
            .split_whitespace()
            .take(8)
            .collect::<Vec<_>>()
            .join(" ");
        self.title_prompts.lock().await.push(p);
        Ok((stand_in, AiCallUsage::default()))
    }
}
