/// Background folder scanning logic.
///
/// Three concerns are kept separate:
///  - `scan_folder`     — fast directory walk, path + OS metadata only.
///                        Calls a callback per file so callers can stream results.
///  - `read_exif`       — reads EXIF metadata for a single file (JPEG only).
///  - `thumbnail_for`   — generates a thumbnail (EXIF embedded or full decode).
use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

/// File extensions recognised as photos.
const PHOTO_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

/// A single photo entry from the directory walk.
/// Contains only path and OS metadata — EXIF arrives separately via `read_exif`.
#[derive(Debug, Clone, Serialize)]
pub struct PhotoInfo {
    pub relative_path: String,
    pub filename: String,
    pub date_modified: Option<i64>,
    pub date_created: Option<i64>,
}

/// EXIF metadata for a single photo, delivered asynchronously after discovery.
#[derive(Debug, Clone, Serialize)]
pub struct ExifInfo {
    pub relative_path: String,
    pub date_taken: Option<String>,
    pub camera_model: Option<String>,
}

/// Walk `folder` and call `on_photo` for each image file found.
/// Only reads OS metadata (a cheap `stat` call) — no image I/O.
pub fn scan_folder<F>(folder: &Path, mut on_photo: F)
where
    F: FnMut(PhotoInfo),
{
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

/// Read EXIF metadata for a single file.
/// Only meaningful for JPEG files; returns empty ExifInfo for other formats.
pub fn read_exif(relative_path: &str, abs_path: &Path) -> ExifInfo {
    // TEMPORARY: simulate slow EXIF reading for load testing.
    #[cfg(not(test))]
    if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    let (date_taken, camera_model) = read_exif_inner(abs_path);
    ExifInfo { relative_path: relative_path.to_owned(), date_taken, camera_model }
}

fn read_exif_inner(path: &Path) -> (Option<String>, Option<String>) {
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

    let date_taken = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string());

    let make = exif
        .get_field(exif::Tag::Make, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string().trim_matches('"').to_owned());
    let model = exif
        .get_field(exif::Tag::Model, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string().trim_matches('"').to_owned());

    let camera_model = match (make, model) {
        (Some(mk), Some(mo)) => {
            if mo.to_lowercase().starts_with(&mk.to_lowercase()) { Some(mo) }
            else { Some(format!("{mk} {mo}")) }
        }
        (None, Some(mo)) => Some(mo),
        (Some(mk), None) => Some(mk),
        (None, None) => None,
    };

    (date_taken, camera_model)
}

/// Generate a base64-encoded JPEG thumbnail for the image at `path`.
pub fn thumbnail_for(path: &Path) -> Option<String> {
    // TEMPORARY: simulate slow thumbnail generation for load testing.
    #[cfg(not(test))]
    if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
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
    if end > buf.len() { return None; }
    let thumb_bytes = &buf[offset..end];
    if thumb_bytes.is_empty() { return None; }

    Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, thumb_bytes))
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
        scan_folder(folder, |p| photos.push(p));
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
        scan_folder(dir.path(), |_| count += 1);
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
    fn exif_returns_none_for_non_jpeg() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.png"), b"x").unwrap();
        let info = read_exif("a.png", &dir.path().join("a.png"));
        assert!(info.date_taken.is_none());
        assert!(info.camera_model.is_none());
    }

    #[test]
    fn exif_returns_none_for_jpeg_without_exif() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("noexif.jpg");
        image::RgbImage::new(1, 1).save(&path).unwrap();
        let info = read_exif("noexif.jpg", &path);
        assert!(info.date_taken.is_none());
        assert!(info.camera_model.is_none());
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
}
