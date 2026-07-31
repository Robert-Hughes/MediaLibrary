//! Shared metadata edit semantics and legacy target-aware draft decoding.
//!
//! Production storage is implemented by [`crate::draft_repository`]. The
//! JSONL reader remains solely for one-time migration; its writer and snapshot
//! helpers remain test-only to verify compatibility with the legacy format.

use crate::metadata_draft_target::{MetadataDraftSlot, MetadataDraftTarget};
use crate::metadata_occurrence::{
    family7_group_from_runtime_tag_id, family7_group_from_schema_id, validate_family1_group,
};
use crate::metadata_value::MetadataValue;
use crate::tag_schema::SchemaDefinitionId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
#[cfg(test)]
use std::io::Write;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

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
    photo_path: String,
    edits: Vec<MetadataTargetDraftEntry>,
}

#[derive(Deserialize)]
struct VersionProbe {
    #[serde(default)]
    schema_version: Option<u32>,
}

pub(crate) const TARGET_DRAFT_FILE_NAME: &str = "MediaLibraryTargetDraftEdits.jsonl";
pub(crate) const TARGET_DRAFT_BACKUP_FILE_NAME: &str = "MediaLibraryTargetDraftEdits.backup.jsonl";
#[cfg(test)]
const HEADER_COMMENT: &str =
    "// This file stores unapplied target-aware metadata draft edits. Lines starting with // are ignored.";

/// Guards access to the central target-draft repository.
///
/// MediaLibrary permits one open folder per process and explicitly orders
/// autosave and apply persistence. Concurrent repository access therefore
/// indicates that this ordering contract has been violated; it is not expected
/// contention. Repository operations use `try_lock` and return an error rather
/// than waiting, because waiting would conceal an ordering defect that should
/// instead be diagnosed and fixed.
#[derive(Default)]
pub struct DraftRepositoryState {
    operation: Mutex<()>,
}

impl DraftRepositoryState {
    pub(crate) fn with_operation<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self.operation.try_lock().map_err(|_| {
            "Concurrent central draft repository access detected; MediaLibrary persistence operation ordering is invalid"
                .to_string()
        })?;
        operation()
    }
}

#[cfg(test)]
fn with_repository_guard<T>(
    state: &DraftRepositoryState,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    state.with_operation(operation)
}

pub(crate) fn canonical_root(folder_path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(folder_path)
        .map_err(|error| format!("Could not canonicalise opened folder '{folder_path}': {error}"))
}

pub(crate) fn resolve_photo_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err(format!(
            "Draft path must be relative to the opened folder: '{relative_path}'"
        ));
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Draft path escapes the opened folder: '{relative_path}'"
        ));
    }
    let joined = root.join(relative);
    let resolved = if joined.exists() {
        fs::canonicalize(&joined).map_err(|error| {
            format!("Could not canonicalise draft photo '{relative_path}': {error}")
        })?
    } else {
        // Missing photos remain harmless orphan records. The canonical opened
        // root plus a validated relative path is still a stable identity, and
        // must not prevent unrelated drafts from being saved or discarded.
        joined
    };
    if resolved.strip_prefix(root).is_err() {
        return Err(format!(
            "Draft path escapes the opened folder: '{relative_path}'"
        ));
    }
    Ok(resolved)
}

pub(crate) fn resolve_canonical_photo_path(
    folder_path: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let root = canonical_root(folder_path)?;
    resolve_photo_path(&root, relative_path)
}

pub(crate) fn frontend_relative_path(root: &Path, photo_path: &Path) -> Option<String> {
    photo_path.strip_prefix(root).ok().map(|relative| {
        relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    })
}

pub(crate) fn read_snapshot(
    path: &Path,
) -> Result<HashMap<PathBuf, Vec<MetadataTargetDraftEntry>>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
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
        if version != Some(6) {
            return Err(match version {
                Some(version) if version > 6 => format!(
                    "Unsupported future draft edit schema_version {version} on line {line_number}. This target draft loader only supports schema_version 6."
                ),
                Some(version) => format!("Unsupported target draft edit schema_version {version} on line {line_number}."),
                None => format!("Unsupported target draft edit line {line_number} with no schema_version."),
            });
        }
        let parsed = serde_json::from_str::<TargetDraftLine>(trimmed).map_err(|error| {
            format!("Invalid draft schema version 6 line {line_number}: {error}")
        })?;
        let photo_path = PathBuf::from(&parsed.photo_path);
        if !photo_path.is_absolute() {
            return Err(format!(
                "Draft photo_path must be absolute on line {line_number}"
            ));
        }
        if let Some(first_line) = seen_paths.insert(photo_path.clone(), line_number) {
            return Err(format!(
                "duplicate photo_path {:?} on line {line_number}; first seen on line {first_line}",
                parsed.photo_path
            ));
        }
        validate_slots(&parsed.photo_path, &parsed.edits, Some(line_number))?;
        if !parsed.edits.is_empty() {
            drafts.insert(photo_path, parsed.edits);
        }
    }
    Ok(drafts)
}

#[cfg(test)]
fn write_snapshot(
    app_data_dir: &Path,
    drafts: &HashMap<PathBuf, Vec<MetadataTargetDraftEntry>>,
) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let target = app_data_dir.join(TARGET_DRAFT_FILE_NAME);
    let backup = app_data_dir.join(TARGET_DRAFT_BACKUP_FILE_NAME);
    let mut temporary =
        tempfile::NamedTempFile::new_in(app_data_dir).map_err(|error| error.to_string())?;
    writeln!(temporary, "{HEADER_COMMENT}").map_err(|error| error.to_string())?;
    let mut files: Vec<_> = drafts.iter().collect();
    files.sort_by(|left, right| left.0.cmp(right.0));
    for (photo_path, entries) in files {
        if entries.is_empty() {
            continue;
        }
        let mut sorted = entries.clone();
        sorted.sort_by_key(|entry| entry.target.slot());
        let line = TargetDraftLine {
            schema_version: 6,
            photo_path: photo_path.to_string_lossy().into_owned(),
            edits: sorted,
        };
        writeln!(
            temporary,
            "{}",
            serde_json::to_string(&line).map_err(|error| error.to_string())?
        )
        .map_err(|error| error.to_string())?;
    }
    temporary.flush().map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| error.to_string())?;
    }
    if target.exists() {
        fs::rename(&target, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = temporary.persist(&target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(error.error.to_string());
    }
    Ok(())
}

#[cfg(test)]
pub fn load_metadata_draft_edits(
    app_data_dir: &Path,
    folder_path: &str,
    state: &DraftRepositoryState,
) -> Result<MetadataTargetDraftsByFile, String> {
    with_repository_guard(state, || {
        let root = canonical_root(folder_path)?;
        let central = read_snapshot(&app_data_dir.join(TARGET_DRAFT_FILE_NAME))?;
        Ok(central
            .into_iter()
            .filter_map(|(photo_path, edits)| {
                frontend_relative_path(&root, &photo_path).map(|relative| (relative, edits))
            })
            .collect())
    })
}

#[cfg(test)]
pub fn save_metadata_draft_edits(
    app_data_dir: &Path,
    folder_path: &str,
    data: &MetadataTargetDraftsByFile,
    state: &DraftRepositoryState,
) -> Result<(), String> {
    with_repository_guard(state, || {
        let root = canonical_root(folder_path)?;
        for (relative_path, entries) in data {
            validate_slots(relative_path, entries, None)?;
        }
        let path = app_data_dir.join(TARGET_DRAFT_FILE_NAME);
        let mut central = read_snapshot(&path)?;
        central.retain(|photo_path, _| frontend_relative_path(&root, photo_path).is_none());
        for (relative_path, entries) in data {
            if !entries.is_empty() {
                central.insert(resolve_photo_path(&root, relative_path)?, entries.clone());
            }
        }
        write_snapshot(app_data_dir, &central)
    })
}

pub(crate) fn validate_slots(
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
        let loaded = load_metadata_draft_edits(
            dir.path(),
            dir.path().to_str().unwrap(),
            &DraftRepositoryState::default(),
        )
        .unwrap();
        assert!(loaded.is_empty());
        assert_eq!(
            std::fs::read(dir.path().join(OLD_DRAFT_FILE_NAME)).unwrap(),
            b"not json\0legacy"
        );
    }

    #[test]
    fn save_leaves_old_file_byte_for_byte_unchanged() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.jpg"), b"photo").unwrap();
        let old = dir.path().join(OLD_DRAFT_FILE_NAME);
        let bytes = b"historical\r\nbytes\0\xff";
        std::fs::write(&old, bytes).unwrap();
        let drafts = HashMap::from([("file.jpg".to_string(), vec![new_property(None)])]);
        save_metadata_draft_edits(
            dir.path(),
            dir.path().to_str().unwrap(),
            &drafts,
            &DraftRepositoryState::default(),
        )
        .unwrap();
        assert_eq!(std::fs::read(old).unwrap(), bytes);
    }

    #[test]
    fn removed_display_field_is_omitted_from_json() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.jpg"), b"photo").unwrap();
        let drafts = HashMap::from([("file.jpg".to_string(), vec![new_property(None)])]);
        save_metadata_draft_edits(
            dir.path(),
            dir.path().to_str().unwrap(),
            &drafts,
            &DraftRepositoryState::default(),
        )
        .unwrap();
        let contents = std::fs::read_to_string(dir.path().join(TARGET_DRAFT_FILE_NAME)).unwrap();
        assert!(!contents.contains("\"display\""));
    }

    #[test]
    fn exact_targets_survive_round_trip() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.jpg"), b"photo").unwrap();
        let drafts = HashMap::from([(
            "file.jpg".to_string(),
            vec![existing(None, "IFD0"), existing(None, "IFD1")],
        )]);
        save_metadata_draft_edits(
            dir.path(),
            dir.path().to_str().unwrap(),
            &drafts,
            &DraftRepositoryState::default(),
        )
        .unwrap();
        assert_eq!(
            load_metadata_draft_edits(
                dir.path(),
                dir.path().to_str().unwrap(),
                &DraftRepositoryState::default()
            )
            .unwrap(),
            drafts
        );
    }

    #[test]
    fn existing_and_new_identities_and_index_absence_round_trip() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.jpg"), b"photo").unwrap();
        let drafts = HashMap::from([(
            "file.jpg".to_string(),
            vec![existing(None, "IFD0"), new_property(Some(0))],
        )]);
        save_metadata_draft_edits(
            dir.path(),
            dir.path().to_str().unwrap(),
            &drafts,
            &DraftRepositoryState::default(),
        )
        .unwrap();
        let loaded = load_metadata_draft_edits(
            dir.path(),
            dir.path().to_str().unwrap(),
            &DraftRepositoryState::default(),
        )
        .unwrap();
        assert_eq!(loaded, drafts);
        assert_ne!(
            loaded["file.jpg"][0].target.slot(),
            loaded["file.jpg"][1].target.slot()
        );
    }

    #[test]
    fn malformed_and_duplicate_input_is_rejected_before_truncation() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.jpg"), b"photo").unwrap();
        let target = dir.path().join(TARGET_DRAFT_FILE_NAME);
        std::fs::write(&target, b"preserve me").unwrap();
        let duplicate = new_property(None);
        let drafts = HashMap::from([("file.jpg".to_string(), vec![duplicate.clone(), duplicate])]);
        assert!(save_metadata_draft_edits(
            dir.path(),
            dir.path().to_str().unwrap(),
            &drafts,
            &DraftRepositoryState::default()
        )
        .is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"preserve me");
    }

    #[test]
    fn parent_and_child_views_share_absolute_photo_identity() {
        let app_data = tempdir().unwrap();
        let photos = tempdir().unwrap();
        let child = photos.path().join("2025");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("a.jpg"), b"photo").unwrap();
        let state = DraftRepositoryState::default();
        let parent_drafts = HashMap::from([("2025/a.jpg".to_string(), vec![new_property(None)])]);
        save_metadata_draft_edits(
            app_data.path(),
            photos.path().to_str().unwrap(),
            &parent_drafts,
            &state,
        )
        .unwrap();
        let child_view =
            load_metadata_draft_edits(app_data.path(), child.to_str().unwrap(), &state).unwrap();
        assert_eq!(
            child_view,
            HashMap::from([("a.jpg".to_string(), vec![new_property(None)])])
        );
    }

    #[test]
    fn replacing_child_view_preserves_sibling_records() {
        let app_data = tempdir().unwrap();
        let photos = tempdir().unwrap();
        for folder in ["2024", "2025"] {
            std::fs::create_dir(photos.path().join(folder)).unwrap();
            std::fs::write(photos.path().join(folder).join("a.jpg"), b"photo").unwrap();
        }
        let state = DraftRepositoryState::default();
        let parent = HashMap::from([
            ("2024/a.jpg".to_string(), vec![new_property(None)]),
            ("2025/a.jpg".to_string(), vec![new_property(Some(0))]),
        ]);
        save_metadata_draft_edits(
            app_data.path(),
            photos.path().to_str().unwrap(),
            &parent,
            &state,
        )
        .unwrap();
        save_metadata_draft_edits(
            app_data.path(),
            photos.path().join("2025").to_str().unwrap(),
            &HashMap::new(),
            &state,
        )
        .unwrap();
        let loaded =
            load_metadata_draft_edits(app_data.path(), photos.path().to_str().unwrap(), &state)
                .unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key("2024/a.jpg"));
    }

    #[test]
    fn concurrent_repository_entry_fails_instead_of_waiting() {
        let state = DraftRepositoryState::default();
        let _held = state.operation.lock().unwrap();
        let error = with_repository_guard(&state, || Ok(())).unwrap_err();
        assert!(error.contains("ordering is invalid"));
    }

    #[test]
    fn missing_photo_remains_a_loadable_orphan_record() {
        let app_data = tempdir().unwrap();
        let photos = tempdir().unwrap();
        let state = DraftRepositoryState::default();
        let drafts = HashMap::from([("missing.jpg".to_string(), vec![new_property(None)])]);
        save_metadata_draft_edits(
            app_data.path(),
            photos.path().to_str().unwrap(),
            &drafts,
            &state,
        )
        .unwrap();
        assert_eq!(
            load_metadata_draft_edits(app_data.path(), photos.path().to_str().unwrap(), &state,)
                .unwrap(),
            drafts
        );
    }

    #[test]
    fn malformed_central_snapshot_blocks_save_without_overwrite() {
        let app_data = tempdir().unwrap();
        let photos = tempdir().unwrap();
        let target = app_data.path().join(TARGET_DRAFT_FILE_NAME);
        let malformed = b"not valid central jsonl";
        std::fs::write(&target, malformed).unwrap();
        let error = save_metadata_draft_edits(
            app_data.path(),
            photos.path().to_str().unwrap(),
            &HashMap::new(),
            &DraftRepositoryState::default(),
        )
        .unwrap_err();
        assert!(error.contains("Invalid draft line"));
        assert_eq!(std::fs::read(target).unwrap(), malformed);
    }
}
