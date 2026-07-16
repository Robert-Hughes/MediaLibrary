//! Append-only audit logs for metadata apply operations.
//!
//! The schema-v4 path writes schema-keyed evidence to
//! `<folder>/MediaLibraryApplyLog.jsonl`. The schema-v5 path writes exact
//! target evidence to the independent
//! `<folder>/MediaLibraryTargetApplyLog.jsonl` file. Both formats are JSONL,
//! but they have separate schemas and version domains.
//!
//! Append-only by design: never truncated, never read by the app. The files are
//! supplemental forensic evidence users can inspect after a write looks wrong.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §6.

use crate::apply_edits::MetadataTagOutcome;
use crate::apply_edits_v5::MetadataDraftReconciliation;
use crate::draft_edits::{EditIntent, MetadataDraftEntry};
use crate::metadata_draft_target::MetadataDraftTarget;
use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
use crate::metadata_value::MetadataValue;
use crate::scanner::MetadataMap;
use crate::tag_schema::SchemaDefinitionId;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const LOG_FILE_NAME: &str = "MediaLibraryApplyLog.jsonl";
const TARGET_LOG_FILE_NAME: &str = "MediaLibraryTargetApplyLog.jsonl";
const TARGET_LOG_SCHEMA_VERSION: u32 = 1;
const TARGET_LOG_IDENTITY_MODEL: &str = "TargetV5";
const TARGET_HEADER_COMMENT: &str = "// Target-aware apply audit log. Append-only. Each line is one exact target outcome from one schema-v5 apply. schema_version=1.";
/// Schema version embedded in each entry.  Bumps:
///  - 2 (Phase 8.8): added dual pre-write semantic fields.
///  - 3 (Phase 8 fix-up): added `before_read_failed` so a `null` before
///    value can be distinguished from "the pre-write read itself failed".
///    v2 readers see the new field as ignorable.
///  - 5: canonical-only metadata values; display/raw semantic fields removed.
///  - 6: added `write_diagnostic` field to capture ExifTool errors/warnings.
const SEMANTIC_LOG_SCHEMA_VERSION: u32 = 7;
const HEADER_COMMENT: &str =
    "// Apply-edits audit log. Append-only. Each line is one tag's outcome from one apply. schema_version=7.";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct TargetApplyAuditRecord {
    pub(crate) target: MetadataDraftTarget,
    pub(crate) display_name: String,
    pub(crate) intent: EditIntent,
    pub(crate) sent: Option<MetadataValue>,
    pub(crate) before: Option<MetadataValue>,
    pub(crate) write: TargetApplyWriteEvidence,
    pub(crate) post_write: TargetApplyPostWriteState,
    pub(crate) verification: TargetApplyVerificationEvidence,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
pub(crate) enum TargetDraftPersistenceOutcome {
    Unchanged,
    Persisted,
    ReconciliationFailed { error: String },
    PersistenceFailed { error: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct TargetApplyWriteEvidence {
    pub(crate) selector: MetadataWriteTarget,
    pub(crate) arguments: TargetApplyArguments,
    pub(crate) numeric_pass: TargetApplyPassStatus,
    pub(crate) text_pass: TargetApplyPassStatus,
    pub(crate) diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct TargetApplyArguments {
    pub(crate) numeric: Vec<String>,
    pub(crate) text: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
pub(crate) enum TargetApplyPassStatus {
    NotApplicable,
    Succeeded,
    Failed { error: String },
    Skipped { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
pub(crate) enum TargetApplyPostWriteState {
    Unavailable {
        cause: TargetApplyPostWriteUnavailableCause,
        message: String,
    },
    Missing,
    Unique {
        occurrence: Box<TargetApplyObservedOccurrence>,
    },
    Multiple {
        occurrences: Vec<TargetApplyObservedOccurrence>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) enum TargetApplyPostWriteUnavailableCause {
    ReadbackFailed,
    ReadbackInvalid,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct TargetApplyObservedOccurrence {
    pub(crate) occurrence_id: MetadataOccurrenceId,
    pub(crate) schema_id: Option<SchemaDefinitionId>,
    pub(crate) write_target: Option<MetadataWriteTarget>,
    pub(crate) value: MetadataValue,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct TargetApplyVerificationEvidence {
    pub(crate) kind: String,
    pub(crate) message: Option<String>,
    pub(crate) proposed_reconciliation: MetadataDraftReconciliation,
}

#[derive(Serialize)]
struct MetadataApplyLogEntry<'a> {
    schema_version: u32,
    timestamp: String,
    relative_path: &'a str,
    id: &'a SchemaDefinitionId,
    display_name: &'a str,
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

#[derive(Serialize)]
struct TargetMetadataApplyLogEntry<'a> {
    schema_version: u32,
    identity_model: &'static str,
    timestamp: String,
    relative_path: &'a str,
    draft_persistence: &'a TargetDraftPersistenceOutcome,
    #[serde(flatten)]
    record: &'a TargetApplyAuditRecord,
}

pub(crate) fn append_target_metadata_entries(
    folder_path: &str,
    relative_path: &str,
    records: &[TargetApplyAuditRecord],
    draft_persistence: &TargetDraftPersistenceOutcome,
) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }

    let timestamp = chrono_like_iso();
    let lines = records
        .iter()
        .map(|record| {
            serde_json::to_string(&TargetMetadataApplyLogEntry {
                schema_version: TARGET_LOG_SCHEMA_VERSION,
                identity_model: TARGET_LOG_IDENTITY_MODEL,
                timestamp: timestamp.clone(),
                relative_path,
                draft_persistence,
                record,
            })
            .map(|line| format!("{line}\n"))
            .map_err(|error| {
                format!("Could not serialise target apply log entry for {relative_path}: {error}")
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let path = Path::new(folder_path).join(TARGET_LOG_FILE_NAME);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| {
            format!(
                "Could not open target apply log {}: {error}",
                path.display()
            )
        })?;
    let needs_header = file
        .metadata()
        .map_err(|error| {
            format!(
                "Could not inspect target apply log {}: {error}",
                path.display()
            )
        })?
        .len()
        == 0;
    let mut writer = std::io::BufWriter::new(file);

    if needs_header {
        writer
            .write_all(format!("{TARGET_HEADER_COMMENT}\n").as_bytes())
            .map_err(|error| {
                format!(
                    "Could not write target apply log header to {}: {error}",
                    path.display()
                )
            })?;
    }

    for line in lines {
        writer.write_all(line.as_bytes()).map_err(|error| {
            format!(
                "Could not append target apply log entry for {relative_path} to {}: {error}",
                path.display()
            )
        })?;
    }

    writer.flush().map_err(|error| {
        format!(
            "Could not flush target apply log {}: {error}",
            path.display()
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub fn append_metadata_entries(
    folder_path: &str,
    relative_path: &str,
    edits: &[MetadataDraftEntry],
    argv_by_tag: &std::collections::BTreeMap<SchemaDefinitionId, Vec<String>>,
    before_metadata: &MetadataMap,
    observed_metadata: &MetadataMap,
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
    let outcome_by_tag: std::collections::BTreeMap<&SchemaDefinitionId, &MetadataTagOutcome> =
        tag_outcomes.iter().map(|o| (&o.id, o)).collect();

    let empty_argv: Vec<String> = Vec::new();
    for edit_entry in edits {
        let id = &edit_entry.id;
        let edit = &edit_entry.edit;
        let argv = argv_by_tag.get(id).unwrap_or(&empty_argv);
        let (outcome, note, display_name) = match outcome_by_tag.get(id) {
            Some(o) => (
                o.kind.as_str(),
                o.message.as_deref(),
                o.display_name.as_str(),
            ),
            None => ("Match", None, "<unknown>"),
        };

        let entry = MetadataApplyLogEntry {
            schema_version: SEMANTIC_LOG_SCHEMA_VERSION,
            timestamp: timestamp.clone(),
            relative_path,
            id,
            display_name,
            intent: &edit.intent,
            intended_value: &edit.value,
            argv,
            before: before_metadata.get(id),
            before_read_failed,
            observed: observed_metadata.get(id),
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
            Err(e) => log::warn!("[apply_log] serialise error for id {:?}: {}", id, e),
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
    use crate::draft_edits::MetadataDraftEdit;
    use crate::metadata_draft_target::MetadataDraftTarget;
    use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
    use std::collections::BTreeMap;
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
        let id = SchemaDefinitionId {
            table: "Test::Log".into(),
            tag_id: tag.into(),
            index: None,
        };
        MetadataTagOutcome {
            id,
            display_name: tag.to_string(),
            kind: kind.to_string(),
            sent: None,
            before: None,
            observed: None,
            message: None,
        }
    }

    fn target_schema(index: Option<u32>) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "282".into(),
            index,
        }
    }

    fn occurrence(path: &str, copy: u32) -> MetadataOccurrenceId {
        MetadataOccurrenceId {
            document: None,
            path: path.into(),
            tag_id: "282".into(),
            copy,
        }
    }

    fn selector(group1: &str) -> MetadataWriteTarget {
        MetadataWriteTarget {
            group1: group1.into(),
            tag_name: "XResolution".into(),
        }
    }

    fn observed(
        path: &str,
        copy: u32,
        index: Option<u32>,
        group1: &str,
        value: i64,
    ) -> TargetApplyObservedOccurrence {
        TargetApplyObservedOccurrence {
            occurrence_id: occurrence(path, copy),
            schema_id: Some(target_schema(index)),
            write_target: Some(selector(group1)),
            value: MetadataValue::Integer(value),
        }
    }

    fn existing_audit(index: Option<u32>, display_name: &str) -> TargetApplyAuditRecord {
        let target = MetadataDraftTarget::ExistingOccurrence {
            occurrence_id: occurrence("JPEG-APP1-IFD0", 0),
            schema_id: target_schema(index),
            write_target: selector("IFD0"),
        };
        TargetApplyAuditRecord {
            target: target.clone(),
            display_name: display_name.into(),
            intent: EditIntent::Set,
            sent: Some(MetadataValue::Integer(300)),
            before: Some(MetadataValue::Integer(72)),
            write: TargetApplyWriteEvidence {
                selector: selector("IFD0"),
                arguments: TargetApplyArguments {
                    numeric: vec!["-n".into(), "-IFD0:XResolution=300".into()],
                    text: vec!["-charset".into(), "filename=UTF8".into()],
                },
                numeric_pass: TargetApplyPassStatus::Failed {
                    error: "numeric failed".into(),
                },
                text_pass: TargetApplyPassStatus::Skipped {
                    reason: "numeric pass failed".into(),
                },
                diagnostic: Some("formatted diagnostic".into()),
            },
            post_write: TargetApplyPostWriteState::Unique {
                occurrence: Box::new(observed("JPEG-APP1-IFD0", 0, index, "IFD0", 300)),
            },
            verification: TargetApplyVerificationEvidence {
                kind: "Mismatch".into(),
                message: Some("semantic mismatch".into()),
                proposed_reconciliation: MetadataDraftReconciliation::Replace { target },
            },
        }
    }

    fn new_property_audit(post_write: TargetApplyPostWriteState) -> TargetApplyAuditRecord {
        TargetApplyAuditRecord {
            target: MetadataDraftTarget::NewProperty {
                schema_id: target_schema(None),
            },
            display_name: "X Resolution".into(),
            intent: EditIntent::Set,
            sent: Some(MetadataValue::Integer(300)),
            before: None,
            write: TargetApplyWriteEvidence {
                selector: selector("IFD0"),
                arguments: TargetApplyArguments {
                    numeric: vec!["-IFD0:XResolution=300".into()],
                    text: Vec::new(),
                },
                numeric_pass: TargetApplyPassStatus::Succeeded,
                text_pass: TargetApplyPassStatus::NotApplicable,
                diagnostic: None,
            },
            post_write,
            verification: TargetApplyVerificationEvidence {
                kind: "Match".into(),
                message: None,
                proposed_reconciliation: MetadataDraftReconciliation::Clear,
            },
        }
    }

    fn target_entries(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .skip(1)
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn append_metadata_entries_records_semantic_values() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();

        let id = SchemaDefinitionId {
            table: "IPTC::ApplicationRecord".into(),
            tag_id: "60".into(),
            index: None,
        };
        let edits = vec![MetadataDraftEntry {
            id: id.clone(),
            edit: MetadataDraftEdit {
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
        }];

        let mut argv = BTreeMap::new();
        argv.insert(id.clone(), vec!["-IPTC:TimeCreated=10:56:05".into()]);

        let mut before = BTreeMap::new();
        before.insert(id.clone(), MetadataValue::Text("old".into()));
        let mut after = BTreeMap::new();
        after.insert(
            id,
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
        assert_eq!(entry["schema_version"], 7);
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
        let id = SchemaDefinitionId {
            table: "Test::Log".into(),
            tag_id: "Tag".into(),
            index: None,
        };
        let edits = vec![MetadataDraftEntry {
            id,
            edit: MetadataDraftEdit {
                value: Some(MetadataValue::Integer(1)),
                intent: EditIntent::Set,
                display: None,
            },
        }];
        let argv = BTreeMap::new();
        let before = BTreeMap::new();
        let after = BTreeMap::new();
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

    #[test]
    fn empty_target_records_create_no_file_and_bad_destinations_return_errors() {
        let dir = tempdir().unwrap();
        append_target_metadata_entries(
            dir.path().to_str().unwrap(),
            "empty.jpg",
            &[],
            &TargetDraftPersistenceOutcome::Unchanged,
        )
        .unwrap();
        assert!(!dir.path().join(TARGET_LOG_FILE_NAME).exists());

        let not_a_directory = dir.path().join("not-a-directory");
        std::fs::write(&not_a_directory, "file").unwrap();
        let error = append_target_metadata_entries(
            not_a_directory.to_str().unwrap(),
            "bad.jpg",
            &[existing_audit(None, "bad")],
            &TargetDraftPersistenceOutcome::Unchanged,
        )
        .unwrap_err();
        assert!(error.contains("target apply log"));
    }

    #[test]
    fn target_writer_is_append_only_and_preserves_order_and_operation_timestamp() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let log_path = dir.path().join(TARGET_LOG_FILE_NAME);
        std::fs::write(&log_path, "").unwrap();
        let first = existing_audit(None, "first");
        let second = existing_audit(Some(0), "second");

        append_target_metadata_entries(
            folder,
            "one.jpg",
            &[first, second],
            &TargetDraftPersistenceOutcome::Persisted,
        )
        .unwrap();
        append_target_metadata_entries(
            folder,
            "two.jpg",
            &[existing_audit(None, "third")],
            &TargetDraftPersistenceOutcome::Unchanged,
        )
        .unwrap();

        let contents = std::fs::read_to_string(&log_path).unwrap();
        assert_eq!(contents.matches(TARGET_HEADER_COMMENT).count(), 1);
        let lines: Vec<_> = contents.lines().collect();
        assert_eq!(lines[0], TARGET_HEADER_COMMENT);
        assert_eq!(lines.len(), 4);
        let entries = target_entries(&log_path);
        assert_eq!(entries[0]["display_name"], "first");
        assert_eq!(entries[1]["display_name"], "second");
        assert_eq!(entries[2]["display_name"], "third");
        assert_eq!(entries[0]["timestamp"], entries[1]["timestamp"]);
    }

    #[test]
    fn target_entry_flattens_complete_existing_evidence_without_identity_loss() {
        let dir = tempdir().unwrap();
        let record_without_index = existing_audit(None, "without index");
        let record_with_zero_index = existing_audit(Some(0), "zero index");
        append_target_metadata_entries(
            dir.path().to_str().unwrap(),
            "photo.jpg",
            &[record_without_index, record_with_zero_index],
            &TargetDraftPersistenceOutcome::PersistenceFailed {
                error: "schema-v5 draft persistence failed for photo.jpg: disk full".into(),
            },
        )
        .unwrap();

        let entries = target_entries(&dir.path().join(TARGET_LOG_FILE_NAME));
        let entry = &entries[0];
        assert_eq!(entry["schema_version"], 1);
        assert_eq!(entry["identity_model"], "TargetV5");
        assert_eq!(entry["relative_path"], "photo.jpg");
        assert_eq!(entry["draft_persistence"]["kind"], "PersistenceFailed");
        assert_eq!(
            entry["draft_persistence"]["error"],
            "schema-v5 draft persistence failed for photo.jpg: disk full"
        );
        assert_eq!(entry["target"]["kind"], "ExistingOccurrence");
        assert_eq!(
            entry["target"]["occurrence_id"]["document"],
            serde_json::Value::Null
        );
        assert_eq!(entry["target"]["occurrence_id"]["copy"], 0);
        assert_eq!(
            entry["target"]["schema_id"]["index"],
            serde_json::Value::Null
        );
        assert_eq!(entries[1]["target"]["schema_id"]["index"], 0);
        assert_eq!(entry["target"]["write_target"]["group1"], "IFD0");
        assert_eq!(entry["sent"]["kind"], "Integer");
        assert_eq!(entry["before"]["value"], 72);
        assert_eq!(entry["write"]["arguments"]["numeric"][0], "-n");
        assert_eq!(
            entry["write"]["arguments"]["numeric"][1],
            "-IFD0:XResolution=300"
        );
        assert_eq!(entry["write"]["arguments"]["text"][0], "-charset");
        assert_eq!(entry["write"]["numeric_pass"]["kind"], "Failed");
        assert_eq!(entry["write"]["numeric_pass"]["error"], "numeric failed");
        assert_eq!(entry["write"]["text_pass"]["kind"], "Skipped");
        assert_eq!(entry["write"]["diagnostic"], "formatted diagnostic");
        assert_eq!(entry["post_write"]["kind"], "Unique");
        assert_eq!(entry["post_write"]["occurrence"]["value"]["value"], 300);
        assert_eq!(entry["verification"]["kind"], "Mismatch");
        assert_eq!(entry["verification"]["message"], "semantic mismatch");
        assert_eq!(
            entry["verification"]["proposed_reconciliation"]["kind"],
            "Replace"
        );
    }

    #[test]
    fn target_writer_preserves_new_property_creation_and_ambiguity_evidence() {
        let dir = tempdir().unwrap();
        let unique = observed("JPEG-APP1-IFD0", 0, None, "IFD0", 300);
        let ambiguous = vec![
            observed("JPEG-APP1-IFD1", 2, None, "IFD1", 200),
            observed("JPEG-APP1-IFD0", 0, None, "IFD0", 300),
        ];
        append_target_metadata_entries(
            dir.path().to_str().unwrap(),
            "created.jpg",
            &[
                new_property_audit(TargetApplyPostWriteState::Unique {
                    occurrence: Box::new(unique.clone()),
                }),
                new_property_audit(TargetApplyPostWriteState::Multiple {
                    occurrences: ambiguous.clone(),
                }),
            ],
            &TargetDraftPersistenceOutcome::Persisted,
        )
        .unwrap();

        let entries = target_entries(&dir.path().join(TARGET_LOG_FILE_NAME));
        assert_eq!(entries[0]["target"]["kind"], "NewProperty");
        assert_eq!(entries[0]["post_write"]["kind"], "Unique");
        assert_eq!(
            entries[0]["post_write"]["occurrence"],
            serde_json::to_value(unique).unwrap()
        );
        assert_eq!(entries[1]["target"]["kind"], "NewProperty");
        assert_eq!(entries[1]["post_write"]["kind"], "Multiple");
        assert_eq!(
            entries[1]["post_write"]["occurrences"],
            serde_json::to_value(ambiguous).unwrap()
        );
    }

    #[test]
    fn target_writer_keeps_zero_occurrence_and_readback_evidence_structured() {
        let dir = tempdir().unwrap();
        let mut missing = existing_audit(None, "missing");
        missing.post_write = TargetApplyPostWriteState::Missing;
        missing.verification = TargetApplyVerificationEvidence {
            kind: "Missing".into(),
            message: Some("no occurrence after write".into()),
            proposed_reconciliation: MetadataDraftReconciliation::Keep,
        };
        let mut unavailable = existing_audit(None, "unavailable");
        unavailable.post_write = TargetApplyPostWriteState::Unavailable {
            cause: TargetApplyPostWriteUnavailableCause::ReadbackFailed,
            message: "authoritative readback failed".into(),
        };
        unavailable.verification = TargetApplyVerificationEvidence {
            kind: "ReadbackFailed".into(),
            message: Some("semantic verification unavailable".into()),
            proposed_reconciliation: MetadataDraftReconciliation::Keep,
        };

        append_target_metadata_entries(
            dir.path().to_str().unwrap(),
            "readback.jpg",
            &[missing, unavailable],
            &TargetDraftPersistenceOutcome::Unchanged,
        )
        .unwrap();

        let entries = target_entries(&dir.path().join(TARGET_LOG_FILE_NAME));
        assert_eq!(entries[0]["post_write"]["kind"], "Missing");
        assert_eq!(entries[1]["write"]["numeric_pass"]["kind"], "Failed");
        assert_eq!(entries[1]["write"]["diagnostic"], "formatted diagnostic");
        assert_eq!(entries[1]["post_write"]["kind"], "Unavailable");
        assert_eq!(entries[1]["post_write"]["cause"], "ReadbackFailed");
        assert_eq!(
            entries[1]["post_write"]["message"],
            "authoritative readback failed"
        );
        assert_eq!(entries[1]["verification"]["kind"], "ReadbackFailed");
        assert_eq!(
            entries[1]["verification"]["message"],
            "semantic verification unavailable"
        );
    }

    #[test]
    fn every_target_draft_persistence_variant_has_its_exact_structured_shape() {
        let dir = tempdir().unwrap();
        let variants = [
            TargetDraftPersistenceOutcome::Unchanged,
            TargetDraftPersistenceOutcome::Persisted,
            TargetDraftPersistenceOutcome::ReconciliationFailed {
                error: "reconciliation context".into(),
            },
            TargetDraftPersistenceOutcome::PersistenceFailed {
                error: "persistence context".into(),
            },
        ];
        for (index, variant) in variants.iter().enumerate() {
            append_target_metadata_entries(
                dir.path().to_str().unwrap(),
                &format!("{index}.jpg"),
                &[existing_audit(None, "variant")],
                variant,
            )
            .unwrap();
        }

        let entries = target_entries(&dir.path().join(TARGET_LOG_FILE_NAME));
        assert_eq!(
            entries[0]["draft_persistence"],
            serde_json::json!({"kind": "Unchanged"})
        );
        assert_eq!(
            entries[1]["draft_persistence"],
            serde_json::json!({"kind": "Persisted"})
        );
        assert_eq!(
            entries[2]["draft_persistence"],
            serde_json::json!({"kind": "ReconciliationFailed", "error": "reconciliation context"})
        );
        assert_eq!(
            entries[3]["draft_persistence"],
            serde_json::json!({"kind": "PersistenceFailed", "error": "persistence context"})
        );
    }

    #[test]
    fn legacy_and_target_writers_never_modify_each_others_files() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let legacy_path = dir.path().join(LOG_FILE_NAME);
        let target_path = dir.path().join(TARGET_LOG_FILE_NAME);
        std::fs::write(&legacy_path, "legacy sentinel\n").unwrap();

        append_target_metadata_entries(
            folder,
            "target.jpg",
            &[existing_audit(None, "target")],
            &TargetDraftPersistenceOutcome::Unchanged,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&legacy_path).unwrap(),
            "legacy sentinel\n"
        );
        let target_before_legacy = std::fs::read_to_string(&target_path).unwrap();

        append_metadata_entries(
            folder,
            "legacy.jpg",
            &[],
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &[],
            false,
            None,
        );
        assert_eq!(
            std::fs::read_to_string(&target_path).unwrap(),
            target_before_legacy
        );
        assert!(legacy_path.exists());
        assert!(target_path.exists());
    }
}
