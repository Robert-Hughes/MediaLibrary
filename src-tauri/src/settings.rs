//! User-facing application settings.
//!
//! Persisted as plain JSON in `<app_data_dir>/settings.json`. V1 contains
//! only the OpenAI API key and the chosen model — additional fields will
//! land here as the AI-description feature grows (detail level, batch
//! toggle, etc.).
//!
//! Plaintext storage is deliberate for V1; OS-keyring hardening is on the
//! deferred list in `docs/IMAGE_ANALYSIS.md`. The settings file lives only
//! in the app's per-user data directory, never in the repo.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Recommended vision models for image description, in cost order.  Mirrors
/// the pareto-frontier set from
/// `experiments/openai_image_analysis/MODEL_CHOICE.md`. The first entry is
/// the default for new installs.
pub const RECOMMENDED_MODELS: &[&str] = &[
    "gpt-5.6-luna", // default — native reasoning, smart and cheap
    "gpt-4o",       // legacy fallback — names landmarks reliably
    "gpt-5.4-nano", // cheapest; generic descriptions
    "gpt-5.4-mini", // cheap with globally-iconic landmarks
    "gpt-5.6-sol",  // flagship reasoning model
];

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
    /// Shared mode for pre-confirm AI cost estimates. Heuristic is
    /// local-only and fast; Exact preserves the OpenAI `/responses/input_tokens`
    /// preflight.
    #[serde(default = "default_ai_cost_estimate_mode")]
    pub ai_cost_estimate_mode: AiCostEstimateMode,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            openai_api_key: String::new(),
            openai_model: default_model(),
            normalise_metadata_model: default_normalise_model(),
            ai_cost_estimate_mode: default_ai_cost_estimate_mode(),
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
    Ok(parsed)
}

/// Atomically write settings.  Writes to `<file>.tmp` and renames, so a
/// crash mid-write can't leave a half-written settings file that breaks
/// the next startup.
pub fn save_settings(app_data_dir: &Path, settings: &Settings) -> Result<(), String> {
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
        assert!(s.openai_api_key.is_empty());
    }

    #[test]
    fn round_trip_save_load_preserves_fields() {
        let dir = tempdir().unwrap();
        let s = Settings {
            openai_api_key: "sk-test-abc".into(),
            openai_model: "gpt-4o".into(),
            normalise_metadata_model: "gpt-5.4-nano".into(),
            ai_cost_estimate_mode: AiCostEstimateMode::Exact,
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
}
