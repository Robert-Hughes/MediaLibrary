/// Background folder scanning logic.
///
/// Three concerns are kept separate:
///  - `scan_folder` — fast directory walk, path + OS metadata only. Calls a
///    callback per file so callers can stream results.
///  - `read_image_metadata` — reads metadata for a single file using ExifTool.
///  - `thumbnail_for` — generates a thumbnail.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use walkdir::WalkDir;

use crate::metadata_occurrence::{MetadataOccurrence, MetadataOccurrenceId, MetadataWriteTarget};
use crate::metadata_value::{parse_metadata_value, MetadataValue};
use crate::tag_schema::{normalize_runtime_tag_id, SchemaDefinitionId, TagKind, TagRegistry};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataEntry {
    pub id: SchemaDefinitionId,
    pub value: MetadataValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(transparent)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataEntries(pub Vec<MetadataEntry>);

impl MetadataEntries {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn get(&self, id: &SchemaDefinitionId) -> Option<&MetadataValue> {
        self.0
            .iter()
            .find(|entry| entry.id == *id)
            .map(|entry| &entry.value)
    }
}

impl IntoIterator for MetadataEntries {
    type Item = MetadataEntry;
    type IntoIter = std::vec::IntoIter<MetadataEntry>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

// ── ExifTool executable name ──────────────────────────────────────────────────

pub(crate) fn find_exiftool() -> &'static str {
    if cfg!(target_os = "windows") {
        "exiftool.exe"
    } else {
        "exiftool"
    }
}

/// File extensions recognised as photos.
const PHOTO_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

/// A single photo entry from the directory walk.
/// Contains only path and OS metadata — Image metadata arrives separately via `read_image_metadata`.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct PhotoInfo {
    pub relative_path: String,
    pub filename: String,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub date_modified: Option<i64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub date_created: Option<i64>,
}

/// A directory-walk failure (permission denied, broken symlink, IO error,
/// etc.).  Reported per-entry — the walk continues past the failure.
#[derive(Debug, Clone)]
pub struct WalkErrorInfo {
    /// The path that produced the error, if WalkDir was able to identify it.
    pub path: Option<String>,
    pub message: String,
}

/// Image-level metadata for a single photo, delivered asynchronously after discovery.
///
/// `metadata` is canonical semantic app metadata. ExifTool display/pretty JSON
/// may be read internally as parsing hints, but it is not exposed as app
/// metadata.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImageMetadata {
    pub relative_path: String,
    pub metadata: MetadataEntries,
}

pub type MetadataMap = BTreeMap<SchemaDefinitionId, MetadataValue>;

fn metadata_entries(values: MetadataMap) -> MetadataEntries {
    MetadataEntries(
        values
            .into_iter()
            .map(|(id, value)| MetadataEntry { id, value })
            .collect(),
    )
}

/// Walk `folder` and call `on_photo` for each image file found.
/// Only reads OS metadata (a cheap `stat` call) — no image I/O.
/// Checks `cancellation_flag` and stops early if set to true.
///
/// Per-entry walk failures (permission denied, broken symlink, etc.) are
/// reported via `on_error` — they previously were silently dropped, leaving
/// the user wondering why files in a folder didn't appear.
pub fn scan_folder<P, E>(
    folder: &Path,
    cancellation_flag: Arc<AtomicBool>,
    mut on_photo: P,
    mut on_error: E,
) where
    P: FnMut(PhotoInfo),
    E: FnMut(WalkErrorInfo),
{
    for entry in WalkDir::new(folder).follow_links(false) {
        if cancellation_flag.load(Ordering::Relaxed) {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                on_error(WalkErrorInfo {
                    path: err.path().map(|p| p.to_string_lossy().into_owned()),
                    message: err.to_string(),
                });
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_ascii_lowercase(),
            None => continue,
        };

        if !PHOTO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }

        let rel = match path.strip_prefix(folder) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let (date_modified, date_created) = read_os_metadata(path);

        // TEMPORARY: simulate slow directory enumeration for load testing.
        #[cfg(not(test))]
        if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        on_photo(PhotoInfo {
            relative_path: rel,
            filename,
            date_modified,
            date_created,
        });
    }
}

/// Read OS-level file metadata: modified and created timestamps.
fn read_os_metadata(path: &Path) -> (Option<i64>, Option<i64>) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (None, None),
    };
    let modified = meta.modified().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs() as i64)
    });
    let created = meta.created().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs() as i64)
    });
    (modified, created)
}

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
/// `ImageMetadata` per file:
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
/// The function can return successful and failed files together.
///
/// Returns Ok(MetadataBatchReadOutcome) when ExifTool executes successfully, which contains
/// both successfully parsed files and per-file failures. Returns Err(error_message) only
/// for genuine batch-wide process/parsing failures.
pub fn read_image_metadata_batch(
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

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!(
            "[exiftool] ExifTool {} failed (status {:?}): {}",
            pass_label,
            output.status,
            stderr
        );
        return Err(format!("status {:?}: {}", output.status, stderr));
    }

    let json = String::from_utf8_lossy(&output.stdout);
    if json.trim().is_empty() {
        return Ok(ExifToolPassOutput {
            values_by_source: HashMap::new(),
            failures_by_source: HashMap::new(),
        });
    }
    try_parse_exiftool_pass_json_raw(&json)
}

fn exiftool_read_args(numeric: bool) -> Vec<&'static str> {
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

/// Parse one exiftool `-j` array into a map keyed by normalized SourceFile path.
/// Per-entry isolation: a single bad entry logs and is skipped, leaving the
/// rest intact.
///
/// Binary substitution: exiftool emits literal `"(Binary data N bytes, use -b
/// option to extract)"` strings for binary tags in `-j` output. Mentioning the
/// `-b` flag is meaningless to Media Library users (they never invoke exiftool
/// directly), so any key whose schema kind is `TagKind::Binary` is replaced
/// with a neutral `"<binary>"` string before semantic parsing.
#[derive(Debug, Clone, Serialize)]
pub struct MetadataReadFailure {
    pub relative_path: String,
    pub error_message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetadataBatchReadOutcome {
    pub results: Vec<ImageMetadata>,
    pub failures: Vec<MetadataReadFailure>,
}

#[derive(Debug, Clone)]
struct ExifToolRuntimeValue {
    pub table: String,
    pub tag_id: String,
    pub index: Option<u32>,
    pub language: Option<String>,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone)]
struct RuntimeProperty {
    pub occurrence_id: MetadataOccurrenceId,
    // Runtime occurrence coordinates and static schema identity come from
    // independent ExifTool fields and must never be inferred from each other.
    pub schema_id: SchemaDefinitionId,
    pub group1: String,
    pub tag_name: String,
    pub friendly_name: String,
    pub runtime: ExifToolRuntimeValue,
}

type RuntimeMap = BTreeMap<MetadataOccurrenceId, RuntimeProperty>;

#[derive(Debug, Clone, Default)]
struct ExifToolPassOutput {
    pub values_by_source: HashMap<String, RuntimeMap>,
    pub failures_by_source: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedRuntimePropertyKey {
    occurrence_id: MetadataOccurrenceId,
    group1: String,
    tag_name: String,
}

impl ParsedRuntimePropertyKey {
    fn friendly_name(&self) -> String {
        format!("{}:{}", self.group1, self.tag_name)
    }
}

fn parse_runtime_property_key(key: &str) -> Result<ParsedRuntimePropertyKey, String> {
    // Confirmed with ExifTool 13.57 and `-G:1:3:4:5:7`: every requested
    // position is retained as
    // `IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution`. The empty family-4
    // position is the primary copy; explicit duplicates use `Copy1`, etc.
    let mut parts = key.splitn(6, ':');
    let group1 = parts.next().unwrap_or_default();
    let document_group = parts.next();
    let copy_group = parts.next();
    let path = parts.next();
    let family7 = parts.next();
    let tag_name = parts.next();

    let (document_group, copy_group, path, family7, tag_name) =
        match (document_group, copy_group, path, family7, tag_name) {
            (Some(document), Some(copy), Some(path), Some(family7), Some(tag_name)) => {
                (document, copy, path, family7, tag_name)
            }
            _ => return Err("expected family 1:3:4:5:7 and tag-name components".to_string()),
        };

    if group1.is_empty() {
        return Err("family-1 group is empty".to_string());
    }
    if document_group.is_empty() {
        return Err("family-3 document/sample group is empty".to_string());
    }
    if path.is_empty() {
        return Err("family-5 metadata path is empty".to_string());
    }
    if tag_name.is_empty() {
        return Err("runtime tag name is empty".to_string());
    }

    let copy = match copy_group {
        "" | "Copy0" => 0,
        value => value
            .strip_prefix("Copy")
            .filter(|digits| {
                !digits.is_empty()
                    && !digits.starts_with('0')
                    && digits.chars().all(|digit| digit.is_ascii_digit())
            })
            .ok_or_else(|| format!("invalid family-4 copy group `{value}`"))?
            .parse::<u32>()
            .map_err(|_| format!("invalid family-4 copy group `{value}`"))?,
    };
    let tag_id = family7
        .strip_prefix("ID-")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("invalid family-7 runtime tag ID `{family7}`"))?;

    Ok(ParsedRuntimePropertyKey {
        occurrence_id: MetadataOccurrenceId {
            document: (document_group != "Main").then(|| document_group.to_string()),
            path: path.to_string(),
            tag_id: tag_id.to_string(),
            copy,
        },
        group1: group1.to_string(),
        tag_name: tag_name.to_string(),
    })
}

fn parse_runtime_value(value: serde_json::Value) -> Result<ExifToolRuntimeValue, String> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("expected wrapped ExifTool runtime value, got {value}"))?;
    let table = object
        .remove("table")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| "runtime value is missing string field `table`".to_string())?;
    let id = object
        .remove("id")
        .ok_or_else(|| "runtime value is missing field `id`".to_string())?;
    let tag_id = normalize_runtime_tag_id(&id)?;
    let index = object
        .remove("index")
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value::<u32>(value).map_err(|e| e.to_string()))
        .transpose()?;
    let language = object
        .remove("lang")
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value::<String>(value).map_err(|e| e.to_string()))
        .transpose()?;
    let value = object
        .remove("val")
        .ok_or_else(|| "runtime value is missing field `val`".to_string())?;
    Ok(ExifToolRuntimeValue {
        table,
        tag_id,
        index,
        language,
        value,
    })
}

fn parse_single_source_object(
    obj: serde_json::Map<String, serde_json::Value>,
    registry: Option<&crate::tag_schema::TagRegistry>,
) -> Result<RuntimeMap, String> {
    let mut map = RuntimeMap::new();
    for (key, val) in obj {
        if key == "SourceFile" {
            continue;
        }
        let parsed_key =
            parse_runtime_property_key(&key).map_err(|error| format!("property {key}: {error}"))?;
        let friendly_name = parsed_key.friendly_name();
        let mut runtime = parse_runtime_value(val)
            .map_err(|error| format!("property {friendly_name}: {error}"))?;

        let schema_id = SchemaDefinitionId {
            table: runtime.table.clone(),
            tag_id: runtime.tag_id.clone(),
            index: runtime.index,
        };
        let value = if is_binary_tag(&schema_id, registry)
            || is_exiftool_binary_placeholder(&runtime.value)
        {
            serde_json::Value::String("<binary>".to_string())
        } else {
            runtime.value
        };
        runtime.value = value;
        let property = RuntimeProperty {
            occurrence_id: parsed_key.occurrence_id.clone(),
            schema_id,
            group1: parsed_key.group1,
            tag_name: parsed_key.tag_name,
            friendly_name,
            runtime,
        };
        debug_assert_eq!(
            property.friendly_name,
            format!("{}:{}", property.group1, property.tag_name)
        );
        if let Some(previous) = map.get(&property.occurrence_id) {
            let conflict = if previous.schema_id != property.schema_id {
                Some("different schema identity")
            } else if previous.group1 != property.group1 || previous.tag_name != property.tag_name {
                Some("different family-1 group or tag name")
            } else if previous.friendly_name != property.friendly_name {
                Some("different canonical friendly name")
            } else if previous.runtime.language != property.runtime.language {
                Some("different language")
            } else if previous.runtime.value != property.runtime.value {
                Some("different value")
            } else {
                None
            };
            if let Some(conflict) = conflict {
                return Err(format!(
                    "same occurrence ID, {conflict}: {occurrence:#?}\nfirst: schema={first_schema:#?} friendly={first_name:?} group1={first_group:?} tag_name={first_tag:?} language={first_language:?} value={first_value}\nsecond: schema={second_schema:#?} friendly={second_name:?} group1={second_group:?} tag_name={second_tag:?} language={second_language:?} value={second_value}",
                    occurrence = property.occurrence_id,
                    first_schema = previous.schema_id,
                    first_name = previous.friendly_name,
                    first_group = previous.group1,
                    first_tag = previous.tag_name,
                    first_language = previous.runtime.language,
                    first_value = previous.runtime.value,
                    second_schema = property.schema_id,
                    second_name = property.friendly_name,
                    second_group = property.group1,
                    second_tag = property.tag_name,
                    second_language = property.runtime.language,
                    second_value = property.runtime.value,
                ));
            }
            log::warn!(
                "deduplicated identical occurrence ID {:?}",
                property.occurrence_id
            );
        } else {
            map.insert(property.occurrence_id.clone(), property);
        }
    }
    Ok(map)
}

fn try_parse_exiftool_pass_json_raw(json: &str) -> Result<ExifToolPassOutput, String> {
    try_parse_exiftool_pass_json_raw_with_registry(json, crate::tag_schema::get_registry().ok())
}

fn try_parse_exiftool_pass_json_raw_with_registry(
    json: &str,
    registry: Option<&crate::tag_schema::TagRegistry>,
) -> Result<ExifToolPassOutput, String> {
    let raw_entries: Vec<serde_json::Value> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            let preview: String = json.chars().take(200).collect();
            log::error!(
                "[parse_exiftool] Failed to parse outer ExifTool JSON: {}. First 200 chars: {:?}",
                e,
                preview
            );
            return Err(format!("invalid ExifTool JSON: {e}"));
        }
    };

    let mut values_by_source = HashMap::new();
    let mut failures_by_source = HashMap::new();

    for (idx, raw) in raw_entries.into_iter().enumerate() {
        let source = raw
            .get("SourceFile")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let obj = match raw {
            serde_json::Value::Object(o) => o,
            other => {
                log::warn!(
                    "[parse_exiftool] Skipping entry {} ({}): expected JSON object, got {:?}",
                    idx,
                    source.as_deref().unwrap_or("<no SourceFile>"),
                    other
                );
                continue;
            }
        };

        let Some(s) = source else {
            log::warn!(
                "[parse_exiftool] Entry {} has no SourceFile; cannot map to a request path",
                idx
            );
            continue;
        };

        let normalized_path = s.replace('\\', "/");

        match parse_single_source_object(obj, registry) {
            Ok(map) => {
                values_by_source.insert(normalized_path, map);
            }
            Err(e) => {
                log::error!(
                    "[parse_exiftool] Error parsing metadata for SourceFile {}: {}",
                    normalized_path,
                    e
                );
                failures_by_source.insert(normalized_path, e);
            }
        }
    }

    Ok(ExifToolPassOutput {
        values_by_source,
        failures_by_source,
    })
}

fn assemble_batch_outcome(
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
    mut display_pass: ExifToolPassOutput,
    mut raw_pass: ExifToolPassOutput,
    registry: Option<&crate::tag_schema::TagRegistry>,
    batch_warnings: &mut Vec<ParseWarning>,
) -> Result<MetadataBatchReadOutcome, String> {
    if rel_paths.len() != abs_paths.len() {
        return Err(format!(
            "Mismatched paths length: relative paths count ({}) does not match absolute paths count ({})",
            rel_paths.len(),
            abs_paths.len()
        ));
    }

    let mut results = Vec::new();
    let mut failures = Vec::new();

    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let key = abs_path.to_string_lossy().replace('\\', "/");

        let display_failure = display_pass.failures_by_source.remove(&key);
        let raw_failure = raw_pass.failures_by_source.remove(&key);

        let has_display_val = display_pass.values_by_source.contains_key(&key);
        let has_raw_val = raw_pass.values_by_source.contains_key(&key);

        let mut error_messages = Vec::new();

        if let Some(df) = display_failure {
            error_messages.push(format!("ExifTool display pass failed:\n{}", df));
        } else if !has_display_val {
            error_messages.push(
                "ExifTool display pass failed:\nExifTool returned no result for this file"
                    .to_string(),
            );
        }

        if let Some(rf) = raw_failure {
            error_messages.push(format!("ExifTool raw (-n) pass failed:\n{}", rf));
        } else if !has_raw_val {
            error_messages.push(
                "ExifTool raw (-n) pass failed:\nExifTool returned no result for this file"
                    .to_string(),
            );
        }

        if !error_messages.is_empty() {
            let combined_error = error_messages.join("\n\n");
            failures.push(MetadataReadFailure {
                relative_path: rel_path.clone(),
                error_message: combined_error,
            });
        } else {
            let display_values = display_pass
                .values_by_source
                .remove(&key)
                .unwrap_or_default();
            let raw_values = raw_pass.values_by_source.remove(&key).unwrap_or_default();

            let occurrences = canonical_occurrences_from_exiftool_pair(
                &raw_values,
                &display_values,
                registry,
                rel_path,
                Some(batch_warnings),
            );

            let occurrences = match occurrences {
                Ok(occurrences) => occurrences,
                Err(error) => {
                    failures.push(MetadataReadFailure {
                        relative_path: rel_path.clone(),
                        error_message: format!("Metadata canonicalisation failed:\n{error}"),
                    });
                    continue;
                }
            };

            let metadata = match project_occurrences_to_legacy_metadata(occurrences) {
                Ok(metadata) => metadata,
                Err(error) => {
                    failures.push(MetadataReadFailure {
                        relative_path: rel_path.clone(),
                        error_message: format!("Legacy schema projection failed:\n{error}"),
                    });
                    continue;
                }
            };

            results.push(ImageMetadata {
                relative_path: rel_path.clone(),
                metadata: metadata_entries(metadata),
            });
        }
    }

    Ok(MetadataBatchReadOutcome { results, failures })
}

pub(crate) fn group_metadata_failures(
    failures: &[MetadataReadFailure],
) -> BTreeMap<String, Vec<String>> {
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for fail in failures {
        grouped
            .entry(fail.error_message.clone())
            .or_default()
            .push(fail.relative_path.clone());
    }
    grouped
}

#[cfg(test)]
fn parse_exiftool_pass_json_raw(json: &str) -> HashMap<String, HashMap<String, serde_json::Value>> {
    parse_exiftool_pass_json_raw_with_registry(json, crate::tag_schema::get_registry().ok())
}

#[cfg(test)]
fn parse_exiftool_pass_json_raw_with_registry(
    json: &str,
    registry: Option<&TagRegistry>,
) -> HashMap<String, HashMap<String, serde_json::Value>> {
    let Ok(json) = complete_test_runtime_json(json) else {
        return HashMap::new();
    };
    try_parse_exiftool_pass_json_raw_with_registry(&json, registry)
        .unwrap_or_else(|_| ExifToolPassOutput {
            values_by_source: HashMap::new(),
            failures_by_source: HashMap::new(),
        })
        .values_by_source
        .into_iter()
        .map(|(source, properties)| {
            let values = properties
                .into_values()
                .map(|property| {
                    let name = if property.group1 == "TestFixture" {
                        property.tag_name
                    } else {
                        property.friendly_name
                    };
                    (name, property.runtime.value)
                })
                .collect();
            (source, values)
        })
        .collect()
}

#[cfg(test)]
fn test_runtime_property_name(
    group1: &str,
    document: &str,
    copy: &str,
    path: &str,
    family7_tag_id: &str,
    tag_name: &str,
) -> String {
    format!("{group1}:{document}:{copy}:{path}:ID-{family7_tag_id}:{tag_name}")
}

#[cfg(test)]
fn complete_test_runtime_json(json: &str) -> Result<String, serde_json::Error> {
    let mut entries: serde_json::Value = serde_json::from_str(json)?;
    let Some(entries) = entries.as_array_mut() else {
        return serde_json::to_string(&entries);
    };
    for entry in entries.iter_mut() {
        let Some(object) = entry.as_object_mut() else {
            continue;
        };
        let old = std::mem::take(object);
        for (key, value) in old {
            if key == "SourceFile" || key.splitn(6, ':').count() == 6 {
                object.insert(key, value);
                continue;
            }
            let (group1, tag_name) = key
                .split_once(':')
                .map_or(("TestFixture", key.as_str()), |parts| parts);
            let path = match group1 {
                "IFD0" | "IFD1" => format!("JPEG-APP1-{group1}"),
                "ExifIFD" => "JPEG-APP1-IFD0-ExifIFD".to_string(),
                "GPS" => "JPEG-APP1-IFD0-GPS".to_string(),
                "IPTC" => "JPEG-APP13-Photoshop-IPTC".to_string(),
                group if group.starts_with("XMP-") => "XMP".to_string(),
                group => format!("TestFixture-{group}"),
            };
            let runtime_id = value
                .get("id")
                .map(|id| {
                    id.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| id.to_string())
                })
                .unwrap_or_else(|| tag_name.to_string());
            let complete_key =
                test_runtime_property_name(group1, "Main", "Copy0", &path, &runtime_id, tag_name);
            object.insert(complete_key, value);
        }
    }
    serde_json::to_string(&entries)
}

#[derive(Debug, Clone)]
struct ParseWarning {
    pub rel_path: String,
    pub tag: String,
    pub pass_name: String,
    pub expected: String,
    pub raw_type: &'static str,
    pub raw: serde_json::Value,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ParseWarningCategory {
    MissingSchema,
    UnknownSchemaKind,
    ParseFailed,
}

fn classify_warning(reason: &str) -> ParseWarningCategory {
    if reason == "no schema entry for tag" {
        ParseWarningCategory::MissingSchema
    } else if reason == "schema kind is unknown" {
        ParseWarningCategory::UnknownSchemaKind
    } else {
        ParseWarningCategory::ParseFailed
    }
}

fn log_single_warning(w: &ParseWarning) {
    let category = classify_warning(&w.reason);
    match category {
        ParseWarningCategory::MissingSchema | ParseWarningCategory::UnknownSchemaKind => {
            log::warn!(
                "[parse_exiftool] Schema gap: file={} tag={} pass={} raw_type={} raw={} reason={}",
                w.rel_path,
                w.tag,
                w.pass_name,
                w.raw_type,
                json_preview(&w.raw),
                w.reason
            );
        }
        ParseWarningCategory::ParseFailed => {
            log::warn!(
                "[parse_exiftool] Unparsed metadata: file={} tag={} pass={} expected={} raw_type={} raw={} reason={}",
                w.rel_path,
                w.tag,
                w.pass_name,
                w.expected,
                w.raw_type,
                json_preview(&w.raw),
                w.reason
            );
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct WarningGroupKey {
    tag: String,
    reason: String,
    expected_summary: String,
    raw_type: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WarningGroupValue {
    count: usize,
    examples: Vec<String>,
    raw_preview: Option<String>,
}

fn group_parse_warnings(warnings: &[ParseWarning]) -> BTreeMap<WarningGroupKey, WarningGroupValue> {
    let mut groups: BTreeMap<WarningGroupKey, WarningGroupValue> = BTreeMap::new();
    for w in warnings {
        let key = WarningGroupKey {
            tag: w.tag.clone(),
            reason: w.reason.clone(),
            expected_summary: w.expected.clone(),
            raw_type: w.raw_type,
        };
        let entry = groups.entry(key).or_insert_with(|| WarningGroupValue {
            count: 0,
            examples: Vec::new(),
            raw_preview: None,
        });
        entry.count += 1;
        if entry.examples.len() < 2 && !entry.examples.contains(&w.rel_path) {
            entry.examples.push(w.rel_path.clone());
        }
        if entry.raw_preview.is_none() {
            entry.raw_preview = Some(json_preview(&w.raw));
        }
    }
    groups
}

fn log_aggregated_warnings(warnings: &[ParseWarning]) {
    for w in warnings {
        log::debug!(
            "[parse_exiftool] Unparsed metadata debug: file={} tag={} pass={} expected={} raw_type={} raw={} reason={}",
            w.rel_path,
            w.tag,
            w.pass_name,
            w.expected,
            w.raw_type,
            json_preview(&w.raw),
            w.reason
        );
    }

    let groups = group_parse_warnings(warnings);

    for (key, val) in groups {
        let category = classify_warning(&key.reason);
        match category {
            ParseWarningCategory::MissingSchema | ParseWarningCategory::UnknownSchemaKind => {
                log::warn!(
                    "[parse_exiftool] Schema gap summary: count={} tag={} raw_type={} reason={} examples={:?} raw_example={}",
                    val.count,
                    key.tag,
                    key.raw_type,
                    key.reason,
                    val.examples,
                    val.raw_preview.as_deref().unwrap_or("")
                );
            }
            ParseWarningCategory::ParseFailed => {
                log::warn!(
                    "[parse_exiftool] Unparsed metadata summary: count={} tag={} expected={} raw_type={} reason={} examples={:?} raw_example={}",
                    val.count,
                    key.tag,
                    key.expected_summary,
                    key.raw_type,
                    key.reason,
                    val.examples,
                    val.raw_preview.as_deref().unwrap_or("")
                );
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct CanonicalRuntimeOccurrence {
    // These three identities answer different questions and must stay
    // independent: the occurrence ID identifies the runtime value, TagInfo::id
    // identifies its static schema, and the write target identifies the
    // supported ExifTool selector.
    occurrence: MetadataOccurrence,
    /// Temporary exact schema identity used by the legacy schema-keyed
    /// projection, including unresolved schemas where `occurrence.tag_info`
    /// is `None`.
    projection_schema_id: SchemaDefinitionId,
    friendly_name: String,
    runtime_group1: String,
    runtime_tag_name: String,
    language: Option<String>,
    is_lang_alt: bool,
}

fn selector_component_is_safe(component: &str, reject_colon: bool) -> bool {
    !component.is_empty()
        && !component.chars().any(|character| {
            matches!(character, '\0' | '\r' | '\n' | '=') || reject_colon && character == ':'
        })
}

fn assign_exact_write_targets(occurrences: &mut [CanonicalRuntimeOccurrence]) {
    let mut selector_counts = BTreeMap::new();
    for occurrence in occurrences.iter() {
        *selector_counts
            .entry((
                occurrence.runtime_group1.to_ascii_lowercase(),
                occurrence.runtime_tag_name.to_ascii_lowercase(),
            ))
            .or_insert(0usize) += 1;
    }

    for canonical in occurrences {
        canonical.occurrence.write_target = None;
        let selector_key = (
            canonical.runtime_group1.to_ascii_lowercase(),
            canonical.runtime_tag_name.to_ascii_lowercase(),
        );
        let Some(tag_info) = canonical.occurrence.tag_info.as_ref() else {
            continue;
        };
        if !tag_info.writable
            || matches!(tag_info.kind, TagKind::Binary | TagKind::Unknown)
            || canonical.occurrence.id.document.is_some()
            || canonical.occurrence.id.copy != 0
            || canonical.is_lang_alt
            || canonical.language.is_some()
            || canonical.runtime_tag_name != tag_info.name
            || !selector_component_is_safe(&canonical.runtime_group1, false)
            || !selector_component_is_safe(&canonical.runtime_tag_name, true)
            || selector_counts.get(&selector_key) != Some(&1)
        {
            continue;
        }

        // Runtime family 1 and the validated runtime tag name are the only
        // write coordinates. Schema table/ID/index and TagInfo::group are not
        // occurrence destinations.
        canonical.occurrence.write_target = Some(MetadataWriteTarget {
            group1: canonical.runtime_group1.clone(),
            tag_name: canonical.runtime_tag_name.clone(),
        });
    }
}

fn canonical_occurrences_from_exiftool_pair(
    raw_values: &RuntimeMap,
    display_values: &RuntimeMap,
    registry: Option<&TagRegistry>,
    rel_path: &str,
    mut warnings_accumulator: Option<&mut Vec<ParseWarning>>,
) -> Result<Vec<CanonicalRuntimeOccurrence>, String> {
    let mut values = Vec::new();
    let occurrence_ids: BTreeSet<_> = raw_values
        .keys()
        .chain(display_values.keys())
        .cloned()
        .collect();

    for occurrence_id in occurrence_ids {
        let raw_property = raw_values.get(&occurrence_id);
        let display_property = display_values.get(&occurrence_id);
        let property = raw_property
            .or(display_property)
            .expect("key came from one of the source maps");
        if raw_property.is_none() || display_property.is_none() {
            log::warn!(
                "[parse_exiftool] pass mismatch: file={} occurrence_id={occurrence_id:?} raw_friendly_name={:?} pretty_friendly_name={:?} raw_schema_id={:?} pretty_schema_id={:?} missing={}",
                rel_path,
                raw_property.map(|p| p.friendly_name.as_str()),
                display_property.map(|p| p.friendly_name.as_str()),
                raw_property.map(|p| &p.schema_id),
                display_property.map(|p| &p.schema_id),
                if raw_property.is_none() { "raw" } else { "pretty" }
            );
        }
        if let (Some(raw), Some(pretty)) = (raw_property, display_property) {
            let conflict = if raw.schema_id != pretty.schema_id {
                Some("schema identity")
            } else if raw.group1 != pretty.group1 || raw.tag_name != pretty.tag_name {
                Some("family-1 group or tag name")
            } else if raw.friendly_name != pretty.friendly_name {
                Some("canonical friendly name")
            } else if raw.runtime.language != pretty.runtime.language {
                Some("language")
            } else {
                None
            };
            if let Some(conflict) = conflict {
                return Err(format!(
                    "pretty/raw extraction disagrees on {conflict} for occurrence ID {occurrence_id:#?}\nraw: schema={raw_schema:#?} friendly={raw_name:?} group1={raw_group:?} tag_name={raw_tag:?} language={raw_language:?}\npretty: schema={pretty_schema:#?} friendly={pretty_name:?} group1={pretty_group:?} tag_name={pretty_tag:?} language={pretty_language:?}",
                    raw_schema = raw.schema_id,
                    raw_name = raw.friendly_name,
                    raw_group = raw.group1,
                    raw_tag = raw.tag_name,
                    raw_language = raw.runtime.language,
                    pretty_schema = pretty.schema_id,
                    pretty_name = pretty.friendly_name,
                    pretty_group = pretty.group1,
                    pretty_tag = pretty.tag_name,
                    pretty_language = pretty.runtime.language,
                ));
            }
        }
        let (id, info, language) = resolve_schema_identity(property, registry);
        let primary = &raw_property.unwrap_or(property).runtime.value;
        let display_hint = display_property.map(|p| &p.runtime.value);
        if let (Some(language), Some(info)) = (language, info) {
            if matches!(info.kind, TagKind::LangAlt) {
                let text = primary
                    .as_str()
                    .or_else(|| display_hint.and_then(serde_json::Value::as_str))
                    .unwrap_or_default()
                    .to_string();
                values.push(CanonicalRuntimeOccurrence {
                    occurrence: MetadataOccurrence {
                        id: occurrence_id,
                        value: MetadataValue::LangAlt(BTreeMap::from([(language.clone(), text)])),
                        tag_info: Some(info.clone()),
                        // Family-1 inputs are captured, but exact eligibility and
                        // ambiguity checks for write targets are intentionally deferred.
                        write_target: None,
                    },
                    projection_schema_id: id,
                    friendly_name: property.friendly_name.clone(),
                    runtime_group1: property.group1.clone(),
                    runtime_tag_name: property.tag_name.clone(),
                    language: Some(language),
                    is_lang_alt: true,
                });
                continue;
            }
        }
        let value = parse_metadata_value(
            &property.friendly_name,
            info.map(|i| &i.kind),
            primary,
            display_hint,
        );
        warn_unknown_metadata_value(
            rel_path,
            &format!("{id:?} ({})", property.friendly_name),
            "canonical",
            primary,
            info,
            &value,
            warnings_accumulator.as_deref_mut(),
        );
        values.push(CanonicalRuntimeOccurrence {
            occurrence: MetadataOccurrence {
                id: occurrence_id,
                value,
                tag_info: info.cloned(),
                // Family-1 inputs are captured, but exact eligibility and
                // ambiguity checks for write targets are intentionally deferred.
                write_target: None,
            },
            projection_schema_id: id,
            friendly_name: property.friendly_name.clone(),
            runtime_group1: property.group1.clone(),
            runtime_tag_name: property.tag_name.clone(),
            language: None,
            is_lang_alt: false,
        });
    }

    assign_exact_write_targets(&mut values);
    Ok(values)
}

fn project_occurrences_to_legacy_metadata(
    mut occurrences: Vec<CanonicalRuntimeOccurrence>,
) -> Result<MetadataMap, String> {
    // Deliberate migration scaffolding: application consumers are still keyed
    // by schema identity, so occurrence values must temporarily be projected.
    // Runtime LangAlt children remain distinct occurrences even though this
    // legacy projection merges their semantic values under the parent schema.
    let mut values = MetadataMap::new();
    let mut origins: BTreeMap<SchemaDefinitionId, CanonicalRuntimeOccurrence> = BTreeMap::new();
    occurrences.sort_by(|left, right| left.occurrence.id.cmp(&right.occurrence.id));

    for occurrence in occurrences {
        if occurrence.is_lang_alt {
            let language = occurrence.language.as_deref().ok_or_else(|| {
                format!(
                    "LangAlt occurrence {:?} ({}) has no language",
                    occurrence.occurrence.id, occurrence.friendly_name
                )
            })?;
            match values.entry(occurrence.projection_schema_id.clone()) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(occurrence.occurrence.value.clone());
                    origins.insert(occurrence.projection_schema_id.clone(), occurrence);
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    if let (MetadataValue::LangAlt(existing), MetadataValue::LangAlt(incoming)) =
                        (entry.get_mut(), &occurrence.occurrence.value)
                    {
                        existing.extend(incoming.clone());
                    } else {
                        let previous = origins
                            .get(&occurrence.projection_schema_id)
                            .expect("legacy projection records every inserted origin");
                        return Err(format!(
                            "legacy schema projection cannot mix LangAlt language {language:?} from occurrence {current:#?} with ordinary occurrence {previous_id:#?} for {schema:#?}",
                            current = occurrence.occurrence.id,
                            previous_id = previous.occurrence.id,
                            schema = occurrence.projection_schema_id,
                        ));
                    }
                }
            }
            continue;
        }

        match values.entry(occurrence.projection_schema_id.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(occurrence.occurrence.value.clone());
                origins.insert(occurrence.projection_schema_id.clone(), occurrence);
            }
            std::collections::btree_map::Entry::Occupied(entry) => {
                let previous = origins
                    .get(&occurrence.projection_schema_id)
                    .expect("legacy projection records every inserted origin");
                if entry.get() == &occurrence.occurrence.value {
                    log::warn!(
                        "multiple runtime occurrences projected to one legacy schema entry: schema_id={:?} occurrence_ids={:?}, {:?}",
                        occurrence.projection_schema_id,
                        previous.occurrence.id,
                        occurrence.occurrence.id
                    );
                } else {
                    return Err(format!(
                        "legacy schema projection cannot represent multiple runtime occurrences for {schema:#?}:\n{first_occurrence:#?} {first_name} = {first_value:?}\n{second_occurrence:#?} {second_name} = {second_value:?}",
                        schema = occurrence.projection_schema_id,
                        first_occurrence = previous.occurrence.id,
                        first_name = previous.friendly_name,
                        first_value = previous.occurrence.value,
                        second_occurrence = occurrence.occurrence.id,
                        second_name = occurrence.friendly_name,
                        second_value = occurrence.occurrence.value,
                    ));
                }
            }
        }
    }
    Ok(values)
}

#[cfg(test)]
fn canonical_values_from_exiftool_pair_exact(
    raw_values: &RuntimeMap,
    display_values: &RuntimeMap,
    registry: Option<&TagRegistry>,
    rel_path: &str,
    warnings_accumulator: Option<&mut Vec<ParseWarning>>,
) -> Result<MetadataMap, String> {
    let occurrences = canonical_occurrences_from_exiftool_pair(
        raw_values,
        display_values,
        registry,
        rel_path,
        warnings_accumulator,
    )?;
    project_occurrences_to_legacy_metadata(occurrences)
}

#[cfg(test)]
fn canonical_values_from_exiftool_pair(
    raw_values: &HashMap<String, serde_json::Value>,
    display_values: &HashMap<String, serde_json::Value>,
    registry: Option<&TagRegistry>,
    rel_path: &str,
    warnings: Option<&mut Vec<ParseWarning>>,
) -> HashMap<String, MetadataValue> {
    fn runtime(
        values: &HashMap<String, serde_json::Value>,
        registry: Option<&TagRegistry>,
    ) -> RuntimeMap {
        values
            .iter()
            .map(|(name, value)| {
                let id = registry
                    .and_then(|registry| {
                        registry
                            .iter()
                            .find(|(_, info)| info.display_name() == *name)
                            .map(|(_, info)| info)
                    })
                    .map(|info| info.id.clone())
                    .unwrap_or_else(|| SchemaDefinitionId {
                        table: "TestFixture::Unknown".into(),
                        tag_id: name.clone(),
                        index: None,
                    });
                let occurrence_id = MetadataOccurrenceId {
                    document: None,
                    path: "TestFixture".into(),
                    tag_id: id.tag_id.clone(),
                    copy: 0,
                };
                (
                    occurrence_id.clone(),
                    RuntimeProperty {
                        occurrence_id,
                        schema_id: id.clone(),
                        group1: name
                            .split_once(':')
                            .map_or("TestFixture", |(group, _)| group)
                            .into(),
                        tag_name: name
                            .split_once(':')
                            .map_or(name.as_str(), |(_, tag)| tag)
                            .into(),
                        friendly_name: name.clone(),
                        runtime: ExifToolRuntimeValue {
                            table: id.table.clone(),
                            tag_id: id.tag_id.clone(),
                            index: id.index,
                            language: None,
                            value: value.clone(),
                        },
                    },
                )
            })
            .collect()
    }
    canonical_values_from_exiftool_pair_exact(
        &runtime(raw_values, registry),
        &runtime(display_values, registry),
        registry,
        rel_path,
        warnings,
    )
    .expect("test fixture canonicalisation")
    .into_iter()
    .map(|(id, value)| {
        let name = registry
            .and_then(|registry| registry.lookup(&id))
            .map(|info| info.display_name())
            .unwrap_or(id.tag_id);
        (name, value)
    })
    .collect()
}

fn resolve_schema_identity<'a>(
    property: &RuntimeProperty,
    registry: Option<&'a TagRegistry>,
) -> (
    SchemaDefinitionId,
    Option<&'a crate::tag_schema::TagInfo>,
    Option<String>,
) {
    let Some(registry) = registry else {
        return (property.schema_id.clone(), None, None);
    };
    let schema_candidate = &property.schema_id;
    if let Some(info) = registry.lookup(schema_candidate) {
        return (schema_candidate.clone(), Some(info), None);
    }
    let language = property.runtime.language.clone().or_else(|| {
        let (_, suffix) = schema_candidate.tag_id.rsplit_once('-')?;
        is_language_code(suffix).then(|| suffix.to_string())
    });
    let Some(language) = language else {
        return (schema_candidate.clone(), None, None);
    };
    let suffix = format!("-{language}");
    let Some(base_tag_id) = schema_candidate.tag_id.strip_suffix(&suffix) else {
        return (schema_candidate.clone(), None, None);
    };
    let base_id = SchemaDefinitionId {
        table: schema_candidate.table.clone(),
        tag_id: base_tag_id.to_string(),
        index: schema_candidate.index,
    };
    match registry.lookup(&base_id) {
        Some(info) if matches!(info.kind, TagKind::LangAlt) => {
            (base_id, Some(info), Some(language))
        }
        _ => (schema_candidate.clone(), None, None),
    }
}

fn is_language_code(value: &str) -> bool {
    value == "x-default"
        || matches!(value.len(), 2 | 5)
            && value
                .split('-')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphabetic()))
}

fn warn_unknown_metadata_value(
    rel_path: &str,
    key: &str,
    pass_name: &str,
    raw: &serde_json::Value,
    info: Option<&crate::tag_schema::TagInfo>,
    value: &MetadataValue,
    warnings_accumulator: Option<&mut Vec<ParseWarning>>,
) {
    if let MetadataValue::Unknown {
        expected, reason, ..
    } = value
    {
        let expected_str = expected
            .as_ref()
            .map(tag_kind_summary)
            .or_else(|| info.map(|i| tag_kind_summary(&i.kind)))
            .unwrap_or_else(|| "<no schema>".to_string());
        let reason_str = reason.as_deref().unwrap_or("<unknown>").to_string();

        let warning = ParseWarning {
            rel_path: rel_path.to_string(),
            tag: key.to_string(),
            pass_name: pass_name.to_string(),
            expected: expected_str,
            raw_type: json_value_kind(raw),
            raw: raw.clone(),
            reason: reason_str,
        };

        if let Some(acc) = warnings_accumulator {
            acc.push(warning);
        } else {
            log_single_warning(&warning);
        }
    }
}

fn json_value_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

fn json_preview(value: &serde_json::Value) -> String {
    const MAX_CHARS: usize = 240;
    const ELLIPSIS: &str = "...";
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "<unserializable>".to_string());
    let mut chars = raw.chars();
    let preview: String = chars.by_ref().take(MAX_CHARS - ELLIPSIS.len()).collect();
    if chars.next().is_some() {
        format!("{preview}{ELLIPSIS}")
    } else {
        raw
    }
}

fn tag_kind_summary(kind: &crate::tag_schema::TagKind) -> String {
    use crate::tag_schema::TagKind;

    match kind {
        TagKind::Text => "Text".to_string(),
        TagKind::LangAlt => "LangAlt".to_string(),
        TagKind::Integer { .. } => "Integer".to_string(),
        TagKind::Real => "Real".to_string(),
        TagKind::Rational => "Rational".to_string(),
        TagKind::Boolean => "Boolean".to_string(),
        TagKind::Date => "Date".to_string(),
        TagKind::Time => "Time".to_string(),
        TagKind::DateTime => "DateTime".to_string(),
        TagKind::TimeOffset => "TimeOffset".to_string(),
        TagKind::Enum { repr, options } => format!("Enum({repr:?}, {} options)", options.len()),
        TagKind::Bag(inner) => format!("Bag<{}>", tag_kind_summary(inner)),
        TagKind::Seq(inner) => format!("Seq<{}>", tag_kind_summary(inner)),
        TagKind::Alt(inner) => format!("Alt<{}>", tag_kind_summary(inner)),
        TagKind::Struct(fields) => format!("Struct({} fields)", fields.len()),
        TagKind::Binary => "Binary".to_string(),
        TagKind::Unknown => "Unknown".to_string(),
    }
}

fn is_binary_tag(id: &SchemaDefinitionId, registry: Option<&TagRegistry>) -> bool {
    registry
        .and_then(|r| r.lookup(id))
        .map(|info| matches!(info.kind, crate::tag_schema::TagKind::Binary))
        .unwrap_or(false)
}

/// Match exiftool's literal binary-placeholder string, exactly as emitted
/// in `-j` output: `(Binary data N bytes, use -b option to extract)`.
///
/// Used as a fallback when the schema does not classify the tag — most
/// importantly for the synthetic `File:` group, which `-listx` does not
/// enumerate. The pattern is anchored end-to-end so a free-text tag whose
/// value happens to contain the phrase will not match unless the entire
/// value is the placeholder.
fn is_exiftool_binary_placeholder(val: &serde_json::Value) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"^\(Binary data \d+ bytes, use -b option to extract\)$")
            .expect("static regex must compile")
    });
    val.as_str().is_some_and(|s| re.is_match(s))
}

/// Test helper: takes JSON for one pass, the input paths, and returns canonical
/// `ImageMetadata`. The provided JSON is treated as display/pretty hints.
#[cfg(test)]
fn parse_exiftool_batch_json(
    json: &str,
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
) -> Vec<ImageMetadata> {
    let registry = crate::tag_schema::get_registry().ok();
    let mut map_by_source = complete_test_runtime_json(json)
        .ok()
        .and_then(|json| try_parse_exiftool_pass_json_raw_with_registry(&json, registry).ok())
        .unwrap_or_default();
    let mut results = Vec::with_capacity(rel_paths.len());
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let normalized_abs = abs_path.to_string_lossy().replace('\\', "/");
        let display_values = map_by_source
            .values_by_source
            .remove(&normalized_abs)
            .unwrap_or_else(|| {
                log::warn!(
                    "[parse_exiftool] Warning: No metadata found for path: {}",
                    normalized_abs
                );
                BTreeMap::new()
            });
        let metadata = canonical_values_from_exiftool_pair_exact(
            &BTreeMap::new(),
            &display_values,
            registry,
            rel_path,
            None,
        )
        .unwrap_or_default();
        results.push(ImageMetadata {
            relative_path: rel_path.clone(),
            metadata: metadata_entries(metadata),
        });
    }
    results
}

/// Generate a base64-encoded JPEG thumbnail for the image at `path`.
///
/// Strategy:
/// 1. Try to extract an embedded EXIF thumbnail. If its largest dimension
///    is >= 160 px, use it as-is (fast path, ~10-50 ms).
/// 2. Otherwise, full-decode the image and resize so the largest dimension
///    is 160 px (slow path, ~100-500 ms release, 2-4 s debug).
pub fn thumbnail_for(path: &Path) -> Option<String> {
    // TEMPORARY: simulate slow thumbnail generation for load testing.
    #[cfg(not(test))]
    if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }

    // Try fast path: extract embedded thumbnail from EXIF
    if let Some(thumb) = extract_exif_thumbnail(path) {
        return Some(thumb);
    }

    // Fall back to full decode
    full_decode_thumbnail(path)
}

/// Try to extract an embedded EXIF thumbnail (very fast).
///
/// Returns `Some` only when the embedded thumbnail's largest dimension is
/// >= 160 px — in that case we return it as-is without re-encoding.
fn extract_exif_thumbnail(path: &Path) -> Option<String> {
    use std::fs::File;
    use std::io::{BufReader, Read};

    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);

    // Parse EXIF data
    let exif_reader = exif::Reader::new();
    let exif = match exif_reader.read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return None,
    };

    // Look for thumbnail in EXIF data
    let offset_field = exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?;
    let length_field =
        exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?;

    if let (exif::Value::Long(offsets), exif::Value::Long(lengths)) =
        (&offset_field.value, &length_field.value)
    {
        if let (Some(&offset), Some(&length)) = (offsets.first(), lengths.first()) {
            // Re-open file to read the entire file and find TIFF header
            let mut file = File::open(path).ok()?;
            let mut file_data = Vec::new();
            file.read_to_end(&mut file_data).ok()?;

            // Find the TIFF header in the JPEG file
            // JPEG structure: FF D8 (SOI) ... FF E1 XX XX "Exif\0\0" [TIFF header starts here]
            let tiff_offset = find_tiff_offset(&file_data)?;

            // The thumbnail offset is relative to the TIFF header
            let absolute_offset = tiff_offset + offset as usize;

            if absolute_offset + length as usize > file_data.len() {
                return None;
            }

            let thumbnail_bytes = &file_data[absolute_offset..absolute_offset + length as usize];

            // Check if it's a valid JPEG (starts with 0xFF 0xD8)
            if thumbnail_bytes.len() > 2 && thumbnail_bytes[0] == 0xFF && thumbnail_bytes[1] == 0xD8
            {
                // Decode just enough to check dimensions
                if let Ok(img) = image::load_from_memory(thumbnail_bytes) {
                    let largest = img.width().max(img.height());
                    if largest >= 160 {
                        // Embedded thumbnail is large enough — use as-is
                        return Some(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            thumbnail_bytes,
                        ));
                    }
                    // Embedded thumbnail is too small; fall through to full decode
                }
            }
        }
    }

    None
}

/// Find the offset of the TIFF header within a JPEG file.
/// JPEG structure: FF D8 (SOI) ... FF E1 XX XX "Exif\0\0" [TIFF header]
fn find_tiff_offset(data: &[u8]) -> Option<usize> {
    // Look for EXIF marker: FF E1
    for i in 0..data.len().saturating_sub(10) {
        if data[i] == 0xFF && data[i + 1] == 0xE1 {
            // Check for "Exif\0\0" identifier
            if i + 10 < data.len()
                && data[i + 4] == b'E'
                && data[i + 5] == b'x'
                && data[i + 6] == b'i'
                && data[i + 7] == b'f'
                && data[i + 8] == 0
                && data[i + 9] == 0
            {
                // TIFF header starts right after "Exif\0\0"
                return Some(i + 10);
            }
        }
    }
    None
}

fn full_decode_thumbnail(path: &Path) -> Option<String> {
    let img = image::open(path).ok()?;
    let thumb = img.thumbnail(160, 160);
    let mut buf = Vec::new();
    thumb
        .write_to(
            &mut std::io::Cursor::new(&mut buf),
            image::ImageFormat::Jpeg,
        )
        .ok()?;
    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &buf,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn test_schema_id(table: &str, tag_id: &str, index: Option<u32>) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: table.into(),
            tag_id: tag_id.into(),
            index,
        }
    }

    fn test_occurrence_id(path: &str, tag_id: &str) -> MetadataOccurrenceId {
        MetadataOccurrenceId {
            document: None,
            path: path.into(),
            tag_id: tag_id.into(),
            copy: 0,
        }
    }

    fn test_runtime_property(
        occurrence_id: MetadataOccurrenceId,
        schema_id: SchemaDefinitionId,
        group1: &str,
        tag_name: &str,
        language: Option<&str>,
        value: serde_json::Value,
    ) -> RuntimeProperty {
        RuntimeProperty {
            occurrence_id,
            schema_id: schema_id.clone(),
            group1: group1.into(),
            tag_name: tag_name.into(),
            friendly_name: format!("{group1}:{tag_name}"),
            runtime: ExifToolRuntimeValue {
                table: schema_id.table,
                tag_id: schema_id.tag_id,
                index: schema_id.index,
                language: language.map(str::to_owned),
                value,
            },
        }
    }

    fn runtime_map(properties: Vec<RuntimeProperty>) -> RuntimeMap {
        properties
            .into_iter()
            .map(|property| (property.occurrence_id.clone(), property))
            .collect()
    }

    fn write_target_test_info(writable: bool, kind: TagKind) -> crate::tag_schema::TagInfo {
        crate::tag_schema::TagInfo {
            id: test_schema_id("Exif::Main", "282", None),
            group: "IFD0".into(),
            name: "XResolution".into(),
            writable,
            kind,
            description: Some("X resolution".into()),
            storage_count: None,
        }
    }

    fn write_target_test_occurrence(
        group1: &str,
        tag_name: &str,
        path: &str,
        copy: u32,
        document: Option<&str>,
        tag_info: Option<crate::tag_schema::TagInfo>,
        value: MetadataValue,
    ) -> CanonicalRuntimeOccurrence {
        let projection_schema_id = tag_info
            .as_ref()
            .map(|info| info.id.clone())
            .unwrap_or_else(|| test_schema_id("Unknown::Table", tag_name, None));
        CanonicalRuntimeOccurrence {
            occurrence: MetadataOccurrence {
                id: MetadataOccurrenceId {
                    document: document.map(str::to_owned),
                    path: path.into(),
                    tag_id: "282".into(),
                    copy,
                },
                value,
                tag_info,
                write_target: None,
            },
            projection_schema_id,
            friendly_name: format!("{group1}:{tag_name}"),
            runtime_group1: group1.into(),
            runtime_tag_name: tag_name.into(),
            language: None,
            is_lang_alt: false,
        }
    }

    fn collect(folder: &Path) -> Vec<PhotoInfo> {
        let mut photos = Vec::new();
        scan_folder(
            folder,
            Arc::new(AtomicBool::new(false)),
            |p| photos.push(p),
            |_| {},
        );
        photos.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        photos
    }

    #[test]
    fn exiftool_read_arguments_match_between_passes_except_numeric_flag() {
        let display = exiftool_read_args(false);
        let raw = exiftool_read_args(true);

        assert_eq!(
            display.iter().filter(|arg| **arg == "-G:1:3:4:5:7").count(),
            1
        );
        assert_eq!(raw.iter().filter(|arg| **arg == "-G:1:3:4:5:7").count(), 1);
        assert!(!display.contains(&"-n"));
        assert_eq!(raw.iter().filter(|arg| **arg == "-n").count(), 1);
        assert_eq!(&raw[..display.len()], display.as_slice());
        for required in ["-a", "-struct", "-t", "-D", "-j"] {
            assert!(display.contains(&required));
            assert!(raw.contains(&required));
        }
        assert!(!display.contains(&"-G1"));
        assert!(!raw.contains(&"-G1"));
    }

    #[test]
    fn runtime_property_key_parses_occurrence_coordinates_and_friendly_name() {
        let primary =
            parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution")
                .unwrap();
        assert_eq!(
            primary.occurrence_id,
            MetadataOccurrenceId {
                document: None,
                path: "JPEG-APP1-IFD0".into(),
                tag_id: "282".into(),
                copy: 0,
            }
        );
        assert_eq!(primary.group1, "IFD0");
        assert_eq!(primary.tag_name, "XResolution");
        assert_eq!(primary.friendly_name(), "IFD0:XResolution");

        let observed_primary =
            parse_runtime_property_key("IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution").unwrap();
        assert_eq!(observed_primary.occurrence_id, primary.occurrence_id);

        let doc1 = parse_runtime_property_key("IFD0:Doc1:Copy0:JPEG-APP1-IFD0:ID-282:XResolution")
            .unwrap();
        assert_eq!(doc1.occurrence_id.document.as_deref(), Some("Doc1"));
        let nested =
            parse_runtime_property_key("Track1:Doc2-3:Copy0:QuickTime-Movie:ID-AbC:Tag").unwrap();
        assert_eq!(nested.occurrence_id.document.as_deref(), Some("Doc2-3"));
        assert_eq!(nested.occurrence_id.tag_id, "AbC");

        let copy1 = parse_runtime_property_key("IFD0:Main:Copy1:JPEG-APP1-IFD0:ID-282:XResolution")
            .unwrap();
        assert_ne!(copy1.occurrence_id, primary.occurrence_id);
        assert_eq!(copy1.occurrence_id.copy, 1);

        let ifd1 = parse_runtime_property_key("IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution")
            .unwrap();
        assert_ne!(ifd1.occurrence_id, primary.occurrence_id);
        let other_id =
            parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-283:XResolution")
                .unwrap();
        assert_ne!(other_id.occurrence_id, primary.occurrence_id);

        let prefixed =
            parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-ID-AbC:Tag:With:Colons")
                .unwrap();
        assert_eq!(prefixed.occurrence_id.tag_id, "ID-AbC");
        assert_eq!(prefixed.tag_name, "Tag:With:Colons");
    }

    #[test]
    fn runtime_property_key_rejects_malformed_coordinates() {
        for malformed in [
            "IFD0:Main:Copy0::ID-282:XResolution",
            "IFD0:Main:Copy0:JPEG-APP1-IFD0::XResolution",
            "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-:XResolution",
            "IFD0:Main:CopyX:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy-1:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy+1:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy00:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy4294967296:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:JPEG-APP1-IFD0:ID-282:XResolution",
        ] {
            assert!(
                parse_runtime_property_key(malformed).is_err(),
                "accepted malformed property key {malformed}"
            );
        }
    }

    #[test]
    fn parsed_source_property_keeps_runtime_and_schema_identity_separate() {
        let key = test_runtime_property_name(
            "IFD0",
            "Main",
            "Copy0",
            "JPEG-APP1-IFD0",
            "runtime-AbC",
            "XResolution",
        );
        let object = serde_json::json!({
            key: {
                "table": "Exif::Main",
                "id": "282",
                "index": 7,
                "lang": "en",
                "val": 300
            }
        })
        .as_object()
        .unwrap()
        .clone();

        let parsed = parse_single_source_object(object, None).unwrap();
        let schema_id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "282".into(),
            index: Some(7),
        };
        let occurrence_id = MetadataOccurrenceId {
            document: None,
            path: "JPEG-APP1-IFD0".into(),
            tag_id: "runtime-AbC".into(),
            copy: 0,
        };
        let property = parsed.get(&occurrence_id).unwrap();
        assert_eq!(property.schema_id, schema_id);
        assert_eq!(property.occurrence_id.tag_id, "runtime-AbC");
        assert_eq!(property.group1, "IFD0");
        assert_eq!(property.tag_name, "XResolution");
        assert_eq!(property.friendly_name, "IFD0:XResolution");
        assert_eq!(property.runtime.table, "Exif::Main");
        assert_eq!(property.runtime.tag_id, "282");
        assert_eq!(property.runtime.index, Some(7));
        assert_eq!(property.runtime.language.as_deref(), Some("en"));
        assert_eq!(property.runtime.value, serde_json::json!(300));
    }

    #[test]
    fn parser_keeps_ifd0_and_ifd1_occurrences_with_one_schema_identity() {
        let ifd0_key = "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution";
        let ifd1_key = "IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution";
        let object = serde_json::json!({
            ifd0_key: {"table":"Exif::Main","id":"282","val":300},
            ifd1_key: {"table":"Exif::Main","id":"282","val":72}
        })
        .as_object()
        .unwrap()
        .clone();

        let parsed = parse_single_source_object(object, None).unwrap();
        let ifd0 = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let ifd1 = test_occurrence_id("JPEG-APP1-IFD1", "282");
        assert_eq!(parsed.len(), 2);
        assert!(parsed.contains_key(&ifd0));
        assert!(parsed.contains_key(&ifd1));
        assert_ne!(ifd0, ifd1);
        assert_eq!(parsed[&ifd0].schema_id, parsed[&ifd1].schema_id);
        assert_ne!(parsed[&ifd0].runtime.value, parsed[&ifd1].runtime.value);

        let identical = serde_json::json!({
            ifd0_key: {"table":"Exif::Main","id":"282","val":300},
            ifd1_key: {"table":"Exif::Main","id":"282","val":300}
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(
            parse_single_source_object(identical, None).unwrap().len(),
            2
        );
    }

    #[test]
    fn parser_deduplicates_only_identical_repeated_occurrence_ids() {
        let primary = "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution";
        let explicit = "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution";
        let identical = serde_json::json!({
            primary: {"table":"Exif::Main","id":"282","lang":"en","val":300},
            explicit: {"table":"Exif::Main","id":"282","lang":"en","val":300}
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(
            parse_single_source_object(identical, None).unwrap().len(),
            1
        );

        for (second, expected) in [
            (
                serde_json::json!({"table":"Exif::Main","id":"282","lang":"en","val":72}),
                "different value",
            ),
            (
                serde_json::json!({"table":"Exif::Other","id":"282","lang":"en","val":300}),
                "different schema identity",
            ),
            (
                serde_json::json!({"table":"Exif::Main","id":"282","lang":"fr","val":300}),
                "different language",
            ),
        ] {
            let object = serde_json::json!({
                primary: {"table":"Exif::Main","id":"282","lang":"en","val":300},
                explicit: second
            })
            .as_object()
            .unwrap()
            .clone();
            let error = parse_single_source_object(object, None).unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
            assert!(error.contains("Exif::Main"));
            assert!(error.contains("IFD0:XResolution"));
            assert!(error.contains("value="));
        }

        let renamed = serde_json::json!({
            primary: {"table":"Exif::Main","id":"282","val":300},
            "Alias:Main:Copy0:JPEG-APP1-IFD0:ID-282:ResolutionAlias": {"table":"Exif::Main","id":"282","val":300}
        })
        .as_object()
        .unwrap()
        .clone();
        let error = parse_single_source_object(renamed, None).unwrap_err();
        assert!(error.contains("different family-1 group or tag name"));
        assert!(error.contains("IFD0:XResolution"));
        assert!(error.contains("Alias:ResolutionAlias"));
    }

    #[test]
    fn malformed_runtime_property_is_a_source_specific_failure() {
        let json = r#"[
            {"SourceFile":"D:/bad.jpg","IFD0:broken":{"table":"Exif::Main","id":"282","val":300}},
            {"SourceFile":"D:/good.jpg","IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":300}}
        ]"#;
        let parsed = try_parse_exiftool_pass_json_raw(json).unwrap();
        assert!(parsed.failures_by_source.contains_key("D:/bad.jpg"));
        assert!(parsed.values_by_source.contains_key("D:/good.jpg"));
    }

    #[test]
    fn pretty_and_raw_source_properties_share_occurrence_id() {
        let key = "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution";
        let pretty = format!(
            r#"[{{"SourceFile":"D:/a.jpg","{key}":{{"table":"Exif::Main","id":"282","val":"300 dpi"}}}}]"#
        );
        let raw = format!(
            r#"[{{"SourceFile":"D:/a.jpg","{key}":{{"table":"Exif::Main","id":"282","val":300}}}}]"#
        );
        let pretty = try_parse_exiftool_pass_json_raw(&pretty).unwrap();
        let raw = try_parse_exiftool_pass_json_raw(&raw).unwrap();
        let pretty_property = pretty.values_by_source["D:/a.jpg"].values().next().unwrap();
        let raw_property = raw.values_by_source["D:/a.jpg"].values().next().unwrap();
        assert_eq!(pretty_property.occurrence_id, raw_property.occurrence_id);
    }

    #[test]
    fn pretty_raw_join_is_occurrence_keyed_and_deterministic() {
        let registry = crate::tag_schema::TagRegistry::from_listx_xml(
            r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <tag id='282' name='XResolution' type='int32u' writable='true'>
  <desc lang='en'>X Resolution</desc>
 </tag>
</table>
</taginfo>"#,
        )
        .expect("build controlled IFD resolution registry");
        let info = registry
            .iter()
            .find_map(|(_, info)| (info.name == "XResolution").then_some(info))
            .unwrap();
        let schema = info.id.clone();
        let ifd0 = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let ifd1 = test_occurrence_id("JPEG-APP1-IFD1", "282");
        let raw = runtime_map(vec![
            test_runtime_property(
                ifd1.clone(),
                schema.clone(),
                "IFD1",
                "XResolution",
                None,
                serde_json::json!(72),
            ),
            test_runtime_property(
                ifd0.clone(),
                schema.clone(),
                "IFD0",
                "XResolution",
                None,
                serde_json::json!(300),
            ),
        ]);
        let pretty = runtime_map(vec![
            test_runtime_property(
                ifd0.clone(),
                schema.clone(),
                "IFD0",
                "XResolution",
                None,
                serde_json::json!("300 dpi"),
            ),
            test_runtime_property(
                ifd1.clone(),
                schema.clone(),
                "IFD1",
                "XResolution",
                None,
                serde_json::json!("72 dpi"),
            ),
        ]);

        let canonical = canonical_occurrences_from_exiftool_pair(
            &raw,
            &pretty,
            Some(&registry),
            "resolution.jpg",
            None,
        )
        .unwrap();
        assert_eq!(canonical.len(), 2);
        assert_eq!(canonical[0].occurrence.id, ifd0);
        assert_eq!(canonical[1].occurrence.id, ifd1);
        assert_eq!(canonical[0].projection_schema_id, schema);
        assert_eq!(
            canonical[0].projection_schema_id,
            canonical[1].projection_schema_id
        );
        assert_eq!(canonical[0].occurrence.tag_info.as_ref(), Some(info));
        assert_eq!(canonical[1].occurrence.tag_info.as_ref(), Some(info));
        assert_eq!(canonical[0].occurrence.value, MetadataValue::Integer(300));
        assert_eq!(canonical[1].occurrence.value, MetadataValue::Integer(72));
        assert_ne!(canonical[0].occurrence.id, canonical[1].occurrence.id);
        assert_eq!(
            canonical[0].occurrence.tag_info,
            canonical[1].occurrence.tag_info
        );
        let ifd0_target = canonical[0].occurrence.write_target.as_ref().unwrap();
        let ifd1_target = canonical[1].occurrence.write_target.as_ref().unwrap();
        assert_eq!(ifd0_target.group1, "IFD0");
        assert_eq!(ifd1_target.group1, "IFD1");
        assert_eq!(ifd0_target.selector(), "IFD0:XResolution");
        assert_eq!(ifd1_target.selector(), "IFD1:XResolution");
        assert_eq!(
            canonical[0].occurrence.tag_info.as_ref().unwrap().group,
            "IFD0"
        );
        assert_eq!(
            canonical[1].occurrence.tag_info.as_ref().unwrap().group,
            "IFD0"
        );
        assert!(canonical[0].occurrence.is_writable());
        assert!(canonical[1].occurrence.is_writable());

        let projection_error = project_occurrences_to_legacy_metadata(canonical).unwrap_err();
        assert!(projection_error.contains("legacy schema projection"));
    }

    #[test]
    fn exact_write_target_base_eligibility_is_conservative() {
        let supported = write_target_test_info(true, TagKind::Rational);
        let cases = [
            write_target_test_occurrence(
                "Unknown",
                "XResolution",
                "unresolved",
                0,
                None,
                None,
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "ReadOnly",
                "XResolution",
                "readonly",
                0,
                None,
                Some(write_target_test_info(false, TagKind::Rational)),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "Binary",
                "XResolution",
                "binary",
                0,
                None,
                Some(write_target_test_info(true, TagKind::Binary)),
                MetadataValue::Binary,
            ),
            write_target_test_occurrence(
                "UnknownKind",
                "XResolution",
                "unknown-kind",
                0,
                None,
                Some(write_target_test_info(true, TagKind::Unknown)),
                MetadataValue::Unknown {
                    expected: Some(TagKind::Unknown),
                    raw: serde_json::json!(300),
                    reason: Some("unsupported schema kind".into()),
                },
            ),
            write_target_test_occurrence(
                "Embedded",
                "XResolution",
                "embedded",
                0,
                Some("Doc1"),
                Some(supported.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "Copy",
                "XResolution",
                "copy",
                1,
                None,
                Some(supported),
                MetadataValue::Integer(300),
            ),
        ];

        for mut occurrence in cases {
            assign_exact_write_targets(std::slice::from_mut(&mut occurrence));
            assert!(
                occurrence.occurrence.write_target.is_none(),
                "unexpected target for {}",
                occurrence.friendly_name
            );
            assert!(!occurrence.occurrence.is_writable());
        }
    }

    #[test]
    fn selector_siblings_make_every_matching_occurrence_ambiguous() {
        let info = write_target_test_info(true, TagKind::Rational);
        let copy0 = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "same-path",
            0,
            None,
            Some(info.clone()),
            MetadataValue::Integer(300),
        );
        let copy1 = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "same-path",
            1,
            None,
            Some(info.clone()),
            MetadataValue::Integer(72),
        );
        let mut copies = vec![copy0, copy1];
        assign_exact_write_targets(&mut copies);
        assert!(copies
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));

        let mut different_paths = vec![
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "JPEG-APP1-IFD0",
                0,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "Other-IFD0-Path",
                0,
                None,
                Some(info),
                MetadataValue::Integer(300),
            ),
        ];
        assign_exact_write_targets(&mut different_paths);
        assert!(different_paths
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));
    }

    #[test]
    fn selector_ambiguity_is_ascii_case_insensitive_and_counts_ineligible_siblings() {
        let mut uppercase_info = write_target_test_info(true, TagKind::Rational);
        uppercase_info.name = "XRESOLUTION".into();
        let mut occurrences = vec![
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "primary",
                0,
                None,
                Some(write_target_test_info(true, TagKind::Rational)),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "ifd0",
                "XRESOLUTION",
                "embedded",
                0,
                Some("Doc1"),
                Some(uppercase_info),
                MetadataValue::Integer(72),
            ),
        ];
        assign_exact_write_targets(&mut occurrences);
        assert!(occurrences
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));
    }

    #[test]
    fn aliases_unsafe_selectors_and_lang_alt_children_have_no_target() {
        let info = write_target_test_info(true, TagKind::Rational);
        let mut alias = write_target_test_occurrence(
            "IFD0",
            "ResolutionAlias",
            "alias",
            0,
            None,
            Some(info.clone()),
            MetadataValue::Integer(300),
        );
        assign_exact_write_targets(std::slice::from_mut(&mut alias));
        assert!(alias.occurrence.write_target.is_none());

        for (group1, tag_name) in [
            ("", "XResolution"),
            ("IFD0=bad", "XResolution"),
            ("IFD0\n", "XResolution"),
            ("IFD0", ""),
            ("IFD0", "X:Resolution"),
            ("IFD0", "XResolution=300"),
            ("IFD0", "XResolution\r"),
            ("IFD0\0", "XResolution"),
        ] {
            let mut matching_info = info.clone();
            matching_info.name = tag_name.into();
            let mut occurrence = write_target_test_occurrence(
                group1,
                tag_name,
                "unsafe",
                0,
                None,
                Some(matching_info),
                MetadataValue::Integer(300),
            );
            assign_exact_write_targets(std::slice::from_mut(&mut occurrence));
            assert!(occurrence.occurrence.write_target.is_none());
        }

        let mut lang_alt_info = write_target_test_info(true, TagKind::LangAlt);
        lang_alt_info.name = "Title".into();
        let mut lang_alt = write_target_test_occurrence(
            "XMP-dc",
            "Title",
            "lang-en",
            0,
            None,
            Some(lang_alt_info),
            MetadataValue::LangAlt(BTreeMap::from([("en".into(), "Hello".into())])),
        );
        lang_alt.is_lang_alt = true;
        lang_alt.language = Some("en".into());
        assign_exact_write_targets(std::slice::from_mut(&mut lang_alt));
        assert!(lang_alt.occurrence.write_target.is_none());
    }

    #[test]
    fn known_schema_with_unparsed_value_can_receive_exact_target() {
        let mut occurrence = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "unique",
            0,
            None,
            Some(write_target_test_info(true, TagKind::Rational)),
            MetadataValue::Unknown {
                expected: Some(TagKind::Rational),
                raw: serde_json::json!("not a rational"),
                reason: Some("parse failed".into()),
            },
        );
        assign_exact_write_targets(std::slice::from_mut(&mut occurrence));
        assert_eq!(
            occurrence
                .occurrence
                .write_target
                .as_ref()
                .map(MetadataWriteTarget::selector),
            Some("IFD0:XResolution".into())
        );
        assert!(occurrence.occurrence.is_writable());
    }

    #[test]
    fn target_assignment_is_independent_of_input_order() {
        let info = write_target_test_info(true, TagKind::Rational);
        let occurrences = vec![
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "ambiguous-a",
                0,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "ambiguous-b",
                0,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD1",
                "XResolution",
                "unique",
                0,
                None,
                Some(info),
                MetadataValue::Integer(72),
            ),
        ];
        let mut forward = occurrences.clone();
        let mut reverse = occurrences;
        reverse.reverse();
        assign_exact_write_targets(&mut forward);
        assign_exact_write_targets(&mut reverse);

        let targets = |items: Vec<CanonicalRuntimeOccurrence>| {
            items
                .into_iter()
                .map(|item| (item.occurrence.id, item.occurrence.write_target))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(targets(forward), targets(reverse));
    }

    #[test]
    fn unresolved_canonical_occurrence_preserves_runtime_identity_and_unknown_value() {
        let occurrence_id = test_occurrence_id("Custom-Container", "runtime-unknown");
        let schema_id = test_schema_id("Custom::Unknown", "schema-candidate", Some(0));
        let property = test_runtime_property(
            occurrence_id.clone(),
            schema_id.clone(),
            "Custom",
            "Mystery",
            None,
            serde_json::json!({"nested": true}),
        );

        let canonical = canonical_occurrences_from_exiftool_pair(
            &runtime_map(vec![property.clone()]),
            &runtime_map(vec![property]),
            Some(&canonical_registry()),
            "unknown.jpg",
            None,
        )
        .unwrap();
        assert_eq!(canonical.len(), 1);
        let item = &canonical[0];
        assert_eq!(item.occurrence.id, occurrence_id);
        assert_eq!(item.projection_schema_id, schema_id);
        assert_eq!(item.friendly_name, "Custom:Mystery");
        assert!(item.occurrence.tag_info.is_none());
        assert!(item.occurrence.write_target.is_none());
        assert!(matches!(
            &item.occurrence.value,
            MetadataValue::Unknown { raw, expected: None, .. }
                if raw == &serde_json::json!({"nested": true})
        ));

        let projected = project_occurrences_to_legacy_metadata(canonical).unwrap();
        assert!(projected.contains_key(&schema_id));
    }

    #[test]
    fn pretty_raw_join_rejects_cross_pass_coordinate_or_schema_inconsistency() {
        let occurrence = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let base_schema = test_schema_id("Exif::Main", "282", None);
        let raw_property = test_runtime_property(
            occurrence.clone(),
            base_schema.clone(),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!(300),
        );

        let cases = [
            (
                test_runtime_property(
                    occurrence.clone(),
                    test_schema_id("Exif::Other", "282", None),
                    "IFD0",
                    "XResolution",
                    None,
                    serde_json::json!("300 dpi"),
                ),
                "schema identity",
            ),
            (
                test_runtime_property(
                    occurrence.clone(),
                    base_schema.clone(),
                    "IFD1",
                    "ResolutionAlias",
                    None,
                    serde_json::json!("300 dpi"),
                ),
                "family-1 group or tag name",
            ),
            (
                test_runtime_property(
                    occurrence.clone(),
                    base_schema.clone(),
                    "IFD0",
                    "XResolution",
                    Some("en"),
                    serde_json::json!("300 dpi"),
                ),
                "language",
            ),
        ];
        for (pretty_property, expected) in cases {
            let error = canonical_occurrences_from_exiftool_pair(
                &runtime_map(vec![raw_property.clone()]),
                &runtime_map(vec![pretty_property]),
                None,
                "bad.jpg",
                None,
            )
            .unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
            assert!(error.contains("JPEG-APP1-IFD0"));
        }
    }

    #[test]
    fn pretty_raw_join_supports_single_pass_occurrences() {
        let schema = test_schema_id("Exif::Main", "282", None);
        let raw_only = test_runtime_property(
            test_occurrence_id("A", "282"),
            schema.clone(),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!(300),
        );
        let pretty_only = test_runtime_property(
            test_occurrence_id("B", "282"),
            schema,
            "IFD1",
            "XResolution",
            None,
            serde_json::json!("72 dpi"),
        );
        let canonical = canonical_occurrences_from_exiftool_pair(
            &runtime_map(vec![raw_only]),
            &runtime_map(vec![pretty_only]),
            None,
            "partial.jpg",
            None,
        )
        .unwrap();
        assert_eq!(canonical.len(), 2);
    }

    fn canonical_occurrence(
        occurrence_id: MetadataOccurrenceId,
        schema_id: SchemaDefinitionId,
        friendly_name: &str,
        value: MetadataValue,
    ) -> CanonicalRuntimeOccurrence {
        CanonicalRuntimeOccurrence {
            occurrence: MetadataOccurrence {
                id: occurrence_id,
                value,
                tag_info: None,
                write_target: None,
            },
            projection_schema_id: schema_id,
            friendly_name: friendly_name.into(),
            runtime_group1: friendly_name.split(':').next().unwrap_or_default().into(),
            runtime_tag_name: friendly_name.split(':').nth(1).unwrap_or_default().into(),
            language: None,
            is_lang_alt: false,
        }
    }

    #[test]
    fn legacy_projection_handles_unique_and_identical_occurrences() {
        let schema_a = test_schema_id("Exif::Main", "282", None);
        let schema_b = test_schema_id("Exif::Main", "283", None);
        let first = canonical_occurrence(
            test_occurrence_id("IFD0", "282"),
            schema_a.clone(),
            "IFD0:XResolution",
            MetadataValue::Integer(300),
        );
        let second_schema = canonical_occurrence(
            test_occurrence_id("IFD0", "283"),
            schema_b.clone(),
            "IFD0:YResolution",
            MetadataValue::Integer(72),
        );
        let identical = canonical_occurrence(
            test_occurrence_id("IFD1", "282"),
            schema_a.clone(),
            "IFD1:XResolution",
            MetadataValue::Integer(300),
        );
        let projected =
            project_occurrences_to_legacy_metadata(vec![first.clone(), second_schema, identical])
                .unwrap();
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[&schema_a], MetadataValue::Integer(300));
        assert_eq!(projected[&schema_b], MetadataValue::Integer(72));

        let single = project_occurrences_to_legacy_metadata(vec![first]).unwrap();
        assert_eq!(single.len(), 1);
    }

    #[test]
    fn legacy_projection_reports_conflicting_occurrences() {
        let schema = test_schema_id("Exif::Main", "282", None);
        let ifd0 = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let ifd1 = test_occurrence_id("JPEG-APP1-IFD1", "282");
        let error = project_occurrences_to_legacy_metadata(vec![
            canonical_occurrence(
                ifd0.clone(),
                schema.clone(),
                "IFD0:XResolution",
                MetadataValue::Integer(300),
            ),
            canonical_occurrence(
                ifd1.clone(),
                schema.clone(),
                "IFD1:XResolution",
                MetadataValue::Integer(72),
            ),
        ])
        .unwrap_err();
        assert!(error.contains("legacy schema projection"));
        assert!(error.contains("Exif::Main"));
        assert!(error.contains(&ifd0.path));
        assert!(error.contains(&ifd1.path));
        assert_ne!(ifd0, ifd1);
    }

    #[test]
    fn legacy_projection_preserves_lang_alt_without_broadening_collisions() {
        let schema = test_schema_id("XMP::dc", "title", None);
        let lang = |path: &str, language: &str, text: &str| CanonicalRuntimeOccurrence {
            occurrence: MetadataOccurrence {
                id: test_occurrence_id(path, "title"),
                value: MetadataValue::LangAlt(BTreeMap::from([(language.into(), text.into())])),
                tag_info: None,
                write_target: None,
            },
            projection_schema_id: schema.clone(),
            friendly_name: "XMP-dc:Title".into(),
            runtime_group1: "XMP-dc".into(),
            runtime_tag_name: "Title".into(),
            language: Some(language.into()),
            is_lang_alt: true,
        };
        let projected = project_occurrences_to_legacy_metadata(vec![
            lang("XMP-en", "en", "Hello"),
            lang("XMP-fr", "fr", "Bonjour"),
        ])
        .unwrap();
        assert!(matches!(
            &projected[&schema],
            MetadataValue::LangAlt(values)
                if values.get("en").map(String::as_str) == Some("Hello")
                    && values.get("fr").map(String::as_str) == Some("Bonjour")
        ));

        let ordinary_error = project_occurrences_to_legacy_metadata(vec![
            canonical_occurrence(
                test_occurrence_id("A", "title"),
                schema.clone(),
                "A:Title",
                MetadataValue::Text("Hello".into()),
            ),
            canonical_occurrence(
                test_occurrence_id("B", "title"),
                schema,
                "B:Title",
                MetadataValue::Text("Bonjour".into()),
            ),
        ])
        .unwrap_err();
        assert!(ordinary_error.contains("legacy schema projection"));
    }

    #[test]
    fn legacy_projection_distinguishes_schema_indexes_and_is_deterministic() {
        let none = test_schema_id("Exif::Main", "282", None);
        let zero = test_schema_id("Exif::Main", "282", Some(0));
        let occurrences = vec![
            canonical_occurrence(
                test_occurrence_id("B", "282"),
                zero.clone(),
                "B:XResolution",
                MetadataValue::Integer(72),
            ),
            canonical_occurrence(
                test_occurrence_id("A", "282"),
                none.clone(),
                "A:XResolution",
                MetadataValue::Integer(300),
            ),
        ];
        let first = project_occurrences_to_legacy_metadata(occurrences.clone()).unwrap();
        let second = project_occurrences_to_legacy_metadata(occurrences).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 2);
        assert!(first.contains_key(&none));
        assert!(first.contains_key(&zero));
    }

    #[cfg(feature = "integration")]
    #[test]
    fn production_exiftool_arguments_emit_parseable_occurrence_coordinates() {
        let temp = tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test_images")
            .join("real_with_exif.jpg");
        let copy = temp.path().join("representative.jpg");
        fs::copy(source, &copy).unwrap();

        let mut command = crate::exiftool_config::exiftool_command();
        command.args(exiftool_read_args(false)).arg(&copy);
        let output = command.output().expect("run installed ExifTool");
        assert!(
            output.status.success(),
            "ExifTool failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let entries: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
        let object = entries[0].as_object().unwrap();
        let parsed: Vec<_> = object
            .keys()
            .filter(|key| key.as_str() != "SourceFile")
            .map(|key| {
                parse_runtime_property_key(key)
                    .unwrap_or_else(|error| panic!("unexpected ExifTool key `{key}`: {error}"))
            })
            .collect();

        assert!(!parsed.is_empty());
        assert!(parsed.iter().any(|key| !key.occurrence_id.path.is_empty()));
        assert!(parsed
            .iter()
            .any(|key| !key.occurrence_id.tag_id.is_empty()));
        assert!(parsed
            .iter()
            .any(|key| { key.occurrence_id.document.is_none() && key.occurrence_id.copy == 0 }));
        assert!(parsed
            .iter()
            .all(|key| key.friendly_name() == format!("{}:{}", key.group1, key.tag_name)));

        let resolutions: Vec<_> = parsed
            .iter()
            .filter(|key| {
                key.tag_name == "XResolution" && matches!(key.group1.as_str(), "IFD0" | "IFD1")
            })
            .collect();
        if resolutions.len() >= 2 {
            assert_ne!(resolutions[0].occurrence_id, resolutions[1].occurrence_id);
        }

        let runtime_map = parse_single_source_object(object.clone(), None).unwrap();
        let runtime_resolutions: Vec<_> = runtime_map
            .values()
            .filter(|property| {
                property.tag_name == "XResolution"
                    && matches!(property.group1.as_str(), "IFD0" | "IFD1")
            })
            .collect();
        if runtime_resolutions.len() >= 2 {
            assert_eq!(
                runtime_resolutions[0].schema_id,
                runtime_resolutions[1].schema_id
            );
            assert_ne!(
                runtime_resolutions[0].occurrence_id,
                runtime_resolutions[1].occurrence_id
            );
            assert!(runtime_map.contains_key(&runtime_resolutions[0].occurrence_id));
            assert!(runtime_map.contains_key(&runtime_resolutions[1].occurrence_id));
        }
    }

    #[cfg(feature = "integration")]
    fn read_integration_occurrences(path: &Path) -> Vec<CanonicalRuntimeOccurrence> {
        let paths = [path.to_path_buf()];
        let display = run_exiftool_pass(&paths, false).unwrap();
        let raw = run_exiftool_pass(&paths, true).unwrap();
        let key = path.to_string_lossy().replace('\\', "/");
        canonical_occurrences_from_exiftool_pair(
            raw.values_by_source
                .get(&key)
                .expect("raw pass contains disposable file"),
            display
                .values_by_source
                .get(&key)
                .expect("display pass contains disposable file"),
            Some(crate::tag_schema::get_registry().unwrap()),
            &key,
            None,
        )
        .unwrap()
    }

    #[cfg(feature = "integration")]
    fn rational_integer_value(occurrence: &CanonicalRuntimeOccurrence) -> i64 {
        match occurrence.occurrence.value {
            MetadataValue::Rational(ref value) if value.denominator == 1 => value.numerator,
            ref other => panic!("expected whole-number rational, got {other:?}"),
        }
    }

    #[cfg(feature = "integration")]
    fn integration_resolution_occurrences(
        items: &[CanonicalRuntimeOccurrence],
    ) -> Vec<&CanonicalRuntimeOccurrence> {
        items
            .iter()
            .filter(|item| {
                item.runtime_tag_name == "XResolution"
                    && matches!(item.runtime_group1.as_str(), "IFD0" | "IFD1")
            })
            .collect()
    }

    #[cfg(feature = "integration")]
    #[test]
    fn production_copy_coordinates_keep_ifd1_conservative_and_group_writes_isolate() {
        let temp = tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test_images")
            .join("real_with_exif.jpg");
        let copy = temp.path().join("ifd-resolution-targets.jpg");
        fs::copy(source, &copy).unwrap();

        let mut initialise = crate::exiftool_config::exiftool_command();
        let initial_output = initialise
            .args([
                "-overwrite_original",
                "-IFD0:XResolution=300",
                "-IFD1:XResolution=72",
            ])
            .arg(&copy)
            .output()
            .expect("initialise disposable IFD resolutions");
        assert!(
            initial_output.status.success(),
            "ExifTool setup failed: {}",
            String::from_utf8_lossy(&initial_output.stderr)
        );

        let initial = read_integration_occurrences(&copy);
        let initial_resolutions = integration_resolution_occurrences(&initial);
        assert_eq!(initial_resolutions.len(), 2);
        let ifd0 = initial_resolutions
            .iter()
            .find(|item| item.runtime_group1 == "IFD0")
            .unwrap();
        let ifd1 = initial_resolutions
            .iter()
            .find(|item| item.runtime_group1 == "IFD1")
            .unwrap();
        assert_ne!(ifd0.occurrence.id, ifd1.occurrence.id);
        assert_eq!(ifd0.occurrence.tag_info, ifd1.occurrence.tag_info);
        let ifd0_target = ifd0.occurrence.write_target.clone().unwrap();
        assert_eq!(ifd0_target.selector(), "IFD0:XResolution");
        assert!(ifd1.occurrence.id.copy > 0);
        assert!(ifd1.occurrence.write_target.is_none());
        assert_eq!(rational_integer_value(ifd0), 300);
        assert_eq!(rational_integer_value(ifd1), 72);

        let mut write_ifd0 = crate::exiftool_config::exiftool_command();
        let ifd0_output = write_ifd0
            .args([
                "-overwrite_original".to_owned(),
                format!("-{}=240", ifd0_target.selector()),
            ])
            .arg(&copy)
            .output()
            .expect("write derived IFD0 selector");
        assert!(
            ifd0_output.status.success(),
            "ExifTool IFD0 write failed: {}",
            String::from_utf8_lossy(&ifd0_output.stderr)
        );
        let after_ifd0 = read_integration_occurrences(&copy);
        let after_ifd0_resolutions = integration_resolution_occurrences(&after_ifd0);
        assert_eq!(
            rational_integer_value(
                after_ifd0_resolutions
                    .iter()
                    .find(|item| item.runtime_group1 == "IFD0")
                    .unwrap()
            ),
            240
        );
        assert_eq!(
            rational_integer_value(
                after_ifd0_resolutions
                    .iter()
                    .find(|item| item.runtime_group1 == "IFD1")
                    .unwrap()
            ),
            72
        );

        let mut write_ifd1 = crate::exiftool_config::exiftool_command();
        let ifd1_output = write_ifd1
            .args([
                "-overwrite_original".to_owned(),
                format!("-{}:{}=96", ifd1.runtime_group1, ifd1.runtime_tag_name),
            ])
            .arg(&copy)
            .output()
            .expect("write derived IFD1 selector");
        assert!(
            ifd1_output.status.success(),
            "ExifTool IFD1 write failed: {}",
            String::from_utf8_lossy(&ifd1_output.stderr)
        );
        let after_ifd1 = read_integration_occurrences(&copy);
        let after_ifd1_resolutions = integration_resolution_occurrences(&after_ifd1);
        assert_eq!(
            rational_integer_value(
                after_ifd1_resolutions
                    .iter()
                    .find(|item| item.runtime_group1 == "IFD0")
                    .unwrap()
            ),
            240
        );
        assert_eq!(
            rational_integer_value(
                after_ifd1_resolutions
                    .iter()
                    .find(|item| item.runtime_group1 == "IFD1")
                    .unwrap()
            ),
            96
        );
    }

    #[test]
    fn empty_folder_returns_no_photos() {
        let dir = tempdir().unwrap();
        assert!(collect(dir.path()).is_empty());
    }

    #[test]
    fn non_image_files_are_ignored() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("readme.txt"), b"hello").unwrap();
        fs::write(dir.path().join("data.csv"), b"a,b,c").unwrap();
        assert!(collect(dir.path()).is_empty());
    }

    #[test]
    fn all_supported_extensions_are_found() {
        let dir = tempdir().unwrap();
        let names = [
            "a.jpg", "b.jpeg", "c.png", "d.gif", "e.bmp", "f.webp", "g.tiff", "h.tif",
        ];
        for name in &names {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        assert_eq!(collect(dir.path()).len(), names.len());
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("A.JPG"), b"x").unwrap();
        fs::write(dir.path().join("B.PNG"), b"x").unwrap();
        assert_eq!(collect(dir.path()).len(), 2);
    }

    #[test]
    fn subdirectories_are_scanned_recursively() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("vacation").join("beach");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("sunset.jpg"), b"x").unwrap();
        fs::write(dir.path().join("portrait.png"), b"x").unwrap();
        let photos = collect(dir.path());
        assert_eq!(photos.len(), 2);
        for p in &photos {
            assert!(!p.relative_path.starts_with('/'));
        }
    }

    #[test]
    fn callback_is_called_for_each_photo() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        fs::write(dir.path().join("b.jpg"), b"x").unwrap();
        fs::write(dir.path().join("c.jpg"), b"x").unwrap();
        let mut count = 0;
        scan_folder(
            dir.path(),
            Arc::new(AtomicBool::new(false)),
            |_| count += 1,
            |_| {},
        );
        assert_eq!(count, 3);
    }

    #[test]
    fn filename_field_is_populated() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        assert_eq!(collect(dir.path())[0].filename, "photo.jpg");
    }

    #[test]
    fn os_metadata_is_populated_for_real_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        assert!(collect(dir.path())[0].date_modified.is_some());
    }

    #[test]
    fn metadata_returns_empty_on_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.jpg");
        let results = read_image_metadata_batch(&["missing.jpg".to_string()], &[path]);
        // Should return an error for missing file
        let err = results.expect_err("missing file should fail metadata batch");
        assert!(
            err.contains("ExifTool display pass failed"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn thumbnail_returns_none_for_corrupt_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("bad.jpg"), b"not an image").unwrap();
        assert!(thumbnail_for(&dir.path().join("bad.jpg")).is_none());
    }

    #[test]
    fn thumbnail_returns_none_for_corrupt_png() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("bad.png"), b"not a png").unwrap();
        assert!(thumbnail_for(&dir.path().join("bad.png")).is_none());
    }

    #[test]
    fn thumbnail_returns_some_for_valid_png() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("pixel.png");
        image::RgbImage::new(1, 1).save(&path).unwrap();
        let result = thumbnail_for(&path);
        assert!(result.is_some());
        assert!(!result.unwrap().is_empty());
    }

    #[test]
    fn walk_errors_are_reported_via_on_error_callback() {
        // Walking a path that doesn't exist produces one WalkDir error.
        // Previously these were silently dropped — the user would never know
        // a folder was unreadable.
        let mut errors = Vec::new();
        scan_folder(
            Path::new("D:/this-path-definitely-does-not-exist-_xyz_999"),
            Arc::new(AtomicBool::new(false)),
            |_| {},
            |e| errors.push(e),
        );
        assert!(
            !errors.is_empty(),
            "expected at least one WalkErrorInfo for a missing root"
        );
        assert!(!errors[0].message.is_empty());
    }

    #[test]
    fn happy_path_walk_does_not_invoke_on_error() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        let mut errors = 0;
        scan_folder(
            dir.path(),
            Arc::new(AtomicBool::new(false)),
            |_| {},
            |_| errors += 1,
        );
        assert_eq!(errors, 0);
    }

    #[test]
    fn parse_exiftool_preserves_nested_objects() {
        let json = r#"[
            {"SourceFile": "D:/a.jpg", "Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}},
            {"SourceFile": "D:/b.mov", "Keys": {"table":"TestFixture::Unknown","id":"Keys","val":{"creator":"alice","year":2024}}},
            {"SourceFile": "D:/c.jpg", "Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}}
        ]"#;
        let rel = vec![
            "a.jpg".to_string(),
            "b.mov".to_string(),
            "c.jpg".to_string(),
        ];
        let abs = vec![
            std::path::PathBuf::from("D:/a.jpg"),
            std::path::PathBuf::from("D:/b.mov"),
            std::path::PathBuf::from("D:/c.jpg"),
        ];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        assert_eq!(results.len(), 3);
        let b = results.iter().find(|r| r.relative_path == "b.mov").unwrap();
        let keys_id = SchemaDefinitionId {
            table: "TestFixture::Unknown".into(),
            tag_id: "Keys".into(),
            index: None,
        };
        match b.metadata.get(&keys_id) {
            Some(MetadataValue::Unknown { raw, .. }) => {
                assert_eq!(raw, &serde_json::json!({"creator": "alice", "year": 2024}));
            }
            other => panic!("expected unknown raw object for Keys, got {:?}", other),
        }
    }

    #[test]
    fn parse_exiftool_skips_non_object_entries_keeps_others() {
        // An entry that isn't a JSON object can't deserialize to a HashMap.
        // Per-entry isolation means the others must still come through.
        let json = r#"[
            {"SourceFile": "D:/a.jpg", "Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}},
            [1, 2, 3],
            {"SourceFile": "D:/c.jpg", "Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}}
        ]"#;
        let rel = vec!["a.jpg".to_string(), "c.jpg".to_string()];
        let abs = vec![
            std::path::PathBuf::from("D:/a.jpg"),
            std::path::PathBuf::from("D:/c.jpg"),
        ];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        assert_eq!(results.len(), 2);
        let a = results.iter().find(|r| r.relative_path == "a.jpg").unwrap();
        let c = results.iter().find(|r| r.relative_path == "c.jpg").unwrap();
        let tag_id = SchemaDefinitionId {
            table: "TestFixture::Unknown".into(),
            tag_id: "Tag".into(),
            index: None,
        };
        assert!(matches!(
            a.metadata.get(&tag_id),
            Some(MetadataValue::Unknown { raw, .. }) if raw == &serde_json::json!("ok")
        ));
        assert!(matches!(
            c.metadata.get(&tag_id),
            Some(MetadataValue::Unknown { raw, .. }) if raw == &serde_json::json!("ok")
        ));
    }

    #[test]
    fn parse_pass_json_keys_results_by_normalized_source() {
        let json = r#"[
            {"SourceFile": "D:\\a.jpg", "Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"X"}},
            {"SourceFile": "D:/b.jpg", "Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"Y"}}
        ]"#;
        let map = parse_exiftool_pass_json_raw(json);
        assert_eq!(map.len(), 2);
        assert_eq!(
            map.get("D:/a.jpg").and_then(|m| m.get("Tag")),
            Some(&serde_json::json!("X"))
        );
        assert_eq!(
            map.get("D:/b.jpg").and_then(|m| m.get("Tag")),
            Some(&serde_json::json!("Y"))
        );
    }

    #[test]
    fn parse_pass_json_handles_struct_values() {
        // Pass A typically returns nested Keys / regions structs.
        let json = r#"[{"SourceFile":"D:/a.mov","Keys":{"table":"TestFixture::Unknown","id":"Keys","val":{"creator":"alice"}}}]"#;
        let map = parse_exiftool_pass_json_raw(json);
        assert_eq!(
            map.get("D:/a.mov").and_then(|m| m.get("Keys")),
            Some(&serde_json::json!({"creator": "alice"}))
        );
    }

    #[test]
    fn parse_pass_json_raw_keeps_exiftool_boundary_as_json() {
        let json = r#"[{"SourceFile":"D:/a.jpg","Int":{"table":"TestFixture::Unknown","id":"Int","val":5},"Real":{"table":"TestFixture::Unknown","id":"Real","val":1.5},"Obj":{"table":"TestFixture::Unknown","id":"Obj","val":{"x":true}}}]"#;
        let map = parse_exiftool_pass_json_raw(json);
        let entry = map.get("D:/a.jpg").expect("entry");
        assert_eq!(entry.get("Int"), Some(&serde_json::json!(5)));
        assert_eq!(entry.get("Real"), Some(&serde_json::json!(1.5)));
        assert_eq!(entry.get("Obj"), Some(&serde_json::json!({"x": true})));
    }

    #[test]
    fn parse_batch_populates_transitional_semantic_maps() {
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IPTC:TimeCreated": {"table": "IPTC::ApplicationRecord", "id": "60", "val": "10:56:05"},
            "ExifIFD:OffsetTimeOriginal": {"table": "Exif::Main", "id": "36881", "val": "+01:00"},
            "MadeUp:Thing": {"table": "TestFixture::Unknown", "id": "MadeUp:Thing", "val": 5}
        }]"#;
        let rel = vec!["a.jpg".to_string()];
        let abs = vec![std::path::PathBuf::from("D:/a.jpg")];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        let image = &results[0];
        assert!(matches!(
            image.metadata.get(&crate::known_ids::iptc_time_created()),
            Some(MetadataValue::Time(t)) if t.offset.is_none()
        ));
        assert!(matches!(
            image
                .metadata
                .get(&crate::known_ids::offset_time_original()),
            Some(MetadataValue::TimeOffset(_))
        ));
        assert!(matches!(
            image.metadata.get(&SchemaDefinitionId { table: "TestFixture::Unknown".into(), tag_id: "MadeUp:Thing".into(), index: None }),
            Some(MetadataValue::Unknown { expected: None, raw, .. }) if raw == &serde_json::json!(5)
        ));
    }

    #[test]
    fn json_preview_is_bounded() {
        let value = serde_json::json!("x".repeat(400));
        let preview = json_preview(&value);
        assert!(
            preview.chars().count() <= 240,
            "preview should be capped, got {} chars",
            preview.chars().count()
        );
        assert!(preview.ends_with("..."));
    }

    #[test]
    fn json_helpers_summarise_raw_values_safely() {
        assert_eq!(json_value_kind(&serde_json::json!(null)), "null");
        assert_eq!(json_value_kind(&serde_json::json!(true)), "bool");
        assert_eq!(json_value_kind(&serde_json::json!(7)), "integer");
        assert_eq!(json_value_kind(&serde_json::json!(1.25)), "number");
        assert_eq!(json_value_kind(&serde_json::json!("line\nbreak")), "string");
        assert_eq!(json_value_kind(&serde_json::json!([1, 2])), "array");
        assert_eq!(json_value_kind(&serde_json::json!({"a": 1})), "object");
        assert_eq!(
            json_preview(&serde_json::json!("line\nbreak")),
            r#""line\nbreak""#
        );
        assert_eq!(
            tag_kind_summary(&crate::tag_schema::TagKind::Bag(Box::new(
                crate::tag_schema::TagKind::Text
            ))),
            "Bag<Text>"
        );
    }

    fn binary_registry() -> crate::tag_schema::TagRegistry {
        // `from_listx_xml` applies the hand-curated override table at the end,
        // which inserts `IFD1:ThumbnailImage` as `TagKind::Binary` even when
        // listx itself didn't enumerate it. Empty taginfo is enough.
        crate::tag_schema::TagRegistry::from_listx_xml(
            "<?xml version='1.0' encoding='UTF-8'?><taginfo></taginfo>",
        )
        .expect("build empty registry")
    }

    fn canonical_registry() -> crate::tag_schema::TagRegistry {
        crate::tag_schema::TagRegistry::from_listx_xml(
            r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Main' g0='EXIF' g1='EXIF' g2='Image'>
 <tag id='282' name='XResolution' type='int32u' writable='true'>
  <desc lang='en'>X Resolution</desc>
 </tag>
 <tag id='Make' name='Make' type='string' writable='true'>
  <desc lang='en'>Make</desc>
 </tag>
 <tag id='Model' name='Model' type='string' writable='true'>
  <desc lang='en'>Model</desc>
 </tag>
 <tag id='LensModel' name='LensModel' type='string' writable='true'>
  <desc lang='en'>Lens Model</desc>
 </tag>
 <tag id='ISO' name='ISO' type='int32u' writable='true'>
  <desc lang='en'>ISO</desc>
 </tag>
 <tag id='ExposureTime' name='ExposureTime' type='rational64u' writable='true'>
  <desc lang='en'>Exposure Time</desc>
 </tag>
</table>
<table name='EXIF::GPS' g0='EXIF' g1='GPS' g2='Location'>
 <tag id='0' name='GPSVersionID' type='int8u' count='4' writable='true'><desc lang='en'>GPS Version</desc></tag>
</table>
</taginfo>"#,
        )
        .expect("build canonical test registry")
    }

    fn lang_alt_registry() -> crate::tag_schema::TagRegistry {
        crate::tag_schema::TagRegistry::from_listx_xml(
            r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='XMP::dc' g0='XMP' g1='XMP-dc' g2='Other'>
 <tag id='description' name='Description' type='lang-alt' writable='true'>
  <desc lang='en'>Description</desc>
 </tag>
</table>
</taginfo>"#,
        )
        .expect("build LangAlt test registry")
    }

    #[test]
    fn lang_alt_children_embed_parent_tag_info_and_remain_distinct() {
        let registry = lang_alt_registry();
        let parent_id = test_schema_id("XMP::dc", "description", None);
        let parent_info = registry.lookup(&parent_id).unwrap();
        let child = |language: &str, text: &str| {
            test_runtime_property(
                test_occurrence_id(&format!("XMP-{language}"), "description"),
                test_schema_id("XMP::dc", &format!("description-{language}"), None),
                "XMP-dc",
                "Description",
                Some(language),
                serde_json::json!(text),
            )
        };
        let properties = runtime_map(vec![child("en", "Hello"), child("fr", "Bonjour")]);
        let canonical = canonical_occurrences_from_exiftool_pair(
            &properties,
            &properties,
            Some(&registry),
            "lang-alt.jpg",
            None,
        )
        .unwrap();

        assert_eq!(canonical.len(), 2);
        assert_ne!(canonical[0].occurrence.id, canonical[1].occurrence.id);
        for item in &canonical {
            assert_eq!(item.projection_schema_id, parent_id);
            assert_eq!(item.occurrence.tag_info.as_ref(), Some(parent_info));
            assert!(item.occurrence.write_target.is_none());
            assert!(matches!(
                &item.occurrence.value,
                MetadataValue::LangAlt(values) if values.len() == 1
            ));
        }

        let projected = project_occurrences_to_legacy_metadata(canonical).unwrap();
        assert!(matches!(
            &projected[&parent_id],
            MetadataValue::LangAlt(values)
                if values.get("en").map(String::as_str) == Some("Hello")
                    && values.get("fr").map(String::as_str) == Some("Bonjour")
        ));
    }

    #[test]
    fn canonical_prefers_raw_primary_and_uses_display_only_as_hint() {
        let reg = canonical_registry();
        let raw = HashMap::from([
            ("EXIF:Make".to_string(), serde_json::json!("Canon raw")),
            ("EXIF:ExposureTime".to_string(), serde_json::json!(0.015625)),
        ]);
        let display = HashMap::from([
            ("EXIF:Make".to_string(), serde_json::json!("Canon display")),
            ("EXIF:ExposureTime".to_string(), serde_json::json!("1/64")),
        ]);

        let values =
            canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

        assert_eq!(
            values.get("EXIF:Make"),
            Some(&MetadataValue::Text("Canon raw".to_string()))
        );
        assert_eq!(
            values.get("EXIF:ExposureTime"),
            Some(&MetadataValue::Rational(
                crate::metadata_value::RationalValue {
                    numerator: 1,
                    denominator: 64,
                }
            ))
        );
    }

    #[test]
    fn canonical_recovers_exact_rational_from_display_hint() {
        let reg = canonical_registry();
        let raw = HashMap::from([("EXIF:ExposureTime".to_string(), serde_json::json!(0.015625))]);
        let display = HashMap::from([("EXIF:ExposureTime".to_string(), serde_json::json!("1/64"))]);

        let values =
            canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

        match values.get("EXIF:ExposureTime") {
            Some(MetadataValue::Rational(r)) => {
                assert_eq!(r.numerator, 1);
                assert_eq!(r.denominator, 64);
            }
            other => panic!("expected rational 1/64, got {:?}", other),
        }
    }

    #[test]
    fn canonical_gps_version_id_is_text_without_warning() {
        let reg = canonical_registry();
        let raw = HashMap::from([("GPS:GPSVersionID".to_string(), serde_json::json!("2 2 0 0"))]);
        let display =
            HashMap::from([("GPS:GPSVersionID".to_string(), serde_json::json!("2.2.0.0"))]);
        let mut warnings = Vec::new();

        let values = canonical_values_from_exiftool_pair(
            &raw,
            &display,
            Some(&reg),
            "photo.jpg",
            Some(&mut warnings),
        );

        assert_eq!(
            values.get("GPS:GPSVersionID"),
            Some(&MetadataValue::Text("2 2 0 0".to_string()))
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn canonical_includes_display_only_fallback_value() {
        let reg = canonical_registry();
        let raw = HashMap::new();
        let display = HashMap::from([("EXIF:Model".to_string(), serde_json::json!("X100V"))]);

        let values =
            canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

        assert_eq!(
            values.get("EXIF:Model"),
            Some(&MetadataValue::Text("X100V".to_string()))
        );
    }

    #[test]
    fn canonical_includes_raw_only_value() {
        let reg = canonical_registry();
        let raw = HashMap::from([("EXIF:ISO".to_string(), serde_json::json!(400))]);
        let display = HashMap::new();

        let values =
            canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

        assert_eq!(values.get("EXIF:ISO"), Some(&MetadataValue::Integer(400)));
    }

    #[test]
    fn canonical_iterates_union_of_raw_and_display_keys() {
        let reg = canonical_registry();
        let raw = HashMap::from([
            ("EXIF:Make".to_string(), serde_json::json!("Raw make")),
            ("EXIF:ISO".to_string(), serde_json::json!(200)),
        ]);
        let display = HashMap::from([
            ("EXIF:Make".to_string(), serde_json::json!("Display make")),
            ("EXIF:LensModel".to_string(), serde_json::json!("35mm f/2")),
        ]);

        let values =
            canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

        assert_eq!(values.len(), 3);
        assert!(values.contains_key("EXIF:Make"));
        assert!(values.contains_key("EXIF:ISO"));
        assert!(values.contains_key("EXIF:LensModel"));
        assert_eq!(
            values.get("EXIF:Make"),
            Some(&MetadataValue::Text("Raw make".to_string()))
        );
    }

    #[test]
    fn binary_tag_values_are_replaced_with_placeholder() {
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IFD1:ThumbnailImage": {"table":"Exif::Main","id":"513","val":"(Binary data 3965 bytes, use -b option to extract)"},
            "EXIF:Make": {"table":"Exif::Main","id":"271","val":"Canon"}
        }]"#;
        let reg = binary_registry();
        let map = parse_exiftool_pass_json_raw_with_registry(json, Some(&reg));
        let entry = map.get("D:/a.jpg").expect("entry present");
        assert_eq!(
            entry.get("IFD1:ThumbnailImage"),
            Some(&serde_json::json!("<binary>"))
        );
        // Non-binary tag passes through untouched.
        assert_eq!(entry.get("EXIF:Make"), Some(&serde_json::json!("Canon")));
    }

    #[test]
    fn regex_fallback_substitutes_when_schema_misses_tag() {
        // `File:` is exiftool's synthetic group for container-extracted
        // binaries (PreviewImage, JpgFromRaw, etc.). `-listx` does not
        // enumerate it, so the schema cannot classify these — the regex
        // fallback is the only thing that catches them.
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "File:PreviewImage": {"table":"File::Main","id":"PreviewImage","val":"(Binary data 105557 bytes, use -b option to extract)"}
        }]"#;
        let reg = binary_registry();
        let map = parse_exiftool_pass_json_raw_with_registry(json, Some(&reg));
        let entry = map.get("D:/a.jpg").expect("entry present");
        assert_eq!(
            entry.get("File:PreviewImage"),
            Some(&serde_json::json!("<binary>"))
        );
    }

    #[test]
    fn regex_fallback_works_without_registry() {
        // No schema available: regex alone must still catch the placeholder.
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IFD1:ThumbnailImage": {"table":"Exif::Main","id":"513","val":"(Binary data 3965 bytes, use -b option to extract)"}
        }]"#;
        let map = parse_exiftool_pass_json_raw_with_registry(json, None);
        let entry = map.get("D:/a.jpg").expect("entry present");
        assert_eq!(
            entry.get("IFD1:ThumbnailImage"),
            Some(&serde_json::json!("<binary>"))
        );
    }

    #[test]
    fn regex_fallback_is_anchored_and_does_not_match_substrings() {
        // A free-text tag whose value mentions the placeholder phrase but is
        // not exactly the placeholder must round-trip unchanged. End-anchoring
        // protects descriptions and other prose fields.
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "EXIF:ImageDescription": {"table":"Exif::Main","id":"270","val":"Note: the exiftool stub reads \"(Binary data 99 bytes, use -b option to extract)\" in this field."}
        }]"#;
        let reg = binary_registry();
        let map = parse_exiftool_pass_json_raw_with_registry(json, Some(&reg));
        let entry = map.get("D:/a.jpg").expect("entry present");
        match entry.get("EXIF:ImageDescription") {
            Some(serde_json::Value::String(s)) => {
                assert!(s.starts_with("Note: the exiftool stub"));
                assert!(!s.contains("<binary>"));
            }
            other => panic!("expected unchanged String, got {:?}", other),
        }
    }

    #[test]
    fn parse_exiftool_malformed_outer_json_logs_and_returns_empty_metadata() {
        let json = "not json at all";
        let rel = vec!["x.jpg".to_string()];
        let abs = vec![std::path::PathBuf::from("D:/x.jpg")];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        assert_eq!(results.len(), 1);
        assert!(results[0].metadata.is_empty());
    }

    #[test]
    fn exif_thumbnail_too_small_is_rejected() {
        // The test image's embedded thumbnail is ~100×68 px, which is below the
        // 160 px threshold.  extract_exif_thumbnail should return None so we
        // fall through to the full-decode path.
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = workspace_root.join("test_images/real_with_exif.jpg");

        if !path.exists() {
            panic!("Test image not found at {:?}. Please ensure test_images/real_with_exif.jpg exists in the repository.", path);
        }

        let result = extract_exif_thumbnail(&path);
        assert!(
            result.is_none(),
            "Embedded thumbnail is < 160 px; should have been rejected"
        );

        // thumbnail_for should still succeed via the full-decode fallback
        let thumb = thumbnail_for(&path);
        assert!(
            thumb.is_some(),
            "Expected thumbnail_for to succeed via full decode"
        );
        assert!(!thumb.unwrap().is_empty());
    }

    #[test]
    fn exif_thumbnail_large_enough_is_used() {
        // large_with_exif.jpg has a 200×150 embedded thumbnail (≥ 160 px),
        // so extract_exif_thumbnail should return it directly.
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = workspace_root.join("test_images/large_with_exif.jpg");

        if !path.exists() {
            panic!("Test image not found at {:?}. Please ensure test_images/large_with_exif.jpg exists in the repository.", path);
        }

        let result = extract_exif_thumbnail(&path);
        assert!(
            result.is_some(),
            "Expected embedded thumbnail (200×150) to be accepted (≥ 160 px)"
        );
        assert!(!result.unwrap().is_empty());
    }

    #[test]
    fn test_warning_classification() {
        assert_eq!(
            classify_warning("no schema entry for tag"),
            ParseWarningCategory::MissingSchema
        );
        assert_eq!(
            classify_warning("schema kind is unknown"),
            ParseWarningCategory::UnknownSchemaKind
        );
        assert_eq!(
            classify_warning("expected integer for integer tag, got string"),
            ParseWarningCategory::ParseFailed
        );
        assert_eq!(
            classify_warning("expected JSON integer for integer tag"),
            ParseWarningCategory::ParseFailed
        );
    }

    #[test]
    fn test_warning_grouping_exact() {
        let warnings = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "c.jpg".to_string(),
                tag: "EXIF:OtherTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "<no schema>".to_string(),
                raw_type: "string",
                raw: serde_json::json!("raw"),
                reason: "no schema entry for tag".to_string(),
            },
        ];

        let groups = group_parse_warnings(&warnings);
        assert_eq!(groups.len(), 2);

        // Group 1: EXIF:SomeTag
        let key1 = WarningGroupKey {
            tag: "EXIF:SomeTag".to_string(),
            reason: "expected integer for integer tag, got string".to_string(),
            expected_summary: "Integer".to_string(),
            raw_type: "string",
        };
        let val1 = groups.get(&key1).expect("SomeTag group present");
        assert_eq!(val1.count, 2);
        assert_eq!(
            val1.examples,
            vec!["a.jpg".to_string(), "b.jpg".to_string()]
        );
        assert_eq!(val1.raw_preview, Some("\"Auto\"".to_string()));

        // Group 2: EXIF:OtherTag
        let key2 = WarningGroupKey {
            tag: "EXIF:OtherTag".to_string(),
            reason: "no schema entry for tag".to_string(),
            expected_summary: "<no schema>".to_string(),
            raw_type: "string",
        };
        let val2 = groups.get(&key2).expect("OtherTag group present");
        assert_eq!(val2.count, 1);
        assert_eq!(
            classify_warning(&key2.reason),
            ParseWarningCategory::MissingSchema
        );

        // Call log_aggregated_warnings to make sure it doesn't panic
        log_aggregated_warnings(&warnings);
    }

    #[test]
    fn test_warning_grouping_example_limit() {
        let warnings = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "a.jpg".to_string(), // Duplicate path, same group
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "c.jpg".to_string(), // Third path, should exceed limit
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
        ];

        let groups = group_parse_warnings(&warnings);
        let val = groups.values().next().expect("Exactly one group");
        assert_eq!(val.count, 4);
        // Duplicate is not repeated, and limit is 2
        assert_eq!(val.examples, vec!["a.jpg".to_string(), "b.jpg".to_string()]);
    }

    #[test]
    fn test_warning_grouping_separation() {
        // Different reason
        let warnings_diff_reason = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason B".to_string(),
            },
        ];
        let groups_diff_reason = group_parse_warnings(&warnings_diff_reason);
        assert_eq!(groups_diff_reason.len(), 2);

        // Different raw type
        let warnings_diff_raw_type = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "number",
                raw: serde_json::json!(123),
                reason: "reason A".to_string(),
            },
        ];
        let groups_diff_raw_type = group_parse_warnings(&warnings_diff_raw_type);
        assert_eq!(groups_diff_raw_type.len(), 2);

        // Different tag
        let warnings_diff_tag = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:TagA".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:TagB".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
        ];
        let groups_diff_tag = group_parse_warnings(&warnings_diff_tag);
        assert_eq!(groups_diff_tag.len(), 2);
    }

    #[test]
    fn test_parser_per_source_isolation() {
        let registry = crate::tag_schema::get_registry().ok();

        // 1. A three-source JSON array where:
        // - first source is valid
        // - second has two occurrence IDs which share one schema identity
        // - third is valid
        // All three sources parse; the legacy projection owns any later collision.
        let json = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            },
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                },
                "IFD1:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "72"
                }
            },
            {
                "SourceFile": "D:/path/Image3.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "150"
                }
            }
        ]"#;

        let json = complete_test_runtime_json(json).unwrap();
        let res = try_parse_exiftool_pass_json_raw_with_registry(&json, registry).unwrap();

        assert_eq!(res.values_by_source.len(), 3);
        assert!(res.values_by_source.contains_key("D:/path/Image1.jpg"));
        assert_eq!(res.values_by_source["D:/path/Image2.jpg"].len(), 2);
        assert!(res.values_by_source.contains_key("D:/path/Image3.jpg"));
        assert!(res.failures_by_source.is_empty());

        let ifd0 = parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution")
            .unwrap();
        let ifd1 = parse_runtime_property_key("IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution")
            .unwrap();
        assert_ne!(ifd0.occurrence_id, ifd1.occurrence_id);

        // 5. A malformed wrapped property in one source is isolated similarly
        let json_malformed_val = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            },
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:XResolution": "not-an-object"
            }
        ]"#;
        let json_malformed_val = complete_test_runtime_json(json_malformed_val).unwrap();
        let res_malformed =
            try_parse_exiftool_pass_json_raw_with_registry(&json_malformed_val, registry).unwrap();
        assert_eq!(res_malformed.values_by_source.len(), 1);
        assert!(res_malformed
            .values_by_source
            .contains_key("D:/path/Image1.jpg"));
        assert_eq!(res_malformed.failures_by_source.len(), 1);
        let fail_msg = res_malformed
            .failures_by_source
            .get("D:/path/Image2.jpg")
            .unwrap();
        assert!(fail_msg.contains("expected wrapped ExifTool runtime value"));
        assert!(!fail_msg.contains("D:/path/Image2.jpg"));

        // A malformed multi-family property name is likewise isolated to its
        // source while a neighbouring complete property remains available.
        let json_malformed_key = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main", "id": "282", "val": "300"
                }
            },
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:Main:Copy0:ID-282:XResolution": {
                    "table": "Exif::Main", "id": "282", "val": "72"
                }
            }
        ]"#;
        let malformed_key_result =
            try_parse_exiftool_pass_json_raw_with_registry(json_malformed_key, registry).unwrap();
        assert!(malformed_key_result
            .values_by_source
            .contains_key("D:/path/Image1.jpg"));
        assert_eq!(malformed_key_result.failures_by_source.len(), 1);
        assert!(
            malformed_key_result.failures_by_source["D:/path/Image2.jpg"]
                .contains("expected family 1:3:4:5:7")
        );

        // 6. An invalid runtime `index` is isolated similarly
        let json_invalid_index = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "index": "invalid",
                    "val": "300"
                }
            }
        ]"#;
        let json_invalid_index = complete_test_runtime_json(json_invalid_index).unwrap();
        let res_invalid_index =
            try_parse_exiftool_pass_json_raw_with_registry(&json_invalid_index, registry).unwrap();
        assert_eq!(res_invalid_index.values_by_source.len(), 0);
        assert_eq!(res_invalid_index.failures_by_source.len(), 1);
        let fail_msg = res_invalid_index
            .failures_by_source
            .get("D:/path/Image1.jpg")
            .unwrap();
        assert!(fail_msg.contains("invalid"));
        assert!(!fail_msg.contains("D:/path/Image1.jpg"));

        // 7. Identical duplicate values retain the current deduplication behaviour
        let json_duplicates = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                },
                "IFD1:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            }
        ]"#;
        let json_duplicates = complete_test_runtime_json(json_duplicates).unwrap();
        let res_duplicates =
            try_parse_exiftool_pass_json_raw_with_registry(&json_duplicates, registry).unwrap();
        assert_eq!(res_duplicates.values_by_source.len(), 1);
        assert_eq!(res_duplicates.failures_by_source.len(), 0);

        // 8. Invalid top-level JSON remains a batch-wide Err
        let json_invalid_top = r#"[ { "SourceFile": "D:/path/Image1.jpg" "#;
        let res_invalid_top =
            try_parse_exiftool_pass_json_raw_with_registry(json_invalid_top, registry);
        assert!(res_invalid_top.is_err());

        // 9. A non-object array entry does not remove valid neighbouring source objects
        let json_non_obj = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            },
            "not-an-object",
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "150"
                }
            }
        ]"#;
        let json_non_obj = complete_test_runtime_json(json_non_obj).unwrap();
        let res_non_obj =
            try_parse_exiftool_pass_json_raw_with_registry(&json_non_obj, registry).unwrap();
        assert_eq!(res_non_obj.values_by_source.len(), 2);
        assert!(res_non_obj
            .values_by_source
            .contains_key("D:/path/Image1.jpg"));
        assert!(res_non_obj
            .values_by_source
            .contains_key("D:/path/Image2.jpg"));
        assert_eq!(res_non_obj.failures_by_source.len(), 0);

        // 10. A source-less object is logged/skipped without being assigned to another file
        let json_sourceless = r#"[
            {
                "IFD0:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            }
        ]"#;
        let json_sourceless = complete_test_runtime_json(json_sourceless).unwrap();
        let res_sourceless =
            try_parse_exiftool_pass_json_raw_with_registry(&json_sourceless, registry).unwrap();
        assert_eq!(res_sourceless.values_by_source.len(), 0);
        assert_eq!(res_sourceless.failures_by_source.len(), 0);
    }

    #[test]
    fn test_assemble_batch_outcome() {
        let registry = crate::tag_schema::get_registry().ok();

        let rel_paths = vec![
            "Image1.jpg".to_string(),
            "Image2.jpg".to_string(),
            "Image3.jpg".to_string(),
        ];
        let abs_paths = vec![
            std::path::PathBuf::from("D:/path/Image1.jpg"),
            std::path::PathBuf::from("D:/path/Image2.jpg"),
            std::path::PathBuf::from("D:/path/Image3.jpg"),
        ];

        // 1. Two successful files and one display-pass failure produce:
        // - two successful results
        // - one failure
        let display_pass = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert(
                    "D:/path/Image2.jpg".to_string(),
                    "display failure details".to_string(),
                );
                map
            },
        };
        let raw_pass = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };

        let mut warnings = Vec::new();
        let outcome = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass.clone(),
            raw_pass.clone(),
            registry,
            &mut warnings,
        )
        .unwrap();

        assert_eq!(outcome.results.len(), 2);
        assert_eq!(outcome.results[0].relative_path, "Image1.jpg");
        assert_eq!(outcome.results[1].relative_path, "Image3.jpg");
        assert_eq!(outcome.failures.len(), 1);
        assert_eq!(outcome.failures[0].relative_path, "Image2.jpg");
        assert!(outcome.failures[0]
            .error_message
            .contains("ExifTool display pass failed:"));
        assert!(outcome.failures[0]
            .error_message
            .contains("display failure details"));
        // Durable isolation invariant: one source can fail parsing while
        // another source in the same logical batch retains successful metadata.
        assert!(outcome
            .results
            .iter()
            .any(|result| result.relative_path == "Image1.jpg"));

        // 2. A raw-pass failure affects only that file
        let display_pass_2 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let raw_pass_2 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert(
                    "D:/path/Image2.jpg".to_string(),
                    "raw failure details".to_string(),
                );
                map
            },
        };
        let outcome_2 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_2,
            raw_pass_2,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_2.results.len(), 2);
        assert_eq!(outcome_2.failures.len(), 1);
        assert_eq!(outcome_2.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_2.failures[0]
            .error_message
            .contains("ExifTool raw (-n) pass failed:"));
        assert!(outcome_2.failures[0]
            .error_message
            .contains("raw failure details"));

        // 3. Failures in both passes produce one combined per-file failure
        let display_pass_3 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert(
                    "D:/path/Image2.jpg".to_string(),
                    "display failure".to_string(),
                );
                map
            },
        };
        let raw_pass_3 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image2.jpg".to_string(), "raw failure".to_string());
                map
            },
        };
        let outcome_3 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_3,
            raw_pass_3,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_3.results.len(), 2);
        assert_eq!(outcome_3.failures.len(), 1);
        assert_eq!(outcome_3.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_3.failures[0]
            .error_message
            .contains("ExifTool display pass failed:"));
        assert!(outcome_3.failures[0]
            .error_message
            .contains("ExifTool raw (-n) pass failed:"));

        // 4. Missing display output affects only that file
        let display_pass_4 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let raw_pass_4 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let outcome_4 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_4,
            raw_pass_4,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_4.results.len(), 2);
        assert_eq!(outcome_4.failures.len(), 1);
        assert_eq!(outcome_4.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_4.failures[0]
            .error_message
            .contains("ExifTool returned no result for this file"));

        // 5. Missing raw output affects only that file
        let display_pass_5 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let raw_pass_5 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let outcome_5 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_5,
            raw_pass_5,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_5.results.len(), 2);
        assert_eq!(outcome_5.failures.len(), 1);
        assert_eq!(outcome_5.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_5.failures[0]
            .error_message
            .contains("ExifTool raw (-n) pass failed:\nExifTool returned no result for this file"));

        // 6. Every requested path is classified exactly once
        // 7. Input order is preserved
        assert_eq!(outcome.results[0].relative_path, "Image1.jpg");
        assert_eq!(outcome.results[1].relative_path, "Image3.jpg");
        assert_eq!(outcome.failures[0].relative_path, "Image2.jpg");

        // 8. Mismatched path-array lengths return a batch-wide error
        let bad_abs = vec![std::path::PathBuf::from("D:/path/Image1.jpg")];
        let outcome_err = assemble_batch_outcome(
            &rel_paths,
            &bad_abs,
            display_pass,
            raw_pass,
            registry,
            &mut warnings,
        );
        assert!(outcome_err.is_err());
    }

    #[test]
    fn post_parse_projection_failure_is_isolated_per_file() {
        let rel_paths = vec![
            "good-before.jpg".to_string(),
            "collision.jpg".to_string(),
            "good-after.jpg".to_string(),
        ];
        let abs_paths: Vec<_> = rel_paths
            .iter()
            .map(|name| std::path::PathBuf::from(format!("D:/batch/{name}")))
            .collect();
        let registry = canonical_registry();
        let schema = registry
            .iter()
            .find_map(|(_, info)| (info.name == "XResolution").then(|| info.id.clone()))
            .unwrap();
        let property = |path: &str, group: &str, value| {
            test_runtime_property(
                test_occurrence_id(path, "282"),
                schema.clone(),
                group,
                "XResolution",
                None,
                serde_json::json!(value),
            )
        };
        let maps = HashMap::from([
            (
                "D:/batch/good-before.jpg".to_string(),
                runtime_map(vec![property("GOOD-BEFORE", "IFD0", 300)]),
            ),
            (
                "D:/batch/collision.jpg".to_string(),
                runtime_map(vec![
                    property("JPEG-APP1-IFD0", "IFD0", 300),
                    property("JPEG-APP1-IFD1", "IFD1", 72),
                ]),
            ),
            (
                "D:/batch/good-after.jpg".to_string(),
                runtime_map(vec![property("GOOD-AFTER", "IFD0", 600)]),
            ),
        ]);
        let display_pass = ExifToolPassOutput {
            values_by_source: maps.clone(),
            failures_by_source: HashMap::new(),
        };
        let raw_pass = ExifToolPassOutput {
            values_by_source: maps,
            failures_by_source: HashMap::new(),
        };

        let outcome = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass,
            raw_pass,
            Some(&registry),
            &mut Vec::new(),
        )
        .expect("individual files remain classifiable");
        assert_eq!(outcome.results.len(), 2);
        assert!(
            outcome
                .results
                .iter()
                .any(|result| result.relative_path == "good-before.jpg"
                    && !result.metadata.is_empty())
        );
        assert!(outcome
            .results
            .iter()
            .any(|result| result.relative_path == "good-after.jpg" && !result.metadata.is_empty()));
        assert_eq!(outcome.failures.len(), 1);
        let failure = &outcome.failures[0];
        assert_eq!(failure.relative_path, "collision.jpg");
        assert!(failure
            .error_message
            .starts_with("Legacy schema projection failed:"));
        assert!(failure.error_message.contains("EXIF::Main"));
        assert!(failure.error_message.contains("JPEG-APP1-IFD0"));
        assert!(failure.error_message.contains("JPEG-APP1-IFD1"));
        assert!(failure.error_message.contains("IFD0:XResolution"));
        assert!(failure.error_message.contains("IFD1:XResolution"));
        assert!(failure.error_message.contains("Integer(300)"));
        assert!(failure.error_message.contains("Integer(72)"));
    }

    #[test]
    fn canonicalisation_failure_prefix_is_isolated_and_groups_complete_messages() {
        let rel_paths = vec![
            "good.jpg".to_string(),
            "bad-one.jpg".to_string(),
            "bad-two.jpg".to_string(),
        ];
        let abs_paths: Vec<_> = rel_paths
            .iter()
            .map(|name| std::path::PathBuf::from(format!("D:/batch/{name}")))
            .collect();
        let occurrence_id = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let raw_property = test_runtime_property(
            occurrence_id.clone(),
            test_schema_id("Exif::Main", "282", None),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!(300),
        );
        let mismatched_pretty = test_runtime_property(
            occurrence_id,
            test_schema_id("Exif::Other", "282", None),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!("300 dpi"),
        );
        let good = test_runtime_property(
            test_occurrence_id("GOOD", "Make"),
            test_schema_id("EXIF::Main", "Make", None),
            "EXIF",
            "Make",
            None,
            serde_json::json!("Canon"),
        );
        let raw_maps = HashMap::from([
            ("D:/batch/good.jpg".into(), runtime_map(vec![good.clone()])),
            (
                "D:/batch/bad-one.jpg".into(),
                runtime_map(vec![raw_property.clone()]),
            ),
            (
                "D:/batch/bad-two.jpg".into(),
                runtime_map(vec![raw_property]),
            ),
        ]);
        let pretty_maps = HashMap::from([
            ("D:/batch/good.jpg".into(), runtime_map(vec![good])),
            (
                "D:/batch/bad-one.jpg".into(),
                runtime_map(vec![mismatched_pretty.clone()]),
            ),
            (
                "D:/batch/bad-two.jpg".into(),
                runtime_map(vec![mismatched_pretty]),
            ),
        ]);

        let outcome = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            ExifToolPassOutput {
                values_by_source: pretty_maps,
                failures_by_source: HashMap::new(),
            },
            ExifToolPassOutput {
                values_by_source: raw_maps,
                failures_by_source: HashMap::new(),
            },
            Some(&canonical_registry()),
            &mut Vec::new(),
        )
        .unwrap();

        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].relative_path, "good.jpg");
        assert_eq!(outcome.failures.len(), 2);
        assert!(outcome.failures.iter().all(|failure| failure
            .error_message
            .starts_with("Metadata canonicalisation failed:")));
        let grouped = group_metadata_failures(&outcome.failures);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped.values().next().unwrap().len(), 2);
    }

    #[test]
    fn test_worker_failure_grouping() {
        let outcome = MetadataBatchReadOutcome {
            results: vec![
                ImageMetadata {
                    relative_path: "good1.jpg".to_string(),
                    metadata: MetadataEntries(vec![]),
                },
                ImageMetadata {
                    relative_path: "good2.jpg".to_string(),
                    metadata: MetadataEntries(vec![]),
                },
            ],
            failures: vec![
                MetadataReadFailure {
                    relative_path: "bad1.jpg".to_string(),
                    error_message: "Error A".to_string(),
                },
                MetadataReadFailure {
                    relative_path: "bad2.jpg".to_string(),
                    error_message: "Error B".to_string(),
                },
                MetadataReadFailure {
                    relative_path: "bad3.jpg".to_string(),
                    error_message: "Error A".to_string(),
                },
            ],
        };

        assert_eq!(outcome.results[0].relative_path, "good1.jpg");
        assert_eq!(outcome.results[1].relative_path, "good2.jpg");

        let grouped = group_metadata_failures(&outcome.failures);

        assert_eq!(grouped.len(), 2);
        assert!(grouped.contains_key("Error A"));
        assert!(grouped.contains_key("Error B"));

        let affected_a = grouped.get("Error A").unwrap();
        assert_eq!(
            affected_a,
            &vec!["bad1.jpg".to_string(), "bad3.jpg".to_string()]
        );

        let affected_b = grouped.get("Error B").unwrap();
        assert_eq!(affected_b, &vec!["bad2.jpg".to_string()]);
    }
}
