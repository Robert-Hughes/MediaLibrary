//! Tauri commands and domain orchestration for authoritative session drafts and metadata operations.

use super::*;

pub(super) fn validate_exact_session_draft_target(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    target: &metadata_draft_target::MetadataDraftTarget,
) -> Result<(), String> {
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    match target {
        metadata_draft_target::MetadataDraftTarget::ExistingOccurrence {
            occurrence_id, ..
        } => {
            let mut matches = occurrences
                .0
                .iter()
                .filter(|occurrence| &occurrence.id == occurrence_id);
            let occurrence = matches
                .next()
                .ok_or_else(|| "The exact metadata occurrence no longer exists".to_string())?;
            if matches.next().is_some() {
                return Err("The exact metadata occurrence ID is duplicated".into());
            }
            target
                .validate_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())
        }
        metadata_draft_target::MetadataDraftTarget::NewProperty {
            schema_id,
            write_target,
        } => {
            let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
            let info = registry
                .lookup(schema_id)
                .ok_or_else(|| "The selected metadata schema is unknown".to_string())?;
            target
                .validate_new_property(info)
                .map_err(|error| error.to_string())?;
            for occurrence in &occurrences.0 {
                if occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| {
                        selector.group1 == write_target.group1
                            && selector.group7 == write_target.group7
                            && selector.tag_name == write_target.tag_name
                    })
                    || occurrence.write_target.as_ref() == Some(write_target)
                {
                    return Err(
                        "The complete ExifTool destination is already present in the file".into(),
                    );
                }
                if occurrence.observed_selector.is_none() && &occurrence.schema_id == schema_id {
                    return Err(
                        "A same-schema occurrence has no safely identifiable destination".into(),
                    );
                }
            }
            if snapshot
                .drafts
                .get(relative_path)
                .into_iter()
                .flatten()
                .any(|entry| {
                    entry.target != *target && entry.target.write_target() == Some(write_target)
                })
            {
                return Err(
                    "Another pending draft already uses the intended complete selector".into(),
                );
            }
            Ok(())
        }
    }
}

pub(super) fn ensure_session_target_has_no_pending_verification(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    target: &metadata_draft_target::MetadataDraftTarget,
) -> Result<(), String> {
    let pending = snapshot
        .verification_outcomes
        .get(relative_path)
        .into_iter()
        .flatten()
        .any(|outcome| {
            let current = match &outcome.draft_reconciliation {
                apply_edits::MetadataDraftReconciliation::Replace { target } => target,
                _ => &outcome.target,
            };
            current == target
        });
    if pending {
        Err("Resolve the verification outcome for this destination before editing it".into())
    } else {
        Ok(())
    }
}

pub(super) fn persist_exact_session_draft_row(
    app: &AppHandle,
    repository_state: &draft_edits::DraftRepositoryState,
    folder: &str,
    relative_path: String,
    entries: Vec<draft_edits::MetadataTargetDraftEntry>,
) -> Result<(), String> {
    let app_data_dir = commands::shared::app_data_dir(app)?;
    draft_repository::apply_row_mutations(
        &app_data_dir,
        folder,
        &[draft_repository::MetadataDraftRowMutation {
            relative_path,
            entries,
        }],
        repository_state,
    )
}

pub(super) fn ensure_session_draft_mutation_allowed(
    snapshot: &session::MediaLibrarySessionSnapshot,
) -> Result<(), String> {
    if !matches!(
        snapshot.draft_persistence,
        session::MediaLibrarySessionDraftPersistenceState::Ready
    ) {
        return Err("Draft persistence is not ready".into());
    }
    if snapshot.apply_operation.as_ref().is_some_and(|operation| {
        matches!(
            operation.state,
            session::MediaLibraryApplyOperationState::Running
        )
    }) {
        return Err("Drafts cannot be changed while metadata apply is running".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) fn set_media_library_session_draft(
    session_id: u64,
    relative_path: String,
    target: metadata_draft_target::MetadataDraftTarget,
    edit: draft_edits::MetadataDraftEdit,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the draft was saved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    if target.is_new_property() {
        ensure_session_target_has_no_pending_verification(&snapshot, &relative_path, &target)?;
    }
    validate_exact_session_draft_target(&snapshot, &relative_path, &target)?;
    let mut entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let slot = target.slot();
    let replacement = draft_edits::MetadataTargetDraftEntry { target, edit };
    if let Some(existing) = entries.iter_mut().find(|entry| entry.target.slot() == slot) {
        *existing = replacement;
    } else {
        entries.push(replacement);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
pub(super) fn discard_media_library_session_draft(
    session_id: u64,
    relative_path: String,
    target: metadata_draft_target::MetadataDraftTarget,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the draft was discarded".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let slot = target.slot();
    let mut entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    entries.retain(|entry| entry.target.slot() != slot);
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
pub(super) fn resolve_media_library_session_verification_outcome(
    session_id: u64,
    relative_path: String,
    current_target: metadata_draft_target::MetadataDraftTarget,
    discard_draft: bool,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before verification was resolved".into());
    }
    let pending = snapshot
        .verification_outcomes
        .get(&relative_path)
        .is_some_and(|outcomes| {
            outcomes.iter().any(|outcome| {
                let target = match &outcome.draft_reconciliation {
                    apply_edits::MetadataDraftReconciliation::Replace { target } => target,
                    _ => &outcome.target,
                };
                target == &current_target
            })
        });
    if !pending {
        return Err("The verification outcome is no longer pending".into());
    }

    let persisted_entries = if discard_draft {
        ensure_session_draft_mutation_allowed(&snapshot)?;
        let slot = current_target.slot();
        let mut entries = snapshot
            .drafts
            .get(&relative_path)
            .cloned()
            .unwrap_or_default();
        let previous_len = entries.len();
        entries.retain(|entry| entry.target.slot() != slot);
        if entries.len() == previous_len {
            return Err("The verification draft is no longer pending".into());
        }
        let folder = snapshot
            .folder
            .as_deref()
            .ok_or_else(|| "The active media-library session has no folder".to_string())?;
        if let Err(error) = persist_exact_session_draft_row(
            &app,
            &repository_state,
            folder,
            relative_path.clone(),
            entries.clone(),
        ) {
            if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
                let _ = emit_session_snapshot(&app, &failed);
            }
            return Err(error);
        }
        Some(entries)
    } else {
        None
    };

    let committed = session_state.resolve_verification_outcome(
        session_id,
        &relative_path,
        &current_target,
        persisted_entries,
    )?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
pub(super) fn dismiss_media_library_session_verification_outcomes(
    session_id: u64,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.dismiss_all_verification_outcomes(session_id)?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
}

pub(super) fn discard_exact_session_draft_targets(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    targets: &[metadata_draft_target::MetadataDraftTarget],
) -> Option<Vec<draft_edits::MetadataTargetDraftEntry>> {
    if targets.is_empty() {
        return None;
    }
    let slots = targets
        .iter()
        .map(metadata_draft_target::MetadataDraftTarget::slot)
        .collect::<std::collections::HashSet<_>>();
    let remaining = entries
        .iter()
        .filter(|entry| !slots.contains(&entry.target.slot()))
        .cloned()
        .collect::<Vec<_>>();
    (remaining.len() != entries.len()).then_some(remaining)
}

#[tauri::command]
pub(super) fn discard_media_library_session_drafts(
    session_id: u64,
    relative_path: String,
    targets: Vec<metadata_draft_target::MetadataDraftTarget>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the drafts were discarded".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let Some(entries) = discard_exact_session_draft_targets(&current_entries, &targets) else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

pub(super) fn replace_exact_new_property_session_draft(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    original_target: &metadata_draft_target::MetadataDraftTarget,
    replacement_target: &metadata_draft_target::MetadataDraftTarget,
    original_edit: &draft_edits::MetadataDraftEdit,
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    let (
        metadata_draft_target::MetadataDraftTarget::NewProperty {
            schema_id: original_schema,
            ..
        },
        metadata_draft_target::MetadataDraftTarget::NewProperty {
            schema_id: replacement_schema,
            ..
        },
    ) = (original_target, replacement_target)
    else {
        return Err("Only NewProperty drafts can be moved".into());
    };
    if original_schema != replacement_schema {
        return Err("The replacement destination changed the exact schema".into());
    }
    let original_slot = original_target.slot();
    let original_entry = entries
        .iter()
        .find(|entry| entry.target.slot() == original_slot)
        .ok_or_else(|| "The original draft changed or disappeared".to_string())?;
    if &original_entry.target != original_target || &original_entry.edit != original_edit {
        return Err("The original draft changed or disappeared".into());
    }
    if original_target == replacement_target {
        return Ok(None);
    }
    let replacement_slot = replacement_target.slot();
    if entries.iter().any(|entry| {
        entry.target.slot() == replacement_slot && entry.target.slot() != original_slot
    }) {
        return Err("Another pending draft already uses the replacement destination".into());
    }
    let mut replaced = entries
        .iter()
        .filter(|entry| entry.target.slot() != original_slot)
        .cloned()
        .collect::<Vec<_>>();
    replaced.push(draft_edits::MetadataTargetDraftEntry {
        target: replacement_target.clone(),
        edit: original_edit.clone(),
    });
    Ok(Some(replaced))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(super) fn replace_media_library_session_new_property_draft(
    session_id: u64,
    relative_path: String,
    original_target: metadata_draft_target::MetadataDraftTarget,
    replacement_target: metadata_draft_target::MetadataDraftTarget,
    original_edit: draft_edits::MetadataDraftEdit,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the draft was moved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    ensure_session_target_has_no_pending_verification(&snapshot, &relative_path, &original_target)?;
    validate_exact_session_draft_target(&snapshot, &relative_path, &replacement_target)?;
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let Some(entries) = replace_exact_new_property_session_draft(
        &current_entries,
        &original_target,
        &replacement_target,
        &original_edit,
    )?
    else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

pub(super) fn plan_exact_session_target_removals(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    targets: &[metadata_draft_target::MetadataDraftTarget],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if targets.is_empty() {
        return Err("At least one exact metadata target is required".into());
    }
    let mut requested_slots = std::collections::HashSet::new();
    for target in targets {
        if !requested_slots.insert(target.slot()) {
            return Err(
                "The removal request contains the same logical target slot more than once".into(),
            );
        }
    }

    let delete_edit = draft_edits::MetadataDraftEdit {
        value: None,
        intent: draft_edits::EditIntent::Delete,
    };
    let mut planned = entries.to_vec();
    for target in targets {
        let slot = target.slot();
        let owner_index = planned.iter().position(|entry| entry.target.slot() == slot);
        match target {
            metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                let index = owner_index.ok_or_else(|| {
                    "The selected New Property target no longer has an exact stored draft"
                        .to_string()
                })?;
                if planned[index].target != *target {
                    return Err(
                        "A stale complete target owns the selected New Property slot".into(),
                    );
                }
                planned.remove(index);
            }
            metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                if let Some(index) = owner_index {
                    if planned[index].target != *target {
                        return Err(
                            "A stale complete target owns the selected occurrence slot".into()
                        );
                    }
                    if planned[index].edit == delete_edit {
                        continue;
                    }
                    planned[index].edit = delete_edit.clone();
                } else {
                    planned.push(draft_edits::MetadataTargetDraftEntry {
                        target: target.clone(),
                        edit: delete_edit.clone(),
                    });
                }
            }
        }
    }

    Ok((planned != entries).then_some(planned))
}

pub(super) fn preview_exact_session_target_removals(
    entries: &[draft_edits::MetadataTargetDraftEntry],
    targets: &[metadata_draft_target::MetadataDraftTarget],
) -> Result<draft_edits::MetadataRemovalPreview, String> {
    plan_exact_session_target_removals(entries, targets)?;
    let delete_edit = draft_edits::MetadataDraftEdit {
        value: None,
        intent: draft_edits::EditIntent::Delete,
    };
    let mut existing_fields_to_delete = 0;
    let mut staged_creations_to_cancel = 0;
    let mut no_op_targets = 0;
    for target in targets {
        match target {
            metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                staged_creations_to_cancel += 1;
            }
            metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                let owner = entries
                    .iter()
                    .find(|entry| entry.target.slot() == target.slot());
                if owner.is_some_and(|entry| entry.edit == delete_edit) {
                    no_op_targets += 1;
                } else {
                    existing_fields_to_delete += 1;
                }
            }
        }
    }
    Ok(draft_edits::MetadataRemovalPreview {
        existing_fields_to_delete,
        staged_creations_to_cancel,
        no_op_targets,
        affected_count: existing_fields_to_delete + staged_creations_to_cancel,
    })
}

#[tauri::command]
pub(super) fn preview_media_library_session_metadata_target_removals(
    session_id: u64,
    relative_path: String,
    targets: Vec<metadata_draft_target::MetadataDraftTarget>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<draft_edits::MetadataRemovalPreview, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err(
            "The media-library session changed before metadata removal was previewed".into(),
        );
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    for target in &targets {
        validate_exact_session_draft_target(&snapshot, &relative_path, target)?;
    }
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    preview_exact_session_target_removals(&current_entries, &targets)
}

#[tauri::command]
pub(super) fn remove_media_library_session_metadata_targets(
    session_id: u64,
    relative_path: String,
    targets: Vec<metadata_draft_target::MetadataDraftTarget>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before metadata was removed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    for target in &targets {
        validate_exact_session_draft_target(&snapshot, &relative_path, target)?;
    }
    let current_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let Some(entries) = plan_exact_session_target_removals(&current_entries, &targets)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

pub(super) fn plan_session_schema_removal(
    occurrences: &metadata_occurrence::MetadataOccurrences,
    entries: &[draft_edits::MetadataTargetDraftEntry],
    schema_id: &tag_schema::SchemaDefinitionId,
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    let mut targets = Vec::new();
    let mut authoritative_slots = std::collections::HashSet::new();
    for occurrence in occurrences
        .iter()
        .filter(|occurrence| &occurrence.schema_id == schema_id)
    {
        let target =
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| {
                    format!("The selected occurrence cannot be removed safely: {error}")
                })?;
        if !authoritative_slots.insert(target.slot()) {
            return Err(
                "Several authoritative occurrences resolve to the same exact target slot".into(),
            );
        }
        targets.push(target);
    }
    for entry in entries
        .iter()
        .filter(|entry| entry.target.schema_id() == schema_id)
    {
        match &entry.target {
            metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                targets.push(entry.target.clone());
            }
            metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. }
                if !authoritative_slots.contains(&entry.target.slot()) =>
            {
                return Err(
                    "An ExistingOccurrence draft owns the selected schema, but its exact authoritative occurrence is missing"
                        .into(),
                );
            }
            _ => {}
        }
    }
    if targets.is_empty() {
        return Ok(None);
    }
    plan_exact_session_target_removals(entries, &targets)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(super) fn remove_media_library_session_metadata_field_from_files(
    session_id: u64,
    schema_id: tag_schema::SchemaDefinitionId,
    relative_paths: Vec<String>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before metadata was removed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    if relative_paths.is_empty() {
        return Err("At least one selected file is required".into());
    }
    let mut seen = std::collections::HashSet::new();
    if let Some(duplicate) = relative_paths
        .iter()
        .find(|path| !seen.insert(path.as_str()))
    {
        return Err(format!(
            "The selected file list contains '{duplicate}' more than once"
        ));
    }

    let mut mutations = Vec::new();
    let mut committed_rows = Vec::new();
    for relative_path in &relative_paths {
        let metadata = snapshot
            .metadata
            .iter()
            .find(|entry| entry.relative_path == *relative_path)
            .ok_or_else(|| {
                format!("Authoritative metadata is unavailable for '{relative_path}'")
            })?;
        let occurrences = match &metadata.state {
            session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
            session::MediaLibrarySessionMetadataState::Loading => {
                return Err(format!(
                    "Authoritative metadata occurrences are still loading for '{relative_path}'"
                ));
            }
            session::MediaLibrarySessionMetadataState::Failed { error } => {
                return Err(format!(
                    "Metadata could not be loaded for '{relative_path}': {error}"
                ));
            }
        };
        let current_entries = snapshot
            .drafts
            .get(relative_path)
            .cloned()
            .unwrap_or_default();
        let Some(entries) = plan_session_schema_removal(occurrences, &current_entries, &schema_id)
            .map_err(|error| format!("Cannot remove metadata from '{relative_path}': {error}"))?
        else {
            continue;
        };
        mutations.push(draft_repository::MetadataDraftRowMutation {
            relative_path: relative_path.clone(),
            entries: entries.clone(),
        });
        committed_rows.push((relative_path.clone(), entries));
    }
    if mutations.is_empty() {
        return Ok(snapshot);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let app_data_dir = commands::shared::app_data_dir(&app)?;
    if let Err(error) =
        draft_repository::apply_row_mutations(&app_data_dir, folder, &mutations, &repository_state)
    {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_rows(session_id, committed_rows)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
pub(super) fn remove_media_library_session_metadata_fields(
    session_id: u64,
    relative_path: String,
    schema_ids: Vec<tag_schema::SchemaDefinitionId>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before metadata was removed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    if schema_ids.is_empty() {
        return Err("At least one exact metadata schema is required".into());
    }
    for (index, schema_id) in schema_ids.iter().enumerate() {
        if schema_ids[..index].contains(schema_id) {
            return Err("The removal request contains the same exact schema more than once".into());
        }
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| format!("Authoritative metadata is unavailable for '{relative_path}'"))?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into());
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!("Metadata could not be loaded: {error}"));
        }
    };
    let original_entries = snapshot
        .drafts
        .get(&relative_path)
        .cloned()
        .unwrap_or_default();
    let mut entries = original_entries.clone();
    for schema_id in &schema_ids {
        if let Some(next) = plan_session_schema_removal(occurrences, &entries, schema_id)
            .map_err(|error| format!("Cannot remove metadata from '{relative_path}': {error}"))?
        {
            entries = next;
        }
    }
    if entries == original_entries {
        return Ok(snapshot);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        entries.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, entries)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

pub(super) fn is_gps_coordinate_schema(id: &tag_schema::SchemaDefinitionId) -> bool {
    id.table == "GPS::Main"
        && id.index.is_none()
        && matches!(id.tag_id.as_str(), "1" | "2" | "3" | "4" | "5" | "6")
}

pub(super) fn plan_session_gps_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<Vec<draft_edits::MetadataTargetDraftEntry>, String> {
    if edits.is_empty() {
        return Err("A GPS edit must contain at least one field".into());
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let stored = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    let mut schemas = std::collections::HashSet::new();
    let mut slots = std::collections::HashSet::new();
    let mut selectors = std::collections::HashSet::new();
    let mut incoming = Vec::with_capacity(edits.len());

    for requested in edits {
        if !schemas.insert(requested.schema_id.clone()) {
            return Err("The GPS batch contains the same exact schema more than once".into());
        }
        if !is_gps_coordinate_schema(&requested.schema_id) {
            return Err("This action accepts only exact GPS coordinate-group schemas".into());
        }
        let matching_occurrences = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == requested.schema_id)
            .collect::<Vec<_>>();
        if matching_occurrences.len() > 1 {
            return Err("Several authoritative occurrences share this exact GPS schema".into());
        }
        let target = if let Some(occurrence) = matching_occurrences.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            let matching_drafts = stored
                .iter()
                .filter(|entry| entry.target.schema_id() == &requested.schema_id)
                .collect::<Vec<_>>();
            if matching_drafts
                .iter()
                .any(|entry| entry.target.is_existing_occurrence())
            {
                return Err(
                    "A staged GPS occurrence draft no longer has its authoritative occurrence"
                        .into(),
                );
            }
            if matching_drafts.len() > 1 {
                return Err("Several staged GPS destinations share this exact schema".into());
            }
            if let Some(entry) = matching_drafts.first() {
                entry.target.clone()
            } else {
                let info = registry
                    .lookup(&requested.schema_id)
                    .ok_or_else(|| "The exact GPS schema is unavailable".to_string())?;
                metadata_draft_target::MetadataDraftTarget::from_new_property(info)
                    .map_err(|error| error.to_string())?
            }
        };
        validate_exact_session_draft_target(snapshot, relative_path, &target)?;
        if !slots.insert(target.slot()) {
            return Err("The GPS batch contains the same exact target slot more than once".into());
        }
        if !selectors.insert(target.write_target().cloned()) {
            return Err("Two incoming GPS targets resolve to the same ExifTool destination".into());
        }
        incoming.push(draft_edits::MetadataTargetDraftEntry {
            target,
            edit: requested.edit.clone(),
        });
    }

    Ok(incoming)
}

pub(super) fn merge_session_gps_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    incoming: &[draft_edits::MetadataTargetDraftEntry],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    for entry in incoming {
        let slot = entry.target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot
                && stored.target.write_target() == entry.target.write_target()
        }) {
            return Err("Another exact draft target uses the captured GPS selector".into());
        }
        if let Some(existing) = planned
            .iter_mut()
            .find(|stored| stored.target.slot() == slot)
        {
            if existing.target != entry.target {
                return Err(
                    "The exact GPS target slot is owned by a different complete target snapshot"
                        .into(),
                );
            }
            *existing = entry.clone();
        } else {
            planned.push(entry.clone());
        }
    }
    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}

#[tauri::command]
pub(super) fn preview_media_library_session_gps_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<Vec<draft_edits::MetadataTargetDraftEntry>, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the GPS edit was previewed".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let entries = plan_session_gps_drafts(&snapshot, &relative_path, &edits)?;
    merge_session_gps_drafts(&snapshot, &relative_path, &entries)?;
    Ok(entries)
}

#[tauri::command]
pub(super) fn stage_media_library_session_gps_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the GPS drafts were saved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let entries = plan_session_gps_drafts(&snapshot, &relative_path, &edits)?;
    let Some(planned) = merge_session_gps_drafts(&snapshot, &relative_path, &entries)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

pub(super) fn is_describe_schema(id: &tag_schema::SchemaDefinitionId) -> bool {
    id.table == "UserDefined::mlib"
        && id.index.is_none()
        && matches!(
            id.tag_id.as_str(),
            "AIDescription"
                | "AIInterpretation"
                | "AITags"
                | "AIObjects"
                | "AIOcrText"
                | "AIModel"
                | "AIPromptVersion"
                | "AIGeneratedAt"
        )
}

pub(super) fn selector_matches_write_target(
    selector: &metadata_occurrence::MetadataObservedSelector,
    target: &metadata_occurrence::MetadataWriteTarget,
) -> bool {
    selector.group1.eq_ignore_ascii_case(&target.group1)
        && selector.group7.eq_ignore_ascii_case(&target.group7)
        && selector.tag_name.eq_ignore_ascii_case(&target.tag_name)
}

pub(super) fn plan_session_describe_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if edits.is_empty() {
        return Ok(None);
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();

    for generated in edits {
        if !seen.insert(generated.schema_id.clone()) {
            return Err("The generated batch contains the same exact schema more than once".into());
        }
        if !is_describe_schema(&generated.schema_id) {
            return Err("AI description is not allowed to generate this exact schema".into());
        }
        if generated.edit.intent != draft_edits::EditIntent::Set || generated.edit.value.is_none() {
            return Err("AI description supports only Set edits with semantic values".into());
        }
        let info = registry
            .lookup(&generated.schema_id)
            .ok_or_else(|| "The exact generated metadata schema is unavailable".to_string())?;
        let new_target = metadata_draft_target::MetadataDraftTarget::from_new_property(info)
            .map_err(|error| error.to_string())?;
        let destination = new_target
            .write_target()
            .ok_or_else(|| "The generated metadata destination is unavailable".to_string())?;
        let same_schema = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == generated.schema_id)
            .collect::<Vec<_>>();
        let at_destination = same_schema
            .iter()
            .copied()
            .filter(|occurrence| {
                occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| selector_matches_write_target(selector, destination))
            })
            .collect::<Vec<_>>();
        if at_destination.is_empty()
            && same_schema
                .iter()
                .any(|occurrence| occurrence.observed_selector.is_none())
        {
            return Err(
                "An authoritative generated-metadata occurrence has no physical selector".into(),
            );
        }
        if at_destination.len() > 1 {
            return Err(
                "The generated schema resolves to multiple occurrences at its destination".into(),
            );
        }
        let target = if let Some(occurrence) = at_destination.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            new_target
        };
        let slot = target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot && stored.target.write_target() == target.write_target()
        }) {
            return Err("Another exact draft target owns the generated destination".into());
        }
        let replacement = draft_edits::MetadataTargetDraftEntry {
            target: target.clone(),
            edit: generated.edit.clone(),
        };
        if let Some(existing) = planned.iter_mut().find(|entry| entry.target.slot() == slot) {
            if existing.target != target {
                return Err("A stale complete target owns the generated metadata slot".into());
            }
            *existing = replacement;
        } else {
            planned.push(replacement);
        }
    }

    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}

pub(super) fn is_geocode_schema(id: &tag_schema::SchemaDefinitionId) -> bool {
    id.table == "UserDefined::mlib"
        && id.index.is_none()
        && matches!(
            id.tag_id.as_str(),
            "ReverseGeocodeGeocodeJSON" | "ReverseGeocodeJSONv2"
        )
}

pub(super) fn is_normalise_schema(
    id: &tag_schema::SchemaDefinitionId,
    enabled_groups: &[normalise::NormaliseGroup],
) -> bool {
    if id.index.is_some() {
        return false;
    }
    enabled_groups.iter().any(|group| match group {
        normalise::NormaliseGroup::Keywords => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::Lightroom", "hierarchicalSubject")
                | ("XMP::dc", "subject")
                | ("IPTC::ApplicationRecord", "25")
        ),
        normalise::NormaliseGroup::Description => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "description") | ("Exif::Main", "270") | ("IPTC::ApplicationRecord", "120")
        ),
        normalise::NormaliseGroup::Title => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "title") | ("IPTC::ApplicationRecord", "5")
        ),
        normalise::NormaliseGroup::Headline => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::photoshop", "Headline") | ("IPTC::ApplicationRecord", "105")
        ),
        normalise::NormaliseGroup::Creator => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "creator") | ("Exif::Main", "315") | ("IPTC::ApplicationRecord", "80")
        ),
        normalise::NormaliseGroup::Copyright => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::dc", "rights") | ("Exif::Main", "33432") | ("IPTC::ApplicationRecord", "116")
        ),
        normalise::NormaliseGroup::IptcUtf8 => {
            id.table == "IPTC::EnvelopeRecord" && id.tag_id == "90"
        }
        normalise::NormaliseGroup::Location => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("XMP::iptcExt", "LocationCreated")
                | ("XMP::iptcCore", "Location")
                | ("IPTC::ApplicationRecord", "92")
                | ("XMP::photoshop", "City")
                | ("IPTC::ApplicationRecord", "90")
                | ("XMP::photoshop", "State")
                | ("IPTC::ApplicationRecord", "95")
                | ("XMP::photoshop", "Country")
                | ("IPTC::ApplicationRecord", "101")
                | ("XMP::iptcCore", "CountryCode")
                | ("IPTC::ApplicationRecord", "100")
        ),
        normalise::NormaliseGroup::Dates => matches!(
            (id.table.as_str(), id.tag_id.as_str()),
            ("Exif::Main", "36867")
                | ("XMP::photoshop", "DateCreated")
                | ("IPTC::ApplicationRecord", "55")
                | ("IPTC::ApplicationRecord", "60")
                | ("Exif::Main", "36868")
                | ("XMP::xmp", "CreateDate")
                | ("IPTC::ApplicationRecord", "62")
                | ("IPTC::ApplicationRecord", "63")
        ),
    })
}

pub(super) fn plan_session_geocode_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if edits.is_empty() {
        return Ok(None);
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();

    for generated in edits {
        if !seen.insert(generated.schema_id.clone()) {
            return Err("The generated batch contains the same exact schema more than once".into());
        }
        if !is_geocode_schema(&generated.schema_id) {
            return Err("Reverse geocoding is not allowed to generate this exact schema".into());
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set if generated.edit.value.is_some() => {}
            draft_edits::EditIntent::Delete if generated.edit.value.is_none() => {}
            _ => return Err("Reverse geocoding received an invalid semantic edit".into()),
        }
        let info = registry
            .lookup(&generated.schema_id)
            .ok_or_else(|| "The exact generated metadata schema is unavailable".to_string())?;
        let new_target = metadata_draft_target::MetadataDraftTarget::from_new_property(info)
            .map_err(|error| error.to_string())?;
        let destination = new_target
            .write_target()
            .ok_or_else(|| "The generated metadata destination is unavailable".to_string())?;
        let same_schema = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == generated.schema_id)
            .collect::<Vec<_>>();
        let at_destination = same_schema
            .iter()
            .copied()
            .filter(|occurrence| {
                occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| selector_matches_write_target(selector, destination))
            })
            .collect::<Vec<_>>();
        if at_destination.is_empty()
            && same_schema
                .iter()
                .any(|occurrence| occurrence.observed_selector.is_none())
        {
            return Err(
                "An authoritative generated-metadata occurrence has no physical selector".into(),
            );
        }
        if at_destination.len() > 1 {
            return Err(
                "The generated schema resolves to multiple occurrences at its destination".into(),
            );
        }
        let target = if let Some(occurrence) = at_destination.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            new_target
        };
        let slot = target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot && stored.target.write_target() == target.write_target()
        }) {
            return Err("Another exact draft target owns the generated destination".into());
        }
        let owner_index = planned.iter().position(|entry| entry.target.slot() == slot);
        if let Some(index) = owner_index {
            if planned[index].target != target {
                return Err("A stale complete target owns the generated metadata slot".into());
            }
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set => {
                let replacement = draft_edits::MetadataTargetDraftEntry {
                    target: target.clone(),
                    edit: generated.edit.clone(),
                };
                if let Some(index) = owner_index {
                    planned[index] = replacement;
                } else {
                    planned.push(replacement);
                }
            }
            draft_edits::EditIntent::Delete => match target {
                metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                    let replacement = draft_edits::MetadataTargetDraftEntry {
                        target: target.clone(),
                        edit: generated.edit.clone(),
                    };
                    if let Some(index) = owner_index {
                        planned[index] = replacement;
                    } else {
                        planned.push(replacement);
                    }
                }
                metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                    if let Some(index) = owner_index {
                        planned.remove(index);
                    }
                }
            },
            draft_edits::EditIntent::ListAdd | draft_edits::EditIntent::ListRemove => {
                return Err("Reverse geocoding received an unsupported list edit".into())
            }
        }
    }

    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}
pub(super) fn plan_session_normalise_drafts(
    snapshot: &session::MediaLibrarySessionSnapshot,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
    enabled_groups: &[normalise::NormaliseGroup],
) -> Result<Option<Vec<draft_edits::MetadataTargetDraftEntry>>, String> {
    if edits.is_empty() {
        return Ok(None);
    }
    let metadata = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .ok_or_else(|| "The file is not part of the active media-library session".to_string())?;
    let occurrences = match &metadata.state {
        session::MediaLibrarySessionMetadataState::Ready { occurrences } => occurrences,
        session::MediaLibrarySessionMetadataState::Loading => {
            return Err("Authoritative metadata occurrences are still loading".into())
        }
        session::MediaLibrarySessionMetadataState::Failed { error } => {
            return Err(format!(
                "Authoritative metadata occurrences failed to load: {error}"
            ))
        }
    };
    let registry = tag_schema::get_registry().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut planned = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();

    for generated in edits {
        if !seen.insert(generated.schema_id.clone()) {
            return Err("The generated batch contains the same exact schema more than once".into());
        }
        if !is_normalise_schema(&generated.schema_id, enabled_groups) {
            return Err(
                "Metadata normalisation is not allowed to generate this exact schema".into(),
            );
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set if generated.edit.value.is_some() => {}
            draft_edits::EditIntent::Delete if generated.edit.value.is_none() => {}
            _ => return Err("Metadata normalisation received an invalid semantic edit".into()),
        }
        let info = registry
            .lookup(&generated.schema_id)
            .ok_or_else(|| "The exact generated metadata schema is unavailable".to_string())?;
        let new_target = metadata_draft_target::MetadataDraftTarget::from_new_property(info)
            .map_err(|error| error.to_string())?;
        let destination = new_target
            .write_target()
            .ok_or_else(|| "The generated metadata destination is unavailable".to_string())?;
        let same_schema = occurrences
            .0
            .iter()
            .filter(|occurrence| occurrence.schema_id == generated.schema_id)
            .collect::<Vec<_>>();
        let at_destination = same_schema
            .iter()
            .copied()
            .filter(|occurrence| {
                occurrence
                    .observed_selector
                    .as_ref()
                    .is_some_and(|selector| selector_matches_write_target(selector, destination))
            })
            .collect::<Vec<_>>();
        if at_destination.is_empty()
            && same_schema
                .iter()
                .any(|occurrence| occurrence.observed_selector.is_none())
        {
            return Err(
                "An authoritative generated-metadata occurrence has no physical selector".into(),
            );
        }
        if at_destination.len() > 1 {
            return Err(
                "The generated schema resolves to multiple occurrences at its destination".into(),
            );
        }
        let target = if let Some(occurrence) = at_destination.first() {
            metadata_draft_target::MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| error.to_string())?
        } else {
            new_target
        };
        let slot = target.slot();
        if planned.iter().any(|stored| {
            stored.target.slot() != slot && stored.target.write_target() == target.write_target()
        }) {
            return Err("Another exact draft target owns the generated destination".into());
        }
        let owner_index = planned.iter().position(|entry| entry.target.slot() == slot);
        if let Some(index) = owner_index {
            if planned[index].target != target {
                return Err("A stale complete target owns the generated metadata slot".into());
            }
        }
        match generated.edit.intent {
            draft_edits::EditIntent::Set => {
                let replacement = draft_edits::MetadataTargetDraftEntry {
                    target: target.clone(),
                    edit: generated.edit.clone(),
                };
                if let Some(index) = owner_index {
                    planned[index] = replacement;
                } else {
                    planned.push(replacement);
                }
            }
            draft_edits::EditIntent::Delete => match target {
                metadata_draft_target::MetadataDraftTarget::ExistingOccurrence { .. } => {
                    let replacement = draft_edits::MetadataTargetDraftEntry {
                        target: target.clone(),
                        edit: generated.edit.clone(),
                    };
                    if let Some(index) = owner_index {
                        planned[index] = replacement;
                    } else {
                        planned.push(replacement);
                    }
                }
                metadata_draft_target::MetadataDraftTarget::NewProperty { .. } => {
                    if let Some(index) = owner_index {
                        planned.remove(index);
                    }
                }
            },
            draft_edits::EditIntent::ListAdd | draft_edits::EditIntent::ListRemove => {
                return Err("Metadata normalisation received an unsupported list edit".into())
            }
        }
    }

    let current = snapshot
        .drafts
        .get(relative_path)
        .cloned()
        .unwrap_or_default();
    Ok((planned != current).then_some(planned))
}

pub(crate) fn stage_batch_generated_metadata_drafts(
    app: &AppHandle,
    session_id: u64,
    operation_id: &str,
    producer: &batch_job::GeneratedDraftProducer,
    relative_path: &str,
    edits: &[draft_edits::SchemaMetadataEdit],
) -> Result<bool, String> {
    if edits.is_empty() {
        return Ok(false);
    }
    let session_state = app.state::<session::MediaLibrarySessionState>();
    let repository_state = app.state::<draft_edits::DraftRepositoryState>();
    let (folder, planned) = session_state.inspect(|snapshot| {
        if snapshot.session_id != Some(session_id)
            || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
        {
            return Err(
                "The media-library session changed before generated drafts were saved".into(),
            );
        }
        let operation_is_current = snapshot
            .batch_operations
            .get(producer.kind())
            .is_some_and(|operation| operation.operation_id == operation_id);
        if !operation_is_current {
            return Err("The generated-metadata batch operation identity changed".into());
        }
        ensure_session_draft_mutation_allowed(snapshot)?;
        let planned = match producer {
            batch_job::GeneratedDraftProducer::Describe => {
                plan_session_describe_drafts(snapshot, relative_path, edits)?
            }
            batch_job::GeneratedDraftProducer::Geocode => {
                plan_session_geocode_drafts(snapshot, relative_path, edits)?
            }
            batch_job::GeneratedDraftProducer::Normalise { enabled_groups } => {
                plan_session_normalise_drafts(snapshot, relative_path, edits, enabled_groups)?
            }
        };
        let folder = snapshot
            .folder
            .clone()
            .ok_or_else(|| "The active media-library session has no folder".to_string())?;
        Ok::<_, String>((folder, planned))
    })?;
    let Some(planned) = planned else {
        return Ok(false);
    };
    if let Err(error) = persist_exact_session_draft_row(
        app,
        &repository_state,
        &folder,
        relative_path.to_owned(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(app, &failed);
        }
        return Err(error);
    }
    session_state.commit_generated_draft_row(session_id, relative_path.to_owned(), planned)?;
    Ok(true)
}

#[tauri::command]
pub(super) fn stage_media_library_session_describe_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err(
            "The media-library session changed before description drafts were saved".into(),
        );
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let Some(planned) = plan_session_describe_drafts(&snapshot, &relative_path, &edits)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
pub(super) fn stage_media_library_session_geocode_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err(
            "The media-library session changed before reverse-geocode drafts were saved".into(),
        );
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let Some(planned) = plan_session_geocode_drafts(&snapshot, &relative_path, &edits)? else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}
#[tauri::command]
pub(super) fn stage_media_library_session_normalise_drafts(
    session_id: u64,
    relative_path: String,
    edits: Vec<draft_edits::SchemaMetadataEdit>,
    enabled_groups: Vec<normalise::NormaliseGroup>,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before normalise drafts were saved".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let Some(planned) =
        plan_session_normalise_drafts(&snapshot, &relative_path, &edits, &enabled_groups)?
    else {
        return Ok(snapshot);
    };
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    if let Err(error) = persist_exact_session_draft_row(
        &app,
        &repository_state,
        folder,
        relative_path.clone(),
        planned.clone(),
    ) {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_row(session_id, relative_path, planned)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

#[tauri::command]
pub(super) fn preview_media_library_session_bulk_drafts(
    session_id: u64,
    relative_paths: Vec<String>,
    request: bulk_metadata::BulkMetadataDraftRequest,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<bulk_metadata::BulkMetadataDraftPreviewPlan, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the bulk edit was previewed".into());
    }
    if !matches!(
        snapshot.draft_persistence,
        session::MediaLibrarySessionDraftPersistenceState::Ready
    ) {
        return Err("Draft persistence is not ready".into());
    }
    let plan = bulk_metadata::plan_bulk_metadata_drafts(&snapshot, &relative_paths, &request)?;
    Ok(bulk_metadata::BulkMetadataDraftPreviewPlan {
        preview: plan.preview,
    })
}

#[tauri::command]
pub(super) fn stage_media_library_session_bulk_drafts(
    session_id: u64,
    relative_paths: Vec<String>,
    request: bulk_metadata::BulkMetadataDraftRequest,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
    repository_state: State<'_, draft_edits::DraftRepositoryState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.snapshot();
    if snapshot.session_id != Some(session_id)
        || snapshot.lifecycle != session::MediaLibrarySessionLifecycle::Loaded
    {
        return Err("The media-library session changed before the bulk edit was staged".into());
    }
    ensure_session_draft_mutation_allowed(&snapshot)?;
    let plan = bulk_metadata::plan_bulk_metadata_drafts(&snapshot, &relative_paths, &request)?;
    if plan.rows.is_empty() {
        return Ok(snapshot);
    }
    let folder = snapshot
        .folder
        .as_deref()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let mutations = plan
        .rows
        .iter()
        .map(
            |(relative_path, entries)| draft_repository::MetadataDraftRowMutation {
                relative_path: relative_path.clone(),
                entries: entries.clone(),
            },
        )
        .collect::<Vec<_>>();
    let app_data_dir = commands::shared::app_data_dir(&app)?;
    if let Err(error) =
        draft_repository::apply_row_mutations(&app_data_dir, folder, &mutations, &repository_state)
    {
        if let Ok(failed) = session_state.mark_draft_save_failed(session_id, error.clone()) {
            let _ = emit_session_snapshot(&app, &failed);
        }
        return Err(error);
    }
    let committed = session_state.commit_draft_rows(session_id, plan.rows)?;
    emit_session_snapshot(&app, &committed)?;
    Ok(committed)
}

/// Production occurrence-aware metadata apply.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(super) async fn apply_metadata_draft_edits_cmd(
    session_id: u64,
    rel_paths: Option<Vec<String>>,
    app: AppHandle,
    apply_state: State<'_, apply_batch::ApplyEditsState>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<apply_batch::MetadataApplyResult, String> {
    let session_snapshot = session_state.snapshot();
    if session_snapshot.session_id != Some(session_id) {
        return Err("The media-library session changed before apply started".into());
    }
    ensure_session_draft_mutation_allowed(&session_snapshot)?;
    let folder_path = session_snapshot
        .folder
        .clone()
        .ok_or_else(|| "The active media-library session has no folder".to_string())?;
    let (operation_id, begun) =
        session_state.begin_new_apply_operation(session_id, rel_paths.clone())?;
    emit_session_snapshot(&app, &begun)?;

    let app_settings = settings::load_settings(&commands::shared::app_data_dir(&app)?)?;
    let batch_size = usize::from(app_settings.metadata_apply_batch_size);
    let write_concurrency = usize::from(app_settings.metadata_apply_concurrency);
    log::info!(
        "[apply_edits] starting batch_size={} write_concurrency={} requested={}",
        batch_size,
        write_concurrency,
        rel_paths.as_ref().map_or(0, Vec::len)
    );
    let run_app = app.clone();
    let run_operation_id = operation_id.clone();
    let result =
        apply_batch::run_apply_edits_command(&apply_state, &operation_id, move |cancel_flag| {
            tauri::async_runtime::spawn_blocking(move || {
                apply_batch::run_apply_metadata_draft_edits_blocking(
                    folder_path,
                    rel_paths,
                    run_operation_id,
                    run_app,
                    cancel_flag,
                    apply_batch::MetadataApplyLimits {
                        batch_size,
                        write_concurrency,
                    },
                )
            })
        })
        .await;
    if let Err(error) = &result {
        if let Ok(failed) =
            session_state.fail_apply_operation(session_id, &operation_id, error.clone())
        {
            let _ = emit_session_snapshot(&app, &failed);
        }
    }
    result
}

#[tauri::command]
pub(super) fn cancel_apply_edits(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    apply_state: State<'_, apply_batch::ApplyEditsState>,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<(), String> {
    let cancelling = session_state.request_apply_cancellation(session_id, &operation_id)?;
    emit_session_snapshot(&app, &cancelling)?;
    apply_state.signal_cancel(&operation_id);
    Ok(())
}

#[tauri::command]
pub(super) fn dismiss_media_library_session_apply_operation(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.dismiss_apply_operation(session_id, &operation_id)?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
}
#[tauri::command]
pub(super) fn dismiss_media_library_session_batch_operation(
    session_id: u64,
    operation_id: String,
    app: AppHandle,
    session_state: State<'_, session::MediaLibrarySessionState>,
) -> Result<session::MediaLibrarySessionSnapshot, String> {
    let snapshot = session_state.dismiss_batch_operation(session_id, &operation_id)?;
    emit_session_snapshot(&app, &snapshot)?;
    Ok(snapshot)
}
