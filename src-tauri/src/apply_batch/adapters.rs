use super::*;

pub(super) struct RealDraftPersistence {
    pub(super) app: AppHandle,
}

impl DraftPersistence for RealDraftPersistence {
    fn select_existing(
        &self,
        folder_path: &str,
        relative_paths: &[String],
    ) -> Result<Vec<String>, String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        select_existing_relative_paths(&app_data_dir, folder_path, relative_paths, &state)
    }

    fn select_all(&self, folder_path: &str) -> Result<Vec<String>, String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        select_all_relative_paths(&app_data_dir, folder_path, &state)
    }

    fn load_rows(
        &self,
        folder_path: &str,
        relative_paths: &[String],
    ) -> Result<Vec<LoadedDraftRow>, String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        load_draft_rows(&app_data_dir, folder_path, relative_paths, &state)
    }

    fn persist_rows(&self, folder_path: &str, rows: &[ReconciledDraftRow]) -> Result<(), String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<DraftRepositoryState>();
        persist_reconciled_rows(&app_data_dir, folder_path, rows, &state)
    }
}

pub(super) struct RealSingleFileApply;

impl SingleFileApply for RealSingleFileApply {
    fn apply(
        &self,
        folder_path: &str,
        relative_path: &str,
        edits: &[MetadataTargetDraftEntry],
    ) -> MetadataSingleFileOutcome {
        apply_single_file_metadata(folder_path, relative_path, edits)
    }

    fn apply_batch(
        &self,
        folder_path: &str,
        jobs: &[(String, Vec<MetadataTargetDraftEntry>)],
        write_concurrency: usize,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Vec<(String, MetadataSingleFileOutcome)> {
        apply_real_metadata_batch(folder_path, jobs, write_concurrency, cancel_flag)
    }
}

pub(super) fn read_metadata_for_jobs(
    folder_path: &str,
    relative_paths: &[String],
) -> HashMap<String, Result<scanner::FileMetadata, String>> {
    let absolute_paths = relative_paths
        .iter()
        .map(|relative_path| {
            Path::new(folder_path).join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        })
        .collect::<Vec<_>>();
    let mut by_path = HashMap::with_capacity(relative_paths.len());
    match scanner::read_file_metadata_batch(relative_paths, &absolute_paths) {
        Ok(outcome) => {
            for metadata in outcome.results {
                by_path.insert(metadata.relative_path.clone(), Ok(metadata));
            }
            for failure in outcome.failures {
                by_path.insert(failure.relative_path, Err(failure.error_message));
            }
            for relative_path in relative_paths {
                by_path.entry(relative_path.clone()).or_insert_with(|| {
                    Err(format!(
                        "authoritative metadata batch read returned neither a result nor a failure for {relative_path}"
                    ))
                });
            }
        }
        Err(error) => {
            for relative_path in relative_paths {
                by_path.insert(
                    relative_path.clone(),
                    Err(format!("authoritative metadata batch read failed: {error}")),
                );
            }
        }
    }
    by_path
}

pub(super) fn apply_real_metadata_batch(
    folder_path: &str,
    jobs: &[(String, Vec<MetadataTargetDraftEntry>)],
    write_concurrency: usize,
    cancel_flag: &Arc<AtomicBool>,
) -> Vec<(String, MetadataSingleFileOutcome)> {
    let phase_started = Instant::now();
    let relative_paths = jobs
        .iter()
        .map(|(relative_path, _)| relative_path.clone())
        .collect::<Vec<_>>();
    let mut before_by_path = read_metadata_for_jobs(folder_path, &relative_paths);
    log::info!(
        "[apply_perf] phase=chunk_pre_read duration_ms={} files={}",
        phase_started.elapsed().as_millis(),
        jobs.len()
    );

    if cancel_flag.load(Ordering::Relaxed) {
        return Vec::new();
    }

    let mut immediate = HashMap::new();
    let mut prepared = Vec::new();
    for (index, (relative_path, edits)) in jobs.iter().enumerate() {
        match before_by_path
            .remove(relative_path)
            .expect("batch reader returns one entry per requested path")
        {
            Ok(before) => {
                match prepare_single_file_metadata(folder_path, relative_path, edits, before) {
                    Ok(item) => prepared.push((index, item)),
                    Err(outcome) => {
                        immediate.insert(index, *outcome);
                    }
                }
            }
            Err(error) => {
                immediate.insert(
                    index,
                    MetadataSingleFileOutcome::pre_write_read_failure(error),
                );
            }
        }
    }

    let phase_started = Instant::now();
    let executed = crate::batch_job::run_bounded_blocking(
        prepared,
        NonZeroUsize::new(write_concurrency).unwrap_or(NonZeroUsize::MIN),
        cancel_flag,
        execute_prepared_metadata_write,
    );
    log::info!(
        "[apply_perf] phase=chunk_writes duration_ms={} completed={} concurrency={}",
        phase_started.elapsed().as_millis(),
        executed.len(),
        write_concurrency
    );

    let post_relative_paths = executed
        .iter()
        .map(|(_, item)| executed_relative_path(item).to_string())
        .collect::<Vec<_>>();
    let phase_started = Instant::now();
    let mut fresh_by_path = read_metadata_for_jobs(folder_path, &post_relative_paths);
    log::info!(
        "[apply_perf] phase=chunk_post_read duration_ms={} files={}",
        phase_started.elapsed().as_millis(),
        post_relative_paths.len()
    );

    for (index, item) in executed {
        let relative_path = executed_relative_path(&item).to_string();
        let fresh = fresh_by_path
            .remove(&relative_path)
            .expect("batch reader returns one entry per written path");
        immediate.insert(index, finalize_executed_metadata_write(item, fresh));
    }

    let mut ordered = immediate.into_iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(index, _)| *index);
    ordered
        .into_iter()
        .map(|(index, outcome)| (jobs[index].0.clone(), outcome))
        .collect()
}

pub(super) struct RealDraftReconciler;

impl DraftReconciler for RealDraftReconciler {
    fn reconcile(
        &self,
        entries: &[MetadataTargetDraftEntry],
        outcomes: &[MetadataTargetOutcome],
    ) -> Result<Vec<MetadataTargetDraftEntry>, String> {
        reconcile_metadata_draft_entries(entries, outcomes).map_err(|error| error.to_string())
    }
}

pub(super) struct RealTargetApplyLogger {
    pub(super) app: AppHandle,
}

impl TargetApplyLogger for RealTargetApplyLogger {
    fn append(
        &self,
        folder_path: &str,
        relative_path: &str,
        records: &[TargetApplyAuditRecord],
        draft_persistence: &TargetDraftPersistenceOutcome,
    ) -> Result<(), String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
        let state = self.app.state::<ApplyLogState>();
        append_target_metadata_entries_with_state(
            &app_data_dir,
            &photo_path,
            records,
            draft_persistence,
            &state,
        )
    }
}

pub(super) struct SessionApplyEvents {
    pub(super) app: AppHandle,
    pub(super) session_id: u64,
}

impl ApplyEvents for SessionApplyEvents {
    fn send(&self, message: &MetadataApplyStreamMessage) -> Result<(), String> {
        let state = self.app.state::<crate::session::MediaLibrarySessionState>();
        state.update_apply_operation(self.session_id, message)?;
        crate::emit_frontend_event(&self.app, "media_library_session_apply_progress", message)?;
        if matches!(message, MetadataApplyStreamMessage::Complete { .. }) {
            crate::emit_frontend_event(
                &self.app,
                crate::session::SESSION_CHANGED_EVENT,
                state.snapshot(),
            )?;
        }
        Ok(())
    }
}
