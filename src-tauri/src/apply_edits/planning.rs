//! Pre-write target planning and batch argument construction.

use super::*;

pub(super) fn plan_batch<F>(
    abs_path: &Path,
    edits: &[MetadataTargetDraftEntry],
    before: &scanner::FileMetadata,
    schema_lookup: F,
) -> Result<PlannedBatch, TargetApplyError>
where
    F: Fn(&SchemaDefinitionId) -> Option<TagInfo>,
{
    let mut occupied_slots = BTreeMap::<MetadataDraftSlot, MetadataDraftTarget>::new();
    for entry in edits {
        let slot = entry.target.slot();
        if let Some(first) = occupied_slots.insert(slot.clone(), entry.target.clone()) {
            return Err(TargetApplyError::DuplicateDraftSlot {
                slot: Box::new(slot),
                first: Box::new(first),
                second: Box::new(entry.target.clone()),
            });
        }
    }

    let mut occurrences = BTreeMap::<MetadataOccurrenceId, &MetadataOccurrence>::new();
    for occurrence in before.occurrences.iter() {
        if occurrences
            .insert(occurrence.id.clone(), occurrence)
            .is_some()
        {
            return Err(TargetApplyError::DuplicatePreWriteOccurrenceId(Box::new(
                occurrence.id.clone(),
            )));
        }
    }

    let mut plans = Vec::with_capacity(edits.len());
    let mut selectors = BTreeMap::<MetadataSelectorKey, MetadataDraftTarget>::new();
    let mut combined = BuiltArgs::default();

    for entry in edits {
        let plan = match &entry.target {
            MetadataDraftTarget::ExistingOccurrence {
                occurrence_id,
                schema_id,
                write_target,
            } => {
                let exact = occurrences.get(occurrence_id).copied();
                let stable_matches = occurrences
                    .values()
                    .copied()
                    .filter(|occurrence| {
                        existing_occurrence_matches_except_copy(
                            occurrence,
                            occurrence_id,
                            schema_id,
                            write_target,
                        )
                    })
                    .collect::<Vec<_>>();
                let occurrence = match stable_matches.as_slice() {
                    [] => exact.ok_or_else(|| {
                        TargetApplyError::ExistingOccurrenceMissing(Box::new(entry.target.clone()))
                    })?,
                    [occurrence] => *occurrence,
                    many => {
                        return Err(TargetApplyError::ExistingOccurrenceAmbiguousCopyRebind {
                            target: Box::new(entry.target.clone()),
                            occurrences: many
                                .iter()
                                .map(|occurrence| occurrence.id.clone())
                                .collect(),
                        });
                    }
                };
                let effective_target = if occurrence.id == *occurrence_id {
                    entry.target.clone()
                } else {
                    MetadataDraftTarget::from_existing_occurrence(occurrence).map_err(|error| {
                        TargetApplyError::ExistingTargetValidationFailure {
                            target: Box::new(entry.target.clone()),
                            reason: error.to_string(),
                        }
                    })?
                };
                effective_target
                    .validate_existing_occurrence(occurrence)
                    .map_err(|error| TargetApplyError::ExistingTargetValidationFailure {
                        target: Box::new(entry.target.clone()),
                        reason: error.to_string(),
                    })?;
                let info = occurrence.tag_info.as_ref().expect("validated schema");
                let operation = if matches!(entry.edit.intent, EditIntent::Delete) {
                    MetadataWriteOperation::DeleteExisting
                } else {
                    MetadataWriteOperation::Set
                };
                info.metadata_write_eligibility(&abs_path.to_string_lossy(), operation)
                    .map_err(|error| TargetApplyError::ArgumentPlanningFailure {
                        target: Box::new(entry.target.clone()),
                        reason: error.to_string(),
                    })?;
                let selector = occurrence
                    .write_target
                    .as_ref()
                    .expect("validated selector");
                let args = crate::write_args::build_existing_occurrence_args(
                    &effective_target,
                    occurrence,
                    &entry.edit,
                )
                .map_err(|error| TargetApplyError::ArgumentPlanningFailure {
                    target: Box::new(entry.target.clone()),
                    reason: error.to_string(),
                })?;
                TargetPlan {
                    target: entry.target.clone(),
                    edit: entry.edit.clone(),
                    display_name: info.display_name(),
                    kind: info.kind.clone(),
                    before: Some(occurrence.value.clone()),
                    selector: selector.clone(),
                    args,
                    derived_reason: None,
                    matched_occurrence_id: Some(occurrence.id.clone()),
                }
            }
            MetadataDraftTarget::NewProperty {
                schema_id,
                write_target,
            } => {
                let info = schema_lookup(schema_id).ok_or_else(|| {
                    TargetApplyError::NewPropertySchemaMissing(Box::new(entry.target.clone()))
                })?;
                if let Err(error) = info.metadata_write_eligibility(
                    &abs_path.to_string_lossy(),
                    MetadataWriteOperation::Set,
                ) {
                    if error == MetadataWriteIneligibility::ReadOnlySchema {
                        return Err(TargetApplyError::NewPropertySchemaReadOnly(Box::new(
                            entry.target.clone(),
                        )));
                    }
                    return Err(TargetApplyError::ArgumentPlanningFailure {
                        target: Box::new(entry.target.clone()),
                        reason: error.to_string(),
                    });
                }
                entry.target.validate_new_property(&info).map_err(|error| {
                    TargetApplyError::ArgumentPlanningFailure {
                        target: Box::new(entry.target.clone()),
                        reason: error.to_string(),
                    }
                })?;
                let occupied = before
                    .occurrences
                    .iter()
                    .filter(|occurrence| {
                        occurrence
                            .observed_selector
                            .as_ref()
                            .is_some_and(|observed| {
                                observed_selector_matches_write_target(observed, write_target)
                            })
                    })
                    .map(|occurrence| (occurrence.id.clone(), occurrence.schema_id.clone()))
                    .collect::<Vec<_>>();
                if !occupied.is_empty() {
                    return Err(TargetApplyError::NewPropertySelectorOccupied {
                        target: Box::new(entry.target.clone()),
                        occurrences: occupied,
                    });
                }
                let unknown_same_schema = before
                    .occurrences
                    .for_schema(schema_id)
                    .filter(|occurrence| occurrence.observed_selector.is_none())
                    .map(|occurrence| occurrence.id.clone())
                    .collect::<Vec<_>>();
                if !unknown_same_schema.is_empty() {
                    return Err(TargetApplyError::NewPropertySchemaOccupancyUnknown {
                        target: Box::new(entry.target.clone()),
                        occurrences: unknown_same_schema,
                    });
                }
                if matches!(
                    entry.edit.intent,
                    EditIntent::Delete | EditIntent::ListRemove
                ) {
                    return Err(TargetApplyError::UnsupportedNewPropertyIntent {
                        target: Box::new(entry.target.clone()),
                        intent: entry.edit.intent.clone(),
                    });
                }
                let args =
                    crate::write_args::build_new_property_args(&entry.target, &info, &entry.edit)
                        .map_err(|error| TargetApplyError::ArgumentPlanningFailure {
                        target: Box::new(entry.target.clone()),
                        reason: error.to_string(),
                    })?;
                TargetPlan {
                    target: entry.target.clone(),
                    edit: entry.edit.clone(),
                    display_name: info.display_name(),
                    kind: info.kind.clone(),
                    before: None,
                    selector: write_target.clone(),
                    args,
                    derived_reason: None,
                    matched_occurrence_id: None,
                }
            }
        };

        let selector_key = MetadataSelectorKey::from_write_target(&plan.selector);
        if let Some(first) = selectors.insert(selector_key, plan.target.clone()) {
            return Err(TargetApplyError::WriteSelectorCollision {
                group1: plan.selector.group1.clone(),
                group7: plan.selector.group7.clone(),
                tag_name: plan.selector.tag_name.clone(),
                first: Box::new(first),
                second: Box::new(plan.target.clone()),
            });
        }
        plans.push(plan);
    }

    let effective_charset_values = effective_iptc_charset_values(before, &plans);
    let effective_charset_utf8 =
        matches!(effective_charset_values.as_slice(), [value] if is_utf8_charset_value(value));
    let effective_charset_label = if effective_charset_utf8 {
        "UTF8".to_string()
    } else {
        match effective_charset_values.as_slice() {
            [] => "<missing>".to_string(),
            [value] => format!("{value:?}"),
            _ => format!(
                "<ambiguous: {} occurrences>",
                effective_charset_values.len()
            ),
        }
    };
    for plan in &plans {
        if is_iptc_schema(plan.target.schema_id())
            && !matches!(plan.edit.intent, EditIntent::Delete)
            && plan
                .edit
                .value
                .as_ref()
                .is_some_and(metadata_value_contains_non_ascii)
            && !effective_charset_utf8
        {
            return Err(TargetApplyError::UnsafeNonAsciiIptcWrite {
                target: Box::new(plan.target.clone()),
                effective_charset: effective_charset_label,
            });
        }
    }

    let converting_to_utf8 = !authoritative_iptc_charset_is_utf8(before) && effective_charset_utf8;
    if converting_to_utf8 {
        // Changing CodedCharacterSet changes only the declaration; ExifTool
        // does not transcode untouched IPTC bytes. Preserve their semantic
        // values by deriving same-value writes for every existing non-ASCII
        // IPTC occurrence. Explicit drafts in *this apply* take precedence,
        // while drafts not supplied to this call are deliberately invisible.
        let explicit_occurrence_ids = plans
            .iter()
            .filter_map(|plan| plan.matched_occurrence_id.clone())
            .collect::<BTreeSet<_>>();

        // Incremental list operations targeting a legacy non-ASCII value must
        // become one complete Set physically, otherwise only the added/removed
        // items would be encoded as UTF-8 and the retained legacy bytes would
        // be reinterpreted under the new marker.
        for plan in &mut plans {
            if !matches!(
                plan.edit.intent,
                EditIntent::ListAdd | EditIntent::ListRemove
            ) || !is_iptc_schema(plan.target.schema_id())
                || !plan
                    .before
                    .as_ref()
                    .is_some_and(metadata_value_contains_non_ascii)
            {
                continue;
            }
            let effective = effective_value_for_edit(plan.before.as_ref(), &plan.edit, &plan.kind)
                .map_err(|reason| TargetApplyError::ArgumentPlanningFailure {
                    target: Box::new(plan.target.clone()),
                    reason,
                })?;
            let synthetic = MetadataDraftEdit {
                value: effective,
                intent: EditIntent::Set,
            };
            let occurrence_id = plan
                .matched_occurrence_id
                .as_ref()
                .expect("existing list edit has a matched occurrence");
            let occurrence = occurrences
                .get(occurrence_id)
                .copied()
                .expect("matched occurrence remains indexed");
            let physical_target = MetadataDraftTarget::from_existing_occurrence(occurrence)
                .map_err(|error| TargetApplyError::IptcUtf8RewriteUnavailable {
                    occurrence_id: Box::new(occurrence.id.clone()),
                    reason: error.to_string(),
                })?;
            plan.args = crate::write_args::build_existing_occurrence_args(
                &physical_target,
                occurrence,
                &synthetic,
            )
            .map_err(|error| TargetApplyError::ArgumentPlanningFailure {
                target: Box::new(plan.target.clone()),
                reason: error.to_string(),
            })?;
        }

        for occurrence in before.occurrences.iter().filter(|occurrence| {
            is_iptc_schema(&occurrence.schema_id)
                && metadata_value_contains_non_ascii(&occurrence.value)
                && !explicit_occurrence_ids.contains(&occurrence.id)
        }) {
            let info = occurrence.tag_info.as_ref().ok_or_else(|| {
                TargetApplyError::IptcUtf8RewriteUnavailable {
                    occurrence_id: Box::new(occurrence.id.clone()),
                    reason: "the occurrence has no interpreted writable schema".to_string(),
                }
            })?;
            if info
                .metadata_write_eligibility(
                    &abs_path.to_string_lossy(),
                    MetadataWriteOperation::Set,
                )
                .is_err()
            {
                return Err(TargetApplyError::IptcUtf8RewriteUnavailable {
                    occurrence_id: Box::new(occurrence.id.clone()),
                    reason: "the occurrence is not writable by the application".to_string(),
                });
            }
            let selector = occurrence.write_target.as_ref().ok_or_else(|| {
                TargetApplyError::IptcUtf8RewriteUnavailable {
                    occurrence_id: Box::new(occurrence.id.clone()),
                    reason: "the occurrence has no exact write selector".to_string(),
                }
            })?;
            let target =
                MetadataDraftTarget::from_existing_occurrence(occurrence).map_err(|error| {
                    TargetApplyError::IptcUtf8RewriteUnavailable {
                        occurrence_id: Box::new(occurrence.id.clone()),
                        reason: error.to_string(),
                    }
                })?;
            let edit = MetadataDraftEdit {
                value: Some(occurrence.value.clone()),
                intent: EditIntent::Set,
            };
            let args =
                crate::write_args::build_existing_occurrence_args(&target, occurrence, &edit)
                    .map_err(|error| TargetApplyError::IptcUtf8RewriteUnavailable {
                        occurrence_id: Box::new(occurrence.id.clone()),
                        reason: error.to_string(),
                    })?;
            let selector_key = MetadataSelectorKey::from_write_target(selector);
            if let Some(first) = selectors.insert(selector_key, target.clone()) {
                return Err(TargetApplyError::WriteSelectorCollision {
                    group1: selector.group1.clone(),
                    group7: selector.group7.clone(),
                    tag_name: selector.tag_name.clone(),
                    first: Box::new(first),
                    second: Box::new(target),
                });
            }
            plans.push(TargetPlan {
                target,
                edit,
                display_name: info.display_name(),
                kind: info.kind.clone(),
                before: Some(occurrence.value.clone()),
                selector: selector.clone(),
                args,
                derived_reason: Some(
                    "required by IPTC UTF-8 conversion: changing CodedCharacterSet does not transcode existing bytes"
                        .to_string(),
                ),
                matched_occurrence_id: Some(occurrence.id.clone()),
            });
        }
    }

    // Put the marker before derived IPTC values in the raw argfile. ExifTool
    // then encodes every explicitly supplied value using the new declaration.
    let charset_id = crate::known_ids::iptc_coded_character_set();
    for plan in plans
        .iter()
        .filter(|plan| plan.target.schema_id() == &charset_id)
        .chain(
            plans
                .iter()
                .filter(|plan| plan.target.schema_id() != &charset_id),
        )
    {
        combined.extend(plan.args.clone());
    }

    if combined.is_empty() {
        return Err(TargetApplyError::NoWriteArguments);
    }

    let argfile = build_exiftool_write_argfile_args(abs_path, &combined.args)
        .and_then(|args| render_exiftool_argfile(&args))
        .map_err(TargetApplyError::ArgfileRenderingFailure)?;

    Ok(PlannedBatch {
        targets: plans,
        argfile,
    })
}
