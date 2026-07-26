//! User-facing application settings.
//!
//! Persisted as plain JSON in `<app_data_dir>/settings.json`.
//!
//! Plaintext storage is deliberate for V1; OS-keyring hardening is on the
//! deferred list in `docs/IMAGE_ANALYSIS.md`. The settings file lives only
//! in the app's per-user data directory, never in the repo.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const RECOMMENDED_LOCATION_MODEL: &str = "gpt-5.6-luna";

/// Recommended vision models for image description, in cost order.  Mirrors
/// the pareto-frontier set from
/// `experiments/openai_image_analysis/MODEL_CHOICE.md`. The first entry is
/// the default for new installs.
pub const RECOMMENDED_MODELS: &[&str] = &[
    RECOMMENDED_LOCATION_MODEL, // default — native reasoning, smart and cheap
    "gpt-4o",                   // legacy fallback — names landmarks reliably
    "gpt-5.4-nano",             // cheapest; generic descriptions
    "gpt-5.4-mini",             // cheap with globally-iconic landmarks
    "gpt-5.6-sol",              // flagship reasoning model
];

pub const MIN_CONCURRENCY: u16 = 1;
pub const MAX_CONCURRENCY: u16 = 16;
pub const MIN_BATCH_SIZE: u16 = 1;
pub const MAX_BATCH_SIZE: u16 = 100;

pub fn default_model() -> String {
    RECOMMENDED_MODELS[0].to_string()
}

/// Default text-only model for the metadata-normalisation AI calls
/// (Group B description merge, Group C case-3 title generation). Per
/// `docs/NORMALISE_METADATA_PLAN.md` §6, nano is plenty for the
/// text-only merge / generate tasks.
pub fn default_normalise_model() -> String {
    "gpt-5.4-nano".to_string()
}

/// Location hierarchy resolution benefits from native reasoning. Repeated
/// prompt/model experiments use Luna as the quality/cost recommendation.
pub fn default_normalise_location_model() -> String {
    RECOMMENDED_LOCATION_MODEL.to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum AiCostEstimateMode {
    Heuristic,
    Exact,
}

pub fn default_ai_cost_estimate_mode() -> AiCostEstimateMode {
    AiCostEstimateMode::Heuristic
}

pub fn default_describe_concurrency() -> u16 {
    12
}

pub fn default_normalise_concurrency() -> u16 {
    4
}

pub fn default_metadata_scan_concurrency() -> u16 {
    available_parallelism_capped(4)
}

pub fn default_metadata_scan_batch_size() -> u16 {
    20
}

pub fn default_metadata_apply_batch_size() -> u16 {
    32
}

pub fn default_metadata_apply_concurrency() -> u16 {
    8
}

pub fn default_thumbnail_concurrency() -> u16 {
    available_parallelism_capped(8)
}

fn available_parallelism_capped(cap: u16) -> u16 {
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .min(usize::from(cap)) as u16
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct Settings {
    /// OpenAI API key. Empty string when unset.
    #[serde(default)]
    pub openai_api_key: String,
    /// Model id used for `/responses` calls. Must be one of
    /// `RECOMMENDED_MODELS` at save time (free-form not allowed yet — kept
    /// strict so cost estimation always has a pricing entry).
    #[serde(default = "default_model")]
    pub openai_model: String,
    /// Model id used for the metadata-normalisation AI calls.
    /// Independent from `openai_model` because the workload (text-only,
    /// ~1k input tokens) is much cheaper than vision and benefits from
    /// nano-class models.
    #[serde(default = "default_normalise_model")]
    pub normalise_metadata_model: String,
    /// Model id used only when Normalize Metadata must create
    /// LocationCreated from raw reverse-geocode evidence.
    #[serde(default = "default_normalise_location_model")]
    pub normalise_location_model: String,
    /// Shared mode for pre-confirm AI cost estimates. Heuristic is
    /// local-only and fast; Exact preserves the OpenAI `/responses/input_tokens`
    /// preflight.
    #[serde(default = "default_ai_cost_estimate_mode")]
    pub ai_cost_estimate_mode: AiCostEstimateMode,
    /// Maximum number of image-description requests in flight.
    #[serde(default = "default_describe_concurrency")]
    pub describe_concurrency: u16,
    /// Maximum number of metadata-normalisation AI requests in flight.
    #[serde(default = "default_normalise_concurrency")]
    pub normalise_concurrency: u16,
    /// Number of metadata scanner workers. Each worker may spawn ExifTool.
    #[serde(default = "default_metadata_scan_concurrency")]
    pub metadata_scan_concurrency: u16,
    /// Maximum files included in one metadata scanner ExifTool read.
    #[serde(default = "default_metadata_scan_batch_size")]
    pub metadata_scan_batch_size: u16,
    /// Maximum files included in one metadata apply read/write/read chunk.
    #[serde(default = "default_metadata_apply_batch_size")]
    pub metadata_apply_batch_size: u16,
    /// Maximum number of metadata file writes in flight.
    #[serde(default = "default_metadata_apply_concurrency")]
    pub metadata_apply_concurrency: u16,
    /// Number of thumbnail generation workers.
    #[serde(default = "default_thumbnail_concurrency")]
    pub thumbnail_concurrency: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            openai_api_key: String::new(),
            openai_model: default_model(),
            normalise_metadata_model: default_normalise_model(),
            normalise_location_model: default_normalise_location_model(),
            ai_cost_estimate_mode: default_ai_cost_estimate_mode(),
            describe_concurrency: default_describe_concurrency(),
            normalise_concurrency: default_normalise_concurrency(),
            metadata_scan_concurrency: default_metadata_scan_concurrency(),
            metadata_scan_batch_size: default_metadata_scan_batch_size(),
            metadata_apply_batch_size: default_metadata_apply_batch_size(),
            metadata_apply_concurrency: default_metadata_apply_concurrency(),
            thumbnail_concurrency: default_thumbnail_concurrency(),
        }
    }
}

pub fn settings_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

/// Load settings from `<app_data_dir>/settings.json`.  Missing file returns
/// `Settings::default()` — a fresh install should not error.  Corrupted file
/// returns an error so the user can inspect and recover rather than silently
/// dropping their saved key.
pub fn load_settings(app_data_dir: &Path) -> Result<Settings, String> {
    let path = settings_file_path(app_data_dir);
    if !path.exists() {
        return Ok(Settings::default());
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let mut parsed: Settings =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", path.display(), e))?;
    // Guard against a stale settings file pointing at a now-unrecommended
    // model name. Quietly snap to default rather than blowing up later in
    // the cost estimator with "unknown model".
    if !RECOMMENDED_MODELS.contains(&parsed.openai_model.as_str()) {
        log::warn!(
            "[settings] Saved model {:?} not in recommended set; using default {:?}",
            parsed.openai_model,
            default_model()
        );
        parsed.openai_model = default_model();
    }
    if !RECOMMENDED_MODELS.contains(&parsed.normalise_metadata_model.as_str()) {
        parsed.normalise_metadata_model = default_normalise_model();
    }
    if !RECOMMENDED_MODELS.contains(&parsed.normalise_location_model.as_str()) {
        parsed.normalise_location_model = default_normalise_location_model();
    }
    clamp_loaded_concurrency("describe_concurrency", &mut parsed.describe_concurrency);
    clamp_loaded_concurrency("normalise_concurrency", &mut parsed.normalise_concurrency);
    clamp_loaded_concurrency(
        "metadata_scan_concurrency",
        &mut parsed.metadata_scan_concurrency,
    );
    clamp_loaded_batch_size(
        "metadata_scan_batch_size",
        &mut parsed.metadata_scan_batch_size,
    );
    clamp_loaded_batch_size(
        "metadata_apply_batch_size",
        &mut parsed.metadata_apply_batch_size,
    );
    clamp_loaded_concurrency(
        "metadata_apply_concurrency",
        &mut parsed.metadata_apply_concurrency,
    );
    clamp_loaded_concurrency("thumbnail_concurrency", &mut parsed.thumbnail_concurrency);
    Ok(parsed)
}

fn clamp_loaded_concurrency(name: &str, value: &mut u16) {
    let clamped = (*value).clamp(MIN_CONCURRENCY, MAX_CONCURRENCY);
    if clamped != *value {
        log::warn!(
            "[settings] Saved {}={} outside supported range {}..={}; using {}",
            name,
            *value,
            MIN_CONCURRENCY,
            MAX_CONCURRENCY,
            clamped
        );
        *value = clamped;
    }
}

fn clamp_loaded_batch_size(name: &str, value: &mut u16) {
    let clamped = (*value).clamp(MIN_BATCH_SIZE, MAX_BATCH_SIZE);
    if clamped != *value {
        log::warn!(
            "[settings] Saved {}={} outside supported range {}..={}; using {}",
            name,
            *value,
            MIN_BATCH_SIZE,
            MAX_BATCH_SIZE,
            clamped
        );
        *value = clamped;
    }
}

fn validate_settings(settings: &Settings) -> Result<(), String> {
    for (name, model) in [
        ("openai_model", settings.openai_model.as_str()),
        (
            "normalise_metadata_model",
            settings.normalise_metadata_model.as_str(),
        ),
        (
            "normalise_location_model",
            settings.normalise_location_model.as_str(),
        ),
    ] {
        if !RECOMMENDED_MODELS.contains(&model) {
            return Err(format!("{name} must be a recommended model"));
        }
    }
    for (name, value) in [
        ("describe_concurrency", settings.describe_concurrency),
        ("normalise_concurrency", settings.normalise_concurrency),
        (
            "metadata_scan_concurrency",
            settings.metadata_scan_concurrency,
        ),
        ("thumbnail_concurrency", settings.thumbnail_concurrency),
        (
            "metadata_apply_concurrency",
            settings.metadata_apply_concurrency,
        ),
    ] {
        if !(MIN_CONCURRENCY..=MAX_CONCURRENCY).contains(&value) {
            return Err(format!(
                "{name} must be between {MIN_CONCURRENCY} and {MAX_CONCURRENCY}"
            ));
        }
    }
    if !(MIN_BATCH_SIZE..=MAX_BATCH_SIZE).contains(&settings.metadata_scan_batch_size) {
        return Err(format!(
            "metadata_scan_batch_size must be between {MIN_BATCH_SIZE} and {MAX_BATCH_SIZE}"
        ));
    }
    if !(MIN_BATCH_SIZE..=MAX_BATCH_SIZE).contains(&settings.metadata_apply_batch_size) {
        return Err(format!(
            "metadata_apply_batch_size must be between {MIN_BATCH_SIZE} and {MAX_BATCH_SIZE}"
        ));
    }
    Ok(())
}

/// Atomically write settings.  Writes to `<file>.tmp` and renames, so a
/// crash mid-write can't leave a half-written settings file that breaks
/// the next startup.
pub fn save_settings(app_data_dir: &Path, settings: &Settings) -> Result<(), String> {
    validate_settings(settings)?;
    fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("create_dir_all({}): {}", app_data_dir.display(), e))?;
    let path = settings_file_path(app_data_dir);
    let tmp = path.with_extension("json.tmp");
    let json =
        serde_json::to_vec_pretty(settings).map_err(|e| format!("serialize settings: {}", e))?;
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("create {}: {}", tmp.display(), e))?;
        f.write_all(&json)
            .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_returns_default_settings() {
        let dir = tempdir().unwrap();
        let s = load_settings(dir.path()).expect("missing-file load should succeed");
        assert_eq!(s, Settings::default());
        assert_eq!(s.openai_model, default_model());
        assert_eq!(s.normalise_location_model, RECOMMENDED_LOCATION_MODEL);
        assert_eq!(s.describe_concurrency, 12);
        assert_eq!(s.metadata_apply_batch_size, 32);
        assert_eq!(s.metadata_apply_concurrency, 8);
        assert!(s.openai_api_key.is_empty());
    }

    #[test]
    fn round_trip_save_load_preserves_fields() {
        let dir = tempdir().unwrap();
        let s = Settings {
            openai_api_key: "sk-test-abc".into(),
            openai_model: "gpt-4o".into(),
            normalise_metadata_model: "gpt-5.4-nano".into(),
            normalise_location_model: "gpt-5.6-luna".into(),
            ai_cost_estimate_mode: AiCostEstimateMode::Exact,
            ..Settings::default()
        };
        save_settings(dir.path(), &s).unwrap();
        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded, s);
    }

    #[test]
    fn save_overwrites_existing_file_atomically() {
        // Atomic rename means partial-write corruption is impossible — after
        // a second save we should see the second payload, never a mix.
        let dir = tempdir().unwrap();
        save_settings(
            dir.path(),
            &Settings {
                openai_api_key: "first".into(),
                openai_model: default_model(),
                normalise_metadata_model: default_normalise_model(),
                ai_cost_estimate_mode: AiCostEstimateMode::Heuristic,
                ..Settings::default()
            },
        )
        .unwrap();
        save_settings(
            dir.path(),
            &Settings {
                openai_api_key: "second".into(),
                openai_model: default_model(),
                normalise_metadata_model: default_normalise_model(),
                ai_cost_estimate_mode: AiCostEstimateMode::Heuristic,
                ..Settings::default()
            },
        )
        .unwrap();
        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded.openai_api_key, "second");
    }

    #[test]
    fn unrecommended_model_in_file_is_snapped_to_default() {
        // Defensive: if a user edits the file by hand to a model we don't
        // know how to price, load_settings should fall back rather than
        // bubble that into the cost estimator.
        let dir = tempdir().unwrap();
        let path = settings_file_path(dir.path());
        std::fs::write(
            &path,
            br#"{"openai_api_key":"k","openai_model":"some-future-model"}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded.openai_model, default_model());
        assert_eq!(loaded.openai_api_key, "k");
        assert_eq!(
            loaded.ai_cost_estimate_mode,
            default_ai_cost_estimate_mode()
        );
    }

    #[test]
    fn unrecommended_location_model_is_snapped_independently() {
        let dir = tempdir().unwrap();
        let path = settings_file_path(dir.path());
        std::fs::write(
            &path,
            br#"{"openai_model":"gpt-4o","normalise_metadata_model":"gpt-5.4-nano","normalise_location_model":"unknown"}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded.normalise_metadata_model, "gpt-5.4-nano");
        assert_eq!(
            loaded.normalise_location_model,
            default_normalise_location_model()
        );
    }

    #[test]
    fn old_json_without_cost_estimate_mode_defaults_to_heuristic() {
        let dir = tempdir().unwrap();
        let path = settings_file_path(dir.path());
        std::fs::write(
            &path,
            br#"{"openai_api_key":"k","openai_model":"gpt-4o","normalise_metadata_model":"gpt-5.4-nano"}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded.ai_cost_estimate_mode, AiCostEstimateMode::Heuristic);
        assert_eq!(
            loaded.normalise_location_model,
            default_normalise_location_model()
        );
        assert_eq!(loaded.describe_concurrency, default_describe_concurrency());
        assert_eq!(
            loaded.metadata_scan_concurrency,
            default_metadata_scan_concurrency()
        );
        assert_eq!(
            loaded.metadata_scan_batch_size,
            default_metadata_scan_batch_size()
        );
        assert_eq!(
            loaded.metadata_apply_batch_size,
            default_metadata_apply_batch_size()
        );
        assert_eq!(
            loaded.metadata_apply_concurrency,
            default_metadata_apply_concurrency()
        );
        assert_eq!(
            loaded.thumbnail_concurrency,
            default_thumbnail_concurrency()
        );
    }

    #[test]
    fn round_trip_preserves_heuristic_cost_estimate_mode() {
        let dir = tempdir().unwrap();
        let s = Settings {
            ai_cost_estimate_mode: AiCostEstimateMode::Heuristic,
            ..Settings::default()
        };
        save_settings(dir.path(), &s).unwrap();
        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded.ai_cost_estimate_mode, AiCostEstimateMode::Heuristic);
    }

    #[test]
    fn round_trip_preserves_exact_cost_estimate_mode() {
        let dir = tempdir().unwrap();
        let s = Settings {
            ai_cost_estimate_mode: AiCostEstimateMode::Exact,
            ..Settings::default()
        };
        save_settings(dir.path(), &s).unwrap();
        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded.ai_cost_estimate_mode, AiCostEstimateMode::Exact);
    }

    #[test]
    fn corrupted_file_returns_error_not_silent_default() {
        // Don't silently discard the user's stored key just because the
        // file is malformed — surface it so they can recover.
        let dir = tempdir().unwrap();
        std::fs::write(settings_file_path(dir.path()), b"not json").unwrap();
        assert!(load_settings(dir.path()).is_err());
    }

    #[test]
    fn out_of_range_loaded_concurrency_is_clamped() {
        let dir = tempdir().unwrap();
        let path = settings_file_path(dir.path());
        std::fs::write(
            path,
            br#"{
                "describe_concurrency": 0,
                "metadata_scan_concurrency": 99,
                "metadata_scan_batch_size": 999,
                "metadata_apply_batch_size": 0,
                "metadata_apply_concurrency": 99,
                "thumbnail_concurrency": 0
            }"#,
        )
        .unwrap();

        let loaded = load_settings(dir.path()).unwrap();
        assert_eq!(loaded.describe_concurrency, MIN_CONCURRENCY);
        assert_eq!(loaded.metadata_scan_concurrency, MAX_CONCURRENCY);
        assert_eq!(loaded.metadata_scan_batch_size, MAX_BATCH_SIZE);
        assert_eq!(loaded.metadata_apply_batch_size, MIN_BATCH_SIZE);
        assert_eq!(loaded.metadata_apply_concurrency, MAX_CONCURRENCY);
        assert_eq!(loaded.thumbnail_concurrency, MIN_CONCURRENCY);
    }

    #[test]
    fn save_rejects_out_of_range_concurrency() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            describe_concurrency: MAX_CONCURRENCY + 1,
            ..Settings::default()
        };

        let error = save_settings(dir.path(), &settings).unwrap_err();
        assert!(error.contains("describe_concurrency must be between 1 and 16"));
        assert!(!settings_file_path(dir.path()).exists());
    }

    #[test]
    fn save_rejects_out_of_range_batch_size() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            metadata_scan_batch_size: MAX_BATCH_SIZE + 1,
            ..Settings::default()
        };

        let error = save_settings(dir.path(), &settings).unwrap_err();
        assert!(error.contains("metadata_scan_batch_size must be between 1 and 100"));
        assert!(!settings_file_path(dir.path()).exists());
    }
}
