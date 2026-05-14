/// Background folder scanning logic.
///
/// Three concerns are kept separate:
///  - `scan_folder`          — fast directory walk, path + OS metadata only.
///                             Calls a callback per file so callers can stream results.
///  - `read_image_metadata`  — reads metadata for a single file using ExifTool.
///  - `thumbnail_for`        — generates a thumbnail.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use walkdir::WalkDir;


// ── ExifTool executable name ──────────────────────────────────────────────────

pub(crate) fn find_exiftool() -> &'static str {
    if cfg!(target_os = "windows") { "exiftool.exe" } else { "exiftool" }
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

/// A value in the image metadata.
///
/// Covers every JSON shape that exiftool's `-j` output can produce, plus the
/// internal shapes we want to round-trip through drafts and write-back.
///
/// Order of arms matters for `#[serde(untagged)]`: serde tries each in order
/// and picks the first that matches.  `Integer` must precede `Float` so `5`
/// stays an integer rather than becoming `5.0`.  `String` is last among the
/// scalar arms so numeric-looking JSON strings stay strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum Variant {
    Null,
    Bool(bool),
    // Tauri serialises i64 as a JSON number which JS parses as `number` (not
    // `bigint`), so override the ts-rs default of `bigint` here.  Risk is the
    // usual 2^53 precision ceiling, acceptable for EXIF/XMP integers.
    Integer(#[cfg_attr(test, ts(type = "number"))] i64),
    Float(f64),
    String(String),
    List(Vec<Variant>),
    Object(BTreeMap<String, Variant>),
}

/// Image-level metadata for a single photo, delivered asynchronously after discovery.
///
/// Two views of the same file, captured in one scan cycle (see `read_image_metadata_batch`):
///
/// - `metadata`     — exiftool's pretty values (e.g. `Orientation = "Rotate 90 CW"`,
///                    `ExposureTime = "1/250"`, `GPSLatitude = "51 deg 30' 26.16\" N"`).
///                    What the UI displays in the details pane and column cells.
/// - `raw_metadata` — exiftool with `-n` (no PrintConv) for the same tags
///                    (`Orientation = 6`, `ExposureTime = 0.004`, `GPSLatitude = 51.50726667`).
///                    Used by editors for unambiguous binding and by the
///                    verifier for type-aware equality after write-back.
///                    Empty until Phase 4/5 consumers wire it in; populated
///                    by the scanner unconditionally so the data is there
///                    when those consumers arrive.
///
/// Both are populated atomically — no half-loaded state. See
/// METADATA_FORMATS_DESIGN.md §4 for the full rationale.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImageMetadata {
    pub relative_path: String,
    pub metadata: HashMap<String, Variant>,
    pub raw_metadata: HashMap<String, Variant>,
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
)
where
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

        on_photo(PhotoInfo { relative_path: rel, filename, date_modified, date_created });
    }
}

/// Read OS-level file metadata: modified and created timestamps.
fn read_os_metadata(path: &Path) -> (Option<i64>, Option<i64>) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (None, None),
    };
    let modified = meta.modified().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
    });
    let created = meta.created().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
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
///                        round-trip into `Variant::Object` instead of being
///                        silently dropped.  Safe because the Variant enum
///                        supports `Object` as of Phase 1.
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

    log::info!("[exiftool] Reading {} files (two-pass), first: {:?}", abs_paths.len(), abs_paths.first());

    // TEMPORARY: simulate slow metadata reading for load testing.
    #[cfg(not(test))]
    if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // Pass A: pretty values (no -n).
    let display_map = run_exiftool_pass(abs_paths, false)?;

    // Pass B: raw values (-n).  A failure here is non-fatal; we degrade
    // to empty raw_metadata.
    let raw_map = match run_exiftool_pass(abs_paths, true) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("[exiftool] Pass B (-n) failed ({}); raw_metadata will be empty for this batch", e);
            HashMap::new()
        }
    };

    // Merge by source path.
    let mut results = Vec::with_capacity(rel_paths.len());
    let mut display = display_map;
    let mut raw = raw_map;
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let key = abs_path.to_string_lossy().replace('\\', "/");
        let metadata = display.remove(&key).unwrap_or_default();
        let raw_metadata = raw.remove(&key).unwrap_or_default();
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
) -> Result<HashMap<String, HashMap<String, Variant>>, String> {
    let exiftool_cmd = find_exiftool();
    let mut cmd = Command::new(exiftool_cmd);
    cmd.arg("-a")
        .arg("-G1")
        .arg("-s")
        .arg("-struct")
        .arg("-charset").arg("filename=utf8")
        .arg("-charset").arg("utf8")
        .arg("--system:all")
        .arg("--composite:all")
        .arg("-j");
    if numeric {
        cmd.arg("-n");
    }
    for path in paths {
        cmd.arg(path);
    }

    let output = cmd.output().map_err(|e| format!(
        "Failed to execute ExifTool: {}. Please ensure ExifTool is installed and accessible.", e
    ))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("[exiftool] Pass {} failed (status {:?}): {}",
            if numeric { "B(-n)" } else { "A" }, output.status, stderr);
        return Err(format!("ExifTool failed: {}", stderr));
    }

    let json = String::from_utf8_lossy(&output.stdout);
    if json.trim().is_empty() {
        return Ok(HashMap::new());
    }
    Ok(parse_exiftool_pass_json(&json))
}

/// Parse one exiftool `-j` array into a map keyed by normalized SourceFile path.
/// Per-entry isolation: a single bad entry logs and is skipped, leaving the
/// rest intact.
fn parse_exiftool_pass_json(json: &str) -> HashMap<String, HashMap<String, Variant>> {
    let raw_entries: Vec<serde_json::Value> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            let preview: String = json.chars().take(200).collect();
            log::error!(
                "[parse_exiftool] Failed to parse outer ExifTool JSON: {}. First 200 chars: {:?}",
                e, preview
            );
            return HashMap::new();
        }
    };

    let mut map_by_source: HashMap<String, HashMap<String, Variant>> = HashMap::new();
    for (idx, raw) in raw_entries.into_iter().enumerate() {
        let source = raw.get("SourceFile").and_then(|v| v.as_str()).map(|s| s.to_string());

        let mut map: HashMap<String, Variant> = match serde_json::from_value(raw) {
            Ok(m) => m,
            Err(e) => {
                log::warn!(
                    "[parse_exiftool] Skipping entry {} ({}): failed to parse as HashMap<String, Variant>: {}",
                    idx,
                    source.as_deref().unwrap_or("<no SourceFile>"),
                    e
                );
                continue;
            }
        };

        if let Some(Variant::String(s)) = map.remove("SourceFile") {
            map_by_source.insert(s.replace('\\', "/"), map);
        } else if let Some(s) = source {
            map_by_source.insert(s.replace('\\', "/"), map);
        } else {
            log::warn!("[parse_exiftool] Entry {} has no SourceFile; cannot map to a request path", idx);
        }
    }

    map_by_source
}

/// Legacy entry point retained for tests: takes JSON for one pass, the input
/// paths, and returns full `ImageMetadata` (with empty `raw_metadata`).
#[cfg(test)]
fn parse_exiftool_batch_json(
    json: &str,
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
) -> Vec<ImageMetadata> {
    let mut map_by_source = parse_exiftool_pass_json(json);
    let mut results = Vec::with_capacity(rel_paths.len());
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let normalized_abs = abs_path.to_string_lossy().replace('\\', "/");
        let metadata = map_by_source.remove(&normalized_abs).unwrap_or_else(|| {
            log::warn!("[parse_exiftool] Warning: No metadata found for path: {}", normalized_abs);
            HashMap::new()
        });
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
    let length_field = exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?;
    
    if let (exif::Value::Long(offsets), exif::Value::Long(lengths)) = 
        (&offset_field.value, &length_field.value) {
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
            if thumbnail_bytes.len() > 2 && thumbnail_bytes[0] == 0xFF && thumbnail_bytes[1] == 0xD8 {
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
                && data[i + 9] == 0 {
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
    thumb.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg).ok()?;
    Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn collect(folder: &Path) -> Vec<PhotoInfo> {
        let mut photos = Vec::new();
        scan_folder(folder, Arc::new(AtomicBool::new(false)), |p| photos.push(p), |_| {});
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
        let names = ["a.jpg", "b.jpeg", "c.png", "d.gif", "e.bmp", "f.webp", "g.tiff", "h.tif"];
        for name in &names { fs::write(dir.path().join(name), b"x").unwrap(); }
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
        for p in &photos { assert!(!p.relative_path.starts_with('/')); }
    }

    #[test]
    fn callback_is_called_for_each_photo() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        fs::write(dir.path().join("b.jpg"), b"x").unwrap();
        fs::write(dir.path().join("c.jpg"), b"x").unwrap();
        let mut count = 0;
        scan_folder(dir.path(), Arc::new(AtomicBool::new(false)), |_| count += 1, |_| {});
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
        assert!(!errors.is_empty(), "expected at least one WalkErrorInfo for a missing root");
        assert!(!errors[0].message.is_empty());
    }

    #[test]
    fn happy_path_walk_does_not_invoke_on_error(){
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
    fn parse_exiftool_json_test() {
        let json = r#"[{"SourceFile": "D:/test.jpg", "Number": 13.5, "String": "Yes", "List": ["A"]}]"#;
        let parsed: Result<Vec<std::collections::HashMap<String, Variant>>, _> = serde_json::from_str(json);
        assert!(parsed.is_ok(), "Failed to parse json: {:?}", parsed.err());
    }

    #[test]
    fn parse_exiftool_preserves_nested_objects() {
        // Variant::Object now accepts nested objects (e.g. QuickTime Keys group,
        // mwg-rs face regions).  Previously this entry would have failed to
        // deserialize and dropped the whole batch.
        let json = r#"[
            {"SourceFile": "D:/a.jpg", "Tag": "ok"},
            {"SourceFile": "D:/b.mov", "Keys": {"creator": "alice", "year": 2024}},
            {"SourceFile": "D:/c.jpg", "Tag": "ok"}
        ]"#;
        let rel = vec!["a.jpg".to_string(), "b.mov".to_string(), "c.jpg".to_string()];
        let abs = vec![
            std::path::PathBuf::from("D:/a.jpg"),
            std::path::PathBuf::from("D:/b.mov"),
            std::path::PathBuf::from("D:/c.jpg"),
        ];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        assert_eq!(results.len(), 3);
        let b = results.iter().find(|r| r.relative_path == "b.mov").unwrap();
        match b.metadata.get("Keys") {
            Some(Variant::Object(m)) => {
                assert!(matches!(m.get("creator"), Some(Variant::String(s)) if s == "alice"));
                assert!(matches!(m.get("year"), Some(Variant::Integer(2024))));
            }
            other => panic!("expected Variant::Object for Keys, got {:?}", other),
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
        assert!(matches!(a.metadata.get("Tag"), Some(Variant::String(s)) if s == "ok"));
        assert!(matches!(c.metadata.get("Tag"), Some(Variant::String(s)) if s == "ok"));
    }

    #[test]
    fn variant_integer_takes_precedence_over_float() {
        let v: Variant = serde_json::from_str("5").unwrap();
        assert_eq!(v, Variant::Integer(5));
    }

    #[test]
    fn variant_float_for_fractional() {
        let v: Variant = serde_json::from_str("5.6").unwrap();
        match v {
            Variant::Float(f) => assert!((f - 5.6).abs() < 1e-9),
            other => panic!("expected Float, got {:?}", other),
        }
    }

    #[test]
    fn variant_bool_roundtrip() {
        let v: Variant = serde_json::from_str("true").unwrap();
        assert_eq!(v, Variant::Bool(true));
        let s = serde_json::to_string(&Variant::Bool(false)).unwrap();
        assert_eq!(s, "false");
    }

    #[test]
    fn variant_null_roundtrip() {
        let v: Variant = serde_json::from_str("null").unwrap();
        assert_eq!(v, Variant::Null);
        let s = serde_json::to_string(&Variant::Null).unwrap();
        assert_eq!(s, "null");
    }

    #[test]
    fn variant_string_roundtrip() {
        let v: Variant = serde_json::from_str("\"hello\"").unwrap();
        assert_eq!(v, Variant::String("hello".to_string()));
    }

    #[test]
    fn variant_list_roundtrip() {
        let v: Variant = serde_json::from_str("[1, \"two\", false]").unwrap();
        assert_eq!(
            v,
            Variant::List(vec![
                Variant::Integer(1),
                Variant::String("two".to_string()),
                Variant::Bool(false),
            ])
        );
    }

    #[test]
    fn variant_nested_object_roundtrip() {
        let json = r#"{"name": "alice", "age": 30, "tags": ["a", "b"]}"#;
        let v: Variant = serde_json::from_str(json).unwrap();
        match v {
            Variant::Object(m) => {
                assert!(matches!(m.get("name"), Some(Variant::String(s)) if s == "alice"));
                assert!(matches!(m.get("age"), Some(Variant::Integer(30))));
                assert!(matches!(m.get("tags"), Some(Variant::List(_))));
            }
            other => panic!("expected Object, got {:?}", other),
        }
    }

    #[test]
    fn variant_large_integer_preserved_as_integer() {
        let v: Variant = serde_json::from_str("4404019").unwrap();
        assert_eq!(v, Variant::Integer(4404019));
    }

    #[test]
    fn parse_pass_json_keys_results_by_normalized_source() {
        let json = r#"[
            {"SourceFile": "D:\\a.jpg", "Tag": "X"},
            {"SourceFile": "D:/b.jpg", "Tag": "Y"}
        ]"#;
        let map = parse_exiftool_pass_json(json);
        assert_eq!(map.len(), 2);
        assert!(matches!(map.get("D:/a.jpg").and_then(|m| m.get("Tag")),
            Some(Variant::String(s)) if s == "X"));
        assert!(matches!(map.get("D:/b.jpg").and_then(|m| m.get("Tag")),
            Some(Variant::String(s)) if s == "Y"));
    }

    #[test]
    fn parse_pass_json_handles_struct_values() {
        // Pass A typically returns nested Keys / regions structs.
        let json = r#"[{"SourceFile":"D:/a.mov","Keys":{"creator":"alice"}}]"#;
        let map = parse_exiftool_pass_json(json);
        match map.get("D:/a.mov").and_then(|m| m.get("Keys")) {
            Some(Variant::Object(_)) => {}
            other => panic!("expected Object, got {:?}", other),
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
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let path = workspace_root.join("test_images/real_with_exif.jpg");

        if !path.exists() {
            panic!("Test image not found at {:?}. Please ensure test_images/real_with_exif.jpg exists in the repository.", path);
        }

        let result = extract_exif_thumbnail(&path);
        assert!(result.is_none(), "Embedded thumbnail is < 160 px; should have been rejected");

        // thumbnail_for should still succeed via the full-decode fallback
        let thumb = thumbnail_for(&path);
        assert!(thumb.is_some(), "Expected thumbnail_for to succeed via full decode");
        assert!(!thumb.unwrap().is_empty());
    }

    #[test]
    fn exif_thumbnail_large_enough_is_used() {
        // large_with_exif.jpg has a 200×150 embedded thumbnail (≥ 160 px),
        // so extract_exif_thumbnail should return it directly.
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let path = workspace_root.join("test_images/large_with_exif.jpg");

        if !path.exists() {
            panic!("Test image not found at {:?}. Please ensure test_images/large_with_exif.jpg exists in the repository.", path);
        }

        let result = extract_exif_thumbnail(&path);
        assert!(result.is_some(), "Expected embedded thumbnail (200×150) to be accepted (≥ 160 px)");
        assert!(!result.unwrap().is_empty());
    }
}
