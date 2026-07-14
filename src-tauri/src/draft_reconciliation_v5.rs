//! Pure application of already-computed schema-v5 draft reconciliation outcomes.
//!
//! This module performs no metadata writes and no draft persistence. It has no
//! production caller or Tauri command; production draft persistence and apply
//! remain schema-v4.

use std::collections::BTreeMap;
use std::fmt;

use crate::apply_edits_v5::{MetadataDraftReconciliation, MetadataTargetOutcome};
use crate::draft_edits::{MetadataDraftEditsV5, MetadataDraftEntryV5};
use crate::metadata_draft_target::{MetadataDraftSlot, MetadataDraftTarget};
use crate::tag_schema::SchemaDefinitionId;

/// A validation failure that prevents an atomic schema-v5 reconciliation.
#[derive(Debug, Clone, PartialEq)]
pub enum DraftReconciliationV5Error {
    DuplicateOriginalSlot {
        slot: MetadataDraftSlot,
        first: Box<MetadataDraftTarget>,
        second: Box<MetadataDraftTarget>,
    },
    DuplicateOutcomeSlot {
        slot: MetadataDraftSlot,
        first: Box<MetadataDraftTarget>,
        second: Box<MetadataDraftTarget>,
    },
    MissingOutcome {
        slot: MetadataDraftSlot,
        original: Box<MetadataDraftTarget>,
    },
    UnexpectedOutcome {
        target: Box<MetadataDraftTarget>,
    },
    OutcomeTargetMismatch {
        original: Box<MetadataDraftTarget>,
        outcome: Box<MetadataDraftTarget>,
    },
    InvalidReplacementSource {
        original: Box<MetadataDraftTarget>,
        replacement: Box<MetadataDraftTarget>,
    },
    ReplacementSchemaMismatch {
        original: Box<MetadataDraftTarget>,
        replacement: Box<MetadataDraftTarget>,
        original_schema: Box<SchemaDefinitionId>,
        replacement_schema: Box<SchemaDefinitionId>,
    },
    ReplacementSlotCollision {
        slot: MetadataDraftSlot,
        first: Box<MetadataDraftTarget>,
        second: Box<MetadataDraftTarget>,
    },
    MissingSourceFile {
        relative_path: String,
    },
}

impl fmt::Display for DraftReconciliationV5Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateOriginalSlot {
                slot,
                first,
                second,
            } => write!(
                formatter,
                "duplicate original metadata draft slot {slot:?}: first target {first:?}, second target {second:?}"
            ),
            Self::DuplicateOutcomeSlot {
                slot,
                first,
                second,
            } => write!(
                formatter,
                "duplicate outcome metadata draft slot {slot:?}: first target {first:?}, second target {second:?}"
            ),
            Self::MissingOutcome { slot, original } => write!(
                formatter,
                "missing reconciliation outcome for original slot {slot:?} and target {original:?}"
            ),
            Self::UnexpectedOutcome { target } => write!(
                formatter,
                "unexpected reconciliation outcome for target {target:?} at slot {:?}",
                target.slot()
            ),
            Self::OutcomeTargetMismatch { original, outcome } => write!(
                formatter,
                "reconciliation outcome target snapshot {outcome:?} does not match original target {original:?} at slot {:?}",
                original.slot()
            ),
            Self::InvalidReplacementSource {
                original,
                replacement,
            } => write!(
                formatter,
                "invalid replacement from original target {original:?} at slot {:?} to replacement target {replacement:?} at slot {:?}; replacement requires NewProperty to ExistingOccurrence",
                original.slot(),
                replacement.slot()
            ),
            Self::ReplacementSchemaMismatch {
                original,
                replacement,
                original_schema,
                replacement_schema,
            } => write!(
                formatter,
                "replacement schema mismatch from original target {original:?} with schema {original_schema:?} to replacement target {replacement:?} with schema {replacement_schema:?}"
            ),
            Self::ReplacementSlotCollision {
                slot,
                first,
                second,
            } => write!(
                formatter,
                "replacement slot collision at {slot:?}: first target {first:?}, second target {second:?}"
            ),
            Self::MissingSourceFile { relative_path } => write!(
                formatter,
                "cannot reconcile missing schema-v5 draft file {relative_path:?}"
            ),
        }
    }
}

impl std::error::Error for DraftReconciliationV5Error {}

/// Applies complete reconciliation outcomes to one file's original entries.
///
/// Validation completes before any output entry is constructed. `Blocked`
/// preserves the original entry; its reason remains transient outcome data that
/// a future command and frontend must surface to the user rather than persist.
pub fn reconcile_metadata_draft_entries_v5(
    original: &[MetadataDraftEntryV5],
    outcomes: &[MetadataTargetOutcome],
) -> Result<Vec<MetadataDraftEntryV5>, DraftReconciliationV5Error> {
    let mut originals_by_slot = BTreeMap::<MetadataDraftSlot, &MetadataDraftEntryV5>::new();
    for entry in original {
        let slot = entry.target.slot();
        if let Some(first) = originals_by_slot.insert(slot.clone(), entry) {
            return Err(DraftReconciliationV5Error::DuplicateOriginalSlot {
                slot,
                first: Box::new(first.target.clone()),
                second: Box::new(entry.target.clone()),
            });
        }
    }

    let mut outcomes_by_slot = BTreeMap::<MetadataDraftSlot, &MetadataTargetOutcome>::new();
    for outcome in outcomes {
        let slot = outcome.target.slot();
        if let Some(first) = outcomes_by_slot.insert(slot.clone(), outcome) {
            return Err(DraftReconciliationV5Error::DuplicateOutcomeSlot {
                slot,
                first: Box::new(first.target.clone()),
                second: Box::new(outcome.target.clone()),
            });
        }
    }

    for (slot, outcome) in &outcomes_by_slot {
        if !originals_by_slot.contains_key(slot) {
            return Err(DraftReconciliationV5Error::UnexpectedOutcome {
                target: Box::new(outcome.target.clone()),
            });
        }
    }

    for (slot, entry) in &originals_by_slot {
        if !outcomes_by_slot.contains_key(slot) {
            return Err(DraftReconciliationV5Error::MissingOutcome {
                slot: slot.clone(),
                original: Box::new(entry.target.clone()),
            });
        }
    }

    for (slot, entry) in &originals_by_slot {
        let outcome = outcomes_by_slot
            .get(slot)
            .expect("outcome completeness validated above");
        if outcome.target != entry.target {
            return Err(DraftReconciliationV5Error::OutcomeTargetMismatch {
                original: Box::new(entry.target.clone()),
                outcome: Box::new(outcome.target.clone()),
            });
        }
    }

    let mut replacement_slots = BTreeMap::<MetadataDraftSlot, MetadataDraftTarget>::new();
    for (slot, entry) in &originals_by_slot {
        let outcome = outcomes_by_slot
            .get(slot)
            .expect("outcome completeness validated above");
        let MetadataDraftReconciliation::Replace {
            target: replacement,
        } = &outcome.draft_reconciliation
        else {
            continue;
        };

        let (
            MetadataDraftTarget::NewProperty {
                schema_id: original_schema,
            },
            MetadataDraftTarget::ExistingOccurrence {
                schema_id: replacement_schema,
                ..
            },
        ) = (&entry.target, replacement)
        else {
            return Err(DraftReconciliationV5Error::InvalidReplacementSource {
                original: Box::new(entry.target.clone()),
                replacement: Box::new(replacement.clone()),
            });
        };

        if original_schema != replacement_schema {
            return Err(DraftReconciliationV5Error::ReplacementSchemaMismatch {
                original: Box::new(entry.target.clone()),
                replacement: Box::new(replacement.clone()),
                original_schema: Box::new(original_schema.clone()),
                replacement_schema: Box::new(replacement_schema.clone()),
            });
        }

        let replacement_slot = replacement.slot();
        if let Some(first) = originals_by_slot.get(&replacement_slot) {
            return Err(DraftReconciliationV5Error::ReplacementSlotCollision {
                slot: replacement_slot,
                first: Box::new(first.target.clone()),
                second: Box::new(replacement.clone()),
            });
        }
        if let Some(first) = replacement_slots.insert(replacement_slot.clone(), replacement.clone())
        {
            return Err(DraftReconciliationV5Error::ReplacementSlotCollision {
                slot: replacement_slot,
                first: Box::new(first),
                second: Box::new(replacement.clone()),
            });
        }
    }

    let mut reconciled = Vec::with_capacity(original.len());
    for (slot, entry) in originals_by_slot {
        let outcome = outcomes_by_slot
            .get(&slot)
            .expect("outcome completeness validated above");
        match &outcome.draft_reconciliation {
            MetadataDraftReconciliation::Clear => {}
            MetadataDraftReconciliation::Keep | MetadataDraftReconciliation::Blocked { .. } => {
                reconciled.push(entry.clone());
            }
            MetadataDraftReconciliation::Replace { target } => {
                reconciled.push(MetadataDraftEntryV5 {
                    target: target.clone(),
                    edit: entry.edit.clone(),
                });
            }
        }
    }
    reconciled.sort_by_key(|entry| entry.target.slot());

    Ok(reconciled)
}

/// Reconciles one file in the production bridge's schema-v5 draft map without persistence.
///
/// The outer map is cloned only after entry reconciliation has fully validated.
pub fn reconcile_metadata_draft_file_v5(
    drafts: &MetadataDraftEditsV5,
    relative_path: &str,
    outcomes: &[MetadataTargetOutcome],
) -> Result<MetadataDraftEditsV5, DraftReconciliationV5Error> {
    let original =
        drafts
            .get(relative_path)
            .ok_or_else(|| DraftReconciliationV5Error::MissingSourceFile {
                relative_path: relative_path.to_owned(),
            })?;
    let reconciled = reconcile_metadata_draft_entries_v5(original, outcomes)?;

    let mut result = drafts.clone();
    if reconciled.is_empty() {
        result.remove(relative_path);
    } else {
        result.insert(relative_path.to_owned(), reconciled);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apply_edits_v5::{MetadataDraftReconciliation, MetadataTargetOutcome};
    use crate::draft_edits::{
        load_metadata_draft_edits_v5, save_metadata_draft_edits_v5, EditIntent, MetadataDraftEdit,
    };
    use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
    use crate::metadata_value::MetadataValue;
    use std::fs;
    use tempfile::tempdir;

    fn schema(tag_id: &str) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: "Exif::Main".to_owned(),
            tag_id: tag_id.to_owned(),
            index: None,
        }
    }

    fn existing_target(
        path: &str,
        group1: &str,
        schema_id: SchemaDefinitionId,
    ) -> MetadataDraftTarget {
        MetadataDraftTarget::ExistingOccurrence {
            occurrence_id: MetadataOccurrenceId {
                document: None,
                path: path.to_owned(),
                tag_id: schema_id.tag_id.clone(),
                copy: 1,
            },
            schema_id,
            write_target: MetadataWriteTarget {
                group1: group1.to_owned(),
                tag_name: "XResolution".to_owned(),
            },
        }
    }

    fn existing_target_with_occurrence_tag(
        path: &str,
        occurrence_tag_id: &str,
        group1: &str,
        schema_id: SchemaDefinitionId,
    ) -> MetadataDraftTarget {
        let mut target = existing_target(path, group1, schema_id);
        let MetadataDraftTarget::ExistingOccurrence { occurrence_id, .. } = &mut target else {
            unreachable!()
        };
        occurrence_id.tag_id = occurrence_tag_id.to_owned();
        target
    }

    fn new_target(schema_id: SchemaDefinitionId) -> MetadataDraftTarget {
        MetadataDraftTarget::NewProperty { schema_id }
    }

    fn edit(label: &str) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(MetadataValue::Text(format!("semantic:{label}"))),
            intent: EditIntent::Set,
            display: Some(format!("display:{label}")),
        }
    }

    fn entry(target: MetadataDraftTarget, label: &str) -> MetadataDraftEntryV5 {
        MetadataDraftEntryV5 {
            target,
            edit: edit(label),
        }
    }

    fn outcome(
        target: MetadataDraftTarget,
        draft_reconciliation: MetadataDraftReconciliation,
    ) -> MetadataTargetOutcome {
        MetadataTargetOutcome {
            target,
            draft_reconciliation,
            display_name: "outcome display".to_owned(),
            kind: "DeliberatelyIgnoredKind".to_owned(),
            sent: Some(MetadataValue::Text("sent must not become edit".to_owned())),
            before: Some(MetadataValue::Text(
                "before must not become edit".to_owned(),
            )),
            observed: Some(MetadataValue::Text(
                "observed must not become edit".to_owned(),
            )),
            message: Some("outcome message".to_owned()),
        }
    }

    fn keep(target: &MetadataDraftTarget) -> MetadataTargetOutcome {
        outcome(target.clone(), MetadataDraftReconciliation::Keep)
    }

    fn clear(target: &MetadataDraftTarget) -> MetadataTargetOutcome {
        outcome(target.clone(), MetadataDraftReconciliation::Clear)
    }

    fn blocked(target: &MetadataDraftTarget) -> MetadataTargetOutcome {
        outcome(
            target.clone(),
            MetadataDraftReconciliation::Blocked {
                reason: "surface this transient reason".to_owned(),
            },
        )
    }

    fn replace(
        target: &MetadataDraftTarget,
        replacement: MetadataDraftTarget,
    ) -> MetadataTargetOutcome {
        outcome(
            target.clone(),
            MetadataDraftReconciliation::Replace {
                target: replacement,
            },
        )
    }

    #[test]
    fn empty_entries_and_outcomes_return_empty() {
        assert_eq!(reconcile_metadata_draft_entries_v5(&[], &[]), Ok(vec![]));
    }

    #[test]
    fn clear_removes_the_original_without_consulting_kind() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "clear");
        let mut outcome = clear(&original.target);
        outcome.kind = "NotMatchOrDeleteOk".to_owned();

        assert_eq!(
            reconcile_metadata_draft_entries_v5(&[original], &[outcome]),
            Ok(vec![])
        );
    }

    #[test]
    fn keep_retains_the_complete_original_entry() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "keep");
        let result = reconcile_metadata_draft_entries_v5(
            std::slice::from_ref(&original),
            &[keep(&original.target)],
        )
        .unwrap();

        assert_eq!(result, vec![original]);
    }

    #[test]
    fn blocked_retains_the_complete_original_entry_without_persisting_reason() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "blocked");
        let result = reconcile_metadata_draft_entries_v5(
            std::slice::from_ref(&original),
            &[blocked(&original.target)],
        )
        .unwrap();

        assert_eq!(result, vec![original]);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("transient reason"));
    }

    #[test]
    fn replace_uses_the_supplied_complete_target_and_original_edit() {
        let original = entry(new_target(schema("282")), "replace-exactly");
        let replacement = existing_target("JPEG-APP1-IFD1", "IFD1", schema("282"));
        let original_edit_bytes = serde_json::to_vec(&original.edit).unwrap();

        let result = reconcile_metadata_draft_entries_v5(
            std::slice::from_ref(&original),
            &[replace(&original.target, replacement.clone())],
        )
        .unwrap();

        assert_eq!(result[0].target, replacement);
        assert_eq!(
            serde_json::to_vec(&result[0].edit).unwrap(),
            original_edit_bytes
        );
    }

    #[test]
    fn replace_never_uses_sent_before_observed_or_display_fields() {
        let original = entry(new_target(schema("282")), "semantic-source");
        let replacement = existing_target("JPEG-APP1-IFD1", "IFD1", schema("282"));
        let mut replacement_outcome = replace(&original.target, replacement);
        replacement_outcome.sent = Some(MetadataValue::Text("wrong sent".to_owned()));
        replacement_outcome.before = Some(MetadataValue::Text("wrong before".to_owned()));
        replacement_outcome.observed = Some(MetadataValue::Text("wrong observed".to_owned()));
        replacement_outcome.display_name = "wrong display".to_owned();

        let result = reconcile_metadata_draft_entries_v5(
            std::slice::from_ref(&original),
            &[replacement_outcome],
        )
        .unwrap();

        assert_eq!(result[0].edit, original.edit);
    }

    #[test]
    fn mixed_states_reconcile_together_and_sort_by_logical_slot() {
        let clear_entry = entry(existing_target("z-clear", "IFD0", schema("100")), "clear");
        let keep_entry = entry(existing_target("b-keep", "IFD1", schema("101")), "keep");
        let blocked_entry = entry(
            existing_target("c-blocked", "ExifIFD", schema("102")),
            "blocked",
        );
        let replace_entry = entry(new_target(schema("103")), "replace");
        let replacement = existing_target("a-replaced", "XMP", schema("103"));
        let original = vec![
            clear_entry.clone(),
            replace_entry.clone(),
            blocked_entry.clone(),
            keep_entry.clone(),
        ];
        let outcomes = vec![
            blocked(&blocked_entry.target),
            clear(&clear_entry.target),
            keep(&keep_entry.target),
            replace(&replace_entry.target, replacement.clone()),
        ];

        let result = reconcile_metadata_draft_entries_v5(&original, &outcomes).unwrap();

        assert_eq!(
            result,
            vec![
                MetadataDraftEntryV5 {
                    target: replacement,
                    edit: replace_entry.edit,
                },
                keep_entry,
                blocked_entry,
            ]
        );
    }

    #[test]
    fn entry_and_outcome_order_do_not_affect_output() {
        let first = entry(existing_target("a", "IFD0", schema("100")), "a");
        let second = entry(existing_target("b", "IFD1", schema("101")), "b");
        let third = entry(new_target(schema("102")), "c");
        let first_order = vec![third.clone(), first.clone(), second.clone()];
        let second_order = vec![second.clone(), third.clone(), first.clone()];
        let outcomes = vec![
            keep(&second.target),
            keep(&third.target),
            keep(&first.target),
        ];
        let reversed_outcomes = outcomes.iter().cloned().rev().collect::<Vec<_>>();

        let expected = reconcile_metadata_draft_entries_v5(&first_order, &outcomes).unwrap();
        assert_eq!(
            reconcile_metadata_draft_entries_v5(&second_order, &outcomes).unwrap(),
            expected
        );
        assert_eq!(
            reconcile_metadata_draft_entries_v5(&first_order, &reversed_outcomes).unwrap(),
            expected
        );
    }

    #[test]
    fn inputs_are_not_mutated() {
        let original = vec![entry(new_target(schema("282")), "immutable")];
        let outcomes = vec![replace(
            &original[0].target,
            existing_target("IFD0", "IFD0", schema("282")),
        )];
        let original_snapshot = original.clone();
        let outcome_snapshot = outcomes.clone();

        reconcile_metadata_draft_entries_v5(&original, &outcomes).unwrap();

        assert_eq!(original, original_snapshot);
        assert_eq!(outcomes, outcome_snapshot);
    }

    #[test]
    fn duplicate_original_existing_slot_rejects() {
        let first = entry(existing_target("IFD0", "IFD0", schema("282")), "first");
        let second = entry(first.target.clone(), "second");

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(&[first, second], &[]),
            Err(DraftReconciliationV5Error::DuplicateOriginalSlot { .. })
        ));
    }

    #[test]
    fn duplicate_original_new_property_slot_rejects() {
        let first = entry(new_target(schema("282")), "first");
        let second = entry(first.target.clone(), "second");

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(&[first, second], &[]),
            Err(DraftReconciliationV5Error::DuplicateOriginalSlot { .. })
        ));
    }

    #[test]
    fn duplicate_outcome_slot_rejects_before_completeness_checks() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "original");
        let outcomes = vec![keep(&original.target), clear(&original.target)];

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(&[original], &outcomes),
            Err(DraftReconciliationV5Error::DuplicateOutcomeSlot { .. })
        ));
    }

    #[test]
    fn missing_outcome_rejects() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "original");

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(&[original], &[]),
            Err(DraftReconciliationV5Error::MissingOutcome { .. })
        ));
    }

    #[test]
    fn unexpected_outcome_rejects_before_missing_outcome() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "original");
        let unexpected = existing_target("IFD1", "IFD1", schema("282"));

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(&[original], &[keep(&unexpected)]),
            Err(DraftReconciliationV5Error::UnexpectedOutcome { .. })
        ));
    }

    #[test]
    fn same_slot_with_changed_outcome_schema_snapshot_rejects() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "original");
        let mut changed = original.target.clone();
        let MetadataDraftTarget::ExistingOccurrence { schema_id, .. } = &mut changed else {
            unreachable!()
        };
        *schema_id = schema("999");

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(&[original], &[keep(&changed)]),
            Err(DraftReconciliationV5Error::OutcomeTargetMismatch { .. })
        ));
    }

    #[test]
    fn same_slot_with_changed_outcome_selector_snapshot_rejects() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "original");
        let mut changed = original.target.clone();
        let MetadataDraftTarget::ExistingOccurrence { write_target, .. } = &mut changed else {
            unreachable!()
        };
        write_target.group1 = "IFD1".to_owned();

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(&[original], &[keep(&changed)]),
            Err(DraftReconciliationV5Error::OutcomeTargetMismatch { .. })
        ));
    }

    #[test]
    fn replacing_an_existing_target_rejects() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "original");
        let replacement = existing_target("IFD1", "IFD1", schema("282"));

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(
                std::slice::from_ref(&original),
                &[replace(&original.target, replacement)]
            ),
            Err(DraftReconciliationV5Error::InvalidReplacementSource { .. })
        ));
    }

    #[test]
    fn replacing_with_a_new_property_or_unchanged_target_rejects() {
        let original = entry(new_target(schema("282")), "original");

        for invalid in [new_target(schema("282")), new_target(schema("283"))] {
            assert!(matches!(
                reconcile_metadata_draft_entries_v5(
                    std::slice::from_ref(&original),
                    &[replace(&original.target, invalid)]
                ),
                Err(DraftReconciliationV5Error::InvalidReplacementSource { .. })
            ));
        }
    }

    #[test]
    fn replacement_schema_mismatch_rejects_without_inference() {
        let original = entry(new_target(schema("282")), "original");
        let replacement = existing_target("IFD0", "IFD0", schema("283"));

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(
                std::slice::from_ref(&original),
                &[replace(&original.target, replacement)]
            ),
            Err(DraftReconciliationV5Error::ReplacementSchemaMismatch { .. })
        ));
    }

    #[test]
    fn replacement_collision_with_retained_entry_rejects_atomically() {
        let retained = entry(existing_target("IFD0", "IFD0", schema("282")), "retained");
        let created = entry(new_target(schema("282")), "created");
        let original = vec![created.clone(), retained.clone()];
        let snapshot = original.clone();
        let result = reconcile_metadata_draft_entries_v5(
            &original,
            &[
                replace(&created.target, retained.target.clone()),
                keep(&retained.target),
            ],
        );

        assert!(matches!(
            result,
            Err(DraftReconciliationV5Error::ReplacementSlotCollision { .. })
        ));
        assert_eq!(original, snapshot);
    }

    #[test]
    fn two_replacements_converging_on_one_occurrence_slot_reject() {
        let first = entry(new_target(schema("282")), "first");
        let second = entry(new_target(schema("283")), "second");
        let first_replacement = existing_target_with_occurrence_tag(
            "shared-slot",
            "shared-runtime-id",
            "IFD0",
            schema("282"),
        );
        let second_replacement = existing_target_with_occurrence_tag(
            "shared-slot",
            "shared-runtime-id",
            "IFD1",
            schema("283"),
        );

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(
                &[first.clone(), second.clone()],
                &[
                    replace(&first.target, first_replacement),
                    replace(&second.target, second_replacement),
                ]
            ),
            Err(DraftReconciliationV5Error::ReplacementSlotCollision { .. })
        ));
    }

    #[test]
    fn replacement_collision_with_an_original_clear_slot_rejects() {
        let cleared = entry(existing_target("IFD0", "IFD0", schema("282")), "clear");
        let created = entry(new_target(schema("282")), "created");

        assert!(matches!(
            reconcile_metadata_draft_entries_v5(
                &[created.clone(), cleared.clone()],
                &[
                    replace(&created.target, cleared.target.clone()),
                    clear(&cleared.target),
                ]
            ),
            Err(DraftReconciliationV5Error::ReplacementSlotCollision { .. })
        ));
    }

    #[test]
    fn shared_schema_ifd0_ifd1_slots_remain_independent() {
        let shared_schema = schema("282");
        let ifd0 = entry(
            existing_target("JPEG-APP1-IFD0", "IFD0", shared_schema.clone()),
            "ifd0",
        );
        let ifd1 = entry(
            existing_target("JPEG-APP1-IFD1", "IFD1", shared_schema.clone()),
            "ifd1",
        );
        let created = entry(new_target(shared_schema.clone()), "created");
        let created_replacement =
            existing_target("JPEG-APP1-ExifIFD", "ExifIFD", shared_schema.clone());

        assert_ne!(ifd0.target.slot(), ifd1.target.slot());
        let result = reconcile_metadata_draft_entries_v5(
            &[created.clone(), ifd1.clone(), ifd0.clone()],
            &[
                replace(&created.target, created_replacement.clone()),
                keep(&ifd1.target),
                clear(&ifd0.target),
            ],
        )
        .unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.contains(&ifd1));
        assert!(result.contains(&MetadataDraftEntryV5 {
            target: created_replacement,
            edit: created.edit,
        }));
        assert!(!result.iter().any(|item| item.target == ifd0.target));
    }

    #[test]
    fn map_helper_reconciles_one_file_and_preserves_unrelated_files() {
        let selected = entry(
            existing_target("selected", "IFD0", schema("100")),
            "selected",
        );
        let unrelated = vec![entry(
            existing_target("unrelated", "IFD1", schema("101")),
            "unrelated",
        )];
        let unrelated_bytes = serde_json::to_vec(&unrelated).unwrap();
        let drafts = MetadataDraftEditsV5::from([
            ("selected.jpg".to_owned(), vec![selected.clone()]),
            ("unrelated.jpg".to_owned(), unrelated),
        ]);
        let source_snapshot = drafts.clone();

        let result =
            reconcile_metadata_draft_file_v5(&drafts, "selected.jpg", &[blocked(&selected.target)])
                .unwrap();

        assert_eq!(result["selected.jpg"], vec![selected]);
        assert_eq!(
            serde_json::to_vec(&result["unrelated.jpg"]).unwrap(),
            unrelated_bytes
        );
        assert_eq!(drafts, source_snapshot);
    }

    #[test]
    fn map_helper_removes_an_emptied_file_but_retains_nonempty_file() {
        let removed = entry(existing_target("removed", "IFD0", schema("100")), "removed");
        let retained = entry(
            existing_target("retained", "IFD1", schema("101")),
            "retained",
        );
        let drafts = MetadataDraftEditsV5::from([
            ("removed.jpg".to_owned(), vec![removed.clone()]),
            ("retained.jpg".to_owned(), vec![retained.clone()]),
        ]);

        let result =
            reconcile_metadata_draft_file_v5(&drafts, "removed.jpg", &[clear(&removed.target)])
                .unwrap();

        assert!(!result.contains_key("removed.jpg"));
        assert_eq!(result["retained.jpg"], vec![retained]);
    }

    #[test]
    fn map_helper_missing_file_and_failed_reconciliation_are_atomic() {
        let selected = entry(
            existing_target("selected", "IFD0", schema("100")),
            "selected",
        );
        let drafts =
            MetadataDraftEditsV5::from([("selected.jpg".to_owned(), vec![selected.clone()])]);
        let snapshot = drafts.clone();

        assert!(matches!(
            reconcile_metadata_draft_file_v5(&drafts, "missing.jpg", &[]),
            Err(DraftReconciliationV5Error::MissingSourceFile { .. })
        ));
        assert!(matches!(
            reconcile_metadata_draft_file_v5(&drafts, "selected.jpg", &[]),
            Err(DraftReconciliationV5Error::MissingOutcome { .. })
        ));
        assert_eq!(drafts, snapshot);
    }

    #[test]
    fn proto_relative_path_is_reconciled_normally() {
        let original = entry(existing_target("IFD0", "IFD0", schema("282")), "proto");
        let drafts = MetadataDraftEditsV5::from([("__proto__".to_owned(), vec![original.clone()])]);

        let result =
            reconcile_metadata_draft_file_v5(&drafts, "__proto__", &[keep(&original.target)])
                .unwrap();

        assert_eq!(result["__proto__"], vec![original]);
    }

    #[test]
    fn outer_map_insertion_order_does_not_affect_reconciled_contents() {
        let selected = entry(
            existing_target("selected", "IFD0", schema("100")),
            "selected",
        );
        let other = entry(existing_target("other", "IFD1", schema("101")), "other");
        let first = MetadataDraftEditsV5::from([
            ("selected.jpg".to_owned(), vec![selected.clone()]),
            ("other.jpg".to_owned(), vec![other.clone()]),
        ]);
        let second = MetadataDraftEditsV5::from([
            ("other.jpg".to_owned(), vec![other]),
            ("selected.jpg".to_owned(), vec![selected.clone()]),
        ]);
        let outcomes = [keep(&selected.target)];

        assert_eq!(
            reconcile_metadata_draft_file_v5(&first, "selected.jpg", &outcomes).unwrap()
                ["selected.jpg"],
            reconcile_metadata_draft_file_v5(&second, "selected.jpg", &outcomes).unwrap()
                ["selected.jpg"]
        );
    }

    #[test]
    fn reconciled_map_round_trips_with_exact_targets_edits_and_ordering() {
        let cleared = entry(
            existing_target("z-cleared", "IFD0", schema("100")),
            "cleared",
        );
        let kept = entry(existing_target("b-kept", "IFD1", schema("101")), "kept");
        let blocked_entry = entry(
            existing_target("c-blocked", "ExifIFD", schema("102")),
            "blocked",
        );
        let created = entry(new_target(schema("103")), "created");
        let replacement = existing_target("a-replacement", "XMP", schema("103"));
        let drafts = MetadataDraftEditsV5::from([(
            "album/photo.jpg".to_owned(),
            vec![
                cleared.clone(),
                created.clone(),
                blocked_entry.clone(),
                kept.clone(),
            ],
        )]);
        let reconciled = reconcile_metadata_draft_file_v5(
            &drafts,
            "album/photo.jpg",
            &[
                blocked(&blocked_entry.target),
                replace(&created.target, replacement.clone()),
                clear(&cleared.target),
                keep(&kept.target),
            ],
        )
        .unwrap();

        let first_dir = tempdir().unwrap();
        save_metadata_draft_edits_v5(first_dir.path().to_str().unwrap(), &reconciled).unwrap();
        let loaded = load_metadata_draft_edits_v5(first_dir.path().to_str().unwrap()).unwrap();
        assert_eq!(loaded, reconciled);

        let loaded_entries = &loaded["album/photo.jpg"];
        assert!(!loaded_entries
            .iter()
            .any(|item| item.target == cleared.target));
        assert!(loaded_entries.contains(&kept));
        assert!(loaded_entries.contains(&blocked_entry));
        assert!(loaded_entries.contains(&MetadataDraftEntryV5 {
            target: replacement,
            edit: created.edit,
        }));

        let first_text =
            fs::read_to_string(first_dir.path().join("MediaLibraryDraftEdits.jsonl")).unwrap();
        let data_line = first_text
            .lines()
            .find(|line| !line.starts_with("//"))
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(data_line).unwrap();
        assert_eq!(json["relative_path"], "album/photo.jpg");
        assert!(json["edits"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["target"].get("relative_path").is_none()));

        let second_dir = tempdir().unwrap();
        save_metadata_draft_edits_v5(second_dir.path().to_str().unwrap(), &loaded).unwrap();
        let second_text =
            fs::read_to_string(second_dir.path().join("MediaLibraryDraftEdits.jsonl")).unwrap();
        assert_eq!(second_text, first_text);
    }

    #[test]
    fn public_types_barrel_exports_both_reconciliation_types() {
        let types = include_str!("../../src/types.ts");
        assert!(types.contains(
            "export type { MetadataDraftReconciliation } from \"./types/generated/MetadataDraftReconciliation\";"
        ));
        assert!(types.contains(
            "export type { MetadataTargetOutcome } from \"./types/generated/MetadataTargetOutcome\";"
        ));
    }

    #[test]
    fn error_messages_include_slots_and_complete_targets() {
        let first = entry(existing_target("IFD0", "IFD0", schema("282")), "first");
        let second = entry(first.target.clone(), "second");
        let error = reconcile_metadata_draft_entries_v5(&[first, second], &[]).unwrap_err();
        let message = error.to_string();

        assert!(message.contains("ExistingOccurrence"));
        assert!(message.contains("IFD0"));
        assert!(message.contains("first target"));
        assert!(message.contains("second target"));
    }
}
