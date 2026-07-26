//! Settings + pricing-preview commands. Thin wrappers over
//! `crate::settings`, `crate::openai_describe`, and
//! `crate::openai_normalise`; kept here so the lib root stays compact.

use tauri::AppHandle;

use crate::commands::shared::app_data_dir;
use crate::{openai_describe, openai_normalise, settings};

#[tauri::command]
pub fn load_settings_cmd(app: AppHandle) -> Result<settings::Settings, String> {
    let dir = app_data_dir(&app)?;
    settings::load_settings(&dir)
}

#[tauri::command]
pub fn save_settings_cmd(app: AppHandle, settings_data: settings::Settings) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    settings::save_settings(&dir, &settings_data)
}

/// Returns the static list of vision models we recommend for image
/// description, so the Settings dropdown stays in sync with the
/// backend's pricing/cost-estimation knowledge.
#[tauri::command]
pub fn list_recommended_models() -> Vec<String> {
    settings::RECOMMENDED_MODELS
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Ballpark USD cost of describing a single typical image with `model`.
/// Drives the per-model cost label in the Settings dropdown so users
/// see the scale before they pick. Returns an error for unknown models
/// so the caller can decide between "(price unknown)" and a hard
/// failure.
#[tauri::command]
pub fn estimate_per_image_cost_cmd(model: String) -> Result<f64, String> {
    openai_describe::estimate_typical_cost_per_image(&model)
        .ok_or_else(|| format!("no pricing entry for model {}", model))
}

/// Ballpark USD cost of normalising one file's metadata with `model`,
/// assuming both Group B (description merge) and Group C (title) fire
/// (worst case). Drives the per-model cost preview in the Settings
/// dialog's normalise-model picker. Plan §6.
#[tauri::command]
pub fn estimate_per_image_normalise_cost_cmd(model: String) -> Result<f64, String> {
    openai_normalise::typical_normalise_cost_per_image(&model)
        .ok_or_else(|| format!("no pricing entry for model {}", model))
}

/// Ballpark cost for the distinct location-resolution AI call.
#[tauri::command]
pub fn estimate_per_image_location_normalise_cost_cmd(model: String) -> Result<f64, String> {
    openai_normalise::typical_location_normalise_cost_per_image(&model)
        .ok_or_else(|| format!("no pricing entry for model {}", model))
}
