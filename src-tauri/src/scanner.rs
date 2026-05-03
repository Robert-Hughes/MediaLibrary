/// Background folder scanning logic.
///
/// Scanning (file discovery) and thumbnail generation are intentionally
/// separate concerns:
///
///  - `scan_folder`  — fast directory walk, returns paths only, no I/O on
///                     image content.
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
}

/// Scan `folder` recursively and return all photo files found, sorted by path.
/// Emits progress via the provided callback after each file is found.
/// No image decoding is performed here — this should be very fast.
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

        photos.push(PhotoInfo { relative_path: rel });
        on_progress(photos.len());
    }

    photos.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    photos
}

/// Generate a base64-encoded JPEG thumbnail for the image at `path`.
///
/// Strategy:
///  1. For JPEG files, attempt to extract the embedded EXIF thumbnail.
///     This reads only a few KB from the start of the file and is very fast.
///  2. If that fails (non-JPEG, no EXIF, or corrupt EXIF), fall back to
///     fully decoding the image and resizing it.
///
/// Returns `None` if both strategies fail, so callers can show a placeholder.
pub fn thumbnail_for(path: &Path) -> Option<String> {
    // Try EXIF fast-path for JPEG files first.
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    if matches!(ext.as_deref(), Some("jpg") | Some("jpeg")) {
        if let Some(b64) = exif_thumbnail(path) {
            return Some(b64);
        }
    }

    // Full decode fallback for all other formats (or JPEG without EXIF thumb).
    full_decode_thumbnail(path)
}

/// Extract the embedded EXIF thumbnail from a JPEG and return it as base64.
/// In kamadak-exif 0.5, the raw TIFF buffer is exposed via `exif.buf()`.
/// The thumbnail IFD (IFD1) stores JPEGInterchangeFormat (offset) and
/// JPEGInterchangeFormatLength (byte count) tags that point into that buffer.
fn exif_thumbnail(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bufreader = std::io::BufReader::new(file);
    let exif_reader = exif::Reader::new();
    let exif = exif_reader.read_from_container(&mut bufreader).ok()?;

    // JPEGInterchangeFormat = offset of thumbnail JPEG data within the TIFF buffer.
    let offset_field = exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?;
    let offset = match offset_field.value {
        exif::Value::Long(ref v) if !v.is_empty() => v[0] as usize,
        _ => return None,
    };

    // JPEGInterchangeFormatLength = byte length of the thumbnail JPEG.
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

/// Fully decode the image, resize to thumbnail dimensions, and return as base64 JPEG.
fn full_decode_thumbnail(path: &Path) -> Option<String> {
    let img = image::open(path).ok()?;
    let thumb = img.thumbnail(80, 80);

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

    fn no_progress(_: usize) {}

    // ── scan_folder ───────────────────────────────────────────────────────────

    #[test]
    fn empty_folder_returns_no_photos() {
        let dir = tempdir().unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert!(photos.is_empty());
    }

    #[test]
    fn non_image_files_are_ignored() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("readme.txt"), b"hello").unwrap();
        fs::write(dir.path().join("data.csv"), b"a,b,c").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert!(photos.is_empty());
    }

    #[test]
    fn all_supported_extensions_are_found() {
        let dir = tempdir().unwrap();
        let names = ["a.jpg", "b.jpeg", "c.png", "d.gif", "e.bmp", "f.webp", "g.tiff", "h.tif"];
        for name in &names {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        let photos = scan_folder(dir.path(), no_progress);
        assert_eq!(photos.len(), names.len());
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("A.JPG"), b"x").unwrap();
        fs::write(dir.path().join("B.PNG"), b"x").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert_eq!(photos.len(), 2);
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
    fn scan_returns_no_thumbnails() {
        // scan_folder must not do any image decoding — PhotoInfo has no thumbnail field.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"fake").unwrap();
        let photos = scan_folder(dir.path(), no_progress);
        assert_eq!(photos.len(), 1);
        // Compile-time check: PhotoInfo only has relative_path.
        let _ = &photos[0].relative_path;
    }

    // ── thumbnail_for ─────────────────────────────────────────────────────────

    #[test]
    fn thumbnail_returns_none_for_corrupt_file() {
        let dir = tempdir().unwrap();
        // Write garbage bytes — not a valid image.
        fs::write(dir.path().join("bad.jpg"), b"not an image").unwrap();
        let result = thumbnail_for(&dir.path().join("bad.jpg"));
        assert!(result.is_none());
    }

    #[test]
    fn thumbnail_returns_none_for_corrupt_png() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("bad.png"), b"not a png").unwrap();
        let result = thumbnail_for(&dir.path().join("bad.png"));
        assert!(result.is_none());
    }

    #[test]
    fn thumbnail_returns_some_for_valid_png() {
        // Create a minimal valid 1x1 PNG using the image crate.
        let dir = tempdir().unwrap();
        let path = dir.path().join("pixel.png");
        let img = image::RgbImage::new(1, 1);
        img.save(&path).unwrap();
        let result = thumbnail_for(&path);
        assert!(result.is_some(), "expected a thumbnail for a valid PNG");
        // Result should be non-empty base64.
        assert!(!result.unwrap().is_empty());
    }
}
