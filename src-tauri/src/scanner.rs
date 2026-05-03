/// Background folder scanning logic.
use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

/// File extensions recognised as photos.
const PHOTO_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

/// A single photo entry discovered during a folder scan.
#[derive(Debug, Clone, Serialize)]
pub struct PhotoInfo {
    /// Path relative to the scanned root folder (forward-slash separated).
    pub relative_path: String,
    /// Base64-encoded JPEG thumbnail, or None if generation failed.
    pub thumbnail: Option<String>,
}

/// Scan `folder` recursively and return all photo files found, sorted by path.
/// Emits progress via the provided callback after each file is processed.
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

        let thumbnail = generate_thumbnail(path);

        photos.push(PhotoInfo {
            relative_path: rel,
            thumbnail,
        });

        on_progress(photos.len());
    }

    photos.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    photos
}

/// Generate a small base64-encoded JPEG thumbnail for the given image file.
/// Returns None on any error so callers can show a placeholder instead.
fn generate_thumbnail(path: &Path) -> Option<String> {
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
}
