use super::*;

/// Cancellation state for the sole metadata apply command.
pub struct ApplyEditsState {
    active: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyEditsBusyError;

impl std::fmt::Display for ApplyEditsBusyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("A target-aware metadata apply operation is already running")
    }
}

impl std::error::Error for ApplyEditsBusyError {}

impl ApplyEditsState {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }

    pub fn try_install(&self, operation_id: &str) -> Result<Arc<AtomicBool>, ApplyEditsBusyError> {
        let mut installed = self.active.lock().unwrap();
        if installed.is_some() {
            return Err(ApplyEditsBusyError);
        }

        let flag = Arc::new(AtomicBool::new(false));
        *installed = Some((operation_id.to_owned(), flag.clone()));
        Ok(flag)
    }

    pub fn clear(&self) {
        *self.active.lock().unwrap() = None;
    }

    pub fn clear_if_mine(&self, flag: &Arc<AtomicBool>) {
        let mut installed = self.active.lock().unwrap();
        if installed
            .as_ref()
            .is_some_and(|(_, current)| Arc::ptr_eq(current, flag))
        {
            *installed = None;
        }
    }

    pub fn signal_cancel(&self, operation_id: &str) -> bool {
        if let Some((_, flag)) = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(active_id, _)| active_id == operation_id)
        {
            flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

impl Default for ApplyEditsState {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) async fn run_apply_edits_command<T, StartWorker, WorkerFuture, WorkerJoinError>(
    state: &ApplyEditsState,
    operation_id: &str,
    start_worker: StartWorker,
) -> Result<T, String>
where
    StartWorker: FnOnce(Arc<AtomicBool>) -> WorkerFuture,
    WorkerFuture: Future<Output = Result<Result<T, String>, WorkerJoinError>>,
    WorkerJoinError: std::fmt::Display,
{
    let cancel_flag = state
        .try_install(operation_id)
        .map_err(|error| error.to_string())?;
    let result = match start_worker(cancel_flag.clone()).await {
        Ok(result) => result,
        Err(error) => Err(format!("Target-aware apply edits worker failed: {error}")),
    };
    state.clear_if_mine(&cancel_flag);
    result
}
