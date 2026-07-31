use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecycleFileResult {
    pub relative_path: String,
    pub recycled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecycleFilesResult {
    pub results: Vec<RecycleFileResult>,
}

fn resolve_file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err("Path must be a non-empty relative file path".into());
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Path escapes the opened folder".into());
    }

    let joined = root.join(relative);
    let symlink_metadata = fs::symlink_metadata(&joined)
        .map_err(|error| format!("Could not inspect file: {error}"))?;
    if symlink_metadata.file_type().is_symlink() {
        return Err("Symbolic links cannot be recycled from the media library".into());
    }
    if !symlink_metadata.is_file() {
        return Err("Path is not a regular file".into());
    }

    let canonical = fs::canonicalize(&joined)
        .map_err(|error| format!("Could not canonicalise file: {error}"))?;
    if canonical.strip_prefix(root).is_err() {
        return Err("Path escapes the opened folder".into());
    }
    Ok(canonical)
}

pub fn recycle_files_with<F>(
    folder: &str,
    relative_paths: Vec<String>,
    mut recycle: F,
) -> Result<RecycleFilesResult, String>
where
    F: FnMut(&Path) -> Result<(), String>,
{
    let root = fs::canonicalize(folder)
        .map_err(|error| format!("Could not canonicalise opened folder '{folder}': {error}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Opened folder is not a directory: {}",
            root.display()
        ));
    }

    let mut seen = HashSet::new();
    let mut results = Vec::with_capacity(relative_paths.len());
    for relative_path in relative_paths {
        let outcome = if !seen.insert(relative_path.clone()) {
            Err("Duplicate requested path".into())
        } else {
            resolve_file(&root, &relative_path).and_then(|absolute| recycle(&absolute))
        };
        match outcome {
            Ok(()) => results.push(RecycleFileResult {
                relative_path,
                recycled: true,
                error: None,
            }),
            Err(error) => results.push(RecycleFileResult {
                relative_path,
                recycled: false,
                error: Some(error),
            }),
        }
    }
    Ok(RecycleFilesResult { results })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn attempts_every_file_and_preserves_partial_failures() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"a").unwrap();
        fs::write(dir.path().join("b.mov"), b"b").unwrap();
        let attempted = RefCell::new(Vec::new());

        let result = recycle_files_with(
            dir.path().to_str().unwrap(),
            vec!["a.jpg".into(), "b.mov".into()],
            |path| {
                attempted.borrow_mut().push(path.to_path_buf());
                if path.ends_with("b.mov") {
                    Err("locked".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();

        assert_eq!(attempted.borrow().len(), 2);
        assert!(result.results[0].recycled);
        assert_eq!(result.results[1].error.as_deref(), Some("locked"));
    }

    #[test]
    fn rejects_invalid_and_duplicate_paths_without_recycling_them() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"a").unwrap();
        fs::create_dir(dir.path().join("album")).unwrap();
        let attempts = RefCell::new(0);

        let result = recycle_files_with(
            dir.path().to_str().unwrap(),
            vec![
                "../outside.jpg".into(),
                "missing.jpg".into(),
                "album".into(),
                "a.jpg".into(),
                "a.jpg".into(),
            ],
            |_| {
                *attempts.borrow_mut() += 1;
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(*attempts.borrow(), 1);
        assert!(result.results[0]
            .error
            .as_deref()
            .unwrap()
            .contains("escapes"));
        assert!(result.results[1]
            .error
            .as_deref()
            .unwrap()
            .contains("inspect"));
        assert!(result.results[2]
            .error
            .as_deref()
            .unwrap()
            .contains("regular file"));
        assert!(result.results[3].recycled);
        assert_eq!(
            result.results[4].error.as_deref(),
            Some("Duplicate requested path")
        );
    }
}
