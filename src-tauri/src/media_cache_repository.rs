//! SQLite-backed cache for scanned media metadata and thumbnails.
//!
//! Each canonical absolute photo path owns one complete cache row. Metadata
//! and thumbnail data are replaced together and are only returned when the
//! caller's file-size and high-precision modification-time fingerprint matches
//! the stored fingerprint.

use crate::draft_edits::resolve_canonical_photo_path;
use crate::metadata_occurrence::MetadataOccurrences;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CACHE_DIRECTORY_NAME: &str = "MediaLibrary";
const DATABASE_FILE_NAME: &str = "MediaLibraryMediaCache.sqlite3";
const DATABASE_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaCacheFingerprint {
    pub file_size: u64,
    pub modified_ns: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CachedMedia {
    pub thumbnail: Option<String>,
    pub metadata: MetadataOccurrences,
}

/// Return MediaLibrary's directory beneath the platform cache directory.
pub fn cache_directory() -> Result<PathBuf, String> {
    dirs::cache_dir()
        .map(|directory| directory.join(CACHE_DIRECTORY_NAME))
        .ok_or_else(|| "No platform cache directory is available".to_string())
}

fn database_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(DATABASE_FILE_NAME)
}

fn sqlite_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| sqlite_error("Could not configure media cache busy timeout", error))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| sqlite_error("Could not enable media cache WAL mode", error))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| sqlite_error("Could not configure media cache durability", error))?;
    Ok(())
}

fn create_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS media_cache (
                photo_path TEXT PRIMARY KEY NOT NULL,
                file_size INTEGER NOT NULL,
                modified_ns INTEGER NOT NULL,
                thumbnail TEXT,
                metadata_json TEXT NOT NULL
            );",
        )
        .map_err(|error| sqlite_error("Could not create media cache schema", error))
}

fn validate_schema_version(connection: &Connection) -> Result<(), String> {
    let current_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| sqlite_error("Could not read media cache schema version", error))?;
    if current_version > DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported future media cache schema version {current_version}; this build supports version {DATABASE_SCHEMA_VERSION}"
        ));
    }
    if current_version == 0 {
        connection
            .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
            .map_err(|error| sqlite_error("Could not set media cache schema version", error))?;
    }
    Ok(())
}

fn open_repository(cache_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(cache_dir).map_err(|error| {
        format!(
            "Could not create media cache directory '{}': {error}",
            cache_dir.display()
        )
    })?;
    let connection = Connection::open(database_path(cache_dir))
        .map_err(|error| sqlite_error("Could not open media cache database", error))?;
    configure_connection(&connection)?;
    create_schema(&connection)?;
    validate_schema_version(&connection)?;
    Ok(connection)
}

/// Create or validate the media cache database without reading or writing rows.
pub fn initialise(cache_dir: &Path) -> Result<(), String> {
    open_repository(cache_dir).map(drop)
}

fn stored_file_size(file_size: u64) -> Result<i64, String> {
    i64::try_from(file_size)
        .map_err(|_| format!("Media cache file size {file_size} exceeds SQLite's integer range"))
}

fn delete_by_photo_path(connection: &Connection, photo_path: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM media_cache WHERE photo_path = ?1",
            params![photo_path],
        )
        .map(|_| ())
        .map_err(|error| sqlite_error("Could not delete media cache row", error))
}

/// Load one complete cache entry if its stored fingerprint is still current.
/// A stale row is deleted before returning `None`.
pub fn load(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    expected_fingerprint: MediaCacheFingerprint,
) -> Result<Option<CachedMedia>, String> {
    let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
    let photo_path = photo_path.to_string_lossy().into_owned();
    let connection = open_repository(cache_dir)?;
    let stored = connection
        .query_row(
            "SELECT file_size, modified_ns, thumbnail, metadata_json
             FROM media_cache
             WHERE photo_path = ?1",
            params![photo_path],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read media cache row", error))?;

    let Some((file_size, modified_ns, thumbnail, metadata_json)) = stored else {
        return Ok(None);
    };
    let expected_file_size = stored_file_size(expected_fingerprint.file_size)?;
    if file_size != expected_file_size || modified_ns != expected_fingerprint.modified_ns {
        delete_by_photo_path(&connection, &photo_path)?;
        return Ok(None);
    }

    let metadata = serde_json::from_str(&metadata_json).map_err(|error| {
        format!(
            "Could not decode media cache metadata for '{}': {error}",
            photo_path
        )
    })?;
    Ok(Some(CachedMedia {
        thumbnail,
        metadata,
    }))
}

/// Insert or replace one complete thumbnail-and-metadata cache entry.
pub fn upsert(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    fingerprint: MediaCacheFingerprint,
    thumbnail: Option<&str>,
    metadata: &MetadataOccurrences,
) -> Result<(), String> {
    let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
    let photo_path = photo_path.to_string_lossy().into_owned();
    let file_size = stored_file_size(fingerprint.file_size)?;
    let metadata_json = serde_json::to_string(metadata).map_err(|error| {
        format!(
            "Could not encode media cache metadata for '{}': {error}",
            photo_path
        )
    })?;
    let connection = open_repository(cache_dir)?;
    connection
        .execute(
            "INSERT INTO media_cache (
                photo_path, file_size, modified_ns, thumbnail, metadata_json
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(photo_path) DO UPDATE SET
                file_size = excluded.file_size,
                modified_ns = excluded.modified_ns,
                thumbnail = excluded.thumbnail,
                metadata_json = excluded.metadata_json",
            params![
                photo_path,
                file_size,
                fingerprint.modified_ns,
                thumbnail,
                metadata_json
            ],
        )
        .map(|_| ())
        .map_err(|error| sqlite_error("Could not upsert media cache row", error))
}

/// Remove one entry using the same canonical photo-path identity as drafts.
pub fn remove(cache_dir: &Path, folder_path: &str, relative_path: &str) -> Result<(), String> {
    let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
    let photo_path = photo_path.to_string_lossy().into_owned();
    let connection = open_repository(cache_dir)?;
    delete_by_photo_path(&connection, &photo_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::{MetadataOccurrence, MetadataOccurrenceId, RuntimeTagIdScope};
    use crate::metadata_value::MetadataValue;
    use crate::tag_schema::SchemaDefinitionId;
    use tempfile::tempdir;

    fn folder_path(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn create_photo(folder: &Path, relative_path: &str) {
        let path = folder.join(relative_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"test photo").unwrap();
    }

    fn fingerprint(file_size: u64, modified_ns: i64) -> MediaCacheFingerprint {
        MediaCacheFingerprint {
            file_size,
            modified_ns,
        }
    }

    fn metadata(value: &str) -> MetadataOccurrences {
        let schema_id = SchemaDefinitionId {
            table: "XMP::dc".into(),
            tag_id: "title".into(),
            index: None,
        };
        MetadataOccurrences(vec![MetadataOccurrence::try_new(
            MetadataOccurrenceId {
                document: None,
                path: "XMP".into(),
                runtime_tag_id: "title".into(),
                tag_id_scope: RuntimeTagIdScope {
                    table: schema_id.table.clone(),
                    tag_id: schema_id.tag_id.clone(),
                    index: schema_id.index,
                },
                copy: 0,
            },
            schema_id,
            MetadataValue::Text(value.into()),
            None,
            None,
            None,
        )
        .unwrap()])
    }

    #[test]
    fn platform_cache_directory_uses_media_library_subdirectory() {
        let directory = cache_directory().unwrap();
        assert_eq!(directory.file_name().unwrap(), CACHE_DIRECTORY_NAME);
    }

    #[test]
    fn initialise_creates_versioned_schema() {
        let temp = tempdir().unwrap();
        let cache_dir = temp.path().join(CACHE_DIRECTORY_NAME);

        initialise(&cache_dir).unwrap();

        let path = database_path(&cache_dir);
        assert!(path.is_file());
        let connection = Connection::open(path).unwrap();
        let version = connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        let columns = connection
            .prepare("PRAGMA table_info(media_cache)")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            columns,
            vec![
                ("photo_path".into(), 1),
                ("file_size".into(), 0),
                ("modified_ns".into(), 0),
                ("thumbnail".into(), 0),
                ("metadata_json".into(), 0),
            ]
        );
    }

    #[test]
    fn complete_entry_round_trips() {
        let temp = tempdir().unwrap();
        let cache_dir = temp.path().join("cache");
        let folder = temp.path().join("photos");
        create_photo(&folder, "nested/photo.jpg");
        let expected = CachedMedia {
            thumbnail: Some("base64-thumbnail".into()),
            metadata: metadata("Cached title"),
        };
        let current = fingerprint(10, 1_786_000_000_123_456_789);

        upsert(
            &cache_dir,
            &folder_path(&folder),
            "nested/photo.jpg",
            current,
            expected.thumbnail.as_deref(),
            &expected.metadata,
        )
        .unwrap();

        assert_eq!(
            load(
                &cache_dir,
                &folder_path(&folder),
                "nested/photo.jpg",
                current,
            )
            .unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn upsert_replaces_the_complete_existing_entry() {
        let temp = tempdir().unwrap();
        let cache_dir = temp.path().join("cache");
        let folder = temp.path().join("photos");
        create_photo(&folder, "photo.jpg");
        let folder = folder_path(&folder);
        let original = fingerprint(10, 100);
        let replacement = fingerprint(20, 200);

        upsert(
            &cache_dir,
            &folder,
            "photo.jpg",
            original,
            Some("old-thumbnail"),
            &metadata("Old"),
        )
        .unwrap();
        upsert(
            &cache_dir,
            &folder,
            "photo.jpg",
            replacement,
            None,
            &metadata("New"),
        )
        .unwrap();

        assert_eq!(
            load(&cache_dir, &folder, "photo.jpg", replacement).unwrap(),
            Some(CachedMedia {
                thumbnail: None,
                metadata: metadata("New"),
            })
        );
        let connection = Connection::open(database_path(&cache_dir)).unwrap();
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM media_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(row_count, 1);
    }

    #[test]
    fn either_fingerprint_mismatch_deletes_the_entry() {
        for stale in [fingerprint(11, 100), fingerprint(10, 101)] {
            let temp = tempdir().unwrap();
            let cache_dir = temp.path().join("cache");
            let folder = temp.path().join("photos");
            create_photo(&folder, "photo.jpg");
            let folder = folder_path(&folder);
            let stored = fingerprint(10, 100);
            upsert(
                &cache_dir,
                &folder,
                "photo.jpg",
                stored,
                Some("thumbnail"),
                &metadata("Title"),
            )
            .unwrap();

            assert_eq!(load(&cache_dir, &folder, "photo.jpg", stale).unwrap(), None);
            assert_eq!(
                load(&cache_dir, &folder, "photo.jpg", stored).unwrap(),
                None,
                "the stale row should have been deleted"
            );
        }
    }

    #[test]
    fn equivalent_paths_share_one_canonical_entry() {
        let temp = tempdir().unwrap();
        let cache_dir = temp.path().join("cache");
        let folder = temp.path().join("photos");
        create_photo(&folder, "nested/photo.jpg");
        let current = fingerprint(10, 100);

        upsert(
            &cache_dir,
            &folder_path(&folder.join(".")),
            "nested/./photo.jpg",
            current,
            Some("thumbnail"),
            &metadata("Title"),
        )
        .unwrap();

        assert!(load(
            &cache_dir,
            &folder_path(&folder),
            "nested/photo.jpg",
            current,
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn missing_and_removed_entries_return_none() {
        let temp = tempdir().unwrap();
        let cache_dir = temp.path().join("cache");
        let folder = temp.path().join("photos");
        create_photo(&folder, "photo.jpg");
        let folder = folder_path(&folder);
        let current = fingerprint(10, 100);

        assert_eq!(
            load(&cache_dir, &folder, "photo.jpg", current).unwrap(),
            None
        );
        upsert(
            &cache_dir,
            &folder,
            "photo.jpg",
            current,
            Some("thumbnail"),
            &metadata("Title"),
        )
        .unwrap();
        remove(&cache_dir, &folder, "photo.jpg").unwrap();
        assert_eq!(
            load(&cache_dir, &folder, "photo.jpg", current).unwrap(),
            None
        );
    }
}
