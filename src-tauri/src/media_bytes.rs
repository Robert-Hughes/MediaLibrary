use crate::scanner::{self, MediaKind};
use std::fs;
use std::path::{Component, Path, PathBuf};

fn resolve_gallery_image(folder_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(folder_path).map_err(|error| {
        format!("Could not canonicalise opened folder '{folder_path}': {error}")
    })?;
    if !root.is_dir() {
        return Err(format!(
            "Opened folder is not a directory: {}",
            root.display()
        ));
    }

    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err("Gallery image path must be a non-empty relative path".into());
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Gallery image path escapes the opened folder".into());
    }

    let joined = root.join(relative);
    let metadata = fs::symlink_metadata(&joined)
        .map_err(|error| format!("Could not inspect gallery image '{relative_path}': {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Symbolic links cannot be loaded as gallery images".into());
    }
    if !metadata.is_file() {
        return Err("Gallery image path is not a regular file".into());
    }

    let canonical = fs::canonicalize(&joined).map_err(|error| {
        format!("Could not canonicalise gallery image '{relative_path}': {error}")
    })?;
    if canonical.strip_prefix(&root).is_err() {
        return Err("Gallery image path escapes the opened folder".into());
    }
    if scanner::media_kind_for_path(&canonical) != Some(MediaKind::Image) {
        return Err("Gallery byte reads are restricted to supported image files".into());
    }
    Ok(canonical)
}

pub fn read_gallery_image_bytes(folder_path: &str, relative_path: &str) -> Result<Vec<u8>, String> {
    let image_path = resolve_gallery_image(folder_path, relative_path)?;
    fs::read(&image_path).map_err(|error| {
        format!(
            "Could not read gallery image '{}': {error}",
            image_path.display()
        )
    })
}

#[tauri::command]
pub async fn read_gallery_image_bytes_cmd(
    folder_path: String,
    relative_path: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_gallery_image_bytes(&folder_path, &relative_path)
    })
    .await
    .map_err(|error| format!("Gallery image read task failed: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_supported_image_bytes() {
        let library = tempfile::tempdir().unwrap();
        fs::create_dir(library.path().join("album")).unwrap();
        fs::write(library.path().join("album/photo.jpg"), b"fresh-image").unwrap();

        let bytes =
            read_gallery_image_bytes(library.path().to_str().unwrap(), "album/photo.jpg").unwrap();

        assert_eq!(bytes, b"fresh-image");
    }

    #[test]
    fn reports_a_missing_image() {
        let library = tempfile::tempdir().unwrap();

        let error =
            read_gallery_image_bytes(library.path().to_str().unwrap(), "missing.jpg").unwrap_err();

        assert!(error.contains("Could not inspect gallery image 'missing.jpg'"));
    }

    #[test]
    fn rejects_paths_outside_the_opened_folder() {
        let parent = tempfile::tempdir().unwrap();
        let library = parent.path().join("library");
        fs::create_dir(&library).unwrap();
        fs::write(parent.path().join("outside.jpg"), b"outside").unwrap();

        let error =
            read_gallery_image_bytes(library.to_str().unwrap(), "../outside.jpg").unwrap_err();

        assert_eq!(error, "Gallery image path escapes the opened folder");
    }

    #[test]
    fn rejects_non_image_files() {
        let library = tempfile::tempdir().unwrap();
        fs::write(library.path().join("notes.txt"), b"not an image").unwrap();

        let error =
            read_gallery_image_bytes(library.path().to_str().unwrap(), "notes.txt").unwrap_err();

        assert_eq!(
            error,
            "Gallery byte reads are restricted to supported image files"
        );
    }
}
