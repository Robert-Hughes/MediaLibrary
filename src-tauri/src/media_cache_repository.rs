//! SQLite-backed cache for scanned media metadata and thumbnails.
//!
//! Each canonical absolute photo path owns one cache row. Metadata and
//! thumbnails arrive independently and are only returned when the
//! caller's file-size and high-precision modification-time fingerprint matches
//! the stored fingerprint.

use crate::draft_edits::resolve_canonical_photo_path;
use crate::metadata_occurrence::MetadataOccurrences;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const CACHE_DIRECTORY_NAME: &str = "MediaLibrary";
const DATABASE_FILE_NAME: &str = "MediaLibraryMediaCache.sqlite3";
const DATABASE_SCHEMA_VERSION: i64 = 3;
const METADATA_CACHE_GENERATION: i64 = 1;

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
                metadata_json TEXT,
                metadata_generation INTEGER
            );",
        )
        .map_err(|error| sqlite_error("Could not create media cache schema", error))
}

fn ensure_schema(connection: &Connection) -> Result<(), String> {
    let current_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| sqlite_error("Could not read media cache schema version", error))?;

    match current_version {
        DATABASE_SCHEMA_VERSION => Ok(()),
        0 => {
            create_schema(connection)?;
            connection
                .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
                .map_err(|error| sqlite_error("Could not set media cache schema version", error))
        }
        version => Err(format!(
            "Unsupported media cache schema version {version}; this build requires version {DATABASE_SCHEMA_VERSION}"
        )),
    }
}

fn stored_file_size(file_size: u64) -> Result<i64, String> {
    i64::try_from(file_size)
        .map_err(|_| format!("Media cache file size {file_size} exceeds SQLite's integer range"))
}

pub struct MediaCacheRepository {
    connection: Mutex<Connection>,
}

static SHARED_REPOSITORY: OnceLock<Result<Arc<MediaCacheRepository>, String>> = OnceLock::new();

impl MediaCacheRepository {
    pub fn open(cache_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(cache_dir).map_err(|error| {
            format!(
                "Could not create media cache directory '{}': {error}",
                cache_dir.display()
            )
        })?;
        let connection = Connection::open(database_path(cache_dir))
            .map_err(|error| sqlite_error("Could not open media cache database", error))?;
        configure_connection(&connection)?;
        ensure_schema(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "Media cache connection lock was poisoned".to_string())
    }

    fn delete_stale_row(
        connection: &Connection,
        photo_path: &str,
        file_size: i64,
        modified_ns: i64,
    ) -> Result<(), String> {
        connection
            .execute(
                "DELETE FROM media_cache
                 WHERE photo_path = ?1 AND file_size = ?2 AND modified_ns = ?3",
                params![photo_path, file_size, modified_ns],
            )
            .map(|_| ())
            .map_err(|error| sqlite_error("Could not delete stale media cache row", error))
    }

    fn fingerprint_matches(
        connection: &Connection,
        photo_path: &str,
        expected_fingerprint: MediaCacheFingerprint,
        file_size: i64,
        modified_ns: i64,
    ) -> Result<bool, String> {
        let expected_file_size = stored_file_size(expected_fingerprint.file_size)?;
        if file_size == expected_file_size && modified_ns == expected_fingerprint.modified_ns {
            return Ok(true);
        }
        Self::delete_stale_row(connection, photo_path, file_size, modified_ns)?;
        Ok(false)
    }

    fn clear_metadata_component(
        &self,
        photo_path: &str,
        fingerprint: MediaCacheFingerprint,
        observed_metadata_json: &str,
        observed_generation: Option<i64>,
    ) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute(
                "UPDATE media_cache
                 SET metadata_json = NULL, metadata_generation = NULL
                 WHERE photo_path = ?1
                   AND file_size = ?2
                   AND modified_ns = ?3
                   AND metadata_json = ?4
                   AND metadata_generation IS ?5",
                params![
                    photo_path,
                    stored_file_size(fingerprint.file_size)?,
                    fingerprint.modified_ns,
                    observed_metadata_json,
                    observed_generation
                ],
            )
            .map(|_| ())
            .map_err(|error| sqlite_error("Could not clear stale media cache metadata", error))
    }

    fn decode_current_metadata(
        &self,
        photo_path: &str,
        fingerprint: MediaCacheFingerprint,
        metadata_json: Option<String>,
        metadata_generation: Option<i64>,
    ) -> Result<Option<MetadataOccurrences>, String> {
        let Some(metadata_json) = metadata_json else {
            return Ok(None);
        };
        if metadata_generation != Some(METADATA_CACHE_GENERATION) {
            self.clear_metadata_component(
                photo_path,
                fingerprint,
                &metadata_json,
                metadata_generation,
            )?;
            return Ok(None);
        }
        match serde_json::from_str(&metadata_json) {
            Ok(metadata) => Ok(Some(metadata)),
            Err(error) => {
                log::warn!(
                    "[media-cache] discarding malformed metadata for {}: {}",
                    photo_path,
                    error
                );
                self.clear_metadata_component(
                    photo_path,
                    fingerprint,
                    &metadata_json,
                    metadata_generation,
                )?;
                Ok(None)
            }
        }
    }

    /// Load only the thumbnail component for one current file.
    pub fn load_thumbnail(
        &self,
        folder_path: &str,
        relative_path: &str,
        expected_fingerprint: MediaCacheFingerprint,
    ) -> Result<Option<String>, String> {
        let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
        let photo_path = photo_path.to_string_lossy().into_owned();
        let connection = self.connection()?;
        let stored = {
            let mut statement = connection
                .prepare_cached(
                    "SELECT file_size, modified_ns, thumbnail
                     FROM media_cache
                     WHERE photo_path = ?1",
                )
                .map_err(|error| {
                    sqlite_error("Could not prepare media cache thumbnail read", error)
                })?;
            statement
                .query_row(params![photo_path], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .optional()
                .map_err(|error| sqlite_error("Could not read media cache thumbnail", error))?
        };
        let Some((file_size, modified_ns, thumbnail)) = stored else {
            return Ok(None);
        };
        if !Self::fingerprint_matches(
            &connection,
            &photo_path,
            expected_fingerprint,
            file_size,
            modified_ns,
        )? {
            return Ok(None);
        }
        Ok(thumbnail)
    }

    /// Load current metadata hits for a scan batch using the shared connection.
    ///
    /// Paths absent from the returned map are cache misses. Stale fingerprints,
    /// stale semantic generations and malformed metadata are all treated as misses.
    /// JSON decoding happens after the SQLite connection lock is released.
    pub fn load_metadata_batch(
        &self,
        folder_path: &str,
        requests: &[(String, MediaCacheFingerprint)],
    ) -> Result<HashMap<String, MetadataOccurrences>, String> {
        let total_started = Instant::now();

        let resolve_started = Instant::now();
        let resolved = requests
            .iter()
            .map(|(relative_path, fingerprint)| {
                let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
                Ok((
                    relative_path.clone(),
                    photo_path.to_string_lossy().into_owned(),
                    *fingerprint,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let resolve_ms = resolve_started.elapsed().as_millis();

        let lock_started = Instant::now();
        let connection = self.connection()?;
        let lock_wait_ms = lock_started.elapsed().as_millis();
        let sqlite_started = Instant::now();
        let stored = {
            let mut statement = connection
                .prepare_cached(
                    "SELECT file_size, modified_ns, metadata_json, metadata_generation
                     FROM media_cache
                     WHERE photo_path = ?1",
                )
                .map_err(|error| {
                    sqlite_error("Could not prepare media cache metadata read", error)
                })?;
            let mut stored = Vec::with_capacity(resolved.len());
            for (relative_path, photo_path, fingerprint) in resolved {
                let row = statement
                    .query_row(params![photo_path], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                        ))
                    })
                    .optional()
                    .map_err(|error| sqlite_error("Could not read media cache metadata", error))?;
                let Some((file_size, modified_ns, metadata_json, metadata_generation)) = row else {
                    continue;
                };
                if !Self::fingerprint_matches(
                    &connection,
                    &photo_path,
                    fingerprint,
                    file_size,
                    modified_ns,
                )? {
                    continue;
                }
                stored.push((
                    relative_path,
                    photo_path,
                    fingerprint,
                    metadata_json,
                    metadata_generation,
                ));
            }
            stored
        };
        let sqlite_ms = sqlite_started.elapsed().as_millis();
        drop(connection);

        let decode_started = Instant::now();
        let stored_count = stored.len();
        let mut hits = HashMap::with_capacity(stored_count);
        for (relative_path, photo_path, fingerprint, metadata_json, metadata_generation) in stored {
            if let Some(metadata) = self.decode_current_metadata(
                &photo_path,
                fingerprint,
                metadata_json,
                metadata_generation,
            )? {
                hits.insert(relative_path, metadata);
            }
        }
        let decode_ms = decode_started.elapsed().as_millis();
        log::info!(
            "[scan_perf] phase=metadata_cache_batch requested={} stored={} hits={} resolve_ms={} lock_wait_ms={} sqlite_ms={} decode_ms={} total_ms={}",
            requests.len(),
            stored_count,
            hits.len(),
            resolve_ms,
            lock_wait_ms,
            sqlite_ms,
            decode_ms,
            total_started.elapsed().as_millis()
        );
        Ok(hits)
    }

    /// Update metadata, keeping the thumbnail only if its fingerprint matches.
    pub fn update_metadata(
        &self,
        folder_path: &str,
        relative_path: &str,
        fingerprint: MediaCacheFingerprint,
        metadata: &MetadataOccurrences,
    ) -> Result<(), String> {
        self.update_component(
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
        &self,
        folder_path: &str,
        relative_path: &str,
        fingerprint: MediaCacheFingerprint,
        thumbnail: Option<&str>,
    ) -> Result<(), String> {
        self.update_component(folder_path, relative_path, fingerprint, thumbnail, None)
    }

    fn update_component(
        &self,
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
        let connection = self.connection()?;
        let mut statement = connection
            .prepare_cached(
                "INSERT INTO media_cache (
                    photo_path, file_size, modified_ns, thumbnail, metadata_json, metadata_generation
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(photo_path) DO UPDATE SET
                    file_size = excluded.file_size,
                    modified_ns = excluded.modified_ns,
                    thumbnail = CASE
                        WHEN ?7 = 0 THEN excluded.thumbnail
                        WHEN media_cache.file_size = excluded.file_size AND media_cache.modified_ns = excluded.modified_ns
                            THEN media_cache.thumbnail
                        ELSE NULL END,
                    metadata_json = CASE
                        WHEN ?7 = 1 THEN excluded.metadata_json
                        WHEN media_cache.file_size = excluded.file_size AND media_cache.modified_ns = excluded.modified_ns
                            THEN media_cache.metadata_json
                        ELSE NULL END,
                    metadata_generation = CASE
                        WHEN ?7 = 1 THEN excluded.metadata_generation
                        WHEN media_cache.file_size = excluded.file_size AND media_cache.modified_ns = excluded.modified_ns
                            THEN media_cache.metadata_generation
                        ELSE NULL END",
            )
            .map_err(|error| sqlite_error("Could not prepare media cache upsert", error))?;
        statement
            .execute(params![
                photo_path,
                file_size,
                fingerprint.modified_ns,
                thumbnail,
                metadata_json,
                metadata.map(|_| METADATA_CACHE_GENERATION),
                metadata.is_some()
            ])
            .map(|_| ())
            .map_err(|error| sqlite_error("Could not upsert media cache row", error))
    }

    /// Remove one entry using the same canonical photo-path identity as drafts.
    pub fn remove(&self, folder_path: &str, relative_path: &str) -> Result<(), String> {
        let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
        let photo_path = photo_path.to_string_lossy().into_owned();
        let connection = self.connection()?;
        connection
            .execute(
                "DELETE FROM media_cache WHERE photo_path = ?1",
                params![photo_path],
            )
            .map(|_| ())
            .map_err(|error| sqlite_error("Could not delete media cache row", error))
    }

    #[cfg(test)]
    pub(crate) fn load(
        &self,
        folder_path: &str,
        relative_path: &str,
        expected_fingerprint: MediaCacheFingerprint,
    ) -> Result<Option<CachedMedia>, String> {
        let photo_path = resolve_canonical_photo_path(folder_path, relative_path)?;
        let photo_path = photo_path.to_string_lossy().into_owned();
        let stored = {
            let connection = self.connection()?;
            let mut statement = connection
                .prepare_cached(
                    "SELECT file_size, modified_ns, thumbnail, metadata_json, metadata_generation
                     FROM media_cache
                     WHERE photo_path = ?1",
                )
                .map_err(|error| sqlite_error("Could not prepare media cache test read", error))?;
            let stored = statement
                .query_row(params![photo_path], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                })
                .optional()
                .map_err(|error| sqlite_error("Could not read media cache row", error))?;
            let Some((file_size, modified_ns, thumbnail, metadata_json, metadata_generation)) =
                stored
            else {
                return Ok(None);
            };
            if !Self::fingerprint_matches(
                &connection,
                &photo_path,
                expected_fingerprint,
                file_size,
                modified_ns,
            )? {
                return Ok(None);
            }
            (thumbnail, metadata_json, metadata_generation)
        };
        let metadata =
            self.decode_current_metadata(&photo_path, expected_fingerprint, stored.1, stored.2)?;
        Ok(Some(CachedMedia {
            thumbnail: stored.0,
            metadata,
        }))
    }
}

pub fn shared_repository() -> Result<Arc<MediaCacheRepository>, String> {
    SHARED_REPOSITORY
        .get_or_init(|| {
            let cache_dir = cache_directory()?;
            let repository = MediaCacheRepository::open(&cache_dir)?;
            log::info!(
                "[media-cache] opened shared SQLite connection at {}",
                database_path(&cache_dir).display()
            );
            Ok(Arc::new(repository))
        })
        .clone()
}

#[cfg(test)]
fn initialise(cache_dir: &Path) -> Result<(), String> {
    MediaCacheRepository::open(cache_dir).map(drop)
}

#[cfg(test)]
pub(crate) fn load(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    expected_fingerprint: MediaCacheFingerprint,
) -> Result<Option<CachedMedia>, String> {
    MediaCacheRepository::open(cache_dir)?.load(folder_path, relative_path, expected_fingerprint)
}

#[cfg(test)]
fn load_thumbnail(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    expected_fingerprint: MediaCacheFingerprint,
) -> Result<Option<String>, String> {
    MediaCacheRepository::open(cache_dir)?.load_thumbnail(
        folder_path,
        relative_path,
        expected_fingerprint,
    )
}

#[cfg(test)]
fn load_metadata_batch(
    cache_dir: &Path,
    folder_path: &str,
    requests: &[(String, MediaCacheFingerprint)],
) -> Result<HashMap<String, MetadataOccurrences>, String> {
    MediaCacheRepository::open(cache_dir)?.load_metadata_batch(folder_path, requests)
}

#[cfg(test)]
fn update_metadata(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    fingerprint: MediaCacheFingerprint,
    metadata: &MetadataOccurrences,
) -> Result<(), String> {
    MediaCacheRepository::open(cache_dir)?.update_metadata(
        folder_path,
        relative_path,
        fingerprint,
        metadata,
    )
}

#[cfg(test)]
fn update_thumbnail(
    cache_dir: &Path,
    folder_path: &str,
    relative_path: &str,
    fingerprint: MediaCacheFingerprint,
    thumbnail: Option<&str>,
) -> Result<(), String> {
    MediaCacheRepository::open(cache_dir)?.update_thumbnail(
        folder_path,
        relative_path,
        fingerprint,
        thumbnail,
    )
}

#[cfg(test)]
fn remove(cache_dir: &Path, folder_path: &str, relative_path: &str) -> Result<(), String> {
    MediaCacheRepository::open(cache_dir)?.remove(folder_path, relative_path)
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
                ("metadata_generation".into(), 0),
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
        let repository = Arc::new(MediaCacheRepository::open(&cache).unwrap());
        let fp = fingerprint(10, 100);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        std::thread::scope(|scope| {
            let metadata_repository = repository.clone();
            let metadata_barrier = barrier.clone();
            let metadata_folder = &folder;
            scope.spawn(move || {
                metadata_barrier.wait();
                metadata_repository
                    .update_metadata(metadata_folder, "photo.jpg", fp, &metadata("Title"))
                    .unwrap();
            });
            let thumbnail_repository = repository.clone();
            let thumbnail_barrier = barrier.clone();
            let thumbnail_folder = &folder;
            scope.spawn(move || {
                thumbnail_barrier.wait();
                thumbnail_repository
                    .update_thumbnail(thumbnail_folder, "photo.jpg", fp, Some("thumb"))
                    .unwrap();
            });
        });
        assert_eq!(
            repository.load(&folder, "photo.jpg", fp).unwrap().unwrap(),
            CachedMedia {
                thumbnail: Some("thumb".into()),
                metadata: Some(metadata("Title")),
            }
        );
    }

    #[test]
    fn legacy_schema_versions_are_rejected_without_migration() {
        for version in [1, 2] {
            let temp = tempdir().unwrap();
            let connection = Connection::open(database_path(temp.path())).unwrap();
            connection
                .pragma_update(None, "user_version", version)
                .unwrap();
            drop(connection);

            let error = initialise(temp.path()).unwrap_err();

            assert_eq!(
                error,
                format!(
                    "Unsupported media cache schema version {version}; this build requires version {DATABASE_SCHEMA_VERSION}"
                )
            );
        }
    }

    #[test]
    fn component_reads_return_only_requested_current_components() {
        let temp = tempdir().unwrap();
        let folder = folder_path(temp.path());
        create_photo(temp.path(), "photo.jpg");
        let cache = temp.path().join("cache");
        let fp = fingerprint(10, 100);
        upsert(
            &cache,
            &folder,
            "photo.jpg",
            fp,
            Some("thumb"),
            &metadata("Title"),
        )
        .unwrap();

        assert_eq!(
            load_thumbnail(&cache, &folder, "photo.jpg", fp)
                .unwrap()
                .as_deref(),
            Some("thumb")
        );
        let hits = load_metadata_batch(&cache, &folder, &[("photo.jpg".into(), fp)]).unwrap();
        assert_eq!(hits.get("photo.jpg"), Some(&metadata("Title")));
    }

    #[test]
    fn stale_metadata_generation_is_a_miss_without_discarding_thumbnail() {
        let temp = tempdir().unwrap();
        let folder = folder_path(temp.path());
        create_photo(temp.path(), "photo.jpg");
        let cache = temp.path().join("cache");
        let fp = fingerprint(10, 100);
        upsert(
            &cache,
            &folder,
            "photo.jpg",
            fp,
            Some("thumb"),
            &metadata("Title"),
        )
        .unwrap();
        let path = resolve_canonical_photo_path(&folder, "photo.jpg").unwrap();
        let connection = Connection::open(database_path(&cache)).unwrap();
        connection
            .execute(
                "UPDATE media_cache SET metadata_generation = ?2 WHERE photo_path = ?1",
                params![path.to_string_lossy(), METADATA_CACHE_GENERATION - 1],
            )
            .unwrap();
        drop(connection);

        assert!(
            load_metadata_batch(&cache, &folder, &[("photo.jpg".into(), fp)])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            load_thumbnail(&cache, &folder, "photo.jpg", fp)
                .unwrap()
                .as_deref(),
            Some("thumb")
        );
        let connection = Connection::open(database_path(&cache)).unwrap();
        let cleared: (Option<String>, Option<i64>) = connection
            .query_row(
                "SELECT metadata_json, metadata_generation FROM media_cache WHERE photo_path = ?1",
                params![path.to_string_lossy()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(cleared, (None, None));
    }

    #[test]
    fn malformed_metadata_is_a_miss_without_discarding_thumbnail() {
        let temp = tempdir().unwrap();
        let folder = folder_path(temp.path());
        create_photo(temp.path(), "photo.jpg");
        let cache = temp.path().join("cache");
        let fp = fingerprint(10, 100);
        upsert(
            &cache,
            &folder,
            "photo.jpg",
            fp,
            Some("thumb"),
            &metadata("Title"),
        )
        .unwrap();
        let path = resolve_canonical_photo_path(&folder, "photo.jpg").unwrap();
        let connection = Connection::open(database_path(&cache)).unwrap();
        connection
            .execute(
                "UPDATE media_cache SET metadata_json = '{' WHERE photo_path = ?1",
                params![path.to_string_lossy()],
            )
            .unwrap();
        drop(connection);

        assert_eq!(
            load_thumbnail(&cache, &folder, "photo.jpg", fp)
                .unwrap()
                .as_deref(),
            Some("thumb")
        );
        assert!(
            load_metadata_batch(&cache, &folder, &[("photo.jpg".into(), fp)])
                .unwrap()
                .is_empty()
        );
        let connection = Connection::open(database_path(&cache)).unwrap();
        let cleared: (Option<String>, Option<i64>) = connection
            .query_row(
                "SELECT metadata_json, metadata_generation FROM media_cache WHERE photo_path = ?1",
                params![path.to_string_lossy()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(cleared, (None, None));
    }

    #[test]
    fn stale_cleanup_does_not_clear_newer_same_fingerprint_metadata() {
        let temp = tempdir().unwrap();
        let folder = folder_path(temp.path());
        create_photo(temp.path(), "photo.jpg");
        let cache = temp.path().join("cache");
        let fp = fingerprint(10, 100);
        let old_metadata = metadata("Old");
        upsert(
            &cache,
            &folder,
            "photo.jpg",
            fp,
            Some("thumb"),
            &old_metadata,
        )
        .unwrap();
        let path = resolve_canonical_photo_path(&folder, "photo.jpg").unwrap();
        let photo_path = path.to_string_lossy().into_owned();
        let old_json = serde_json::to_string(&old_metadata).unwrap();
        let connection = Connection::open(database_path(&cache)).unwrap();
        connection
            .execute(
                "UPDATE media_cache SET metadata_generation = ?2 WHERE photo_path = ?1",
                params![photo_path, METADATA_CACHE_GENERATION - 1],
            )
            .unwrap();
        drop(connection);

        update_metadata(&cache, &folder, "photo.jpg", fp, &metadata("New")).unwrap();

        let repository = MediaCacheRepository::open(&cache).unwrap();
        repository
            .clear_metadata_component(
                &photo_path,
                fp,
                &old_json,
                Some(METADATA_CACHE_GENERATION - 1),
            )
            .unwrap();

        let hits = load_metadata_batch(&cache, &folder, &[("photo.jpg".into(), fp)]).unwrap();
        assert_eq!(hits.get("photo.jpg"), Some(&metadata("New")));
    }
}
