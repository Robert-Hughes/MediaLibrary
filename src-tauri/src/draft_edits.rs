//! Draft-edit persistence with versioned JSONL schema.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §7.
//!
//! On-disk format is JSONL. Production load/save supports:
//!
//! - **v4**: `{ "schema_version": 4, "relative_path": "...", "edits":
//!   [{ "id": { "table": "...", "tag_id": "...", "index": ... }, "edit": { "value": <MetadataValue | null>, "intent": "Set" | ..., "display": ... } }] }`
//!
//! Schema v4 remains in `MediaLibraryDraftEdits.jsonl`; production Add Property
//! schema-v5 drafts use `MediaLibraryTargetDraftEdits.jsonl`. The two maps may
//! coexist for the same folder and relative path. When the target file is absent,
//! the v5 loader can atomically migrate a completely valid v5 file written to the
//! old shared path by the brief activation bridge.
//!
//! Production loading rejects older v1/v2/v3 lines with a clear error. Old
//! drafts must be recreated so semantic values are never reconstructed from
//! display strings. Production saving always writes v4.

use crate::metadata_draft_target::{MetadataDraftSlot, MetadataDraftTarget};
use crate::metadata_value::MetadataValue;
use crate::tag_schema::SchemaDefinitionId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
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

// ── v4 semantic model ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataDraftEdit {
    pub value: Option<MetadataValue>,
    pub intent: EditIntent,
    /// Optional pretty-printed label for UI display only. The persisted value
    /// remains semantic and must not round-trip through this string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub display: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataDraftEntry {
    pub id: SchemaDefinitionId,
    pub edit: MetadataDraftEdit,
}

pub type MetadataDraftEdits = HashMap<String, Vec<MetadataDraftEntry>>;

// ── production bridge v5 target-aware model ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataDraftEntryV5 {
    pub target: MetadataDraftTarget,
    pub edit: MetadataDraftEdit,
}

pub type MetadataDraftEditsV5 = HashMap<String, Vec<MetadataDraftEntryV5>>;

// Public because the integration-test crate exercises exact-ID geocode batches.
pub type MetadataDraftMap = BTreeMap<SchemaDefinitionId, MetadataDraftEdit>;

pub(crate) fn draft_entries(map: MetadataDraftMap) -> Vec<MetadataDraftEntry> {
    map.into_iter()
        .map(|(id, edit)| MetadataDraftEntry { id, edit })
        .collect()
}

// ── On-disk schemas ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct V4Line {
    schema_version: u32,
    relative_path: String,
    edits: Vec<MetadataDraftEntry>,
}

#[derive(Serialize, Deserialize)]
struct V5Line {
    schema_version: u32,
    relative_path: String,
    edits: Vec<MetadataDraftEntryV5>,
}

#[derive(Deserialize)]
struct VersionProbe {
    #[serde(default)]
    schema_version: Option<u32>,
}

// ── File names ───────────────────────────────────────────────────────────────

const V4_FILE_NAME: &str = "MediaLibraryDraftEdits.jsonl";
const V5_FILE_NAME: &str = "MediaLibraryTargetDraftEdits.jsonl";
const HEADER_COMMENT: &str =
    "// This file stores unapplied metadata draft edits. Lines starting with // are ignored.";

pub fn load_metadata_draft_edits(folder_path: &str) -> Result<MetadataDraftEdits, String> {
    let path = Path::new(folder_path).join(V4_FILE_NAME);
    let mut typed: MetadataDraftEdits = HashMap::new();

    if !path.exists() {
        return Ok(typed);
    }

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut seen_paths = HashMap::new();

    for (line_no, line_result) in reader.lines().enumerate() {
        let line = line_result.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }

        let version = serde_json::from_str::<VersionProbe>(trimmed)
            .map_err(|e| format!("Invalid draft line {}: {e}", line_no + 1))?
            .schema_version;

        match version {
            Some(4) => {
                let parsed = serde_json::from_str::<V4Line>(trimmed)
                    .map_err(|e| format!("Invalid v4 draft line {}: {e}", line_no + 1))?;

                if let Some(first_line) = seen_paths.get(&parsed.relative_path) {
                    return Err(format!(
                        "duplicate relative_path {:?} on line {}; first seen on line {}",
                        parsed.relative_path,
                        line_no + 1,
                        first_line
                    ));
                }
                seen_paths.insert(parsed.relative_path.clone(), line_no + 1);

                // Detect duplicate tag IDs within a single file's edits
                let mut seen_ids = HashSet::new();
                for entry in &parsed.edits {
                    if !seen_ids.insert(&entry.id) {
                        return Err(format!(
                            "Duplicate SchemaDefinitionId '{}' on line {}",
                            entry.id,
                            line_no + 1
                        ));
                    }
                }

                if !parsed.edits.is_empty() {
                    typed.insert(parsed.relative_path, parsed.edits);
                }
            }
            Some(old) => {
                if old > 4 {
                    return Err(format!(
                        "Unsupported future draft edit schema_version {old} on line {}. This version of MediaLibrary only supports schema_version 4.",
                        line_no + 1
                    ));
                } else {
                    return Err(format!(
                        "Unsupported draft edit schema_version {old} on line {}. Recreate pending draft edits with schema_version 4 because legacy tag names do not uniquely identify ExifTool definitions.",
                        line_no + 1
                    ));
                }
            }
            None => {
                return Err(format!(
                    "Unsupported legacy draft edit line {} with no schema_version. Recreate pending draft edits with schema_version 4 because legacy tag names do not uniquely identify ExifTool definitions.",
                    line_no + 1
                ));
            }
        }
    }

    Ok(typed)
}

pub fn save_metadata_draft_edits(
    folder_path: &str,
    data: &MetadataDraftEdits,
) -> Result<(), String> {
    let path = Path::new(folder_path).join(V4_FILE_NAME);

    // Verify duplicate IDs before saving
    for (rel_path, entries) in data {
        let mut seen = HashSet::new();
        for entry in entries {
            if !seen.insert(&entry.id) {
                return Err(format!(
                    "Duplicate SchemaDefinitionId '{}' in save payload for file '{}'",
                    entry.id, rel_path
                ));
            }
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    writeln!(file, "{}", HEADER_COMMENT).map_err(|e| e.to_string())?;

    // Sort files by relative path
    let mut sorted_files: Vec<(&String, &Vec<MetadataDraftEntry>)> = data.iter().collect();
    sorted_files.sort_by(|a, b| a.0.cmp(b.0));

    for (relative_path, edits) in sorted_files {
        if edits.is_empty() {
            continue;
        }

        // Sort draft entries by SchemaDefinitionId
        let mut sorted_edits = edits.clone();
        sorted_edits.sort_by(|a, b| a.id.cmp(&b.id));

        let line = V4Line {
            schema_version: 4,
            relative_path: relative_path.clone(),
            edits: sorted_edits,
        };
        let json_line = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        writeln!(file, "{}", json_line).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Loads the target-aware schema-v5 format used by production Add Property.
///
/// Remaining editing producers retain schema-v4 persistence during the
/// controlled migration; the formats have intentionally incompatible identities.
pub fn load_metadata_draft_edits_v5(folder_path: &str) -> Result<MetadataDraftEditsV5, String> {
    let folder = Path::new(folder_path);
    let path = folder.join(V5_FILE_NAME);

    if path.exists() {
        return load_metadata_draft_edits_v5_from_path(&path);
    }

    let old_path = folder.join(V4_FILE_NAME);
    if !old_path.exists() {
        return Ok(HashMap::new());
    }

    migrate_misplaced_v5_file(&old_path, &path)
}

fn load_metadata_draft_edits_v5_from_path(path: &Path) -> Result<MetadataDraftEditsV5, String> {
    let mut typed: MetadataDraftEditsV5 = HashMap::new();

    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut seen_paths = HashMap::new();

    for (line_no, line_result) in reader.lines().enumerate() {
        let line = line_result.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }

        let display_line = line_no + 1;
        let version = serde_json::from_str::<VersionProbe>(trimmed)
            .map_err(|e| format!("Invalid draft line {display_line}: {e}"))?
            .schema_version;

        match version {
            Some(5) => {
                let parsed = serde_json::from_str::<V5Line>(trimmed)
                    .map_err(|e| format!("Invalid v5 draft line {display_line}: {e}"))?;

                if let Some(first_line) = seen_paths.get(&parsed.relative_path) {
                    return Err(format!(
                        "duplicate relative_path {:?} on line {}; first seen on line {}",
                        parsed.relative_path, display_line, first_line
                    ));
                }
                seen_paths.insert(parsed.relative_path.clone(), display_line);

                let mut seen_slots: HashSet<MetadataDraftSlot> = HashSet::new();
                for entry in &parsed.edits {
                    let slot = entry.target.slot();
                    if !seen_slots.insert(slot.clone()) {
                        return Err(format!(
                            "Duplicate metadata draft slot {slot:?} on line {display_line}"
                        ));
                    }
                }

                if !parsed.edits.is_empty() {
                    typed.insert(parsed.relative_path, parsed.edits);
                }
            }
            Some(4) => {
                return Err(format!(
                    "Cannot load schema_version 4 as v5 on line {display_line}. Schema-v4 drafts are keyed only by SchemaDefinitionId and cannot be safely converted into ExistingOccurrence or NewProperty targets without authoritative runtime context. Recreate pending drafts after the v5 migration."
                ));
            }
            Some(version) if version > 5 => {
                return Err(format!(
                    "Unsupported future draft edit schema_version {version} on line {display_line}. This v5 loader only supports schema_version 5."
                ));
            }
            Some(version) => {
                return Err(format!(
                    "Unsupported legacy draft edit schema_version {version} on line {display_line}. Recreate pending draft edits with schema_version 5."
                ));
            }
            None => {
                return Err(format!(
                    "Unsupported legacy draft edit line {display_line} with no schema_version. Recreate pending draft edits with schema_version 5."
                ));
            }
        }
    }

    Ok(typed)
}

fn migrate_misplaced_v5_file(
    old_path: &Path,
    target_path: &Path,
) -> Result<MetadataDraftEditsV5, String> {
    let file = File::open(old_path).map_err(|error| migration_error(error.to_string()))?;
    let reader = BufReader::new(file);
    let mut versions = Vec::new();

    for (line_no, line_result) in reader.lines().enumerate() {
        let line = line_result.map_err(|error| migration_error(error.to_string()))?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        let version = serde_json::from_str::<VersionProbe>(trimmed)
            .map_err(|error| {
                migration_error(format!("invalid JSON on line {}: {error}", line_no + 1))
            })?
            .schema_version
            .ok_or_else(|| {
                migration_error(format!("line {} has no schema_version", line_no + 1))
            })?;
        versions.push(version);
    }

    if versions.is_empty() {
        return Ok(HashMap::new());
    }

    if versions.iter().all(|version| *version == 4) {
        // Validate that this really is a v4 file before classifying it as
        // independently owned legacy persistence. The v4 loader never writes.
        load_metadata_draft_edits(
            old_path
                .parent()
                .and_then(Path::to_str)
                .ok_or_else(|| migration_error("old shared file has a non-UTF-8 parent path"))?,
        )
        .map_err(migration_error)?;
        return Ok(HashMap::new());
    }

    if !versions.iter().all(|version| *version == 5) {
        return Err(migration_error(format!(
            "found incompatible schema versions {versions:?}"
        )));
    }

    // Complete strict validation, including duplicate paths and slots, before
    // the byte-preserving rename is attempted.
    let drafts = load_metadata_draft_edits_v5_from_path(old_path).map_err(migration_error)?;
    fs::rename(old_path, target_path).map_err(|error| {
        migration_error(format!(
            "validated schema-v5 data but could not rename {} to {}: {error}",
            old_path.display(),
            target_path.display()
        ))
    })?;
    Ok(drafts)
}

fn migration_error(error: impl std::fmt::Display) -> String {
    format!("Old shared draft file cannot be safely classified or migrated: {error}")
}

/// Saves the target-aware schema-v5 format used by production Add Property.
///
/// Validation completes before the v5-owned filename is opened or truncated.
/// Remaining editing producers retain independent schema-v4 persistence.
pub fn save_metadata_draft_edits_v5(
    folder_path: &str,
    data: &MetadataDraftEditsV5,
) -> Result<(), String> {
    let path = Path::new(folder_path).join(V5_FILE_NAME);

    // Validate the complete input before opening/truncating the destination.
    for (relative_path, entries) in data {
        let mut seen_slots: HashSet<MetadataDraftSlot> = HashSet::new();
        for entry in entries {
            let slot = entry.target.slot();
            if !seen_slots.insert(slot.clone()) {
                return Err(format!(
                    "Duplicate metadata draft slot {slot:?} in save payload for file '{relative_path}'"
                ));
            }
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    writeln!(file, "{}", HEADER_COMMENT).map_err(|e| e.to_string())?;

    let mut sorted_files: Vec<(&String, &Vec<MetadataDraftEntryV5>)> = data.iter().collect();
    sorted_files.sort_by(|a, b| a.0.cmp(b.0));

    for (relative_path, edits) in sorted_files {
        if edits.is_empty() {
            continue;
        }

        let mut sorted_edits = edits.clone();
        sorted_edits.sort_by_key(|entry| entry.target.slot());

        let line = V5Line {
            schema_version: 5,
            relative_path: relative_path.clone(),
            edits: sorted_edits,
        };
        let json_line = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        writeln!(file, "{json_line}").map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
    use crate::metadata_value::{ListKind, MetadataValue};
    use std::fs;
    use tempfile::tempdir;

    const FILE_NAME: &str = V4_FILE_NAME;

    fn write_file(folder: &Path, name: &str, contents: &str) {
        fs::write(folder.join(name), contents).unwrap();
    }

    fn read_file(folder: &Path, name: &str) -> String {
        fs::read_to_string(folder.join(name)).unwrap()
    }

    fn make_entry(
        table: &str,
        tag_id: &str,
        index: Option<u32>,
        value: MetadataValue,
        display: Option<&str>,
    ) -> MetadataDraftEntry {
        MetadataDraftEntry {
            id: SchemaDefinitionId {
                table: table.to_string(),
                tag_id: tag_id.to_string(),
                index,
            },
            edit: MetadataDraftEdit {
                value: Some(value),
                intent: EditIntent::Set,
                display: display.map(|s| s.to_string()),
            },
        }
    }

    #[test]
    fn test_1_missing_draft_file_returns_empty() {
        let dir = tempdir().unwrap();
        let result = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_2_empty_per_file_collections_are_not_written() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        data.insert("empty.jpg".to_string(), vec![]);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let contents = read_file(dir.path(), FILE_NAME);
        assert!(!contents.contains("empty.jpg"));
        assert_eq!(contents.trim(), HEADER_COMMENT);
    }

    #[test]
    fn test_3_comments_and_blank_lines_are_ignored() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "// header comment\n",
                "\n",
                "// another comment\n",
                "{\"schema_version\":4,\"relative_path\":\"a.jpg\",\"edits\":[]}\n",
            ),
        );
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn test_4_display_values_persist_and_round_trip() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("hello".into()),
            Some("Nice Title"),
        );
        data.insert("photo.jpg".to_string(), vec![entry.clone()]);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();

        let contents = read_file(dir.path(), FILE_NAME);
        assert!(contents.contains("Nice Title"));

        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn test_5_display_none_is_omitted() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("hello".into()),
            None,
        );
        data.insert("photo.jpg".to_string(), vec![entry]);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();

        let contents = read_file(dir.path(), FILE_NAME);
        assert!(!contents.contains("\"display\""));
    }

    #[test]
    fn test_7_v4_round_trip_preserves_table_tag_id_index_none() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("hello".into()),
            None,
        );
        data.insert("photo.jpg".to_string(), vec![entry.clone()]);

        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        let loaded_entry = &loaded.get("photo.jpg").unwrap()[0];
        assert_eq!(loaded_entry.id.table, "XMP::dc");
        assert_eq!(loaded_entry.id.tag_id, "title");
        assert_eq!(loaded_entry.id.index, None);
    }

    #[test]
    fn test_8_v4_round_trip_preserves_index_some_0() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry = make_entry(
            "XMP::dc",
            "title",
            Some(0),
            MetadataValue::Text("hello".into()),
            None,
        );
        data.insert("photo.jpg".to_string(), vec![entry.clone()]);

        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        let loaded_entry = &loaded.get("photo.jpg").unwrap()[0];
        assert_eq!(loaded_entry.id.index, Some(0));
    }

    #[test]
    fn test_9_none_and_some_0_remain_distinct_draft_keys() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry1 = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("hello".into()),
            None,
        );
        let entry2 = make_entry(
            "XMP::dc",
            "title",
            Some(0),
            MetadataValue::Text("world".into()),
            None,
        );
        data.insert("photo.jpg".to_string(), vec![entry1, entry2]);

        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        let entries = loaded.get("photo.jpg").unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.id.index.is_none()));
        assert!(entries.iter().any(|e| e.id.index == Some(0)));
    }

    #[test]
    fn test_10_two_entries_with_same_friendly_name_but_different_ids_survive() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry1 = make_entry(
            "XMP::dc",
            "description",
            None,
            MetadataValue::Text("caption1".into()),
            Some("Description"),
        );
        let entry2 = make_entry(
            "IPTC::ApplicationRecord",
            "120",
            None,
            MetadataValue::Text("caption2".into()),
            Some("Description"),
        );
        data.insert("photo.jpg".to_string(), vec![entry1, entry2]);

        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        let entries = loaded.get("photo.jpg").unwrap();
        assert_eq!(entries.len(), 2);

        let e1 = entries.iter().find(|e| e.id.table == "XMP::dc").unwrap();
        let e2 = entries
            .iter()
            .find(|e| e.id.table == "IPTC::ApplicationRecord")
            .unwrap();
        assert_eq!(e1.edit.display, Some("Description".to_string()));
        assert_eq!(e2.edit.display, Some("Description".to_string()));
        assert_eq!(e1.edit.value, Some(MetadataValue::Text("caption1".into())));
        assert_eq!(e2.edit.value, Some(MetadataValue::Text("caption2".into())));
    }

    #[test]
    fn test_11_entry_ordering_is_deterministic() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry_b = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("b".into()),
            None,
        );
        let entry_a = make_entry(
            "EXIF::Main",
            "orientation",
            None,
            MetadataValue::Integer(1),
            None,
        );
        data.insert("photo.jpg".to_string(), vec![entry_b, entry_a]);

        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let contents = read_file(dir.path(), FILE_NAME);

        let idx_exif = contents.find("EXIF::Main").unwrap();
        let idx_xmp = contents.find("XMP::dc").unwrap();
        assert!(
            idx_exif < idx_xmp,
            "EXIF::Main should be serialized before XMP::dc"
        );
    }

    #[test]
    fn test_12_legacy_line_with_no_version_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("no schema_version"), "{err}");
        assert!(err.contains("schema_version 4"), "{err}");
    }

    #[test]
    fn test_13_v1_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":1,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("schema_version 1"), "{err}");
        assert!(err.contains("schema_version 4"), "{err}");
    }

    #[test]
    fn test_14_v2_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":2,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("schema_version 2"), "{err}");
    }

    #[test]
    fn test_15_v3_is_rejected_with_exact_identity_explanation() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":3,\"relative_path\":\"photo.jpg\",\"edits\":{}}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("schema_version 3 on line 1"), "{err}");
        assert!(
            err.contains("legacy tag names do not uniquely identify ExifTool definitions"),
            "{err}"
        );
    }

    #[test]
    fn test_16_unknown_future_version_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":5,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("schema_version 5"), "{err}");
    }

    #[test]
    fn test_17_invalid_json_is_rejected_with_line_number() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":4,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n{not json}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("Invalid draft line 2"), "{err}");
    }

    #[test]
    fn test_18_duplicate_exact_ids_within_one_file_are_rejected_on_load() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "{\"schema_version\":4,\"relative_path\":\"photo.jpg\",\"edits\":[",
                "{\"id\":{\"table\":\"XMP::dc\",\"tag_id\":\"title\"},\"edit\":{\"value\":{\"kind\":\"Text\",\"value\":\"a\"},\"intent\":\"Set\"}},",
                "{\"id\":{\"table\":\"XMP::dc\",\"tag_id\":\"title\"},\"edit\":{\"value\":{\"kind\":\"Text\",\"value\":\"b\"},\"intent\":\"Set\"}}",
                "]}\n"
            )
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(
            err.contains("Duplicate SchemaDefinitionId 'XMP::dc/title' on line 1"),
            "{err}"
        );
    }

    #[test]
    fn test_19_duplicate_exact_ids_are_rejected_on_save() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry1 = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("a".into()),
            None,
        );
        let entry2 = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("b".into()),
            None,
        );
        data.insert("photo.jpg".to_string(), vec![entry1, entry2]);

        let err = save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap_err();
        assert!(
            err.contains("Duplicate SchemaDefinitionId 'XMP::dc/title'"),
            "{err}"
        );
    }

    #[test]
    fn test_20_duplicate_file_lines_rejected_reporting_both_locations() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "{\"schema_version\":4,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
                "// comment\n",
                "{\"schema_version\":4,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n"
            ),
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(
            err.contains("duplicate relative_path \"photo.jpg\" on line 3; first seen on line 1"),
            "{err}"
        );
    }

    #[test]
    fn test_21_edits_empty_accepted_but_omitted() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":4,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn test_23_tauri_json_serialization_is_entry_array() {
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("hello".into()),
            None,
        );
        data.insert("photo.jpg".to_string(), vec![entry]);

        let json_str = serde_json::to_string(&data).unwrap();
        assert!(
            json_str.contains("\"photo.jpg\":["),
            "expected JSON array mapping for relative path: {}",
            json_str
        );
        assert!(
            json_str.contains("\"id\":"),
            "expected entry shape containing id: {}",
            json_str
        );
        assert!(
            json_str.contains("\"edit\":"),
            "expected entry shape containing edit: {}",
            json_str
        );
    }

    #[test]
    fn test_24_idempotency_save_load_save() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry1 = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("a".into()),
            None,
        );
        let entry2 = make_entry(
            "EXIF::Main",
            "orientation",
            None,
            MetadataValue::Integer(3),
            None,
        );
        data.insert("a.jpg".to_string(), vec![entry1]);
        data.insert("b.jpg".to_string(), vec![entry2]);

        // Save first time
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let first_file_content = read_file(dir.path(), FILE_NAME);

        // Load it
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, data);

        // Save second time
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &loaded).unwrap();
        let second_file_content = read_file(dir.path(), FILE_NAME);

        assert_eq!(first_file_content, second_file_content);
    }

    #[test]
    fn test_25_deterministic_relative_path_ordering() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry_z = make_entry(
            "XMP::dc",
            "title",
            None,
            MetadataValue::Text("z".into()),
            None,
        );
        let entry_a = make_entry(
            "EXIF::Main",
            "orientation",
            None,
            MetadataValue::Integer(1),
            None,
        );
        data.insert("z.jpg".to_string(), vec![entry_z]);
        data.insert("a.jpg".to_string(), vec![entry_a]);

        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let contents = read_file(dir.path(), FILE_NAME);

        // Check relative paths ordering
        let idx_a_jpg = contents.find("a.jpg").unwrap();
        let idx_z_jpg = contents.find("z.jpg").unwrap();
        assert!(idx_a_jpg < idx_z_jpg, "a.jpg should come before z.jpg");
    }

    #[test]
    fn test_26_tauri_wire_shape_rigorous() {
        let mut data: MetadataDraftEdits = HashMap::new();
        let entry = make_entry(
            "XMP::dc",
            "title",
            Some(1),
            MetadataValue::Text("hello".into()),
            Some("Nice Title"),
        );
        data.insert("photo.jpg".to_string(), vec![entry]);

        let json_str = serde_json::to_string(&data).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // Must be a map at top level
        let obj = value.as_object().unwrap();
        // Must contain "photo.jpg"
        let photo_edits = obj.get("photo.jpg").unwrap();
        // Must be an array
        let edits_arr = photo_edits.as_array().unwrap();
        assert_eq!(edits_arr.len(), 1);

        let edit_entry = edits_arr[0].as_object().unwrap();

        // Must have "id" which has table/tag_id/index
        let id_val = edit_entry.get("id").unwrap().as_object().unwrap();
        assert_eq!(id_val.get("table").unwrap().as_str().unwrap(), "XMP::dc");
        assert_eq!(id_val.get("tag_id").unwrap().as_str().unwrap(), "title");
        assert_eq!(id_val.get("index").unwrap().as_i64().unwrap(), 1);

        // Must have "edit" which has value/intent/display
        let edit_val = edit_entry.get("edit").unwrap().as_object().unwrap();
        assert_eq!(edit_val.get("intent").unwrap().as_str().unwrap(), "Set");
        assert_eq!(
            edit_val.get("display").unwrap().as_str().unwrap(),
            "Nice Title"
        );

        let val_val = edit_val.get("value").unwrap().as_object().unwrap();
        assert_eq!(val_val.get("kind").unwrap().as_str().unwrap(), "Text");
        assert_eq!(val_val.get("value").unwrap().as_str().unwrap(), "hello");
    }

    fn v5_schema(index: Option<u32>) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: "Exif::Main".to_owned(),
            tag_id: "282".to_owned(),
            index,
        }
    }

    fn v5_edit(value: MetadataValue) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(value),
            intent: EditIntent::Set,
            display: Some("display snapshot".to_owned()),
        }
    }

    fn v5_existing_entry(
        path: &str,
        copy: u32,
        schema_index: Option<u32>,
        group1: &str,
        value: MetadataValue,
    ) -> MetadataDraftEntryV5 {
        MetadataDraftEntryV5 {
            target: MetadataDraftTarget::ExistingOccurrence {
                occurrence_id: MetadataOccurrenceId {
                    document: Some("Doc1".to_owned()),
                    path: path.to_owned(),
                    tag_id: "282".to_owned(),
                    copy,
                },
                schema_id: v5_schema(schema_index),
                write_target: MetadataWriteTarget {
                    group1: group1.to_owned(),
                    tag_name: "XResolution".to_owned(),
                },
            },
            edit: v5_edit(value),
        }
    }

    fn v5_new_entry(index: Option<u32>, value: MetadataValue) -> MetadataDraftEntryV5 {
        MetadataDraftEntryV5 {
            target: MetadataDraftTarget::NewProperty {
                schema_id: v5_schema(index),
            },
            edit: v5_edit(value),
        }
    }

    fn write_v5_line(folder: &Path, line: &V5Line) {
        write_file(
            folder,
            V5_FILE_NAME,
            &format!("{}\n", serde_json::to_string(line).unwrap()),
        );
    }

    #[test]
    fn v5_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        assert!(load_metadata_draft_edits_v5(dir.path().to_str().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn v5_existing_target_round_trip_preserves_every_snapshot_and_outer_path() {
        let dir = tempdir().unwrap();
        let entry = v5_existing_entry(
            "JPEG-APP1-IFD0",
            2,
            Some(0),
            "IFD0",
            MetadataValue::Integer(300),
        );
        let mut data = MetadataDraftEditsV5::new();
        data.insert("folder/photo.jpg".to_owned(), vec![entry.clone()]);

        save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap();

        assert_eq!(loaded, data);
        let line: serde_json::Value =
            serde_json::from_str(read_file(dir.path(), V5_FILE_NAME).lines().nth(1).unwrap())
                .unwrap();
        assert_eq!(line["relative_path"], "folder/photo.jpg");
        assert!(line["edits"][0]["target"].get("relative_path").is_none());
        assert_eq!(loaded["folder/photo.jpg"][0], entry);
    }

    #[test]
    fn v5_new_property_target_round_trips() {
        let dir = tempdir().unwrap();
        let mut data = MetadataDraftEditsV5::new();
        data.insert(
            "photo.jpg".to_owned(),
            vec![v5_new_entry(Some(0), MetadataValue::Text("new".to_owned()))],
        );

        save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &data).unwrap();
        assert_eq!(
            load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap(),
            data
        );
    }

    #[test]
    fn v5_mixed_targets_and_nested_semantic_values_round_trip_exactly() {
        let dir = tempdir().unwrap();
        let nested = MetadataValue::Struct(BTreeMap::from([
            ("name".to_owned(), MetadataValue::Text("value".to_owned())),
            (
                "items".to_owned(),
                MetadataValue::List {
                    list_kind: ListKind::Seq,
                    items: vec![MetadataValue::Integer(1), MetadataValue::Bool(true)],
                },
            ),
        ]));
        let entries = vec![
            v5_existing_entry("IFD0", 0, None, "IFD0", nested),
            v5_new_entry(Some(3), MetadataValue::Null),
        ];
        let mut data = MetadataDraftEditsV5::new();
        data.insert("photo.jpg".to_owned(), entries);

        save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &data).unwrap();
        assert_eq!(
            load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap(),
            data
        );
    }

    #[test]
    fn v5_two_existing_occurrences_sharing_one_schema_are_accepted() {
        let dir = tempdir().unwrap();
        let entries = vec![
            v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1)),
            v5_existing_entry("IFD1", 0, None, "IFD1", MetadataValue::Integer(2)),
        ];
        let mut data = MetadataDraftEditsV5::new();
        data.insert("photo.jpg".to_owned(), entries);

        save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &data).unwrap();
        assert_eq!(
            load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap()["photo.jpg"].len(),
            2
        );
    }

    #[test]
    fn v5_duplicate_identical_existing_slot_is_rejected() {
        let dir = tempdir().unwrap();
        let entry = v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1));
        write_v5_line(
            dir.path(),
            &V5Line {
                schema_version: 5,
                relative_path: "photo.jpg".to_owned(),
                edits: vec![entry.clone(), entry],
            },
        );

        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("Duplicate metadata draft slot"), "{error}");
    }

    #[test]
    fn v5_duplicate_existing_slot_with_changed_schema_snapshot_is_rejected() {
        let dir = tempdir().unwrap();
        let first = v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1));
        let mut second = first.clone();
        if let MetadataDraftTarget::ExistingOccurrence { schema_id, .. } = &mut second.target {
            schema_id.index = Some(9);
        }
        write_v5_line(
            dir.path(),
            &V5Line {
                schema_version: 5,
                relative_path: "photo.jpg".to_owned(),
                edits: vec![first, second],
            },
        );

        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("Duplicate metadata draft slot"), "{error}");
    }

    #[test]
    fn v5_duplicate_existing_slot_with_changed_selector_snapshot_is_rejected() {
        let dir = tempdir().unwrap();
        let first = v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1));
        let mut second = first.clone();
        if let MetadataDraftTarget::ExistingOccurrence { write_target, .. } = &mut second.target {
            write_target.group1 = "IFD1".to_owned();
        }
        write_v5_line(
            dir.path(),
            &V5Line {
                schema_version: 5,
                relative_path: "photo.jpg".to_owned(),
                edits: vec![first, second],
            },
        );

        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("Duplicate metadata draft slot"), "{error}");
    }

    #[test]
    fn v5_duplicate_new_property_schema_is_rejected() {
        let dir = tempdir().unwrap();
        let first = v5_new_entry(None, MetadataValue::Text("a".to_owned()));
        let second = v5_new_entry(None, MetadataValue::Text("b".to_owned()));
        write_v5_line(
            dir.path(),
            &V5Line {
                schema_version: 5,
                relative_path: "photo.jpg".to_owned(),
                edits: vec![first, second],
            },
        );

        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("Duplicate metadata draft slot"), "{error}");
    }

    #[test]
    fn v5_existing_and_new_targets_with_same_schema_are_accepted() {
        let dir = tempdir().unwrap();
        let mut data = MetadataDraftEditsV5::new();
        data.insert(
            "photo.jpg".to_owned(),
            vec![
                v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1)),
                v5_new_entry(None, MetadataValue::Integer(2)),
            ],
        );

        save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &data).unwrap();
        assert_eq!(
            load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap()["photo.jpg"].len(),
            2
        );
    }

    #[test]
    fn v5_duplicate_relative_path_lines_are_rejected() {
        let dir = tempdir().unwrap();
        let line = serde_json::to_string(&V5Line {
            schema_version: 5,
            relative_path: "photo.jpg".to_owned(),
            edits: vec![],
        })
        .unwrap();
        write_file(dir.path(), V5_FILE_NAME, &format!("{line}\n{line}\n"));

        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("on line 2; first seen on line 1"), "{error}");
    }

    #[test]
    fn v5_malformed_json_reports_the_line_number() {
        let dir = tempdir().unwrap();
        write_file(dir.path(), V5_FILE_NAME, "// comment\n\n{not json}\n");
        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("Invalid draft line 3"), "{error}");
    }

    #[test]
    fn v5_blank_comments_and_empty_edit_vectors_are_ignored_or_omitted() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            V5_FILE_NAME,
            "// comment\n\n{\"schema_version\":5,\"relative_path\":\"empty.jpg\",\"edits\":[]}\n",
        );
        assert!(load_metadata_draft_edits_v5(dir.path().to_str().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn v5_loader_leaves_valid_v4_file_for_the_v4_loader() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            V4_FILE_NAME,
            "{\"schema_version\":4,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let original = fs::read(dir.path().join(V4_FILE_NAME)).unwrap();

        assert!(load_metadata_draft_edits_v5(dir.path().to_str().unwrap())
            .unwrap()
            .is_empty());
        assert_eq!(fs::read(dir.path().join(V4_FILE_NAME)).unwrap(), original);
        assert!(!dir.path().join(V5_FILE_NAME).exists());
        assert!(load_metadata_draft_edits(dir.path().to_str().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn v5_loader_rejects_v1_through_v3_and_unversioned_input() {
        for version in 1..=3 {
            let dir = tempdir().unwrap();
            write_file(
                dir.path(),
                V5_FILE_NAME,
                &format!(
                    "{{\"schema_version\":{version},\"relative_path\":\"photo.jpg\",\"edits\":[]}}\n"
                ),
            );
            let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
            assert!(error.contains("Unsupported legacy"), "{error}");
        }

        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            V5_FILE_NAME,
            "{\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("no schema_version"), "{error}");
    }

    #[test]
    fn v5_loader_rejects_version_six_as_future() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            V5_FILE_NAME,
            "{\"schema_version\":6,\"relative_path\":\"photo.jpg\",\"edits\":[]}\n",
        );
        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
        assert!(error.contains("Unsupported future"), "{error}");
        assert!(error.contains("schema_version 6"), "{error}");
    }

    #[test]
    fn v5_serialization_is_deterministic_without_mutating_source_collections() {
        let dir = tempdir().unwrap();
        let a = v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1));
        let b = v5_new_entry(Some(2), MetadataValue::Text("b".to_owned()));
        let mut first = MetadataDraftEditsV5::new();
        first.insert("z.jpg".to_owned(), vec![b.clone(), a.clone()]);
        first.insert(
            "a.jpg".to_owned(),
            vec![v5_new_entry(None, MetadataValue::Null)],
        );
        let before = first.clone();

        save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &first).unwrap();
        let first_bytes = fs::read(dir.path().join(V5_FILE_NAME)).unwrap();
        assert_eq!(first, before);

        let mut second = MetadataDraftEditsV5::new();
        second.insert("a.jpg".to_owned(), before["a.jpg"].clone());
        second.insert("z.jpg".to_owned(), vec![a, b]);
        save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &second).unwrap();
        let second_bytes = fs::read(dir.path().join(V5_FILE_NAME)).unwrap();

        assert_eq!(first_bytes, second_bytes);
    }

    #[test]
    fn v5_duplicate_validation_occurs_before_truncation() {
        let dir = tempdir().unwrap();
        let original = b"existing v4 or v5 bytes must survive\n";
        fs::write(dir.path().join(V5_FILE_NAME), original).unwrap();
        let entry = v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1));
        let mut invalid = MetadataDraftEditsV5::new();
        invalid.insert("photo.jpg".to_owned(), vec![entry.clone(), entry]);

        let error =
            save_metadata_draft_edits_v5(dir.path().to_str().unwrap(), &invalid).unwrap_err();
        assert!(error.contains("Duplicate metadata draft slot"), "{error}");
        assert_eq!(fs::read(dir.path().join(V5_FILE_NAME)).unwrap(), original);
    }

    #[test]
    fn v4_and_v5_files_coexist_and_mutations_preserve_other_bytes() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let shared_path = "__proto__".to_owned();
        let v4_entry = make_entry(
            "XMP::dc",
            "title",
            Some(0),
            MetadataValue::Text("legacy".to_owned()),
            Some("Legacy title"),
        );
        let v5_entry = v5_existing_entry(
            "JPEG-APP1-IFD0",
            2,
            Some(0),
            "IFD0",
            MetadataValue::Struct(BTreeMap::from([(
                "nested".to_owned(),
                MetadataValue::List {
                    list_kind: ListKind::Seq,
                    items: vec![MetadataValue::Text("target".to_owned())],
                },
            )])),
        );
        let v4 = MetadataDraftEdits::from([(shared_path.clone(), vec![v4_entry])]);
        let v5 = MetadataDraftEditsV5::from([(shared_path.clone(), vec![v5_entry])]);

        save_metadata_draft_edits(folder, &v4).unwrap();
        save_metadata_draft_edits_v5(folder, &v5).unwrap();
        assert!(dir.path().join(V4_FILE_NAME).is_file());
        assert!(dir.path().join(V5_FILE_NAME).is_file());
        assert_eq!(load_metadata_draft_edits(folder).unwrap(), v4);
        assert_eq!(load_metadata_draft_edits_v5(folder).unwrap(), v5);

        let v5_bytes = fs::read(dir.path().join(V5_FILE_NAME)).unwrap();
        save_metadata_draft_edits(folder, &MetadataDraftEdits::new()).unwrap();
        assert_eq!(fs::read(dir.path().join(V5_FILE_NAME)).unwrap(), v5_bytes);
        assert!(load_metadata_draft_edits(folder).unwrap().is_empty());
        assert_eq!(load_metadata_draft_edits_v5(folder).unwrap(), v5);

        save_metadata_draft_edits(folder, &v4).unwrap();
        let v4_bytes = fs::read(dir.path().join(V4_FILE_NAME)).unwrap();
        save_metadata_draft_edits_v5(folder, &MetadataDraftEditsV5::new()).unwrap();
        assert_eq!(fs::read(dir.path().join(V4_FILE_NAME)).unwrap(), v4_bytes);
        assert_eq!(load_metadata_draft_edits(folder).unwrap(), v4);
        assert!(load_metadata_draft_edits_v5(folder).unwrap().is_empty());
    }

    #[test]
    fn failed_cross_file_saves_leave_the_other_persistence_untouched() {
        let v5_dir = tempdir().unwrap();
        let v5_folder = v5_dir.path().to_str().unwrap();
        let v5 = MetadataDraftEditsV5::from([(
            "pending.jpg".to_owned(),
            vec![v5_new_entry(
                None,
                MetadataValue::Text("pending".to_owned()),
            )],
        )]);
        save_metadata_draft_edits_v5(v5_folder, &v5).unwrap();
        let v5_bytes = fs::read(v5_dir.path().join(V5_FILE_NAME)).unwrap();
        fs::create_dir(v5_dir.path().join(V4_FILE_NAME)).unwrap();
        assert!(save_metadata_draft_edits(v5_folder, &MetadataDraftEdits::new()).is_err());
        assert_eq!(
            fs::read(v5_dir.path().join(V5_FILE_NAME)).unwrap(),
            v5_bytes
        );

        let v4_dir = tempdir().unwrap();
        let v4_folder = v4_dir.path().to_str().unwrap();
        let v4 = MetadataDraftEdits::from([(
            "pending.jpg".to_owned(),
            vec![make_entry(
                "XMP::dc",
                "title",
                None,
                MetadataValue::Text("pending".to_owned()),
                None,
            )],
        )]);
        save_metadata_draft_edits(v4_folder, &v4).unwrap();
        let v4_bytes = fs::read(v4_dir.path().join(V4_FILE_NAME)).unwrap();
        fs::create_dir(v4_dir.path().join(V5_FILE_NAME)).unwrap();
        assert!(save_metadata_draft_edits_v5(v4_folder, &MetadataDraftEditsV5::new()).is_err());
        assert_eq!(
            fs::read(v4_dir.path().join(V4_FILE_NAME)).unwrap(),
            v4_bytes
        );
    }

    #[test]
    fn valid_misplaced_v5_file_is_validated_then_renamed_without_rewriting() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let drafts = MetadataDraftEditsV5::from([(
            "__proto__".to_owned(),
            vec![v5_existing_entry(
                "JPEG-APP1-IFD0/SubIFD",
                7,
                Some(3),
                "SubIFD",
                MetadataValue::Struct(BTreeMap::from([(
                    "nested".to_owned(),
                    MetadataValue::List {
                        list_kind: ListKind::Bag,
                        items: vec![MetadataValue::Integer(4), MetadataValue::Bool(true)],
                    },
                )])),
            )],
        )]);
        save_metadata_draft_edits_v5(folder, &drafts).unwrap();
        fs::rename(dir.path().join(V5_FILE_NAME), dir.path().join(V4_FILE_NAME)).unwrap();
        let original = fs::read(dir.path().join(V4_FILE_NAME)).unwrap();

        assert_eq!(load_metadata_draft_edits_v5(folder).unwrap(), drafts);
        assert!(!dir.path().join(V4_FILE_NAME).exists());
        assert_eq!(fs::read(dir.path().join(V5_FILE_NAME)).unwrap(), original);
        assert!(load_metadata_draft_edits(folder).unwrap().is_empty());
    }

    #[test]
    fn misplaced_v5_rename_failure_leaves_original_file_intact() {
        let dir = tempdir().unwrap();
        let entry = v5_new_entry(None, MetadataValue::Text("pending".to_owned()));
        let contents = format!(
            "{}\n",
            serde_json::to_string(&V5Line {
                schema_version: 5,
                relative_path: "photo.jpg".to_owned(),
                edits: vec![entry],
            })
            .unwrap()
        );
        let old_path = dir.path().join(V4_FILE_NAME);
        write_file(dir.path(), V4_FILE_NAME, &contents);
        let original = fs::read(&old_path).unwrap();
        let target_path = dir.path().join("missing-parent").join(V5_FILE_NAME);

        let error = migrate_misplaced_v5_file(&old_path, &target_path).unwrap_err();

        assert!(error.contains("could not rename"), "{error}");
        assert_eq!(fs::read(&old_path).unwrap(), original);
        assert!(!target_path.exists());
    }

    #[test]
    fn ambiguous_or_invalid_old_shared_files_are_rejected_without_mutation() {
        let cases = [
            concat!(
                "{\"schema_version\":4,\"relative_path\":\"v4.jpg\",\"edits\":[]}\n",
                "{\"schema_version\":5,\"relative_path\":\"v5.jpg\",\"edits\":[]}\n"
            ),
            "{\"schema_version\":5,\"relative_path\":\"broken.jpg\",\"edits\":[}\n",
            concat!(
                "{\"schema_version\":5,\"relative_path\":\"same.jpg\",\"edits\":[]}\n",
                "{\"schema_version\":5,\"relative_path\":\"same.jpg\",\"edits\":[]}\n"
            ),
            "{\"relative_path\":\"legacy.jpg\",\"edits\":[]}\n",
            concat!(
                "{\"schema_version\":5,\"relative_path\":\"v5.jpg\",\"edits\":[]}\n",
                "{\"schema_version\":6,\"relative_path\":\"future.jpg\",\"edits\":[]}\n"
            ),
        ];

        for contents in cases {
            let dir = tempdir().unwrap();
            write_file(dir.path(), V4_FILE_NAME, contents);
            let original = fs::read(dir.path().join(V4_FILE_NAME)).unwrap();
            let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();
            assert!(
                error.contains("Old shared draft file cannot be safely classified or migrated"),
                "{error}"
            );
            assert_eq!(fs::read(dir.path().join(V4_FILE_NAME)).unwrap(), original);
            assert!(!dir.path().join(V5_FILE_NAME).exists());
        }
    }

    #[test]
    fn duplicate_slots_in_misplaced_v5_file_reject_without_mutation() {
        let dir = tempdir().unwrap();
        let entry = v5_existing_entry("IFD0", 0, None, "IFD0", MetadataValue::Integer(1));
        let contents = format!(
            "{}\n",
            serde_json::to_string(&V5Line {
                schema_version: 5,
                relative_path: "same.jpg".to_owned(),
                edits: vec![entry.clone(), entry],
            })
            .unwrap()
        );
        write_file(dir.path(), V4_FILE_NAME, &contents);
        let original = fs::read(dir.path().join(V4_FILE_NAME)).unwrap();

        let error = load_metadata_draft_edits_v5(dir.path().to_str().unwrap()).unwrap_err();

        assert!(error.contains("cannot be safely classified or migrated"));
        assert!(error.contains("Duplicate metadata draft slot"));
        assert_eq!(fs::read(dir.path().join(V4_FILE_NAME)).unwrap(), original);
        assert!(!dir.path().join(V5_FILE_NAME).exists());
    }

    #[test]
    fn existing_v5_file_is_strict_and_never_consults_old_path() {
        let dir = tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        let expected = MetadataDraftEditsV5::from([(
            "new.jpg".to_owned(),
            vec![v5_new_entry(None, MetadataValue::Integer(5))],
        )]);
        save_metadata_draft_edits_v5(folder, &expected).unwrap();
        let old = b"misplaced target bytes that must not be consulted\n";
        fs::write(dir.path().join(V4_FILE_NAME), old).unwrap();

        assert_eq!(load_metadata_draft_edits_v5(folder).unwrap(), expected);
        assert_eq!(fs::read(dir.path().join(V4_FILE_NAME)).unwrap(), old);
    }

    #[test]
    fn empty_or_comment_only_old_file_is_not_a_migration_candidate() {
        for contents in ["", "// comment\n\n"] {
            let dir = tempdir().unwrap();
            write_file(dir.path(), V4_FILE_NAME, contents);
            let original = fs::read(dir.path().join(V4_FILE_NAME)).unwrap();
            assert!(load_metadata_draft_edits_v5(dir.path().to_str().unwrap())
                .unwrap()
                .is_empty());
            assert_eq!(fs::read(dir.path().join(V4_FILE_NAME)).unwrap(), original);
            assert!(!dir.path().join(V5_FILE_NAME).exists());
        }
    }

    #[test]
    fn generated_typescript_v5_entry_preserves_target_and_edit() {
        use ts_rs::TS;

        let declaration = MetadataDraftEntryV5::decl();
        assert!(
            declaration.contains("target: MetadataDraftTarget"),
            "{declaration}"
        );
        assert!(
            declaration.contains("edit: MetadataDraftEdit"),
            "{declaration}"
        );
    }
}
