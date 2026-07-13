//! Inactive schema-v5, occurrence-aware single-file apply foundation.
//!
//! No production command invokes this module. Production `apply_edits.rs`
//! remains schema-v4 and schema-keyed. Existing-occurrence targets are read,
//! written and verified only by exact [`MetadataOccurrenceId`]. New-property
//! targets use explicit zero/one/multiple exact-schema resolution after the
//! write. Choosing a first, lowest, `Copy0`, `IFD0`, writable, or otherwise
//! preferred occurrence is forbidden.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::draft_edits::{EditIntent, MetadataDraftEdit, MetadataDraftEntryV5};
use crate::metadata_draft_target::{MetadataDraftSlot, MetadataDraftTarget};
use crate::metadata_occurrence::{MetadataOccurrence, MetadataOccurrenceId, MetadataWriteTarget};
use crate::metadata_value::MetadataValue;
use crate::metadata_write_execution::{
    build_exiftool_write_argfile_args, format_apply_diagnostics, render_exiftool_argfile,
    run_exiftool_write,
};
use crate::scanner;
use crate::tag_schema::{SchemaDefinitionId, TagInfo, TagKind};
use crate::write_args::BuiltArgs;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataTargetOutcome {
    pub target: MetadataDraftTarget,
    pub display_name: String,
    pub kind: String,
    pub sent: Option<MetadataValue>,
    pub before: Option<MetadataValue>,
    pub observed: Option<MetadataValue>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MetadataSingleFileOutcomeV5 {
    pub fresh_image_metadata: Option<scanner::ImageMetadata>,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub outcomes: Vec<MetadataTargetOutcome>,
    pub targets_to_clear: Vec<MetadataDraftTarget>,
}

impl MetadataSingleFileOutcomeV5 {
    fn hard_failure(error: ApplyV5Error) -> Self {
        Self {
            fresh_image_metadata: None,
            error: Some(error.to_string()),
            warning: None,
            outcomes: Vec::new(),
            targets_to_clear: Vec::new(),
        }
    }
}

pub(crate) trait MetadataTargetWriteClient {
    fn read_image_metadata(
        &self,
        rel_path: &str,
        abs_path: &Path,
    ) -> Result<scanner::ImageMetadata, String>;

    fn write_metadata(&self, numeric: bool, rendered_contents: &str) -> Result<(), String>;
}

struct RealMetadataTargetWriteClient;

impl MetadataTargetWriteClient for RealMetadataTargetWriteClient {
    fn read_image_metadata(
        &self,
        rel_path: &str,
        abs_path: &Path,
    ) -> Result<scanner::ImageMetadata, String> {
        let outcome =
            scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path.to_path_buf()])
                .map_err(|error| format!("authoritative metadata batch read failed: {error}"))?;

        let mut results = outcome
            .results
            .into_iter()
            .filter(|result| result.relative_path == rel_path);
        let result = results.next();
        if results.next().is_some() {
            return Err(format!(
                "authoritative metadata read returned duplicate results for {rel_path}"
            ));
        }
        if let Some(result) = result {
            // Legacy projection omissions are intentionally ignored: the
            // authoritative occurrence collection above remains complete.
            return Ok(result);
        }

        let failures = outcome
            .failures
            .into_iter()
            .filter(|failure| failure.relative_path == rel_path)
            .map(|failure| failure.error_message)
            .collect::<Vec<_>>();
        if !failures.is_empty() {
            return Err(format!(
                "authoritative metadata read failed for {rel_path}: {}",
                failures.join("; ")
            ));
        }

        Err(format!(
            "authoritative metadata read returned neither a result nor a failure for {rel_path} (impossible outcome)"
        ))
    }

    fn write_metadata(&self, numeric: bool, rendered_contents: &str) -> Result<(), String> {
        run_exiftool_write(rendered_contents, numeric)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ApplyV5Error {
    NoEdits,
    FileMissing(String),
    PreWriteReadFailure(String),
    DuplicateDraftSlot {
        slot: Box<MetadataDraftSlot>,
        first: Box<MetadataDraftTarget>,
        second: Box<MetadataDraftTarget>,
    },
    DuplicatePreWriteOccurrenceId(Box<MetadataOccurrenceId>),
    PostWriteDuplicateOccurrenceId {
        occurrence_id: Box<MetadataOccurrenceId>,
    },
    ExistingOccurrenceMissing(Box<MetadataDraftTarget>),
    ExistingTargetValidationFailure {
        target: Box<MetadataDraftTarget>,
        reason: String,
    },
    NewPropertySchemaMissing(Box<MetadataDraftTarget>),
    NewPropertySchemaReadOnly(Box<MetadataDraftTarget>),
    NewPropertyAlreadyExists {
        target: Box<MetadataDraftTarget>,
        occurrences: Vec<MetadataOccurrenceId>,
    },
    UnsupportedNewPropertyIntent {
        target: Box<MetadataDraftTarget>,
        intent: EditIntent,
    },
    WriteSelectorCollision {
        group: String,
        tag_name: String,
        first: Box<MetadataDraftTarget>,
        second: Box<MetadataDraftTarget>,
    },
    ArgumentPlanningFailure {
        target: Box<MetadataDraftTarget>,
        reason: String,
    },
    ArgfileRenderingFailure(String),
    NoWriteArguments,
}

impl std::fmt::Display for ApplyV5Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoEdits => formatter.write_str("No edits to apply"),
            Self::FileMissing(path) => write!(formatter, "File not found: {path}"),
            Self::PreWriteReadFailure(reason) => {
                write!(formatter, "Authoritative pre-write read failed: {reason}")
            }
            Self::DuplicateDraftSlot { slot, first, second } => write!(
                formatter,
                "Duplicate draft slot {slot:?}: conflicting targets {first:?} and {second:?}"
            ),
            Self::DuplicatePreWriteOccurrenceId(id) => write!(
                formatter,
                "Authoritative pre-write metadata contains duplicate occurrence ID {id:?}"
            ),
            Self::PostWriteDuplicateOccurrenceId { occurrence_id } => write!(
                formatter,
                "Authoritative post-write metadata contains duplicate exact occurrence ID {occurrence_id:?}"
            ),
            Self::ExistingOccurrenceMissing(target) => write!(
                formatter,
                "Existing target {target:?} is absent from authoritative pre-write metadata"
            ),
            Self::ExistingTargetValidationFailure { target, reason } => write!(
                formatter,
                "Existing target validation failed for {target:?}: {reason}"
            ),
            Self::NewPropertySchemaMissing(target) => {
                write!(formatter, "New-property schema is missing for {target:?}")
            }
            Self::NewPropertySchemaReadOnly(target) => {
                write!(formatter, "New-property schema is read-only for {target:?}")
            }
            Self::NewPropertyAlreadyExists {
                target,
                occurrences,
            } => write!(
                formatter,
                "New-property target {target:?} already has exact-schema occurrences {occurrences:?}"
            ),
            Self::UnsupportedNewPropertyIntent { target, intent } => write!(
                formatter,
                "New-property target {target:?} does not support creation intent {intent:?}"
            ),
            Self::WriteSelectorCollision {
                group,
                tag_name,
                first,
                second,
            } => write!(
                formatter,
                "Write-selector collision for {group}:{tag_name}: targets {first:?} and {second:?}"
            ),
            Self::ArgumentPlanningFailure { target, reason } => write!(
                formatter,
                "Argument planning failed for target {target:?}: {reason}"
            ),
            Self::ArgfileRenderingFailure(reason) => {
                write!(formatter, "ExifTool argfile rendering failed: {reason}")
            }
            Self::NoWriteArguments => {
                formatter.write_str("Target-aware planning produced no ExifTool write arguments")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SelectorKey {
    group: String,
    tag_name: String,
}

impl SelectorKey {
    fn new(group: &str, tag_name: &str) -> Self {
        Self {
            group: group.to_ascii_lowercase(),
            tag_name: tag_name.to_ascii_lowercase(),
        }
    }
}

#[derive(Clone)]
struct TargetPlan {
    target: MetadataDraftTarget,
    edit: MetadataDraftEdit,
    display_name: String,
    kind: TagKind,
    before: Option<MetadataValue>,
    selector: MetadataWriteTarget,
    args: BuiltArgs,
}

struct PlannedBatch {
    targets: Vec<TargetPlan>,
    numeric_argfile: Option<String>,
    text_argfile: Option<String>,
}

fn plan_batch<F>(
    abs_path: &Path,
    edits: &[MetadataDraftEntryV5],
    before: &scanner::ImageMetadata,
    schema_lookup: F,
) -> Result<PlannedBatch, ApplyV5Error>
where
    F: Fn(&SchemaDefinitionId) -> Option<TagInfo>,
{
    let mut occupied_slots = BTreeMap::<MetadataDraftSlot, MetadataDraftTarget>::new();
    for entry in edits {
        let slot = entry.target.slot();
        if let Some(first) = occupied_slots.insert(slot.clone(), entry.target.clone()) {
            return Err(ApplyV5Error::DuplicateDraftSlot {
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
            return Err(ApplyV5Error::DuplicatePreWriteOccurrenceId(Box::new(
                occurrence.id.clone(),
            )));
        }
    }

    let mut plans = Vec::with_capacity(edits.len());
    let mut selectors = BTreeMap::<SelectorKey, MetadataDraftTarget>::new();
    let mut combined = BuiltArgs::default();

    for entry in edits {
        let plan = match &entry.target {
            MetadataDraftTarget::ExistingOccurrence { occurrence_id, .. } => {
                let occurrence = occurrences.get(occurrence_id).copied().ok_or_else(|| {
                    ApplyV5Error::ExistingOccurrenceMissing(Box::new(entry.target.clone()))
                })?;
                entry
                    .target
                    .validate_existing_occurrence(occurrence)
                    .map_err(|error| ApplyV5Error::ExistingTargetValidationFailure {
                        target: Box::new(entry.target.clone()),
                        reason: error.to_string(),
                    })?;
                let info = occurrence.tag_info.as_ref().expect("validated schema");
                let selector = occurrence
                    .write_target
                    .as_ref()
                    .expect("validated selector");
                let args = crate::write_args::build_existing_occurrence_args(
                    &entry.target,
                    occurrence,
                    &entry.edit,
                )
                .map_err(|error| ApplyV5Error::ArgumentPlanningFailure {
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
                }
            }
            MetadataDraftTarget::NewProperty { schema_id } => {
                let info = schema_lookup(schema_id).ok_or_else(|| {
                    ApplyV5Error::NewPropertySchemaMissing(Box::new(entry.target.clone()))
                })?;
                if !info.writable {
                    return Err(ApplyV5Error::NewPropertySchemaReadOnly(Box::new(
                        entry.target.clone(),
                    )));
                }
                let existing = before
                    .occurrences
                    .for_schema(schema_id)
                    .map(|occurrence| occurrence.id.clone())
                    .collect::<Vec<_>>();
                if !existing.is_empty() {
                    return Err(ApplyV5Error::NewPropertyAlreadyExists {
                        target: Box::new(entry.target.clone()),
                        occurrences: existing,
                    });
                }
                if matches!(
                    entry.edit.intent,
                    EditIntent::Delete | EditIntent::ListRemove
                ) {
                    return Err(ApplyV5Error::UnsupportedNewPropertyIntent {
                        target: Box::new(entry.target.clone()),
                        intent: entry.edit.intent.clone(),
                    });
                }
                let args =
                    crate::write_args::build_new_property_args(&entry.target, &info, &entry.edit)
                        .map_err(|error| ApplyV5Error::ArgumentPlanningFailure {
                        target: Box::new(entry.target.clone()),
                        reason: error.to_string(),
                    })?;
                TargetPlan {
                    target: entry.target.clone(),
                    edit: entry.edit.clone(),
                    display_name: info.display_name(),
                    kind: info.kind.clone(),
                    before: None,
                    selector: MetadataWriteTarget {
                        group1: info.group,
                        tag_name: info.name,
                    },
                    args,
                }
            }
        };

        let selector_key = SelectorKey::new(&plan.selector.group1, &plan.selector.tag_name);
        if let Some(first) = selectors.insert(selector_key, plan.target.clone()) {
            return Err(ApplyV5Error::WriteSelectorCollision {
                group: plan.selector.group1.clone(),
                tag_name: plan.selector.tag_name.clone(),
                first: Box::new(first),
                second: Box::new(plan.target.clone()),
            });
        }
        combined.extend(plan.args.clone());
        plans.push(plan);
    }

    if combined.is_empty() {
        return Err(ApplyV5Error::NoWriteArguments);
    }

    let numeric_argfile = (!combined.numeric.is_empty())
        .then(|| {
            build_exiftool_write_argfile_args(abs_path, &combined.numeric, true)
                .and_then(|args| render_exiftool_argfile(&args))
        })
        .transpose()
        .map_err(ApplyV5Error::ArgfileRenderingFailure)?;
    let text_argfile = (!combined.text.is_empty())
        .then(|| {
            build_exiftool_write_argfile_args(abs_path, &combined.text, false)
                .and_then(|args| render_exiftool_argfile(&args))
        })
        .transpose()
        .map_err(ApplyV5Error::ArgfileRenderingFailure)?;

    Ok(PlannedBatch {
        targets: plans,
        numeric_argfile,
        text_argfile,
    })
}

pub fn apply_single_file_metadata_v5(
    folder_path: &str,
    rel_path: &str,
    edits: &[MetadataDraftEntryV5],
) -> MetadataSingleFileOutcomeV5 {
    let registry = crate::tag_schema::get_registry().ok();
    apply_single_file_metadata_v5_with_client(
        folder_path,
        rel_path,
        edits,
        &RealMetadataTargetWriteClient,
        |id| registry.and_then(|value| value.lookup(id)).cloned(),
    )
}

fn apply_single_file_metadata_v5_with_client<C, F>(
    folder_path: &str,
    rel_path: &str,
    edits: &[MetadataDraftEntryV5],
    client: &C,
    schema_lookup: F,
) -> MetadataSingleFileOutcomeV5
where
    C: MetadataTargetWriteClient,
    F: Fn(&SchemaDefinitionId) -> Option<TagInfo>,
{
    if edits.is_empty() {
        return MetadataSingleFileOutcomeV5::hard_failure(ApplyV5Error::NoEdits);
    }

    let abs_path =
        Path::new(folder_path).join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !abs_path.exists() {
        return MetadataSingleFileOutcomeV5::hard_failure(ApplyV5Error::FileMissing(
            abs_path.display().to_string(),
        ));
    }

    let before = match client.read_image_metadata(rel_path, &abs_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return MetadataSingleFileOutcomeV5::hard_failure(ApplyV5Error::PreWriteReadFailure(
                error,
            ));
        }
    };

    let planned = match plan_batch(&abs_path, edits, &before, schema_lookup) {
        Ok(planned) => planned,
        Err(error) => return MetadataSingleFileOutcomeV5::hard_failure(error),
    };

    let mut numeric_attempted = false;
    let mut numeric_result = Ok(());
    if let Some(contents) = &planned.numeric_argfile {
        numeric_attempted = true;
        numeric_result = client.write_metadata(true, contents);
    }

    let mut text_attempted = false;
    let mut text_result = Ok(());
    if numeric_result.is_ok() {
        if let Some(contents) = &planned.text_argfile {
            text_attempted = true;
            text_result = client.write_metadata(false, contents);
        }
    }

    let write_failure = match (
        numeric_attempted,
        &numeric_result,
        text_attempted,
        &text_result,
    ) {
        (true, Err(error), _, _) => Some(format!("numeric pass failed: {error}")),
        (_, _, true, Err(error)) => Some(format!("text pass failed: {error}")),
        _ => None,
    };

    let fresh = match client.read_image_metadata(rel_path, &abs_path) {
        Ok(metadata) => metadata,
        Err(read_error) => {
            let error = match &write_failure {
                Some(write_error) => format!(
                    "ExifTool write failed ({write_error}) and authoritative post-write readback failed ({read_error}); file contents could not be verified."
                ),
                None => format!("Authoritative post-write readback failed: {read_error}"),
            };
            let outcomes = planned
                .targets
                .into_iter()
                .map(|plan| MetadataTargetOutcome {
                    target: plan.target,
                    display_name: plan.display_name,
                    kind: "ReadbackFailed".to_string(),
                    sent: plan.edit.value,
                    before: plan.before,
                    observed: None,
                    message: Some(format!(
                        "Verification could not be completed because authoritative post-write readback failed: {read_error}"
                    )),
                })
                .collect();
            return MetadataSingleFileOutcomeV5 {
                fresh_image_metadata: None,
                error: Some(error),
                warning: None,
                outcomes,
                targets_to_clear: Vec::new(),
            };
        }
    };

    let post_by_id = match build_strict_post_write_occurrence_index(&fresh) {
        Ok(index) => index,
        Err(invariant_error) => {
            let invariant_message = invariant_error.to_string();
            let error = match &write_failure {
                Some(write_error) => format!(
                    "ExifTool write failed ({write_error}) and post-write readback was invalid ({invariant_message}); file contents could not be verified."
                ),
                None => format!("Post-write readback was invalid: {invariant_message}"),
            };
            let outcomes = planned
                .targets
                .into_iter()
                .map(|plan| MetadataTargetOutcome {
                    target: plan.target,
                    display_name: plan.display_name,
                    kind: "ReadbackInvalid".to_string(),
                    sent: plan.edit.value,
                    before: plan.before,
                    observed: None,
                    message: Some(format!(
                        "Verification was not attempted because {invariant_message}"
                    )),
                })
                .collect();
            return MetadataSingleFileOutcomeV5 {
                fresh_image_metadata: None,
                error: Some(error),
                warning: None,
                outcomes,
                targets_to_clear: Vec::new(),
            };
        }
    };

    let mut outcomes = Vec::with_capacity(planned.targets.len());
    let mut targets_to_clear = Vec::new();
    let mut cleared_slots = BTreeSet::new();
    let mut first_mismatch = None;

    for plan in planned.targets {
        let (kind, mut message, observed) = verify_plan(&plan, &post_by_id);
        if matches!(kind.as_str(), "Match" | "DeleteOk") {
            if cleared_slots.insert(plan.target.slot()) {
                targets_to_clear.push(plan.target.clone());
            }
        } else {
            if let Some(write_error) = &write_failure {
                message = Some(match message {
                    Some(current) => {
                        format!("{current} (ExifTool write failed: {write_error})")
                    }
                    None => format!("ExifTool write failed: {write_error}"),
                });
            }
            if first_mismatch.is_none() {
                first_mismatch = message.clone();
            }
        }
        outcomes.push(MetadataTargetOutcome {
            target: plan.target,
            display_name: plan.display_name,
            kind,
            sent: plan.edit.value,
            before: plan.before,
            observed,
            message,
        });
    }

    let diagnostics = format_apply_diagnostics(
        numeric_attempted,
        &numeric_result,
        text_attempted,
        &text_result,
        targets_to_clear.len(),
        outcomes.len(),
    );

    // Intentionally no `apply_log::append_metadata_entries`: the production
    // log is schema-keyed. Target-aware logging remains pending activation.
    MetadataSingleFileOutcomeV5 {
        fresh_image_metadata: Some(fresh),
        error: diagnostics.error.or(first_mismatch),
        warning: diagnostics.warning,
        outcomes,
        targets_to_clear,
    }
}

fn build_strict_post_write_occurrence_index(
    fresh: &scanner::ImageMetadata,
) -> Result<BTreeMap<MetadataOccurrenceId, &MetadataOccurrence>, ApplyV5Error> {
    let mut occurrences = BTreeMap::new();
    for occurrence in fresh.occurrences.iter() {
        if occurrences
            .insert(occurrence.id.clone(), occurrence)
            .is_some()
        {
            return Err(ApplyV5Error::PostWriteDuplicateOccurrenceId {
                occurrence_id: Box::new(occurrence.id.clone()),
            });
        }
    }
    Ok(occurrences)
}

fn verify_plan(
    plan: &TargetPlan,
    post_by_id: &BTreeMap<MetadataOccurrenceId, &MetadataOccurrence>,
) -> (String, Option<String>, Option<MetadataValue>) {
    match &plan.target {
        MetadataDraftTarget::ExistingOccurrence { occurrence_id, .. } => {
            verify_existing_plan(plan, post_by_id.get(occurrence_id).copied())
        }
        MetadataDraftTarget::NewProperty { schema_id } => {
            let matches = post_by_id
                .values()
                .copied()
                .filter(|occurrence| {
                    occurrence
                        .tag_info
                        .as_ref()
                        .is_some_and(|info| &info.id == schema_id)
                })
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [] => (
                    "MissingPostWrite".to_string(),
                    Some(format!(
                        "New property {schema_id} has zero exact-schema occurrences after write"
                    )),
                    None,
                ),
                [occurrence] => {
                    let (kind, message) = verify_semantic(
                        schema_id,
                        &plan.edit,
                        Some(&occurrence.value),
                        Some(&plan.kind),
                    );
                    (kind, message, Some(occurrence.value.clone()))
                }
                many => (
                    "AmbiguousPostWrite".to_string(),
                    Some(format!(
                        "New property {schema_id} resolved to multiple exact-schema occurrences: {:?}",
                        many.iter().map(|item| &item.id).collect::<Vec<_>>()
                    )),
                    None,
                ),
            }
        }
    }
}

fn verify_existing_plan(
    plan: &TargetPlan,
    occurrence: Option<&MetadataOccurrence>,
) -> (String, Option<String>, Option<MetadataValue>) {
    let MetadataDraftTarget::ExistingOccurrence {
        occurrence_id,
        schema_id,
        write_target,
    } = &plan.target
    else {
        unreachable!("existing-target verification requires an existing target")
    };

    if plan.edit.intent == EditIntent::Delete {
        let observed = occurrence.map(|item| item.value.clone());
        let (kind, message) =
            crate::apply_edits::verify_delete_value(schema_id, occurrence.map(|item| &item.value));
        return (kind, message, observed);
    }

    let Some(occurrence) = occurrence else {
        return (
            "MissingPostWrite".to_string(),
            Some(format!(
                "Exact occurrence {occurrence_id:?} is absent after write"
            )),
            None,
        );
    };
    let schema_unchanged = occurrence
        .tag_info
        .as_ref()
        .is_some_and(|info| &info.id == schema_id);
    if !schema_unchanged || occurrence.write_target.as_ref() != Some(write_target) {
        return (
            "TargetChangedPostWrite".to_string(),
            Some(format!(
                "Exact occurrence {occurrence_id:?} changed schema or selector after write"
            )),
            Some(occurrence.value.clone()),
        );
    }
    let (kind, message) = verify_semantic(
        schema_id,
        &plan.edit,
        Some(&occurrence.value),
        Some(&plan.kind),
    );
    (kind, message, Some(occurrence.value.clone()))
}

fn verify_semantic(
    schema_id: &SchemaDefinitionId,
    edit: &MetadataDraftEdit,
    observed: Option<&MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    match edit.intent {
        EditIntent::Set => {
            crate::apply_edits::verify_set_value(schema_id, edit.value.as_ref(), observed, kind)
        }
        EditIntent::Delete => crate::apply_edits::verify_delete_value(schema_id, observed),
        EditIntent::ListAdd => crate::apply_edits::verify_list_add_value(
            schema_id,
            edit.value.as_ref(),
            observed,
            kind,
        ),
        EditIntent::ListRemove => crate::apply_edits::verify_list_remove_value(
            schema_id,
            edit.value.as_ref(),
            observed,
            kind,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::MetadataOccurrences;
    use crate::metadata_value::{ListKind, RationalValue};
    use std::cell::RefCell;
    use std::collections::VecDeque;

    struct FakeClient {
        reads: RefCell<VecDeque<Result<scanner::ImageMetadata, String>>>,
        writes: RefCell<Vec<(bool, String)>>,
        calls: RefCell<Vec<String>>,
        fail_numeric: bool,
        fail_text: bool,
    }

    impl FakeClient {
        fn new(reads: Vec<Result<scanner::ImageMetadata, String>>) -> Self {
            Self {
                reads: RefCell::new(reads.into()),
                writes: RefCell::new(Vec::new()),
                calls: RefCell::new(Vec::new()),
                fail_numeric: false,
                fail_text: false,
            }
        }

        fn failing(mut self, numeric: bool, text: bool) -> Self {
            self.fail_numeric = numeric;
            self.fail_text = text;
            self
        }
    }

    impl MetadataTargetWriteClient for FakeClient {
        fn read_image_metadata(
            &self,
            _rel_path: &str,
            _abs_path: &Path,
        ) -> Result<scanner::ImageMetadata, String> {
            self.calls.borrow_mut().push("read".to_string());
            self.reads
                .borrow_mut()
                .pop_front()
                .expect("configured fake read")
        }

        fn write_metadata(&self, numeric: bool, rendered_contents: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(if numeric {
                "write:numeric".to_string()
            } else {
                "write:text".to_string()
            });
            self.writes
                .borrow_mut()
                .push((numeric, rendered_contents.to_string()));
            if (numeric && self.fail_numeric) || (!numeric && self.fail_text) {
                Err("configured write failure".to_string())
            } else {
                Ok(())
            }
        }
    }

    fn schema(tag_id: &str, group: &str, name: &str, writable: bool, kind: TagKind) -> TagInfo {
        TagInfo {
            id: SchemaDefinitionId {
                table: "Test::Table".to_string(),
                tag_id: tag_id.to_string(),
                index: None,
            },
            group: group.to_string(),
            name: name.to_string(),
            writable,
            kind,
            description: None,
            storage_count: None,
        }
    }

    fn occurrence_id(path: &str, tag_id: &str, copy: u32) -> MetadataOccurrenceId {
        MetadataOccurrenceId {
            document: None,
            path: path.to_string(),
            tag_id: tag_id.to_string(),
            copy,
        }
    }

    fn occurrence(
        id: MetadataOccurrenceId,
        value: MetadataValue,
        info: Option<TagInfo>,
        group: Option<&str>,
        name: &str,
    ) -> MetadataOccurrence {
        MetadataOccurrence {
            id,
            value,
            tag_info: info,
            write_target: group.map(|group1| MetadataWriteTarget {
                group1: group1.to_string(),
                tag_name: name.to_string(),
            }),
        }
    }

    fn image(occurrences: Vec<MetadataOccurrence>) -> scanner::ImageMetadata {
        scanner::ImageMetadata {
            relative_path: "photo.jpg".to_string(),
            occurrences: MetadataOccurrences(occurrences),
            metadata: scanner::MetadataEntries::default(),
        }
    }

    fn edit(intent: EditIntent, value: Option<MetadataValue>) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value,
            intent,
            display: None,
        }
    }

    fn existing_entry(
        occurrence: &MetadataOccurrence,
        edit: MetadataDraftEdit,
    ) -> MetadataDraftEntryV5 {
        MetadataDraftEntryV5 {
            target: MetadataDraftTarget::from_existing_occurrence(occurrence).unwrap(),
            edit,
        }
    }

    fn new_entry(info: &TagInfo, edit: MetadataDraftEdit) -> MetadataDraftEntryV5 {
        MetadataDraftEntryV5 {
            target: MetadataDraftTarget::from_new_property(info).unwrap(),
            edit,
        }
    }

    fn with_temp_file<T>(run: impl FnOnce(&Path, &str) -> T) -> T {
        let dir = tempfile::tempdir().unwrap();
        std::fs::File::create(dir.path().join("photo.jpg")).unwrap();
        run(dir.path(), "photo.jpg")
    }

    fn apply_fake(
        edits: &[MetadataDraftEntryV5],
        client: &FakeClient,
        infos: &[TagInfo],
    ) -> MetadataSingleFileOutcomeV5 {
        with_temp_file(|folder, rel| {
            apply_single_file_metadata_v5_with_client(
                folder.to_str().unwrap(),
                rel,
                edits,
                client,
                |id| infos.iter().find(|info| &info.id == id).cloned(),
            )
        })
    }

    #[test]
    fn empty_missing_and_failed_pre_read_are_hard_failures_without_writes() {
        let empty_client = FakeClient::new(Vec::new());
        let empty = apply_fake(&[], &empty_client, &[]);
        assert!(empty.error.unwrap().contains("No edits"));
        assert!(empty_client.calls.borrow().is_empty());

        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("x".into()))),
        );
        let missing_client = FakeClient::new(Vec::new());
        let missing = apply_single_file_metadata_v5_with_client(
            "definitely-missing-folder",
            "missing.jpg",
            std::slice::from_ref(&entry),
            &missing_client,
            |_| Some(info.clone()),
        );
        assert!(missing.error.unwrap().contains("File not found"));
        assert!(missing_client.calls.borrow().is_empty());

        let failed_client = FakeClient::new(vec![Err("pre-read boom".into())]);
        let failed = apply_fake(std::slice::from_ref(&entry), &failed_client, &[info]);
        assert!(failed.error.unwrap().contains("pre-write read failed"));
        assert_eq!(&*failed_client.calls.borrow(), &["read"]);
        assert!(failed.outcomes.is_empty());
        assert!(failed.targets_to_clear.is_empty());
    }

    #[test]
    fn duplicate_slots_reject_changed_snapshots_and_new_properties_before_planning() {
        let info = schema("1", "IFD0", "A", true, TagKind::Text);
        let original = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Text("a".into()),
            Some(info.clone()),
            Some("IFD0"),
            "A",
        );
        let first = existing_entry(
            &original,
            edit(EditIntent::Set, Some(MetadataValue::Text("b".into()))),
        );
        let mut changed_schema = first.clone();
        if let MetadataDraftTarget::ExistingOccurrence { schema_id, .. } =
            &mut changed_schema.target
        {
            schema_id.tag_id = "changed".into();
        }
        let mut changed_selector = first.clone();
        if let MetadataDraftTarget::ExistingOccurrence { write_target, .. } =
            &mut changed_selector.target
        {
            write_target.group1 = "IFD1".into();
        }
        for second in [first.clone(), changed_schema, changed_selector] {
            let error = plan_batch(
                Path::new("photo.jpg"),
                &[first.clone(), second],
                &image(vec![original.clone()]),
                |_| None,
            )
            .err()
            .unwrap();
            assert!(matches!(error, ApplyV5Error::DuplicateDraftSlot { .. }));
            assert!(error.to_string().contains("conflicting targets"));
        }

        let new = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("x".into()))),
        );
        assert!(matches!(
            plan_batch(
                Path::new("photo.jpg"),
                &[new.clone(), new],
                &image(vec![]),
                |_| Some(info.clone())
            ),
            Err(ApplyV5Error::DuplicateDraftSlot { .. })
        ));
    }

    #[test]
    fn exact_occurrence_index_and_existing_freshness_failures_are_distinct() {
        let info = schema("1", "SchemaGroup", "SchemaName", true, TagKind::Text);
        let fresh = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Text("a".into()),
            Some(info.clone()),
            Some("IFD0"),
            "RuntimeName",
        );
        let entry = existing_entry(
            &fresh,
            edit(EditIntent::Set, Some(MetadataValue::Text("b".into()))),
        );

        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&entry),
                &image(vec![fresh.clone(), fresh.clone()]),
                |_| None
            ),
            Err(ApplyV5Error::DuplicatePreWriteOccurrenceId(_))
        ));
        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&entry),
                &image(vec![]),
                |_| None
            ),
            Err(ApplyV5Error::ExistingOccurrenceMissing(_))
        ));

        let mut cases = Vec::new();
        let mut stale_schema = fresh.clone();
        stale_schema.tag_info.as_mut().unwrap().id.tag_id = "stale".into();
        cases.push(stale_schema);
        let mut stale_selector = fresh.clone();
        stale_selector.write_target.as_mut().unwrap().group1 = "IFD1".into();
        cases.push(stale_selector);
        let mut readonly = fresh.clone();
        readonly.tag_info.as_mut().unwrap().writable = false;
        cases.push(readonly);
        let mut missing_selector = fresh.clone();
        missing_selector.write_target = None;
        cases.push(missing_selector);
        let mut missing_schema = fresh.clone();
        missing_schema.tag_info = None;
        cases.push(missing_schema);
        for changed in cases {
            assert!(matches!(
                plan_batch(
                    Path::new("p"),
                    std::slice::from_ref(&entry),
                    &image(vec![changed]),
                    |_| None
                ),
                Err(ApplyV5Error::ExistingTargetValidationFailure { .. })
            ));
        }
    }

    #[test]
    fn new_property_planning_enforces_schema_absence_writability_and_creation_intents() {
        let writable = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let readonly = schema("1", "XMP-test", "Name", false, TagKind::Text);
        let set = new_entry(
            &writable,
            edit(EditIntent::Set, Some(MetadataValue::Text("x".into()))),
        );
        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&set),
                &image(vec![]),
                |_| None
            ),
            Err(ApplyV5Error::NewPropertySchemaMissing(_))
        ));
        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&set),
                &image(vec![]),
                |_| Some(readonly.clone())
            ),
            Err(ApplyV5Error::NewPropertySchemaReadOnly(_))
        ));

        let present = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Text("old".into()),
            Some(writable.clone()),
            Some("XMP-test"),
            "Name",
        );
        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&set),
                &image(vec![present]),
                |_| Some(writable.clone())
            ),
            Err(ApplyV5Error::NewPropertyAlreadyExists { .. })
        ));

        for intent in [EditIntent::Delete, EditIntent::ListRemove] {
            let unsupported = new_entry(&writable, edit(intent.clone(), None));
            assert!(matches!(
                plan_batch(Path::new("p"), &[unsupported], &image(vec![]), |_| Some(writable.clone())),
                Err(ApplyV5Error::UnsupportedNewPropertyIntent { intent: actual, .. }) if actual == intent
            ));
        }

        assert!(plan_batch(
            Path::new("p"),
            std::slice::from_ref(&set),
            &image(vec![]),
            |_| Some(writable.clone())
        )
        .is_ok());
        let list = schema(
            "2",
            "XMP-test",
            "Items",
            true,
            TagKind::Bag(Box::new(TagKind::Text)),
        );
        let add = new_entry(
            &list,
            edit(EditIntent::ListAdd, Some(MetadataValue::Text("x".into()))),
        );
        assert!(plan_batch(Path::new("p"), &[add], &image(vec![]), |_| Some(
            list.clone()
        ))
        .is_ok());
    }

    #[test]
    fn selector_collisions_are_ascii_case_insensitive_and_cross_variant() {
        let info_a = schema("1", "Schema", "A", true, TagKind::Text);
        let info_b = schema("2", "ifd0", "same", true, TagKind::Text);
        let existing = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Text("old".into()),
            Some(info_a),
            Some("IFD0"),
            "Same",
        );
        let entries = [
            existing_entry(
                &existing,
                edit(EditIntent::Set, Some(MetadataValue::Text("a".into()))),
            ),
            new_entry(
                &info_b,
                edit(EditIntent::Set, Some(MetadataValue::Text("b".into()))),
            ),
        ];
        assert!(matches!(
            plan_batch(Path::new("p"), &entries, &image(vec![existing]), |_| Some(
                info_b.clone()
            )),
            Err(ApplyV5Error::WriteSelectorCollision { .. })
        ));

        let info_c = schema("3", "IFD0", "Same", true, TagKind::Text);
        let two_new = [
            new_entry(
                &info_b,
                edit(EditIntent::Set, Some(MetadataValue::Text("b".into()))),
            ),
            new_entry(
                &info_c,
                edit(EditIntent::Set, Some(MetadataValue::Text("c".into()))),
            ),
        ];
        assert!(matches!(
            plan_batch(Path::new("p"), &two_new, &image(vec![]), |id| [
                info_b.clone(),
                info_c.clone()
            ]
            .into_iter()
            .find(|info| &info.id == id)),
            Err(ApplyV5Error::WriteSelectorCollision { .. })
        ));
    }

    #[test]
    fn shared_schema_occurrences_plan_and_verify_independently_by_exact_id() {
        let info = schema(
            "282",
            "SchemaMustNotBeUsed",
            "XResolution",
            true,
            TagKind::Rational,
        );
        let ifd0 = occurrence(
            occurrence_id("JPEG-APP1-IFD0", "282", 0),
            MetadataValue::Rational(RationalValue {
                numerator: 300,
                denominator: 1,
            }),
            Some(info.clone()),
            Some("IFD0"),
            "XResolution",
        );
        let ifd1 = occurrence(
            occurrence_id("JPEG-APP1-IFD1", "282", 1),
            MetadataValue::Rational(RationalValue {
                numerator: 72,
                denominator: 1,
            }),
            Some(info.clone()),
            Some("IFD1"),
            "XResolution",
        );
        let edits = [
            existing_entry(
                &ifd0,
                edit(
                    EditIntent::Set,
                    Some(MetadataValue::Rational(RationalValue {
                        numerator: 600,
                        denominator: 1,
                    })),
                ),
            ),
            existing_entry(
                &ifd1,
                edit(
                    EditIntent::Set,
                    Some(MetadataValue::Rational(RationalValue {
                        numerator: 144,
                        denominator: 1,
                    })),
                ),
            ),
        ];
        let after0 = occurrence(
            ifd0.id.clone(),
            edits[0].edit.value.clone().unwrap(),
            Some(info.clone()),
            Some("IFD0"),
            "XResolution",
        );
        let after1 = occurrence(
            ifd1.id.clone(),
            MetadataValue::Rational(RationalValue {
                numerator: 999,
                denominator: 1,
            }),
            Some(info.clone()),
            Some("IFD1"),
            "XResolution",
        );
        let client = FakeClient::new(vec![
            Ok(image(vec![ifd0.clone(), ifd1.clone()])),
            Ok(image(vec![after1.clone(), after0.clone()])),
        ]);
        let outcome = apply_fake(&edits, &client, &[]);
        let rendered = &client.writes.borrow()[0].1;
        assert!(rendered.contains("-IFD0:XResolution=600"));
        assert!(rendered.contains("-IFD1:XResolution=144"));
        assert!(!rendered.contains("SchemaMustNotBeUsed:XResolution"));
        assert_eq!(outcome.outcomes[0].before, Some(ifd0.value.clone()));
        assert_eq!(outcome.outcomes[1].before, Some(ifd1.value.clone()));
        assert_eq!(outcome.outcomes[0].kind, "Match");
        assert_eq!(outcome.outcomes[1].kind, "Mismatch");
        assert_eq!(outcome.targets_to_clear, vec![edits[0].target.clone()]);
        assert!(outcome.fresh_image_metadata.unwrap().metadata.is_empty());

        let ordered_client = FakeClient::new(vec![
            Ok(image(vec![ifd0, ifd1])),
            Ok(image(vec![after0, after1])),
        ]);
        let ordered = apply_fake(&edits, &ordered_client, &[]);
        assert_eq!(
            ordered
                .outcomes
                .iter()
                .map(|item| item.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["Match", "Mismatch"]
        );
        assert_eq!(ordered.targets_to_clear, vec![edits[0].target.clone()]);
    }

    #[test]
    fn duplicate_post_write_occurrence_id_is_a_distinct_invariant_error() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let duplicate = occurrence(
            occurrence_id("DUPLICATE-PATH", "1", 7),
            MetadataValue::Text("value".into()),
            Some(info),
            Some("XMP-test"),
            "Name",
        );

        let error = build_strict_post_write_occurrence_index(&image(vec![
            duplicate.clone(),
            duplicate.clone(),
        ]))
        .unwrap_err();
        assert!(matches!(
            &error,
            ApplyV5Error::PostWriteDuplicateOccurrenceId { occurrence_id }
                if occurrence_id.as_ref() == &duplicate.id
        ));
        let message = error.to_string();
        assert!(message.contains("post-write"));
        assert!(message.contains("duplicate exact occurrence ID"));
        assert!(message.contains("DUPLICATE-PATH"));
        assert!(!matches!(
            error,
            ApplyV5Error::DuplicatePreWriteOccurrenceId(_)
        ));
    }

    #[test]
    fn duplicate_post_write_set_never_selects_a_first_record() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let before = occurrence(
            occurrence_id("SET-DUPLICATE", "1", 0),
            MetadataValue::Text("before".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let entry = existing_entry(
            &before,
            edit(EditIntent::Set, Some(MetadataValue::Text("sent".into()))),
        );
        let matching = occurrence(
            before.id.clone(),
            MetadataValue::Text("sent".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let mismatching = occurrence(
            before.id.clone(),
            MetadataValue::Text("other".into()),
            Some(info),
            Some("XMP-test"),
            "Name",
        );
        let duplicate_id = format!("{:?}", before.id);

        for post in [
            vec![matching.clone(), mismatching.clone()],
            vec![mismatching, matching],
        ] {
            let client = FakeClient::new(vec![Ok(image(vec![before.clone()])), Ok(image(post))]);
            let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[]);
            assert_eq!(outcome.outcomes.len(), 1);
            assert_eq!(outcome.outcomes[0].kind, "ReadbackInvalid");
            assert_eq!(outcome.outcomes[0].target, entry.target);
            assert_eq!(
                outcome.outcomes[0].display_name,
                before.tag_info.as_ref().unwrap().display_name()
            );
            assert_eq!(outcome.outcomes[0].sent, entry.edit.value);
            assert_eq!(outcome.outcomes[0].before, Some(before.value.clone()));
            assert!(outcome.outcomes[0].observed.is_none());
            assert!(outcome.outcomes[0]
                .message
                .as_ref()
                .unwrap()
                .contains(&duplicate_id));
            assert!(outcome.error.as_ref().unwrap().contains(&duplicate_id));
            assert!(outcome.fresh_image_metadata.is_none());
            assert!(outcome.targets_to_clear.is_empty());
            assert!(outcome.warning.is_none());
        }
    }

    #[test]
    fn duplicate_post_write_delete_never_clears_regardless_of_values_or_order() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let before = occurrence(
            occurrence_id("DELETE-DUPLICATE", "1", 0),
            MetadataValue::Text("before".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let entry = existing_entry(&before, edit(EditIntent::Delete, None));

        for values in [["", "still"], ["still", ""], ["", ""]] {
            let post = values
                .into_iter()
                .map(|value| {
                    occurrence(
                        before.id.clone(),
                        MetadataValue::Text(value.into()),
                        Some(info.clone()),
                        Some("XMP-test"),
                        "Name",
                    )
                })
                .collect();
            let client = FakeClient::new(vec![Ok(image(vec![before.clone()])), Ok(image(post))]);
            let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[]);
            assert_eq!(outcome.outcomes[0].kind, "ReadbackInvalid");
            assert_eq!(outcome.outcomes[0].sent, None);
            assert_eq!(outcome.outcomes[0].before, Some(before.value.clone()));
            assert!(outcome.outcomes[0].observed.is_none());
            assert!(outcome.outcomes[0]
                .message
                .as_ref()
                .unwrap()
                .contains("DELETE-DUPLICATE"));
            assert!(outcome.fresh_image_metadata.is_none());
            assert!(outcome.targets_to_clear.is_empty());
        }
    }

    #[test]
    fn duplicate_target_id_invalidates_every_planned_outcome() {
        let info = schema(
            "282",
            "SchemaMustNotSelect",
            "XResolution",
            true,
            TagKind::Rational,
        );
        let make_value = |value| {
            MetadataValue::Rational(RationalValue {
                numerator: value,
                denominator: 1,
            })
        };
        let ifd0 = occurrence(
            occurrence_id("JPEG-APP1-IFD0", "282", 0),
            make_value(300),
            Some(info.clone()),
            Some("IFD0"),
            "XResolution",
        );
        let ifd1 = occurrence(
            occurrence_id("JPEG-APP1-IFD1", "282", 1),
            make_value(72),
            Some(info.clone()),
            Some("IFD1"),
            "XResolution",
        );
        let edits = [
            existing_entry(&ifd0, edit(EditIntent::Set, Some(make_value(600)))),
            existing_entry(&ifd1, edit(EditIntent::Set, Some(make_value(144)))),
        ];
        let after0 = occurrence(
            ifd0.id.clone(),
            make_value(600),
            Some(info.clone()),
            Some("IFD0"),
            "XResolution",
        );
        let after1 = occurrence(
            ifd1.id.clone(),
            make_value(144),
            Some(info),
            Some("IFD1"),
            "XResolution",
        );

        for post in [
            vec![after0.clone(), after1.clone(), after0.clone()],
            vec![after0.clone(), after0.clone(), after1.clone()],
        ] {
            let client = FakeClient::new(vec![
                Ok(image(vec![ifd0.clone(), ifd1.clone()])),
                Ok(image(post)),
            ]);
            let outcome = apply_fake(&edits, &client, &[]);
            assert_eq!(outcome.outcomes.len(), edits.len());
            for (target_outcome, entry) in outcome.outcomes.iter().zip(&edits) {
                assert_eq!(target_outcome.kind, "ReadbackInvalid");
                assert_eq!(target_outcome.target, entry.target);
                assert_eq!(target_outcome.sent, entry.edit.value);
                assert!(target_outcome.observed.is_none());
                assert!(target_outcome
                    .message
                    .as_ref()
                    .unwrap()
                    .contains("JPEG-APP1-IFD0"));
            }
            assert_eq!(outcome.outcomes[0].before, Some(ifd0.value.clone()));
            assert_eq!(outcome.outcomes[1].before, Some(ifd1.value.clone()));
            assert!(outcome.fresh_image_metadata.is_none());
            assert!(outcome.targets_to_clear.is_empty());
        }
    }

    #[test]
    fn duplicate_unrelated_post_write_id_invalidates_readback_and_retains_write_failure() {
        let info = schema(
            "1",
            "IFD0",
            "Number",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let before = occurrence(
            occurrence_id("TARGET", "1", 0),
            MetadataValue::Integer(1),
            Some(info.clone()),
            Some("IFD0"),
            "Number",
        );
        let entry = existing_entry(
            &before,
            edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
        );
        let after = occurrence(
            before.id.clone(),
            MetadataValue::Integer(2),
            Some(info),
            Some("IFD0"),
            "Number",
        );
        let unrelated = occurrence(
            occurrence_id("UNRELATED-DUPLICATE", "999", 4),
            MetadataValue::Text("unrelated".into()),
            None,
            None,
            "Unknown",
        );
        let client = FakeClient::new(vec![
            Ok(image(vec![before])),
            Ok(image(vec![after, unrelated.clone(), unrelated])),
        ])
        .failing(true, false);
        let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[]);

        assert_eq!(outcome.outcomes[0].kind, "ReadbackInvalid");
        let error = outcome.error.unwrap();
        assert!(error.contains("numeric pass failed"));
        assert!(error.contains("UNRELATED-DUPLICATE"));
        assert!(outcome.fresh_image_metadata.is_none());
        assert!(outcome.targets_to_clear.is_empty());
    }

    #[test]
    fn existing_set_resolution_covers_match_coercion_mismatch_missing_changed_and_unparsed() {
        let info = schema(
            "1",
            "IFD0",
            "Number",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let before = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Integer(1),
            Some(info.clone()),
            Some("IFD0"),
            "Number",
        );
        let entry = existing_entry(
            &before,
            edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
        );
        let run = |post: Vec<MetadataOccurrence>| {
            let client = FakeClient::new(vec![Ok(image(vec![before.clone()])), Ok(image(post))]);
            apply_fake(std::slice::from_ref(&entry), &client, &[]).outcomes[0]
                .kind
                .clone()
        };
        assert_eq!(
            run(vec![occurrence(
                before.id.clone(),
                MetadataValue::Integer(2),
                Some(info.clone()),
                Some("IFD0"),
                "Number"
            )]),
            "Match"
        );
        assert_eq!(
            run(vec![occurrence(
                before.id.clone(),
                MetadataValue::Real(2.0),
                Some(info.clone()),
                Some("IFD0"),
                "Number"
            )]),
            "Coerced"
        );
        assert_eq!(
            run(vec![occurrence(
                before.id.clone(),
                MetadataValue::Integer(3),
                Some(info.clone()),
                Some("IFD0"),
                "Number"
            )]),
            "Mismatch"
        );
        assert_eq!(run(vec![]), "MissingPostWrite");
        let mut changed_schema = info.clone();
        changed_schema.id.tag_id = "changed".into();
        assert_eq!(
            run(vec![occurrence(
                before.id.clone(),
                MetadataValue::Integer(2),
                Some(changed_schema),
                Some("IFD0"),
                "Number"
            )]),
            "TargetChangedPostWrite"
        );
        assert_eq!(
            run(vec![occurrence(
                before.id.clone(),
                MetadataValue::Integer(2),
                Some(info.clone()),
                Some("IFD1"),
                "Number"
            )]),
            "TargetChangedPostWrite"
        );
        assert_eq!(
            run(vec![occurrence(
                before.id.clone(),
                MetadataValue::Unknown {
                    expected: Some(info.kind.clone()),
                    raw: serde_json::json!("bad"),
                    reason: Some("parse".into())
                },
                Some(info.clone()),
                Some("IFD0"),
                "Number"
            )]),
            "UnparsedPostWrite"
        );

        let sibling = occurrence(
            occurrence_id("OTHER", "1", 1),
            MetadataValue::Integer(2),
            Some(info),
            Some("IFD1"),
            "Number",
        );
        assert_eq!(run(vec![sibling]), "MissingPostWrite");
    }

    #[test]
    fn existing_delete_uses_exact_absence_and_empty_equivalence_only() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let before = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Text("old".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let entry = existing_entry(&before, edit(EditIntent::Delete, None));
        for (post, expected) in [
            (vec![], "DeleteOk"),
            (
                vec![occurrence(
                    before.id.clone(),
                    MetadataValue::Text(String::new()),
                    Some(info.clone()),
                    Some("XMP-test"),
                    "Name",
                )],
                "DeleteOk",
            ),
            (
                vec![occurrence(
                    before.id.clone(),
                    MetadataValue::Text("still".into()),
                    Some(info.clone()),
                    Some("XMP-test"),
                    "Name",
                )],
                "DeleteLingering",
            ),
        ] {
            let client = FakeClient::new(vec![Ok(image(vec![before.clone()])), Ok(image(post))]);
            let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[]);
            assert_eq!(outcome.outcomes[0].kind, expected);
            assert_eq!(
                outcome.targets_to_clear.len(),
                usize::from(expected == "DeleteOk")
            );
        }
    }

    #[test]
    fn existing_list_add_and_remove_verify_semantically() {
        let info = schema(
            "1",
            "XMP-test",
            "Items",
            true,
            TagKind::Bag(Box::new(TagKind::Text)),
        );
        let value = |items: &[&str]| MetadataValue::List {
            list_kind: ListKind::Bag,
            items: items
                .iter()
                .map(|item| MetadataValue::Text((*item).into()))
                .collect(),
        };
        let before = occurrence(
            occurrence_id("P", "1", 0),
            value(&["a"]),
            Some(info.clone()),
            Some("XMP-test"),
            "Items",
        );
        for (intent, sent, post_value, expected) in [
            (EditIntent::ListAdd, "b", value(&["a", "b"]), "Match"),
            (EditIntent::ListAdd, "b", value(&["a"]), "Mismatch"),
            (EditIntent::ListRemove, "a", value(&["b"]), "Match"),
            (EditIntent::ListRemove, "a", value(&["a"]), "Mismatch"),
        ] {
            let entry = existing_entry(&before, edit(intent, Some(value(&[sent]))));
            let post = occurrence(
                before.id.clone(),
                post_value,
                Some(info.clone()),
                Some("XMP-test"),
                "Items",
            );
            let client =
                FakeClient::new(vec![Ok(image(vec![before.clone()])), Ok(image(vec![post]))]);
            assert_eq!(
                apply_fake(&[entry], &client, &[]).outcomes[0].kind,
                expected
            );
        }
    }

    #[test]
    fn new_property_readback_uses_zero_one_multiple_cardinality_without_preference() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("made".into()))),
        );
        let unique = occurrence(
            occurrence_id("NON-IFD0", "1", 9),
            MetadataValue::Text("made".into()),
            Some(info.clone()),
            None,
            "Name",
        );
        for (post, expected, clear) in [
            (vec![], "MissingPostWrite", false),
            (vec![unique.clone()], "Match", true),
        ] {
            let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(post))]);
            let outcome = apply_fake(
                std::slice::from_ref(&entry),
                &client,
                std::slice::from_ref(&info),
            );
            assert_eq!(outcome.outcomes[0].kind, expected);
            assert_eq!(!outcome.targets_to_clear.is_empty(), clear);
        }

        let ifd0_copy0 = occurrence(
            occurrence_id("IFD0", "1", 0),
            MetadataValue::Text("made".into()),
            Some(info.clone()),
            Some("IFD0"),
            "Name",
        );
        let mut ambiguity_messages = Vec::new();
        for post in [
            vec![ifd0_copy0.clone(), unique.clone()],
            vec![unique.clone(), ifd0_copy0.clone()],
        ] {
            let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(post))]);
            let outcome = apply_fake(
                std::slice::from_ref(&entry),
                &client,
                std::slice::from_ref(&info),
            );
            assert_eq!(outcome.outcomes[0].kind, "AmbiguousPostWrite");
            let message = outcome.outcomes[0].message.as_ref().unwrap();
            assert!(message.contains("IFD0"));
            assert!(message.contains("NON-IFD0"));
            ambiguity_messages.push(message.clone());
            assert!(outcome.targets_to_clear.is_empty());
        }
        assert_eq!(ambiguity_messages[0], ambiguity_messages[1]);
    }

    #[test]
    fn new_property_list_add_uses_unique_observed_value() {
        let info = schema(
            "1",
            "XMP-test",
            "Items",
            true,
            TagKind::Bag(Box::new(TagKind::Text)),
        );
        let entry = new_entry(
            &info,
            edit(
                EditIntent::ListAdd,
                Some(MetadataValue::List {
                    list_kind: ListKind::Bag,
                    items: vec![MetadataValue::Text("x".into())],
                }),
            ),
        );
        let observed = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Text("x".into())],
        };
        let post = occurrence(
            occurrence_id("ANY", "1", 7),
            observed.clone(),
            Some(info.clone()),
            None,
            "Items",
        );
        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![post]))]);
        let outcome = apply_fake(&[entry], &client, &[info]);
        assert_eq!(outcome.outcomes[0].kind, "Match");
        assert_eq!(outcome.outcomes[0].observed, Some(observed));
    }

    #[test]
    fn write_pass_order_and_failure_policy_are_conservative() {
        let numeric_info = schema(
            "1",
            "IFD0",
            "Number",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let text_info = schema("2", "XMP-test", "Name", true, TagKind::Text);
        let numeric = new_entry(
            &numeric_info,
            edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
        );
        let text = new_entry(
            &text_info,
            edit(EditIntent::Set, Some(MetadataValue::Text("x".into()))),
        );
        let numeric_post = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Integer(2),
            Some(numeric_info.clone()),
            Some("IFD0"),
            "Number",
        );
        let text_post = occurrence(
            occurrence_id("P", "2", 0),
            MetadataValue::Text("x".into()),
            Some(text_info.clone()),
            Some("XMP-test"),
            "Name",
        );

        let mixed = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![numeric_post.clone(), text_post.clone()])),
        ]);
        let outcome = apply_fake(
            &[numeric.clone(), text.clone()],
            &mixed,
            &[numeric_info.clone(), text_info.clone()],
        );
        assert!(outcome.error.is_none());
        assert_eq!(
            &*mixed.calls.borrow(),
            &["read", "write:numeric", "write:text", "read"]
        );

        let numeric_only = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![numeric_post.clone()])),
        ]);
        apply_fake(
            std::slice::from_ref(&numeric),
            &numeric_only,
            std::slice::from_ref(&numeric_info),
        );
        assert_eq!(
            &*numeric_only.calls.borrow(),
            &["read", "write:numeric", "read"]
        );

        let text_only =
            FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![text_post.clone()]))]);
        apply_fake(
            std::slice::from_ref(&text),
            &text_only,
            std::slice::from_ref(&text_info),
        );
        assert_eq!(&*text_only.calls.borrow(), &["read", "write:text", "read"]);

        let numeric_failure =
            FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![]))]).failing(true, false);
        let failed = apply_fake(
            &[numeric, text],
            &numeric_failure,
            &[numeric_info, text_info],
        );
        assert_eq!(
            &*numeric_failure.calls.borrow(),
            &["read", "write:numeric", "read"]
        );
        assert!(failed.error.unwrap().contains("numeric pass failed"));
    }

    #[test]
    fn pass_failures_can_be_warning_compatible_after_complete_verification() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("x".into()))),
        );
        let post = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Text("x".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let client =
            FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![post]))]).failing(false, true);
        let outcome = apply_fake(&[entry], &client, &[info]);
        assert!(outcome.error.is_none());
        assert!(outcome
            .warning
            .unwrap()
            .contains("all intended tags verified"));
    }

    #[test]
    fn readback_failure_returns_one_complete_target_outcome_per_plan_and_clears_none() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("x".into()))),
        );
        let client = FakeClient::new(vec![Ok(image(vec![])), Err("readback boom".into())]);
        let outcome = apply_fake(
            std::slice::from_ref(&entry),
            &client,
            std::slice::from_ref(&info),
        );
        assert!(outcome.fresh_image_metadata.is_none());
        assert!(outcome
            .error
            .unwrap()
            .contains("post-write readback failed"));
        assert_eq!(outcome.outcomes.len(), 1);
        assert_eq!(outcome.outcomes[0].kind, "ReadbackFailed");
        assert_eq!(outcome.outcomes[0].target, entry.target);
        assert_eq!(outcome.outcomes[0].sent, entry.edit.value);
        assert!(outcome.outcomes[0].observed.is_none());
        assert!(outcome.targets_to_clear.is_empty());

        let duplicate = occurrence(
            occurrence_id("INVALID-READBACK", "1", 0),
            MetadataValue::Text("x".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let invalid_client = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![duplicate.clone(), duplicate])),
        ]);
        let invalid = apply_fake(
            std::slice::from_ref(&entry),
            &invalid_client,
            std::slice::from_ref(&info),
        );
        assert_eq!(invalid.outcomes[0].kind, "ReadbackInvalid");
        assert_ne!(invalid.outcomes[0].kind, "ReadbackFailed");
        assert!(invalid.error.unwrap().contains("readback was invalid"));
    }

    #[test]
    fn all_planning_finishes_before_first_write_and_cstr_utf8_is_preserved() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let good = new_entry(
            &info,
            edit(
                EditIntent::Set,
                Some(MetadataValue::Text("café\nsecond".into())),
            ),
        );
        let bad_info = schema("2", "XMP-test", "Bad", false, TagKind::Text);
        let bad = MetadataDraftEntryV5 {
            target: MetadataDraftTarget::NewProperty {
                schema_id: bad_info.id.clone(),
            },
            edit: edit(EditIntent::Set, Some(MetadataValue::Text("bad".into()))),
        };
        let failed_client = FakeClient::new(vec![Ok(image(vec![]))]);
        let failed = apply_fake(
            &[good.clone(), bad],
            &failed_client,
            &[info.clone(), bad_info],
        );
        assert!(failed.error.unwrap().contains("read-only"));
        assert_eq!(&*failed_client.calls.borrow(), &["read"]);

        let post = occurrence(
            occurrence_id("P", "1", 0),
            good.edit.value.clone().unwrap(),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![post]))]);
        apply_fake(&[good], &client, &[info]);
        let rendered = &client.writes.borrow()[0].1;
        assert!(rendered.contains("#[CSTR]-XMP-test:Name=café\\nsecond"));
    }

    #[test]
    fn generated_target_outcome_retains_complete_target_and_semantic_fields() {
        use ts_rs::TS;

        let declaration = MetadataTargetOutcome::decl();
        assert!(declaration.contains("target: MetadataDraftTarget"));
        assert!(declaration.contains("sent: MetadataValue | null"));
        assert!(declaration.contains("before: MetadataValue | null"));
        assert!(declaration.contains("observed: MetadataValue | null"));
        assert!(declaration.contains("message: string | null"));
        assert!(declaration.contains("kind: string"));
    }
}
