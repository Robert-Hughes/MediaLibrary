/// Background folder scanning logic.
///
/// Three concerns are kept separate:
///  - `scan_folder` — fast directory walk, path + OS metadata only. Calls a
///    callback per file so callers can stream results.
///  - `read_image_metadata` — reads metadata for a single file using ExifTool.
///  - `thumbnail_for` — generates a thumbnail.
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use walkdir::WalkDir;

use crate::metadata_value::{parse_metadata_value, MetadataValue};

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
    pub metadata: HashMap<String, MetadataValue>,
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
///  -G1                   Group tags by location (e.g. IFD0:Make, XMP-dc:Subject).
///                        G1 is the specific block; format family (G0) is
///                        implicit in the prefix.
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
/// Both passes use the same flags otherwise, so the second pass is cheap
/// (exiftool startup dominates; the OS file cache is hot). They run
/// sequentially on the same worker — parallelism gains nothing because
/// startup, not CPU, is the cost.
///
/// Both passes are required. If either pass fails, the batch fails and the
/// frontend receives a metadata worker error for the affected files.
///
/// Returns Ok(results) when both passes succeed, Err(error_message) otherwise.
pub fn read_image_metadata_batch(
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
) -> Result<Vec<ImageMetadata>, String> {
    if abs_paths.is_empty() {
        return Ok(Vec::new());
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
    let display_json_map = run_exiftool_pass(abs_paths, false)
        .map_err(|e| format!("ExifTool display pass failed: {}", e))?;

    // Pass B: raw values (-n), the primary canonical source.
    let raw_json_map = run_exiftool_pass(abs_paths, true)
        .map_err(|e| format!("ExifTool raw (-n) pass failed: {}", e))?;

    // Merge by source path.
    let mut results = Vec::with_capacity(rel_paths.len());
    let mut display_json = display_json_map;
    let mut raw_json = raw_json_map;
    let registry = crate::tag_schema::get_registry().ok();
    let mut batch_warnings = Vec::new();
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let key = abs_path.to_string_lossy().replace('\\', "/");
        let display_values = display_json.remove(&key).unwrap_or_default();
        let raw_values = raw_json.remove(&key).unwrap_or_default();
        let metadata =
            canonical_values_from_exiftool_pair(&raw_values, &display_values, registry, rel_path, Some(&mut batch_warnings));
        if metadata.is_empty() {
            log::warn!(
                "[parse_exiftool] Warning: no canonical metadata for {}",
                key
            );
        }
        results.push(ImageMetadata {
            relative_path: rel_path.clone(),
            metadata,
        });
    }

    if !batch_warnings.is_empty() {
        log_aggregated_warnings(&batch_warnings);
    }

    Ok(results)
}

/// Run one exiftool pass over `paths` and return a per-SourceFile map.
/// `numeric=true` adds `-n` to drop PrintConv formatting.
fn run_exiftool_pass(
    paths: &[std::path::PathBuf],
    numeric: bool,
) -> Result<HashMap<String, HashMap<String, serde_json::Value>>, String> {
    let pass_label = if numeric {
        "raw (-n) pass"
    } else {
        "display pass"
    };
    let mut cmd = crate::exiftool_config::exiftool_command();
    cmd.arg("-a")
        .arg("-G1")
        .arg("-s")
        .arg("-struct")
        .arg("-charset")
        .arg("filename=utf8")
        .arg("-charset")
        .arg("utf8")
        .arg("--system:all")
        .arg("--composite:all")
        .arg("-j");
    if numeric {
        cmd.arg("-n");
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
        return Ok(HashMap::new());
    }
    Ok(parse_exiftool_pass_json_raw(&json))
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
fn parse_exiftool_pass_json_raw(json: &str) -> HashMap<String, HashMap<String, serde_json::Value>> {
    parse_exiftool_pass_json_raw_with_registry(json, crate::tag_schema::get_registry().ok())
}

fn parse_exiftool_pass_json_raw_with_registry(
    json: &str,
    registry: Option<&crate::tag_schema::TagRegistry>,
) -> HashMap<String, HashMap<String, serde_json::Value>> {
    let raw_entries: Vec<serde_json::Value> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            let preview: String = json.chars().take(200).collect();
            log::error!(
                "[parse_exiftool] Failed to parse outer ExifTool JSON: {}. First 200 chars: {:?}",
                e,
                preview
            );
            return HashMap::new();
        }
    };

    let mut map_by_source: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
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

        let mut map: HashMap<String, serde_json::Value> = HashMap::with_capacity(obj.len());
        for (key, val) in obj {
            // ExifTool's raw placeholder ("(Binary data N bytes, use -b
            // option to extract)") is confusing in the UI: Media Library
            // users don't invoke exiftool directly, so the `-b` advice is
            // noise. Substitute a neutral "<binary>" string so the field
            // is clearly non-textual without leaking the tool name.
            //
            // Primary check is the schema (TagKind::Binary). The regex
            // fallback catches tags `-listx` does not enumerate — most
            // notably exiftool's synthetic `File:` group (PreviewImage,
            // ThumbnailImage, JpgFromRaw, etc.) which is built from file
            // parsing rather than spec tables.
            let value = if is_binary_tag(&key, registry) || is_exiftool_binary_placeholder(&val) {
                serde_json::Value::String("<binary>".to_string())
            } else {
                val
            };
            map.insert(key, value);
        }

        if let Some(s) = map.remove("SourceFile").and_then(|v| match v {
            serde_json::Value::String(s) => Some(s),
            _ => None,
        }) {
            map_by_source.insert(s.replace('\\', "/"), map);
        } else if let Some(s) = source {
            map_by_source.insert(s.replace('\\', "/"), map);
        } else {
            log::warn!(
                "[parse_exiftool] Entry {} has no SourceFile; cannot map to a request path",
                idx
            );
        }
    }

    map_by_source
}

struct ParseWarning {
    rel_path: String,
    tag: String,
    pass_name: String,
    expected: String,
    raw_type: &'static str,
    raw: serde_json::Value,
    reason: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WarningGroupKey {
    tag: String,
    reason: String,
    expected_summary: String,
    raw_type: &'static str,
}

struct WarningGroupValue {
    count: usize,
    examples: Vec<String>,
    raw_preview: Option<String>,
}

fn log_aggregated_warnings(warnings: &[ParseWarning]) {
    let mut groups: HashMap<WarningGroupKey, WarningGroupValue> = HashMap::new();
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

fn canonical_values_from_exiftool_pair(
    raw_values: &HashMap<String, serde_json::Value>,
    display_values: &HashMap<String, serde_json::Value>,
    registry: Option<&crate::tag_schema::TagRegistry>,
    rel_path: &str,
    mut warnings_accumulator: Option<&mut Vec<ParseWarning>>,
) -> HashMap<String, MetadataValue> {
    let mut values = HashMap::with_capacity(raw_values.len().max(display_values.len()));

    for key in raw_values.keys().chain(display_values.keys()) {
        if values.contains_key(key) {
            continue;
        }
        let primary = raw_values
            .get(key)
            .or_else(|| display_values.get(key))
            .expect("key came from one of the source maps");
        let display_hint = display_values.get(key);
        let info = registry.and_then(|r| r.lookup(key));
        let value = parse_metadata_value(key, info.map(|i| &i.kind), primary, display_hint);
        warn_unknown_metadata_value(rel_path, key, "canonical", primary, info, &value, warnings_accumulator.as_mut().map(|w| &mut **w));
        values.insert(key.clone(), value);
    }

    values
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

fn is_binary_tag(key: &str, registry: Option<&crate::tag_schema::TagRegistry>) -> bool {
    registry
        .and_then(|r| r.lookup(key))
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
    let mut map_by_source = parse_exiftool_pass_json_raw_with_registry(json, registry);
    let mut results = Vec::with_capacity(rel_paths.len());
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let normalized_abs = abs_path.to_string_lossy().replace('\\', "/");
        let display_values = map_by_source.remove(&normalized_abs).unwrap_or_else(|| {
            log::warn!(
                "[parse_exiftool] Warning: No metadata found for path: {}",
                normalized_abs
            );
            HashMap::new()
        });
        let metadata = canonical_values_from_exiftool_pair(
            &HashMap::new(),
            &display_values,
            registry,
            rel_path,
            None,
        );
        results.push(ImageMetadata {
            relative_path: rel_path.clone(),
            metadata,
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
            {"SourceFile": "D:/a.jpg", "Tag": "ok"},
            {"SourceFile": "D:/b.mov", "Keys": {"creator": "alice", "year": 2024}},
            {"SourceFile": "D:/c.jpg", "Tag": "ok"}
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
        match b.metadata.get("Keys") {
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
            {"SourceFile": "D:/a.jpg", "Tag": "ok"},
            [1, 2, 3],
            {"SourceFile": "D:/c.jpg", "Tag": "ok"}
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
        assert!(matches!(
            a.metadata.get("Tag"),
            Some(MetadataValue::Unknown { raw, .. }) if raw == &serde_json::json!("ok")
        ));
        assert!(matches!(
            c.metadata.get("Tag"),
            Some(MetadataValue::Unknown { raw, .. }) if raw == &serde_json::json!("ok")
        ));
    }

    #[test]
    fn parse_pass_json_keys_results_by_normalized_source() {
        let json = r#"[
            {"SourceFile": "D:\\a.jpg", "Tag": "X"},
            {"SourceFile": "D:/b.jpg", "Tag": "Y"}
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
        let json = r#"[{"SourceFile":"D:/a.mov","Keys":{"creator":"alice"}}]"#;
        let map = parse_exiftool_pass_json_raw(json);
        assert_eq!(
            map.get("D:/a.mov").and_then(|m| m.get("Keys")),
            Some(&serde_json::json!({"creator": "alice"}))
        );
    }

    #[test]
    fn parse_pass_json_raw_keeps_exiftool_boundary_as_json() {
        let json = r#"[{"SourceFile":"D:/a.jpg","Int":5,"Real":1.5,"Obj":{"x":true}}]"#;
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
            "IPTC:TimeCreated": "10:56:05",
            "ExifIFD:OffsetTimeOriginal": "+01:00",
            "MadeUp:Thing": 5
        }]"#;
        let rel = vec!["a.jpg".to_string()];
        let abs = vec![std::path::PathBuf::from("D:/a.jpg")];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        let image = &results[0];
        assert!(matches!(
            image.metadata.get("IPTC:TimeCreated"),
            Some(MetadataValue::Time(t)) if t.offset.is_none()
        ));
        assert!(matches!(
            image.metadata.get("ExifIFD:OffsetTimeOriginal"),
            Some(MetadataValue::TimeOffset(_))
        ));
        assert!(matches!(
            image.metadata.get("MadeUp:Thing"),
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
</taginfo>"#,
        )
        .expect("build canonical test registry")
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

        let values = canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

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

        let values = canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

        match values.get("EXIF:ExposureTime") {
            Some(MetadataValue::Rational(r)) => {
                assert_eq!(r.numerator, 1);
                assert_eq!(r.denominator, 64);
            }
            other => panic!("expected rational 1/64, got {:?}", other),
        }
    }

    #[test]
    fn canonical_includes_display_only_fallback_value() {
        let reg = canonical_registry();
        let raw = HashMap::new();
        let display = HashMap::from([("EXIF:Model".to_string(), serde_json::json!("X100V"))]);

        let values = canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

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

        let values = canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

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

        let values = canonical_values_from_exiftool_pair(&raw, &display, Some(&reg), "photo.jpg", None);

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
            "IFD1:ThumbnailImage": "(Binary data 3965 bytes, use -b option to extract)",
            "EXIF:Make": "Canon"
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
            "File:PreviewImage": "(Binary data 105557 bytes, use -b option to extract)"
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
            "IFD1:ThumbnailImage": "(Binary data 3965 bytes, use -b option to extract)"
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
            "EXIF:ImageDescription": "Note: the exiftool stub reads \"(Binary data 99 bytes, use -b option to extract)\" in this field."
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
    fn test_warning_classification_and_aggregation() {
        // Classification
        assert_eq!(classify_warning("no schema entry for tag"), ParseWarningCategory::MissingSchema);
        assert_eq!(classify_warning("schema kind is unknown"), ParseWarningCategory::UnknownSchemaKind);
        assert_eq!(classify_warning("expected JSON integer for integer tag"), ParseWarningCategory::ParseFailed);

        // Aggregation
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

        // Let's call log_aggregated_warnings to make sure it doesn't panic
        log_aggregated_warnings(&warnings);
    }
}
