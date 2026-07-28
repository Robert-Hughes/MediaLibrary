//! Shared OpenAI HTTP transport.
//!
//! `OpenAiHttp` owns authentication, request timeouts, retry
//! classification, retry logging, and a task-local rate-limit gate.
//! Describe and Normalize wrap the same transport with their own
//! request/response types. Clones share the gate, so one worker's TPM
//! rate limit pauses its peers without introducing application-global
//! state.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;

/// Default `/v1` base URL for production calls. Tests inject their
/// own wiremock URL.
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// Number of retries after the initial attempt in production.
pub const DEFAULT_MAX_RETRIES: u32 = 5;

/// Request timeout used for all OpenAI HTTP calls.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Fixed retry schedule. Keeping this local and deterministic makes
/// failures easy to interpret in the app log.
const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
];

#[derive(Default)]
struct RateLimitState {
    blocked_until: Option<Instant>,
    probe_in_flight: bool,
    generation: u64,
}

#[derive(Default)]
struct RateLimitGate {
    state: Mutex<RateLimitState>,
    changed: Notify,
}

impl RateLimitGate {
    /// Wait until ordinary dispatch is open or claim the single
    /// half-open probe after a cooldown.
    async fn wait_for_turn(&self) -> Option<u64> {
        loop {
            let mut state = self.state.lock().await;
            let blocked_until = state.blocked_until?;

            let now = Instant::now();
            if now < blocked_until {
                let wait = blocked_until - now;
                drop(state);
                tokio::time::sleep(wait).await;
                continue;
            }

            if !state.probe_in_flight {
                state.probe_in_flight = true;
                return Some(state.generation);
            }

            let changed = self.changed.notified();
            drop(state);
            changed.await;
        }
    }

    async fn open(&self, delay: Duration) {
        let mut state = self.state.lock().await;
        let proposed = Instant::now() + delay;
        state.blocked_until = Some(
            state
                .blocked_until
                .map_or(proposed, |current| current.max(proposed)),
        );
        state.probe_in_flight = false;
        state.generation = state.generation.wrapping_add(1);
        drop(state);
        self.changed.notify_waiters();
    }

    async fn close_after_probe(&self, probe_generation: Option<u64>) {
        let Some(probe_generation) = probe_generation else {
            return;
        };
        let mut state = self.state.lock().await;
        if state.generation != probe_generation || !state.probe_in_flight {
            return;
        }
        state.blocked_until = None;
        state.probe_in_flight = false;
        drop(state);
        self.changed.notify_waiters();
    }
}

/// HTTP response details used to distinguish retryable TPM limits from
/// permanent quota failures.
fn openai_error_code(body: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    json.get("error")?.get("code")?.as_str().map(str::to_owned)
}

fn retry_delay(delays: &[Duration], retries_used: usize, max_retries: usize) -> Option<Duration> {
    if retries_used >= max_retries {
        return None;
    }
    delays
        .get(retries_used)
        .copied()
        .or_else(|| delays.last().copied())
}

/// Shared task-local OpenAI transport. Clones share the same HTTP
/// connection pool and rate-limit gate.
#[derive(Clone)]
pub struct OpenAiHttp {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
    max_retries: usize,
    retry_delays: Arc<[Duration]>,
    rate_limit_gate: Arc<RateLimitGate>,
}

impl OpenAiHttp {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>, max_retries: u32) -> Self {
        Self::with_retry_delays(base_url, api_key, max_retries, RETRY_DELAYS.into())
    }

    fn with_retry_delays(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        max_retries: u32,
        retry_delays: Arc<[Duration]>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("reqwest client construction never fails with default config");
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            client,
            max_retries: max_retries as usize,
            retry_delays,
            rate_limit_gate: Arc::new(RateLimitGate::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_retry_delays(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        max_retries: u32,
        retry_delays: Vec<Duration>,
    ) -> Self {
        Self::with_retry_delays(base_url, api_key, max_retries, retry_delays.into())
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn post_responses(
        &self,
        body: &serde_json::Value,
    ) -> Result<(reqwest::StatusCode, String), String> {
        self.post_json("responses", body).await
    }

    pub async fn post_responses_input_tokens(
        &self,
        body: &serde_json::Value,
    ) -> Result<(reqwest::StatusCode, String), String> {
        self.post_json("responses/input_tokens", body).await
    }

    /// POST JSON with explicit retry classification and logging.
    ///
    /// `rate_limit_exceeded` opens the shared gate. `insufficient_quota`
    /// and all other 4xx responses return immediately. Network failures,
    /// 408, and 5xx responses retry only the current request.
    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<(reqwest::StatusCode, String), String> {
        let url = format!("{}/{}", self.base_url, path);
        let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
        let model = body
            .get("model")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        let mut retries_used = 0usize;
        let mut total_wait = Duration::ZERO;

        loop {
            let probe_generation = self.rate_limit_gate.wait_for_turn().await;
            let attempt = retries_used + 1;
            if probe_generation.is_some() {
                log::info!(
                    "[openai] rate_limit_probe path={} model={} attempt={}",
                    path,
                    model,
                    attempt
                );
            } else {
                log::debug!(
                    "[openai] request_attempt path={} model={} attempt={}",
                    path,
                    model,
                    attempt
                );
            }

            let result = self
                .client
                .post(&url)
                .bearer_auth(&self.api_key)
                .header("content-type", "application/json")
                .body(body_str.clone())
                .send()
                .await;

            let response = match result {
                Ok(response) => response,
                Err(error) => {
                    self.rate_limit_gate
                        .close_after_probe(probe_generation)
                        .await;
                    let Some(delay) =
                        retry_delay(&self.retry_delays, retries_used, self.max_retries)
                    else {
                        log::warn!(
                            "[openai] request_failed_final path={} model={} attempt={} kind=network error={}",
                            path,
                            model,
                            attempt,
                            error
                        );
                        return Err(format!("network error: {}", error));
                    };
                    retries_used += 1;
                    total_wait += delay;
                    log::warn!(
                        "[openai] request_retry path={} model={} attempt={} kind=network delay_ms={} error={}",
                        path,
                        model,
                        attempt,
                        delay.as_millis(),
                        error
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            };

            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            let code = openai_error_code(&text);
            let is_rate_limit = status == reqwest::StatusCode::TOO_MANY_REQUESTS
                && code.as_deref() == Some("rate_limit_exceeded");

            if is_rate_limit {
                let Some(delay) = retry_delay(&self.retry_delays, retries_used, self.max_retries)
                else {
                    if let Some(delay) = self.retry_delays.last().copied() {
                        // This request is out of retries, but sibling workers
                        // may still have attempts left. Keep them behind one
                        // final cooldown instead of releasing a burst.
                        self.rate_limit_gate.open(delay).await;
                    } else {
                        self.rate_limit_gate
                            .close_after_probe(probe_generation)
                            .await;
                    }
                    log::warn!(
                        "[openai] request_failed_final path={} model={} attempt={} kind=rate_limit_exceeded total_wait_ms={}",
                        path,
                        model,
                        attempt,
                        total_wait.as_millis()
                    );
                    return Ok((status, text));
                };
                retries_used += 1;
                total_wait += delay;
                self.rate_limit_gate.open(delay).await;
                log::warn!(
                    "[openai] rate_limit_open path={} model={} attempt={} delay_ms={} total_wait_ms={}",
                    path,
                    model,
                    attempt,
                    delay.as_millis(),
                    total_wait.as_millis()
                );
                continue;
            }

            self.rate_limit_gate
                .close_after_probe(probe_generation)
                .await;

            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                log::warn!(
                    "[openai] request_failed_final path={} model={} attempt={} kind={} retryable=false",
                    path,
                    model,
                    attempt,
                    code.as_deref().unwrap_or("unknown_429")
                );
                return Ok((status, text));
            }

            let retryable_status =
                status == reqwest::StatusCode::REQUEST_TIMEOUT || status.is_server_error();
            if retryable_status {
                let Some(delay) = retry_delay(&self.retry_delays, retries_used, self.max_retries)
                else {
                    log::warn!(
                        "[openai] request_failed_final path={} model={} attempt={} kind=http_{} total_wait_ms={}",
                        path,
                        model,
                        attempt,
                        status.as_u16(),
                        total_wait.as_millis()
                    );
                    return Ok((status, text));
                };
                retries_used += 1;
                total_wait += delay;
                log::warn!(
                    "[openai] request_retry path={} model={} attempt={} kind=http_{} delay_ms={}",
                    path,
                    model,
                    attempt,
                    status.as_u16(),
                    delay.as_millis()
                );
                tokio::time::sleep(delay).await;
                continue;
            }

            if retries_used > 0 {
                log::info!(
                    "[openai] request_recovered path={} model={} attempts={} total_wait_ms={}",
                    path,
                    model,
                    attempt,
                    total_wait.as_millis()
                );
            }
            return Ok((status, text));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn error_code_distinguishes_rate_limit_from_quota() {
        assert_eq!(
            openai_error_code(r#"{"error":{"code":"rate_limit_exceeded"}}"#),
            Some("rate_limit_exceeded".into())
        );
        assert_eq!(
            openai_error_code(r#"{"error":{"code":"insufficient_quota"}}"#),
            Some("insufficient_quota".into())
        );
        assert_eq!(openai_error_code("not json"), None);
    }

    #[test]
    fn retry_schedule_stops_at_the_configured_limit() {
        let delays = [Duration::from_millis(5), Duration::from_millis(10)];
        assert_eq!(retry_delay(&delays, 0, 2), Some(delays[0]));
        assert_eq!(retry_delay(&delays, 1, 2), Some(delays[1]));
        assert_eq!(retry_delay(&delays, 2, 2), None);
    }

    #[tokio::test]
    async fn rate_limit_retries_then_recovers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(429).set_body_json(serde_json::json!({
                "error": {"code": "rate_limit_exceeded"}
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;
        let http = OpenAiHttp::with_test_retry_delays(
            server.uri(),
            "k",
            2,
            vec![Duration::from_millis(5), Duration::from_millis(10)],
        );

        let (status, body) = http
            .post_responses(&serde_json::json!({"model": "test"}))
            .await
            .unwrap();

        assert_eq!(status, reqwest::StatusCode::OK);
        assert_eq!(body, "ok");
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn insufficient_quota_is_not_retried() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(429).set_body_json(serde_json::json!({
                "error": {"code": "insufficient_quota"}
            })))
            .mount(&server)
            .await;
        let http = OpenAiHttp::with_test_retry_delays(
            server.uri(),
            "k",
            5,
            vec![Duration::from_millis(5)],
        );

        let (status, _) = http
            .post_responses(&serde_json::json!({"model": "test"}))
            .await
            .unwrap();

        assert_eq!(status, reqwest::StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn server_error_retries_without_opening_rate_limit_gate() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;
        let http = OpenAiHttp::with_test_retry_delays(
            server.uri(),
            "k",
            1,
            vec![Duration::from_millis(5)],
        );

        let (status, _) = http
            .post_responses(&serde_json::json!({"model": "test"}))
            .await
            .unwrap();

        assert_eq!(status, reqwest::StatusCode::OK);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
        assert!(
            http.rate_limit_gate.wait_for_turn().await.is_none(),
            "ordinary server retries must not open the shared TPM gate"
        );
    }

    #[tokio::test]
    async fn shared_gate_releases_only_one_half_open_probe() {
        let gate = Arc::new(RateLimitGate::default());
        gate.open(Duration::ZERO).await;
        let probe_generation = gate.wait_for_turn().await;
        assert!(
            probe_generation.is_some(),
            "first waiter must claim the probe"
        );

        let second_gate = gate.clone();
        let mut second = tokio::spawn(async move { second_gate.wait_for_turn().await });

        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut second)
                .await
                .is_err(),
            "second waiter must remain blocked while the probe is in flight"
        );

        gate.close_after_probe(probe_generation).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), second)
                .await
                .expect("second waiter should be released")
                .unwrap()
                .is_none(),
            "released waiter is an ordinary request, not another probe"
        );
    }

    #[tokio::test]
    async fn stale_successful_probe_does_not_clear_a_newer_cooldown() {
        let gate = RateLimitGate::default();
        gate.open(Duration::ZERO).await;
        let stale_probe = gate.wait_for_turn().await;
        assert!(stale_probe.is_some());

        gate.open(Duration::from_millis(50)).await;
        gate.close_after_probe(stale_probe).await;

        assert!(
            tokio::time::timeout(Duration::from_millis(5), gate.wait_for_turn())
                .await
                .is_err(),
            "a newer rate-limit event must keep the gate closed"
        );
    }
}
