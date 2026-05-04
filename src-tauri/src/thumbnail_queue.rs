/// A thread-safe priority queue for thumbnail/EXIF work items.
///
/// Workers call `pop()` — it blocks until an item is available or `finish()`
/// has been called. The frontend calls `prioritize()` to move visible paths
/// to the front so on-screen photos are processed first.
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

#[derive(Clone)]
pub struct ThumbnailQueue {
    inner: Arc<(Mutex<State>, Condvar)>,
}

struct State {
    queue: VecDeque<String>,
    /// Set to true when no more items will be pushed; workers exit when empty.
    done: bool,
}

impl ThumbnailQueue {
    /// Create a new queue, optionally pre-populated.
    pub fn new(paths: Vec<String>) -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(State { queue: VecDeque::from(paths), done: false }),
                Condvar::new(),
            )),
        }
    }

    /// Push a path onto the back and wake one waiting worker.
    pub fn push(&self, path: String) {
        let (lock, cvar) = &*self.inner;
        lock.lock().unwrap().queue.push_back(path);
        cvar.notify_one();
    }

    /// Signal that no more items will be pushed.
    /// Workers drain remaining items then return `None`.
    pub fn finish(&self) {
        let (lock, cvar) = &*self.inner;
        lock.lock().unwrap().done = true;
        cvar.notify_all();
    }

    /// Clear all pending items and signal workers to exit immediately.
    pub fn abort(&self) {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap();
        state.queue.clear();
        state.done = true;
        cvar.notify_all();
    }

    /// Block until an item is available, then return it.
    /// Returns `None` when the queue is empty and `finish()` has been called.
    pub fn pop(&self) -> Option<String> {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap();
        loop {
            if let Some(item) = state.queue.pop_front() {
                return Some(item);
            }
            if state.done {
                return None;
            }
            state = cvar.wait(state).unwrap();
        }
    }

    /// Block until at least one item is available, then return up to `max` items.
    /// Returns an empty vector when the queue is empty and `finish()` has been called.
    pub fn pop_batch(&self, max: usize) -> Vec<String> {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap();
        loop {
            if !state.queue.is_empty() {
                let mut batch = Vec::with_capacity(max);
                while batch.len() < max {
                    if let Some(item) = state.queue.pop_front() {
                        batch.push(item);
                    } else {
                        break;
                    }
                }
                return batch;
            }
            if state.done {
                return Vec::new();
            }
            state = cvar.wait(state).unwrap();
        }
    }

    /// Move `priority_paths` to the front, preserving their relative order.
    /// Paths not currently in the queue (already processed) are ignored.
    pub fn prioritize(&self, priority_paths: &[String]) {
        let (lock, _) = &*self.inner;
        let mut state = lock.lock().unwrap();

        let pending: std::collections::HashSet<&str> =
            state.queue.iter().map(|s| s.as_str()).collect();

        let to_front: Vec<String> = priority_paths
            .iter()
            .filter(|p| pending.contains(p.as_str()))
            .cloned()
            .collect();

        if to_front.is_empty() {
            return;
        }

        let promote_set: std::collections::HashSet<&str> =
            to_front.iter().map(|s| s.as_str()).collect();
        state.queue.retain(|p| !promote_set.contains(p.as_str()));

        for path in to_front.into_iter().rev() {
            state.queue.push_front(path);
        }
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.0.lock().unwrap().queue.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[allow(dead_code)]
    pub fn snapshot(&self) -> Vec<String> {
        self.inner.0.lock().unwrap().queue.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: pre-populated queue that is immediately finished.
    fn queue(items: &[&str]) -> ThumbnailQueue {
        let q = ThumbnailQueue::new(items.iter().map(|s| s.to_string()).collect());
        q.finish();
        q
    }

    // ── pop ───────────────────────────────────────────────────────────────────

    #[test]
    fn pop_returns_items_in_order() {
        let q = queue(&["a", "b", "c"]);
        assert_eq!(q.pop(), Some("a".into()));
        assert_eq!(q.pop(), Some("b".into()));
        assert_eq!(q.pop(), Some("c".into()));
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn pop_on_empty_finished_queue_returns_none() {
        let q = queue(&[]);
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn push_then_finish_drains_correctly() {
        let q = ThumbnailQueue::new(vec![]);
        q.push("a".into());
        q.push("b".into());
        q.finish();
        assert_eq!(q.pop(), Some("a".into()));
        assert_eq!(q.pop(), Some("b".into()));
        assert_eq!(q.pop(), None);
    }

    // ── prioritize ────────────────────────────────────────────────────────────

    #[test]
    fn prioritize_moves_items_to_front() {
        let q = queue(&["a", "b", "c", "d", "e"]);
        q.prioritize(&["d".into(), "e".into()]);
        assert_eq!(q.snapshot(), vec!["d", "e", "a", "b", "c"]);
    }

    #[test]
    fn prioritize_preserves_relative_order_of_priority_items() {
        let q = queue(&["a", "b", "c", "d"]);
        q.prioritize(&["c".into(), "b".into()]);
        assert_eq!(q.snapshot(), vec!["c", "b", "a", "d"]);
    }

    #[test]
    fn prioritize_ignores_paths_not_in_queue() {
        let q = queue(&["a", "b", "c"]);
        q.prioritize(&["z".into(), "b".into()]);
        assert_eq!(q.snapshot(), vec!["b", "a", "c"]);
    }

    #[test]
    fn prioritize_with_empty_list_is_noop() {
        let q = queue(&["a", "b", "c"]);
        q.prioritize(&[]);
        assert_eq!(q.snapshot(), vec!["a", "b", "c"]);
    }

    #[test]
    fn prioritize_when_all_already_at_front_is_noop() {
        let q = queue(&["a", "b", "c"]);
        q.prioritize(&["a".into(), "b".into()]);
        assert_eq!(q.snapshot(), vec!["a", "b", "c"]);
    }

    #[test]
    fn prioritize_on_empty_queue_is_noop() {
        let q = queue(&[]);
        q.prioritize(&["a".into()]);
        assert!(q.is_empty());
    }

    #[test]
    fn prioritize_single_item_from_middle() {
        let q = queue(&["a", "b", "c", "d", "e"]);
        q.prioritize(&["c".into()]);
        assert_eq!(q.snapshot(), vec!["c", "a", "b", "d", "e"]);
    }

    #[test]
    fn prioritize_can_be_called_multiple_times() {
        let q = queue(&["a", "b", "c", "d", "e"]);
        q.prioritize(&["e".into()]);
        assert_eq!(q.snapshot(), vec!["e", "a", "b", "c", "d"]);
        q.prioritize(&["c".into(), "d".into()]);
        assert_eq!(q.snapshot(), vec!["c", "d", "e", "a", "b"]);
    }

    // ── blocking pop / push / finish interaction ──────────────────────────────

    #[test]
    fn pop_blocks_until_push_arrives() {
        let q = Arc::new(ThumbnailQueue::new(vec![]));
        let q2 = q.clone();

        // Spawn a worker that will block on pop().
        let handle = std::thread::spawn(move || q2.pop());

        // Give the worker time to start blocking.
        std::thread::sleep(std::time::Duration::from_millis(20));

        // Push an item — this should unblock the worker.
        q.push("woken.jpg".into());
        q.finish();

        let result = handle.join().unwrap();
        assert_eq!(result, Some("woken.jpg".into()));
    }

    #[test]
    fn finish_unblocks_all_waiting_workers() {
        let q = Arc::new(ThumbnailQueue::new(vec![]));
        let num_workers = 4;

        // Spawn workers that all block immediately on an empty queue.
        let handles: Vec<_> = (0..num_workers)
            .map(|_| {
                let q = q.clone();
                std::thread::spawn(move || q.pop())
            })
            .collect();

        std::thread::sleep(std::time::Duration::from_millis(20));

        // finish() with no items — all workers should get None and exit.
        q.finish();

        for h in handles {
            assert_eq!(h.join().unwrap(), None);
        }
    }

    #[test]
    fn workers_receive_items_pushed_after_they_start_blocking() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let q = Arc::new(ThumbnailQueue::new(vec![]));
        let received = Arc::new(AtomicUsize::new(0));

        // Start workers before any items exist.
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let q = q.clone();
                let received = received.clone();
                std::thread::spawn(move || {
                    while q.pop().is_some() {
                        received.fetch_add(1, Ordering::Relaxed);
                    }
                })
            })
            .collect();

        // Feed items in after workers are (likely) blocking.
        std::thread::sleep(std::time::Duration::from_millis(10));
        for i in 0..50 {
            q.push(format!("photo_{i}.jpg"));
        }
        q.finish();

        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(received.load(Ordering::Relaxed), 50);
    }

    #[test]
    fn prioritize_while_workers_are_draining() {
        // Verify prioritize() works correctly when called before draining starts.
        let q = Arc::new(ThumbnailQueue::new(vec![]));

        // Pre-populate with items a–z.
        for c in b'a'..=b'z' {
            q.push(format!("{}.jpg", c as char));
        }

        // Mark that we want "z.jpg" first.
        q.prioritize(&["z.jpg".into()]);

        // The first item popped must be z.jpg.
        let first = q.pop().unwrap();
        assert_eq!(first, "z.jpg");

        // Drain the rest.
        q.finish();
        let mut rest = Vec::new();
        while let Some(item) = q.pop() {
            rest.push(item);
        }
        // z.jpg should not appear again.
        assert!(!rest.contains(&"z.jpg".to_string()));
        assert_eq!(rest.len(), 25); // a–y
    }

    // ── concurrent access ─────────────────────────────────────────────────────

    #[test]
    fn concurrent_pops_drain_queue_exactly_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let q = Arc::new(ThumbnailQueue::new(vec![]));
        for i in 0..100 {
            q.push(format!("photo_{i}.jpg"));
        }
        q.finish();

        let counter = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let q = q.clone();
                let counter = counter.clone();
                std::thread::spawn(move || {
                    while q.pop().is_some() {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(counter.load(Ordering::Relaxed), 100);
        assert!(q.is_empty());
    }

    #[test]
    fn abort_clears_queue_and_stops_workers() {
        let q = ThumbnailQueue::new(vec!["a".into(), "b".into(), "c".into()]);
        q.abort();
        assert!(q.is_empty());
        assert_eq!(q.pop(), None);
    }
}
