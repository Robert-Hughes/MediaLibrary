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

/// Outcome of applying edits to a single file.
///
/// `fresh_metadata` is populated whenever exiftool ran and the re-read succeeded,
/// regardless of whether verification passed.  This lets the UI reflect the actual
/// file state even when verification detects a mismatch or partial write.
///
/// `error` is `None` on full success, `Some` for any failure (hard or verification).
pub struct SingleFileOutcome {
    pub fresh_metadata: Option<HashMap<String, Variant>>,
    pub error: Option<String>,
}

impl SingleFileOutcome {
    fn hard_failure(reason: String) -> Self {
        Self { fresh_metadata: None, error: Some(reason) }
    }

    fn success(meta: HashMap<String, Variant>) -> Self {
        Self { fresh_metadata: Some(meta), error: None }
    }

    fn verification_failure(meta: HashMap<String, Variant>, reason: String) -> Self {
        Self { fresh_metadata: Some(meta), error: Some(reason) }
    }
}

/// Apply draft edits to a single file using exiftool, then re-read and verify.
pub fn apply_single_file(
    folder_path: &str,
    rel_path: &str,
    edits: &HashMap<String, Option<String>>,
) -> SingleFileOutcome {
    if edits.is_empty() {
        return SingleFileOutcome::hard_failure("No edits to apply".to_string());
    }

    let abs_path = Path::new(folder_path)
        .join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));

    // Validate all keys before touching the filesystem
    for key in edits.keys() {
        if key.contains('\n') || key.contains('\0') {
            return SingleFileOutcome::hard_failure(format!("Invalid tag key: {:?}", key));
        }
    }

    if !abs_path.exists() {
        return SingleFileOutcome::hard_failure(format!("File not found: {}", abs_path.display()));
    }

    let exiftool_cmd = scanner::find_exiftool();

    let mut cmd = Command::new(exiftool_cmd);
    cmd.arg("-overwrite_original");

    for (key, value) in edits {
        match value {
            Some(v) => { cmd.arg(format!("-{}={}", key, v)); }
            None    => { cmd.arg(format!("-{}=", key)); }
        }
    }

    cmd.arg(&abs_path);

    log_ts!("[apply_edits] Running exiftool for: {}", rel_path);

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => return SingleFileOutcome::hard_failure(format!(
            "Failed to execute ExifTool: {}. Please ensure ExifTool is installed.", e
        )),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return SingleFileOutcome::hard_failure(format!("ExifTool failed: {}", stderr.trim()));
    }

    // Re-read metadata. A read failure here is a hard failure — we have nothing to show.
    let fresh_meta = match scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path]) {
        Ok(results) => results.into_iter().next().map(|r| r.metadata).unwrap_or_default(),
        Err(e) => return SingleFileOutcome::hard_failure(format!("Post-write read failed: {}", e)),
    };

    // Verify each edit is reflected in the fresh metadata.
    // A mismatch is a soft failure: we return the fresh metadata so the UI
    // can show the actual file state (which may be partially written).
    for (key, expected_value) in edits {
        match expected_value {
            Some(expected) => {
                match fresh_meta.get(key) {
                    Some(Variant::String(actual)) => {
                        if actual != expected {
                            let reason = format!(
                                "Verification failed for {}: expected {:?}, got {:?}",
                                key, expected, actual
                            );
                            return SingleFileOutcome::verification_failure(fresh_meta, reason);
                        }
                    }
                    Some(_other) => {
                        // Non-string variant — exiftool may normalise the format; accept it
                        log_ts!("[apply_edits] Warning: {} has non-string variant after write", key);
                    }
                    None => {
                        // Tag absent — some formats silently drop unsupported tags
                        log_ts!("[apply_edits] Warning: {} not found in fresh metadata after write", key);
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
                        let reason = format!(
                            "Verification failed for {}: expected tag removed, got {:?}",
                            key, v_str
                        );
                        return SingleFileOutcome::verification_failure(fresh_meta, reason);
                    }
                }
            }
        }
    }

    SingleFileOutcome::success(fresh_meta)
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

        let outcome = apply_single_file(folder_path, rel_path, edits);

        // Always store fresh metadata if available so the UI reflects actual file state,
        // even when verification failed (partial write / corruption case).
        if let Some(meta) = outcome.fresh_metadata {
            fresh_metadata.insert(rel_path.clone(), meta);
        }

        match outcome.error {
            None => {
                log_ts!("[apply_edits] Successfully applied edits to {}", rel_path);
                applied.push(rel_path.clone());
            }
            Some(reason) => {
                log_ts!("[apply_edits] Failed for {}: {}", rel_path, reason);
                failed.push(FailedFile { relative_path: rel_path.clone(), reason });
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

    fn is_hard_failure(outcome: &SingleFileOutcome, substr: &str) -> bool {
        outcome.fresh_metadata.is_none()
            && outcome.error.as_deref().map_or(false, |e| e.contains(substr))
    }

    #[test]
    fn empty_edits_is_hard_failure() {
        let outcome = apply_single_file("/tmp", "photo.jpg", &HashMap::new());
        assert!(is_hard_failure(&outcome, "No edits"));
    }

    #[test]
    fn missing_file_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert("XMP-dc:Description".to_string(), Some("test".to_string()));
        let outcome = apply_single_file("/tmp", "nonexistent_photo_xyz_999.jpg", &edits);
        assert!(is_hard_failure(&outcome, "not found"));
    }

    #[test]
    fn key_with_newline_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert("Bad\nKey".to_string(), Some("test".to_string()));
        let outcome = apply_single_file("/tmp", "photo.jpg", &edits);
        assert!(is_hard_failure(&outcome, "Invalid tag key"));
    }

    #[test]
    fn key_with_null_byte_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert("Bad\0Key".to_string(), Some("test".to_string()));
        let outcome = apply_single_file("/tmp", "photo.jpg", &edits);
        assert!(is_hard_failure(&outcome, "Invalid tag key"));
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

    #[test]
    fn hard_failure_produces_no_fresh_metadata() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string()];
        let mut drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();
        let mut file_edits = HashMap::new();
        file_edits.insert("XMP-dc:Description".to_string(), Some("hello".to_string()));
        drafts.insert("a.jpg".to_string(), file_edits);

        let result = apply_draft_edits(folder, &paths, &drafts);
        assert!(!result.fresh_metadata.contains_key("a.jpg"),
            "hard failure (file not found) should not produce fresh metadata");
    }
}
