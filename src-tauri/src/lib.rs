mod scanner;

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

// ── Shared state ─────────────────────────────────────────────────────────────

/// Tracks whether a scan is currently running so we can reject concurrent requests.
struct ScanState(Mutex<bool>);

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct ScanProgressPayload {
    found_so_far: usize,
}

#[derive(Clone, Serialize)]
struct ScanCompletePayload {
    photos: Vec<scanner::PhotoInfo>,
}

#[derive(Clone, Serialize)]
struct ScanErrorPayload {
    message: String,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Open the native folder-picker dialog and return the chosen path,
/// or None if the user cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

/// Start a background scan of `folder_path`.
/// Emits `scan_progress` events during the scan and a final `scan_complete`
/// (or `scan_error`) event when finished.
#[tauri::command]
async fn start_scan(
    folder_path: String,
    app: AppHandle,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    // Guard against concurrent scans.
    {
        let mut running = scan_state.0.lock().unwrap();
        if *running {
            return Err("A scan is already in progress".into());
        }
        *running = true;
    }

    let app_clone = app.clone();
    std::thread::spawn(move || {
        let path = std::path::PathBuf::from(&folder_path);

        if !path.is_dir() {
            let _ = app_clone.emit(
                "scan_error",
                ScanErrorPayload {
                    message: format!("{} is not a directory", folder_path),
                },
            );
            if let Some(state) = app_clone.try_state::<ScanState>() {
                *state.0.lock().unwrap() = false;
            }
            return;
        }

        let app_progress = app_clone.clone();
        let photos = scanner::scan_folder(&path, move |found_so_far| {
            let _ = app_progress.emit("scan_progress", ScanProgressPayload { found_so_far });
        });

        let _ = app_clone.emit("scan_complete", ScanCompletePayload { photos });

        if let Some(state) = app_clone.try_state::<ScanState>() {
            *state.0.lock().unwrap() = false;
        }
    });

    Ok(())
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanState(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![pick_folder, start_scan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
