//! Shared metadata edit semantics for the SQLite-backed target-aware draft store.

use crate::metadata_draft_target::{MetadataDraftSlot, MetadataDraftTarget};
use crate::metadata_occurrence::{
    family7_group_from_runtime_tag_id, family7_group_from_schema_id, validate_family1_group,
};
use crate::metadata_value::MetadataValue;
use crate::tag_schema::SchemaDefinitionId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataRemovalPreview {
    pub existing_fields_to_delete: usize,
    pub staged_creations_to_cancel: usize,
    pub no_op_targets: usize,
    pub affected_count: usize,
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
