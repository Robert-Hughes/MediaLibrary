use super::*;

pub(super) fn build_cached() -> Result<TagRegistry, SchemaError> {
    let version = read_exiftool_version()?;
    let cache_path = cache_path_for(&version);

    if let Some(ref path) = cache_path {
        if path.exists() {
            match std::fs::read_to_string(path) {
                Ok(contents) => match serde_json::from_str::<TagRegistry>(&contents) {
                    Ok(mut r) => {
                        // Apply hard-coded overrides after load so the app
                        // doesn't need to bump cache keys when adding new ones.
                        apply_overrides(&mut r.tags);
                        log::info!(
                            "[tag_schema] Loaded {} tags from cache {} (exiftool {})",
                            r.len(),
                            path.display(),
                            version
                        );
                        return Ok(r);
                    }
                    Err(e) => log::warn!(
                        "[tag_schema] Cache file at {} unparseable ({}); rebuilding",
                        path.display(),
                        e
                    ),
                },
                Err(e) => log::warn!(
                    "[tag_schema] Could not read cache {} ({}); rebuilding",
                    path.display(),
                    e
                ),
            }
        }
    }

    let registry = TagRegistry::build()?;

    if let Some(path) = cache_path {
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!(
                    "[tag_schema] Could not create cache dir {} ({}); skipping cache write",
                    parent.display(),
                    e
                );
                return Ok(registry);
            }
        }
        match serde_json::to_string(&registry) {
            Ok(json) => match std::fs::write(&path, json) {
                Ok(_) => log::info!(
                    "[tag_schema] Cached {} tags to {} (exiftool {})",
                    registry.len(),
                    path.display(),
                    version
                ),
                Err(e) => log::warn!(
                    "[tag_schema] Cache write failed at {} ({}); registry still usable",
                    path.display(),
                    e
                ),
            },
            Err(e) => log::warn!(
                "[tag_schema] Cache serialize failed ({}); skipping write",
                e
            ),
        }
    }

    Ok(registry)
}

/// Run `exiftool -ver`. Returns trimmed version string (e.g. `13.57`).
fn read_exiftool_version() -> Result<String, SchemaError> {
    let output = crate::exiftool_config::exiftool_command()
        .arg("-ver")
        .output()
        .map_err(|e| SchemaError::ExifToolFailed(e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(SchemaError::ExifToolFailed(format!(
            "exiftool -ver failed: {}",
            stderr
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// Bump this when the logic that converts ExifTool `-listx` XML into our
// `TagKind` model changes in a way that should invalidate existing schema
// cache files, even if the ExifTool version itself did not change.
pub(super) const TAG_SCHEMA_PARSER_VERSION: u32 = 11;

pub(super) fn cache_path_for(version: &str) -> Option<std::path::PathBuf> {
    let dir = dirs::cache_dir()?;
    // Slashes-or-dots-in-version turn into filename-safe form. exiftool
    // versions are like `13.57` — safe — but be defensive.
    let safe: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Some(dir.join("MediaLibrary").join(format!(
        "tag_schema_p{}_{}.json",
        TAG_SCHEMA_PARSER_VERSION, safe
    )))
}
