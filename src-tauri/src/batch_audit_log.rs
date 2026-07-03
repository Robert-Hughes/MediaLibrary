//! Generic append-only JSONL audit logger for batch runs.
//!
//! Originally lived inline in `describe_log.rs` for the AI-description
//! flow. Extracted here so additional batch features (reverse-geocode
//! and the planned metadata-normaliser in
//! `docs/NORMALISE_METADATA_PLAN.md` §11 item 3) can write per-run audit
//! entries with the same on-disk discipline:
//!
//! - One JSON object per line (JSONL), `\n`-terminated.
//! - `OpenOptions::append` so concurrent writers don't truncate.
//! - `create_dir_all` on the directory so the first run on a fresh
//!   install just works.
//!
//! No rotation, no compaction. Files are bounded by user behaviour and
//! every entry is read by the user (or us) when investigating a cost or
//! correctness surprise; the value is in keeping history forever rather
//! than pruning it.
//!
//! The wire shape is owned by each caller — this module knows nothing
//! about token totals, model names, or per-image errors. Callers pass
//! any `Serialize` value and the file path they want it written to.

use serde::Serialize;
use std::io::Write;
use std::path::Path;

/// Append one JSON-encoded entry to `path` (JSONL — one line per call).
///
/// Creates the parent directory if missing. Returns an error string on
/// any I/O or serialisation failure; callers typically log-and-swallow
/// because audit failures should not abort the user's batch.
pub fn append<T: Serialize>(path: &Path, entry: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}): {}", parent.display(), e))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    let json = serde_json::to_string(entry).map_err(|e| format!("serialize audit entry: {}", e))?;
    writeln!(f, "{}", json).map_err(|e| format!("write audit line: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use tempfile::tempdir;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Dummy {
        name: String,
        count: u32,
    }

    #[test]
    fn append_creates_dir_and_writes_one_jsonl_line() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("audit.jsonl");
        append(
            &path,
            &Dummy {
                name: "first".into(),
                count: 1,
            },
        )
        .unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 1);
        let parsed: Dummy = serde_json::from_str(contents.trim()).unwrap();
        assert_eq!(
            parsed,
            Dummy {
                name: "first".into(),
                count: 1
            }
        );
    }

    #[test]
    fn append_is_additive_not_truncating() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        append(
            &path,
            &Dummy {
                name: "a".into(),
                count: 1,
            },
        )
        .unwrap();
        append(
            &path,
            &Dummy {
                name: "b".into(),
                count: 2,
            },
        )
        .unwrap();
        let lines: Vec<_> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|l| l.to_string())
            .collect();
        assert_eq!(lines.len(), 2);
        let a: Dummy = serde_json::from_str(&lines[0]).unwrap();
        let b: Dummy = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(a.name, "a");
        assert_eq!(b.name, "b");
    }
}
