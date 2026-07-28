//! Cross-feature command helpers: per-user app data dir, OpenAI transport
//! construction, relative-to-absolute path resolution.

use tauri::AppHandle;

use crate::openai_http;
use crate::settings;

/// Locate the per-user app-data directory for settings/log files.  Uses
/// tauri's `path()` resolver so the location follows OS conventions
/// (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
/// `$XDG_CONFIG_HOME` on Linux).
pub fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {}", e))
}

/// Build a fresh task-local OpenAI transport using the stored settings. Fails fast if
/// the API key is empty so the caller can show a "Settings → API key"
/// hint.
pub fn make_openai_http(
    app: &AppHandle,
) -> Result<(openai_http::OpenAiHttp, settings::Settings), String> {
    let dir = app_data_dir(app)?;
    let s = settings::load_settings(&dir)?;
    if s.openai_api_key.trim().is_empty() {
        return Err("OpenAI API key is not configured. Open Settings to enter your key.".into());
    }
    let http = openai_http::OpenAiHttp::new(
        openai_http::DEFAULT_BASE_URL,
        s.openai_api_key.clone(),
        openai_http::DEFAULT_MAX_RETRIES,
    );
    Ok((http, s))
}

/// Resolve a relative path under `folder_path` to an absolute path,
/// matching how scanner.rs walks the tree (forward-slash relative
/// paths).
pub fn resolve_rel(folder_path: &str, rel: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(folder_path).join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}
