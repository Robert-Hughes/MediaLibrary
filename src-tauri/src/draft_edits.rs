//! Draft-edit persistence with versioned JSONL schema.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §7.
//!
//! On-disk format is JSONL. The supported schema is:
//!
//! - **v3**: `{ "schema_version": 3, "relative_path": "...", "edits":
//!   { "TAG": { "value": <MetadataValue | null>, "intent": "Set" | ... } } }`
//!   Values carry semantic metadata types.
//!
//! Loading rejects older v1/v2 lines with a clear error. Old drafts must be
//! recreated so semantic values are never reconstructed from display strings.
//!
//! Saving: the semantic API always writes v3.

use crate::metadata_value::MetadataValue;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

// ── v3 semantic model ────────────────────────────────────────────────────────

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

pub type MetadataDraftEdits = HashMap<String, HashMap<String, MetadataDraftEdit>>;

// ── On-disk schemas ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct V3Line {
    schema_version: u32,
    relative_path: String,
    edits: HashMap<String, MetadataDraftEdit>,
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
            Some(3) => {
                let parsed = serde_json::from_str::<V3Line>(trimmed)
                    .map_err(|e| format!("Invalid v3 draft line {}: {e}", line_no + 1))?;
                typed.insert(parsed.relative_path, parsed.edits);
            }
            Some(old) => {
                return Err(format!(
                    "Unsupported draft edit schema_version {old} on line {}. Recreate pending draft edits with schema_version 3.",
                    line_no + 1
                ));
            }
            None => {
                return Err(format!(
                    "Unsupported legacy draft edit line {} with no schema_version. Recreate pending draft edits with schema_version 3.",
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

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    writeln!(file, "{}", HEADER_COMMENT).map_err(|e| e.to_string())?;

    for (relative_path, edits) in data {
        if edits.is_empty() {
            continue;
        }
        let line = V3Line {
            schema_version: 3,
            relative_path: relative_path.clone(),
            edits: edits.clone(),
        };
        let json_line = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        writeln!(file, "{}", json_line).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_value::{DateValue, MetadataValue, TimeValue};
    use std::fs;
    use tempfile::tempdir;

    fn write_file(folder: &Path, name: &str, contents: &str) {
        fs::write(folder.join(name), contents).unwrap();
    }

    fn read_file(folder: &Path, name: &str) -> String {
        fs::read_to_string(folder.join(name)).unwrap()
    }

    #[test]
    fn load_nonexistent_folder_returns_empty() {
        let dir = tempdir().unwrap();
        let result = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn legacy_line_without_schema_version_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "// header\n{\"relative_path\":\"a.jpg\",\"edits\":{\"XMP-dc:Description\":\"hello\"}}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("Unsupported legacy draft edit line"), "{err}");
        assert!(err.contains("schema_version 3"), "{err}");
    }

    #[test]
    fn v2_line_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":2,\"relative_path\":\"a.jpg\",\"edits\":{\"k\":{\"value\":\"v\",\"intent\":\"Set\"}}}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(
            err.contains("Unsupported draft edit schema_version 2"),
            "{err}"
        );
    }

    #[test]
    fn unknown_schema_version_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":99,\"relative_path\":\"a.jpg\",\"edits\":{}}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("schema_version 99"), "{err}");
    }

    #[test]
    fn corrupt_line_is_rejected() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "{\"schema_version\":3,\"relative_path\":\"good.jpg\",\"edits\":{}}\n",
                "this is not json\n",
            ),
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("Invalid draft line 2"), "{err}");
    }

    #[test]
    fn empty_edits_omitted_from_output() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        data.insert("empty.jpg".to_string(), HashMap::new());
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let contents = read_file(dir.path(), FILE_NAME);
        assert!(!contents.contains("empty.jpg"));
    }

    #[test]
    fn comment_lines_are_ignored() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "// header comment\n",
                "\n",
                "// another comment\n",
                "{\"schema_version\":3,\"relative_path\":\"a.jpg\",\"edits\":{}}\n",
            ),
        );
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn display_field_is_persisted_and_restored() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "EXIF:Orientation".to_string(),
            MetadataDraftEdit {
                value: Some(MetadataValue::Integer(6)),
                intent: EditIntent::Set,
                display: Some("Rotate 90 CW".to_string()),
            },
        );
        data.insert("a.jpg".to_string(), edits);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, data);
        // Sanity: the literal string is in the file.
        let contents = read_file(dir.path(), FILE_NAME);
        assert!(
            contents.contains("Rotate 90 CW"),
            "display field missing from JSONL: {}",
            contents
        );
    }

    #[test]
    fn display_field_omitted_when_none() {
        // Drafts with no display value should not write a `"display":null`
        // field — keeps the on-disk v3 shape minimal.
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "Rating".to_string(),
            MetadataDraftEdit {
                value: Some(MetadataValue::Integer(5)),
                intent: EditIntent::Set,
                display: None,
            },
        );
        data.insert("a.jpg".to_string(), edits);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let contents = read_file(dir.path(), FILE_NAME);
        assert!(
            !contents.contains("\"display\""),
            "display key leaked when None: {}",
            contents
        );
    }

    #[test]
    fn idempotent_v3_load_save_load() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "k".to_string(),
            MetadataDraftEdit {
                value: Some(MetadataValue::Bool(true)),
                intent: EditIntent::Set,
                display: None,
            },
        );
        data.insert("a.jpg".to_string(), edits);
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded1 = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        save_metadata_draft_edits(dir.path().to_str().unwrap(), &loaded1).unwrap();
        let loaded2 = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded1, loaded2);
    }

    #[test]
    fn v3_semantic_draft_roundtrip_stores_metadata_value() {
        let dir = tempdir().unwrap();
        let mut data: MetadataDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "IPTC:TimeCreated".to_string(),
            MetadataDraftEdit {
                value: Some(MetadataValue::Time(TimeValue {
                    hour: 10,
                    minute: 56,
                    second: 5,
                    subsecond: None,
                    offset: None,
                })),
                intent: EditIntent::Set,
                display: Some("10:56:05".to_string()),
            },
        );
        edits.insert(
            "IPTC:DateCreated".to_string(),
            MetadataDraftEdit {
                value: Some(MetadataValue::Date(DateValue {
                    year: 2026,
                    month: 7,
                    day: 4,
                })),
                intent: EditIntent::Set,
                display: None,
            },
        );
        data.insert("a.jpg".to_string(), edits);

        save_metadata_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let contents = read_file(dir.path(), FILE_NAME);
        assert!(contents.contains("\"schema_version\":3"), "{contents}");
        assert!(contents.contains("\"kind\":\"Time\""), "{contents}");
        assert!(contents.contains("\"kind\":\"Date\""), "{contents}");

        let loaded = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn v3_loader_rejects_mixed_legacy_and_semantic_lines() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "{\"relative_path\":\"v1.jpg\",\"edits\":{\"k\":\"v\"}}\n",
                "{\"schema_version\":3,\"relative_path\":\"v3.jpg\",\"edits\":",
                "{\"k\":{\"value\":{\"kind\":\"Bool\",\"value\":true},\"intent\":\"Set\"}}}\n",
            ),
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(
            err.contains("Unsupported legacy draft edit line 1"),
            "{err}"
        );
    }
}
