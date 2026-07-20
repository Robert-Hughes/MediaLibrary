//! Shared metadata edit semantics and target-aware draft persistence.
//!
//! Production persists only exact targets in
//! `MediaLibraryTargetDraftEdits.jsonl`. Historical schema-keyed draft files
//! are deliberately neither read nor modified.

use crate::metadata_draft_target::{MetadataDraftSlot, MetadataDraftTarget};
use crate::metadata_occurrence::{
    family7_group_from_runtime_tag_id, family7_group_from_schema_id, validate_family1_group,
};
use crate::metadata_value::MetadataValue;
use crate::tag_schema::SchemaDefinitionId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum EditIntent {
    Set,
    Delete,
    ListAdd,
    ListRemove,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataDraftEdit {
    pub value: Option<MetadataValue>,
    pub intent: EditIntent,
}

// Schema-addressed edit suggestion emitted by generation jobs. It is an
// in-memory/wire staging value, not a persisted draft or apply target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SchemaMetadataEdit {
    pub schema_id: SchemaDefinitionId,
    pub edit: MetadataDraftEdit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataTargetDraftEntry {
    pub target: MetadataDraftTarget,
    pub edit: MetadataDraftEdit,
}

pub type MetadataTargetDraftsByFile = HashMap<String, Vec<MetadataTargetDraftEntry>>;

/// Schema-addressed generation output which the frontend resolves to exact
/// targets before it enters the production draft store.
pub type SchemaMetadataEditMap = BTreeMap<SchemaDefinitionId, MetadataDraftEdit>;

pub(crate) fn schema_metadata_edit_entries(map: SchemaMetadataEditMap) -> Vec<SchemaMetadataEdit> {
    map.into_iter()
        .map(|(schema_id, edit)| SchemaMetadataEdit { schema_id, edit })
        .collect()
}

#[derive(Serialize, Deserialize)]
struct TargetDraftLine {
    schema_version: u32,
    relative_path: String,
    edits: Vec<MetadataTargetDraftEntry>,
}

#[derive(Deserialize)]
struct VersionProbe {
    #[serde(default)]
    schema_version: Option<u32>,
}

const TARGET_DRAFT_FILE_NAME: &str = "MediaLibraryTargetDraftEdits.jsonl";
const HEADER_COMMENT: &str =
    "// This file stores unapplied target-aware metadata draft edits. Lines starting with // are ignored.";

pub fn load_metadata_draft_edits(folder_path: &str) -> Result<MetadataTargetDraftsByFile, String> {
    let path = Path::new(folder_path).join(TARGET_DRAFT_FILE_NAME);
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let file = File::open(&path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let mut drafts = HashMap::new();
    let mut seen_paths = HashMap::new();

    for (line_index, line_result) in reader.lines().enumerate() {
        let line = line_result.map_err(|error| error.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        let line_number = line_index + 1;
        let version = serde_json::from_str::<VersionProbe>(trimmed)
            .map_err(|error| format!("Invalid draft line {line_number}: {error}"))?
            .schema_version;
        if version != Some(5) {
            return Err(match version {
                Some(version) if version > 5 => format!(
                    "Unsupported future draft edit schema_version {version} on line {line_number}. This target draft loader only supports schema_version 5."
                ),
                Some(version) => format!(
                    "Unsupported target draft edit schema_version {version} on line {line_number}."
                ),
                None => format!(
                    "Unsupported target draft edit line {line_number} with no schema_version."
                ),
            });
        }

        let parsed = serde_json::from_str::<TargetDraftLine>(trimmed).map_err(|error| {
            format!("Invalid draft schema version 5 line {line_number}: {error}")
        })?;
        if let Some(first_line) = seen_paths.insert(parsed.relative_path.clone(), line_number) {
            return Err(format!(
                "duplicate relative_path {:?} on line {line_number}; first seen on line {first_line}",
                parsed.relative_path
            ));
        }
        validate_slots(&parsed.relative_path, &parsed.edits, Some(line_number))?;
        if !parsed.edits.is_empty() {
            drafts.insert(parsed.relative_path, parsed.edits);
        }
    }

    Ok(drafts)
}

pub fn save_metadata_draft_edits(
    folder_path: &str,
    data: &MetadataTargetDraftsByFile,
) -> Result<(), String> {
    for (relative_path, entries) in data {
        validate_slots(relative_path, entries, None)?;
    }

    let path = Path::new(folder_path).join(TARGET_DRAFT_FILE_NAME);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{HEADER_COMMENT}").map_err(|error| error.to_string())?;

    let mut files: Vec<_> = data.iter().collect();
    files.sort_by(|left, right| left.0.cmp(right.0));
    for (relative_path, entries) in files {
        if entries.is_empty() {
            continue;
        }
        let mut sorted = entries.clone();
        sorted.sort_by_key(|entry| entry.target.slot());
        let line = TargetDraftLine {
            schema_version: 5,
            relative_path: relative_path.clone(),
            edits: sorted,
        };
        let json = serde_json::to_string(&line).map_err(|error| error.to_string())?;
        writeln!(file, "{json}").map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_slots(
    relative_path: &str,
    entries: &[MetadataTargetDraftEntry],
    line_number: Option<usize>,
) -> Result<(), String> {
    let mut slots: HashSet<MetadataDraftSlot> = HashSet::new();
    for entry in entries {
        match &entry.target {
            MetadataDraftTarget::ExistingOccurrence {
                occurrence_id,
                write_target,
                ..
            } => {
                validate_family1_group(&write_target.group1).map_err(|error| {
                    format!(
                        "Invalid existing-occurrence destination for '{relative_path}': {error}"
                    )
                })?;
                if write_target.group7
                    != family7_group_from_runtime_tag_id(&occurrence_id.runtime_tag_id)
                {
                    return Err(format!(
                        "Invalid existing-occurrence family-7 destination for '{relative_path}'"
                    ));
                }
            }
            MetadataDraftTarget::NewProperty {
                schema_id,
                write_target,
            } => {
                validate_family1_group(&write_target.group1).map_err(|error| {
                    format!("Invalid new-property destination for '{relative_path}': {error}")
                })?;
                if write_target.group7 != family7_group_from_schema_id(schema_id) {
                    return Err(format!(
                        "Invalid new-property family-7 destination for '{relative_path}'"
                    ));
                }
            }
        }
        let slot = entry.target.slot();
        if !slots.insert(slot.clone()) {
            return Err(match line_number {
                Some(line) => format!("Duplicate metadata draft slot {slot:?} on line {line}"),
                None => format!(
                    "Duplicate metadata draft slot {slot:?} in save payload for file '{relative_path}'"
                ),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
    use tempfile::tempdir;

    const OLD_DRAFT_FILE_NAME: &str = "MediaLibraryDraftEdits.jsonl";

    fn schema(index: Option<u32>) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: "XMP::Main".to_string(),
            tag_id: "Title".to_string(),
            index,
        }
    }

    fn edit() -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(MetadataValue::Text("Reykjavik draft".to_string())),
            intent: EditIntent::Set,
        }
    }

    fn existing(index: Option<u32>, path: &str) -> MetadataTargetDraftEntry {
        MetadataTargetDraftEntry {
            target: MetadataDraftTarget::ExistingOccurrence {
                occurrence_id: MetadataOccurrenceId {
                    document: None,
                    path: path.to_string(),
                    runtime_tag_id: "Title".to_string(),
                    tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                        table: "XMP::dc".to_string(),
                        tag_id: "Title".to_string(),
                        index,
                    },
                    copy: 0,
                },
                schema_id: schema(index),
                write_target: MetadataWriteTarget {
                    group1: "XMP-dc".to_string(),
                    group7: "ID-Title".to_string(),
                    tag_name: "Title".to_string(),
                },
            },
            edit: edit(),
        }
    }

    fn new_property(index: Option<u32>) -> MetadataTargetDraftEntry {
        MetadataTargetDraftEntry {
            target: MetadataDraftTarget::NewProperty {
                schema_id: schema(index),
                write_target: MetadataWriteTarget {
                    group1: "XMP-dc".to_string(),
                    group7: "ID-Title".to_string(),
                    tag_name: "Title".to_string(),
                },
            },
            edit: edit(),
        }
    }

    #[test]
    fn missing_target_file_ignores_old_file_even_when_it_is_malformed() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(OLD_DRAFT_FILE_NAME), b"not json\0legacy").unwrap();
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert!(loaded.is_empty());
        assert_eq!(
            std::fs::read(dir.path().join(OLD_DRAFT_FILE_NAME)).unwrap(),
            b"not json\0legacy"
        );
    }

    #[test]
    fn save_leaves_old_file_byte_for_byte_unchanged() {
        let dir = tempdir().unwrap();
        let old = dir.path().join(OLD_DRAFT_FILE_NAME);
        let bytes = b"historical\r\nbytes\0\xff";
        std::fs::write(&old, bytes).unwrap();
        let drafts = HashMap::from([("photo.jpg".to_string(), vec![new_property(None)])]);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &drafts).unwrap();
        assert_eq!(std::fs::read(old).unwrap(), bytes);
    }

    #[test]
    fn removed_display_field_is_omitted_from_json() {
        let dir = tempdir().unwrap();
        let drafts = HashMap::from([("photo.jpg".to_string(), vec![new_property(None)])]);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &drafts).unwrap();
        let contents = std::fs::read_to_string(dir.path().join(TARGET_DRAFT_FILE_NAME)).unwrap();
        assert!(!contents.contains("\"display\""));
    }

    #[test]
    fn exact_targets_survive_round_trip() {
        let dir = tempdir().unwrap();
        let drafts = HashMap::from([(
            "photo.jpg".to_string(),
            vec![existing(None, "IFD0"), existing(None, "IFD1")],
        )]);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &drafts).unwrap();
        assert_eq!(
            load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap(),
            drafts
        );
    }

    #[test]
    fn existing_and_new_identities_and_index_absence_round_trip() {
        let dir = tempdir().unwrap();
        let drafts = HashMap::from([(
            "photo.jpg".to_string(),
            vec![existing(None, "IFD0"), new_property(Some(0))],
        )]);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &drafts).unwrap();
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, drafts);
        assert_ne!(
            loaded["photo.jpg"][0].target.slot(),
            loaded["photo.jpg"][1].target.slot()
        );
    }

    #[test]
    fn malformed_and_duplicate_input_is_rejected_before_truncation() {
        let dir = tempdir().unwrap();
        let target = dir.path().join(TARGET_DRAFT_FILE_NAME);
        std::fs::write(&target, b"preserve me").unwrap();
        let duplicate = new_property(None);
        let drafts = HashMap::from([("photo.jpg".to_string(), vec![duplicate.clone(), duplicate])]);
        assert!(save_metadata_draft_edits(dir.path().to_str().unwrap(), &drafts).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"preserve me");
    }
}
