/// Background folder scanning logic.
///
/// Three concerns are kept separate:
///  - `scan_folder`          — fast directory walk, path + OS metadata only.
///                             Calls a callback per file so callers can stream results.
///  - `read_image_metadata`  — reads metadata for a single file using ExifTool.
///  - `thumbnail_for`        — generates a thumbnail.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use walkdir::WalkDir;

// ── Timestamp helper ──────────────────────────────────────────────────────────

fn get_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap();
    let millis = now.as_millis();
    format!("{}.{:03}", millis / 1000, millis % 1000)
}

macro_rules! log_ts {
    ($($arg:tt)*) => {
        eprintln!("[{}] {}", get_timestamp(), format!($($arg)*))
    };
}

/// Like log_ts! but only emits when MEDIA_LIBRARY_VERBOSE is set.
macro_rules! log_verbose {
    ($($arg:tt)*) => {
        if crate::is_verbose() {
            eprintln!("[{}] [verbose] {}", get_timestamp(), format!($($arg)*))
        }
    };
}

// ── ExifTool path cache ───────────────────────────────────────────────────────

static EXIFTOOL_CMD: OnceLock<String> = OnceLock::new();

/// Locate the exiftool executable once and cache the result for the process
/// lifetime.  Logs the chosen path at normal verbosity on first call only.
fn find_exiftool() -> &'static str {
    EXIFTOOL_CMD.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            let candidates = [
                "exiftool.exe", // PATH first
                r"C:\Users\xman2\AppData\Local\Programs\ExifTool\ExifTool.exe",
                r"C:\Program Files\ExifTool\exiftool.exe",
                r"C:\Program Files\ExifTool\ExifTool.exe",
            ];
            for path in &candidates {
                let found = if path.contains('\\') {
                    std::path::Path::new(path).exists()
                } else {
                    Command::new(path).arg("-ver").output().is_ok()
                };
                if found {
                    log_ts!("[exiftool] Using: {}", path);
                    return path.to_string();
                }
            }
            log_ts!("[exiftool] Warning: not found in expected locations; will try 'exiftool.exe'");
            "exiftool.exe".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            log_ts!("[exiftool] Using: exiftool");
            "exiftool".to_string()
        }
    })
}

/// File extensions recognised as photos.
const PHOTO_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

/// A single photo entry from the directory walk.
/// Contains only path and OS metadata — Image metadata arrives separately via `read_image_metadata`.
#[derive(Debug, Clone, Serialize)]
pub struct PhotoInfo {
    pub relative_path: String,
    pub filename: String,
    pub date_modified: Option<i64>,
    pub date_created: Option<i64>,
}

/// A value in the image metadata.
/// Can be a string, a number, or a list of variants.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Variant {
    String(String),
    Number(f64),
    List(Vec<Variant>),
}

/// Image-level metadata for a single photo, delivered asynchronously after discovery.
/// Contains arbitrary key-value pairs from ExifTool.
#[derive(Debug, Clone, Serialize)]
pub struct ImageMetadata {
    pub relative_path: String,
    pub metadata: HashMap<String, Variant>,
}

/// Walk `folder` and call `on_photo` for each image file found.
/// Only reads OS metadata (a cheap `stat` call) — no image I/O.
/// Checks `cancellation_flag` and stops early if set to true.
pub fn scan_folder<F>(folder: &Path, cancellation_flag: Arc<AtomicBool>, mut on_photo: F)
where
    F: FnMut(PhotoInfo),
{
    for entry in WalkDir::new(folder).follow_links(false) {
        if cancellation_flag.load(Ordering::Relaxed) {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
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
/// We use the following flags:
///  -a: Allow duplicate tag names (to see all occurrences)
///  -G1: Group tags by location (e.g. [IFD0], [XMP-dc])
///  -s: Short tag names
///  --system:all: Exclude OS-level system tags
///  --composite:all: Exclude tags calculated by ExifTool (to see only original data)
///  -j: Output in JSON format
///
/// Returns Ok(results) on success, or Err(error_message) if ExifTool fails to execute.
pub fn read_image_metadata_batch(
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
) -> Result<Vec<ImageMetadata>, String> {
    if abs_paths.is_empty() {
        return Ok(Vec::new());
    }

    log_ts!("[exiftool] Reading {} files, first: {:?}", abs_paths.len(), abs_paths.first());

    // TEMPORARY: simulate slow metadata reading for load testing.
    #[cfg(not(test))]
    if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // find_exiftool() is called once and cached; subsequent calls are free.
    let exiftool_cmd = find_exiftool();

    let mut cmd = Command::new(exiftool_cmd);
    cmd.arg("-a")
        .arg("-G1")
        .arg("-s")
        .arg("--system:all")
        .arg("--composite:all")
        .arg("-j");

    for path in abs_paths {
        cmd.arg(path);
    }

    let output = cmd.output();

    match output {
        Ok(out) => {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                log_ts!("[exiftool] Command failed (status {:?}): {}", out.status, stderr);
                return Err(format!("ExifTool failed: {}", stderr));
            }

            let json = String::from_utf8_lossy(&out.stdout);
            log_ts!("[exiftool] Output: {} bytes", json.len());

            if !json.trim().is_empty() {
                log_verbose!("[exiftool] First 500 chars: {}", &json.chars().take(500).collect::<String>());
                Ok(parse_exiftool_batch_json(&json, rel_paths, abs_paths))
            } else {
                log_ts!("[exiftool] Warning: empty output for {} files", abs_paths.len());
                Ok(rel_paths
                    .iter()
                    .map(|r| ImageMetadata {
                        relative_path: r.clone(),
                        metadata: HashMap::new(),
                    })
                    .collect())
            }
        }
        Err(e) => {
            let error_msg = format!(
                "Failed to execute ExifTool: {}. Please ensure ExifTool is installed and accessible.", e
            );
            log_ts!("[exiftool] {}", error_msg);
            Err(error_msg)
        }
    }
}

fn parse_exiftool_batch_json(
    json: &str,
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
) -> Vec<ImageMetadata> {
    let list: Vec<HashMap<String, Variant>> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            // Without this log, an unparseable ExifTool response silently
            // produced empty metadata for every file in the batch with no
            // indication why.  Include a short prefix of the offending JSON
            // so the cause is diagnosable from the log.
            let preview: String = json.chars().take(200).collect();
            log_ts!(
                "[parse_exiftool] Failed to parse ExifTool JSON ({} files affected): {}. First 200 chars: {:?}",
                rel_paths.len(), e, preview
            );
            Vec::new()
        }
    };
    
    // Map ExifTool output by SourceFile
    let mut map_by_source = HashMap::new();
    for mut map in list {
        if let Some(Variant::String(source)) = map.remove("SourceFile") {
            let normalized_source = source.replace('\\', "/");
            map_by_source.insert(normalized_source, map);
        }
    }
    
    let mut results = Vec::with_capacity(rel_paths.len());
    
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let normalized_abs = abs_path.to_string_lossy().replace('\\', "/");
        
        // Look up metadata using normalized path
        let metadata = map_by_source.remove(&normalized_abs).unwrap_or_else(|| {
            log_ts!("[parse_exiftool] Warning: No metadata found for path: {}", normalized_abs);
            log_ts!("[parse_exiftool] Available keys: {:?}", map_by_source.keys().take(3).collect::<Vec<_>>());
            HashMap::new()
        });
        
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
/// 1. Try to extract embedded EXIF thumbnail (fast, ~10-50ms)
/// 2. Fall back to full decode and resize (slow, ~100-500ms in release, 2-4s in debug)
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
                // Try to load and resize if needed
                if let Ok(img) = image::load_from_memory(thumbnail_bytes) {
                    // Only resize if significantly larger than target
                    if img.width() > 160 || img.height() > 160 {
                        let resized = img.thumbnail(80, 80);
                        let mut buf = Vec::new();
                        resized.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg).ok()?;
                        return Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &buf));
                    } else {
                        // Use embedded thumbnail as-is
                        return Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, thumbnail_bytes));
                    }
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
    let thumb = img.thumbnail(80, 80);
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
        scan_folder(folder, Arc::new(AtomicBool::new(false)), |p| photos.push(p));
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
        scan_folder(dir.path(), Arc::new(AtomicBool::new(false)), |_| count += 1);
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
    fn parse_exiftool_json_test() {
        let json = r#"[{"SourceFile": "D:/test.jpg", "Number": 13.5, "String": "Yes", "List": ["A"]}]"#;
        let parsed: Result<Vec<std::collections::HashMap<String, Variant>>, _> = serde_json::from_str(json);
        assert!(parsed.is_ok(), "Failed to parse json: {:?}", parsed.err());
    }

    #[test]
    fn exif_thumbnail_is_extracted() {
        // Test with a checked-in sample image that has an embedded EXIF thumbnail
        // Path is relative to the workspace root (where Cargo.toml is located)
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let path = workspace_root.join("test_images/real_with_exif.jpg");
        
        if !path.exists() {
            panic!("Test image not found at {:?}. Please ensure test_images/real_with_exif.jpg exists in the repository.", path);
        }
        
        let result = extract_exif_thumbnail(&path);
        assert!(result.is_some(), "Expected to extract an EXIF thumbnail from the sample image");
        assert!(!result.unwrap().is_empty());
    }
}
