//! Shared OpenAI HTTP client.
//!
//! `OpenAiHttp` owns the reqwest_middleware client (retry policy +
//! timeout) and the auth header + base URL. Both
//! `openai_describe::OpenAiClient` (vision) and
//! `openai_normalise::OpenAiNormaliseClient` (text-only) embed an
//! instance so the retry middleware is constructed exactly once and
//! the per-call surface (`post_responses`,
//! `post_responses_input_tokens`) lives in one place.
//!
//! The split between callers and this module is deliberate: callers
//! own the request body / response parsing; this module owns
//! transport, auth, and retries. Tests inject a custom `base_url` to
//! point at a wiremock and override `max_retries` to keep timings
//! short.

use std::time::Duration;

use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use reqwest_retry::{policies::ExponentialBackoff, RetryTransientMiddleware};

/// Default `/v1` base URL for production calls. Tests inject their
/// own wiremock URL.
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// Request-timeout used for all OpenAI HTTP calls. 120s mirrors the
/// pre-extraction value in `openai_describe`; long enough for slow
/// `/responses` completions, short enough that a wedged connection
/// surfaces.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Retry-backoff bounds. The middleware retries transient failures
/// (429, 5xx, network errors) with exponential backoff between these
/// bounds. `max_retries` is supplied at construction; production uses
/// 3, tests use 1 to keep the suite fast.
const RETRY_LOWER: Duration = Duration::from_millis(500);
const RETRY_UPPER: Duration = Duration::from_secs(8);

/// Thin wrapper around `reqwest_middleware::ClientWithMiddleware` with
/// the OpenAI base URL + bearer auth + retry policy preconfigured.
/// Cheap to clone (`Arc` internally inside reqwest_middleware) so
/// callers store one instance.
#[derive(Clone)]
pub struct OpenAiHttp {
    base_url: String,
    api_key: String,
    client: ClientWithMiddleware,
}

impl OpenAiHttp {
    /// Build a client with the supplied base URL + key.
    ///
    /// `max_retries` of 3 is the production default — enough to ride
    /// out transient 429s without delaying the user beyond ~30s on a
    /// hard failure. Tests inject `1` to keep the suite fast.
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>, max_retries: u32) -> Self {
        let policy = ExponentialBackoff::builder()
            .retry_bounds(RETRY_LOWER, RETRY_UPPER)
            .build_with_max_retries(max_retries);
        let inner = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("reqwest client construction never fails with default config");
        let client = ClientBuilder::new(inner)
            .with(RetryTransientMiddleware::new_with_policy(policy))
            .build();
        Self { base_url: base_url.into(), api_key: api_key.into(), client }
    }

    pub fn base_url(&self) -> &str { &self.base_url }

    /// POST a JSON body to `<base_url>/responses` and return the
    /// `(status, response_body_text)` tuple. The caller decides how to
    /// parse and what to do on non-2xx — different flows surface
    /// different error variants (`DescribeError::HttpError` vs
    /// `NormaliseAiError`).
    pub async fn post_responses(
        &self,
        body: &serde_json::Value,
    ) -> Result<(reqwest::StatusCode, String), String> {
        self.post_json("responses", body).await
    }

    /// POST a JSON body to `<base_url>/responses/input_tokens` and
    /// return `(status, body_text)`. Convenience over
    /// `post_json("responses/input_tokens", …)`.
    pub async fn post_responses_input_tokens(
        &self,
        body: &serde_json::Value,
    ) -> Result<(reqwest::StatusCode, String), String> {
        self.post_json("responses/input_tokens", body).await
    }

    /// Lower-level escape hatch: POST to `<base_url>/<path>`.
    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<(reqwest::StatusCode, String), String> {
        let url = format!("{}/{}", self.base_url, path);
        let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .body(body_str)
            .send()
            .await
            .map_err(|e| format!("network error: {}", e))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, text))
    }
}
