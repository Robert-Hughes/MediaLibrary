use crate::draft_edits::{
    EditIntent, MetadataDraftEdit, MetadataTargetDraftEntry, SchemaMetadataEdit,
};
use crate::metadata_draft_target::MetadataDraftTarget;
use crate::metadata_occurrence::{MetadataOccurrence, MetadataOccurrences, MetadataWriteTarget};
use crate::metadata_value::{ListKind, MetadataValue};
use crate::session::{
    MediaLibrarySessionFileMetadata, MediaLibrarySessionMetadataState, MediaLibrarySessionSnapshot,
};
use crate::tag_schema::{MetadataWriteOperation, SchemaDefinitionId, TagInfo, TagKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "operation")]
pub enum BulkMetadataDraftRequest {
    Set {
        #[serde(rename = "tagInfo")]
        tag_info: TagInfo,
        edit: MetadataDraftEdit,
        merge: bool,
    },
    Delete {
        #[serde(rename = "schemaId")]
        schema_id: SchemaDefinitionId,
    },
    SetGps {
        group: GpsTagGroup,
        edits: Vec<SchemaMetadataEdit>,
    },
    DeleteGps {
        group: GpsTagGroup,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpsTagGroup {
    pub latitude_id: SchemaDefinitionId,
    pub latitude_ref_id: SchemaDefinitionId,
    pub longitude_id: SchemaDefinitionId,
    pub longitude_ref_id: SchemaDefinitionId,
    pub altitude_id: SchemaDefinitionId,
    pub altitude_ref_id: SchemaDefinitionId,
}

impl GpsTagGroup {
    fn ids(&self) -> [SchemaDefinitionId; 6] {
        [
            self.latitude_id.clone(),
            self.latitude_ref_id.clone(),
            self.longitude_id.clone(),
            self.longitude_ref_id.clone(),
            self.altitude_id.clone(),
            self.altitude_ref_id.clone(),
        ]
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BulkMetadataDraftPreview {
    pub file_count: usize,
    pub affected_file_count: usize,
    pub no_op_file_count: usize,
    pub existing_occurrences_set: usize,
    pub new_properties_set: usize,
    pub existing_occurrences_deleted: usize,
    pub staged_creations_cancelled: usize,
    pub drafts_cleared: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkMetadataDraftPreviewPlan {
    pub preview: BulkMetadataDraftPreview,
}

#[derive(Debug, Clone)]
pub struct BulkMetadataDraftPlan {
    pub rows: Vec<(String, Vec<MetadataTargetDraftEntry>)>,
    pub preview: BulkMetadataDraftPreview,
}

fn metadata_for_path<'a>(
    snapshot: &'a MediaLibrarySessionSnapshot,
    relative_path: &str,
) -> Result<&'a MediaLibrarySessionFileMetadata, String> {
    snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| format!("The file '{relative_path}' is not part of the active session"))
}

fn ready_occurrences<'a>(
    snapshot: &'a MediaLibrarySessionSnapshot,
    relative_path: &str,
) -> Result<&'a MetadataOccurrences, String> {
    match &metadata_for_path(snapshot, relative_path)?.state {
        MediaLibrarySessionMetadataState::Ready { occurrences } => Ok(occurrences),
        MediaLibrarySessionMetadataState::Loading => Err(format!(
            "Authoritative metadata occurrences are still loading for '{relative_path}'. Nothing was staged."
        )),
        MediaLibrarySessionMetadataState::Failed { error } => Err(format!(
            "Authoritative metadata occurrences failed for '{relative_path}': {error}"
        )),
    }
}

fn selector_equals(left: &MetadataWriteTarget, right: &MetadataWriteTarget) -> bool {
    left.group1.eq_ignore_ascii_case(&right.group1)
        && left.group7.eq_ignore_ascii_case(&right.group7)
        && left.tag_name.eq_ignore_ascii_case(&right.tag_name)
}

fn validate_occurrence_ids(
    occurrences: &MetadataOccurrences,
    relative_path: &str,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    for occurrence in &occurrences.0 {
        if !seen.insert(occurrence.id.clone()) {
            return Err(format!(
                "A complete authoritative metadata occurrence ID is duplicated in '{relative_path}'. Nothing was staged."
            ));
        }
    }
    Ok(())
}

fn validate_stored_entries(
    entries: &[MetadataTargetDraftEntry],
    relative_path: &str,
) -> Result<(), String> {
    let mut slots = HashSet::new();
    let mut selectors: Vec<&MetadataWriteTarget> = Vec::new();
    for entry in entries {
        if !slots.insert(entry.target.slot()) {
            return Err(format!(
                "Several stored target-aware drafts in '{relative_path}' use the same logical slot. Nothing was staged."
            ));
        }
        let selector = entry
            .target
            .write_target()
            .ok_or_else(|| "A stored target has no write destination".to_string())?;
        if selectors
            .iter()
            .any(|other| selector_equals(other, selector))
        {
            return Err(format!(
                "Several stored target-aware drafts in '{relative_path}' use the same ExifTool destination. Nothing was staged."
            ));
        }
        selectors.push(selector);
    }
    Ok(())
}

fn apply_edit(
    current: Option<&MetadataValue>,
    edit: &MetadataDraftEdit,
    kind: &TagKind,
) -> Result<Option<MetadataValue>, String> {
    match edit.intent {
        EditIntent::Delete => return Ok(None),
        EditIntent::Set => return Ok(edit.value.clone()),
        EditIntent::ListAdd | EditIntent::ListRemove => {}
    }
    let list_kind = match kind {
        TagKind::Bag(_) => Some(ListKind::Bag),
        TagKind::Seq(_) => Some(ListKind::Seq),
        TagKind::Alt(_) => Some(ListKind::Alt),
        _ => None,
    };
    let Some(list_kind) = list_kind else {
        return match edit.intent {
            EditIntent::ListRemove => Ok(None),
            EditIntent::ListAdd => match edit.value.clone() {
                Some(MetadataValue::List { .. }) => {
                    Err("a list payload cannot be rendered for a non-list schema".to_owned())
                }
                value => Ok(value),
            },
            _ => unreachable!(),
        };
    };
    let mut items = match current {
        Some(MetadataValue::List { items, .. }) => items.clone(),
        Some(value) => vec![value.clone()],
        None => Vec::new(),
    };
    let staged = match &edit.value {
        Some(MetadataValue::List { items, .. }) => items.clone(),
        Some(value) => vec![value.clone()],
        None => Vec::new(),
    };
    match edit.intent {
        EditIntent::ListRemove => items.retain(|item| !staged.contains(item)),
        EditIntent::ListAdd => {
            for item in staged {
                if !items.contains(&item) {
                    items.push(item);
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(Some(MetadataValue::List { list_kind, items }))
}

fn merge_value(
    kind: &TagKind,
    current: Option<&MetadataValue>,
    patch: &MetadataValue,
) -> Result<MetadataValue, String> {
    match kind {
        TagKind::Bag(_) | TagKind::Seq(_) | TagKind::Alt(_) => {
            let MetadataValue::List {
                items: patch_items, ..
            } = patch
            else {
                return Err("The collection editor did not return a list value".into());
            };
            if matches!(
                current,
                Some(MetadataValue::Unknown { .. } | MetadataValue::Binary)
            ) {
                return Err("The existing collection value cannot be interpreted safely".into());
            }
            let mut items = match current {
                Some(MetadataValue::List { items, .. }) => items.clone(),
                Some(value) => vec![value.clone()],
                None => Vec::new(),
            };
            for candidate in patch_items {
                if !items.contains(candidate) {
                    items.push(candidate.clone());
                }
            }
            let list_kind = match kind {
                TagKind::Bag(_) => ListKind::Bag,
                TagKind::Seq(_) => ListKind::Seq,
                TagKind::Alt(_) => ListKind::Alt,
                _ => unreachable!(),
            };
            Ok(MetadataValue::List { list_kind, items })
        }
        TagKind::LangAlt => {
            let MetadataValue::LangAlt(patch_languages) = patch else {
                return Err(
                    "The language-alternative editor returned an incompatible value".into(),
                );
            };
            let mut languages = match current {
                Some(MetadataValue::LangAlt(languages)) => languages.clone(),
                Some(_) => {
                    return Err("The existing value is not a language-alternative map".into())
                }
                None => BTreeMap::new(),
            };
            languages.extend(patch_languages.clone());
            Ok(MetadataValue::LangAlt(languages))
        }
        TagKind::Text => {
            let MetadataValue::Text(patch_text) = patch else {
                return Err("The text editor did not return a text value".into());
            };
            let mut text = match current {
                Some(MetadataValue::Text(text)) => text.clone(),
                Some(_) => return Err("The existing value is not a text value".into()),
                None => String::new(),
            };
            text.push_str(patch_text);
            Ok(MetadataValue::Text(text))
        }
        _ => Err("Merge is not supported for this metadata datatype".into()),
    }
}

fn owner_for_target<'a>(
    entries: &'a [MetadataTargetDraftEntry],
    target: &MetadataDraftTarget,
) -> Result<Option<&'a MetadataTargetDraftEntry>, String> {
    let slot = target.slot();
    let owner = entries.iter().find(|entry| entry.target.slot() == slot);
    if owner.is_some_and(|owner| owner.target != *target) {
        return Err("A stale complete target owns the requested draft slot".into());
    }
    Ok(owner)
}

fn target_for_occurrence(occurrence: &MetadataOccurrence) -> Result<MetadataDraftTarget, String> {
    MetadataDraftTarget::from_existing_occurrence(occurrence).map_err(|error| error.to_string())
}

fn validate_new_target(
    target: &MetadataDraftTarget,
    info: &TagInfo,
    occurrences: &MetadataOccurrences,
    entries: &[MetadataTargetDraftEntry],
) -> Result<(), String> {
    target
        .validate_new_property(info)
        .map_err(|error| error.to_string())?;
    let selector = target
        .write_target()
        .ok_or_else(|| "The New Property target has no destination".to_owned())?;
    if occurrences.0.iter().any(|occurrence| {
        occurrence
            .observed_selector
            .as_ref()
            .is_some_and(|observed| {
                observed.group1.eq_ignore_ascii_case(&selector.group1)
                    && observed.group7.eq_ignore_ascii_case(&selector.group7)
                    && observed.tag_name.eq_ignore_ascii_case(&selector.tag_name)
            })
    }) {
        return Err("The New Property destination is already occupied".into());
    }
    if occurrences
        .0
        .iter()
        .any(|occurrence| occurrence.schema_id == info.id && occurrence.observed_selector.is_none())
    {
        return Err("A same-schema occurrence has no safely identifiable destination".into());
    }
    if entries.iter().any(|entry| {
        entry.target.slot() != target.slot()
            && entry
                .target
                .write_target()
                .is_some_and(|other| selector_equals(other, selector))
    }) {
        return Err("Another pending draft already uses the intended destination".into());
    }
    Ok(())
}

fn upsert_entry(
    entries: &mut Vec<MetadataTargetDraftEntry>,
    replacement: MetadataTargetDraftEntry,
) {
    let slot = replacement.target.slot();
    if let Some(existing) = entries.iter_mut().find(|entry| entry.target.slot() == slot) {
        *existing = replacement;
    } else {
        entries.push(replacement);
    }
}

fn remove_target(
    entries: &mut Vec<MetadataTargetDraftEntry>,
    target: &MetadataDraftTarget,
) -> bool {
    let before = entries.len();
    let slot = target.slot();
    entries.retain(|entry| entry.target.slot() != slot);
    entries.len() != before
}

fn plan_target_set(
    entries: &mut Vec<MetadataTargetDraftEntry>,
    target: MetadataDraftTarget,
    authoritative: Option<&MetadataValue>,
    effective: Option<MetadataValue>,
    desired: MetadataValue,
    preview: &mut BulkMetadataDraftPreview,
) -> Result<bool, String> {
    if effective.as_ref() == Some(&desired) {
        return Ok(false);
    }
    let owner = owner_for_target(entries, &target)?.cloned();
    if owner.is_some() && authoritative == Some(&desired) {
        if remove_target(entries, &target) {
            preview.drafts_cleared += 1;
            return Ok(true);
        }
        return Ok(false);
    }
    let replacement = MetadataTargetDraftEntry {
        target: target.clone(),
        edit: MetadataDraftEdit {
            intent: EditIntent::Set,
            value: Some(desired),
        },
    };
    if owner.as_ref() == Some(&replacement) {
        return Ok(false);
    }
    upsert_entry(entries, replacement);
    if target.is_existing_occurrence() {
        preview.existing_occurrences_set += 1;
    } else {
        preview.new_properties_set += 1;
    }
    Ok(true)
}

fn plan_set_file(
    snapshot: &MediaLibrarySessionSnapshot,
    relative_path: &str,
    supplied_info: &TagInfo,
    edit: &MetadataDraftEdit,
    merge: bool,
    preview: &mut BulkMetadataDraftPreview,
) -> Result<Option<Vec<MetadataTargetDraftEntry>>, String> {
    if edit.intent != EditIntent::Set || edit.value.is_none() {
        return Err("Bulk Set requires one non-null semantic Set value".into());
    }
    let registry = crate::tag_schema::get_registry().map_err(|error| error.to_string())?;
    let info = registry
        .lookup(&supplied_info.id)
        .ok_or_else(|| "The selected exact schema is unavailable".to_owned())?;
    if info != supplied_info {
        return Err("The selected schema snapshot changed before bulk staging".into());
    }
    info.metadata_write_eligibility(relative_path, MetadataWriteOperation::Set)
        .map_err(|error| {
            format!("The selected schema is not writable for '{relative_path}': {error}")
        })?;
    let occurrences = ready_occurrences(snapshot, relative_path)?;
    validate_occurrence_ids(occurrences, relative_path)?;
    let current_entries = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    validate_stored_entries(&current_entries, relative_path)?;
    let mut entries = current_entries.clone();
    let authoritative = occurrences
        .0
        .iter()
        .filter(|occurrence| occurrence.schema_id == info.id)
        .collect::<Vec<_>>();
    let same_schema_drafts = current_entries
        .iter()
        .filter(|entry| entry.target.schema_id() == &info.id)
        .collect::<Vec<_>>();
    let authoritative_slots = authoritative
        .iter()
        .map(|occurrence| target_for_occurrence(occurrence).map(|target| target.slot()))
        .collect::<Result<HashSet<_>, _>>()?;
    for entry in &same_schema_drafts {
        if entry.target.is_existing_occurrence()
            && !authoritative_slots.contains(&entry.target.slot())
        {
            return Err(format!(
                "An ExistingOccurrence draft for '{relative_path}' no longer has its authoritative occurrence"
            ));
        }
    }
    let patch = edit.value.as_ref().expect("validated Set value");
    let mut changed = false;
    for occurrence in authoritative {
        let target = target_for_occurrence(occurrence)?;
        let owner = owner_for_target(&current_entries, &target)?;
        let effective = if let Some(owner) = owner {
            apply_edit(Some(&occurrence.value), &owner.edit, &info.kind)?
        } else {
            Some(occurrence.value.clone())
        };
        let desired = if merge {
            merge_value(&info.kind, effective.as_ref(), patch)?
        } else {
            patch.clone()
        };
        changed |= plan_target_set(
            &mut entries,
            target,
            Some(&occurrence.value),
            effective,
            desired,
            preview,
        )?;
    }
    let staged_new = same_schema_drafts
        .into_iter()
        .filter(|entry| entry.target.is_new_property())
        .cloned()
        .collect::<Vec<_>>();
    for entry in staged_new {
        validate_new_target(&entry.target, info, occurrences, &current_entries)?;
        let effective = apply_edit(None, &entry.edit, &info.kind)?;
        let desired = if merge {
            merge_value(&info.kind, effective.as_ref(), patch)?
        } else {
            patch.clone()
        };
        changed |= plan_target_set(
            &mut entries,
            entry.target,
            None,
            effective,
            desired,
            preview,
        )?;
    }
    if authoritative_slots.is_empty()
        && !current_entries
            .iter()
            .any(|entry| entry.target.schema_id() == &info.id && entry.target.is_new_property())
    {
        let target =
            MetadataDraftTarget::from_new_property(info).map_err(|error| error.to_string())?;
        validate_new_target(&target, info, occurrences, &current_entries)?;
        let desired = if merge {
            merge_value(&info.kind, None, patch)?
        } else {
            patch.clone()
        };
        changed |= plan_target_set(&mut entries, target, None, None, desired, preview)?;
    }
    Ok(changed.then_some(entries))
}

fn validate_gps_group(group: &GpsTagGroup) -> Result<[SchemaDefinitionId; 6], String> {
    let expected = [
        crate::known_ids::gps_latitude(),
        crate::known_ids::gps_latitude_ref(),
        crate::known_ids::gps_longitude(),
        crate::known_ids::gps_longitude_ref(),
        crate::known_ids::gps_altitude(),
        crate::known_ids::gps_altitude_ref(),
    ];
    let supplied = group.ids();
    let expected_set = expected.iter().cloned().collect::<HashSet<_>>();
    let supplied_set = supplied.iter().cloned().collect::<HashSet<_>>();
    if expected_set != supplied_set || supplied_set.len() != 6 {
        return Err("The bulk GPS request does not contain the exact six GPS schemas".into());
    }
    Ok(supplied)
}

fn resolve_gps_target(
    schema_id: &SchemaDefinitionId,
    occurrences: &MetadataOccurrences,
    entries: &[MetadataTargetDraftEntry],
) -> Result<(MetadataDraftTarget, Option<MetadataValue>), String> {
    let matches = occurrences
        .0
        .iter()
        .filter(|occurrence| &occurrence.schema_id == schema_id)
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Err("Several authoritative occurrences share one exact GPS schema".into());
    }
    if let Some(occurrence) = matches.first() {
        let target = target_for_occurrence(occurrence)?;
        return Ok((target, Some(occurrence.value.clone())));
    }
    let staged = entries
        .iter()
        .filter(|entry| entry.target.schema_id() == schema_id)
        .collect::<Vec<_>>();
    if staged.len() > 1 {
        return Err("Several staged destinations exist for one missing GPS field".into());
    }
    if let Some(entry) = staged.first() {
        if entry.target.is_existing_occurrence() {
            return Err(
                "A staged GPS ExistingOccurrence no longer has its authoritative occurrence".into(),
            );
        }
        return Ok((entry.target.clone(), None));
    }
    let registry = crate::tag_schema::get_registry().map_err(|error| error.to_string())?;
    let info = registry
        .lookup(schema_id)
        .ok_or_else(|| "The exact GPS schema is unavailable".to_owned())?;
    Ok((
        MetadataDraftTarget::from_new_property(info).map_err(|error| error.to_string())?,
        None,
    ))
}

fn plan_gps_set_file(
    snapshot: &MediaLibrarySessionSnapshot,
    relative_path: &str,
    group: &GpsTagGroup,
    edits: &[SchemaMetadataEdit],
    preview: &mut BulkMetadataDraftPreview,
) -> Result<Option<Vec<MetadataTargetDraftEntry>>, String> {
    let group_ids = validate_gps_group(group)?;
    if edits.is_empty() {
        return Err("A grouped GPS edit must contain at least one field".into());
    }
    let allowed = group_ids.into_iter().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    for edit in edits {
        if !allowed.contains(&edit.schema_id) {
            return Err("A grouped GPS edit contains a non-GPS schema".into());
        }
        if !seen.insert(edit.schema_id.clone()) {
            return Err("A grouped GPS edit contains the same schema more than once".into());
        }
        if edit.edit.intent != EditIntent::Set || edit.edit.value.is_none() {
            return Err("The grouped GPS editor must return non-null Set edits".into());
        }
    }
    let occurrences = ready_occurrences(snapshot, relative_path)?;
    validate_occurrence_ids(occurrences, relative_path)?;
    let current_entries = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    validate_stored_entries(&current_entries, relative_path)?;
    let mut entries = current_entries.clone();
    let mut changed = false;
    for edit in edits {
        let (target, authoritative) =
            resolve_gps_target(&edit.schema_id, occurrences, &current_entries)?;
        if target.is_new_property() {
            let registry = crate::tag_schema::get_registry().map_err(|error| error.to_string())?;
            let info = registry
                .lookup(&edit.schema_id)
                .ok_or_else(|| "The exact GPS schema is unavailable".to_owned())?;
            validate_new_target(&target, info, occurrences, &current_entries)?;
        } else {
            let occurrence_id = target
                .occurrence_id()
                .ok_or_else(|| "The GPS occurrence target is incomplete".to_owned())?;
            let occurrence = occurrences
                .0
                .iter()
                .find(|occurrence| &occurrence.id == occurrence_id)
                .ok_or_else(|| "The captured GPS occurrence no longer exists".to_owned())?;
            target
                .validate_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?;
        }
        let owner = owner_for_target(&current_entries, &target)?;
        let kind = occurrences
            .0
            .iter()
            .find(|occurrence| Some(&occurrence.id) == target.occurrence_id())
            .and_then(|occurrence| occurrence.tag_info.as_ref())
            .map(|info| &info.kind)
            .unwrap_or(&TagKind::Real);
        let effective = if let Some(owner) = owner {
            apply_edit(authoritative.as_ref(), &owner.edit, kind)?
        } else {
            authoritative.clone()
        };
        changed |= plan_target_set(
            &mut entries,
            target,
            authoritative.as_ref(),
            effective,
            edit.edit.value.clone().expect("validated GPS value"),
            preview,
        )?;
    }
    Ok(changed.then_some(entries))
}

fn plan_delete_file(
    snapshot: &MediaLibrarySessionSnapshot,
    relative_path: &str,
    schema_ids: &[SchemaDefinitionId],
    preview: &mut BulkMetadataDraftPreview,
) -> Result<Option<Vec<MetadataTargetDraftEntry>>, String> {
    let occurrences = ready_occurrences(snapshot, relative_path)?;
    validate_occurrence_ids(occurrences, relative_path)?;
    let current_entries = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    validate_stored_entries(&current_entries, relative_path)?;
    let mut entries = current_entries.clone();
    let mut changed = false;
    for schema_id in schema_ids {
        let authoritative = occurrences
            .0
            .iter()
            .filter(|occurrence| &occurrence.schema_id == schema_id)
            .collect::<Vec<_>>();
        let authoritative_ids = authoritative
            .iter()
            .map(|occurrence| occurrence.id.clone())
            .collect::<HashSet<_>>();
        for entry in current_entries
            .iter()
            .filter(|entry| entry.target.schema_id() == schema_id)
        {
            if let Some(occurrence_id) = entry.target.occurrence_id() {
                if !authoritative_ids.contains(occurrence_id) {
                    return Err(
                        "A staged ExistingOccurrence no longer has its authoritative occurrence"
                            .into(),
                    );
                }
            }
        }
        for occurrence in authoritative {
            let target = target_for_occurrence(occurrence)?;
            let owner = owner_for_target(&current_entries, &target)?;
            let replacement = MetadataTargetDraftEntry {
                target: target.clone(),
                edit: MetadataDraftEdit {
                    intent: EditIntent::Delete,
                    value: None,
                },
            };
            if owner != Some(&replacement) {
                upsert_entry(&mut entries, replacement);
                preview.existing_occurrences_deleted += 1;
                changed = true;
            }
        }
        let creations = current_entries
            .iter()
            .filter(|entry| entry.target.schema_id() == schema_id && entry.target.is_new_property())
            .map(|entry| entry.target.clone())
            .collect::<Vec<_>>();
        for target in creations {
            if remove_target(&mut entries, &target) {
                preview.staged_creations_cancelled += 1;
                changed = true;
            }
        }
    }
    Ok(changed.then_some(entries))
}

pub fn plan_bulk_metadata_drafts(
    snapshot: &MediaLibrarySessionSnapshot,
    relative_paths: &[String],
    request: &BulkMetadataDraftRequest,
) -> Result<BulkMetadataDraftPlan, String> {
    if relative_paths.is_empty() {
        return Err("At least one file must be selected".into());
    }
    let mut seen = HashSet::new();
    for path in relative_paths {
        if !seen.insert(path.clone()) {
            return Err(format!(
                "The bulk metadata request contains '{path}' more than once"
            ));
        }
    }
    let mut preview = BulkMetadataDraftPreview {
        file_count: relative_paths.len(),
        ..Default::default()
    };
    let mut rows = Vec::new();
    for path in relative_paths {
        let planned = match request {
            BulkMetadataDraftRequest::Set {
                tag_info,
                edit,
                merge,
            } => plan_set_file(snapshot, path, tag_info, edit, *merge, &mut preview)?,
            BulkMetadataDraftRequest::Delete { schema_id } => plan_delete_file(
                snapshot,
                path,
                std::slice::from_ref(schema_id),
                &mut preview,
            )?,
            BulkMetadataDraftRequest::SetGps { group, edits } => {
                plan_gps_set_file(snapshot, path, group, edits, &mut preview)?
            }
            BulkMetadataDraftRequest::DeleteGps { group } => {
                let ids = validate_gps_group(group)?;
                plan_delete_file(snapshot, path, &ids, &mut preview)?
            }
        };
        if let Some(entries) = planned {
            preview.affected_file_count += 1;
            rows.push((path.clone(), entries));
        } else {
            preview.no_op_file_count += 1;
        }
    }
    Ok(BulkMetadataDraftPlan { rows, preview })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::{
        self, MetadataOccurrence, MetadataOccurrenceId, MetadataOccurrences, MetadataWriteTarget,
    };
    use crate::session;
    use std::collections::HashMap;

    #[test]
    fn gps_group_rejects_missing_or_duplicate_members() {
        let id = crate::known_ids::gps_latitude();
        let group = GpsTagGroup {
            latitude_id: id.clone(),
            latitude_ref_id: id.clone(),
            longitude_id: id.clone(),
            longitude_ref_id: id.clone(),
            altitude_id: id.clone(),
            altitude_ref_id: id,
        };
        assert!(validate_gps_group(&group).is_err());
    }

    #[test]
    fn merge_text_appends_and_list_merge_deduplicates() {
        assert_eq!(
            merge_value(
                &TagKind::Text,
                Some(&MetadataValue::Text("a".into())),
                &MetadataValue::Text("b".into())
            )
            .unwrap(),
            MetadataValue::Text("ab".into())
        );
        assert_eq!(
            merge_value(
                &TagKind::Bag(Box::new(TagKind::Text)),
                Some(&MetadataValue::List {
                    list_kind: ListKind::Bag,
                    items: vec![MetadataValue::Text("a".into())]
                }),
                &MetadataValue::List {
                    list_kind: ListKind::Bag,
                    items: vec![
                        MetadataValue::Text("a".into()),
                        MetadataValue::Text("b".into())
                    ]
                }
            )
            .unwrap(),
            MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![
                    MetadataValue::Text("a".into()),
                    MetadataValue::Text("b".into())
                ]
            }
        );
    }

    fn test_schema(id: SchemaDefinitionId) -> (SchemaDefinitionId, TagInfo) {
        let registry = crate::tag_schema::get_registry().unwrap();
        let info = registry.lookup(&id).unwrap().clone();
        (id, info)
    }

    fn test_occurrence(
        path: &str,
        schema_id: SchemaDefinitionId,
        info: TagInfo,
        val: &str,
    ) -> MetadataOccurrence {
        let write_target = MetadataWriteTarget {
            group1: info.group.clone(),
            group7: metadata_occurrence::family7_group_from_schema_id(&schema_id),
            tag_name: info.name.clone(),
        };
        MetadataOccurrence {
            id: MetadataOccurrenceId {
                document: None,
                path: path.to_owned(),
                runtime_tag_id: schema_id.tag_id.clone(),
                tag_id_scope: metadata_occurrence::RuntimeTagIdScope {
                    table: schema_id.table.clone(),
                    tag_id: schema_id.tag_id.clone(),
                    index: None,
                },
                copy: 0,
            },
            schema_id,
            value: MetadataValue::Text(val.to_owned()),
            tag_info: Some(info),
            observed_selector: Some(metadata_occurrence::MetadataObservedSelector {
                group1: write_target.group1.clone(),
                group7: write_target.group7.clone(),
                tag_name: write_target.tag_name.clone(),
            }),
            write_target: Some(write_target),
        }
    }

    fn test_snapshot(
        files: Vec<(&str, Vec<MetadataOccurrence>, Vec<MetadataTargetDraftEntry>)>,
    ) -> MediaLibrarySessionSnapshot {
        let mut drafts = HashMap::new();
        let mut metadata = Vec::new();
        for (path, occs, d) in files {
            if !d.is_empty() {
                drafts.insert(path.to_owned(), d);
            }
            metadata.push(session::MediaLibrarySessionFileMetadata {
                relative_path: path.to_owned(),
                state: session::MediaLibrarySessionMetadataState::Ready {
                    occurrences: MetadataOccurrences(occs),
                },
            });
        }
        MediaLibrarySessionSnapshot {
            session_id: Some(1),
            revision: 1,
            lifecycle: session::MediaLibrarySessionLifecycle::Loaded,
            folder: Some("/test".to_owned()),
            files: Vec::new(),
            discovery_running: false,
            issues: Vec::new(),
            metadata,
            thumbnails: Vec::new(),
            drafts,
            draft_persistence: session::MediaLibrarySessionDraftPersistenceState::Ready,
            apply_operation: None,
            verification_outcomes: HashMap::new(),
            batch_operations: HashMap::new(),
        }
    }

    #[test]
    fn bulk_plan_rejects_empty_or_duplicate_paths() {
        let snapshot = test_snapshot(vec![]);
        let (id, info) = test_schema(crate::known_ids::xmp_title());
        let req = BulkMetadataDraftRequest::Set {
            tag_info: info,
            edit: MetadataDraftEdit {
                intent: EditIntent::Set,
                value: Some(MetadataValue::Text("A".into())),
            },
            merge: false,
        };
        assert!(plan_bulk_metadata_drafts(&snapshot, &[], &req).is_err());
        assert!(plan_bulk_metadata_drafts(
            &snapshot,
            &["a.jpg".to_string(), "a.jpg".to_string()],
            &req
        )
        .is_err());
        let _ = id;
    }

    #[test]
    fn bulk_plan_set_updates_existing_and_creates_new_property() {
        let (id, info) = test_schema(crate::known_ids::xmp_description());
        let occ = test_occurrence("a.jpg", id.clone(), info.clone(), "Old Description");
        let snapshot = test_snapshot(vec![
            ("a.jpg", vec![occ], vec![]),
            ("b.jpg", vec![], vec![]),
        ]);

        let req = BulkMetadataDraftRequest::Set {
            tag_info: info,
            edit: MetadataDraftEdit {
                intent: EditIntent::Set,
                value: Some(MetadataValue::Text("New Description".into())),
            },
            merge: false,
        };
        let paths = vec!["a.jpg".to_string(), "b.jpg".to_string()];
        let plan = plan_bulk_metadata_drafts(&snapshot, &paths, &req).unwrap();

        assert_eq!(plan.preview.file_count, 2);
        assert_eq!(plan.preview.affected_file_count, 2);
        assert_eq!(plan.preview.no_op_file_count, 0);
        assert_eq!(plan.preview.existing_occurrences_set, 1);
        assert_eq!(plan.preview.new_properties_set, 1);
        assert_eq!(plan.rows.len(), 2);

        // a.jpg has existing occurrence updated
        let a_row = &plan.rows.iter().find(|(p, _)| p == "a.jpg").unwrap().1;
        assert_eq!(a_row.len(), 1);
        assert!(a_row[0].target.is_existing_occurrence());

        // b.jpg has new property created
        let b_row = &plan.rows.iter().find(|(p, _)| p == "b.jpg").unwrap().1;
        assert_eq!(b_row.len(), 1);
        assert!(!b_row[0].target.is_existing_occurrence());
    }

    #[test]
    fn bulk_plan_set_clears_draft_when_matching_current_value() {
        let (id, info) = test_schema(crate::known_ids::xmp_description());
        let occ = test_occurrence("a.jpg", id.clone(), info.clone(), "Same Description");
        let existing_target = MetadataDraftTarget::from_existing_occurrence(&occ).unwrap();
        let staged_draft = MetadataTargetDraftEntry {
            target: existing_target,
            edit: MetadataDraftEdit {
                intent: EditIntent::Set,
                value: Some(MetadataValue::Text("Staged Value".into())),
            },
        };
        let snapshot = test_snapshot(vec![("a.jpg", vec![occ], vec![staged_draft])]);

        let req = BulkMetadataDraftRequest::Set {
            tag_info: info,
            edit: MetadataDraftEdit {
                intent: EditIntent::Set,
                value: Some(MetadataValue::Text("Same Description".into())),
            },
            merge: false,
        };
        let paths = vec!["a.jpg".to_string()];
        let plan = plan_bulk_metadata_drafts(&snapshot, &paths, &req).unwrap();

        assert_eq!(plan.preview.drafts_cleared, 1);
        assert_eq!(plan.preview.affected_file_count, 1);
        assert_eq!(plan.rows[0].1.len(), 0);
    }

    #[test]
    fn bulk_plan_delete_stages_deletion_and_cancels_staged_creation() {
        let (id, info) = test_schema(crate::known_ids::xmp_title());
        let occ = test_occurrence("a.jpg", id.clone(), info.clone(), "Title");
        let new_target = MetadataDraftTarget::from_new_property(&info).unwrap();
        let staged_creation = MetadataTargetDraftEntry {
            target: new_target,
            edit: MetadataDraftEdit {
                intent: EditIntent::Set,
                value: Some(MetadataValue::Text("Staged Creation".into())),
            },
        };
        let snapshot = test_snapshot(vec![
            ("a.jpg", vec![occ], vec![]),
            ("b.jpg", vec![], vec![staged_creation]),
            ("c.jpg", vec![], vec![]),
        ]);

        let req = BulkMetadataDraftRequest::Delete { schema_id: id };
        let paths = vec![
            "a.jpg".to_string(),
            "b.jpg".to_string(),
            "c.jpg".to_string(),
        ];
        let plan = plan_bulk_metadata_drafts(&snapshot, &paths, &req).unwrap();

        assert_eq!(plan.preview.file_count, 3);
        assert_eq!(plan.preview.affected_file_count, 2);
        assert_eq!(plan.preview.no_op_file_count, 1);
        assert_eq!(plan.preview.existing_occurrences_deleted, 1);
        assert_eq!(plan.preview.staged_creations_cancelled, 1);
    }

    #[test]
    fn bulk_plan_rejects_read_only_schema() {
        let registry = crate::tag_schema::get_registry().unwrap();
        let mut info = registry
            .lookup(&crate::known_ids::xmp_description())
            .unwrap()
            .clone();
        info.writable = false;
        let snapshot = test_snapshot(vec![("a.jpg", vec![], vec![])]);
        let req = BulkMetadataDraftRequest::Set {
            tag_info: info,
            edit: MetadataDraftEdit {
                intent: EditIntent::Set,
                value: Some(MetadataValue::Text("A".into())),
            },
            merge: false,
        };
        let error = plan_bulk_metadata_drafts(&snapshot, &["a.jpg".to_string()], &req).unwrap_err();
        assert!(
            error.contains("not writable")
                || error.contains("read-only")
                || error.contains("changed before bulk staging")
        );
    }
}
