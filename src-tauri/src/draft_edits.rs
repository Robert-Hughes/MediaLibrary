//! Draft-edit persistence with versioned JSONL schema.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §7.
//!
//! On-disk format is JSONL.  Two schema versions exist:
//!
//! - **v1**: `{ "relative_path": "...", "edits": { "TAG": "value" | null } }`
//!   Values are strings only.  `null` means "delete the tag".
//!
//! - **v2**: `{ "schema_version": 2, "relative_path": "...", "edits":
//!   { "TAG": { "value": <Variant | null>, "intent": "Set" | "Delete" |
//!   "ListAdd" | "ListRemove" } } }`
//!   Values carry full Variant type and an explicit intent.
//!
//! Loading: each line is decoded by inspecting `schema_version`.  Absence
//! defaults to v1 (legacy lines).  Mixed-version files are supported.
//!
//! Saving: always writes v2.  If a v1 file is loaded and then saved, the
//! original is first copied to `MediaLibraryDraftEdits.v1.bak.jsonl` so the
//! user has a recovery point.
//!
//! Public API: the legacy string-only `DraftEditsPayload` shape is retained
//! for backward compatibility with the existing frontend and Tauri commands.
//! Internally, persistence uses the typed `TypedDraftEdits`.  See
//! `from_legacy` / `to_legacy` for the boundary conversions.  The frontend
//! migrates to the typed shape in a follow-up phase.

use crate::metadata_value::MetadataValue;
use crate::scanner::Variant;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

// ── Legacy public API (string-only) ──────────────────────────────────────────

pub type DraftEditsPayload = HashMap<String, HashMap<String, Option<String>>>;

// ── v2 typed model ───────────────────────────────────────────────────────────

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
pub struct DraftEdit {
    pub value: Option<Variant>,
    pub intent: EditIntent,
    /// Optional pretty-printed form of `value`, computed by the editor that
    /// produced this draft (enum label, rational fraction, GPS DMS, …).
    /// When present, the UI prefers this over a generic `String(value)` for
    /// the "pending change" cell.  Persisted to JSONL so restored drafts
    /// keep their pretty form across app restarts.  See
    /// METADATA_FORMATS_DESIGN.md §display-roundtrip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub display: Option<String>,
}

impl DraftEdit {
    /// Construct from a legacy string edit (`None` → delete, `Some(s)` → set).
    pub fn from_legacy_string(v: Option<String>) -> Self {
        match v {
            None => DraftEdit {
                value: None,
                intent: EditIntent::Delete,
                display: None,
            },
            Some(s) => DraftEdit {
                value: Some(Variant::String(s)),
                intent: EditIntent::Set,
                display: None,
            },
        }
    }

    /// Best-effort conversion back to a legacy string edit for the
    /// transitional Tauri boundary.  Non-string Variants are stringified
    /// using the same `to_string`-style representation the previous code
    /// used for non-strings (an explicit information-loss point that the
    /// frontend migration in a later phase removes).
    pub fn to_legacy_string(&self) -> Option<String> {
        match &self.intent {
            EditIntent::Delete => None,
            _ => Some(variant_to_display(self.value.as_ref())),
        }
    }
}

fn variant_to_display(v: Option<&Variant>) -> String {
    match v {
        None => String::new(),
        Some(Variant::String(s)) => s.clone(),
        Some(Variant::Null) => String::new(),
        Some(Variant::Bool(b)) => b.to_string(),
        Some(Variant::Integer(n)) => n.to_string(),
        Some(Variant::Float(f)) => f.to_string(),
        Some(Variant::List(items)) => items
            .iter()
            .map(|i| variant_to_display(Some(i)))
            .collect::<Vec<_>>()
            .join(", "),
        Some(Variant::Object(m)) => serde_json::to_string(m).unwrap_or_default(),
    }
}

pub type TypedDraftEdits = HashMap<String, HashMap<String, DraftEdit>>;

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

impl MetadataDraftEdit {
    pub fn from_legacy_draft(edit: &DraftEdit) -> Self {
        MetadataDraftEdit {
            value: edit.value.as_ref().map(metadata_value_from_variant),
            intent: edit.intent.clone(),
            display: edit.display.clone(),
        }
    }
}

fn metadata_value_from_variant(value: &Variant) -> MetadataValue {
    match value {
        Variant::Null => MetadataValue::Null,
        Variant::String(s) => MetadataValue::Text(s.clone()),
        Variant::Bool(b) => MetadataValue::Bool(*b),
        Variant::Integer(n) => MetadataValue::Integer(*n),
        Variant::Float(f) => MetadataValue::Real(*f),
        Variant::List(items) => MetadataValue::List {
            list_kind: crate::metadata_value::ListKind::Unknown,
            items: items.iter().map(metadata_value_from_variant).collect(),
        },
        Variant::Object(map) => MetadataValue::Struct(
            map.iter()
                .map(|(key, value)| (key.clone(), metadata_value_from_variant(value)))
                .collect::<BTreeMap<_, _>>(),
        ),
    }
}

pub type MetadataDraftEdits = HashMap<String, HashMap<String, MetadataDraftEdit>>;

// ── On-disk schemas ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct V1Line {
    relative_path: String,
    edits: HashMap<String, Option<String>>,
}

#[derive(Serialize, Deserialize)]
struct V2Line {
    schema_version: u32,
    relative_path: String,
    edits: HashMap<String, DraftEdit>,
}

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
const V1_BACKUP_NAME: &str = "MediaLibraryDraftEdits.v1.bak.jsonl";
const HEADER_COMMENT: &str =
    "// This file stores unapplied metadata draft edits. Lines starting with // are ignored.";

// ── Public legacy-shape API (current callers) ────────────────────────────────

pub fn load_draft_edits(folder_path: &str) -> Result<DraftEditsPayload, String> {
    let typed = load_typed_draft_edits(folder_path)?;
    Ok(typed
        .into_iter()
        .map(|(path, edits)| {
            (
                path,
                edits
                    .into_iter()
                    .map(|(k, e)| (k, e.to_legacy_string()))
                    .collect(),
            )
        })
        .collect())
}

pub fn save_draft_edits(folder_path: &str, data: DraftEditsPayload) -> Result<(), String> {
    let typed: TypedDraftEdits = data
        .into_iter()
        .map(|(path, edits)| {
            (
                path,
                edits
                    .into_iter()
                    .map(|(k, v)| (k, DraftEdit::from_legacy_string(v)))
                    .collect(),
            )
        })
        .collect();
    save_typed_draft_edits(folder_path, &typed)
}

// ── Typed API (Phase 3+) ─────────────────────────────────────────────────────

pub fn load_typed_draft_edits(folder_path: &str) -> Result<TypedDraftEdits, String> {
    let path = Path::new(folder_path).join(FILE_NAME);
    let mut typed: TypedDraftEdits = HashMap::new();

    if !path.exists() {
        return Ok(typed);
    }

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut saw_v1 = false;

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }

        let version = serde_json::from_str::<VersionProbe>(trimmed)
            .ok()
            .and_then(|p| p.schema_version)
            .unwrap_or(1);

        match version {
            2 => match serde_json::from_str::<V2Line>(trimmed) {
                Ok(parsed) => {
                    typed.insert(parsed.relative_path, parsed.edits);
                }
                Err(e) => log::warn!("[draft_edits] Skipping v2 line ({}): {}", e, trimmed),
            },
            _ => match serde_json::from_str::<V1Line>(trimmed) {
                Ok(parsed) => {
                    saw_v1 = true;
                    let migrated: HashMap<String, DraftEdit> = parsed
                        .edits
                        .into_iter()
                        .map(|(k, v)| (k, DraftEdit::from_legacy_string(v)))
                        .collect();
                    typed.insert(parsed.relative_path, migrated);
                }
                Err(e) => log::warn!(
                    "[draft_edits] Skipping unparseable line ({}): {}",
                    e,
                    trimmed
                ),
            },
        }
    }

    if saw_v1 {
        // Migration occurred.  Snapshot the original file once so the user
        // has a recovery point before the next save rewrites it as v2.
        let backup = Path::new(folder_path).join(V1_BACKUP_NAME);
        if !backup.exists() {
            if let Err(e) = fs::copy(&path, &backup) {
                log::warn!(
                    "[draft_edits] Could not write v1 backup ({}): {}",
                    backup.display(),
                    e
                );
            } else {
                log::info!(
                    "[draft_edits] v1 draft file detected; backup written to {}",
                    backup.display()
                );
            }
        }
    }

    Ok(typed)
}

pub fn save_typed_draft_edits(folder_path: &str, data: &TypedDraftEdits) -> Result<(), String> {
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
        let line = V2Line {
            schema_version: 2,
            relative_path: relative_path.clone(),
            edits: edits.clone(),
        };
        let json_line = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        writeln!(file, "{}", json_line).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn load_metadata_draft_edits(folder_path: &str) -> Result<MetadataDraftEdits, String> {
    let path = Path::new(folder_path).join(FILE_NAME);
    let mut typed: MetadataDraftEdits = HashMap::new();

    if !path.exists() {
        return Ok(typed);
    }

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }

        let version = serde_json::from_str::<VersionProbe>(trimmed)
            .ok()
            .and_then(|p| p.schema_version)
            .unwrap_or(1);

        match version {
            3 => {
                let parsed = serde_json::from_str::<V3Line>(trimmed)
                    .map_err(|e| format!("Invalid v3 draft line: {e}"))?;
                typed.insert(parsed.relative_path, parsed.edits);
            }
            other => {
                return Err(format!(
                    "Unsupported draft schema_version {other}; recreate draft edits in the current app"
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
        let result = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn v1_string_value_migrates_to_set_intent() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "// header\n{\"relative_path\":\"a.jpg\",\"edits\":{\"XMP-dc:Description\":\"hello\"}}\n",
        );
        let result = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        let edit = &result["a.jpg"]["XMP-dc:Description"];
        assert_eq!(edit.intent, EditIntent::Set);
        assert_eq!(edit.value, Some(Variant::String("hello".to_string())));
    }

    #[test]
    fn v1_null_value_migrates_to_delete_intent() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"relative_path\":\"a.jpg\",\"edits\":{\"XMP-dc:Description\":null}}\n",
        );
        let result = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        let edit = &result["a.jpg"]["XMP-dc:Description"];
        assert_eq!(edit.intent, EditIntent::Delete);
        assert_eq!(edit.value, None);
    }

    #[test]
    fn loading_v1_file_creates_backup() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"relative_path\":\"a.jpg\",\"edits\":{\"k\":\"v\"}}\n",
        );
        let _ = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert!(
            dir.path().join(V1_BACKUP_NAME).exists(),
            "v1 backup should have been written"
        );
    }

    #[test]
    fn backup_is_not_overwritten_on_second_load() {
        let dir = tempdir().unwrap();
        // Pre-existing backup with sentinel content
        write_file(dir.path(), V1_BACKUP_NAME, "existing-backup-do-not-touch");
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"relative_path\":\"a.jpg\",\"edits\":{\"k\":\"v\"}}\n",
        );
        let _ = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        let backup_contents = read_file(dir.path(), V1_BACKUP_NAME);
        assert_eq!(backup_contents, "existing-backup-do-not-touch");
    }

    #[test]
    fn v2_roundtrip() {
        let dir = tempdir().unwrap();
        let mut data: TypedDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "XMP-dc:Subject".to_string(),
            DraftEdit {
                value: Some(Variant::List(vec![
                    Variant::String("beach".to_string()),
                    Variant::String("sunset".to_string()),
                ])),
                intent: EditIntent::Set,
                display: Some("beach, sunset".to_string()),
            },
        );
        edits.insert(
            "Rating".to_string(),
            DraftEdit {
                value: Some(Variant::Integer(5)),
                intent: EditIntent::Set,
                display: None,
            },
        );
        edits.insert(
            "ToRemove".to_string(),
            DraftEdit {
                value: None,
                intent: EditIntent::Delete,
                display: None,
            },
        );
        data.insert("a.jpg".to_string(), edits);

        save_typed_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn mixed_v1_and_v2_lines_both_load() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "{\"relative_path\":\"v1.jpg\",\"edits\":{\"k\":\"v\"}}\n",
                "{\"schema_version\":2,\"relative_path\":\"v2.jpg\",\"edits\":",
                "{\"k\":{\"value\":42,\"intent\":\"Set\"}}}\n",
            ),
        );
        let loaded = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded["v1.jpg"]["k"].intent, EditIntent::Set);
        assert_eq!(
            loaded["v1.jpg"]["k"].value,
            Some(Variant::String("v".to_string()))
        );
        assert_eq!(loaded["v2.jpg"]["k"].intent, EditIntent::Set);
        assert_eq!(loaded["v2.jpg"]["k"].value, Some(Variant::Integer(42)));
    }

    #[test]
    fn corrupt_line_is_skipped_others_kept() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            concat!(
                "{\"relative_path\":\"good.jpg\",\"edits\":{\"k\":\"v\"}}\n",
                "this is not json\n",
                "{\"relative_path\":\"good2.jpg\",\"edits\":{\"k\":\"v2\"}}\n",
            ),
        );
        let loaded = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains_key("good.jpg"));
        assert!(loaded.contains_key("good2.jpg"));
    }

    #[test]
    fn save_then_load_via_legacy_api() {
        let dir = tempdir().unwrap();
        let mut data: DraftEditsPayload = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert("XMP-dc:Description".to_string(), Some("hello".to_string()));
        edits.insert("ToRemove".to_string(), None);
        data.insert("a.jpg".to_string(), edits);

        save_draft_edits(dir.path().to_str().unwrap(), data.clone()).unwrap();
        let loaded = load_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn empty_edits_omitted_from_output() {
        let dir = tempdir().unwrap();
        let mut data: TypedDraftEdits = HashMap::new();
        data.insert("empty.jpg".to_string(), HashMap::new());
        save_typed_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
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
                "{\"relative_path\":\"a.jpg\",\"edits\":{\"k\":\"v\"}}\n",
            ),
        );
        let loaded = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn display_field_is_persisted_and_restored() {
        let dir = tempdir().unwrap();
        let mut data: TypedDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "EXIF:Orientation".to_string(),
            DraftEdit {
                value: Some(Variant::Integer(6)),
                intent: EditIntent::Set,
                display: Some("Rotate 90 CW".to_string()),
            },
        );
        data.insert("a.jpg".to_string(), edits);
        save_typed_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
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
        // field — keeps the on-disk shape minimal and v1-style files
        // round-trip without growing.
        let dir = tempdir().unwrap();
        let mut data: TypedDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "Rating".to_string(),
            DraftEdit {
                value: Some(Variant::Integer(5)),
                intent: EditIntent::Set,
                display: None,
            },
        );
        data.insert("a.jpg".to_string(), edits);
        save_typed_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let contents = read_file(dir.path(), FILE_NAME);
        assert!(
            !contents.contains("\"display\""),
            "display key leaked when None: {}",
            contents
        );
    }

    #[test]
    fn legacy_v1_load_has_no_display() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"relative_path\":\"a.jpg\",\"edits\":{\"k\":\"v\"}}\n",
        );
        let loaded = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded["a.jpg"]["k"].display, None);
    }

    #[test]
    fn idempotent_v2_load_save_load() {
        let dir = tempdir().unwrap();
        let mut data: TypedDraftEdits = HashMap::new();
        let mut edits = HashMap::new();
        edits.insert(
            "k".to_string(),
            DraftEdit {
                value: Some(Variant::Bool(true)),
                intent: EditIntent::Set,
                display: None,
            },
        );
        data.insert("a.jpg".to_string(), edits);
        save_typed_draft_edits(dir.path().to_str().unwrap(), &data).unwrap();
        let loaded1 = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
        save_typed_draft_edits(dir.path().to_str().unwrap(), &loaded1).unwrap();
        let loaded2 = load_typed_draft_edits(dir.path().to_str().unwrap()).unwrap();
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
    fn metadata_draft_from_legacy_preserves_semantic_shape() {
        let edit = DraftEdit {
            value: Some(Variant::List(vec![
                Variant::String("beach".to_string()),
                Variant::Integer(7),
            ])),
            intent: EditIntent::Set,
            display: Some("beach, 7".to_string()),
        };

        let converted = MetadataDraftEdit::from_legacy_draft(&edit);

        assert_eq!(converted.intent, EditIntent::Set);
        assert_eq!(converted.display.as_deref(), Some("beach, 7"));
        assert_eq!(
            converted.value,
            Some(MetadataValue::List {
                list_kind: crate::metadata_value::ListKind::Unknown,
                items: vec![
                    MetadataValue::Text("beach".to_string()),
                    MetadataValue::Integer(7),
                ],
            })
        );
    }

    #[test]
    fn metadata_draft_from_legacy_preserves_nested_structs() {
        let mut obj = BTreeMap::new();
        obj.insert("Name".to_string(), Variant::String("Alice".to_string()));
        obj.insert("Score".to_string(), Variant::Float(1.5));
        let edit = DraftEdit {
            value: Some(Variant::Object(obj)),
            intent: EditIntent::Set,
            display: None,
        };

        let converted = MetadataDraftEdit::from_legacy_draft(&edit);
        let Some(MetadataValue::Struct(fields)) = converted.value else {
            panic!("expected struct value");
        };
        assert_eq!(fields["Name"], MetadataValue::Text("Alice".to_string()));
        assert_eq!(fields["Score"], MetadataValue::Real(1.5));
    }

    #[test]
    fn v3_loader_rejects_v2_without_migration() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"schema_version\":2,\"relative_path\":\"a.jpg\",\"edits\":{\"k\":{\"value\":\"v\",\"intent\":\"Set\"}}}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("Unsupported draft schema_version 2"), "{err}");
        assert!(err.contains("recreate draft edits"), "{err}");
    }

    #[test]
    fn v3_loader_rejects_v1_without_migration() {
        let dir = tempdir().unwrap();
        write_file(
            dir.path(),
            FILE_NAME,
            "{\"relative_path\":\"a.jpg\",\"edits\":{\"k\":\"v\"}}\n",
        );
        let err = load_metadata_draft_edits(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("Unsupported draft schema_version 1"), "{err}");
    }
}
