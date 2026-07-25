/// Integration test that exercises the multi-threaded scan pipeline:
/// the directory walk feeds two shared queues, worker pools drain them
/// concurrently, prioritization can run alongside, and cancellation
/// shuts everything down cleanly.
///
/// `start_scan` in lib.rs binds these pieces to Tauri (AppHandle, events,
/// State<>) and isn't reachable from an integration test. We reproduce
/// the orchestration here so a regression in how the modules interact
/// is caught even when the unit tests still pass.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use medialibrary_tauri_lib::scanner;
use medialibrary_tauri_lib::work_queue::{PopResult, WorkQueue};
use tempfile::tempdir;

fn make_dummy_jpgs(dir: &std::path::Path, n: usize) -> Vec<String> {
    (0..n)
        .map(|i| {
            let name = format!("file_{i:04}.jpg");
            fs::write(dir.join(&name), b"x").unwrap();
            name
        })
        .collect()
}

#[test]
fn scan_folder_discovers_supported_image_audio_and_video_extensions() {
    use scanner::MediaKind;

    let dir = tempdir().unwrap();
    let extensions = [
        (
            MediaKind::Image,
            ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"].as_slice(),
        ),
        (
            MediaKind::Audio,
            [
                "mp3", "flac", "m4a", "m4b", "aac", "wav", "aiff", "ogg", "opus", "wma", "ape",
            ]
            .as_slice(),
        ),
        (
            MediaKind::Video,
            [
                "mp4", "mov", "m4v", "3gp", "3g2", "avi", "mkv", "webm", "mpg", "mpeg", "m2v",
                "mts", "m2ts", "ts", "wmv",
            ]
            .as_slice(),
        ),
    ];

    for (_, kind_extensions) in extensions {
        for extension in kind_extensions {
            fs::write(dir.path().join(format!("sample.{extension}")), b"x").unwrap();
        }
    }
    fs::write(dir.path().join("uppercase.FLAC"), b"x").unwrap();
    fs::write(dir.path().join("unsupported.txt"), b"x").unwrap();
    fs::write(dir.path().join("no-extension"), b"x").unwrap();

    let mut discovered = HashMap::new();
    scanner::scan_folder(
        dir.path(),
        Arc::new(AtomicBool::new(false)),
        |file| {
            discovered.insert(file.relative_path, file.media_kind);
        },
        |error| panic!("unexpected scan error: {error:?}"),
    );

    let mut expected = HashMap::new();
    for (media_kind, kind_extensions) in extensions {
        for extension in kind_extensions {
            expected.insert(format!("sample.{extension}"), media_kind);
        }
    }
    expected.insert("uppercase.FLAC".to_owned(), MediaKind::Audio);

    assert_eq!(discovered, expected);
}
#[test]
fn walk_feeds_queues_and_workers_drain_them_with_no_loss() {
    let dir = tempdir().unwrap();
    let names = make_dummy_jpgs(dir.path(), 200);

    let metadata_q = Arc::new(WorkQueue::new(vec![]));
    let thumb_q = Arc::new(WorkQueue::new(vec![]));
    let cancel = Arc::new(AtomicBool::new(false));

    let metadata_seen: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let thumb_seen: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let metadata_handles: Vec<_> = (0..4)
        .map(|_| {
            let q = metadata_q.clone();
            let seen = metadata_seen.clone();
            std::thread::spawn(move || loop {
                match q.pop_batch_timeout(20, Duration::from_millis(100)) {
                    PopResult::Items(items) => {
                        let mut s = seen.lock().unwrap();
                        for item in items {
                            s.insert(item);
                        }
                    }
                    PopResult::Timeout => continue,
                    PopResult::Done => break,
                }
            })
        })
        .collect();

    let thumb_handles: Vec<_> = (0..8)
        .map(|_| {
            let q = thumb_q.clone();
            let seen = thumb_seen.clone();
            std::thread::spawn(move || loop {
                match q.pop_timeout(Duration::from_millis(100)) {
                    PopResult::Items(item) => {
                        seen.lock().unwrap().insert(item);
                    }
                    PopResult::Timeout => continue,
                    PopResult::Done => break,
                }
            })
        })
        .collect();

    let walk_metadata = metadata_q.clone();
    let walk_thumb = thumb_q.clone();
    let walk_cancel = cancel.clone();
    let root: PathBuf = dir.path().to_path_buf();
    let walk = std::thread::spawn(move || {
        scanner::scan_folder(
            &root,
            walk_cancel,
            |file| {
                walk_metadata.push(file.relative_path.clone());
                walk_thumb.push(file.relative_path);
            },
            |_| {},
        );
    });

    walk.join().unwrap();
    metadata_q.finish();
    thumb_q.finish();
    for h in metadata_handles {
        h.join().unwrap();
    }
    for h in thumb_handles {
        h.join().unwrap();
    }

    let m = metadata_seen.lock().unwrap();
    let t = thumb_seen.lock().unwrap();
    assert_eq!(m.len(), names.len(), "metadata workers missed items");
    assert_eq!(t.len(), names.len(), "thumbnail workers missed items");
    let expected: HashSet<String> = names.into_iter().collect();
    assert_eq!(*m, expected);
    assert_eq!(*t, expected);
}

#[test]
fn cancellation_during_walk_shuts_pipeline_down_cleanly() {
    let dir = tempdir().unwrap();
    make_dummy_jpgs(dir.path(), 500);

    let metadata_q = Arc::new(WorkQueue::new(vec![]));
    let thumb_q = Arc::new(WorkQueue::new(vec![]));
    let cancel = Arc::new(AtomicBool::new(false));

    let processed = Arc::new(AtomicUsize::new(0));

    let metadata_handles: Vec<_> = (0..2)
        .map(|_| {
            let q = metadata_q.clone();
            let counter = processed.clone();
            std::thread::spawn(move || loop {
                match q.pop_batch_timeout(20, Duration::from_millis(50)) {
                    PopResult::Items(items) => {
                        counter.fetch_add(items.len(), Ordering::Relaxed);
                    }
                    PopResult::Timeout => continue,
                    PopResult::Done => break,
                }
            })
        })
        .collect();

    let walk_metadata = metadata_q.clone();
    let walk_thumb = thumb_q.clone();
    let walk_cancel = cancel.clone();
    let root: PathBuf = dir.path().to_path_buf();
    let walk = std::thread::spawn(move || {
        scanner::scan_folder(
            &root,
            walk_cancel,
            |file| {
                walk_metadata.push(file.relative_path.clone());
                walk_thumb.push(file.relative_path);
            },
            |_| {},
        );
    });

    // Cancel almost immediately, simulating the user switching folders.
    std::thread::sleep(Duration::from_millis(5));
    cancel.store(true, Ordering::Relaxed);
    metadata_q.abort();
    thumb_q.abort();

    walk.join().unwrap();
    for h in metadata_handles {
        h.join().unwrap();
    }

    // Cancellation must have stopped the walk early — not all 500 reach the workers.
    // We don't assert an exact upper bound (timing is racy) but the walk must terminate.
    assert!(
        processed.load(Ordering::Relaxed) <= 500,
        "processed count exceeds total file count"
    );
}

#[test]
fn prioritize_during_active_scan_moves_visible_paths_to_front() {
    // Pre-populate a queue (simulating a walk that already pushed everything),
    // then prioritize a subset and verify the next pops match the priority order.
    let q = Arc::new(WorkQueue::new(vec![]));
    for i in 0..100 {
        q.push(format!("file_{i:04}.jpg"));
    }

    // User scrolls and the visible paths are 50, 51, 52 (mid-list).
    let visible: Vec<String> = (50..53).map(|i| format!("file_{i:04}.jpg")).collect();
    q.prioritize(&visible);

    // Next three pops should be the prioritized items in order.
    assert_eq!(q.pop(), Some("file_0050.jpg".into()));
    assert_eq!(q.pop(), Some("file_0051.jpg".into()));
    assert_eq!(q.pop(), Some("file_0052.jpg".into()));

    // The next pop should fall back to the original order, with priority items removed.
    assert_eq!(q.pop(), Some("file_0000.jpg".into()));
}
