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

/// Emitted once per photo when its thumbnail has been generated.
#[derive(Clone, Serialize)]
struct ThumbnailReadyPayload {
    /// Relative path — used by the frontend to match the photo entry.
    relative_path: String,
    /// Base64-encoded JPEG thumbnail data.
    thumbnail: String,
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
///
/// Phase 1 — fast file discovery:
///   Emits `scan_progress` as files are found, then `scan_complete` with the
///   full list (no thumbnails). The UI can display the list immediately.
///
/// Phase 2 — parallel thumbnail generation:
///   After `scan_complete`, spawns a Rayon thread pool to generate thumbnails
///   concurrently. Each completed thumbnail emits a `thumbnail_ready` event
///   so the frontend can update individual rows as they arrive.
#[tauri::command]
async fn start_scan(
    folder_path: String,
    app: AppHandle,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    {
        let mut running = scan_state.0.lock().unwrap();
        if *running {
            return Err("A scan is already in progress".into());
        }
        *running = true;
    }

    let app_clone = app.clone();
    std::thread::spawn(move || {
        let root = std::path::PathBuf::from(&folder_path);

        if !root.is_dir() {
            let _ = app_clone.emit(
                "scan_error",
                ScanErrorPayload {
                    message: format!("{} is not a directory", folder_path),
                },
            );
            clear_running(&app_clone);
            return;
        }

        // ── Phase 1: fast file discovery ──────────────────────────────────

        let app_progress = app_clone.clone();
        let photos = scanner::scan_folder(&root, move |found_so_far| {
            let _ = app_progress.emit("scan_progress", ScanProgressPayload { found_so_far });
        });

        // Send the list immediately — no thumbnails yet.
        let _ = app_clone.emit("scan_complete", ScanCompletePayload { photos: photos.clone() });

        // ── Phase 2: parallel thumbnail generation ────────────────────────

        let app_thumbs = app_clone.clone();
        std::thread::spawn(move || {
            use rayon::prelude::*;

            photos.par_iter().for_each(|photo| {
                let abs_path = root.join(photo.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));

                if let Some(thumbnail) = scanner::thumbnail_for(&abs_path) {
                    let _ = app_thumbs.emit(
                        "thumbnail_ready",
                        ThumbnailReadyPayload {
                            relative_path: photo.relative_path.clone(),
                            thumbnail,
                        },
                    );
                }
            });

            clear_running(&app_thumbs);
        });
    });

    Ok(())
}

fn clear_running(app: &AppHandle) {
    if let Some(state) = app.try_state::<ScanState>() {
        *state.0.lock().unwrap() = false;
    }
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
