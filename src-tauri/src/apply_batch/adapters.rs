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

pub(super) struct RealBatchApply;

impl BatchApply for RealBatchApply {
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
    classify_metadata_results(
        relative_paths,
        scanner::read_file_metadata_batch(relative_paths, &absolute_paths),
    )
}

fn classify_metadata_results(
    relative_paths: &[String],
    outcome: Result<scanner::MetadataBatchReadOutcome, String>,
) -> HashMap<String, Result<scanner::FileMetadata, String>> {
    let mut by_path = HashMap::with_capacity(relative_paths.len());
    match outcome {
        Ok(outcome) => {
            for metadata in outcome.results {
                let path = metadata.relative_path.clone();
                match by_path.entry(path.clone()) {
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(Ok(metadata));
                    }
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        let _ = entry.insert(Err(format!(
                            "authoritative metadata read returned duplicate results for {path}"
                        )));
                    }
                }
            }
            for failure in outcome.failures {
                let _ = by_path.insert(failure.relative_path, Err(failure.error_message));
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

/// Apply a batch through authoritative pre-read, bounded writes and readback.
pub fn apply_real_metadata_batch(
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
    fn begin_batch(&self) -> Result<(), String> {
        let app_data_dir = crate::commands::shared::app_data_dir(&self.app)?;
        let state = self.app.state::<ApplyLogState>();
        rotate_target_apply_log_if_needed(&app_data_dir, &state)
    }

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

fn applied_thumbnail_paths(results: &[MetadataApplyFileResult]) -> Vec<String> {
    results
        .iter()
        .filter(|result| result.applied)
        .map(|result| result.relative_path.clone())
        .collect()
}

fn cache_post_write_metadata(
    cache: &crate::media_cache_repository::MediaCacheRepository,
    folder: &str,
    results: &[MetadataApplyFileResult],
) {
    for metadata in results
        .iter()
        .filter_map(|result| result.fresh_file_metadata.as_ref())
    {
        let absolute_path = Path::new(folder).join(
            metadata
                .relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        let update = crate::media_cache_repository::fingerprint_for_file(&absolute_path).and_then(
            |fingerprint| {
                cache.update_metadata(
                    folder,
                    &metadata.relative_path,
                    fingerprint,
                    &metadata.occurrences,
                )
            },
        );
        if let Err(error) = update {
            log::warn!(
                "[media-cache] post-write metadata update failed for {}: {}",
                metadata.relative_path,
                error
            );
        }
    }
}

fn refresh_applied_media(
    state: &crate::session::MediaLibrarySessionState,
    session_id: u64,
    results: &[MetadataApplyFileResult],
    cache: Option<&crate::media_cache_repository::MediaCacheRepository>,
) {
    let folder = state.inspect(|snapshot| {
        if snapshot.session_id == Some(session_id) {
            snapshot.folder.clone()
        } else {
            None
        }
    });
    let Some(folder) = folder else {
        log::debug!("[apply-thumbnails] skipped refresh because the session changed");
        return;
    };

    if let Some(cache) = cache {
        cache_post_write_metadata(cache, &folder, results);
    }

    let refreshed = applied_thumbnail_paths(results)
        .into_iter()
        .map(|relative_path| {
            let absolute_path =
                Path::new(&folder).join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let thumbnail = scanner::thumbnail_for_media(&absolute_path);
            if let Some(cache) = cache {
                let update = crate::media_cache_repository::fingerprint_for_file(&absolute_path)
                    .and_then(|fingerprint| {
                        cache.update_thumbnail(
                            &folder,
                            &relative_path,
                            fingerprint,
                            thumbnail.as_deref(),
                        )
                    });
                if let Err(error) = update {
                    log::warn!(
                        "[media-cache] post-write thumbnail update failed for {}: {}",
                        relative_path,
                        error
                    );
                }
            }
            (relative_path, thumbnail)
        })
        .collect::<Vec<_>>();

    if !refreshed.is_empty() {
        if let Err(error) = state.commit_thumbnail_results(session_id, refreshed) {
            log::debug!("[apply-thumbnails] discarded stale refresh results: {error}");
        }
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
        if let MetadataApplyStreamMessage::ProgressBatch { results, .. } = message {
            let cache = match crate::media_cache_repository::shared_repository() {
                Ok(cache) => Some(cache),
                Err(error) => {
                    log::warn!("[media-cache] disabled for apply refresh: {error}");
                    None
                }
            };
            refresh_applied_media(&state, self.session_id, results, cache.as_deref());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_metadata_results_fail_only_the_affected_file() {
        let metadata = |path: &str| scanner::FileMetadata {
            relative_path: path.into(),
            occurrences: Default::default(),
        };
        let paths = vec![
            "duplicate.jpg".into(),
            "good.jpg".into(),
            "missing.jpg".into(),
        ];
        let classified = classify_metadata_results(
            &paths,
            Ok(scanner::MetadataBatchReadOutcome {
                results: vec![
                    metadata("duplicate.jpg"),
                    metadata("good.jpg"),
                    metadata("duplicate.jpg"),
                    metadata("duplicate.jpg"),
                ],
                failures: Vec::new(),
            }),
        );
        assert!(classified["duplicate.jpg"]
            .as_ref()
            .unwrap_err()
            .contains("duplicate results"));
        assert!(classified["good.jpg"].is_ok());
        assert!(classified["missing.jpg"]
            .as_ref()
            .unwrap_err()
            .contains("neither a result nor a failure"));
    }

    fn apply_result(relative_path: &str, applied: bool) -> MetadataApplyFileResult {
        MetadataApplyFileResult {
            relative_path: relative_path.into(),
            applied,
            error: None,
            warning: None,
            fresh_file_metadata: None,
            target_outcomes: Vec::new(),
            persisted_draft_entries: None,
        }
    }

    #[test]
    fn applied_thumbnail_paths_only_include_successful_writes() {
        let results = vec![
            apply_result("changed.jpg", true),
            apply_result("failed.jpg", false),
            apply_result("unchanged.jpg", false),
        ];

        assert_eq!(
            applied_thumbnail_paths(&results),
            vec!["changed.jpg".to_string()]
        );
    }

    #[test]
    fn refresh_applied_thumbnails_replaces_cached_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let relative_path = "changed.png";
        let absolute_path = dir.path().join(relative_path);
        image::RgbImage::new(1, 1).save(&absolute_path).unwrap();

        let state = crate::session::MediaLibrarySessionState::new();
        let folder = dir.path().to_string_lossy().into_owned();
        let opened = state.begin_open(folder.clone());
        let session_id = opened.session_id.unwrap();
        state.mark_loaded(session_id, &folder).unwrap();
        state
            .add_files(
                session_id,
                vec![scanner::FileInfo {
                    relative_path: relative_path.into(),
                    filename: relative_path.into(),
                    media_kind: scanner::MediaKind::Image,
                    date_modified: None,
                    date_created: None,
                }],
            )
            .unwrap();
        state
            .commit_thumbnail_results(
                session_id,
                vec![(relative_path.into(), Some("old-thumbnail".into()))],
            )
            .unwrap();

        let cache_dir = dir.path().join("cache");
        let cache = crate::media_cache_repository::MediaCacheRepository::open(&cache_dir).unwrap();
        refresh_applied_media(
            &state,
            session_id,
            &[apply_result(relative_path, true)],
            Some(&cache),
        );

        let snapshot = state.snapshot();
        let cache_key = match &snapshot.thumbnails[0].state {
            crate::session::MediaLibrarySessionThumbnailState::Ready { cache_key } => {
                cache_key.clone()
            }
            state => panic!("expected refreshed thumbnail, got {state:?}"),
        };
        let payloads = state.thumbnail_payloads(session_id, &[cache_key]).unwrap();
        assert_ne!(payloads[0].thumbnail, "old-thumbnail");
        assert!(!payloads[0].thumbnail.is_empty());
        let fingerprint =
            crate::media_cache_repository::fingerprint_for_file(&absolute_path).unwrap();
        let cached = cache
            .load(&folder, relative_path, fingerprint)
            .unwrap()
            .unwrap();
        assert!(cached.thumbnail.is_some());
        assert_ne!(cached.thumbnail.as_deref(), Some("old-thumbnail"));
    }

    #[test]
    fn authoritative_post_write_metadata_populates_cache_independently() {
        let dir = tempfile::tempdir().unwrap();
        let relative_path = "changed.jpg";
        let absolute_path = dir.path().join(relative_path);
        std::fs::write(&absolute_path, b"changed media").unwrap();
        let folder = dir.path().to_string_lossy().into_owned();
        let cache_dir = dir.path().join("cache");
        let cache = crate::media_cache_repository::MediaCacheRepository::open(&cache_dir).unwrap();

        let state = crate::session::MediaLibrarySessionState::new();
        let opened = state.begin_open(folder.clone());
        let session_id = opened.session_id.unwrap();
        state.mark_loaded(session_id, &folder).unwrap();

        let mut result = apply_result(relative_path, false);
        result.fresh_file_metadata = Some(scanner::FileMetadata {
            relative_path: relative_path.into(),
            occurrences: Default::default(),
        });
        refresh_applied_media(&state, session_id, &[result], Some(&cache));

        let fingerprint =
            crate::media_cache_repository::fingerprint_for_file(&absolute_path).unwrap();
        let cached = cache
            .load(&folder, relative_path, fingerprint)
            .unwrap()
            .unwrap();
        assert_eq!(cached.metadata, Some(Default::default()));
        assert_eq!(cached.thumbnail, None);
    }
}
