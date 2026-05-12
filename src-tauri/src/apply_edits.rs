use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::scanner::{self, Variant};
use crate::log_ts;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FailedFile {
    pub relative_path: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
pub struct ApplyEditsResult {
    pub applied: Vec<String>,
    pub failed: Vec<FailedFile>,
    pub fresh_metadata: HashMap<String, HashMap<String, Variant>>,
}

/// Apply draft edits to a single file using exiftool, then verify by re-reading metadata.
/// Returns Ok(fresh_metadata) on success, Err(reason) on failure.
fn apply_single_file(
    folder_path: &str,
    rel_path: &str,
    edits: &HashMap<String, Option<String>>,
) -> Result<HashMap<String, Variant>, String> {
    if edits.is_empty() {
        return Err("No edits to apply".to_string());
    }

    let abs_path = Path::new(folder_path)
        .join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));

    // Validate all keys before touching the filesystem
    for key in edits.keys() {
        if key.contains('\n') || key.contains('\0') {
            return Err(format!("Invalid tag key: {:?}", key));
        }
    }

    if !abs_path.exists() {
        return Err(format!("File not found: {}", abs_path.display()));
    }

    let exiftool_cmd = scanner::find_exiftool();

    let mut cmd = Command::new(exiftool_cmd);
    cmd.arg("-overwrite_original");

    for (key, value) in edits {
        match value {
            Some(v) => {
                cmd.arg(format!("-{}={}", key, v));
            }
            None => {
                // Remove tag entirely
                cmd.arg(format!("-{}=", key));
            }
        }
    }

    cmd.arg(&abs_path);

    log_ts!("[apply_edits] Running exiftool for: {}", rel_path);

    let output = cmd.output().map_err(|e| {
        format!("Failed to execute ExifTool: {}. Please ensure ExifTool is installed.", e)
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ExifTool failed: {}", stderr.trim()));
    }

    // Verify by re-reading metadata
    let fresh = scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path])
        .map_err(|e| format!("Verification read failed: {}", e))?;

    let fresh_meta = fresh
        .into_iter()
        .next()
        .map(|r| r.metadata)
        .unwrap_or_default();

    // Verify each edit is reflected in the fresh metadata
    for (key, expected_value) in edits {
        match expected_value {
            Some(expected) => {
                match fresh_meta.get(key) {
                    Some(Variant::String(actual)) => {
                        if actual != expected {
                            return Err(format!(
                                "Verification failed for {}: expected {:?}, got {:?}",
                                key, expected, actual
                            ));
                        }
                    }
                    Some(_other) => {
                        // Non-string variant — accept it; exiftool may normalise the format
                        log_ts!(
                            "[apply_edits] Warning: {} has non-string variant after write",
                            key
                        );
                    }
                    None => {
                        // Tag absent — some formats silently drop unsupported tags
                        log_ts!(
                            "[apply_edits] Warning: {} not found in fresh metadata after write",
                            key
                        );
                    }
                }
            }
            None => {
                // Tag should be absent or empty after removal
                if let Some(v) = fresh_meta.get(key) {
                    let v_str = match v {
                        Variant::String(s) => s.clone(),
                        _ => String::new(),
                    };
                    if !v_str.is_empty() {
                        return Err(format!(
                            "Verification failed for {}: expected tag removed, got {:?}",
                            key, v_str
                        ));
                    }
                }
            }
        }
    }

    Ok(fresh_meta)
}

/// Apply draft edits for the given relative paths, using the provided drafts map.
/// Per-file: each file is processed independently so one failure does not block others.
pub fn apply_draft_edits(
    folder_path: &str,
    rel_paths: &[String],
    all_drafts: &HashMap<String, HashMap<String, Option<String>>>,
) -> ApplyEditsResult {
    let mut applied = Vec::new();
    let mut failed = Vec::new();
    let mut fresh_metadata = HashMap::new();

    for rel_path in rel_paths {
        let edits = match all_drafts.get(rel_path.as_str()) {
            Some(e) if !e.is_empty() => e,
            _ => {
                log_ts!("[apply_edits] No drafts for {}, skipping", rel_path);
                continue;
            }
        };

        match apply_single_file(folder_path, rel_path, edits) {
            Ok(meta) => {
                log_ts!("[apply_edits] Successfully applied edits to {}", rel_path);
                applied.push(rel_path.clone());
                fresh_metadata.insert(rel_path.clone(), meta);
            }
            Err(reason) => {
                log_ts!("[apply_edits] Failed for {}: {}", rel_path, reason);
                failed.push(FailedFile {
                    relative_path: rel_path.clone(),
                    reason,
                });
            }
        }
    }

    ApplyEditsResult {
        applied,
        failed,
        fresh_metadata,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_edits_returns_error() {
        let result = apply_single_file("/tmp", "photo.jpg", &HashMap::new());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No edits"));
    }

    #[test]
    fn missing_file_returns_error() {
        let mut edits = HashMap::new();
        edits.insert(
            "XMP-dc:Description".to_string(),
            Some("test".to_string()),
        );
        let result = apply_single_file("/tmp", "nonexistent_photo_xyz_999.jpg", &edits);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn key_with_newline_is_rejected() {
        let mut edits = HashMap::new();
        edits.insert("Bad\nKey".to_string(), Some("test".to_string()));
        let result = apply_single_file("/tmp", "photo.jpg", &edits);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid tag key"));
    }

    #[test]
    fn key_with_null_byte_is_rejected() {
        let mut edits = HashMap::new();
        edits.insert("Bad\0Key".to_string(), Some("test".to_string()));
        let result = apply_single_file("/tmp", "photo.jpg", &edits);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid tag key"));
    }

    #[test]
    fn missing_file_is_reported_in_failed_list() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string()];
        let mut drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();
        let mut file_edits = HashMap::new();
        file_edits.insert(
            "XMP-dc:Description".to_string(),
            Some("hello".to_string()),
        );
        drafts.insert("a.jpg".to_string(), file_edits);

        let result = apply_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].relative_path, "a.jpg");
        assert!(!result.failed[0].reason.is_empty());
    }

    #[test]
    fn path_with_no_drafts_is_skipped_not_failed() {
        let folder = "/some/folder";
        let paths = vec!["photo_with_no_edits.jpg".to_string()];
        let drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();

        let result = apply_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 0);
    }

    #[test]
    fn multiple_files_tracked_independently() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string(), "b.jpg".to_string()];
        let mut drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();

        let mut edits_a = HashMap::new();
        edits_a.insert("XMP-dc:Description".to_string(), Some("test a".to_string()));
        drafts.insert("a.jpg".to_string(), edits_a);

        let mut edits_b = HashMap::new();
        edits_b.insert("XMP-dc:Description".to_string(), Some("test b".to_string()));
        drafts.insert("b.jpg".to_string(), edits_b);

        let result = apply_draft_edits(folder, &paths, &drafts);
        // Both fail (folder doesn't exist) but independently
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 2);
    }
}
