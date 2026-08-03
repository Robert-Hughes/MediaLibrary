//! Post-write authoritative verification and draft reconciliation.

use super::*;

pub(super) fn targets_to_clear_from_reconciliation(
    outcomes: &[MetadataTargetOutcome],
) -> Vec<MetadataDraftTarget> {
    let mut cleared_slots = BTreeSet::new();
    let mut targets = Vec::new();
    for outcome in outcomes {
        if matches!(
            &outcome.draft_reconciliation,
            MetadataDraftReconciliation::Clear
        ) {
            assert!(
                cleared_slots.insert(outcome.target.slot()),
                "duplicate logical slot reached draft-clear reconciliation"
            );
            targets.push(outcome.target.clone());
        }
    }
    targets
}

pub(super) fn build_strict_post_write_occurrence_index(
    fresh: &scanner::FileMetadata,
) -> Result<BTreeMap<MetadataOccurrenceId, &MetadataOccurrence>, TargetApplyError> {
    let mut occurrences = BTreeMap::new();
    for occurrence in fresh.occurrences.iter() {
        if occurrences
            .insert(occurrence.id.clone(), occurrence)
            .is_some()
        {
            return Err(TargetApplyError::PostWriteDuplicateOccurrenceId {
                occurrence_id: Box::new(occurrence.id.clone()),
            });
        }
    }
    Ok(occurrences)
}

pub(super) fn verify_plan(
    plan: &TargetPlan,
    post_by_id: &BTreeMap<MetadataOccurrenceId, &MetadataOccurrence>,
) -> VerifiedTarget {
    match &plan.target {
        MetadataDraftTarget::ExistingOccurrence {
            occurrence_id,
            schema_id,
            write_target,
        } => {
            let exact = post_by_id.get(occurrence_id).copied();
            let stable_matches = post_by_id
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
            let evidence = if stable_matches.is_empty() {
                exact.into_iter().collect::<Vec<_>>()
            } else {
                stable_matches.clone()
            };
            let post_write = match evidence.as_slice() {
                [] => TargetApplyPostWriteState::Missing,
                [occurrence] => TargetApplyPostWriteState::Unique {
                    occurrence: Box::new(observed_occurrence(occurrence)),
                },
                many => TargetApplyPostWriteState::Multiple {
                    occurrences: many
                        .iter()
                        .map(|occurrence| observed_occurrence(occurrence))
                        .collect(),
                },
            };
            let verification = match stable_matches.as_slice() {
                [] => verify_existing_plan(plan, exact, false),
                [occurrence] => {
                    verify_existing_plan(plan, Some(occurrence), occurrence.id != *occurrence_id)
                }
                many => ambiguous_existing_occurrence_verification(
                    occurrence_id,
                    schema_id,
                    write_target,
                    many,
                ),
            };
            VerifiedTarget {
                verification,
                post_write,
            }
        }
        MetadataDraftTarget::NewProperty {
            schema_id,
            write_target,
        } => {
            // Inspect both the selected schema and the attempted destination so
            // a different schema index or a redirected destination is retained
            // as verification evidence instead of being mistaken for absence.
            let candidates = post_by_id
                .values()
                .copied()
                .filter(|occurrence| {
                    &occurrence.schema_id == schema_id
                        || occurrence
                            .observed_selector
                            .as_ref()
                            .is_some_and(|observed| {
                                observed_selector_matches_write_target(observed, write_target)
                            })
                })
                .collect::<Vec<_>>();
            let matches = candidates
                .iter()
                .copied()
                .filter(|occurrence| {
                    &occurrence.schema_id == schema_id
                        && occurrence
                            .observed_selector
                            .as_ref()
                            .is_some_and(|observed| {
                                observed_selector_matches_write_target(observed, write_target)
                            })
                })
                .collect::<Vec<_>>();
            let post_write_occurrences = if matches.is_empty() {
                &candidates
            } else {
                &matches
            };
            let post_write = match post_write_occurrences.as_slice() {
                [] => TargetApplyPostWriteState::Missing,
                [occurrence] => TargetApplyPostWriteState::Unique {
                    occurrence: Box::new(observed_occurrence(occurrence)),
                },
                many => TargetApplyPostWriteState::Multiple {
                    occurrences: many
                        .iter()
                        .map(|occurrence| observed_occurrence(occurrence))
                        .collect(),
                },
            };
            let verification = match matches.as_slice() {
                [] if candidates.is_empty() => {
                    // ExifTool represents an empty assignment as property
                    // deletion. Route true absence through the shared semantic
                    // verifier so Set(empty) can succeed while every non-empty
                    // Set remains MissingPostWrite.
                    let (kind, message) =
                        verify_semantic(schema_id, &plan.edit, None, Some(&plan.kind));
                    let draft_reconciliation = if verification_clears_draft(&kind) {
                        MetadataDraftReconciliation::Clear
                    } else {
                        MetadataDraftReconciliation::Keep
                    };
                    TargetVerification {
                        kind,
                        message,
                        observed: None,
                        draft_reconciliation,
                    }
                }
                [] => TargetVerification {
                    kind: "TargetChangedPostWrite".to_string(),
                    message: Some(format!(
                        "New property {schema_id} has no occurrence at attempted selector {}; observed candidates: {:?}",
                        write_target.selector(),
                        candidates
                            .iter()
                            .map(|occurrence| (&occurrence.id, &occurrence.schema_id))
                            .collect::<Vec<_>>()
                    )),
                    observed: None,
                    draft_reconciliation: MetadataDraftReconciliation::Keep,
                },
                [occurrence] => {
                    let (kind, message) = verify_semantic(
                        schema_id,
                        &plan.edit,
                        Some(&occurrence.value),
                        Some(&plan.kind),
                    );
                    let draft_reconciliation = if verification_clears_draft(&kind) {
                        MetadataDraftReconciliation::Clear
                    } else {
                        match MetadataDraftTarget::from_existing_occurrence(occurrence) {
                            Ok(target) => MetadataDraftReconciliation::Replace { target },
                            Err(error) => MetadataDraftReconciliation::Blocked {
                                reason: error.to_string(),
                            },
                        }
                    };
                    TargetVerification {
                        kind,
                        message,
                        observed: Some(occurrence.value.clone()),
                        draft_reconciliation,
                    }
                }
                many => ambiguous_new_property_verification(schema_id, write_target, many),
            };
            VerifiedTarget {
                verification,
                post_write,
            }
        }
    }
}

pub(super) fn existing_occurrence_matches_except_copy(
    occurrence: &MetadataOccurrence,
    occurrence_id: &MetadataOccurrenceId,
    schema_id: &SchemaDefinitionId,
    write_target: &MetadataWriteTarget,
) -> bool {
    occurrence.id.document == occurrence_id.document
        && occurrence.id.path == occurrence_id.path
        && occurrence.id.runtime_tag_id == occurrence_id.runtime_tag_id
        && occurrence.id.tag_id_scope == occurrence_id.tag_id_scope
        && &occurrence.schema_id == schema_id
        && occurrence.write_target.as_ref() == Some(write_target)
}

pub(super) fn ambiguous_existing_occurrence_verification(
    occurrence_id: &MetadataOccurrenceId,
    schema_id: &SchemaDefinitionId,
    write_target: &MetadataWriteTarget,
    occurrences: &[&MetadataOccurrence],
) -> TargetVerification {
    let message = format!(
        "Existing occurrence {occurrence_id:?} disappeared after write and its stable destination ({schema_id}, {}) resolved to multiple Copy-number candidates: {:?}",
        write_target.selector(),
        occurrences
            .iter()
            .map(|occurrence| &occurrence.id)
            .collect::<Vec<_>>()
    );
    TargetVerification {
        kind: "AmbiguousPostWrite".to_string(),
        message: Some(message.clone()),
        observed: None,
        draft_reconciliation: MetadataDraftReconciliation::Blocked { reason: message },
    }
}

pub(super) fn ambiguous_new_property_verification(
    schema_id: &SchemaDefinitionId,
    write_target: &MetadataWriteTarget,
    occurrences: &[&MetadataOccurrence],
) -> TargetVerification {
    let message = format!(
        "New property {schema_id} at attempted selector {} resolved to multiple exact schema-and-selector occurrences: {:?}",
        write_target.selector(),
        occurrences
            .iter()
            .map(|occurrence| &occurrence.id)
            .collect::<Vec<_>>()
    );
    TargetVerification {
        kind: "AmbiguousPostWrite".to_string(),
        message: Some(message.clone()),
        observed: None,
        draft_reconciliation: MetadataDraftReconciliation::Blocked { reason: message },
    }
}

pub(super) fn verify_existing_plan(
    plan: &TargetPlan,
    occurrence: Option<&MetadataOccurrence>,
    rebound: bool,
) -> TargetVerification {
    let MetadataDraftTarget::ExistingOccurrence {
        occurrence_id,
        schema_id,
        write_target,
    } = &plan.target
    else {
        unreachable!("existing-target verification requires an existing target")
    };

    let Some(occurrence) = occurrence else {
        let (kind, message) = verify_semantic(schema_id, &plan.edit, None, Some(&plan.kind));
        if matches!(kind.as_str(), "Match" | "DeleteOk") {
            return TargetVerification {
                kind,
                message,
                observed: None,
                draft_reconciliation: MetadataDraftReconciliation::Clear,
            };
        }
        let reason = format!("Exact occurrence {occurrence_id:?} no longer exists");
        return TargetVerification {
            kind,
            message: message.or_else(|| {
                Some(format!(
                    "Exact occurrence {occurrence_id:?} is absent after write"
                ))
            }),
            observed: None,
            draft_reconciliation: MetadataDraftReconciliation::Blocked { reason },
        };
    };
    let schema_unchanged = &occurrence.schema_id == schema_id;
    if !schema_unchanged || occurrence.write_target.as_ref() != Some(write_target) {
        let reason = format!(
            "Exact occurrence {occurrence_id:?} changed schema or selector; the stored target snapshot is stale"
        );
        return TargetVerification {
            kind: "TargetChangedPostWrite".to_string(),
            message: Some(format!(
                "Exact occurrence {occurrence_id:?} changed schema or selector after write"
            )),
            observed: Some(occurrence.value.clone()),
            draft_reconciliation: MetadataDraftReconciliation::Blocked { reason },
        };
    }
    let (kind, message) = verify_semantic(
        schema_id,
        &plan.edit,
        Some(&occurrence.value),
        Some(&plan.kind),
    );
    let draft_reconciliation = if verification_clears_draft(&kind) {
        MetadataDraftReconciliation::Clear
    } else if rebound {
        match MetadataDraftTarget::from_existing_occurrence(occurrence) {
            Ok(target) => MetadataDraftReconciliation::Replace { target },
            Err(error) => MetadataDraftReconciliation::Blocked {
                reason: error.to_string(),
            },
        }
    } else {
        MetadataDraftReconciliation::Keep
    };
    TargetVerification {
        kind,
        message,
        observed: Some(occurrence.value.clone()),
        draft_reconciliation,
    }
}

pub(super) fn verify_semantic(
    schema_id: &SchemaDefinitionId,
    edit: &MetadataDraftEdit,
    observed: Option<&MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    match edit.intent {
        EditIntent::Set => crate::metadata_verification::verify_set_value(
            schema_id,
            edit.value.as_ref(),
            observed,
            kind,
        ),
        EditIntent::Delete => {
            crate::metadata_verification::verify_delete_value(schema_id, observed)
        }
        EditIntent::ListAdd => crate::metadata_verification::verify_list_add_value(
            schema_id,
            edit.value.as_ref(),
            observed,
            kind,
        ),
        EditIntent::ListRemove => crate::metadata_verification::verify_list_remove_value(
            schema_id,
            edit.value.as_ref(),
            observed,
            kind,
        ),
    }
}
