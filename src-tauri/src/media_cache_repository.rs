//! SQLite-backed cache for scanned media metadata and thumbnails.
//!
//! Each canonical absolute photo path owns one cache row. Metadata and
//! thumbnails arrive independently and are only returned when the
//! caller's file-size and high-precision modification-time fingerprint matches
//! the stored fingerprint.

use crate::draft_edits::resolve_canonical_photo_path;
use crate::metadata_occurrence::MetadataOccurrences;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CACHE_DIRECTORY_NAME: &str = "MediaLibrary";
const DATABASE_FILE_NAME: &str = "MediaLibraryMediaCache.sqlite3";
const DATABASE_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaCacheFingerprint {
    pub file_size: u64,
    pub modified_ns: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CachedMedia {
    pub thumbnail: Option<String>,
    pub metadata: Option<MetadataOccurrences>,
}

/// Return MediaLibrary's directory beneath the platform cache directory.
pub fn cache_directory() -> Result<PathBuf, String> {
    dirs::cache_dir()
        .map(|directory| directory.join(CACHE_DIRECTORY_NAME))
        .ok_or_else(|| "No platform cache directory is available".to_string())
}

/// Read the cache fingerprint used to validate a media file.
pub fn fingerprint_for_file(path: &Path) -> Result<MediaCacheFingerprint, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Could not stat media file '{}': {error}", path.display()))?;
    let modified = metadata.modified().map_err(|error| {
        format!(
            "Could not read modified time for '{}': {error}",
            path.display()
        )
    })?;
    let modified_ns = match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_nanos())
            .map_err(|_| format!("Modified time for '{}' exceeds cache range", path.display()))?,
        Err(error) => {
            let before_epoch = i64::try_from(error.duration().as_nanos()).map_err(|_| {
                format!("Modified time for '{}' exceeds cache range", path.display())
            })?;
            before_epoch.checked_neg().ok_or_else(|| {
                format!("Modified time for '{}' exceeds cache range", path.display())
            })?
        }
    };
    Ok(MediaCacheFingerprint {
        file_size: metadata.len(),
        modified_ns,
    })
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
                metadata_json TEXT
            );",
        )
        .map_err(|error| sqlite_error("Could not create media cache schema", error))
}

fn ensure_schema(connection: &mut Connection) -> Result<(), String> {
    let current_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| sqlite_error("Could not read media cache schema version", error))?;
    if current_version > DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported future media cache schema version {current_version}; this build supports version {DATABASE_SCHEMA_VERSION}"
        ));
    }
    if current_version == DATABASE_SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("Could not start media cache schema transaction", error))?;
    // Another connection may have completed initialization while we waited.
    let version: i64 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| sqlite_error("Could not read media cache schema version", error))?;
    match version {
        0 => create_schema(&transaction)?,
        1 => {
            transaction
                .execute_batch("ALTER TABLE media_cache RENAME TO media_cache_v1;")
                .map_err(|error| sqlite_error("Could not migrate media cache schema", error))?;
            create_schema(&transaction)?;
            transaction.execute_batch(
                "INSERT INTO media_cache SELECT photo_path, file_size, modified_ns, thumbnail, metadata_json FROM media_cache_v1;
                 DROP TABLE media_cache_v1;"
            ).map_err(|error| sqlite_error("Could not migrate media cache rows", error))?;
        }
        DATABASE_SCHEMA_VERSION => {}
        _ => return Err(format!("Unsupported media cache schema version {version}")),
    }
    transaction
        .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
        .map_err(|error| sqlite_error("Could not set media cache schema version", error))?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit media cache schema", error))
}

fn open_repository(cache_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(cache_dir).map_err(|error| {
        format!(
            "Could not create media cache directory '{}': {error}",
            cache_dir.display()
        )
    })?;
    let mut connection = Connection::open(database_path(cache_dir))
        .map_err(|error| sqlite_error("Could not open media cache database", error))?;
    configure_connection(&connection)?;
    ensure_schema(&mut connection)?;
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

/// Load the available components if the stored fingerprint is still current.
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
                    row.get::<_, Option<String>>(3)?,
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
        // Do not delete a newer row written since the SELECT above.
        connection.execute(
            "DELETE FROM media_cache WHERE photo_path = ?1 AND file_size = ?2 AND modified_ns = ?3",
            params![photo_path, file_size, modified_ns],
        ).map_err(|error| sqlite_error("Could not delete stale media cache row", error))?;
        return Ok(None);
    }

    let metadata = metadata_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| {
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

/// Update metadata, keeping the thumbnail only if its fingerprint matches.
pub fn update_metadata(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    fingerprint: MediaCacheFingerprint,
    metadata: &MetadataOccurrences,
) -> Result<(), String> {
    update_component(
        cache_dir,
        folder_path,
        relative_path,
        fingerprint,
        None,
        Some(metadata),
    )
}

/// Update (or clear) the thumbnail, keeping metadata only if its fingerprint matches.
/// `None` is an uncached thumbnail, not a persistent failure marker.
pub fn update_thumbnail(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    fingerprint: MediaCacheFingerprint,
    thumbnail: Option<&str>,
) -> Result<(), String> {
    update_component(
        cache_dir,
        folder_path,
        relative_path,
        fingerprint,
        thumbnail,
        None,
    )
}

fn update_component(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    fingerprint: MediaCacheFingerprint,
    thumbnail: Option<&str>,
    metadata: Option<&MetadataOccurrences>,
) -> Result<(), String> {
    let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
    let photo_path = photo_path.to_string_lossy().into_owned();
    let file_size = stored_file_size(fingerprint.file_size)?;
    let metadata_json = metadata
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| {
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
                thumbnail = CASE
                    WHEN ?6 = 0 THEN excluded.thumbnail
                    WHEN media_cache.file_size = excluded.file_size AND media_cache.modified_ns = excluded.modified_ns
                        THEN media_cache.thumbnail
                    ELSE NULL END,
                metadata_json = CASE
                    WHEN ?6 = 1 THEN excluded.metadata_json
                    WHEN media_cache.file_size = excluded.file_size AND media_cache.modified_ns = excluded.modified_ns
                        THEN media_cache.metadata_json
                    ELSE NULL END",
            params![
                photo_path,
                file_size,
                fingerprint.modified_ns,
                thumbnail,
                metadata_json,
                metadata.is_some()
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

    // Seed both components through the same independent APIs used by workers.
    fn upsert(
        cache_dir: &Path,
        folder: &str,
        relative: &str,
        fingerprint: MediaCacheFingerprint,
        thumbnail: Option<&str>,
        metadata: &MetadataOccurrences,
    ) -> Result<(), String> {
        update_metadata(cache_dir, folder, relative, fingerprint, metadata)?;
        update_thumbnail(cache_dir, folder, relative, fingerprint, thumbnail)
    }

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
    fn fingerprint_uses_file_size_and_high_precision_modified_time() {
        let temp = tempdir().unwrap();
        create_photo(temp.path(), "photo.jpg");
        let path = temp.path().join("photo.jpg");

        let fingerprint = fingerprint_for_file(&path).unwrap();

        assert_eq!(fingerprint.file_size, b"test photo".len() as u64);
        assert!(fingerprint.modified_ns > 0);
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
            metadata: Some(metadata("Cached title")),
        };
        let current = fingerprint(10, 1_786_000_000_123_456_789);

        upsert(
            &cache_dir,
            &folder_path(&folder),
            "nested/photo.jpg",
            current,
            expected.thumbnail.as_deref(),
            expected.metadata.as_ref().unwrap(),
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
                metadata: Some(metadata("New")),
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

    #[test]
    fn either_component_can_arrive_first_and_be_replaced_independently() {
        for thumbnail_first in [false, true] {
            let temp = tempdir().unwrap();
            let folder = folder_path(temp.path());
            let cache = temp.path().join("cache");
            create_photo(temp.path(), "photo.jpg");
            let fp = fingerprint(10, 100);
            let write_metadata =
                || update_metadata(&cache, &folder, "photo.jpg", fp, &metadata("Title")).unwrap();
            let write_thumbnail =
                || update_thumbnail(&cache, &folder, "photo.jpg", fp, Some("thumb")).unwrap();
            if thumbnail_first {
                write_thumbnail();
            } else {
                write_metadata();
            }
            let partial = load(&cache, &folder, "photo.jpg", fp).unwrap().unwrap();
            assert_eq!(partial.thumbnail.is_some(), thumbnail_first);
            assert_eq!(partial.metadata.is_some(), !thumbnail_first);
            if thumbnail_first {
                write_metadata();
            } else {
                write_thumbnail();
            }
            assert_eq!(
                load(&cache, &folder, "photo.jpg", fp).unwrap().unwrap(),
                CachedMedia {
                    thumbnail: Some("thumb".into()),
                    metadata: Some(metadata("Title")),
                }
            );
            update_metadata(
                &cache,
                &folder,
                "photo.jpg",
                fp,
                &MetadataOccurrences::default(),
            )
            .unwrap();
            let updated = load(&cache, &folder, "photo.jpg", fp).unwrap().unwrap();
            assert_eq!(updated.metadata, Some(MetadataOccurrences::default()));
            assert_eq!(updated.thumbnail.as_deref(), Some("thumb"));
            update_thumbnail(&cache, &folder, "photo.jpg", fp, None).unwrap();
            let cleared = load(&cache, &folder, "photo.jpg", fp).unwrap().unwrap();
            assert_eq!(cleared.thumbnail, None);
            assert_eq!(cleared.metadata, updated.metadata);
        }
    }

    #[test]
    fn changed_fingerprint_clears_the_other_component() {
        for next in [fingerprint(11, 100), fingerprint(10, 101)] {
            for metadata_first in [true, false] {
                let temp = tempdir().unwrap();
                let folder = folder_path(temp.path());
                let cache = temp.path().join("cache");
                create_photo(temp.path(), "photo.jpg");
                upsert(
                    &cache,
                    &folder,
                    "photo.jpg",
                    fingerprint(10, 100),
                    Some("old"),
                    &metadata("Old"),
                )
                .unwrap();
                if metadata_first {
                    update_metadata(&cache, &folder, "photo.jpg", next, &metadata("New")).unwrap();
                } else {
                    update_thumbnail(&cache, &folder, "photo.jpg", next, Some("new")).unwrap();
                }
                let row = load(&cache, &folder, "photo.jpg", next).unwrap().unwrap();
                assert_eq!(row.metadata, metadata_first.then(|| metadata("New")));
                assert_eq!(row.thumbnail, (!metadata_first).then(|| "new".into()));
            }
        }
    }

    #[test]
    fn simultaneous_component_writes_preserve_both_results() {
        let temp = tempdir().unwrap();
        let folder = folder_path(temp.path());
        let cache = temp.path().join("cache");
        create_photo(temp.path(), "photo.jpg");
        initialise(&cache).unwrap();
        let fp = fingerprint(10, 100);
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                barrier.wait();
                update_metadata(&cache, &folder, "photo.jpg", fp, &metadata("Title")).unwrap();
            });
            scope.spawn(|| {
                barrier.wait();
                update_thumbnail(&cache, &folder, "photo.jpg", fp, Some("thumb")).unwrap();
            });
        });
        assert_eq!(
            load(&cache, &folder, "photo.jpg", fp).unwrap().unwrap(),
            CachedMedia {
                thumbnail: Some("thumb".into()),
                metadata: Some(metadata("Title")),
            }
        );
    }

    #[test]
    fn version_one_rows_survive_nullable_metadata_migration() {
        let temp = tempdir().unwrap();
        let folder = folder_path(temp.path());
        create_photo(temp.path(), "photo.jpg");
        let path = resolve_canonical_photo_path(&folder, "photo.jpg").unwrap();
        let connection = Connection::open(database_path(temp.path())).unwrap();
        connection.execute_batch(
            "CREATE TABLE media_cache (photo_path TEXT PRIMARY KEY NOT NULL, file_size INTEGER NOT NULL,
             modified_ns INTEGER NOT NULL, thumbnail TEXT, metadata_json TEXT NOT NULL);
             PRAGMA user_version = 1;"
        ).unwrap();
        connection
            .execute(
                "INSERT INTO media_cache VALUES (?1, 10, 100, 'thumb', '[]')",
                params![path.to_string_lossy()],
            )
            .unwrap();
        drop(connection);
        initialise(temp.path()).unwrap();
        assert_eq!(
            load(temp.path(), &folder, "photo.jpg", fingerprint(10, 100))
                .unwrap()
                .unwrap(),
            CachedMedia {
                thumbnail: Some("thumb".into()),
                metadata: Some(MetadataOccurrences::default()),
            }
        );
        update_thumbnail(
            temp.path(),
            &folder,
            "photo.jpg",
            fingerprint(11, 100),
            Some("new"),
        )
        .unwrap();
        assert_eq!(
            load(temp.path(), &folder, "photo.jpg", fingerprint(11, 100))
                .unwrap()
                .unwrap()
                .metadata,
            None
        );
    }
}
