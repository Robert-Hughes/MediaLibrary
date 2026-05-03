/// A thread-safe priority queue for thumbnail generation paths.
///
/// Workers call `pop()` to get the next path to process.
/// The frontend calls `prioritize()` to move visible paths to the front,
/// so that thumbnails for on-screen photos are generated first.
///
/// Internally this is a `VecDeque` protected by a `Mutex`. The lock is held
/// only for the duration of each individual operation, keeping contention low.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct ThumbnailQueue {
    inner: Arc<Mutex<VecDeque<String>>>,
}

impl ThumbnailQueue {
    /// Create a new queue pre-populated with `paths` in order.
    pub fn new(paths: Vec<String>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::from(paths))),
        }
    }

    /// Pop the next path from the front of the queue.
    /// Returns `None` when the queue is empty.
    pub fn pop(&self) -> Option<String> {
        self.inner.lock().unwrap().pop_front()
    }

    /// Move `priority_paths` to the front of the queue, preserving their
    /// relative order, without duplicating entries that are already done
    /// (i.e. no longer in the queue).
    ///
    /// Paths in `priority_paths` that are not currently in the queue
    /// (already processed or never existed) are silently ignored.
    pub fn prioritize(&self, priority_paths: &[String]) {
        let mut queue = self.inner.lock().unwrap();

        // Collect the priority paths that are still pending, in order.
        // Use a set for O(1) membership checks against the queue.
        let pending: std::collections::HashSet<&str> =
            queue.iter().map(|s| s.as_str()).collect();

        let to_front: Vec<String> = priority_paths
            .iter()
            .filter(|p| pending.contains(p.as_str()))
            .cloned()
            .collect();

        if to_front.is_empty() {
            return;
        }

        // Remove the priority paths from wherever they currently sit.
        let promote_set: std::collections::HashSet<&str> =
            to_front.iter().map(|s| s.as_str()).collect();
        queue.retain(|p| !promote_set.contains(p.as_str()));

        // Prepend them in the requested order.
        for path in to_front.into_iter().rev() {
            queue.push_front(path);
        }
    }

    /// Return the current number of pending items (primarily for testing).
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// Return true if the queue is empty.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Return a snapshot of the current queue order (primarily for testing).
    #[allow(dead_code)]
    pub fn snapshot(&self) -> Vec<String> {
        self.inner.lock().unwrap().iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(items: &[&str]) -> ThumbnailQueue {
        ThumbnailQueue::new(items.iter().map(|s| s.to_string()).collect())
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
    fn pop_on_empty_queue_returns_none() {
        let q = queue(&[]);
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
        // Request c before b — they should appear in that order at the front.
        q.prioritize(&["c".into(), "b".into()]);
        assert_eq!(q.snapshot(), vec!["c", "b", "a", "d"]);
    }

    #[test]
    fn prioritize_ignores_paths_not_in_queue() {
        let q = queue(&["a", "b", "c"]);
        // "z" was never in the queue (or already processed).
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

    // ── concurrent access ─────────────────────────────────────────────────────

    #[test]
    fn concurrent_pops_drain_queue_exactly_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let paths: Vec<String> = (0..100).map(|i| format!("photo_{i}.jpg")).collect();
        let q = Arc::new(ThumbnailQueue::new(paths));
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
}
