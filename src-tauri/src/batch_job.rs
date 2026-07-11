//! Shared primitives for sequential per-image batch jobs.
//!
//! Several Media Library features run the same shape of operation:
//! iterate a list of relative paths, process each one (network call,
//! local compute, …), emit progress events, accumulate failures, and
//! finish with a summary. The AI-description flow was the first; the
//! reverse-geocoding flow is the second; more are likely.
//!
//! Rather than copy-paste the loop, the truly shared bits are extracted
//! here:
//!
//!  - `BatchJobCancelState` — cooperative cancellation flag installed at
//!    job start, signalled by the cancel command, checked at item
//!    boundaries by the loop.
//!  - `BatchFailureRow` — the wire shape of a per-item failure entry in
//!    the `${prefix}_complete` payload. Identical across jobs by design;
//!    the frontend's failure list renders any job's failures the same
//!    way.
//!  - `BatchProgressEmitter` — typed wrapper around `app.emit` that
//!    prepends the job's event prefix so the four event names
//!    (`${prefix}_started` / `${prefix}_progress` / `${prefix}_complete`
//!    and the per-job `${prefix}_*` extras) can't drift between caller
//!    and listener.
//!
//! The per-item business logic stays in each job's own module
//! (`openai_describe.rs`, `geocode.rs`). Keeping the inner loop body in
//! each command — rather than abstracting it behind an async-trait —
//! avoids generics gymnastics and keeps each command readable on its
//! own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Typed wire kind for a per-image batch-job failure.
///
/// Each variant serialises to the snake-case string that has historically
/// been used as the stringly `kind` field on `BatchFailureRow`,
/// `DescribeFailure`, and `GeocodeFailure`. Switching to an enum lets the
/// frontend exhaustively render friendly labels and lets Rust callers stop
/// allocating `String`s for static error labels.
///
/// Variants are grouped by where they originate. New batch features (e.g.
/// the metadata-normaliser planned in `docs/NORMALISE_METADATA_PLAN.md`)
/// add their own variants here so the wire contract stays in one place.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum BatchFailureKind {
    // ── Shared transport / lifecycle ────────────────────────────────────
    /// HTTP request returned a non-2xx status.
    Http,
    /// Transport-layer network error (DNS, connection, timeout, …).
    Network,
    /// The user cancelled the run before this item completed.
    Cancelled,
    /// Frontend-synthesised: the Tauri command itself threw before
    /// reporting any per-image progress (rare; surfaces as a single
    /// failure row with `relativePath = "(batch)"`).
    CommandFailed,
    /// Frontend-synthesised: the estimate-phase preflight (e.g.
    /// describe's `/responses/input_tokens` per-image walk) errored
    /// before any image was processed for real. Every input image
    /// surfaces with this kind so the user sees the run aborted up-front
    /// rather than after a partial batch.
    PreflightFailed,

    // ── AI-description ─────────────────────────────────────────────────
    /// Local image decode / downscale failed (corrupt file, unsupported
    /// format, …). The API was never called for this image.
    Decode,
    /// API responded with `status: "incomplete"` — typically max-output-
    /// tokens hit. The partial response is unparseable.
    Incomplete,
    /// API refused to answer (policy refusal in `output[].refusal`).
    Refused,
    /// API returned a 2xx response whose JSON body didn't match the
    /// expected schema.
    BadJson,
    /// `usage` block missing or malformed in an otherwise-successful
    /// response. Kept distinct from `BadJson` so a cost-reporting gap
    /// doesn't get conflated with content-parse failures in the audit
    /// log.
    UsageParse,

    // ── Reverse-geocode ────────────────────────────────────────────────
    /// Image had no resolvable GPS coordinates (neither draft nor
    /// metadata). Counted separately from real failures in the summary.
    NoGps,
    /// Nominatim returned no usable address fields for the GPS query.
    NominatimEmpty,
    /// Reading or writing the local geocache file failed.
    CacheIo,

    // ── Metadata-normaliser ────────────────────────────────────────────
    /// OpenAI returned a non-2xx response or a transport error during
    /// Group B description merge / Group C title generation.
    AiCallFailed,
    /// AI response parsed as JSON but missing the required field for the
    /// structured-output schema.
    AiSchemaInvalid,
    /// AI returned HTTP 429.
    AiRateLimited,
    /// Appending to the normaliser audit JSONL log failed.
    AuditLogIo,
    /// Bug in the normaliser surfaced as a per-image failure rather than
    /// crashing the whole batch. Detail string carries the message.
    Internal,
    /// Required by plan §6: no OpenAI API key configured but the user
    /// enabled a group that needs AI (Group B distinct sources, or
    /// Group C all-empty + description present).
    AiKeyMissing,
}

impl BatchFailureKind {
    /// Snake-case wire form used in event payloads. Allocates nothing.
    pub fn as_wire(&self) -> &'static str {
        match self {
            BatchFailureKind::Http => "http",
            BatchFailureKind::Network => "network",
            BatchFailureKind::Cancelled => "cancelled",
            BatchFailureKind::CommandFailed => "command_failed",
            BatchFailureKind::PreflightFailed => "preflight_failed",
            BatchFailureKind::Decode => "decode",
            BatchFailureKind::Incomplete => "incomplete",
            BatchFailureKind::Refused => "refused",
            BatchFailureKind::BadJson => "bad_json",
            BatchFailureKind::UsageParse => "usage_parse",
            BatchFailureKind::NoGps => "no_gps",
            BatchFailureKind::NominatimEmpty => "nominatim_empty",
            BatchFailureKind::CacheIo => "cache_io",
            BatchFailureKind::AiCallFailed => "ai_call_failed",
            BatchFailureKind::AiSchemaInvalid => "ai_schema_invalid",
            BatchFailureKind::AiRateLimited => "ai_rate_limited",
            BatchFailureKind::AuditLogIo => "audit_log_io",
            BatchFailureKind::Internal => "internal",
            BatchFailureKind::AiKeyMissing => "ai_key_missing",
        }
    }
}

impl std::fmt::Display for BatchFailureKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_wire())
    }
}

/// Cooperative cancellation flag shared between a running batch loop and
/// the `cancel_${prefix}_cmd` Tauri command.
///
/// Lifecycle:
///
/// 1. The command handler that starts the loop calls `install()` to get
///    a fresh `AtomicBool` and stores the loop's reference to it.
/// 2. The loop checks the flag at each item boundary (and ideally
///    between sub-calls inside one item) and breaks out when it's set.
/// 3. When the loop exits — success, failure, or cancellation — the
///    handler calls `clear()` so a follow-up cancel command silently
///    no-ops instead of mutating a stale flag.
/// 4. The cancel command handler calls `signal_cancel()` which flips the
///    flag if a flag is currently installed.
///
/// Two distinct features (e.g. describe and geocode) keep their own
/// `BatchJobCancelState` instances so that cancelling one doesn't affect
/// the other.
#[derive(Default)]
pub struct BatchJobCancelState {
    cancelled: Mutex<Option<Arc<AtomicBool>>>,
}

impl BatchJobCancelState {
    /// Install a fresh cancellation flag and return a clone of it.
    ///
    /// Overwrites any previously-installed flag — only one batch of this
    /// kind can run at a time, and starting a new batch from the
    /// frontend implicitly supersedes any stale flag from a previous
    /// run that didn't `clear()` itself.
    pub fn install(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        *self.cancelled.lock().unwrap() = Some(flag.clone());
        flag
    }

    /// Drop the currently-installed flag.
    ///
    /// Call this exactly once per `install`, after the loop has fully
    /// drained, so a `signal_cancel` arriving later is a no-op rather
    /// than setting a flag that no loop is reading.
    pub fn clear(&self) {
        *self.cancelled.lock().unwrap() = None;
    }

    /// Set the installed flag to `true`, if one is installed.
    ///
    /// Returns `true` when a flag was set; `false` when there is nothing
    /// running. The command handler doesn't strictly need the return
    /// value but it's handy for tests.
    pub fn signal_cancel(&self) -> bool {
        if let Some(f) = self.cancelled.lock().unwrap().as_ref() {
            f.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

/// Per-item failure entry on the `${prefix}_complete` payload.
///
/// The frontend renders these uniformly across jobs — only the `kind`
/// values differ between jobs. See `BatchFailureKind` for the closed set
/// of wire values.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailureRow {
    pub relative_path: String,
    pub kind: BatchFailureKind,
    pub detail: String,
}

/// Helper for emitting the three standard events of a batch job with
/// the right prefix.
///
/// Each job is free to emit additional `${prefix}_*` events (e.g.
/// `describe_estimate_*` for the cost-preflight phase) directly through
/// `app.emit`; the emitter just covers the universal three so the
/// prefix string lives in exactly one place per command.
pub struct BatchProgressEmitter<'a> {
    app: &'a AppHandle,
    prefix: &'static str,
}

impl<'a> BatchProgressEmitter<'a> {
    pub fn new(app: &'a AppHandle, prefix: &'static str) -> Self {
        Self { app, prefix }
    }

    /// Emit `${prefix}_started` with the total item count.
    pub fn started(&self, total: usize) {
        #[derive(Clone, Serialize)]
        struct Payload {
            total: usize,
        }
        let _ = self
            .app
            .emit(&format!("{}_started", self.prefix), Payload { total });
    }

    /// Emit `${prefix}_progress` with semantic draft edits.
    pub fn progress_metadata(
        &self,
        current: usize,
        total: usize,
        relative_path: &str,
        status: &str,
        error: Option<&str>,
        edits: Option<&crate::draft_edits::MetadataDraftMap>,
    ) {
        #[derive(Clone, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            current: usize,
            total: usize,
            relative_path: &'a str,
            status: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            edits: Option<Vec<crate::draft_edits::MetadataDraftEntry>>,
        }
        let _ = self.app.emit(
            &format!("{}_progress", self.prefix),
            Payload {
                current,
                total,
                relative_path,
                status,
                error,
                edits: edits.cloned().map(crate::draft_edits::draft_entries),
            },
        );
    }

    /// Emit `${prefix}_complete` with the per-job summary payload.
    ///
    /// `summary` is whatever shape the caller chose (token totals for
    /// describe, source counters for geocode, …). The emitter doesn't
    /// constrain it; the caller's wire type and the frontend hook
    /// stay in lockstep.
    pub fn complete<S: Serialize + Clone>(
        &self,
        succeeded: &[String],
        failed: &[BatchFailureRow],
        summary: &S,
    ) {
        #[derive(Clone, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a, S: Serialize> {
            succeeded: &'a [String],
            failed: &'a [BatchFailureRow],
            usage_summary: &'a S,
        }
        let _ = self.app.emit(
            &format!("{}_complete", self.prefix),
            Payload {
                succeeded,
                failed,
                usage_summary: summary,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_returns_unset_flag_each_time() {
        let s = BatchJobCancelState::default();
        let a = s.install();
        assert!(!a.load(Ordering::Relaxed));
        // signal_cancel sets the live flag (which is now `a` plus the
        // copy held inside the state).
        assert!(s.signal_cancel());
        assert!(a.load(Ordering::Relaxed));

        // Re-install replaces the stored flag so the new caller sees
        // a fresh unset bool. The old `a` is still set — its owner
        // (the old loop) is responsible for noticing and exiting.
        let b = s.install();
        assert!(!b.load(Ordering::Relaxed));
        assert!(a.load(Ordering::Relaxed));
    }

    #[test]
    fn signal_cancel_returns_false_when_nothing_installed() {
        let s = BatchJobCancelState::default();
        assert!(!s.signal_cancel());
    }

    #[test]
    fn batch_failure_kind_wire_round_trip_for_every_variant() {
        // Lock the wire shape: serde rename_all="snake_case" must produce
        // exactly these strings, and parsing them back must yield the
        // same variant. New variants added later need to be appended to
        // this list so a missed `as_wire()` arm fails the test.
        let all = [
            (BatchFailureKind::Http, "http"),
            (BatchFailureKind::Network, "network"),
            (BatchFailureKind::Cancelled, "cancelled"),
            (BatchFailureKind::CommandFailed, "command_failed"),
            (BatchFailureKind::PreflightFailed, "preflight_failed"),
            (BatchFailureKind::Decode, "decode"),
            (BatchFailureKind::Incomplete, "incomplete"),
            (BatchFailureKind::Refused, "refused"),
            (BatchFailureKind::BadJson, "bad_json"),
            (BatchFailureKind::UsageParse, "usage_parse"),
            (BatchFailureKind::NoGps, "no_gps"),
            (BatchFailureKind::NominatimEmpty, "nominatim_empty"),
            (BatchFailureKind::CacheIo, "cache_io"),
            (BatchFailureKind::AiCallFailed, "ai_call_failed"),
            (BatchFailureKind::AiSchemaInvalid, "ai_schema_invalid"),
            (BatchFailureKind::AiRateLimited, "ai_rate_limited"),
            (BatchFailureKind::AuditLogIo, "audit_log_io"),
            (BatchFailureKind::Internal, "internal"),
            (BatchFailureKind::AiKeyMissing, "ai_key_missing"),
        ];
        for (variant, wire) in all {
            assert_eq!(variant.as_wire(), wire, "as_wire() for {:?}", variant);
            let serialised = serde_json::to_string(&variant).unwrap();
            assert_eq!(
                serialised,
                format!("\"{}\"", wire),
                "serialised form for {:?}",
                variant
            );
            let parsed: BatchFailureKind = serde_json::from_str(&serialised).unwrap();
            assert_eq!(parsed, variant, "round-trip for {:?}", variant);
        }
    }

    #[test]
    fn clear_makes_subsequent_signal_a_no_op() {
        // After `clear()`, the flag previously returned to the loop is
        // no longer reachable through the state — a stray cancel command
        // arriving later does nothing rather than mutating a flag for a
        // run that already finished.
        let s = BatchJobCancelState::default();
        let flag = s.install();
        s.clear();
        assert!(!s.signal_cancel());
        assert!(!flag.load(Ordering::Relaxed));
    }
}
