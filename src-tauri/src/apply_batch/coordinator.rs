use super::*;

fn combine_errors(original: Option<String>, additional: String) -> String {
    match original {
        Some(original) => format!("{original}; {additional}"),
        None => additional,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_apply_metadata_draft_edits_with_limits<P, A, R, L, E>(
    folder_path: &str,
    relative_paths: Option<&[String]>,
    persistence: &P,
    single_file_apply: &A,
    reconciler: &R,
    target_logger: &L,
    events: &E,
    operation_id: &str,
    cancel_flag: Arc<AtomicBool>,
    batch_size: usize,
    write_concurrency: usize,
) -> Result<MetadataApplyResult, String>
where
    P: DraftPersistence,
    A: SingleFileApply,
    R: DraftReconciler,
    L: TargetApplyLogger,
    E: ApplyEvents,
{
    let batch_started = Instant::now();
    if let Some(relative_paths) = relative_paths {
        let mut seen = HashSet::new();
        for relative_path in relative_paths {
            if !seen.insert(relative_path.as_str()) {
                return Err(format!(
                    "duplicate requested relative path: {relative_path}"
                ));
            }
        }
    }

    let phase_started = Instant::now();
    let selected = match relative_paths {
        Some(relative_paths) => persistence.select_existing(folder_path, relative_paths)?,
        None => persistence.select_all(folder_path)?,
    };
    let requested = relative_paths.map_or(selected.len(), <[String]>::len);
    let total = selected.len();
    log::info!(
        "[apply_perf] phase=draft_select duration_ms={} requested={} selected={}",
        phase_started.elapsed().as_millis(),
        requested,
        total
    );
    log::info!(
        "[apply_perf] phase=batch_start requested={} selected={} batch_size={} write_concurrency={}",
        requested,
        total,
        batch_size,
        write_concurrency
    );

    if let Err(error) = events.send(&MetadataApplyStreamMessage::Started {
        operation_id: operation_id.to_owned(),
        total,
    }) {
        log::warn!("[apply_batch] Failed to emit started event: {error}");
    }

    // Rotate the target apply log once per command, before any append, so a
    // command's audit lines are never split across files.
    if total > 0 {
        if let Err(error) = target_logger.begin_batch() {
            log::warn!("[apply_batch] Failed to rotate target apply log: {error}");
        }
    }

    #[cfg(test)]
    let mut files = Vec::with_capacity(total);
    let mut undelivered_files = Vec::new();
    let mut completed = 0usize;
    let mut applied = 0usize;
    let mut failed = 0usize;
    let mut warning_count = 0usize;
    let mut sequence = 0usize;
    let mut cancelled = false;
    let mut aborted = false;
    let mut abort_reason = None;

    for chunk in selected.chunks(batch_size) {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let phase_started = Instant::now();
        let loaded_rows = persistence.load_rows(folder_path, chunk)?;
        if loaded_rows.len() != chunk.len() {
            let loaded_paths = loaded_rows
                .iter()
                .map(|row| row.relative_path.as_str())
                .collect::<HashSet<_>>();
            let missing = chunk
                .iter()
                .filter(|path| !loaded_paths.contains(path.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            return Err(format!(
                "Draft rows changed before metadata apply began: {}",
                missing.join(", ")
            ));
        }
        log::info!(
            "[apply_perf] phase=chunk_draft_load duration_ms={} files={}",
            phase_started.elapsed().as_millis(),
            loaded_rows.len()
        );

        let jobs = loaded_rows
            .iter()
            .map(|row| (row.relative_path.clone(), row.entries.clone()))
            .collect::<Vec<_>>();
        let mut rows_by_path = loaded_rows
            .into_iter()
            .map(|row| (row.relative_path.clone(), row))
            .collect::<HashMap<_, _>>();
        let chunk_started = Instant::now();
        let chunk_outcomes =
            single_file_apply.apply_batch(folder_path, &jobs, write_concurrency, &cancel_flag);
        log::info!(
            "[apply_perf] phase=chunk_pipeline duration_ms={} requested={} completed={}",
            chunk_started.elapsed().as_millis(),
            jobs.len(),
            chunk_outcomes.len()
        );
        if chunk_outcomes.len() < jobs.len() {
            cancelled = cancel_flag.load(Ordering::Relaxed);
        }

        struct PendingResult {
            relative_path: String,
            outcome: MetadataSingleFileOutcome,
            reconciled: Option<ReconciledDraftRow>,
            fatal_reason: Option<String>,
            draft_persistence: TargetDraftPersistenceOutcome,
        }

        let phase_started = Instant::now();
        let mut pending = Vec::with_capacity(chunk_outcomes.len());
        for (relative_path, outcome) in chunk_outcomes {
            let row = rows_by_path
                .remove(&relative_path)
                .expect("apply batch returns only requested paths");
            let mut reconciled = None;
            let mut fatal_reason = None;
            let mut draft_persistence = TargetDraftPersistenceOutcome::Unchanged;
            if !outcome.outcomes.is_empty() {
                match reconciler.reconcile(&row.entries, &outcome.outcomes) {
                    Ok(entries) if entries != row.entries => {
                        reconciled = Some(row.reconciled(entries));
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let reason = format!(
                            "target-aware draft reconciliation failed for {relative_path}: {error}"
                        );
                        fatal_reason = Some(reason.clone());
                        draft_persistence =
                            TargetDraftPersistenceOutcome::ReconciliationFailed { error: reason };
                    }
                }
            }
            pending.push(PendingResult {
                relative_path,
                outcome,
                reconciled,
                fatal_reason,
                draft_persistence,
            });
        }
        log::info!(
            "[apply_perf] phase=chunk_reconcile duration_ms={} files={}",
            phase_started.elapsed().as_millis(),
            pending.len()
        );

        let rows_to_persist = pending
            .iter()
            .filter_map(|item| item.reconciled.clone())
            .collect::<Vec<_>>();
        if !rows_to_persist.is_empty() {
            let persist_started = Instant::now();
            match persistence.persist_rows(folder_path, &rows_to_persist) {
                Ok(()) => {
                    for item in &mut pending {
                        if item.reconciled.is_some() {
                            item.draft_persistence = TargetDraftPersistenceOutcome::Persisted;
                        }
                    }
                    log::info!(
                        "[apply_perf] phase=chunk_draft_persist duration_ms={} status=ok rows={}",
                        persist_started.elapsed().as_millis(),
                        rows_to_persist.len()
                    );
                }
                Err(error) => {
                    for item in &mut pending {
                        if item.reconciled.is_some() {
                            let reason = format!(
                                "target-aware draft persistence failed for {}: {error}",
                                item.relative_path
                            );
                            item.fatal_reason = Some(reason.clone());
                            item.draft_persistence =
                                TargetDraftPersistenceOutcome::PersistenceFailed { error: reason };
                        }
                    }
                    log::info!(
                        "[apply_perf] phase=chunk_draft_persist duration_ms={} status=failed rows={}",
                        persist_started.elapsed().as_millis(),
                        rows_to_persist.len()
                    );
                }
            }
        }

        let mut chunk_results = Vec::with_capacity(pending.len());
        for item in pending {
            let coordinator_file_started = Instant::now();
            let PendingResult {
                relative_path,
                outcome,
                reconciled,
                fatal_reason,
                draft_persistence,
            } = item;
            let mut final_error = outcome.error.clone();
            if let Some(reason) = fatal_reason.as_ref() {
                final_error = Some(combine_errors(final_error, reason.clone()));
            }
            let persisted_draft_entries =
                if matches!(draft_persistence, TargetDraftPersistenceOutcome::Persisted) {
                    reconciled.as_ref().map(|row| row.entries.clone())
                } else {
                    None
                };

            let phase_started = Instant::now();
            if !outcome.audit_records.is_empty() {
                if let Err(error) = target_logger.append(
                    folder_path,
                    &relative_path,
                    &outcome.audit_records,
                    &draft_persistence,
                ) {
                    log::warn!(
                    "[apply_batch] Failed to append target apply log for {relative_path}: {error}"
                );
                }
            }
            log::info!(
                "[apply_perf] file={} phase=audit duration_ms={} records={}",
                relative_path,
                phase_started.elapsed().as_millis(),
                outcome.audit_records.len()
            );

            let result = MetadataApplyFileResult {
                relative_path,
                applied: final_error.is_none(),
                error: final_error,
                warning: outcome.warning,
                fresh_file_metadata: outcome.fresh_file_metadata,
                target_outcomes: outcome.outcomes,
                persisted_draft_entries,
            };
            if result.applied {
                applied += 1;
            } else {
                failed += 1;
            }
            if result.warning.is_some() {
                warning_count += 1;
            }
            let current = completed + chunk_results.len() + 1;
            log::info!(
                "[apply_perf] file={} phase=coordinator_total duration_ms={} current={} total={}",
                result.relative_path,
                coordinator_file_started.elapsed().as_millis(),
                current,
                total
            );
            chunk_results.push(result);

            if let Some(reason) = fatal_reason {
                aborted = true;
                abort_reason.get_or_insert(reason);
            }
        }

        if !chunk_results.is_empty() {
            sequence += 1;
            completed += chunk_results.len();
            let message = MetadataApplyStreamMessage::ProgressBatch {
                operation_id: operation_id.to_owned(),
                sequence,
                current: completed,
                total,
                results: chunk_results.clone(),
            };
            if let Err(error) = events.send(&message) {
                log::warn!(
                    "[apply_batch] Failed to emit progress batch ending at {completed}: {error}"
                );
                undelivered_files.extend(chunk_results.iter().cloned());
            }
            #[cfg(test)]
            files.extend(chunk_results);
        }

        if aborted || cancelled {
            break;
        }
    }

    log::info!(
        "[apply_perf] phase=batch_complete duration_ms={} completed={} total={} cancelled={} aborted={}",
        batch_started.elapsed().as_millis(),
        completed,
        total,
        cancelled,
        aborted
    );
    let summary = MetadataApplySummary {
        requested,
        selected: total,
        completed,
        applied,
        failed,
        warning_count,
        cancelled,
        aborted,
        abort_reason,
        delivery_failure_count: undelivered_files.len(),
    };
    let complete_delivery_failed = events
        .send(&MetadataApplyStreamMessage::Complete {
            operation_id: operation_id.to_owned(),
            summary: summary.clone(),
        })
        .is_err();
    Ok(MetadataApplyResult {
        summary,
        undelivered_files,
        complete_delivery_failed,
        #[cfg(test)]
        files,
    })
}
