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
//! See `docs/METADATA_FORMATS_DESIGN.md` §6.

use crate::apply_edits::MetadataTagOutcome;
use crate::draft_edits::{EditIntent, MetadataDraftEdit};
use crate::metadata_value::MetadataValue;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const LOG_FILE_NAME: &str = "MediaLibraryApplyLog.jsonl";
/// Schema version embedded in each entry.  Bumps:
///  - 2 (Phase 8.8): added dual pre-write semantic fields.
///  - 3 (Phase 8 fix-up): added `before_read_failed` so a `null` before
///    value can be distinguished from "the pre-write read itself failed".
///    v2 readers see the new field as ignorable.
///  - 5: canonical-only metadata values; display/raw semantic fields removed.
///  - 6: added `write_diagnostic` field to capture ExifTool errors/warnings.
const SEMANTIC_LOG_SCHEMA_VERSION: u32 = 6;
const HEADER_COMMENT: &str =
    "// Apply-edits audit log. Append-only. Each line is one tag's outcome from one apply. schema_version=6.";

#[derive(Serialize)]
struct MetadataApplyLogEntry<'a> {
    schema_version: u32,
    timestamp: String,
    relative_path: &'a str,
    tag: &'a str,
    intent: &'a EditIntent,
    /// The intended semantic value sent to exiftool.
    intended_value: &'a Option<MetadataValue>,
    /// argv we passed to exiftool for this tag.
    argv: &'a [String],
    /// The file's canonical semantic value before our write.
    before: Option<&'a MetadataValue>,
    /// True when the pre-write metadata read failed and before-fields are not authoritative.
    before_read_failed: bool,
    /// The file's canonical semantic value after the write.
    observed: Option<&'a MetadataValue>,
    /// One of the verification outcome strings.
    outcome: &'a str,
    /// Free-text error message when outcome is not Match.
    note: Option<&'a str>,
    /// ExifTool write error or warning diagnostic (if any).
    write_diagnostic: Option<&'a str>,
}

#[allow(clippy::too_many_arguments)]
pub fn append_metadata_entries(
    folder_path: &str,
    relative_path: &str,
    edits: &std::collections::HashMap<String, MetadataDraftEdit>,
    argv_by_tag: &std::collections::HashMap<String, Vec<String>>,
    before_metadata: &std::collections::HashMap<String, MetadataValue>,
    observed_metadata: &std::collections::HashMap<String, MetadataValue>,
    tag_outcomes: &[MetadataTagOutcome],
    before_read_failed: bool,
    write_diagnostic: Option<&str>,
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

    if needs_header && writeln!(writer, "{}", HEADER_COMMENT).is_err() {
        return;
    }

    let timestamp = chrono_like_iso();
    let outcome_by_tag: std::collections::HashMap<&str, &MetadataTagOutcome> =
        tag_outcomes.iter().map(|o| (o.tag.as_str(), o)).collect();

    let empty_argv: Vec<String> = Vec::new();
    for (tag, edit) in edits {
        let argv = argv_by_tag.get(tag).unwrap_or(&empty_argv);
        let (outcome, note) = match outcome_by_tag.get(tag.as_str()) {
            Some(o) => (o.kind.as_str(), o.message.as_deref()),
            None => ("Match", None),
        };

        let entry = MetadataApplyLogEntry {
            schema_version: SEMANTIC_LOG_SCHEMA_VERSION,
            timestamp: timestamp.clone(),
            relative_path,
            tag,
            intent: &edit.intent,
            intended_value: &edit.value,
            argv,
            before: before_metadata.get(tag),
            before_read_failed,
            observed: observed_metadata.get(tag),
            outcome,
            note,
            write_diagnostic,
        };

        match serde_json::to_string(&entry) {
            Ok(line) => {
                if writeln!(writer, "{}", line).is_err() {
                    log::warn!(
                        "[apply_log] write error; further entries in this apply will be skipped"
                    );
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

    fn metadata_outcome(tag: &str, kind: &str) -> MetadataTagOutcome {
        MetadataTagOutcome {
            tag: tag.to_string(),
            kind: kind.to_string(),
            sent: None,
            before: None,
            observed: None,
            message: None,
        }
    }

    #[test]
    fn append_metadata_entries_records_semantic_values() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();

        let mut edits: HashMap<String, MetadataDraftEdit> = HashMap::new();
        edits.insert(
            "IPTC:TimeCreated".to_string(),
            MetadataDraftEdit {
                value: Some(MetadataValue::Time(crate::metadata_value::TimeValue {
                    hour: 10,
                    minute: 56,
                    second: 5,
                    subsecond: None,
                    offset: None,
                })),
                intent: EditIntent::Set,
                display: None,
            },
        );

        let mut argv: HashMap<String, Vec<String>> = HashMap::new();
        argv.insert(
            "IPTC:TimeCreated".to_string(),
            vec!["-IPTC:TimeCreated=10:56:05".into()],
        );

        let mut before: HashMap<String, MetadataValue> = HashMap::new();
        before.insert(
            "IPTC:TimeCreated".to_string(),
            MetadataValue::Text("old".into()),
        );
        let mut after: HashMap<String, MetadataValue> = HashMap::new();
        after.insert(
            "IPTC:TimeCreated".to_string(),
            MetadataValue::Time(crate::metadata_value::TimeValue {
                hour: 10,
                minute: 56,
                second: 5,
                subsecond: None,
                offset: None,
            }),
        );

        append_metadata_entries(
            folder,
            "a.jpg",
            &edits,
            &argv,
            &before,
            &after,
            &[metadata_outcome("IPTC:TimeCreated", "Match")],
            false,
            Some("test diagnostic"),
        );

        let contents = std::fs::read_to_string(dir.path().join(LOG_FILE_NAME)).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "expected header + one semantic entry");
        let entry: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(entry["schema_version"], 6);
        assert_eq!(entry["intended_value"]["kind"], "Time");
        assert_eq!(
            entry["intended_value"]["value"]["offset"],
            serde_json::Value::Null
        );
        assert_eq!(entry["observed"]["kind"], "Time");
        assert_eq!(entry["argv"][0], "-IPTC:TimeCreated=10:56:05");
        assert_eq!(entry["write_diagnostic"], "test diagnostic");
    }

    #[test]
    fn append_entries_is_append_only_no_header_on_second_apply() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let edits: HashMap<String, MetadataDraftEdit> = {
            let mut m = HashMap::new();
            m.insert(
                "Tag".to_string(),
                MetadataDraftEdit {
                    value: Some(MetadataValue::Integer(1)),
                    intent: EditIntent::Set,
                    display: None,
                },
            );
            m
        };
        let argv = HashMap::new();
        let before = HashMap::new();
        let after = HashMap::new();
        let outcomes = vec![metadata_outcome("Tag", "Match")];

        append_metadata_entries(
            folder, "a.jpg", &edits, &argv, &before, &after, &outcomes, false, None,
        );
        append_metadata_entries(
            folder, "b.jpg", &edits, &argv, &before, &after, &outcomes, false, None,
        );

        let contents = std::fs::read_to_string(dir.path().join(LOG_FILE_NAME)).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        // One header line + one entry per apply.
        assert_eq!(lines.len(), 3, "{:?}", lines);
    }
}
