//! SQLite-backed target-draft repository.
//!
//! Draft identity remains the canonical absolute photo path. Each database row
//! stores one photo's complete target-aware entry vector as JSON so reads,
//! validation, reconciliation, and writes stay scoped to the affected rows.

use crate::draft_edits::{
    canonical_root, frontend_relative_path, read_snapshot, resolve_photo_path, validate_slots,
    DraftRepositoryState, MetadataTargetDraftEntry, MetadataTargetDraftsByFile,
    TARGET_DRAFT_BACKUP_FILE_NAME, TARGET_DRAFT_FILE_NAME,
};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use sea_query::{ColumnDef, Expr, ExprTrait, Iden, OnConflict, Query, SqliteQueryBuilder, Table};
use sea_query_rusqlite::RusqliteBinder;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DATABASE_FILE_NAME: &str = "MediaLibraryTargetDraftEdits.sqlite3";
const MIGRATED_DRAFT_FILE_NAME: &str = "MediaLibraryTargetDraftEdits.migrated.jsonl";
const MIGRATED_BACKUP_FILE_NAME: &str = "MediaLibraryTargetDraftEdits.backup.migrated.jsonl";
const DATABASE_SCHEMA_VERSION: i64 = 1;

#[derive(Iden)]
enum Drafts {
    #[iden = "metadata_drafts"]
    Table,
    PhotoPath,
    EntriesJson,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetadataDraftRowMutation {
    pub relative_path: String,
    pub entries: Vec<MetadataTargetDraftEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedDraftRow {
    pub relative_path: String,
    pub entries: Vec<MetadataTargetDraftEntry>,
    pub(crate) original_json: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReconciledDraftRow {
    pub relative_path: String,
    pub original_json: String,
    pub entries: Vec<MetadataTargetDraftEntry>,
}

impl LoadedDraftRow {
    pub fn reconciled(self, entries: Vec<MetadataTargetDraftEntry>) -> ReconciledDraftRow {
        ReconciledDraftRow {
            relative_path: self.relative_path,
            original_json: self.original_json,
            entries,
        }
    }
}

fn database_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DATABASE_FILE_NAME)
}

fn sqlite_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| sqlite_error("Could not configure draft database busy timeout", error))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| sqlite_error("Could not enable draft database WAL mode", error))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| sqlite_error("Could not configure draft database durability", error))?;
    Ok(())
}

fn create_schema(connection: &Connection) -> Result<(), String> {
    let statement = Table::create()
        .table(Drafts::Table)
        .if_not_exists()
        .col(
            ColumnDef::new(Drafts::PhotoPath)
                .text()
                .not_null()
                .primary_key(),
        )
        .col(ColumnDef::new(Drafts::EntriesJson).text().not_null())
        .to_owned()
        .build(SqliteQueryBuilder);
    connection
        .execute_batch(&statement)
        .map_err(|error| sqlite_error("Could not create draft database schema", error))
}

fn insert_row(
    transaction: &Transaction<'_>,
    photo_path: &str,
    entries_json: &str,
) -> Result<(), String> {
    let statement = Query::insert()
        .into_table(Drafts::Table)
        .columns([Drafts::PhotoPath, Drafts::EntriesJson])
        .values_panic([photo_path.into(), entries_json.into()])
        .on_conflict(
            OnConflict::column(Drafts::PhotoPath)
                .update_column(Drafts::EntriesJson)
                .to_owned(),
        )
        .to_owned();
    let (sql, values) = statement.build_rusqlite(SqliteQueryBuilder);
    transaction
        .execute(&sql, values.as_params().as_slice())
        .map(|_| ())
        .map_err(|error| sqlite_error("Could not insert draft database row", error))
}

fn migrate_legacy_snapshot(connection: &mut Connection, app_data_dir: &Path) -> Result<(), String> {
    let current_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| sqlite_error("Could not read draft database schema version", error))?;
    if current_version > DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported future draft database schema version {current_version}; this build supports version {DATABASE_SCHEMA_VERSION}"
        ));
    }
    if current_version == DATABASE_SCHEMA_VERSION {
        archive_legacy_files(app_data_dir);
        return Ok(());
    }

    let legacy_path = app_data_dir.join(TARGET_DRAFT_FILE_NAME);
    let legacy_rows = read_snapshot(&legacy_path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("Could not start draft migration transaction", error))?;
    for (photo_path, entries) in legacy_rows {
        validate_slots(&photo_path.to_string_lossy(), &entries, None)?;
        let entries_json = serde_json::to_string(&entries)
            .map_err(|error| sqlite_error("Could not serialise migrated draft row", error))?;
        insert_row(&transaction, &photo_path.to_string_lossy(), &entries_json)?;
    }
    transaction
        .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
        .map_err(|error| sqlite_error("Could not set draft database schema version", error))?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit draft database migration", error))?;
    archive_legacy_files(app_data_dir);
    Ok(())
}

fn archive_legacy_files(app_data_dir: &Path) {
    for (source_name, destination_name) in [
        (TARGET_DRAFT_FILE_NAME, MIGRATED_DRAFT_FILE_NAME),
        (TARGET_DRAFT_BACKUP_FILE_NAME, MIGRATED_BACKUP_FILE_NAME),
    ] {
        let source = app_data_dir.join(source_name);
        let destination = app_data_dir.join(destination_name);
        if !source.exists() || destination.exists() {
            continue;
        }
        if let Err(error) = std::fs::rename(&source, &destination) {
            log::warn!(
                "[draft_repository] Could not archive migrated draft file {} to {}: {error}",
                source.display(),
                destination.display()
            );
        }
    }
}

fn open_repository(app_data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let mut connection = Connection::open(database_path(app_data_dir))
        .map_err(|error| sqlite_error("Could not open draft database", error))?;
    configure_connection(&connection)?;
    create_schema(&connection)?;
    migrate_legacy_snapshot(&mut connection, app_data_dir)?;
    Ok(connection)
}

fn decode_entries(
    photo_path: &str,
    entries_json: &str,
) -> Result<Vec<MetadataTargetDraftEntry>, String> {
    let entries = serde_json::from_str::<Vec<MetadataTargetDraftEntry>>(entries_json)
        .map_err(|error| format!("Invalid draft database row for '{photo_path}': {error}"))?;
    validate_slots(photo_path, &entries, None)?;
    Ok(entries)
}

fn resolved_paths(
    folder_path: &str,
    relative_paths: &[String],
) -> Result<Vec<(String, String)>, String> {
    let root = canonical_root(folder_path)?;
    relative_paths
        .iter()
        .map(|relative_path| {
            resolve_photo_path(&root, relative_path).map(|photo_path| {
                (
                    relative_path.clone(),
                    photo_path.to_string_lossy().into_owned(),
                )
            })
        })
        .collect()
}

pub fn load_metadata_draft_edits(
    app_data_dir: &Path,
    folder_path: &str,
    state: &DraftRepositoryState,
) -> Result<MetadataTargetDraftsByFile, String> {
    state.with_operation(|| {
        let root = canonical_root(folder_path)?;
        let mut prefix = root.to_string_lossy().into_owned();
        if !prefix.ends_with(std::path::MAIN_SEPARATOR) {
            prefix.push(std::path::MAIN_SEPARATOR);
        }
        let upper_bound = format!("{prefix}\u{10ffff}");
        let connection = open_repository(app_data_dir)?;
        let statement = Query::select()
            .columns([Drafts::PhotoPath, Drafts::EntriesJson])
            .from(Drafts::Table)
            .and_where(Expr::col(Drafts::PhotoPath).gte(prefix))
            .and_where(Expr::col(Drafts::PhotoPath).lt(upper_bound))
            .to_owned();
        let (sql, values) = statement.build_rusqlite(SqliteQueryBuilder);
        let mut prepared = connection
            .prepare(&sql)
            .map_err(|error| sqlite_error("Could not prepare draft folder query", error))?;
        let rows = prepared
            .query_map(values.as_params().as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| sqlite_error("Could not query draft folder rows", error))?;
        let mut drafts = MetadataTargetDraftsByFile::new();
        for row in rows {
            let (photo_path, entries_json) =
                row.map_err(|error| sqlite_error("Could not read draft folder row", error))?;
            let path = PathBuf::from(&photo_path);
            let Some(relative_path) = frontend_relative_path(&root, &path) else {
                continue;
            };
            let entries = decode_entries(&photo_path, &entries_json)?;
            if !entries.is_empty() {
                drafts.insert(relative_path, entries);
            }
        }
        Ok(drafts)
    })
}

pub fn select_existing_relative_paths(
    app_data_dir: &Path,
    folder_path: &str,
    relative_paths: &[String],
    state: &DraftRepositoryState,
) -> Result<Vec<String>, String> {
    state.with_operation(|| {
        let resolved = resolved_paths(folder_path, relative_paths)?;
        let connection = open_repository(app_data_dir)?;
        let mut found = std::collections::HashSet::new();
        for chunk in resolved.chunks(500) {
            let keys = chunk
                .iter()
                .map(|(_, absolute)| absolute.clone())
                .collect::<Vec<_>>();
            let statement = Query::select()
                .column(Drafts::PhotoPath)
                .from(Drafts::Table)
                .and_where(Expr::col(Drafts::PhotoPath).is_in(keys))
                .to_owned();
            let (sql, values) = statement.build_rusqlite(SqliteQueryBuilder);
            let mut prepared = connection
                .prepare(&sql)
                .map_err(|error| sqlite_error("Could not prepare draft selection query", error))?;
            let rows = prepared
                .query_map(values.as_params().as_slice(), |row| row.get::<_, String>(0))
                .map_err(|error| sqlite_error("Could not select requested draft rows", error))?;
            for row in rows {
                found.insert(
                    row.map_err(|error| sqlite_error("Could not read selected draft row", error))?,
                );
            }
        }
        Ok(resolved
            .into_iter()
            .filter(|(_, absolute)| found.contains(absolute))
            .map(|(relative, _)| relative)
            .collect::<Vec<_>>())
    })
}

pub fn select_all_relative_paths(
    app_data_dir: &Path,
    folder_path: &str,
    state: &DraftRepositoryState,
) -> Result<Vec<String>, String> {
    state.with_operation(|| {
        let root = canonical_root(folder_path)?;
        let mut prefix = root.to_string_lossy().into_owned();
        if !prefix.ends_with(std::path::MAIN_SEPARATOR) {
            prefix.push(std::path::MAIN_SEPARATOR);
        }
        let upper_bound = format!("{prefix}\u{10ffff}");
        let connection = open_repository(app_data_dir)?;
        let statement = Query::select()
            .column(Drafts::PhotoPath)
            .from(Drafts::Table)
            .and_where(Expr::col(Drafts::PhotoPath).gte(prefix))
            .and_where(Expr::col(Drafts::PhotoPath).lt(upper_bound))
            .to_owned();
        let (sql, values) = statement.build_rusqlite(SqliteQueryBuilder);
        let mut prepared = connection
            .prepare(&sql)
            .map_err(|error| sqlite_error("Could not prepare draft path query", error))?;
        let rows = prepared
            .query_map(values.as_params().as_slice(), |row| row.get::<_, String>(0))
            .map_err(|error| sqlite_error("Could not query draft paths", error))?;
        let mut relative_paths = Vec::new();
        for row in rows {
            let photo_path =
                row.map_err(|error| sqlite_error("Could not read draft path", error))?;
            if let Some(relative_path) = frontend_relative_path(&root, Path::new(&photo_path)) {
                relative_paths.push(relative_path);
            }
        }
        relative_paths.sort();
        Ok(relative_paths)
    })
}

pub fn load_draft_rows(
    app_data_dir: &Path,
    folder_path: &str,
    relative_paths: &[String],
    state: &DraftRepositoryState,
) -> Result<Vec<LoadedDraftRow>, String> {
    state.with_operation(|| {
        let resolved = resolved_paths(folder_path, relative_paths)?;
        let by_absolute = resolved
            .iter()
            .map(|(relative, absolute)| (absolute.clone(), relative.clone()))
            .collect::<HashMap<_, _>>();
        let keys = resolved
            .iter()
            .map(|(_, absolute)| absolute.clone())
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let connection = open_repository(app_data_dir)?;
        let statement = Query::select()
            .columns([Drafts::PhotoPath, Drafts::EntriesJson])
            .from(Drafts::Table)
            .and_where(Expr::col(Drafts::PhotoPath).is_in(keys))
            .to_owned();
        let (sql, values) = statement.build_rusqlite(SqliteQueryBuilder);
        let mut prepared = connection
            .prepare(&sql)
            .map_err(|error| sqlite_error("Could not prepare draft row query", error))?;
        let rows = prepared
            .query_map(values.as_params().as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| sqlite_error("Could not query draft rows", error))?;
        let mut loaded = HashMap::new();
        for row in rows {
            let (photo_path, original_json) =
                row.map_err(|error| sqlite_error("Could not read draft row", error))?;
            let relative_path = by_absolute
                .get(&photo_path)
                .ok_or_else(|| {
                    format!("Draft database returned an unrequested path '{photo_path}'")
                })?
                .clone();
            let entries = decode_entries(&photo_path, &original_json)?;
            loaded.insert(
                relative_path.clone(),
                LoadedDraftRow {
                    relative_path,
                    entries,
                    original_json,
                },
            );
        }
        Ok(relative_paths
            .iter()
            .filter_map(|path| loaded.remove(path))
            .collect())
    })
}

pub fn apply_row_mutations(
    app_data_dir: &Path,
    folder_path: &str,
    mutations: &[MetadataDraftRowMutation],
    state: &DraftRepositoryState,
) -> Result<(), String> {
    state.with_operation(|| {
        let root = canonical_root(folder_path)?;
        let mut connection = open_repository(app_data_dir)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("Could not start draft mutation transaction", error))?;
        let mut seen = std::collections::HashSet::new();
        for mutation in mutations {
            if !seen.insert(mutation.relative_path.as_str()) {
                return Err(format!(
                    "Duplicate draft row mutation for '{}'",
                    mutation.relative_path
                ));
            }
            validate_slots(&mutation.relative_path, &mutation.entries, None)?;
            let photo_path = resolve_photo_path(&root, &mutation.relative_path)?;
            let photo_path = photo_path.to_string_lossy().into_owned();
            if mutation.entries.is_empty() {
                delete_row(&transaction, &photo_path, None)?;
            } else {
                let entries_json = serde_json::to_string(&mutation.entries).map_err(|error| {
                    sqlite_error("Could not serialise draft row mutation", error)
                })?;
                insert_row(&transaction, &photo_path, &entries_json)?;
            }
        }
        transaction
            .commit()
            .map_err(|error| sqlite_error("Could not commit draft mutation transaction", error))
    })
}

pub fn persist_reconciled_rows(
    app_data_dir: &Path,
    folder_path: &str,
    rows: &[ReconciledDraftRow],
    state: &DraftRepositoryState,
) -> Result<(), String> {
    state.with_operation(|| {
        let root = canonical_root(folder_path)?;
        let mut connection = open_repository(app_data_dir)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("Could not start reconciled draft transaction", error))?;
        for row in rows {
            validate_slots(&row.relative_path, &row.entries, None)?;
            let photo_path = resolve_photo_path(&root, &row.relative_path)?;
            let photo_path = photo_path.to_string_lossy().into_owned();
            let changed = if row.entries.is_empty() {
                delete_row(&transaction, &photo_path, Some(&row.original_json))?
            } else {
                let new_json = serde_json::to_string(&row.entries).map_err(|error| {
                    sqlite_error("Could not serialise reconciled draft row", error)
                })?;
                update_row(&transaction, &photo_path, &row.original_json, &new_json)?
            };
            if changed != 1 {
                return Err(format!(
                    "Draft row changed concurrently while applying metadata: '{}'",
                    row.relative_path
                ));
            }
        }
        transaction
            .commit()
            .map_err(|error| sqlite_error("Could not commit reconciled draft transaction", error))
    })
}

fn delete_row(
    transaction: &Transaction<'_>,
    photo_path: &str,
    original_json: Option<&str>,
) -> Result<usize, String> {
    let mut statement = Query::delete();
    statement
        .from_table(Drafts::Table)
        .and_where(Expr::col(Drafts::PhotoPath).eq(photo_path));
    if let Some(original_json) = original_json {
        statement.and_where(Expr::col(Drafts::EntriesJson).eq(original_json));
    }
    let (sql, values) = statement.build_rusqlite(SqliteQueryBuilder);
    transaction
        .execute(&sql, values.as_params().as_slice())
        .map_err(|error| sqlite_error("Could not delete draft row", error))
}

fn update_row(
    transaction: &Transaction<'_>,
    photo_path: &str,
    original_json: &str,
    new_json: &str,
) -> Result<usize, String> {
    let statement = Query::update()
        .table(Drafts::Table)
        .value(Drafts::EntriesJson, new_json)
        .and_where(Expr::col(Drafts::PhotoPath).eq(photo_path))
        .and_where(Expr::col(Drafts::EntriesJson).eq(original_json))
        .to_owned();
    let (sql, values) = statement.build_rusqlite(SqliteQueryBuilder);
    transaction
        .execute(&sql, values.as_params().as_slice())
        .map_err(|error| sqlite_error("Could not update draft row", error))
}

#[cfg(test)]
pub(crate) fn database_file_path(app_data_dir: &Path) -> PathBuf {
    database_path(app_data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft_edits::{EditIntent, MetadataDraftEdit};
    use crate::metadata_draft_target::MetadataDraftTarget;
    use crate::metadata_occurrence::MetadataWriteTarget;
    use crate::metadata_value::MetadataValue;
    use crate::tag_schema::SchemaDefinitionId;
    use tempfile::tempdir;

    fn entry(value: &str) -> MetadataTargetDraftEntry {
        MetadataTargetDraftEntry {
            target: MetadataDraftTarget::NewProperty {
                schema_id: SchemaDefinitionId {
                    table: "XMP::dc".to_string(),
                    tag_id: "Title".to_string(),
                    index: None,
                },
                write_target: MetadataWriteTarget {
                    group1: "XMP-dc".to_string(),
                    group7: "ID-Title".to_string(),
                    tag_name: "Title".to_string(),
                },
            },
            edit: MetadataDraftEdit {
                value: Some(MetadataValue::Text(value.to_string())),
                intent: EditIntent::Set,
            },
        }
    }

    fn create_library_file(root: &Path, relative_path: &str) {
        let path = root.join(relative_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"photo").unwrap();
    }

    #[test]
    fn row_mutations_only_read_and_change_requested_folder_rows() {
        let app_data = tempdir().unwrap();
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        create_library_file(first.path(), "a.jpg");
        create_library_file(first.path(), "nested/b.jpg");
        create_library_file(second.path(), "other.jpg");
        let state = DraftRepositoryState::default();

        apply_row_mutations(
            app_data.path(),
            first.path().to_str().unwrap(),
            &[
                MetadataDraftRowMutation {
                    relative_path: "a.jpg".into(),
                    entries: vec![entry("a")],
                },
                MetadataDraftRowMutation {
                    relative_path: "nested/b.jpg".into(),
                    entries: vec![entry("b")],
                },
            ],
            &state,
        )
        .unwrap();
        apply_row_mutations(
            app_data.path(),
            second.path().to_str().unwrap(),
            &[MetadataDraftRowMutation {
                relative_path: "other.jpg".into(),
                entries: vec![entry("other")],
            }],
            &state,
        )
        .unwrap();
        apply_row_mutations(
            app_data.path(),
            first.path().to_str().unwrap(),
            &[MetadataDraftRowMutation {
                relative_path: "a.jpg".into(),
                entries: Vec::new(),
            }],
            &state,
        )
        .unwrap();

        let first_rows =
            load_metadata_draft_edits(app_data.path(), first.path().to_str().unwrap(), &state)
                .unwrap();
        assert_eq!(first_rows.len(), 1);
        assert_eq!(first_rows["nested/b.jpg"], vec![entry("b")]);
        let second_rows =
            load_metadata_draft_edits(app_data.path(), second.path().to_str().unwrap(), &state)
                .unwrap();
        assert_eq!(second_rows["other.jpg"], vec![entry("other")]);
    }

    #[test]
    fn select_all_relative_paths_is_folder_scoped_and_sorted() {
        let app_data = tempdir().unwrap();
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        create_library_file(first.path(), "z.jpg");
        create_library_file(first.path(), "nested/a.jpg");
        create_library_file(second.path(), "other.jpg");
        let state = DraftRepositoryState::default();

        apply_row_mutations(
            app_data.path(),
            first.path().to_str().unwrap(),
            &[
                MetadataDraftRowMutation {
                    relative_path: "z.jpg".into(),
                    entries: vec![entry("z")],
                },
                MetadataDraftRowMutation {
                    relative_path: "nested/a.jpg".into(),
                    entries: vec![entry("a")],
                },
            ],
            &state,
        )
        .unwrap();
        apply_row_mutations(
            app_data.path(),
            second.path().to_str().unwrap(),
            &[MetadataDraftRowMutation {
                relative_path: "other.jpg".into(),
                entries: vec![entry("other")],
            }],
            &state,
        )
        .unwrap();

        assert_eq!(
            select_all_relative_paths(app_data.path(), first.path().to_str().unwrap(), &state,)
                .unwrap(),
            vec!["nested/a.jpg".to_string(), "z.jpg".to_string()],
        );
    }

    #[test]
    fn duplicate_mutation_rolls_back_the_entire_transaction() {
        let app_data = tempdir().unwrap();
        let library = tempdir().unwrap();
        create_library_file(library.path(), "a.jpg");
        let state = DraftRepositoryState::default();
        let mutation = MetadataDraftRowMutation {
            relative_path: "a.jpg".into(),
            entries: vec![entry("draft")],
        };

        let error = apply_row_mutations(
            app_data.path(),
            library.path().to_str().unwrap(),
            &[mutation.clone(), mutation],
            &state,
        )
        .unwrap_err();

        assert!(error.contains("Duplicate draft row mutation"));
        assert!(load_metadata_draft_edits(
            app_data.path(),
            library.path().to_str().unwrap(),
            &state,
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn stale_reconciled_row_rolls_back_every_row_in_the_apply_chunk() {
        let app_data = tempdir().unwrap();
        let library = tempdir().unwrap();
        create_library_file(library.path(), "a.jpg");
        create_library_file(library.path(), "b.jpg");
        let state = DraftRepositoryState::default();
        apply_row_mutations(
            app_data.path(),
            library.path().to_str().unwrap(),
            &[
                MetadataDraftRowMutation {
                    relative_path: "a.jpg".into(),
                    entries: vec![entry("a-original")],
                },
                MetadataDraftRowMutation {
                    relative_path: "b.jpg".into(),
                    entries: vec![entry("b-original")],
                },
            ],
            &state,
        )
        .unwrap();
        let mut loaded = load_draft_rows(
            app_data.path(),
            library.path().to_str().unwrap(),
            &["a.jpg".into(), "b.jpg".into()],
            &state,
        )
        .unwrap();
        let a = loaded.remove(0);
        let b = loaded.remove(0);
        apply_row_mutations(
            app_data.path(),
            library.path().to_str().unwrap(),
            &[MetadataDraftRowMutation {
                relative_path: "a.jpg".into(),
                entries: vec![entry("a-concurrent")],
            }],
            &state,
        )
        .unwrap();

        let error = persist_reconciled_rows(
            app_data.path(),
            library.path().to_str().unwrap(),
            &[b.reconciled(Vec::new()), a.reconciled(Vec::new())],
            &state,
        )
        .unwrap_err();

        assert!(error.contains("changed concurrently"));
        let remaining =
            load_metadata_draft_edits(app_data.path(), library.path().to_str().unwrap(), &state)
                .unwrap();
        assert_eq!(remaining["a.jpg"], vec![entry("a-concurrent")]);
        assert_eq!(remaining["b.jpg"], vec![entry("b-original")]);
    }

    #[test]
    fn legacy_jsonl_migrates_once_to_absolute_keyed_rows() {
        let app_data = tempdir().unwrap();
        let library = tempdir().unwrap();
        create_library_file(library.path(), "a.jpg");
        let absolute = std::fs::canonicalize(library.path().join("a.jpg")).unwrap();
        let legacy = serde_json::json!({
            "schema_version": 6,
            "photo_path": absolute.to_string_lossy(),
            "edits": [entry("legacy")],
        });
        std::fs::write(
            app_data.path().join(TARGET_DRAFT_FILE_NAME),
            format!("// legacy\n{legacy}\n"),
        )
        .unwrap();
        let state = DraftRepositoryState::default();

        let loaded =
            load_metadata_draft_edits(app_data.path(), library.path().to_str().unwrap(), &state)
                .unwrap();

        assert_eq!(loaded["a.jpg"], vec![entry("legacy")]);
        assert!(database_file_path(app_data.path()).exists());
        assert!(!app_data.path().join(TARGET_DRAFT_FILE_NAME).exists());
        assert!(app_data.path().join(MIGRATED_DRAFT_FILE_NAME).exists());
    }
}
