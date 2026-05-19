//! Append-only audit log for AI-description runs.
//!
//! Mirrors `apply_log.rs` in spirit: one JSON object per run, appended as a
//! JSONL line under `<app_data_dir>/describe_log.jsonl`. Lets users (and
//! us) spot cost surprises, see when prompt-version bumps started landing,
//! and reason about model-vs-prompt deltas without re-running.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DescribeLogEntry {
    /// RFC-3339 UTC.
    pub ts: String,
    pub model: String,
    pub prompt_version: String,
    pub n_images: usize,
    pub n_succeeded: usize,
    pub n_failed: usize,
    pub total_input_tokens: u32,
    pub total_cached_tokens: u32,
    pub total_output_tokens: u32,
    pub predicted_cost_usd: f64,
    pub actual_cost_usd: f64,
    /// Per-image errors. Bounded — we record only the failure rows, not
    /// successful ones, so the log stays small.
    pub errors: Vec<DescribeLogError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DescribeLogError {
    pub relative_path: String,
    pub kind: crate::batch_job::BatchFailureKind,
    pub detail: String,
}

pub fn log_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("describe_log.jsonl")
}

pub fn append(app_data_dir: &Path, entry: &DescribeLogEntry) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("create_dir_all({}): {}", app_data_dir.display(), e))?;
    let path = log_file_path(app_data_dir);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    let json = serde_json::to_string(entry)
        .map_err(|e| format!("serialize log entry: {}", e))?;
    writeln!(f, "{}", json).map_err(|e| format!("write log line: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_entry() -> DescribeLogEntry {
        DescribeLogEntry {
            ts: "2024-06-01T12:00:00Z".into(),
            model: "gpt-4o".into(),
            prompt_version: "v1".into(),
            n_images: 3, n_succeeded: 2, n_failed: 1,
            total_input_tokens: 5000, total_cached_tokens: 0, total_output_tokens: 500,
            predicted_cost_usd: 0.0175, actual_cost_usd: 0.018,
            errors: vec![DescribeLogError {
                relative_path: "x.jpg".into(),
                kind: crate::batch_job::BatchFailureKind::Incomplete,
                detail: "max_output_tokens".into(),
            }],
        }
    }

    #[test]
    fn append_creates_file_and_writes_one_jsonl_line() {
        let dir = tempdir().unwrap();
        append(dir.path(), &sample_entry()).unwrap();
        let contents = std::fs::read_to_string(log_file_path(dir.path())).unwrap();
        assert_eq!(contents.lines().count(), 1);
        // Round-trip parse to make sure we wrote valid JSON.
        let parsed: DescribeLogEntry = serde_json::from_str(contents.trim()).unwrap();
        assert_eq!(parsed.n_images, 3);
        assert_eq!(parsed.errors.len(), 1);
    }

    #[test]
    fn append_is_additive_not_truncating() {
        // Second append must not wipe the first — append-only audit guarantee.
        let dir = tempdir().unwrap();
        append(dir.path(), &sample_entry()).unwrap();
        append(dir.path(), &sample_entry()).unwrap();
        let contents = std::fs::read_to_string(log_file_path(dir.path())).unwrap();
        assert_eq!(contents.lines().count(), 2);
    }
}
