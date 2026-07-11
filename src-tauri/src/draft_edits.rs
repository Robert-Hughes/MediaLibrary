//! Draft-edit persistence with versioned JSONL schema.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §7.
//!
//! On-disk format is JSONL. The supported schema is:
//!
//! - **v4**: `{ "schema_version": 4, "relative_path": "...", "edits":
//!   [{ "id": { "table": "...", "tag_id": "...", "index": ... }, "edit": { "value": <MetadataValue | null>, "intent": "Set" | ..., "display": ... } }] }`
//!
//! Loading rejects older v1/v2/v3 lines with a clear error. Old drafts must be
//! recreated so semantic values are never reconstructed from display strings.
//!
//! Saving: the semantic API always writes v4.

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

#[derive(Deserialize)]
struct VersionProbe {
    #[serde(default)]
    schema_version: Option<u32>,
}

// ── File names ───────────────────────────────────────────────────────────────

const FILE_NAME: &str = "MediaLibraryDraftEdits.jsonl";
const HEADER_COMMENT: &str =
    "// This file stores unapplied metadata draft edits. Lines starting with // are ignored.";

pub fn load_metadata_draft_edits(folder_path: &str) -> Result<MetadataDraftEdits, String> {
    let path = Path::new(folder_path).join(FILE_NAME);
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
                            "Duplicate tag ID '{}' on line {}",
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
                return Err(format!(
                    "Unsupported draft edit schema_version {old} on line {}. Recreate pending draft edits with schema_version 4 because legacy tag names do not uniquely identify ExifTool definitions.",
                    line_no + 1
                ));
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
    let path = Path::new(folder_path).join(FILE_NAME);

    // Verify duplicate IDs before saving
    for (rel_path, entries) in data {
        let mut seen = HashSet::new();
        for entry in entries {
            if !seen.insert(&entry.id) {
                return Err(format!(
                    "Duplicate tag ID '{}' in save payload for file '{}'",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_value::MetadataValue;
    use std::fs;
    use tempfile::tempdir;

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
            err.contains("Duplicate tag ID 'XMP::dc/title' on line 1"),
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
        assert!(err.contains("Duplicate tag ID 'XMP::dc/title'"), "{err}");
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
}
