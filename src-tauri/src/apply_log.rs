//! Append-only audit log for apply_edits operations.
//!
//! Lives at `<folder>/MediaLibraryApplyLog.jsonl` next to the draft file.
//! Each line is one tag's apply outcome — multiple lines per apply when a
//! file has multiple typed edits.  Format is JSONL, header comment line
//! identical to MediaLibraryDraftEdits.jsonl.
//!
//! Append-only by design: never truncated, never read by the app.  The
//! file is forensic documentation users can inspect after the fact when
//! a write looks wrong; tools/inspect-apply-log.ts is a small pretty-printer
//! to be added in a follow-up.
//!
//! See `METADATA_FORMATS_DESIGN.md` §6 and `METADATA_FORMATS_PLAN.md` §5.5.

use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const LOG_FILE_NAME: &str = "MediaLibraryApplyLog.jsonl";
const HEADER_COMMENT: &str =
    "// Apply-edits audit log. Append-only. Each line is one tag's outcome from one apply.";

#[derive(Serialize)]
struct ApplyLogEntry<'a> {
    timestamp: String,
    relative_path: &'a str,
    tag: &'a str,
    intent: &'a EditIntent,
    /// The intended value (post-coerce, what we sent to exiftool).
    intended_value: &'a Option<Variant>,
    /// argv we passed to exiftool for this tag.
    argv: &'a [String],
    /// What the file holds after the write (pretty / display view).
    after_display: Option<&'a Variant>,
    /// What the file holds after the write (raw / -n view).
    after_raw: Option<&'a Variant>,
    /// One of: "Match", "Coerced", "Mismatch", "MissingPostWrite", "Delete-Ok",
    /// "Delete-Lingering", "Hard-Failure-Before-Write".  Free-text so we can
    /// grow new outcomes without a schema migration.
    outcome: &'a str,
    /// Free-text error message when outcome is not Match.
    note: Option<&'a str>,
}

/// Append one log entry per tag for an apply operation.  Best-effort: any
/// write failure logs at warn and proceeds — we never want the audit log
/// to break the apply pipeline.
#[allow(clippy::too_many_arguments)]
pub fn append_entries(
    folder_path: &str,
    relative_path: &str,
    edits: &std::collections::HashMap<String, DraftEdit>,
    argv_by_tag: &std::collections::HashMap<String, Vec<String>>,
    after_display: &std::collections::HashMap<String, Variant>,
    after_raw: &std::collections::HashMap<String, Variant>,
    outcome_by_tag: &std::collections::HashMap<String, (&'static str, Option<String>)>,
) {
    let path = Path::new(folder_path).join(LOG_FILE_NAME);
    let needs_header = !path.exists();

    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("[apply_log] Could not open {}: {}", path.display(), e);
            return;
        }
    };
    let mut writer = std::io::BufWriter::new(file);

    if needs_header {
        if writeln!(writer, "{}", HEADER_COMMENT).is_err() {
            return;
        }
    }

    let timestamp = chrono_like_iso();

    let empty_argv: Vec<String> = Vec::new();
    for (tag, edit) in edits {
        let argv = argv_by_tag.get(tag).unwrap_or(&empty_argv);
        let (outcome, note) = outcome_by_tag
            .get(tag)
            .map(|(o, n)| (*o, n.as_deref()))
            .unwrap_or(("Match", None));

        let entry = ApplyLogEntry {
            timestamp: timestamp.clone(),
            relative_path,
            tag,
            intent: &edit.intent,
            intended_value: &edit.value,
            argv,
            after_display: after_display.get(tag),
            after_raw: after_raw.get(tag),
            outcome,
            note,
        };

        match serde_json::to_string(&entry) {
            Ok(line) => {
                if writeln!(writer, "{}", line).is_err() {
                    log::warn!("[apply_log] write error; further entries in this apply will be skipped");
                    return;
                }
            }
            Err(e) => log::warn!("[apply_log] serialise error for tag {}: {}", tag, e),
        }
    }
}

/// Tiny RFC3339-ish timestamp without pulling in `chrono`.  Format:
/// `YYYY-MM-DDTHH:MM:SSZ` from system time, UTC.
fn chrono_like_iso() -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Convert seconds since epoch into a date.  Naïve but stable: days
    // since epoch + time-of-day.  Good enough for an audit log — users
    // can also see the file's mtime if absolute precision is needed.
    let days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
}

/// Civil-calendar conversion from days-since-1970-01-01.  Algorithm via
/// Howard Hinnant's "date" library convertor.
fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[test]
    fn days_to_ymd_known_dates() {
        // Epoch
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        // First day of 2000
        assert_eq!(days_to_ymd(10957), (2000, 1, 1));
        // Leap-day handling
        assert_eq!(days_to_ymd(10957 + 31 + 28), (2000, 2, 29));
    }

    #[test]
    fn iso_timestamp_shape_is_correct() {
        let s = chrono_like_iso();
        // YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        assert_eq!(s.chars().nth(4), Some('-'));
        assert_eq!(s.chars().nth(7), Some('-'));
        assert_eq!(s.chars().nth(10), Some('T'));
    }

    #[test]
    fn append_entries_creates_file_with_header() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();

        let mut edits: HashMap<String, DraftEdit> = HashMap::new();
        edits.insert(
            "XMP-dc:Title".to_string(),
            DraftEdit { value: Some(Variant::String("Hi".into())), intent: EditIntent::Set },
        );

        let mut argv: HashMap<String, Vec<String>> = HashMap::new();
        argv.insert("XMP-dc:Title".to_string(), vec!["-XMP-dc:Title=Hi".into()]);

        let after_display: HashMap<String, Variant> = HashMap::new();
        let after_raw: HashMap<String, Variant> = HashMap::new();

        let mut outcome: HashMap<String, (&'static str, Option<String>)> = HashMap::new();
        outcome.insert("XMP-dc:Title".to_string(), ("Match", None));

        append_entries(folder, "a.jpg", &edits, &argv, &after_display, &after_raw, &outcome);

        let contents = std::fs::read_to_string(dir.path().join(LOG_FILE_NAME)).unwrap();
        assert!(contents.starts_with("// "), "first line should be the header comment");
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "expected header + one entry");
        assert!(lines[1].contains("\"XMP-dc:Title\""));
        assert!(lines[1].contains("\"Match\""));
    }

    #[test]
    fn append_entries_is_append_only_no_header_on_second_apply() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let edits: HashMap<String, DraftEdit> = {
            let mut m = HashMap::new();
            m.insert(
                "Tag".to_string(),
                DraftEdit { value: Some(Variant::Integer(1)), intent: EditIntent::Set },
            );
            m
        };
        let argv = HashMap::new();
        let after = HashMap::new();
        let outcome = HashMap::new();

        append_entries(folder, "a.jpg", &edits, &argv, &after, &after, &outcome);
        append_entries(folder, "b.jpg", &edits, &argv, &after, &after, &outcome);

        let contents = std::fs::read_to_string(dir.path().join(LOG_FILE_NAME)).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        // One header line + one entry per apply.
        assert_eq!(lines.len(), 3, "{:?}", lines);
    }
}
