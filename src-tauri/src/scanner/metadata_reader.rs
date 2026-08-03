//! ExifTool process execution and batched metadata reads.

use super::*;

/// Read image metadata for a batch of files using ExifTool.
///
/// Flags:
///  -a                    Allow duplicate tag names (see all occurrences)
///  -G:1:3:4:5:7          Unsimplified family 1, document/sample (family 3),
///                        copy (family 4), complete path (family 5), and
///                        runtime tag ID (family 7), followed by tag name.
///  -t                    Include the exact ExifTool tag-table name.
///  -D                    Include the exact decimal tag ID.
///  -s                    Short tag names
///  -struct               Preserve nested XMP structs as JSON objects (face
///                        regions, QuickTime Keys group, etc.) — these now
///                        parse into `MetadataValue::Struct` instead of being
///                        silently dropped.
///  -charset filename=utf8 Force UTF-8 path handling so non-ASCII filenames
///                        work on Windows.
///  -charset utf8         Force UTF-8 for tag values.
///  --system:all          Exclude OS-level system tags
///  --composite:all       Exclude composite (computed) tags
///  -j                    JSON output
///
/// Runs **two required passes** per batch and merges them into one canonical
/// `FileMetadata` per file:
///
/// - Pass A: no `-n`. Pretty values — `Orientation = "Rotate 90 CW"`,
///   `ExposureTime = "1/250"`. These JSON values supply display/pretty parser
///   hints, especially exact rational strings. ExifTool display/pretty JSON is
///   not app metadata; it is only parser input.
/// - Pass B: with `-n`. Raw values — `Orientation = 6`,
///   `ExposureTime = 0.004`. This is the primary canonical source.
///
/// Both passes request table identity (`-t`), decimal schema tag IDs (`-D`),
/// and the same unsimplified runtime occurrence coordinates
/// (`-G:1:3:4:5:7`).
/// Both passes use the same flags otherwise, so the second pass is cheap
/// (exiftool startup dominates; the OS file cache is hot). They run
/// sequentially on the same worker — parallelism gains nothing because
/// startup, not CPU, is the cost.
///
/// Both display and raw passes are required for each successful file. If a
/// source-specific pass fails, that file's parsing fails while successful
/// neighbouring files remain available.
///
/// Top-level or batch-wide failures (such as ExifTool not launching, process exiting
/// unsuccessfully, or stdout not being valid top-level JSON array) remain batch-wide.
///
/// The function can return successful and failed files together. Successful
/// files contain the complete authoritative occurrence set. Only genuine
/// parsing, canonicalisation or invariant failures appear in `failures`; a
/// schema-keyed ambiguity is never a scanner failure.
///
/// Returns Ok(MetadataBatchReadOutcome) when ExifTool executes successfully.
/// Returns Err(error_message) only for genuine batch-wide process/parsing
/// failures.
pub fn read_file_metadata_batch(
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
) -> Result<MetadataBatchReadOutcome, String> {
    if rel_paths.len() != abs_paths.len() {
        return Err(format!(
            "Mismatched paths length: relative paths count ({}) does not match absolute paths count ({})",
            rel_paths.len(),
            abs_paths.len()
        ));
    }

    if abs_paths.is_empty() {
        return Ok(MetadataBatchReadOutcome {
            results: Vec::new(),
            failures: Vec::new(),
        });
    }

    log::info!(
        "[exiftool] Reading {} files (two-pass), first: {:?}",
        abs_paths.len(),
        abs_paths.first()
    );

    // TEMPORARY: simulate slow metadata reading for load testing.
    #[cfg(not(test))]
    if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // Pass A: pretty values (no -n), used only as parser input.
    let display_pass = run_exiftool_pass(abs_paths, false)
        .map_err(|e| format!("ExifTool display pass failed: {}", e))?;

    // Pass B: raw values (-n), the primary canonical source.
    let raw_pass = run_exiftool_pass(abs_paths, true)
        .map_err(|e| format!("ExifTool raw (-n) pass failed: {}", e))?;

    let registry = crate::tag_schema::get_registry().ok();
    let mut batch_warnings = Vec::new();

    let outcome = assemble_batch_outcome(
        rel_paths,
        abs_paths,
        display_pass,
        raw_pass,
        registry,
        &mut batch_warnings,
    )?;

    if !batch_warnings.is_empty() {
        log_aggregated_warnings(&batch_warnings);
    }

    Ok(outcome)
}

/// Run one exiftool pass over `paths` and return a per-SourceFile map.
/// `numeric=true` adds `-n` to drop PrintConv formatting.
fn run_exiftool_pass(
    paths: &[std::path::PathBuf],
    numeric: bool,
) -> Result<ExifToolPassOutput, String> {
    let pass_label = if numeric {
        "raw (-n) pass"
    } else {
        "display pass"
    };
    let mut cmd = crate::exiftool_config::exiftool_command();
    for arg in exiftool_read_args(numeric) {
        cmd.arg(arg);
    }
    for path in paths {
        cmd.arg(path);
    }

    let output = cmd.output().map_err(|e| {
        format!(
            "failed to execute: {}. Please ensure ExifTool is installed and accessible.",
            e
        )
    })?;

    let json = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if json.trim().is_empty() {
        if output.status.success() {
            return Ok(ExifToolPassOutput {
                values_by_source: HashMap::new(),
                failures_by_source: HashMap::new(),
            });
        }
        log::error!(
            "[exiftool] ExifTool {} failed without usable output (status {:?}): {}",
            pass_label,
            output.status,
            stderr
        );
        return Err(format!("status {:?}: {}", output.status, stderr));
    }

    let parsed = try_parse_exiftool_pass_json_raw_with_registry_and_context(
        &json,
        crate::tag_schema::get_registry().ok(),
        Some(pass_label),
    );

    if output.status.success() {
        return parsed;
    }

    match parsed {
        Ok(parsed)
            if !parsed.values_by_source.is_empty() || !parsed.failures_by_source.is_empty() =>
        {
            log::warn!(
                "[exiftool] ExifTool {} exited with status {:?}, but returned usable per-file JSON: {}",
                pass_label,
                output.status,
                stderr
            );
            Ok(parsed)
        }
        Ok(_) => Err(format!(
            "status {:?}: {}; ExifTool returned no classified file results",
            output.status, stderr
        )),
        Err(parse_error) => Err(format!(
            "status {:?}: {}; failed to parse ExifTool output: {}",
            output.status, stderr, parse_error
        )),
    }
}

pub(super) fn exiftool_read_args(numeric: bool) -> Vec<&'static str> {
    let mut args = vec![
        "-a",
        "-G:1:3:4:5:7",
        "-s",
        "-struct",
        "-t",
        "-D",
        "-charset",
        "filename=utf8",
        "-charset",
        "utf8",
        "--system:all",
        "--composite:all",
        "-j",
    ];
    if numeric {
        args.push("-n");
    }
    args
}
