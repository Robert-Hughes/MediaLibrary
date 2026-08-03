use super::*;

struct RealMetadataTargetWriteClient;

impl MetadataTargetWriteClient for RealMetadataTargetWriteClient {
    fn read_file_metadata(
        &self,
        rel_path: &str,
        abs_path: &Path,
    ) -> Result<scanner::FileMetadata, String> {
        let outcome =
            scanner::read_file_metadata_batch(&[rel_path.to_string()], &[abs_path.to_path_buf()])
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

    fn write_metadata(&self, rendered_contents: &str) -> Result<(), String> {
        run_exiftool_write(rendered_contents)
    }
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

pub(super) fn apply_single_file_metadata_with_client<C, F>(
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
    let file_started = Instant::now();
    log::info!(
        "[apply_perf] file={} phase=start edits={}",
        rel_path,
        edits.len()
    );
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

    let phase_started = Instant::now();
    let before = match client.read_file_metadata(rel_path, &abs_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            log::info!(
                "[apply_perf] file={} phase=pre_read duration_ms={} status=failed",
                rel_path,
                phase_started.elapsed().as_millis()
            );
            return MetadataSingleFileOutcome::hard_failure(TargetApplyError::PreWriteReadFailure(
                error,
            ));
        }
    };
    log::info!(
        "[apply_perf] file={} phase=pre_read duration_ms={} status=ok",
        rel_path,
        phase_started.elapsed().as_millis()
    );

    let prepared = match prepare_single_file_metadata_with_schema(
        rel_path,
        abs_path,
        edits,
        before,
        schema_lookup,
        file_started,
    ) {
        Ok(prepared) => prepared,
        Err(outcome) => return *outcome,
    };
    let executed = execute_prepared_metadata_write_with_client(prepared, client);
    let rel_path = executed.prepared.rel_path.clone();
    let abs_path = executed.prepared.abs_path.clone();
    let phase_started = Instant::now();
    let fresh = client.read_file_metadata(&rel_path, &abs_path);
    log::info!(
        "[apply_perf] file={} phase=post_read duration_ms={} status={}",
        rel_path,
        phase_started.elapsed().as_millis(),
        if fresh.is_ok() { "ok" } else { "failed" }
    );
    finalize_executed_metadata_write(executed, fresh)
}

pub(super) fn prepare_single_file_metadata_with_schema<F>(
    rel_path: &str,
    abs_path: std::path::PathBuf,
    edits: &[MetadataTargetDraftEntry],
    before: scanner::FileMetadata,
    schema_lookup: F,
    file_started: Instant,
) -> Result<PreparedMetadataWrite, Box<MetadataSingleFileOutcome>>
where
    F: Fn(&SchemaDefinitionId) -> Option<TagInfo>,
{
    let phase_started = Instant::now();
    let planned = match plan_batch(&abs_path, edits, &before, schema_lookup) {
        Ok(planned) => planned,
        Err(error) => {
            log::info!(
                "[apply_perf] file={} phase=plan duration_ms={} status=failed",
                rel_path,
                phase_started.elapsed().as_millis()
            );
            return Err(Box::new(MetadataSingleFileOutcome::hard_failure(error)));
        }
    };
    log::info!(
        "[apply_perf] file={} phase=plan duration_ms={} status=ok targets={}",
        rel_path,
        phase_started.elapsed().as_millis(),
        planned.targets.len()
    );
    Ok(PreparedMetadataWrite {
        rel_path: rel_path.to_string(),
        abs_path,
        planned,
        file_started,
    })
}

pub(crate) fn prepare_single_file_metadata(
    folder_path: &str,
    rel_path: &str,
    edits: &[MetadataTargetDraftEntry],
    before: scanner::FileMetadata,
) -> Result<PreparedMetadataWrite, Box<MetadataSingleFileOutcome>> {
    let file_started = Instant::now();
    log::info!(
        "[apply_perf] file={} phase=start edits={}",
        rel_path,
        edits.len()
    );
    if edits.is_empty() {
        return Err(Box::new(MetadataSingleFileOutcome::hard_failure(
            TargetApplyError::NoEdits,
        )));
    }
    let abs_path =
        Path::new(folder_path).join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !abs_path.exists() {
        return Err(Box::new(MetadataSingleFileOutcome::hard_failure(
            TargetApplyError::FileMissing(abs_path.display().to_string()),
        )));
    }
    let registry = crate::tag_schema::get_registry().ok();
    prepare_single_file_metadata_with_schema(
        rel_path,
        abs_path,
        edits,
        before,
        |id| registry.and_then(|value| value.lookup(id)).cloned(),
        file_started,
    )
}

pub(super) fn execute_prepared_metadata_write_with_client<C>(
    prepared: PreparedMetadataWrite,
    client: &C,
) -> ExecutedMetadataWrite
where
    C: MetadataTargetWriteClient,
{
    let rel_path = &prepared.rel_path;
    let write_started = Instant::now();
    log::info!("[apply_perf] file={} phase=write_worker_start", rel_path);
    let phase_started = Instant::now();
    let write_result = client.write_metadata(&prepared.planned.argfile);
    log::info!(
        "[apply_perf] file={} phase=write_raw duration_ms={} status={}",
        rel_path,
        phase_started.elapsed().as_millis(),
        if write_result.is_ok() { "ok" } else { "failed" }
    );

    log::info!(
        "[apply_perf] file={} phase=write_worker_complete duration_ms={} status={}",
        rel_path,
        write_started.elapsed().as_millis(),
        if write_result.is_ok() { "ok" } else { "failed" }
    );
    ExecutedMetadataWrite {
        prepared,
        write_result,
    }
}

pub(crate) fn execute_prepared_metadata_write(
    prepared: PreparedMetadataWrite,
) -> ExecutedMetadataWrite {
    execute_prepared_metadata_write_with_client(prepared, &RealMetadataTargetWriteClient)
}

pub(crate) fn executed_relative_path(executed: &ExecutedMetadataWrite) -> &str {
    &executed.prepared.rel_path
}

pub(crate) fn finalize_executed_metadata_write(
    executed: ExecutedMetadataWrite,
    fresh: Result<scanner::FileMetadata, String>,
) -> MetadataSingleFileOutcome {
    let ExecutedMetadataWrite {
        prepared,
        write_result,
    } = executed;
    let PreparedMetadataWrite {
        rel_path,
        planned,
        file_started,
        ..
    } = prepared;
    let write_failure = write_result
        .as_ref()
        .err()
        .map(|error| format!("raw write failed: {error}"));

    let fresh = match fresh {
        Ok(metadata) => metadata,
        Err(read_error) => {
            log::info!(
                "[apply_perf] file={} phase=verify status=post_read_failed total_ms={}",
                rel_path,
                file_started.elapsed().as_millis()
            );
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
                    &write_result,
                    write_failure.as_deref(),
                    TargetApplyPostWriteState::Unavailable {
                        cause: TargetApplyPostWriteUnavailableCause::ReadbackFailed,
                        message: read_error.clone(),
                    },
                    &verification,
                ));
                if plan.derived_reason.is_none() {
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
            }
            return MetadataSingleFileOutcome {
                fresh_file_metadata: None,
                error: Some(error),
                warning: None,
                outcomes,
                targets_to_clear: Vec::new(),
                audit_records,
            };
        }
    };
    let verification_started = Instant::now();
    let post_by_id = match build_strict_post_write_occurrence_index(&fresh) {
        Ok(index) => index,
        Err(invariant_error) => {
            log::info!(
                "[apply_perf] file={} phase=verify duration_ms={} status=failed total_ms={}",
                rel_path,
                verification_started.elapsed().as_millis(),
                file_started.elapsed().as_millis()
            );
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
                    &write_result,
                    write_failure.as_deref(),
                    TargetApplyPostWriteState::Unavailable {
                        cause: TargetApplyPostWriteUnavailableCause::ReadbackInvalid,
                        message: invariant_message.clone(),
                    },
                    &verification,
                ));
                if plan.derived_reason.is_none() {
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
            }
            return MetadataSingleFileOutcome {
                fresh_file_metadata: None,
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
    let mut coercion_messages = verified_targets
        .iter()
        .filter_map(|(plan, verified)| {
            (plan.derived_reason.is_none() && verified.verification.kind == "Coerced")
                .then(|| verified.verification.message.clone())
                .flatten()
        })
        .collect::<Vec<_>>();
    coercion_messages.sort();
    coercion_messages.dedup();
    let coercion_warning = match coercion_messages.as_slice() {
        [] => None,
        [message] => Some(message.clone()),
        messages => Some(format!(
            "ExifTool normalised {} metadata values during storage: {}",
            messages.len(),
            messages.join("; ")
        )),
    };

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
        if plan.derived_reason.is_none() {
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
    }
    let targets_to_clear = targets_to_clear_from_reconciliation(&outcomes);

    let verified_count = verified_targets
        .iter()
        .filter(|(_, verified)| {
            matches!(
                verified.verification.draft_reconciliation,
                MetadataDraftReconciliation::Clear
            )
        })
        .count();
    let diagnostics =
        format_apply_diagnostics(&write_result, verified_count, verified_targets.len());
    let write_diagnostic = diagnostics
        .error
        .as_deref()
        .or(diagnostics.warning.as_deref());
    let audit_records = verified_targets
        .into_iter()
        .map(|(plan, verified)| {
            target_audit_record(
                &plan,
                &write_result,
                write_diagnostic,
                verified.post_write,
                &verified.verification,
            )
        })
        .collect();
    let warning = match (diagnostics.warning, coercion_warning) {
        (Some(write_warning), Some(coercion_warning)) => {
            Some(format!("{write_warning}; {coercion_warning}"))
        }
        (Some(write_warning), None) => Some(write_warning),
        (None, Some(coercion_warning)) => Some(coercion_warning),
        (None, None) => None,
    };

    // The batch coordinator appends this evidence to the independent
    // target-aware log after draft reconciliation and any persistence attempt.
    let result = MetadataSingleFileOutcome {
        fresh_file_metadata: Some(fresh),
        error: diagnostics.error.or(first_mismatch),
        warning,
        outcomes,
        targets_to_clear,
        audit_records,
    };
    log::info!(
        "[apply_perf] file={} phase=verify duration_ms={} status=ok targets={} total_ms={}",
        rel_path,
        verification_started.elapsed().as_millis(),
        result.outcomes.len(),
        file_started.elapsed().as_millis()
    );
    result
}
