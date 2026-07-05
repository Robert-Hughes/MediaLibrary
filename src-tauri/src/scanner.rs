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
/// Two views of the same file, captured in one scan cycle (see `read_image_metadata_batch`):
///
/// - `metadata` — exiftool's pretty values (e.g. `Orientation = "Rotate 90 CW"`,
///   `ExposureTime = "1/250"`, `GPSLatitude = "51 deg 30' 26.16\" N"`).
///   What the UI displays in the details pane and column cells.
/// - `raw_metadata` — exiftool with `-n` (no PrintConv) for the same tags
///   (`Orientation = 6`, `ExposureTime = 0.004`, `GPSLatitude = 51.50726667`).
///   Used by editors for unambiguous binding and by the verifier for type-aware
///   equality after write-back. Empty until Phase 4/5 consumers wire it in;
///   populated by the scanner unconditionally so the data is there when those
///   consumers arrive.
///
/// Both are populated atomically — no half-loaded state. See
/// METADATA_FORMATS_DESIGN.md §4 for the full rationale.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImageMetadata {
    pub relative_path: String,
    pub metadata: HashMap<String, MetadataValue>,
    pub raw_metadata: HashMap<String, MetadataValue>,
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
/// Runs **two passes** per batch and merges them into one `ImageMetadata`
/// per file:
///
/// - Pass A: no `-n`. Pretty values — `Orientation = "Rotate 90 CW"`,
///   `ExposureTime = "1/250"`. Lands in `metadata`.
/// - Pass B: with `-n`. Raw values — `Orientation = 6`,
///   `ExposureTime = 0.004`. Lands in `raw_metadata`.
///
/// Both passes use the same flags otherwise, so the second pass is cheap
/// (exiftool startup dominates; the OS file cache is hot). They run
/// sequentially on the same worker — parallelism gains nothing because
/// startup, not CPU, is the cost. Pass A runs first because if Pass B
/// fails partway we still have something to show.
///
/// Failure of Pass A is a hard error (no display data → nothing to show).
/// Failure of Pass B is logged and we proceed with empty `raw_metadata`;
/// editors that need raw values can fall back to parsing the display.
///
/// Returns Ok(results) on Pass A success, Err(error_message) if Pass A
/// fails to execute.
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

    // Pass A: pretty values (no -n).
    let display_json_map = run_exiftool_pass(abs_paths, false)?;

    // Pass B: raw values (-n).  A failure here is non-fatal; we degrade
    // to empty raw_metadata.
    let raw_json_map = match run_exiftool_pass(abs_paths, true) {
        Ok(m) => m,
        Err(e) => {
            log::warn!(
                "[exiftool] Pass B (-n) failed ({}); raw_metadata will be empty for this batch",
                e
            );
            HashMap::new()
        }
    };

    // Merge by source path.
    let mut results = Vec::with_capacity(rel_paths.len());
    let mut display_json = display_json_map;
    let mut raw_json = raw_json_map;
    let registry = crate::tag_schema::get_registry().ok();
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let key = abs_path.to_string_lossy().replace('\\', "/");
        let display_values = display_json.remove(&key).unwrap_or_default();
        let raw_values = raw_json.remove(&key).unwrap_or_default();
        let metadata = semantic_values_from_json(&display_values, &raw_values, registry, false);
        let raw_metadata = semantic_values_from_json(&raw_values, &display_values, registry, true);
        if metadata.is_empty() {
            log::warn!("[parse_exiftool] Warning: no display metadata for {}", key);
        }
        results.push(ImageMetadata {
            relative_path: rel_path.clone(),
            metadata,
            raw_metadata,
        });
    }
    Ok(results)
}

/// Run one exiftool pass over `paths` and return a per-SourceFile map.
/// `numeric=true` adds `-n` to drop PrintConv formatting.
fn run_exiftool_pass(
    paths: &[std::path::PathBuf],
    numeric: bool,
) -> Result<HashMap<String, HashMap<String, serde_json::Value>>, String> {
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
            "Failed to execute ExifTool: {}. Please ensure ExifTool is installed and accessible.",
            e
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!(
            "[exiftool] Pass {} failed (status {:?}): {}",
            if numeric { "B(-n)" } else { "A" },
            output.status,
            stderr
        );
        return Err(format!("ExifTool failed: {}", stderr));
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

fn semantic_values_from_json(
    primary: &HashMap<String, serde_json::Value>,
    paired: &HashMap<String, serde_json::Value>,
    registry: Option<&crate::tag_schema::TagRegistry>,
    primary_is_raw: bool,
) -> HashMap<String, MetadataValue> {
    primary
        .iter()
        .map(|(key, raw)| {
            let info = registry.and_then(|r| r.lookup(key));
            let display = paired.get(key);
            let value = if primary_is_raw {
                parse_metadata_value(key, info.map(|i| &i.kind), raw, display)
            } else {
                parse_metadata_value(key, info.map(|i| &i.kind), raw, Some(raw))
            };
            (key.clone(), value)
        })
        .collect()
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

/// Legacy entry point retained for tests: takes JSON for one pass, the input
/// paths, and returns full `ImageMetadata` (with empty `raw_metadata`).
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
        let metadata = semantic_values_from_json(&display_values, &HashMap::new(), registry, false);
        results.push(ImageMetadata {
            relative_path: rel_path.clone(),
            metadata,
            raw_metadata: HashMap::new(),
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
        assert!(results.is_err() || results.unwrap().is_empty());
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

    fn binary_registry() -> crate::tag_schema::TagRegistry {
        // `from_listx_xml` applies the hand-curated override table at the end,
        // which inserts `IFD1:ThumbnailImage` as `TagKind::Binary` even when
        // listx itself didn't enumerate it. Empty taginfo is enough.
        crate::tag_schema::TagRegistry::from_listx_xml(
            "<?xml version='1.0' encoding='UTF-8'?><taginfo></taginfo>",
        )
        .expect("build empty registry")
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
}
