/// Background folder scanning logic.
///
/// Scanning (file discovery) and thumbnail generation are intentionally
/// separate concerns:
///
///  - `scan_folder`  — fast directory walk, returns paths + file metadata.
///                     No image decoding.
///  - `thumbnail_for` — generates a single thumbnail; tries the EXIF
///                      embedded thumbnail first (cheap), falls back to
///                      full decode + resize only when necessary.
use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

/// File extensions recognised as photos.
const PHOTO_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

/// A single photo entry discovered during a folder scan.
/// Thumbnails are NOT included here — they are generated separately and
/// delivered via `thumbnail_ready` events.
#[derive(Debug, Clone, Serialize)]
pub struct PhotoInfo {
    /// Path relative to the scanned root folder (forward-slash separated).
    pub relative_path: String,
    /// Filename only (last component of relative_path).
    pub filename: String,

    // ── OS / filesystem metadata ──────────────────────────────────────────
    /// Last-modified time as a Unix timestamp (seconds), or None if unavailable.
    pub date_modified: Option<i64>,
    /// Creation time as a Unix timestamp (seconds), or None if unavailable.
    pub date_created: Option<i64>,

    // ── EXIF / inner metadata ─────────────────────────────────────────────
    /// DateTimeOriginal from EXIF (ISO 8601 string), or None if unavailable.
    pub date_taken: Option<String>,
    /// Camera make + model from EXIF, or None if unavailable.
    pub camera_model: Option<String>,
}

/// Scan `folder` recursively and return all photo files found, sorted by path.
/// Emits progress via the provided callback after each file is found.
/// Reads OS metadata for each file; no image decoding is performed.
pub fn scan_folder<F>(folder: &Path, mut on_progress: F) -> Vec<PhotoInfo>
where
    F: FnMut(usize),
{
    let mut photos = Vec::new();

    for entry in WalkDir::new(folder).follow_links(false) {
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
        let (date_taken, camera_model) = read_exif_metadata(path);

        photos.push(PhotoInfo {
            relative_path: rel,
            filename,
            date_modified,
            date_created,
            date_taken,
            camera_model,
        });
        on_progress(photos.len());
    }

    photos.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    photos
}

/// Read OS-level file metadata: modified and created timestamps.
fn read_os_metadata(path: &Path) -> (Option<i64>, Option<i64>) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (None, None),
    };

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64)
        });

    let created = meta
        .created()
        .ok()
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64)
        });

    (modified, created)
}

/// Read EXIF metadata: date taken and camera model.
/// Only attempted for JPEG files; returns (None, None) for other formats.
fn read_exif_metadata(path: &Path) -> (Option<String>, Option<String>) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    if !matches!(ext.as_deref(), Some("jpg") | Some("jpeg")) {
        return (None, None);
    }

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let mut bufreader = std::io::BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut bufreader) {
        Ok(e) => e,
        Err(_) => return (None, None),
    };

    // DateTimeOriginal (tag 0x9003) — when the shutter was pressed.
    let date_taken = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string());

    // Build "Make Model" string, deduplicating if make is already in model.
    let make = exif
        .get_field(exif::Tag::Make, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string().trim_matches('"').to_owned());

    let model = exif
        .get_field(exif::Tag::Model, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string().trim_matches('"').to_owned());

    let camera_model = match (make, model) {
        (Some(mk), Some(mo)) => {
            if mo.to_lowercase().starts_with(&mk.to_lowercase()) {
                Some(mo)
            } else {
                Some(format!("{mk} {mo}"))
            }
        }
        (None, Some(mo)) => Some(mo),
        (Some(mk), None) => Some(mk),
        (None, None) => None,
    };

    (date_taken, camera_model)
}

/// Generate a base64-encoded JPEG thumbnail for the image at `path`.
///
/// Strategy:
///  1. For JPEG files, attempt to extract the embedded EXIF thumbnail.
///  2. Fall back to full decode + resize for other formats or missing EXIF.
pub fn thumbnail_for(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    if matches!(ext.as_deref(), Some("jpg") | Some("jpeg")) {
        if let Some(b64) = exif_thumbnail(path) {
            return Some(b64);
        }
    }

    full_decode_thumbnail(path)
}

fn exif_thumbnail(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bufreader = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut bufreader).ok()?;

    let offset_field = exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?;
    let offset = match offset_field.value {
        exif::Value::Long(ref v) if !v.is_empty() => v[0] as usize,
        _ => return None,
    };

    let len_field = exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?;
    let len = match len_field.value {
        exif::Value::Long(ref v) if !v.is_empty() => v[0] as usize,
        _ => return None,
    };

    let buf = exif.buf();
    let end = offset.checked_add(len)?;
    if end > buf.len() {
        return None;
    }

    let thumb_bytes = &buf[offset..end];
    if thumb_bytes.is_empty() {
        return None;
    }

    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        thumb_bytes,
    ))
}

fn full_decode_thumbnail(path: &Path) -> Option<String> {
    let img = image::open(path).ok()?;
    let thumb = img.thumbnail(80, 80);
    let mut buf = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
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

    fn no_progress(_: usize) {}

    // ── scan_folder ───────────────────────────────────────────────────────────

    #[test]
    fn empty_folder_returns_no_photos() {
        let dir = tempdir().unwrap();
        assert!(scan_folder(dir.path(), no_progress).is_empty());
    }

    #[test]
    fn non_image_files_are_ignored() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("readme.txt"), b"hello").unwrap();
        fs::write(dir.path().join("data.csv"), b"a,b,c").unwrap();
        assert!(scan_folder(dir.path(), no_progress).is_empty());
    }

    #[test]
    fn all_supported_extensions_are_found() {
        let dir = tempdir().unwrap();
        let names = ["a.jpg", "b.jpeg", "c.png", "d.gif", "e.bmp", "f.webp", "g.tiff", "h.tif"];
        for name in &names {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        assert_eq!(scan_folder(dir.path(), no_progress).len(), names.len());
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("A.JPG"), b"x").unwrap();
        fs::write(dir.path().join("B.PNG"), b"x").unwrap();
        assert_eq!(scan_folder(dir.path(), no_progress).len(), 2);
    }

    #[test]
    fn subdirectories_are_scanned_recursively() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("vacation").join("beach");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("sunset.jpg"), b"x").unwrap();
        fs::write(dir.path().join("portrait.png"), b"x").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert_eq!(photos.len(), 2);
        for p in &photos {
            assert!(!p.relative_path.starts_with('/'));
        }
    }

    #[test]
    fn results_are_sorted_alphabetically() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("z.jpg"), b"x").unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        fs::write(dir.path().join("m.jpg"), b"x").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        let names: Vec<&str> = photos.iter().map(|p| p.relative_path.as_str()).collect();
        assert_eq!(names, vec!["a.jpg", "m.jpg", "z.jpg"]);
    }

    #[test]
    fn progress_callback_is_called_for_each_photo() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        fs::write(dir.path().join("b.jpg"), b"x").unwrap();
        fs::write(dir.path().join("c.jpg"), b"x").unwrap();
        let mut counts = Vec::new();
        scan_folder(dir.path(), |n| counts.push(n));
        assert_eq!(counts.len(), 3);
    }

    #[test]
    fn filename_field_is_populated() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert_eq!(photos[0].filename, "photo.jpg");
    }

    #[test]
    fn os_metadata_is_populated_for_real_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        // date_modified should be Some — we just wrote the file.
        assert!(photos[0].date_modified.is_some());
    }

    #[test]
    fn exif_metadata_is_none_for_non_jpeg() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.png"), b"x").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert!(photos[0].date_taken.is_none());
        assert!(photos[0].camera_model.is_none());
    }

    #[test]
    fn exif_metadata_is_none_for_jpeg_without_exif() {
        let dir = tempdir().unwrap();
        // Write a minimal valid JPEG with no EXIF.
        let path = dir.path().join("noexif.jpg");
        let img = image::RgbImage::new(1, 1);
        img.save(&path).unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert!(photos[0].date_taken.is_none());
        assert!(photos[0].camera_model.is_none());
    }

    // ── thumbnail_for ─────────────────────────────────────────────────────────

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
}
