//! Target-aware, occurrence-aware single-file apply path for the target-aware metadata pipeline.
//!
//! Production target-aware metadata apply reaches this module through the
//! versioned batch command. Existing-occurrence targets are read, written and
//! verified only by exact [`MetadataOccurrenceId`]. New-property
//! targets require exactly one post-write occurrence matching both the selected
//! schema definition and the complete attempted selector. Choosing a first,
//! lowest, `Copy0`, `IFD0`, writable, or otherwise preferred occurrence is
//! forbidden.
//! Complete target-aware audit evidence is retained for the batch coordinator,
//! which annotates it with draft persistence and appends it best-effort.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::apply_log::{
    TargetApplyArguments, TargetApplyAuditRecord, TargetApplyObservedOccurrence,
    TargetApplyPassStatus, TargetApplyPostWriteState, TargetApplyPostWriteUnavailableCause,
    TargetApplyVerificationEvidence, TargetApplyWriteEvidence,
};
use crate::draft_edits::{EditIntent, MetadataDraftEdit, MetadataTargetDraftEntry};
use crate::metadata_draft_target::{MetadataDraftSlot, MetadataDraftTarget};
use crate::metadata_occurrence::{
    observed_selector_matches_write_target, MetadataOccurrence, MetadataOccurrenceId,
    MetadataSelectorKey, MetadataWriteTarget,
};
use crate::metadata_value::MetadataValue;
use crate::metadata_write_execution::{
    build_exiftool_write_argfile_args, format_apply_diagnostics, render_exiftool_argfile,
    run_exiftool_write,
};
use crate::scanner;
use crate::tag_schema::{SchemaDefinitionId, TagInfo, TagKind};
use crate::write_args::BuiltArgs;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[allow(clippy::large_enum_variant)]
pub enum MetadataDraftReconciliation {
    Clear,
    Keep,
    Replace { target: MetadataDraftTarget },
    Blocked { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataTargetOutcome {
    pub target: MetadataDraftTarget,
    pub draft_reconciliation: MetadataDraftReconciliation,
    pub display_name: String,
    pub kind: String,
    pub sent: Option<MetadataValue>,
    pub before: Option<MetadataValue>,
    pub observed: Option<MetadataValue>,
    pub message: Option<String>,
}

struct TargetVerification {
    kind: String,
    message: Option<String>,
    observed: Option<MetadataValue>,
    draft_reconciliation: MetadataDraftReconciliation,
}

struct VerifiedTarget {
    verification: TargetVerification,
    post_write: TargetApplyPostWriteState,
}

#[derive(Debug, Clone)]
pub struct MetadataSingleFileOutcome {
    pub fresh_image_metadata: Option<scanner::ImageMetadata>,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub outcomes: Vec<MetadataTargetOutcome>,
    pub targets_to_clear: Vec<MetadataDraftTarget>,
    pub(crate) audit_records: Vec<TargetApplyAuditRecord>,
}

impl MetadataSingleFileOutcome {
    fn hard_failure(error: TargetApplyError) -> Self {
        Self {
            fresh_image_metadata: None,
            error: Some(error.to_string()),
            warning: None,
            outcomes: Vec::new(),
            targets_to_clear: Vec::new(),
            audit_records: Vec::new(),
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
            // The authoritative occurrence collection above is the complete readback.
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
pub(crate) enum TargetApplyError {
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
    NewPropertySelectorOccupied {
        target: Box<MetadataDraftTarget>,
        occurrences: Vec<(MetadataOccurrenceId, SchemaDefinitionId)>,
    },
    NewPropertySchemaOccupancyUnknown {
        target: Box<MetadataDraftTarget>,
        occurrences: Vec<MetadataOccurrenceId>,
    },
    UnsupportedNewPropertyIntent {
        target: Box<MetadataDraftTarget>,
        intent: EditIntent,
    },
    WriteSelectorCollision {
        group1: String,
        group7: String,
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

impl std::fmt::Display for TargetApplyError {
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
            Self::NewPropertySelectorOccupied {
                target,
                occurrences,
            } => write!(
                formatter,
                "New-property target {target:?} uses a selector already observed in the file at occurrences {occurrences:?}"
            ),
            Self::NewPropertySchemaOccupancyUnknown {
                target,
                occurrences,
            } => write!(
                formatter,
                "New-property target {target:?} cannot prove destination freedom because same-schema occurrences have no safely represented observed selector: {occurrences:?}"
            ),
            Self::UnsupportedNewPropertyIntent { target, intent } => write!(
                formatter,
                "New-property target {target:?} does not support creation intent {intent:?}"
            ),
            Self::WriteSelectorCollision {
                group1,
                group7,
                tag_name,
                first,
                second,
            } => write!(
                formatter,
                "Write-selector collision for 1{group1}:7{group7}:{tag_name}: targets {first:?} and {second:?}"
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

fn target_pass_status(
    arguments: &[String],
    attempted: bool,
    result: &Result<(), String>,
    skipped_reason: impl FnOnce() -> String,
) -> TargetApplyPassStatus {
    if arguments.is_empty() {
        TargetApplyPassStatus::NotApplicable
    } else if attempted {
        match result {
            Ok(()) => TargetApplyPassStatus::Succeeded,
            Err(error) => TargetApplyPassStatus::Failed {
                error: error.clone(),
            },
        }
    } else {
        TargetApplyPassStatus::Skipped {
            reason: skipped_reason(),
        }
    }
}

fn target_write_evidence(
    plan: &TargetPlan,
    numeric_attempted: bool,
    numeric_result: &Result<(), String>,
    text_attempted: bool,
    text_result: &Result<(), String>,
    write_diagnostic: Option<&str>,
) -> TargetApplyWriteEvidence {
    TargetApplyWriteEvidence {
        selector: plan.selector.clone(),
        arguments: TargetApplyArguments {
            numeric: plan.args.numeric.clone(),
            text: plan.args.text.clone(),
        },
        numeric_pass: target_pass_status(
            &plan.args.numeric,
            numeric_attempted,
            numeric_result,
            || "numeric pass was not attempted".to_string(),
        ),
        text_pass: target_pass_status(&plan.args.text, text_attempted, text_result, || {
            match numeric_result {
                Err(error) => {
                    format!("text pass was skipped because the numeric pass failed: {error}")
                }
                Ok(()) => "text pass was not attempted".to_string(),
            }
        }),
        diagnostic: write_diagnostic.map(str::to_owned),
    }
}

#[allow(clippy::too_many_arguments)]
fn target_audit_record(
    plan: &TargetPlan,
    numeric_attempted: bool,
    numeric_result: &Result<(), String>,
    text_attempted: bool,
    text_result: &Result<(), String>,
    write_diagnostic: Option<&str>,
    post_write: TargetApplyPostWriteState,
    verification: &TargetVerification,
) -> TargetApplyAuditRecord {
    TargetApplyAuditRecord {
        target: plan.target.clone(),
        display_name: plan.display_name.clone(),
        intent: plan.edit.intent.clone(),
        sent: plan.edit.value.clone(),
        before: plan.before.clone(),
        write: target_write_evidence(
            plan,
            numeric_attempted,
            numeric_result,
            text_attempted,
            text_result,
            write_diagnostic,
        ),
        post_write,
        verification: TargetApplyVerificationEvidence {
            kind: verification.kind.clone(),
            message: verification.message.clone(),
            proposed_reconciliation: verification.draft_reconciliation.clone(),
        },
    }
}

fn observed_occurrence(occurrence: &MetadataOccurrence) -> TargetApplyObservedOccurrence {
    TargetApplyObservedOccurrence {
        occurrence_id: occurrence.id.clone(),
        schema_id: Some(occurrence.schema_id.clone()),
        write_target: occurrence.write_target.clone(),
        value: occurrence.value.clone(),
    }
}

fn plan_batch<F>(
    abs_path: &Path,
    edits: &[MetadataTargetDraftEntry],
    before: &scanner::ImageMetadata,
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
            MetadataDraftTarget::ExistingOccurrence { occurrence_id, .. } => {
                let occurrence = occurrences.get(occurrence_id).copied().ok_or_else(|| {
                    TargetApplyError::ExistingOccurrenceMissing(Box::new(entry.target.clone()))
                })?;
                entry
                    .target
                    .validate_existing_occurrence(occurrence)
                    .map_err(|error| TargetApplyError::ExistingTargetValidationFailure {
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
                }
            }
            MetadataDraftTarget::NewProperty {
                schema_id,
                write_target,
            } => {
                let info = schema_lookup(schema_id).ok_or_else(|| {
                    TargetApplyError::NewPropertySchemaMissing(Box::new(entry.target.clone()))
                })?;
                if !info.supports_metadata_write() {
                    return Err(TargetApplyError::NewPropertySchemaReadOnly(Box::new(
                        entry.target.clone(),
                    )));
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
        combined.extend(plan.args.clone());
        plans.push(plan);
    }

    if combined.is_empty() {
        return Err(TargetApplyError::NoWriteArguments);
    }

    let numeric_argfile = (!combined.numeric.is_empty())
        .then(|| {
            build_exiftool_write_argfile_args(abs_path, &combined.numeric, true)
                .and_then(|args| render_exiftool_argfile(&args))
        })
        .transpose()
        .map_err(TargetApplyError::ArgfileRenderingFailure)?;
    let text_argfile = (!combined.text.is_empty())
        .then(|| {
            build_exiftool_write_argfile_args(abs_path, &combined.text, false)
                .and_then(|args| render_exiftool_argfile(&args))
        })
        .transpose()
        .map_err(TargetApplyError::ArgfileRenderingFailure)?;

    Ok(PlannedBatch {
        targets: plans,
        numeric_argfile,
        text_argfile,
    })
}

pub fn apply_single_file_metadata(
    folder_path: &str,
    rel_path: &str,
    edits: &[MetadataTargetDraftEntry],
) -> MetadataSingleFileOutcome {
    let registry = crate::tag_schema::get_registry().ok();
    apply_single_file_metadata_with_client(
        folder_path,
        rel_path,
        edits,
        &RealMetadataTargetWriteClient,
        |id| registry.and_then(|value| value.lookup(id)).cloned(),
    )
}

fn apply_single_file_metadata_with_client<C, F>(
    folder_path: &str,
    rel_path: &str,
    edits: &[MetadataTargetDraftEntry],
    client: &C,
    schema_lookup: F,
) -> MetadataSingleFileOutcome
where
    C: MetadataTargetWriteClient,
    F: Fn(&SchemaDefinitionId) -> Option<TagInfo>,
{
    if edits.is_empty() {
        return MetadataSingleFileOutcome::hard_failure(TargetApplyError::NoEdits);
    }

    let abs_path =
        Path::new(folder_path).join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !abs_path.exists() {
        return MetadataSingleFileOutcome::hard_failure(TargetApplyError::FileMissing(
            abs_path.display().to_string(),
        ));
    }

    let before = match client.read_image_metadata(rel_path, &abs_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return MetadataSingleFileOutcome::hard_failure(TargetApplyError::PreWriteReadFailure(
                error,
            ));
        }
    };

    let planned = match plan_batch(&abs_path, edits, &before, schema_lookup) {
        Ok(planned) => planned,
        Err(error) => return MetadataSingleFileOutcome::hard_failure(error),
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
            let mut outcomes = Vec::with_capacity(planned.targets.len());
            let mut audit_records = Vec::with_capacity(planned.targets.len());
            for plan in planned.targets {
                let verification = TargetVerification {
                    kind: "ReadbackFailed".to_string(),
                    message: Some(format!(
                        "Verification could not be completed because authoritative post-write readback failed: {read_error}"
                    )),
                    observed: None,
                    draft_reconciliation: MetadataDraftReconciliation::Keep,
                };
                audit_records.push(target_audit_record(
                    &plan,
                    numeric_attempted,
                    &numeric_result,
                    text_attempted,
                    &text_result,
                    write_failure.as_deref(),
                    TargetApplyPostWriteState::Unavailable {
                        cause: TargetApplyPostWriteUnavailableCause::ReadbackFailed,
                        message: read_error.clone(),
                    },
                    &verification,
                ));
                outcomes.push(MetadataTargetOutcome {
                    target: plan.target,
                    draft_reconciliation: verification.draft_reconciliation,
                    display_name: plan.display_name,
                    kind: verification.kind,
                    sent: plan.edit.value,
                    before: plan.before,
                    observed: verification.observed,
                    message: verification.message,
                });
            }
            return MetadataSingleFileOutcome {
                fresh_image_metadata: None,
                error: Some(error),
                warning: None,
                outcomes,
                targets_to_clear: Vec::new(),
                audit_records,
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
            let mut outcomes = Vec::with_capacity(planned.targets.len());
            let mut audit_records = Vec::with_capacity(planned.targets.len());
            for plan in planned.targets {
                let verification = TargetVerification {
                    kind: "ReadbackInvalid".to_string(),
                    message: Some(format!(
                        "Verification was not attempted because {invariant_message}"
                    )),
                    observed: None,
                    draft_reconciliation: MetadataDraftReconciliation::Keep,
                };
                audit_records.push(target_audit_record(
                    &plan,
                    numeric_attempted,
                    &numeric_result,
                    text_attempted,
                    &text_result,
                    write_failure.as_deref(),
                    TargetApplyPostWriteState::Unavailable {
                        cause: TargetApplyPostWriteUnavailableCause::ReadbackInvalid,
                        message: invariant_message.clone(),
                    },
                    &verification,
                ));
                outcomes.push(MetadataTargetOutcome {
                    target: plan.target,
                    draft_reconciliation: verification.draft_reconciliation,
                    display_name: plan.display_name,
                    kind: verification.kind,
                    sent: plan.edit.value,
                    before: plan.before,
                    observed: verification.observed,
                    message: verification.message,
                });
            }
            return MetadataSingleFileOutcome {
                fresh_image_metadata: None,
                error: Some(error),
                warning: None,
                outcomes,
                targets_to_clear: Vec::new(),
                audit_records,
            };
        }
    };

    let verified_targets = planned
        .targets
        .into_iter()
        .map(|plan| {
            let verified = verify_plan(&plan, &post_by_id);
            (plan, verified)
        })
        .collect::<Vec<_>>();
    let mut outcomes = Vec::with_capacity(verified_targets.len());
    let mut first_mismatch = None;

    for (plan, verified) in &verified_targets {
        let verification = &verified.verification;
        let mut message = verification.message.clone();
        if !matches!(
            &verification.draft_reconciliation,
            MetadataDraftReconciliation::Clear
        ) {
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
            target: plan.target.clone(),
            draft_reconciliation: verification.draft_reconciliation.clone(),
            display_name: plan.display_name.clone(),
            kind: verification.kind.clone(),
            sent: plan.edit.value.clone(),
            before: plan.before.clone(),
            observed: verification.observed.clone(),
            message,
        });
    }
    let targets_to_clear = targets_to_clear_from_reconciliation(&outcomes);

    let diagnostics = format_apply_diagnostics(
        numeric_attempted,
        &numeric_result,
        text_attempted,
        &text_result,
        targets_to_clear.len(),
        outcomes.len(),
    );
    let write_diagnostic = diagnostics
        .error
        .as_deref()
        .or(diagnostics.warning.as_deref());
    let audit_records = verified_targets
        .into_iter()
        .map(|(plan, verified)| {
            target_audit_record(
                &plan,
                numeric_attempted,
                &numeric_result,
                text_attempted,
                &text_result,
                write_diagnostic,
                verified.post_write,
                &verified.verification,
            )
        })
        .collect();

    // The batch coordinator appends this evidence to the independent
    // target-aware log after draft reconciliation and any persistence attempt.
    MetadataSingleFileOutcome {
        fresh_image_metadata: Some(fresh),
        error: diagnostics.error.or(first_mismatch),
        warning: diagnostics.warning,
        outcomes,
        targets_to_clear,
        audit_records,
    }
}

fn targets_to_clear_from_reconciliation(
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

fn build_strict_post_write_occurrence_index(
    fresh: &scanner::ImageMetadata,
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

fn merged_lang_alt_readback(
    schema_id: &SchemaDefinitionId,
    primary: &MetadataOccurrence,
    candidates: &[&MetadataOccurrence],
) -> Option<MetadataValue> {
    let mut languages = BTreeMap::new();
    let child_prefix = format!("{}-", primary.id.runtime_tag_id);
    for occurrence in candidates.iter().copied().filter(|occurrence| {
        &occurrence.schema_id == schema_id
            && occurrence.id.document == primary.id.document
            && occurrence.id.path == primary.id.path
            && occurrence.id.copy == primary.id.copy
            && (occurrence.id.runtime_tag_id == primary.id.runtime_tag_id
                || occurrence.id.runtime_tag_id.starts_with(&child_prefix))
    }) {
        let MetadataValue::LangAlt(observed) = &occurrence.value else {
            return None;
        };
        for (language, value) in observed {
            match languages.get(language) {
                Some(existing) if existing != value => return None,
                Some(_) => {}
                None => {
                    languages.insert(language.clone(), value.clone());
                }
            }
        }
    }
    (!languages.is_empty()).then_some(MetadataValue::LangAlt(languages))
}

fn verify_plan(
    plan: &TargetPlan,
    post_by_id: &BTreeMap<MetadataOccurrenceId, &MetadataOccurrence>,
) -> VerifiedTarget {
    match &plan.target {
        MetadataDraftTarget::ExistingOccurrence { occurrence_id, .. } => {
            let occurrence = post_by_id.get(occurrence_id).copied();
            VerifiedTarget {
                verification: verify_existing_plan(plan, occurrence),
                post_write: match occurrence {
                    Some(occurrence) => TargetApplyPostWriteState::Unique {
                        occurrence: Box::new(observed_occurrence(occurrence)),
                    },
                    None => TargetApplyPostWriteState::Missing,
                },
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
                [] => TargetVerification {
                    kind: if candidates.is_empty() {
                        "MissingPostWrite".to_string()
                    } else {
                        "TargetChangedPostWrite".to_string()
                    },
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
                    let merged_lang_alt = matches!(plan.kind, TagKind::LangAlt)
                        .then(|| merged_lang_alt_readback(schema_id, occurrence, &candidates))
                        .flatten();
                    let observed = merged_lang_alt.as_ref().unwrap_or(&occurrence.value);
                    let (kind, message) = verify_semantic(
                        schema_id,
                        &plan.edit,
                        Some(observed),
                        Some(&plan.kind),
                    );
                    let draft_reconciliation = if kind == "Match" {
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
                        observed: Some(observed.clone()),
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

fn ambiguous_new_property_verification(
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

fn verify_existing_plan(
    plan: &TargetPlan,
    occurrence: Option<&MetadataOccurrence>,
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
        if plan.edit.intent == EditIntent::Delete {
            return TargetVerification {
                kind: "DeleteOk".to_string(),
                message: None,
                observed: None,
                draft_reconciliation: MetadataDraftReconciliation::Clear,
            };
        }
        let reason = format!("Exact occurrence {occurrence_id:?} no longer exists");
        return TargetVerification {
            kind: "MissingPostWrite".to_string(),
            message: Some(format!(
                "Exact occurrence {occurrence_id:?} is absent after write"
            )),
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
    let draft_reconciliation = if matches!(kind.as_str(), "Match" | "DeleteOk") {
        MetadataDraftReconciliation::Clear
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

fn verify_semantic(
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
            runtime_tag_id: tag_id.to_string(),
            tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                table: "Exif::Main".to_string(),
                tag_id: tag_id.to_string(),
                index: None,
            },
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
        let schema_id = info
            .as_ref()
            .expect("tests without TagInfo must use occurrence_with_schema")
            .id
            .clone();
        occurrence_with_schema(id, schema_id, value, info, group, name)
    }

    fn occurrence_with_schema(
        id: MetadataOccurrenceId,
        schema_id: SchemaDefinitionId,
        value: MetadataValue,
        info: Option<TagInfo>,
        group: Option<&str>,
        name: &str,
    ) -> MetadataOccurrence {
        let group7 =
            crate::metadata_occurrence::family7_group_from_runtime_tag_id(&id.runtime_tag_id);
        let write_group = group
            .map(str::to_owned)
            .or_else(|| info.as_ref().map(|tag_info| tag_info.group.clone()));
        let observed_selector = write_group.as_ref().map(|group1| {
            crate::metadata_occurrence::MetadataObservedSelector {
                group1: group1.clone(),
                group7: group7.clone(),
                tag_name: name.to_string(),
            }
        });
        MetadataOccurrence {
            id,
            schema_id,
            value,
            tag_info: info,
            observed_selector,
            write_target: write_group.map(|group1| MetadataWriteTarget {
                group1,
                group7,
                tag_name: name.to_string(),
            }),
        }
    }

    fn image(occurrences: Vec<MetadataOccurrence>) -> scanner::ImageMetadata {
        scanner::ImageMetadata {
            relative_path: "photo.jpg".to_string(),
            occurrences: MetadataOccurrences(occurrences),
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
    ) -> MetadataTargetDraftEntry {
        MetadataTargetDraftEntry {
            target: MetadataDraftTarget::from_existing_occurrence(occurrence).unwrap(),
            edit,
        }
    }

    fn new_entry(info: &TagInfo, edit: MetadataDraftEdit) -> MetadataTargetDraftEntry {
        MetadataTargetDraftEntry {
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
        edits: &[MetadataTargetDraftEntry],
        client: &FakeClient,
        infos: &[TagInfo],
    ) -> MetadataSingleFileOutcome {
        with_temp_file(|folder, rel| {
            apply_single_file_metadata_with_client(
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
        assert!(empty.audit_records.is_empty());
        assert!(empty_client.calls.borrow().is_empty());

        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("x".into()))),
        );
        let missing_client = FakeClient::new(Vec::new());
        let missing = apply_single_file_metadata_with_client(
            "definitely-missing-folder",
            "missing.jpg",
            std::slice::from_ref(&entry),
            &missing_client,
            |_| Some(info.clone()),
        );
        assert!(missing.error.unwrap().contains("File not found"));
        assert!(missing.audit_records.is_empty());
        assert!(missing_client.calls.borrow().is_empty());

        let failed_client = FakeClient::new(vec![Err("pre-read boom".into())]);
        let failed = apply_fake(std::slice::from_ref(&entry), &failed_client, &[info]);
        assert!(failed.error.unwrap().contains("pre-write read failed"));
        assert_eq!(&*failed_client.calls.borrow(), &["read"]);
        assert!(failed.outcomes.is_empty());
        assert!(failed.targets_to_clear.is_empty());
        assert!(failed.audit_records.is_empty());
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
            assert!(matches!(error, TargetApplyError::DuplicateDraftSlot { .. }));
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
            Err(TargetApplyError::DuplicateDraftSlot { .. })
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
            Err(TargetApplyError::DuplicatePreWriteOccurrenceId(_))
        ));
        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&entry),
                &image(vec![]),
                |_| None
            ),
            Err(TargetApplyError::ExistingOccurrenceMissing(_))
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
                Err(TargetApplyError::ExistingTargetValidationFailure { .. })
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
            Err(TargetApplyError::NewPropertySchemaMissing(_))
        ));
        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&set),
                &image(vec![]),
                |_| Some(readonly.clone())
            ),
            Err(TargetApplyError::NewPropertySchemaReadOnly(_))
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
            Err(TargetApplyError::NewPropertySelectorOccupied { .. })
        ));

        for intent in [EditIntent::Delete, EditIntent::ListRemove] {
            let unsupported = new_entry(&writable, edit(intent.clone(), None));
            assert!(matches!(
                plan_batch(Path::new("p"), &[unsupported], &image(vec![]), |_| Some(writable.clone())),
                Err(TargetApplyError::UnsupportedNewPropertyIntent { intent: actual, .. }) if actual == intent
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
        let mut info_b = schema("1", "ifd0", "same", true, TagKind::Text);
        info_b.id.index = Some(1);
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
            Err(TargetApplyError::NewPropertySelectorOccupied { .. })
        ));

        let mut info_c = schema("1", "IFD0", "Same", true, TagKind::Text);
        info_c.id.index = Some(2);
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
            Err(TargetApplyError::WriteSelectorCollision { .. })
        ));
    }

    #[test]
    fn new_property_occupancy_is_destination_aware_and_conservative_without_a_target() {
        let info = schema(
            "282",
            "IFD1",
            "XResolution",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Integer(72))),
        );
        let existing_elsewhere = occurrence(
            occurrence_id("EXISTING-IFD0", "282", 0),
            MetadataValue::Integer(300),
            Some(info.clone()),
            Some("IFD0"),
            "XResolution",
        );
        assert!(plan_batch(
            Path::new("p"),
            std::slice::from_ref(&entry),
            &image(vec![existing_elsewhere.clone()]),
            |_| Some(info.clone()),
        )
        .is_ok());

        let exact = occurrence(
            occurrence_id("EXISTING-IFD1", "282", 0),
            MetadataValue::Integer(72),
            Some(info.clone()),
            Some("IFD1"),
            "XResolution",
        );
        assert!(matches!(
            plan_batch(
                Path::new("p"),
                std::slice::from_ref(&entry),
                &image(vec![exact]),
                |_| Some(info.clone()),
            ),
            Err(TargetApplyError::NewPropertySelectorOccupied { .. })
        ));

        let mut ambiguous = existing_elsewhere;
        ambiguous.observed_selector = None;
        ambiguous.write_target = None;
        assert!(matches!(
            plan_batch(Path::new("p"), &[entry], &image(vec![ambiguous]), |_| Some(
                info.clone()
            ),),
            Err(TargetApplyError::NewPropertySchemaOccupancyUnknown { .. })
        ));
    }

    #[test]
    fn new_property_blocks_cross_schema_observed_selector_without_write_target() {
        let proposed = schema("shared", "IFD0", "SharedName", true, TagKind::Text);
        let entry = new_entry(
            &proposed,
            edit(EditIntent::Set, Some(MetadataValue::Text("new".into()))),
        );
        let existing_schema = schema("other", "IFD0", "OtherName", false, TagKind::Text);
        let mut existing = occurrence_with_schema(
            occurrence_id("EXISTING", "shared", 0),
            existing_schema.id.clone(),
            MetadataValue::Text("old".into()),
            Some(existing_schema),
            Some("IFD0"),
            "SharedName",
        );
        existing.write_target = None;

        let Err(error) = plan_batch(
            Path::new("p"),
            &[entry],
            &image(vec![existing.clone()]),
            |_| Some(proposed.clone()),
        ) else {
            panic!("cross-schema occupied selector must fail planning")
        };
        assert!(matches!(
            error,
            TargetApplyError::NewPropertySelectorOccupied { occurrences, .. }
                if occurrences == vec![(existing.id, existing.schema_id)]
        ));
    }

    #[test]
    fn every_pre_execution_failure_path_returns_no_audit_records() {
        let assert_no_audit = |outcome: MetadataSingleFileOutcome| {
            assert!(outcome.error.is_some());
            assert!(outcome.outcomes.is_empty());
            assert!(outcome.audit_records.is_empty());
        };
        let info = schema("1", "IFD0", "Name", true, TagKind::Text);
        let original = occurrence(
            occurrence_id("P", "1", 0),
            MetadataValue::Text("before".into()),
            Some(info.clone()),
            Some("IFD0"),
            "Name",
        );
        let existing = existing_entry(
            &original,
            edit(EditIntent::Set, Some(MetadataValue::Text("after".into()))),
        );

        let duplicate_slot_client = FakeClient::new(vec![Ok(image(vec![original.clone()]))]);
        assert_no_audit(apply_fake(
            &[existing.clone(), existing.clone()],
            &duplicate_slot_client,
            &[],
        ));

        let duplicate_pre_client =
            FakeClient::new(vec![Ok(image(vec![original.clone(), original.clone()]))]);
        assert_no_audit(apply_fake(
            std::slice::from_ref(&existing),
            &duplicate_pre_client,
            &[],
        ));

        let missing_existing_client = FakeClient::new(vec![Ok(image(vec![]))]);
        assert_no_audit(apply_fake(
            std::slice::from_ref(&existing),
            &missing_existing_client,
            &[],
        ));

        let mut stale = original.clone();
        stale.write_target.as_mut().unwrap().group1 = "IFD1".into();
        let stale_client = FakeClient::new(vec![Ok(image(vec![stale]))]);
        assert_no_audit(apply_fake(
            std::slice::from_ref(&existing),
            &stale_client,
            &[],
        ));

        let new = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("new".into()))),
        );
        let missing_schema_client = FakeClient::new(vec![Ok(image(vec![]))]);
        assert_no_audit(apply_fake(
            std::slice::from_ref(&new),
            &missing_schema_client,
            &[],
        ));

        let mut readonly = info.clone();
        readonly.writable = false;
        let readonly_client = FakeClient::new(vec![Ok(image(vec![]))]);
        assert_no_audit(apply_fake(
            std::slice::from_ref(&new),
            &readonly_client,
            &[readonly],
        ));

        let already_present_client = FakeClient::new(vec![Ok(image(vec![original.clone()]))]);
        assert_no_audit(apply_fake(
            std::slice::from_ref(&new),
            &already_present_client,
            std::slice::from_ref(&info),
        ));

        let unsupported = new_entry(&info, edit(EditIntent::Delete, None));
        let unsupported_client = FakeClient::new(vec![Ok(image(vec![]))]);
        assert_no_audit(apply_fake(
            &[unsupported],
            &unsupported_client,
            std::slice::from_ref(&info),
        ));

        let mut colliding_info = schema("1", "ifd0", "name", true, TagKind::Text);
        colliding_info.id.index = Some(1);
        let colliding = new_entry(
            &colliding_info,
            edit(
                EditIntent::Set,
                Some(MetadataValue::Text("collision".into())),
            ),
        );
        let collision_client = FakeClient::new(vec![Ok(image(vec![original.clone()]))]);
        assert_no_audit(apply_fake(
            &[existing.clone(), colliding],
            &collision_client,
            std::slice::from_ref(&colliding_info),
        ));

        let binary_info = schema("3", "XMP-test", "Binary", true, TagKind::Binary);
        let binary = MetadataTargetDraftEntry {
            target: MetadataDraftTarget::NewProperty {
                schema_id: binary_info.id.clone(),
                write_target: MetadataWriteTarget {
                    group1: binary_info.group.clone(),
                    group7: crate::metadata_occurrence::family7_group_from_schema_id(
                        &binary_info.id,
                    ),
                    tag_name: binary_info.name.clone(),
                },
            },
            edit: edit(EditIntent::Set, Some(MetadataValue::Binary)),
        };
        let argument_failure_client = FakeClient::new(vec![Ok(image(vec![]))]);
        assert_no_audit(apply_fake(
            &[binary],
            &argument_failure_client,
            &[binary_info],
        ));

        let lang_alt_info = schema("4", "XMP-test", "Title", true, TagKind::LangAlt);
        let no_arguments = new_entry(
            &lang_alt_info,
            edit(
                EditIntent::Set,
                Some(MetadataValue::LangAlt(BTreeMap::new())),
            ),
        );
        let no_arguments_client = FakeClient::new(vec![Ok(image(vec![]))]);
        assert_no_audit(apply_fake(
            &[no_arguments],
            &no_arguments_client,
            &[lang_alt_info],
        ));

        let nul_info = schema("5", "XMP-test", "Comment", true, TagKind::Text);
        let unrenderable = new_entry(
            &nul_info,
            edit(
                EditIntent::Set,
                Some(MetadataValue::Text("contains\0nul".into())),
            ),
        );
        let rendering_failure_client = FakeClient::new(vec![Ok(image(vec![]))]);
        assert_no_audit(apply_fake(
            &[unrenderable],
            &rendering_failure_client,
            &[nul_info],
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
        assert!(rendered.contains("-1IFD0:7ID-282:XResolution=600"));
        assert!(rendered.contains("-1IFD1:7ID-282:XResolution=144"));
        assert!(!rendered.contains("SchemaMustNotBeUsed:XResolution"));
        assert_eq!(outcome.outcomes[0].before, Some(ifd0.value.clone()));
        assert_eq!(outcome.outcomes[1].before, Some(ifd1.value.clone()));
        assert_eq!(outcome.outcomes[0].kind, "Match");
        assert_eq!(outcome.outcomes[1].kind, "Mismatch");
        assert_eq!(
            outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Clear
        );
        assert_eq!(
            outcome.outcomes[1].draft_reconciliation,
            MetadataDraftReconciliation::Keep
        );
        assert_eq!(outcome.outcomes[0].target, edits[0].target);
        assert_eq!(outcome.outcomes[1].target, edits[1].target);
        assert_eq!(outcome.targets_to_clear, vec![edits[0].target.clone()]);
        assert!(outcome.error.is_some());
        assert_eq!(outcome.audit_records.len(), 2);
        for (record, entry) in outcome.audit_records.iter().zip(&edits) {
            assert_eq!(record.target, entry.target);
            assert_eq!(record.intent, entry.edit.intent);
            assert_eq!(record.sent, entry.edit.value);
            assert!(record.write.diagnostic.is_none());
            assert!(matches!(
                record.write.numeric_pass,
                TargetApplyPassStatus::Succeeded
            ));
            assert!(matches!(
                record.write.text_pass,
                TargetApplyPassStatus::NotApplicable
            ));
        }
        assert_eq!(outcome.audit_records[0].before, Some(ifd0.value.clone()));
        assert_eq!(outcome.audit_records[1].before, Some(ifd1.value.clone()));
        assert_eq!(
            outcome.audit_records[0].write.selector,
            ifd0.write_target.clone().unwrap()
        );
        assert_eq!(
            outcome.audit_records[1].write.selector,
            ifd1.write_target.clone().unwrap()
        );
        assert_eq!(
            outcome.audit_records[0].write.arguments.numeric,
            vec!["-1IFD0:7ID-282:XResolution=600/1"]
        );
        assert_eq!(
            outcome.audit_records[1].write.arguments.numeric,
            vec!["-1IFD1:7ID-282:XResolution=144/1"]
        );
        assert!(outcome.audit_records[0].write.arguments.text.is_empty());
        assert!(outcome.audit_records[1].write.arguments.text.is_empty());
        for (record, expected) in outcome.audit_records.iter().zip([&after0, &after1]) {
            let TargetApplyPostWriteState::Unique { occurrence } = &record.post_write else {
                panic!("existing target must retain its exact post-write occurrence")
            };
            assert_eq!(occurrence.occurrence_id, expected.id);
            assert_eq!(occurrence.schema_id.as_ref(), Some(&expected.schema_id));
            assert_eq!(occurrence.write_target, expected.write_target);
            assert_eq!(occurrence.value, expected.value);
        }
        assert_eq!(
            outcome.audit_records[0]
                .verification
                .proposed_reconciliation,
            MetadataDraftReconciliation::Clear
        );
        assert_eq!(
            outcome.audit_records[1]
                .verification
                .proposed_reconciliation,
            MetadataDraftReconciliation::Keep
        );
        assert_eq!(outcome.audit_records[1].verification.kind, "Mismatch");
        assert_eq!(
            outcome.audit_records[1].verification.message,
            outcome.outcomes[1].message
        );
        let fresh = outcome.fresh_image_metadata.unwrap();
        assert_eq!(fresh.occurrences.0, vec![after1.clone(), after0.clone()]);

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
        assert_eq!(
            ordered
                .audit_records
                .iter()
                .map(|record| record.target.clone())
                .collect::<Vec<_>>(),
            edits
                .iter()
                .map(|entry| entry.target.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn audit_new_property_resolution_keeps_none_and_zero_schema_indexes_distinct() {
        let unindexed = schema("7", "XMP-none", "Unindexed", true, TagKind::Text);
        let mut indexed = schema("7", "XMP-zero", "Indexed", true, TagKind::Text);
        indexed.id.index = Some(0);
        let entries = [
            new_entry(
                &unindexed,
                edit(EditIntent::Set, Some(MetadataValue::Text("none".into()))),
            ),
            new_entry(
                &indexed,
                edit(EditIntent::Set, Some(MetadataValue::Text("zero".into()))),
            ),
        ];
        let unindexed_post = occurrence(
            occurrence_id("UNINDEXED", "7", 0),
            MetadataValue::Text("none".into()),
            Some(unindexed.clone()),
            Some("XMP-none"),
            "Unindexed",
        );
        let indexed_post = occurrence(
            occurrence_id("INDEXED", "7", 0),
            MetadataValue::Text("zero".into()),
            Some(indexed.clone()),
            Some("XMP-zero"),
            "Indexed",
        );
        let client = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![indexed_post.clone(), unindexed_post.clone()])),
        ]);
        let outcome = apply_fake(&entries, &client, &[unindexed.clone(), indexed.clone()]);

        assert_eq!(outcome.audit_records.len(), 2);
        assert_eq!(outcome.audit_records[0].target.schema_id().index, None);
        assert_eq!(outcome.audit_records[1].target.schema_id().index, Some(0));
        for (record, expected) in outcome
            .audit_records
            .iter()
            .zip([&unindexed_post, &indexed_post])
        {
            let TargetApplyPostWriteState::Unique { occurrence } = &record.post_write else {
                panic!("each exact schema ID must resolve uniquely")
            };
            assert_eq!(occurrence.occurrence_id, expected.id);
            assert_eq!(
                occurrence.schema_id.as_ref(),
                Some(record.target.schema_id())
            );
            assert_eq!(
                record.verification.proposed_reconciliation,
                MetadataDraftReconciliation::Clear
            );
        }
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
            TargetApplyError::PostWriteDuplicateOccurrenceId { occurrence_id }
                if occurrence_id.as_ref() == &duplicate.id
        ));
        let message = error.to_string();
        assert!(message.contains("post-write"));
        assert!(message.contains("duplicate exact occurrence ID"));
        assert!(message.contains("DUPLICATE-PATH"));
        assert!(!matches!(
            error,
            TargetApplyError::DuplicatePreWriteOccurrenceId(_)
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
            assert_eq!(
                outcome.outcomes[0].draft_reconciliation,
                MetadataDraftReconciliation::Keep
            );
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
            assert_eq!(
                outcome.outcomes[0].draft_reconciliation,
                MetadataDraftReconciliation::Keep
            );
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
                assert_eq!(
                    target_outcome.draft_reconciliation,
                    MetadataDraftReconciliation::Keep
                );
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
            assert_eq!(outcome.audit_records.len(), edits.len());
            for (audit, entry) in outcome.audit_records.iter().zip(&edits) {
                assert_eq!(audit.target, entry.target);
                assert!(matches!(
                    audit.post_write,
                    TargetApplyPostWriteState::Unavailable {
                        cause: TargetApplyPostWriteUnavailableCause::ReadbackInvalid,
                        ..
                    }
                ));
                assert_eq!(
                    audit.verification.proposed_reconciliation,
                    MetadataDraftReconciliation::Keep
                );
            }
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
        let unrelated = occurrence_with_schema(
            occurrence_id("UNRELATED-DUPLICATE", "999", 4),
            SchemaDefinitionId {
                table: "Unknown::Table".to_owned(),
                tag_id: "999".to_owned(),
                index: None,
            },
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
            apply_fake(std::slice::from_ref(&entry), &client, &[])
                .outcomes
                .remove(0)
        };
        for (post, expected_kind, expected_reconciliation) in [
            (
                vec![occurrence(
                    before.id.clone(),
                    MetadataValue::Integer(2),
                    Some(info.clone()),
                    Some("IFD0"),
                    "Number",
                )],
                "Match",
                MetadataDraftReconciliation::Clear,
            ),
            (
                vec![occurrence(
                    before.id.clone(),
                    MetadataValue::Real(2.0),
                    Some(info.clone()),
                    Some("IFD0"),
                    "Number",
                )],
                "Coerced",
                MetadataDraftReconciliation::Keep,
            ),
            (
                vec![occurrence(
                    before.id.clone(),
                    MetadataValue::Integer(3),
                    Some(info.clone()),
                    Some("IFD0"),
                    "Number",
                )],
                "Mismatch",
                MetadataDraftReconciliation::Keep,
            ),
            (
                vec![occurrence(
                    before.id.clone(),
                    MetadataValue::Unknown {
                        expected: Some(info.kind.clone()),
                        raw: serde_json::json!("bad"),
                        reason: Some("parse".into()),
                    },
                    Some(info.clone()),
                    Some("IFD0"),
                    "Number",
                )],
                "UnparsedPostWrite",
                MetadataDraftReconciliation::Keep,
            ),
        ] {
            let outcome = run(post);
            assert_eq!(outcome.kind, expected_kind);
            assert_eq!(outcome.draft_reconciliation, expected_reconciliation);
            assert_eq!(outcome.target, entry.target);
        }
        let missing = run(vec![]);
        assert_eq!(missing.kind, "MissingPostWrite");
        assert!(matches!(
            missing.draft_reconciliation,
            MetadataDraftReconciliation::Blocked { ref reason }
                if reason.contains("no longer exists")
        ));
        assert_eq!(missing.target, entry.target);
        let mut changed_schema = info.clone();
        changed_schema.id.tag_id = "changed".into();
        let changed_schema_outcome = run(vec![occurrence(
            before.id.clone(),
            MetadataValue::Integer(2),
            Some(changed_schema),
            Some("IFD0"),
            "Number",
        )]);
        assert_eq!(changed_schema_outcome.kind, "TargetChangedPostWrite");
        assert!(matches!(
            changed_schema_outcome.draft_reconciliation,
            MetadataDraftReconciliation::Blocked { ref reason } if reason.contains("stale")
        ));
        let changed_selector_outcome = run(vec![occurrence(
            before.id.clone(),
            MetadataValue::Integer(2),
            Some(info.clone()),
            Some("IFD1"),
            "Number",
        )]);
        assert_eq!(changed_selector_outcome.kind, "TargetChangedPostWrite");
        assert!(matches!(
            changed_selector_outcome.draft_reconciliation,
            MetadataDraftReconciliation::Blocked { ref reason } if reason.contains("stale")
        ));

        let sibling = occurrence(
            occurrence_id("OTHER", "1", 1),
            MetadataValue::Integer(2),
            Some(info),
            Some("IFD1"),
            "Number",
        );
        let sibling_outcome = run(vec![sibling]);
        assert_eq!(sibling_outcome.kind, "MissingPostWrite");
        assert!(matches!(
            sibling_outcome.draft_reconciliation,
            MetadataDraftReconciliation::Blocked { .. }
        ));
    }

    #[test]
    fn changed_existing_target_remains_unique_audit_evidence_but_is_blocked() {
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
        let changed = occurrence(
            before.id.clone(),
            MetadataValue::Integer(2),
            Some(info),
            Some("IFD1"),
            "Number",
        );
        let client = FakeClient::new(vec![
            Ok(image(vec![before])),
            Ok(image(vec![changed.clone()])),
        ]);
        let outcome = apply_fake(&[entry], &client, &[]);

        let audit = &outcome.audit_records[0];
        let TargetApplyPostWriteState::Unique { occurrence } = &audit.post_write else {
            panic!("the exact original ID must remain unique evidence")
        };
        assert_eq!(occurrence.occurrence_id, changed.id);
        assert_eq!(occurrence.write_target, changed.write_target);
        assert_eq!(occurrence.value, changed.value);
        assert_eq!(audit.verification.kind, "TargetChangedPostWrite");
        assert!(matches!(
            audit.verification.proposed_reconciliation,
            MetadataDraftReconciliation::Blocked { .. }
        ));
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
            let post_is_missing = post.is_empty();
            let client = FakeClient::new(vec![Ok(image(vec![before.clone()])), Ok(image(post))]);
            let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[]);
            assert_eq!(outcome.outcomes[0].kind, expected);
            assert_eq!(outcome.outcomes[0].target, entry.target);
            assert_eq!(
                outcome.outcomes[0].draft_reconciliation,
                if expected == "DeleteOk" {
                    MetadataDraftReconciliation::Clear
                } else {
                    MetadataDraftReconciliation::Keep
                }
            );
            assert_eq!(
                outcome.targets_to_clear.len(),
                usize::from(expected == "DeleteOk")
            );
            let audit = &outcome.audit_records[0];
            assert_eq!(audit.target, entry.target);
            assert_eq!(audit.intent, EditIntent::Delete);
            assert_eq!(audit.sent, None);
            assert_eq!(audit.before, Some(before.value.clone()));
            if post_is_missing {
                assert!(matches!(
                    audit.post_write,
                    TargetApplyPostWriteState::Missing
                ));
                assert_eq!(audit.verification.kind, "DeleteOk");
                assert_eq!(
                    audit.verification.proposed_reconciliation,
                    MetadataDraftReconciliation::Clear
                );
            }
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
            let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[]);
            assert_eq!(outcome.outcomes[0].kind, expected);
            assert_eq!(outcome.outcomes[0].target, entry.target);
            assert_eq!(
                outcome.outcomes[0].draft_reconciliation,
                if expected == "Match" {
                    MetadataDraftReconciliation::Clear
                } else {
                    MetadataDraftReconciliation::Keep
                }
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
            let expected_occurrence = post.first().cloned();
            let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(post))]);
            let outcome = apply_fake(
                std::slice::from_ref(&entry),
                &client,
                std::slice::from_ref(&info),
            );
            assert_eq!(outcome.outcomes[0].kind, expected);
            assert_eq!(outcome.outcomes[0].target, entry.target);
            assert_eq!(
                outcome.outcomes[0].draft_reconciliation,
                if expected == "Match" {
                    MetadataDraftReconciliation::Clear
                } else {
                    MetadataDraftReconciliation::Keep
                }
            );
            assert_eq!(!outcome.targets_to_clear.is_empty(), clear);
            let audit = &outcome.audit_records[0];
            assert_eq!(audit.target, entry.target);
            assert_eq!(
                audit.write.selector,
                MetadataWriteTarget {
                    group1: info.group.clone(),
                    group7: crate::metadata_occurrence::family7_group_from_schema_id(&info.id),
                    tag_name: info.name.clone(),
                }
            );
            match expected_occurrence {
                None => {
                    assert!(matches!(
                        audit.post_write,
                        TargetApplyPostWriteState::Missing
                    ));
                    assert_eq!(
                        audit.verification.proposed_reconciliation,
                        MetadataDraftReconciliation::Keep
                    );
                }
                Some(expected_occurrence) => {
                    let TargetApplyPostWriteState::Unique { occurrence } = &audit.post_write else {
                        panic!("successful creation must retain its exact created occurrence")
                    };
                    assert_eq!(occurrence.occurrence_id, expected_occurrence.id);
                    assert_eq!(occurrence.schema_id, Some(info.id.clone()));
                    assert_eq!(occurrence.write_target, expected_occurrence.write_target);
                    assert_eq!(occurrence.value, expected_occurrence.value);
                    assert_eq!(
                        audit.verification.proposed_reconciliation,
                        MetadataDraftReconciliation::Clear
                    );
                }
            }
        }

        let ifd0_copy0 = occurrence(
            occurrence_id("IFD0", "1", 0),
            MetadataValue::Text("made".into()),
            Some(info.clone()),
            Some("IFD0"),
            "Name",
        );
        // A same-schema occurrence at a different proven destination is not a
        // duplicate of the exact intended result.
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
            assert_eq!(outcome.outcomes[0].kind, "Match");
            assert_eq!(
                outcome.outcomes[0].draft_reconciliation,
                MetadataDraftReconciliation::Clear
            );
            let audit = &outcome.audit_records[0];
            let TargetApplyPostWriteState::Unique { occurrence } = &audit.post_write else {
                panic!("the exact destination must retain only its exact match")
            };
            assert_eq!(occurrence.occurrence_id, unique.id);
        }

        let mut duplicate = unique.clone();
        duplicate.id.path = "DUPLICATE-EXACT".into();
        duplicate.id.copy = 10;
        let client = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![unique.clone(), duplicate.clone()])),
        ]);
        let outcome = apply_fake(
            std::slice::from_ref(&entry),
            &client,
            std::slice::from_ref(&info),
        );
        assert_eq!(outcome.outcomes[0].kind, "AmbiguousPostWrite");
        assert!(matches!(
            outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Blocked { .. }
        ));
        let TargetApplyPostWriteState::Multiple { occurrences } =
            &outcome.audit_records[0].post_write
        else {
            panic!("duplicate exact results must retain every exact candidate")
        };
        assert_eq!(occurrences.len(), 2);
    }

    #[test]
    fn same_schema_new_properties_at_different_destinations_plan_and_verify_independently() {
        let info = schema(
            "282",
            "IFD0",
            "XResolution",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let mut ifd0 = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Integer(300))),
        );
        let mut ifd1 = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Integer(72))),
        );
        let MetadataDraftTarget::NewProperty { write_target, .. } = &mut ifd0.target else {
            unreachable!()
        };
        write_target.group1 = "IFD0".into();
        let MetadataDraftTarget::NewProperty { write_target, .. } = &mut ifd1.target else {
            unreachable!()
        };
        write_target.group1 = "IFD1".into();

        let post0 = occurrence(
            occurrence_id("CREATED-IFD0", "282", 0),
            MetadataValue::Integer(300),
            Some(info.clone()),
            Some("IFD0"),
            "XResolution",
        );
        let post1 = occurrence(
            occurrence_id("CREATED-IFD1", "282", 1),
            MetadataValue::Integer(72),
            Some(info.clone()),
            Some("IFD1"),
            "XResolution",
        );
        let client = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![post1.clone(), post0.clone()])),
        ]);

        let outcome = apply_fake(&[ifd0.clone(), ifd1.clone()], &client, &[info]);
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert_eq!(outcome.targets_to_clear, vec![ifd0.target, ifd1.target]);
        assert!(outcome.outcomes.iter().all(|item| item.kind == "Match"));
        assert_eq!(
            outcome
                .audit_records
                .iter()
                .map(|record| record.write.selector.group1.as_str())
                .collect::<Vec<_>>(),
            vec!["IFD0", "IFD1"]
        );
    }

    #[test]
    fn new_property_readback_rejects_changed_schema_index_and_each_selector_component() {
        let info = schema(
            "282",
            "IFD0",
            "XResolution",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Integer(300))),
        );
        let mut indexed_info = info.clone();
        indexed_info.id.index = Some(0);
        let cases = [
            occurrence(
                occurrence_id("INDEXED", "282", 0),
                MetadataValue::Integer(300),
                Some(indexed_info),
                Some("IFD0"),
                "XResolution",
            ),
            occurrence(
                occurrence_id("OTHER-GROUP", "282", 0),
                MetadataValue::Integer(300),
                Some(info.clone()),
                Some("IFD1"),
                "XResolution",
            ),
            occurrence(
                occurrence_id("OTHER-FAMILY7", "ID-AbC", 0),
                MetadataValue::Integer(300),
                Some(info.clone()),
                Some("IFD0"),
                "XResolution",
            ),
            occurrence(
                occurrence_id("OTHER-NAME", "282", 0),
                MetadataValue::Integer(300),
                Some(info.clone()),
                Some("IFD0"),
                "OtherName",
            ),
        ];

        for post in cases {
            let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![post.clone()]))]);
            let outcome = apply_fake(
                std::slice::from_ref(&entry),
                &client,
                std::slice::from_ref(&info),
            );
            assert_eq!(outcome.outcomes[0].kind, "TargetChangedPostWrite");
            assert_eq!(
                outcome.outcomes[0].draft_reconciliation,
                MetadataDraftReconciliation::Keep
            );
            assert!(outcome.targets_to_clear.is_empty());
            assert_eq!(
                outcome.audit_records[0].write.selector,
                entry.target.write_target().unwrap().clone()
            );
            let TargetApplyPostWriteState::Unique { occurrence } =
                &outcome.audit_records[0].post_write
            else {
                panic!("changed target evidence must retain the observed candidate")
            };
            assert_eq!(occurrence.occurrence_id, post.id);
            assert_eq!(occurrence.schema_id.as_ref(), Some(&post.schema_id));
        }
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
        let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[info]);
        assert_eq!(outcome.outcomes[0].kind, "Match");
        assert_eq!(outcome.outcomes[0].observed, Some(observed));
    }

    #[test]
    fn new_lang_alt_property_merges_child_extraction_occurrences_under_one_exact_parent() {
        let info = schema(
            "description",
            "XMP-test",
            "Description",
            true,
            TagKind::LangAlt,
        );
        let expected = MetadataValue::LangAlt(BTreeMap::from([
            ("fr".to_string(), "Texte exact".to_string()),
            ("x-default".to_string(), "Exact default".to_string()),
        ]));
        let entry = new_entry(&info, edit(EditIntent::Set, Some(expected.clone())));
        let default = occurrence(
            occurrence_id("XMP", "description", 0),
            MetadataValue::LangAlt(BTreeMap::from([(
                "x-default".to_string(),
                "Exact default".to_string(),
            )])),
            Some(info.clone()),
            Some("XMP-test"),
            "Description",
        );
        let french = occurrence(
            occurrence_id("XMP", "description-fr", 0),
            MetadataValue::LangAlt(BTreeMap::from([(
                "fr".to_string(),
                "Texte exact".to_string(),
            )])),
            Some(info.clone()),
            None,
            "Description-fr",
        );
        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![default, french]))]);

        let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[info]);

        assert_eq!(outcome.outcomes[0].kind, "Match");
        assert_eq!(outcome.outcomes[0].observed, Some(expected));
        assert_eq!(
            outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Clear
        );
        assert_eq!(outcome.targets_to_clear, vec![entry.target]);
        assert!(matches!(
            outcome.audit_records[0].post_write,
            TargetApplyPostWriteState::Unique { .. }
        ));
    }

    #[test]
    fn new_property_unique_non_clear_results_replace_with_the_exact_fresh_target() {
        let info = schema(
            "282",
            "SchemaGroupMustNotBeUsed",
            "XResolution",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
        );
        let original_entry = entry.clone();

        for (observed, expected_kind) in [
            (MetadataValue::Real(2.0), "Coerced"),
            (MetadataValue::Integer(3), "Mismatch"),
            (
                MetadataValue::Unknown {
                    expected: Some(info.kind.clone()),
                    raw: serde_json::json!("unparsed"),
                    reason: Some("fixture parse failure".into()),
                },
                "UnparsedPostWrite",
            ),
        ] {
            let fresh = occurrence(
                occurrence_id("JPEG-APP1-IFD1", "282", 7),
                observed.clone(),
                Some(info.clone()),
                Some(&info.group),
                "XResolution",
            );
            let original_fresh = fresh.clone();
            let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![fresh.clone()]))]);
            let outcome = apply_fake(
                std::slice::from_ref(&entry),
                &client,
                std::slice::from_ref(&info),
            );

            assert_eq!(outcome.outcomes[0].kind, expected_kind);
            assert_eq!(outcome.outcomes[0].target, entry.target);
            assert_eq!(outcome.outcomes[0].observed, Some(observed));
            assert!(outcome.targets_to_clear.is_empty());
            let MetadataDraftReconciliation::Replace { target } =
                &outcome.outcomes[0].draft_reconciliation
            else {
                panic!("unique non-clear creation must produce an exact replacement")
            };
            assert_eq!(target.occurrence_id(), Some(&fresh.id));
            assert_eq!(target.schema_id(), &info.id);
            assert_eq!(target.write_target(), fresh.write_target.as_ref());
            assert_eq!(
                target.write_target(),
                Some(&MetadataWriteTarget {
                    group1: info.group.clone(),
                    group7: "ID-282".into(),
                    tag_name: "XResolution".into(),
                })
            );
            let audit = &outcome.audit_records[0];
            let TargetApplyPostWriteState::Unique { occurrence } = &audit.post_write else {
                panic!("unique mismatch must retain its exact observed occurrence")
            };
            assert_eq!(occurrence.occurrence_id, fresh.id);
            assert_eq!(occurrence.schema_id, Some(info.id.clone()));
            assert_eq!(occurrence.write_target, fresh.write_target);
            assert_eq!(occurrence.value, fresh.value);
            assert!(audit.write.diagnostic.is_none());
            assert!(matches!(
                &audit.verification.proposed_reconciliation,
                MetadataDraftReconciliation::Replace { target: audit_target }
                    if audit_target == target
            ));
            assert_eq!(fresh, original_fresh);
            assert_eq!(entry, original_entry);
        }
    }

    #[test]
    fn new_property_list_mismatch_replaces_without_changing_the_semantic_edit() {
        let info = schema(
            "1",
            "SchemaGroupMustNotBeUsed",
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
        let entry = new_entry(&info, edit(EditIntent::ListAdd, Some(value(&["wanted"]))));
        let original_edit = entry.edit.clone();
        let fresh = occurrence(
            occurrence_id("LIST-PATH", "1", 4),
            value(&["different"]),
            Some(info.clone()),
            Some(&info.group),
            "Items",
        );
        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![fresh.clone()]))]);
        let outcome = apply_fake(std::slice::from_ref(&entry), &client, &[info]);

        assert_eq!(outcome.outcomes[0].kind, "Mismatch");
        assert!(matches!(
            &outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Replace { target }
                if target == &MetadataDraftTarget::from_existing_occurrence(&fresh).unwrap()
        ));
        assert_eq!(entry.edit, original_edit);
        assert_eq!(outcome.outcomes[0].sent, original_edit.value);
        assert_eq!(outcome.outcomes[0].target, entry.target);
    }

    #[test]
    fn new_property_unique_untargetable_occurrence_is_blocked_with_construction_reason() {
        let info = schema(
            "1",
            "XMP-schema",
            "Number",
            true,
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
        );
        let base = occurrence(
            occurrence_id("CREATED", "1", 0),
            MetadataValue::Integer(3),
            Some(info.clone()),
            Some(&info.group),
            "Number",
        );
        let mut read_only = base.clone();
        read_only.tag_info.as_mut().unwrap().writable = false;
        let mut no_selector = base.clone();
        no_selector.write_target = None;

        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![read_only]))]);
        let outcome = apply_fake(
            std::slice::from_ref(&entry),
            &client,
            std::slice::from_ref(&info),
        );
        assert_eq!(outcome.outcomes[0].kind, "Mismatch");
        assert!(matches!(
            &outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Blocked { reason } if reason.contains("read-only")
        ));
        assert!(outcome.targets_to_clear.is_empty());

        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![no_selector]))]);
        let outcome = apply_fake(
            std::slice::from_ref(&entry),
            &client,
            std::slice::from_ref(&info),
        );
        assert_eq!(outcome.outcomes[0].kind, "Mismatch");
        assert!(matches!(
            &outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Blocked { reason }
                if reason.contains("no exact write target")
        ));
        assert!(outcome.targets_to_clear.is_empty());
    }

    #[test]
    fn mixed_reconciliations_derive_clear_targets_in_input_order_only() {
        let make_info = |id: &str, name: &str| {
            schema(
                id,
                "IFD0",
                name,
                true,
                TagKind::Integer {
                    min: None,
                    max: None,
                },
            )
        };
        let infos = [
            make_info("1", "First"),
            make_info("2", "Keep"),
            make_info("3", "Blocked"),
            make_info("4", "Replace"),
            make_info("5", "Last"),
        ];
        let existing = |info: &TagInfo| {
            occurrence(
                occurrence_id(&format!("PATH-{}", info.id.tag_id), &info.id.tag_id, 0),
                MetadataValue::Integer(1),
                Some(info.clone()),
                Some("IFD0"),
                &info.name,
            )
        };
        let before = [
            existing(&infos[0]),
            existing(&infos[1]),
            existing(&infos[2]),
            existing(&infos[4]),
        ];
        let entries = [
            existing_entry(
                &before[0],
                edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
            ),
            existing_entry(
                &before[1],
                edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
            ),
            existing_entry(
                &before[2],
                edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
            ),
            new_entry(
                &infos[3],
                edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
            ),
            existing_entry(
                &before[3],
                edit(EditIntent::Set, Some(MetadataValue::Integer(2))),
            ),
        ];
        let after = vec![
            occurrence(
                before[0].id.clone(),
                MetadataValue::Integer(2),
                Some(infos[0].clone()),
                Some("IFD0"),
                "First",
            ),
            occurrence(
                before[1].id.clone(),
                MetadataValue::Integer(3),
                Some(infos[1].clone()),
                Some("IFD0"),
                "Keep",
            ),
            occurrence(
                occurrence_id("CREATED-4", "4", 0),
                MetadataValue::Integer(3),
                Some(infos[3].clone()),
                Some("IFD0"),
                "Replace",
            ),
            occurrence(
                before[3].id.clone(),
                MetadataValue::Integer(2),
                Some(infos[4].clone()),
                Some("IFD0"),
                "Last",
            ),
        ];
        let client = FakeClient::new(vec![Ok(image(before.to_vec())), Ok(image(after))]);
        let outcome = apply_fake(&entries, &client, &infos);

        assert!(matches!(
            outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Clear
        ));
        assert!(matches!(
            outcome.outcomes[1].draft_reconciliation,
            MetadataDraftReconciliation::Keep
        ));
        assert!(matches!(
            outcome.outcomes[2].draft_reconciliation,
            MetadataDraftReconciliation::Blocked { .. }
        ));
        assert!(matches!(
            outcome.outcomes[3].draft_reconciliation,
            MetadataDraftReconciliation::Replace { .. }
        ));
        assert!(matches!(
            outcome.outcomes[4].draft_reconciliation,
            MetadataDraftReconciliation::Clear
        ));
        assert_eq!(
            outcome.targets_to_clear,
            vec![entries[0].target.clone(), entries[4].target.clone()]
        );
        assert_eq!(
            outcome.targets_to_clear,
            targets_to_clear_from_reconciliation(&outcome.outcomes)
        );
        assert_eq!(
            outcome
                .targets_to_clear
                .iter()
                .map(MetadataDraftTarget::slot)
                .collect::<BTreeSet<_>>()
                .len(),
            outcome.targets_to_clear.len()
        );
    }

    #[test]
    #[should_panic(expected = "duplicate logical slot reached draft-clear reconciliation")]
    fn duplicate_clear_slots_violate_the_internal_reconciliation_invariant() {
        let info = schema("1", "XMP-test", "Name", true, TagKind::Text);
        let entry = new_entry(
            &info,
            edit(EditIntent::Set, Some(MetadataValue::Text("made".into()))),
        );
        let post = occurrence(
            occurrence_id("CREATED", "1", 0),
            MetadataValue::Text("made".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![post]))]);
        let outcome = apply_fake(
            std::slice::from_ref(&entry),
            &client,
            std::slice::from_ref(&info),
        );
        let duplicated = vec![outcome.outcomes[0].clone(), outcome.outcomes[0].clone()];

        let _ = targets_to_clear_from_reconciliation(&duplicated);
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
        assert!(matches!(
            outcome.audit_records[0].write.numeric_pass,
            TargetApplyPassStatus::Succeeded
        ));
        assert!(matches!(
            outcome.audit_records[0].write.text_pass,
            TargetApplyPassStatus::NotApplicable
        ));
        assert!(matches!(
            outcome.audit_records[1].write.numeric_pass,
            TargetApplyPassStatus::NotApplicable
        ));
        assert!(matches!(
            outcome.audit_records[1].write.text_pass,
            TargetApplyPassStatus::Succeeded
        ));

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
        assert!(failed
            .error
            .as_ref()
            .unwrap()
            .contains("numeric pass failed"));
        assert!(matches!(
            &failed.audit_records[0].write.numeric_pass,
            TargetApplyPassStatus::Failed { error }
                if error == "configured write failure"
        ));
        assert!(matches!(
            failed.audit_records[0].write.text_pass,
            TargetApplyPassStatus::NotApplicable
        ));
        assert!(matches!(
            failed.audit_records[1].write.numeric_pass,
            TargetApplyPassStatus::NotApplicable
        ));
        assert!(matches!(
            &failed.audit_records[1].write.text_pass,
            TargetApplyPassStatus::Skipped { reason }
                if reason.contains("numeric pass failed")
        ));
        assert!(failed.audit_records.iter().all(|record| record
            .write
            .diagnostic
            .as_ref()
            .is_some_and(|diagnostic| diagnostic.contains("numeric pass failed"))));
    }

    #[test]
    fn audit_argument_vectors_preserve_each_target_builders_order() {
        let info = schema(
            "1",
            "XMP-test",
            "Items",
            true,
            TagKind::Bag(Box::new(TagKind::Text)),
        );
        let value = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![
                MetadataValue::Text("second".into()),
                MetadataValue::Text("first".into()),
            ],
        };
        let entry = new_entry(&info, edit(EditIntent::Set, Some(value.clone())));
        let post = occurrence(
            occurrence_id("CREATED", "1", 0),
            value,
            Some(info.clone()),
            Some("XMP-test"),
            "Items",
        );
        let client = FakeClient::new(vec![Ok(image(vec![])), Ok(image(vec![post]))]);
        let outcome = apply_fake(&[entry], &client, &[info]);

        assert_eq!(
            outcome.audit_records[0].write.arguments.text,
            vec![
                "-1XMP-test:7ID-1:Items=",
                "-1XMP-test:7ID-1:Items=second",
                "-1XMP-test:7ID-1:Items=first",
            ]
        );
        assert!(outcome.audit_records[0].write.arguments.numeric.is_empty());
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
        let warning = outcome.warning.as_deref().unwrap();
        assert!(warning.contains("all intended tags verified"));
        assert_eq!(
            outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Clear
        );
        assert_eq!(
            outcome.targets_to_clear,
            vec![outcome.outcomes[0].target.clone()]
        );
        assert!(matches!(
            &outcome.audit_records[0].write.text_pass,
            TargetApplyPassStatus::Failed { error }
                if error == "configured write failure"
        ));
        assert_eq!(
            outcome.audit_records[0].write.diagnostic.as_deref(),
            Some(warning)
        );
        assert_eq!(outcome.audit_records[0].verification.kind, "Match");
        assert!(outcome.audit_records[0].verification.message.is_none());
        assert_eq!(
            outcome.audit_records[0]
                .verification
                .proposed_reconciliation,
            MetadataDraftReconciliation::Clear
        );
    }

    #[test]
    fn failed_pass_with_partial_shared_schema_verification_uses_formatted_audit_diagnostic() {
        let info = schema("1", "SchemaMustNotBeUsed", "Name", true, TagKind::Text);
        let before0 = occurrence(
            occurrence_id("P0", "1", 0),
            MetadataValue::Text("before-0".into()),
            Some(info.clone()),
            Some("IFD0"),
            "Name",
        );
        let before1 = occurrence(
            occurrence_id("P1", "1", 1),
            MetadataValue::Text("before-1".into()),
            Some(info.clone()),
            Some("IFD1"),
            "Name",
        );
        let edits = [
            existing_entry(
                &before0,
                edit(EditIntent::Set, Some(MetadataValue::Text("after-0".into()))),
            ),
            existing_entry(
                &before1,
                edit(EditIntent::Set, Some(MetadataValue::Text("after-1".into()))),
            ),
        ];
        let after0 = occurrence(
            before0.id.clone(),
            edits[0].edit.value.clone().unwrap(),
            Some(info.clone()),
            Some("IFD0"),
            "Name",
        );
        let after1 = occurrence(
            before1.id.clone(),
            MetadataValue::Text("unexpected".into()),
            Some(info),
            Some("IFD1"),
            "Name",
        );
        let client = FakeClient::new(vec![
            Ok(image(vec![before0, before1])),
            Ok(image(vec![after1.clone(), after0.clone()])),
        ])
        .failing(false, true);

        let outcome = apply_fake(&edits, &client, &[]);
        let error = outcome.error.as_deref().unwrap();
        assert!(error.contains("post-write verification found 1/2 tags applied"));
        assert_eq!(outcome.audit_records.len(), edits.len());
        assert!(outcome
            .audit_records
            .iter()
            .all(|record| record.write.diagnostic.as_deref() == Some(error)));
        for record in &outcome.audit_records {
            assert!(matches!(
                &record.write.text_pass,
                TargetApplyPassStatus::Failed { error }
                    if error == "configured write failure"
            ));
        }
        assert_eq!(
            outcome
                .audit_records
                .iter()
                .map(|record| record.target.clone())
                .collect::<Vec<_>>(),
            edits
                .iter()
                .map(|entry| entry.target.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            outcome.audit_records[0].write.selector,
            after0.write_target.clone().unwrap()
        );
        assert_eq!(
            outcome.audit_records[1].write.selector,
            after1.write_target.clone().unwrap()
        );
        assert_eq!(outcome.audit_records[0].verification.kind, "Match");
        assert_eq!(
            outcome.audit_records[0]
                .verification
                .proposed_reconciliation,
            MetadataDraftReconciliation::Clear
        );
        assert_eq!(outcome.audit_records[1].verification.kind, "Mismatch");
        assert_eq!(
            outcome.audit_records[1]
                .verification
                .proposed_reconciliation,
            MetadataDraftReconciliation::Keep
        );
        assert_eq!(
            outcome.audit_records[1].verification.message,
            outcome.outcomes[1]
                .message
                .as_ref()
                .and_then(|message| message.split(" (ExifTool write failed:").next())
                .map(str::to_owned)
        );
        for (record, expected) in outcome.audit_records.iter().zip([after0, after1]) {
            let TargetApplyPostWriteState::Unique { occurrence } = &record.post_write else {
                panic!("each same-schema target must retain its own occurrence")
            };
            assert_eq!(occurrence.occurrence_id, expected.id);
            assert_eq!(occurrence.value, expected.value);
        }
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
        assert_eq!(
            outcome.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Keep
        );
        assert_eq!(outcome.outcomes[0].target, entry.target);
        assert_eq!(outcome.outcomes[0].sent, entry.edit.value);
        assert_eq!(outcome.outcomes[0].before, None);
        assert!(outcome.outcomes[0].observed.is_none());
        assert!(outcome.targets_to_clear.is_empty());
        assert_eq!(outcome.audit_records.len(), 1);
        let failed_readback_audit = &outcome.audit_records[0];
        assert_eq!(failed_readback_audit.target, entry.target);
        assert!(failed_readback_audit.write.diagnostic.is_none());
        assert!(matches!(
            &failed_readback_audit.post_write,
            TargetApplyPostWriteState::Unavailable {
                cause: TargetApplyPostWriteUnavailableCause::ReadbackFailed,
                message,
            } if message == "readback boom"
        ));
        assert_eq!(
            failed_readback_audit.verification.proposed_reconciliation,
            MetadataDraftReconciliation::Keep
        );

        let duplicate = occurrence(
            occurrence_id("INVALID-READBACK", "1", 0),
            MetadataValue::Text("x".into()),
            Some(info.clone()),
            Some("XMP-test"),
            "Name",
        );
        let invalid_client = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![duplicate.clone(), duplicate.clone()])),
        ]);
        let invalid = apply_fake(
            std::slice::from_ref(&entry),
            &invalid_client,
            std::slice::from_ref(&info),
        );
        assert_eq!(invalid.outcomes[0].kind, "ReadbackInvalid");
        assert_eq!(
            invalid.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Keep
        );
        assert_ne!(invalid.outcomes[0].kind, "ReadbackFailed");
        assert!(invalid.error.unwrap().contains("readback was invalid"));
        assert!(invalid.targets_to_clear.is_empty());
        assert_eq!(invalid.audit_records.len(), 1);
        assert_eq!(invalid.audit_records[0].target, entry.target);
        assert!(invalid.audit_records[0].write.diagnostic.is_none());
        assert!(matches!(
            &invalid.audit_records[0].post_write,
            TargetApplyPostWriteState::Unavailable {
                cause: TargetApplyPostWriteUnavailableCause::ReadbackInvalid,
                message,
            } if message.contains("duplicate exact occurrence ID")
        ));
        assert_eq!(
            invalid.audit_records[0]
                .verification
                .proposed_reconciliation,
            MetadataDraftReconciliation::Keep
        );

        let write_and_invalid_readback = FakeClient::new(vec![
            Ok(image(vec![])),
            Ok(image(vec![duplicate.clone(), duplicate])),
        ])
        .failing(false, true);
        let invalid_after_write_failure = apply_fake(
            std::slice::from_ref(&entry),
            &write_and_invalid_readback,
            std::slice::from_ref(&info),
        );
        let combined_error = invalid_after_write_failure.error.as_deref().unwrap();
        assert!(combined_error.contains("text pass failed"));
        assert!(combined_error.contains("readback was invalid"));
        assert!(invalid_after_write_failure.outcomes[0].observed.is_none());
        let invalid_audit = &invalid_after_write_failure.audit_records[0];
        assert!(matches!(
            &invalid_audit.write.text_pass,
            TargetApplyPassStatus::Failed { error }
                if error == "configured write failure"
        ));
        assert_eq!(
            invalid_audit.write.diagnostic.as_deref(),
            Some("text pass failed: configured write failure")
        );
        assert!(matches!(
            &invalid_audit.post_write,
            TargetApplyPostWriteState::Unavailable {
                cause: TargetApplyPostWriteUnavailableCause::ReadbackInvalid,
                message,
            } if message.contains("duplicate exact occurrence ID")
        ));
        assert_eq!(invalid_audit.verification.kind, "ReadbackInvalid");
        assert!(invalid_audit
            .verification
            .message
            .as_ref()
            .is_some_and(|message| !message.contains("ExifTool")));

        let write_and_read_failure = FakeClient::new(vec![
            Ok(image(vec![])),
            Err("readback after failed write".into()),
        ])
        .failing(false, true);
        let failed = apply_fake(
            std::slice::from_ref(&entry),
            &write_and_read_failure,
            std::slice::from_ref(&info),
        );
        let error = failed.error.unwrap();
        assert!(error.contains("text pass failed"));
        assert!(error.contains("readback after failed write"));
        assert_eq!(failed.outcomes[0].sent, entry.edit.value);
        assert_eq!(failed.outcomes[0].before, None);
        assert_eq!(
            failed.outcomes[0].draft_reconciliation,
            MetadataDraftReconciliation::Keep
        );
        assert!(matches!(
            &failed.audit_records[0].write.text_pass,
            TargetApplyPassStatus::Failed { error }
                if error == "configured write failure"
        ));
        assert_eq!(
            failed.audit_records[0].write.diagnostic.as_deref(),
            Some("text pass failed: configured write failure")
        );
        assert!(matches!(
            &failed.audit_records[0].post_write,
            TargetApplyPostWriteState::Unavailable {
                cause: TargetApplyPostWriteUnavailableCause::ReadbackFailed,
                message,
            } if message == "readback after failed write"
        ));
        assert_eq!(failed.audit_records[0].verification.kind, "ReadbackFailed");
        assert!(failed.audit_records[0]
            .verification
            .message
            .as_ref()
            .is_some_and(|message| !message.contains("ExifTool")));
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
        let bad = MetadataTargetDraftEntry {
            target: MetadataDraftTarget::NewProperty {
                schema_id: bad_info.id.clone(),
                write_target: MetadataWriteTarget {
                    group1: bad_info.group.clone(),
                    group7: crate::metadata_occurrence::family7_group_from_schema_id(&bad_info.id),
                    tag_name: bad_info.name.clone(),
                },
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
        assert!(rendered.contains("#[CSTR]-1XMP-test:7ID-1:Name=café\\nsecond"));
    }

    #[test]
    fn generated_target_outcome_retains_complete_target_and_semantic_fields() {
        use ts_rs::TS;

        let declaration = MetadataTargetOutcome::decl();
        assert!(declaration.contains("target: MetadataDraftTarget"));
        assert!(declaration.contains("draft_reconciliation: MetadataDraftReconciliation"));
        assert!(declaration.contains("sent: MetadataValue | null"));
        assert!(declaration.contains("before: MetadataValue | null"));
        assert!(declaration.contains("observed: MetadataValue | null"));
        assert!(declaration.contains("message: string | null"));
        assert!(declaration.contains("kind: string"));

        let reconciliation = MetadataDraftReconciliation::decl();
        assert_eq!(reconciliation.matches("\"kind\":").count(), 4);
        for kind in ["Clear", "Keep", "Replace", "Blocked"] {
            assert!(reconciliation.contains(&format!("\"kind\": \"{kind}\"")));
        }
        assert!(reconciliation.contains("{ \"kind\": \"Replace\", target: MetadataDraftTarget"));
    }
}
