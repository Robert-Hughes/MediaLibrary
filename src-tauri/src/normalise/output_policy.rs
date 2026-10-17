//! Shared estimate/run output eligibility. Comparison still sees every input;
//! only absent unwritable outputs are optional. Existing mismatches block a group.
use super::{GroupOutput, NormaliseGroup, NormaliseRequestItem, PerFileStats};
use crate::{draft_edits::EditIntent, tag_schema::MetadataWriteOperation};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct NormaliseBlockedField {
    pub relative_path: String,
    pub group: NormaliseGroup,
    pub schema_id: crate::tag_schema::SchemaDefinitionId,
    pub field: String,
    pub reason: String,
}

pub(super) fn filter_output(
    item: &NormaliseRequestItem,
    group: NormaliseGroup,
    output: Option<GroupOutput>,
    stats: &mut PerFileStats,
) -> Option<GroupOutput> {
    let mut output = output?;
    let registry = crate::tag_schema::get_registry();
    let mut blocked = false;
    output.edits.retain(|schema, edit| {
        let snapshot = item.group_inputs.effective_outputs.as_ref();
        let current = snapshot.and_then(|fields| fields.iter().find(|f| &f.schema_id == schema));
        // A matching read-only field needs no write. Preserve unknown presence
        // in old requests rather than guessing that a field is absent.
        if current.is_some_and(|f| edit.intent == EditIntent::Set && edit.value.as_ref() == Some(&f.value)) {
            return false;
        }
        let operation = if edit.intent == EditIntent::Delete {
            MetadataWriteOperation::DeleteExisting
        } else {
            MetadataWriteOperation::Set
        };
        let info = registry.as_ref().ok().and_then(|registry| registry.lookup(schema));
        let reason = match info {
            Some(info) => info.metadata_write_eligibility(&item.rel_path, operation).err().map(|e| e.to_string()),
            None => Some("The exact output schema is unavailable".into()),
        };
        let Some(reason) = reason else { return true; };
        let field = info.map(|i| i.display_name()).unwrap_or_else(|| format!("{}:{}", schema.table, schema.tag_id));
        if info.is_some() && snapshot.is_some() && current.is_none() {
            log::info!("[normalise] output_skipped path={} group={} field={} schema={:?} operation={:?} reason=absent_unwritable detail={}", item.rel_path, group.as_wire(), field, schema, operation, reason);
        } else {
            log::warn!("[normalise] group_blocked path={} group={} field={} schema={:?} operation={:?} reason={}", item.rel_path, group.as_wire(), field, schema, operation, reason);
            stats.blocked_fields.push(NormaliseBlockedField {
                relative_path: item.rel_path.clone(), group, schema_id: schema.clone(), field,
                reason: if snapshot.is_none() { format!("{reason}; effective field presence is unavailable, reopen normalization") } else { reason },
            });
            blocked = true;
        }
        false
    });
    if blocked {
        stats.group(group).n_blocked = 1;
        None
    } else if output.edits.is_empty() {
        None
    } else {
        Some(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{known_ids as id, metadata_value::MetadataValue, normalise::*};

    fn item() -> NormaliseRequestItem {
        NormaliseRequestItem {
            rel_path: "animation.gif".into(),
            group_inputs: GroupInputs {
                effective_outputs: Some(Vec::new()),
                ..Default::default()
            },
        }
    }
    fn output() -> GroupOutput {
        GroupOutput {
            edits: [
                (id::xmp_title(), lang_alt_edit("New Title".into())),
                (id::iptc_object_name(), text_edit("New Title".into())),
            ]
            .into_iter()
            .collect(),
        }
    }

    #[test]
    fn absent_unwritable_outputs_are_logged_without_values_and_writable_outputs_survive() {
        let item = item();
        let mut stats = PerFileStats::default();
        let (result, logs) = crate::test_logging::capture(|| {
            filter_output(&item, NormaliseGroup::Title, Some(output()), &mut stats)
        });
        let result = result.unwrap();
        assert_eq!(result.edits.len(), 1);
        assert!(result.edits.contains_key(&id::xmp_title()));
        assert!(stats.blocked_fields.is_empty());
        let log = logs.iter().find(|l| l.contains("output_skipped")).unwrap();
        for text in [
            "animation.gif",
            "group=title",
            "ObjectName",
            "absent_unwritable",
            "not supported by this file format",
        ] {
            assert!(log.contains(text), "{log}");
        }
        assert!(!log.contains("New Title"));
    }

    #[test]
    fn matching_unwritable_field_is_not_a_blocker_but_existing_empty_mismatch_is() {
        let mut item = item();
        item.group_inputs.effective_outputs = Some(vec![EffectiveNormaliseOutput {
            schema_id: id::iptc_object_name(),
            value: MetadataValue::Text("New Title".into()),
        }]);
        let mut stats = PerFileStats::default();
        assert!(filter_output(&item, NormaliseGroup::Title, Some(output()), &mut stats).is_some());
        assert!(stats.blocked_fields.is_empty());
        item.group_inputs.effective_outputs.as_mut().unwrap()[0].value =
            MetadataValue::Text(String::new());
        assert!(filter_output(&item, NormaliseGroup::Title, Some(output()), &mut stats).is_none());
        assert_eq!(stats.group(NormaliseGroup::Title).n_blocked, 1);
        assert_eq!(stats.blocked_fields.len(), 1);
    }

    #[test]
    fn missing_effective_snapshot_fails_closed_for_unwritable_outputs() {
        let mut item = item();
        item.group_inputs.effective_outputs = None;
        let mut stats = PerFileStats::default();
        assert!(filter_output(&item, NormaliseGroup::Title, Some(output()), &mut stats).is_none());
        assert!(stats.blocked_fields[0]
            .reason
            .contains("presence is unavailable"));
    }

    #[tokio::test]
    async fn gif_keywords_only_stages_xmp_and_does_not_make_iptc_utf8_applicable() {
        let mut item = item();
        item.group_inputs.keywords = Some(KeywordsInput {
            dc_subject: vec!["Cat".into()],
            ..Default::default()
        });
        item.group_inputs.iptc_utf8 = Some(IptcUtf8Input::default());
        let (edits, stats, error, _) = process_item(
            &item,
            &[NormaliseGroup::Keywords, NormaliseGroup::IptcUtf8],
            None,
            None,
        )
        .await;
        assert!(error.is_none());
        assert_eq!(edits.len(), 2);
        assert!(edits.contains_key(&id::xmp_subject()));
        assert!(edits.contains_key(&id::xmp_hierarchical_subject()));
        assert!(stats.iptc_output_groups.is_empty());
        assert_eq!(stats.per_group[&NormaliseGroup::IptcUtf8].n_noop, 1);
        item.group_inputs.keywords = Some(KeywordsInput {
            dc_subject: vec!["cat".into()],
            hierarchical_subject: vec!["cat".into()],
            ..Default::default()
        });
        item.group_inputs.effective_outputs = Some(
            edits
                .into_iter()
                .map(|(schema_id, edit)| EffectiveNormaliseOutput {
                    schema_id,
                    value: edit.value.unwrap(),
                })
                .collect(),
        );
        let (again, stats, error, _) = process_item(
            &item,
            &[NormaliseGroup::Keywords, NormaliseGroup::IptcUtf8],
            None,
            None,
        )
        .await;
        assert!(again.is_empty());
        assert!(error.is_none());
        assert_eq!(stats.per_group[&NormaliseGroup::Keywords].n_noop, 1);
    }

    #[tokio::test]
    async fn blocked_group_stages_nothing_but_independent_group_proceeds() {
        let mut item = item();
        item.group_inputs.title = Some(TitleInput {
            title: Some("New Title".into()),
            object_name: Some("Old Title".into()),
            ..Default::default()
        });
        item.group_inputs.effective_outputs = Some(vec![EffectiveNormaliseOutput {
            schema_id: id::iptc_object_name(),
            value: MetadataValue::Text("Old Title".into()),
        }]);
        item.group_inputs.keywords = Some(KeywordsInput {
            dc_subject: vec!["Cat".into()],
            ..Default::default()
        });
        let (edits, stats, _, _) = process_item(
            &item,
            &[NormaliseGroup::Title, NormaliseGroup::Keywords],
            None,
            None,
        )
        .await;
        assert_eq!(edits.len(), 2);
        assert!(!edits.contains_key(&id::xmp_title()));
        assert!(!edits.contains_key(&id::iptc_object_name()));
        assert_eq!(stats.per_group[&NormaliseGroup::Title].n_blocked, 1);
        assert_eq!(stats.per_group[&NormaliseGroup::Title].n_noop, 0);
        assert_eq!(
            stats.per_group[&NormaliseGroup::Title].n_normalised_deterministic,
            0
        );
        let mut summary = NormaliseSummary::default();
        summary.accumulate(&stats);
        assert_eq!(summary.per_group[&NormaliseGroup::Title].n_blocked, 1);
    }

    #[tokio::test]
    async fn gif_filename_date_does_not_claim_an_unwritable_exif_date_was_filled() {
        let mut item = item();
        item.group_inputs.dates = Some(DatesInput {
            file_stem: Some("20200204_162143_001-ANIMATION".into()),
            ..Default::default()
        });
        let (edits, stats, error, _) =
            process_item(&item, &[NormaliseGroup::Dates], None, None).await;
        assert!(error.is_none());
        assert_eq!(edits.len(), 1);
        assert!(edits.contains_key(&id::xmp_date_created()));
        let dates = &stats.per_group[&NormaliseGroup::Dates];
        assert_eq!(dates.n_normalised_deterministic, 1);
        assert_eq!(dates.n_dto_from_filename, 0);
        assert_eq!(dates.n_dto_from_filename_date_only, 0);
    }
}
