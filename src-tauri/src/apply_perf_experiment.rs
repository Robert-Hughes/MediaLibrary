//! Manual, ignored performance experiments for the metadata apply I/O shape.
//! All writes target disposable copies of repository fixtures.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::tempdir;

use crate::metadata_write_execution::{
    build_exiftool_write_argfile_args, render_exiftool_argfile, run_exiftool_write,
};

const FILE_COUNT: usize = 8;

#[derive(Debug)]
struct ExperimentResult {
    elapsed: Duration,
    pre_read: Duration,
    writes: Duration,
    post_read: Duration,
    read_processes: usize,
    write_processes: usize,
}

fn prepare_files() -> (tempfile::TempDir, Vec<String>, Vec<PathBuf>) {
    let temp = tempdir().expect("create experiment temp directory");
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test_images")
        .join("real_with_exif.jpg");
    let mut relative_paths = Vec::with_capacity(FILE_COUNT);
    let mut absolute_paths = Vec::with_capacity(FILE_COUNT);
    for index in 0..FILE_COUNT {
        let relative_path = format!("apply-perf-{index}.jpg");
        let absolute_path = temp.path().join(&relative_path);
        std::fs::copy(&source, &absolute_path).expect("copy fixture");
        relative_paths.push(relative_path);
        absolute_paths.push(absolute_path);
    }
    (temp, relative_paths, absolute_paths)
}

fn read_batch(relative_paths: &[String], absolute_paths: &[PathBuf]) {
    let outcome = crate::scanner::read_file_metadata_batch(relative_paths, absolute_paths)
        .expect("authoritative batch read");
    assert!(
        outcome.failures.is_empty(),
        "unexpected read failures: {:?}",
        outcome.failures
    );
    assert_eq!(outcome.results.len(), absolute_paths.len());
}

fn write_file(path: &Path, index: usize) -> Result<(), String> {
    let numeric = build_exiftool_write_argfile_args(
        path,
        &[format!("-XMP-xmp:Rating={}", (index % 5) + 1)],
        true,
    )
    .and_then(|args| render_exiftool_argfile(&args))?;
    run_exiftool_write(&numeric, true)?;

    let text = build_exiftool_write_argfile_args(
        path,
        &[format!("-XMP-dc:Title=apply performance {index}")],
        false,
    )
    .and_then(|args| render_exiftool_argfile(&args))?;
    run_exiftool_write(&text, false)
}

fn write_files_bounded(paths: &[PathBuf], workers: usize) {
    let paths = Arc::new(paths.to_vec());
    let next = Arc::new(AtomicUsize::new(0));
    let handles = (0..workers)
        .map(|_| {
            let paths = Arc::clone(&paths);
            let next = Arc::clone(&next);
            std::thread::spawn(move || -> Result<(), String> {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else {
                        return Ok(());
                    };
                    write_file(path, index)?;
                }
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().expect("write worker panicked").unwrap();
    }
}

fn run_serial_per_file() -> ExperimentResult {
    let (_temp, relative_paths, absolute_paths) = prepare_files();
    let started = Instant::now();
    let mut pre_read = Duration::ZERO;
    let mut writes = Duration::ZERO;
    let mut post_read = Duration::ZERO;
    for (index, (relative_path, absolute_path)) in
        relative_paths.iter().zip(&absolute_paths).enumerate()
    {
        let phase = Instant::now();
        read_batch(
            std::slice::from_ref(relative_path),
            std::slice::from_ref(absolute_path),
        );
        pre_read += phase.elapsed();

        let phase = Instant::now();
        write_file(absolute_path, index).unwrap();
        writes += phase.elapsed();

        let phase = Instant::now();
        read_batch(
            std::slice::from_ref(relative_path),
            std::slice::from_ref(absolute_path),
        );
        post_read += phase.elapsed();
    }
    ExperimentResult {
        elapsed: started.elapsed(),
        pre_read,
        writes,
        post_read,
        read_processes: FILE_COUNT * 4,
        write_processes: FILE_COUNT * 2,
    }
}

fn run_batched_reads(write_workers: usize) -> ExperimentResult {
    let (_temp, relative_paths, absolute_paths) = prepare_files();
    let started = Instant::now();

    let phase = Instant::now();
    read_batch(&relative_paths, &absolute_paths);
    let pre_read = phase.elapsed();

    let phase = Instant::now();
    write_files_bounded(&absolute_paths, write_workers);
    let writes = phase.elapsed();

    let phase = Instant::now();
    read_batch(&relative_paths, &absolute_paths);
    let post_read = phase.elapsed();

    ExperimentResult {
        elapsed: started.elapsed(),
        pre_read,
        writes,
        post_read,
        read_processes: 4,
        write_processes: FILE_COUNT * 2,
    }
}

fn report(mode: &str, write_workers: usize, result: ExperimentResult) {
    println!(
        "APPLY_PERF_RESULT mode={mode} files={FILE_COUNT} write_workers={write_workers} \
         elapsed_ms={} pre_read_ms={} writes_ms={} post_read_ms={} \
         read_processes={} write_processes={} total_processes={}",
        result.elapsed.as_millis(),
        result.pre_read.as_millis(),
        result.writes.as_millis(),
        result.post_read.as_millis(),
        result.read_processes,
        result.write_processes,
        result.read_processes + result.write_processes,
    );
}

#[test]
#[ignore = "manual performance experiment"]
fn serial_per_file() {
    report("serial_per_file", 1, run_serial_per_file());
}

#[test]
#[ignore = "manual performance experiment"]
fn batched_reads_serial_writes() {
    report("batched_reads", 1, run_batched_reads(1));
}

#[test]
#[ignore = "manual performance experiment"]
fn batched_reads_two_write_workers() {
    report("batched_reads", 2, run_batched_reads(2));
}

#[test]
#[ignore = "manual performance experiment"]
fn batched_reads_four_write_workers() {
    report("batched_reads", 4, run_batched_reads(4));
}
