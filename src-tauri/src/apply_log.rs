//! Append-only target-aware audit log for metadata apply operations.
//!
//! Append-only by design: never truncated, never read by the app. The files are
//! supplemental forensic evidence users can inspect after a write looks wrong.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §6.

use crate::apply_edits::MetadataDraftReconciliation;
use crate::draft_edits::EditIntent;
use crate::metadata_draft_target::MetadataDraftTarget;
use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
use crate::metadata_value::MetadataValue;
use crate::tag_schema::SchemaDefinitionId;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const TARGET_LOG_FILE_NAME: &str = "MediaLibraryTargetApplyLog.jsonl";
const TARGET_LOG_SCHEMA_VERSION: u32 = 1;
const TARGET_LOG_IDENTITY_MODEL: &str = "TargetDraft";
const TARGET_HEADER_COMMENT: &str = "// Target-aware apply audit log. Append-only. Each line is one exact target outcome from one target-aware apply. schema_version=1.";

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
    use crate::metadata_draft_target::MetadataDraftTarget;
    use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
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
            runtime_tag_id: "282".into(),
            tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                table: "Exif::Main".into(),
                tag_id: "282".into(),
                index: None,
            },
            copy,
        }
    }

    fn selector(group1: &str) -> MetadataWriteTarget {
        MetadataWriteTarget {
            group1: group1.into(),
            group7: "ID-282".into(),
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
                write_target: selector("IFD0"),
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
                error: "target-aware draft persistence failed for photo.jpg: disk full".into(),
            },
        )
        .unwrap();

        let entries = target_entries(&dir.path().join(TARGET_LOG_FILE_NAME));
        let entry = &entries[0];
        assert_eq!(entry["schema_version"], 1);
        assert_eq!(entry["identity_model"], "TargetDraft");
        assert_eq!(entry["relative_path"], "photo.jpg");
        assert_eq!(entry["draft_persistence"]["kind"], "PersistenceFailed");
        assert_eq!(
            entry["draft_persistence"]["error"],
            "target-aware draft persistence failed for photo.jpg: disk full"
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
    fn target_writer_leaves_historical_apply_log_untouched() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let legacy_path = dir.path().join("MediaLibraryApplyLog.jsonl");
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
        assert!(legacy_path.exists());
        assert!(target_path.exists());
    }
}
