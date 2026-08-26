/// Background folder scanning logic.
///
/// Three concerns are kept separate:
///  - `scan_folder` — fast directory walk, path + OS metadata only. Calls a
///    callback per file so callers can stream results.
///  - `read_file_metadata` — reads metadata for a single file using ExifTool.
///  - `thumbnail_for_media` — returns a real thumbnail or media placeholder.
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use walkdir::WalkDir;

mod media;
mod thumbnail;

use media::media_kind_from_extension;
pub use media::{placeholder_thumbnail, MediaKind};
#[cfg(test)]
use thumbnail::extract_exif_thumbnail;
pub use thumbnail::thumbnail_for;

fn path_identity(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        path.to_string_lossy().replace('\\', "/")
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string_lossy().into_owned()
    }
}

fn frontend_relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn media_kind_for_path(path: &Path) -> Option<MediaKind> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .and_then(|extension| media_kind_from_extension(&extension))
}

/// Return the thumbnail representation for any supported media file.
/// Images are decoded into real thumbnails; audio and video return their
/// built-in placeholders.
pub fn thumbnail_for_media(path: &Path) -> Option<String> {
    let media_kind = media_kind_for_path(path)?;
    match media_kind {
        MediaKind::Image => thumbnail_for(path),
        MediaKind::Audio | MediaKind::Video => placeholder_thumbnail(media_kind).map(str::to_owned),
    }
}
use crate::metadata_occurrence::{
    family7_group_from_runtime_tag_id, MetadataObservedSelector, MetadataOccurrence,
    MetadataOccurrenceId, MetadataOccurrences, MetadataSelectorKey, MetadataWriteTarget,
    RuntimeTagIdScope,
};
use crate::metadata_value::{
    consolidate_lang_alt_maps, is_exiftool_language_identifier, parse_metadata_value_from_raw_json,
    MetadataValue,
};
use crate::tag_schema::{normalize_runtime_tag_id, SchemaDefinitionId, TagKind, TagRegistry};

/// A single file entry from the directory walk.
/// Contains only path, media category and OS metadata — detailed metadata arrives separately.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct FileInfo {
    pub relative_path: String,
    pub filename: String,
    pub media_kind: MediaKind,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub date_modified: Option<i64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub date_created: Option<i64>,
}
/// A directory-walk failure (permission denied, broken symlink, IO error,
/// etc.).  Reported per-entry — the walk continues past the failure.
#[derive(Debug, Clone)]
pub struct WalkErrorInfo {
    /// The path that produced the error, if WalkDir was able to identify it.
    pub path: Option<String>,
    pub message: String,
}

/// Image-level metadata for a single file read by the backend scanner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct FileMetadata {
    pub relative_path: String,

    /// Authoritative runtime metadata occurrences.
    ///
    /// Each entry retains its concrete occurrence identity, semantic value,
    /// resolved schema information and exact write target. Several occurrences
    /// may share one schema definition without losing their runtime identity.
    pub occurrences: MetadataOccurrences,
}

fn metadata_occurrences_from_canonical(
    occurrences: &[CanonicalRuntimeOccurrence],
) -> MetadataOccurrences {
    let mut public_occurrences: Vec<_> = occurrences
        .iter()
        .map(|item| item.occurrence.clone())
        .collect();
    public_occurrences.sort_by(|left, right| left.id.cmp(&right.id));
    MetadataOccurrences(public_occurrences)
}

/// Walk `folder` and call `on_file` for each image file found.
/// Only reads OS metadata (a cheap `stat` call) — no image I/O.
/// Checks `cancellation_flag` and stops early if set to true.
///
/// Per-entry walk failures (permission denied, broken symlink, etc.) are
/// reported via `on_error` — they previously were silently dropped, leaving
/// the user wondering why files in a folder didn't appear.
pub fn scan_folder<P, E>(
    folder: &Path,
    cancellation_flag: Arc<AtomicBool>,
    mut on_file: P,
    mut on_error: E,
) where
    P: FnMut(FileInfo),
    E: FnMut(WalkErrorInfo),
{
    for entry in WalkDir::new(folder).follow_links(false) {
        if cancellation_flag.load(Ordering::Relaxed) {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                on_error(WalkErrorInfo {
                    path: err.path().map(|p| p.to_string_lossy().into_owned()),
                    message: err.to_string(),
                });
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let Some(media_kind) = media_kind_for_path(path) else {
            continue;
        };

        let rel = match path.strip_prefix(folder) {
            Ok(r) => frontend_relative_path(r),
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

        on_file(FileInfo {
            relative_path: rel,
            filename,
            media_kind,
            date_modified,
            date_created,
        });
    }
}

/// Read OS-level file metadata: modified and created timestamps.
fn read_os_metadata(path: &Path) -> (Option<i64>, Option<i64>) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (None, None),
    };
    let modified = meta.modified().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs() as i64)
    });
    let created = meta.created().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs() as i64)
    });
    (modified, created)
}

// ExifTool process execution is isolated from canonical parsing.
mod metadata_reader;
#[cfg(test)]
use metadata_reader::exiftool_read_args;
pub use metadata_reader::read_file_metadata_batch;

/// Parse one exiftool `-j` array into a map keyed by normalized SourceFile path.
/// Per-entry isolation: a single bad entry logs and is skipped, leaving the
/// rest intact.
///
/// Binary substitution: exiftool emits literal `"(Binary data N bytes, use -b
/// option to extract)"` strings for binary tags in `-j` output. Mentioning the
/// `-b` flag is meaningless to Media Library users (they never invoke exiftool
/// directly), so any key whose schema kind is `TagKind::Binary` is replaced
/// with a neutral `"<binary>"` string before semantic parsing.
#[derive(Debug, Clone, Serialize)]
pub struct MetadataReadFailure {
    pub relative_path: String,
    pub error_message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetadataBatchReadOutcome {
    pub results: Vec<FileMetadata>,
    pub failures: Vec<MetadataReadFailure>,
}

// Raw ExifTool JSON decoding and per-source isolation.
mod raw_parser;
pub use raw_parser::group_metadata_failures;
#[cfg(test)]
use raw_parser::*;
use raw_parser::{
    assemble_batch_outcome, try_parse_exiftool_pass_json_raw_with_registry_and_context,
    ExifToolPassOutput, RuntimeMap, RuntimeProperty,
};

#[cfg(test)]
fn runtime_property_key(
    group1: &str,
    document: &str,
    copy: &str,
    path: &str,
    family7_tag_id: &str,
    tag_name: &str,
) -> String {
    format!("{group1}:{document}:{copy}:{path}:ID-{family7_tag_id}:{tag_name}")
}

// Parse-warning classification, grouping and logging.
mod diagnostics;
#[cfg(test)]
use diagnostics::{classify_warning, group_parse_warnings, ParseWarningCategory, WarningGroupKey};
use diagnostics::{log_aggregated_warnings, log_single_warning, ParseWarning};

// Canonical occurrence construction and write-target assignment.
mod canonical;
use canonical::*;

#[cfg(test)]
fn parse_exiftool_batch_json(
    json: &str,
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
) -> Vec<FileMetadata> {
    let registry = crate::tag_schema::get_registry().ok();
    let mut map_by_source = try_parse_exiftool_pass_json_raw_with_registry(json, registry)
        .ok()
        .unwrap_or_default();
    let mut results = Vec::with_capacity(rel_paths.len());
    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let normalized_abs = path_identity(abs_path);
        let display_values = map_by_source
            .values_by_source
            .remove(&normalized_abs)
            .unwrap_or_else(|| {
                log::warn!(
                    "[parse_exiftool] Warning: No metadata found for path: {}",
                    normalized_abs
                );
                BTreeMap::new()
            });
        let canonical = canonical_occurrences_from_exiftool_pair(
            &BTreeMap::new(),
            &display_values,
            registry,
            rel_path,
            None,
        )
        .unwrap_or_default();
        results.push(FileMetadata {
            relative_path: rel_path.clone(),
            occurrences: metadata_occurrences_from_canonical(&canonical),
        });
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn test_schema_id(table: &str, tag_id: &str, index: Option<u32>) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: table.into(),
            tag_id: tag_id.into(),
            index,
        }
    }

    fn test_occurrence_id(path: &str, tag_id: &str) -> MetadataOccurrenceId {
        MetadataOccurrenceId {
            document: None,
            path: path.into(),
            runtime_tag_id: tag_id.into(),
            tag_id_scope: RuntimeTagIdScope {
                table: "Exif::Main".into(),
                tag_id: tag_id.into(),
                index: None,
            },
            copy: 0,
        }
    }

    fn test_occurrence_id_for_schema(
        path: &str,
        runtime_tag_id: &str,
        schema_id: &SchemaDefinitionId,
    ) -> MetadataOccurrenceId {
        let mut id = test_occurrence_id(path, runtime_tag_id);
        id.tag_id_scope = RuntimeTagIdScope {
            table: schema_id.table.clone(),
            tag_id: schema_id.tag_id.clone(),
            index: schema_id.index,
        };
        id
    }

    fn test_runtime_property(
        mut occurrence_id: MetadataOccurrenceId,
        schema_id: SchemaDefinitionId,
        group1: &str,
        tag_name: &str,
        language: Option<&str>,
        value: serde_json::Value,
    ) -> RuntimeProperty {
        occurrence_id.tag_id_scope = RuntimeTagIdScope {
            table: schema_id.table,
            tag_id: schema_id.tag_id,
            index: schema_id.index,
        };
        let raw_value =
            serde_json::value::to_raw_value(&value).expect("test value serializes as JSON");
        RuntimeProperty {
            occurrence_id,
            group1: group1.into(),
            tag_name: tag_name.into(),
            friendly_name: format!("{group1}:{tag_name}"),
            language: language.map(str::to_owned),
            value,
            raw_value,
        }
    }

    fn runtime_map(properties: Vec<RuntimeProperty>) -> RuntimeMap {
        properties
            .into_iter()
            .map(|property| (property.occurrence_id.clone(), property))
            .collect()
    }

    fn write_target_test_info(writable: bool, kind: TagKind) -> crate::tag_schema::TagInfo {
        crate::tag_schema::TagInfo {
            id: test_schema_id("Exif::Main", "282", None),
            group0: Some("EXIF".into()),
            group: "IFD0".into(),
            name: "XResolution".into(),
            writable,
            kind,
            description: Some("X resolution".into()),
            storage_count: None,
        }
    }

    fn write_target_test_occurrence(
        group1: &str,
        tag_name: &str,
        path: &str,
        copy: u32,
        document: Option<&str>,
        tag_info: Option<crate::tag_schema::TagInfo>,
        value: MetadataValue,
    ) -> CanonicalRuntimeOccurrence {
        let schema_id = tag_info
            .as_ref()
            .map(|info| info.id.clone())
            .unwrap_or_else(|| test_schema_id("Unknown::Table", tag_name, None));
        let tag_id_scope = RuntimeTagIdScope {
            table: schema_id.table.clone(),
            tag_id: schema_id.tag_id.clone(),
            index: schema_id.index,
        };
        CanonicalRuntimeOccurrence {
            occurrence: MetadataOccurrence {
                id: MetadataOccurrenceId {
                    document: document.map(str::to_owned),
                    path: path.into(),
                    runtime_tag_id: "282".into(),
                    tag_id_scope,
                    copy,
                },
                schema_id,
                value,
                tag_info,
                observed_selector: None,
                write_target: None,
            },
            friendly_name: format!("{group1}:{tag_name}"),
            runtime_group1: group1.into(),
            runtime_tag_name: tag_name.into(),
            language: None,
            is_lang_alt: false,
        }
    }

    fn collect(folder: &Path) -> Vec<FileInfo> {
        let mut files = Vec::new();
        scan_folder(
            folder,
            Arc::new(AtomicBool::new(false)),
            |p| files.push(p),
            |_| {},
        );
        files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        files
    }

    #[test]
    fn exiftool_read_arguments_match_between_passes_except_numeric_flag() {
        let display = exiftool_read_args(false);
        let raw = exiftool_read_args(true);

        assert_eq!(
            display.iter().filter(|arg| **arg == "-G:1:3:4:5:7").count(),
            1
        );
        assert_eq!(raw.iter().filter(|arg| **arg == "-G:1:3:4:5:7").count(), 1);
        assert!(!display.contains(&"-n"));
        assert_eq!(raw.iter().filter(|arg| **arg == "-n").count(), 1);
        assert_eq!(&raw[..display.len()], display.as_slice());
        for required in ["-a", "-struct", "-t", "-D", "-j"] {
            assert!(display.contains(&required));
            assert!(raw.contains(&required));
        }
        assert!(!display.contains(&"-G1"));
        assert!(!raw.contains(&"-G1"));
    }

    #[test]
    fn runtime_property_key_parses_occurrence_coordinates_and_friendly_name() {
        let primary =
            parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution")
                .unwrap();
        assert_eq!(primary.document, None);
        assert_eq!(primary.path, "JPEG-APP1-IFD0");
        assert_eq!(primary.runtime_tag_id, "282");
        assert_eq!(primary.copy, 0);
        assert_eq!(primary.group1, "IFD0");
        assert_eq!(primary.tag_name, "XResolution");
        assert_eq!(primary.friendly_name(), "IFD0:XResolution");

        let observed_primary =
            parse_runtime_property_key("IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution").unwrap();
        assert_eq!(observed_primary, primary);

        let doc1 = parse_runtime_property_key("IFD0:Doc1:Copy0:JPEG-APP1-IFD0:ID-282:XResolution")
            .unwrap();
        assert_eq!(doc1.document.as_deref(), Some("Doc1"));
        let nested =
            parse_runtime_property_key("Track1:Doc2-3:Copy0:QuickTime-Movie:ID-AbC:Tag").unwrap();
        assert_eq!(nested.document.as_deref(), Some("Doc2-3"));
        assert_eq!(nested.runtime_tag_id, "AbC");

        let copy1 = parse_runtime_property_key("IFD0:Main:Copy1:JPEG-APP1-IFD0:ID-282:XResolution")
            .unwrap();
        assert_ne!(copy1, primary);
        assert_eq!(copy1.copy, 1);

        let ifd1 = parse_runtime_property_key("IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution")
            .unwrap();
        assert_ne!(ifd1, primary);
        let other_id =
            parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-283:XResolution")
                .unwrap();
        assert_ne!(other_id, primary);

        let prefixed =
            parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-ID-AbC:Tag:With:Colons")
                .unwrap();
        assert_eq!(prefixed.runtime_tag_id, "ID-AbC");
        assert_eq!(prefixed.tag_name, "Tag:With:Colons");
    }

    #[test]
    fn runtime_property_key_rejects_malformed_coordinates() {
        for malformed in [
            "IFD0:Main:Copy0::ID-282:XResolution",
            "IFD0:Main:Copy0:JPEG-APP1-IFD0::XResolution",
            "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-:XResolution",
            "IFD0:Main:CopyX:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy-1:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy+1:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy00:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:Copy4294967296:JPEG-APP1-IFD0:ID-282:XResolution",
            "IFD0:Main:JPEG-APP1-IFD0:ID-282:XResolution",
        ] {
            assert!(
                parse_runtime_property_key(malformed).is_err(),
                "accepted malformed property key {malformed}"
            );
        }
    }

    #[test]
    fn parsed_source_property_constructs_complete_occurrence_id_from_both_sources() {
        let key = runtime_property_key(
            "IFD0",
            "Doc2-3",
            "Copy4",
            "JPEG-APP1-IFD0",
            "runtime-AbC",
            "XResolution",
        );
        let object = serde_json::json!({
            key: {
                "table": "Exif::Main",
                "id": "282",
                "index": 7,
                "lang": "en",
                "val": 300
            }
        })
        .as_object()
        .unwrap()
        .clone();

        let parsed = parse_single_source_object(object, None).unwrap();
        let schema_id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "282".into(),
            index: Some(7),
        };
        let occurrence_id = MetadataOccurrenceId {
            document: Some("Doc2-3".into()),
            path: "JPEG-APP1-IFD0".into(),
            runtime_tag_id: "runtime-AbC".into(),
            tag_id_scope: RuntimeTagIdScope {
                table: "Exif::Main".into(),
                tag_id: "282".into(),
                index: Some(7),
            },
            copy: 4,
        };
        let property = parsed.get(&occurrence_id).unwrap();
        assert_eq!(
            property
                .occurrence_id
                .tag_id_scope
                .as_schema_definition_id(),
            schema_id
        );
        assert_eq!(property.occurrence_id.runtime_tag_id, "runtime-AbC");
        assert_eq!(property.group1, "IFD0");
        assert_eq!(property.tag_name, "XResolution");
        assert_eq!(property.friendly_name, "IFD0:XResolution");
        assert_eq!(property.language.as_deref(), Some("en"));
        assert_eq!(property.value, serde_json::json!(300));
    }

    #[test]
    fn parser_keeps_ifd0_and_ifd1_occurrences_with_one_schema_identity() {
        let ifd0_key = "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution";
        let ifd1_key = "IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution";
        let object = serde_json::json!({
            ifd0_key: {"table":"Exif::Main","id":"282","val":300},
            ifd1_key: {"table":"Exif::Main","id":"282","val":72}
        })
        .as_object()
        .unwrap()
        .clone();

        let parsed = parse_single_source_object(object, None).unwrap();
        let ifd0 = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let ifd1 = test_occurrence_id("JPEG-APP1-IFD1", "282");
        assert_eq!(parsed.len(), 2);
        assert!(parsed.contains_key(&ifd0));
        assert!(parsed.contains_key(&ifd1));
        assert_ne!(ifd0, ifd1);
        assert_eq!(
            parsed[&ifd0].occurrence_id.tag_id_scope,
            parsed[&ifd1].occurrence_id.tag_id_scope
        );
        assert_ne!(parsed[&ifd0].value, parsed[&ifd1].value);

        let identical = serde_json::json!({
            ifd0_key: {"table":"Exif::Main","id":"282","val":300},
            ifd1_key: {"table":"Exif::Main","id":"282","val":300}
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(
            parse_single_source_object(identical, None).unwrap().len(),
            2
        );
    }

    #[test]
    fn iptc_dataset_zero_records_survive_parse_join_and_batch_assembly() {
        let source = "D:/batch/iptc-record-versions.jpg";
        let display_json = serde_json::json!([{
            "SourceFile": source,
            "IPTC:Main::JPEG-APP13-Photoshop-IPTC:ID-0:EnvelopeRecordVersion": {
                "table": "IPTC::EnvelopeRecord", "id": 0, "val": "4"
            },
            "IPTC:Main::JPEG-APP13-Photoshop-IPTC:ID-0:ApplicationRecordVersion": {
                "table": "IPTC::ApplicationRecord", "id": 0, "val": "4"
            }
        }])
        .to_string();
        let raw_json = serde_json::json!([{
            "SourceFile": source,
            "IPTC:Main::JPEG-APP13-Photoshop-IPTC:ID-0:EnvelopeRecordVersion": {
                "table": "IPTC::EnvelopeRecord", "id": 0, "val": 4
            },
            "IPTC:Main::JPEG-APP13-Photoshop-IPTC:ID-0:ApplicationRecordVersion": {
                "table": "IPTC::ApplicationRecord", "id": 0, "val": 4
            }
        }])
        .to_string();
        let registry = crate::tag_schema::get_registry().ok();
        let display = try_parse_exiftool_pass_json_raw_with_registry(&display_json, registry)
            .expect("display pass parses");
        let raw = try_parse_exiftool_pass_json_raw_with_registry(&raw_json, registry)
            .expect("raw pass parses");

        assert!(display.failures_by_source.is_empty());
        assert!(raw.failures_by_source.is_empty());
        let display_properties = &display.values_by_source[source];
        let raw_properties = &raw.values_by_source[source];
        assert_eq!(display_properties.len(), 2);
        assert_eq!(raw_properties.len(), 2);
        assert_eq!(
            display_properties.keys().collect::<Vec<_>>(),
            raw_properties.keys().collect::<Vec<_>>()
        );

        let ids = display_properties.keys().cloned().collect::<Vec<_>>();
        assert_ne!(ids[0], ids[1]);
        assert!(ids.iter().all(|id| {
            id.document.is_none()
                && id.path == "JPEG-APP13-Photoshop-IPTC"
                && id.runtime_tag_id == "0"
                && id.tag_id_scope.tag_id == "0"
                && id.tag_id_scope.index.is_none()
                && id.copy == 0
        }));
        assert_eq!(
            ids.iter()
                .map(|id| id.tag_id_scope.table.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["IPTC::ApplicationRecord", "IPTC::EnvelopeRecord"])
        );

        let canonical = canonical_occurrences_from_exiftool_pair(
            raw_properties,
            display_properties,
            registry,
            "iptc-record-versions.jpg",
            None,
        )
        .expect("raw and display properties join");
        assert_eq!(canonical.len(), 2);
        assert_eq!(
            canonical
                .iter()
                .map(|item| item.occurrence.schema_id.table.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["IPTC::ApplicationRecord", "IPTC::EnvelopeRecord"])
        );

        let outcome = assemble_batch_outcome(
            &["iptc-record-versions.jpg".to_owned()],
            &[std::path::PathBuf::from(source)],
            display,
            raw,
            registry,
            &mut Vec::new(),
        )
        .expect("batch assembly remains classifiable");
        assert!(outcome.failures.is_empty());
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].occurrences.len(), 2);
    }

    #[test]
    fn runtime_schema_ids_preserve_original_json_number_tokens() {
        let source = "D:/path/mpf.jpg";
        let json = r#"[
            {
                "SourceFile": "D:/path/mpf.jpg",
                "MPImage1:Main:Copy1:JPEG-APP2-MPF0-MPF:ID-02e1:MPImageFlags": {
                    "table": "MPF::MPImage",
                    "id": 0.1,
                    "val": 20
                },
                "Fixture:Main::Fixture-Metadata:ID-precise:PreciseId": {
                    "table": "TestFixture::Unknown",
                    "id": 0.10000000000000000000000000000000000001,
                    "val": [1.60]
                },
                "Fixture:Main::Fixture-Metadata:ID-exponent:ExponentId": {
                    "table": "TestFixture::Unknown",
                    "id": 1e-10000,
                    "val": 2
                },
                "Fixture:Main::Fixture-Metadata:ID-text:TextId": {
                    "table": "TestFixture::Unknown",
                    "id": "MadeUp\u003aThing",
                    "val": 3
                }
            }
        ]"#;

        let parsed = try_parse_exiftool_pass_json_raw_with_registry(json, None).unwrap();
        assert!(parsed.failures_by_source.is_empty());
        let properties = &parsed.values_by_source[source];
        assert_eq!(properties.len(), 4);
        assert_eq!(
            properties
                .keys()
                .map(|id| id.tag_id_scope.tag_id.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "0.1",
                "0.10000000000000000000000000000000000001",
                "1e-10000",
                "MadeUp:Thing",
            ])
        );

        let flags = properties
            .values()
            .find(|property| property.tag_name == "MPImageFlags")
            .unwrap();
        assert_eq!(flags.value, serde_json::json!(20));
        let precise = properties
            .values()
            .find(|property| property.tag_name == "PreciseId")
            .unwrap();
        assert_eq!(precise.raw_value.get(), "[1.60]");
    }

    #[test]
    fn invalid_runtime_schema_id_is_source_specific() {
        let json = r#"[
            {
                "SourceFile": "D:/path/good.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": 282,
                    "val": 300
                }
            },
            {
                "SourceFile": "D:/path/bad.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": true,
                    "val": 300
                }
            }
        ]"#;

        let parsed = try_parse_exiftool_pass_json_raw_with_registry(json, None).unwrap();
        assert!(parsed.values_by_source.contains_key("D:/path/good.jpg"));
        assert_eq!(
            parsed.failures_by_source["D:/path/bad.jpg"],
            "property IFD0:XResolution: ExifTool runtime tag id must be a number or string, got true"
        );
    }

    #[test]
    fn parser_rejects_every_repeated_complete_occurrence_id() {
        let primary = "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution";
        let explicit = "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution";
        for (second_key, second, expected) in [
            (
                explicit,
                serde_json::json!({"table":"Exif::Main","id":"282","lang":"en","val":300}),
                "number 300",
            ),
            (
                explicit,
                serde_json::json!({"table":"Exif::Main","id":"282","lang":"en","val":72}),
                "number 72",
            ),
            (
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:ResolutionAlias",
                serde_json::json!({"table":"Exif::Main","id":"282","lang":"en","val":300}),
                "ResolutionAlias",
            ),
            (
                "Alias:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution",
                serde_json::json!({"table":"Exif::Main","id":"282","lang":"fr","val":300}),
                "Alias",
            ),
        ] {
            let mut object = serde_json::Map::new();
            object.insert(
                primary.to_string(),
                serde_json::json!({"table":"Exif::Main","id":"282","lang":"en","val":300}),
            );
            object.insert(second_key.to_string(), second);
            let error = parse_single_source_object(object, None).unwrap_err();
            assert!(error.contains("duplicate complete runtime occurrence ID"));
            assert!(error.contains(expected), "unexpected error: {error}");
            assert!(error.contains("<direct source object>"));
            assert!(error.contains("<unknown pass>"));
            assert!(error.contains("Exif::Main"));
            assert!(error.contains("first: group1="));
            assert!(error.contains("second: group1="));
            assert!(error.contains("raw_scope="));
            assert!(error.contains("language="));
            assert!(error.contains("value="));
        }

        let different_table = serde_json::json!({
            primary: {"table":"Exif::Main","id":"282","lang":"en","val":300},
            explicit: {"table":"Exif::Other","id":"282","lang":"en","val":300}
        })
        .as_object()
        .unwrap()
        .clone();
        let different_table = parse_single_source_object(different_table, None).unwrap();
        assert_eq!(different_table.len(), 2);
        assert_eq!(
            different_table
                .keys()
                .map(|id| id.tag_id_scope.table.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["Exif::Main", "Exif::Other"])
        );
    }

    #[test]
    fn duplicate_failure_is_source_specific_and_neighbours_are_assembled() {
        let display_json = r#"[
            {
                "SourceFile":"D:/path/Image1.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":"300 dpi"}
            },
            {
                "SourceFile":"D:/path/Image2.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":"300 dpi"},
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":"300 dpi"}
            },
            {
                "SourceFile":"D:/path/Image3.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":"72 dpi"}
            }
        ]"#;
        let raw_json = r#"[
            {
                "SourceFile":"D:/path/Image1.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":300}
            },
            {
                "SourceFile":"D:/path/Image2.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":300}
            },
            {
                "SourceFile":"D:/path/Image3.jpg",
                "IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":72}
            }
        ]"#;

        let display = try_parse_exiftool_pass_json_raw_with_registry_and_context(
            display_json,
            None,
            Some("display pass"),
        )
        .unwrap();
        let raw = try_parse_exiftool_pass_json_raw_with_registry_and_context(
            raw_json,
            None,
            Some("raw (-n) pass"),
        )
        .unwrap();
        assert_eq!(display.values_by_source.len(), 2);
        assert_eq!(display.failures_by_source.len(), 1);
        let failure = &display.failures_by_source["D:/path/Image2.jpg"];
        assert!(failure.contains("D:/path/Image2.jpg"));
        assert!(failure.contains("display pass"));
        assert!(display.values_by_source.contains_key("D:/path/Image1.jpg"));
        assert!(display.values_by_source.contains_key("D:/path/Image3.jpg"));

        let outcome = assemble_batch_outcome(
            &[
                "Image1.jpg".into(),
                "Image2.jpg".into(),
                "Image3.jpg".into(),
            ],
            &[
                "D:/path/Image1.jpg".into(),
                "D:/path/Image2.jpg".into(),
                "D:/path/Image3.jpg".into(),
            ],
            display,
            raw,
            None,
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(outcome.results.len(), 2);
        assert_eq!(outcome.failures.len(), 1);
        assert_eq!(outcome.failures[0].relative_path, "Image2.jpg");
        assert_eq!(
            outcome
                .results
                .iter()
                .map(|result| result.relative_path.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["Image1.jpg", "Image3.jpg"])
        );
    }

    #[test]
    fn malformed_runtime_property_is_a_source_specific_failure() {
        let json = r#"[
            {"SourceFile":"D:/bad.jpg","IFD0:broken":{"table":"Exif::Main","id":"282","val":300}},
            {"SourceFile":"D:/good.jpg","IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution":{"table":"Exif::Main","id":"282","val":300}}
        ]"#;
        let parsed = try_parse_exiftool_pass_json_raw(json).unwrap();
        assert!(parsed.failures_by_source.contains_key("D:/bad.jpg"));
        assert!(parsed.values_by_source.contains_key("D:/good.jpg"));
    }

    #[test]
    fn pretty_and_raw_source_properties_share_occurrence_id() {
        let key = "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution";
        let pretty = format!(
            r#"[{{"SourceFile":"D:/a.jpg","{key}":{{"table":"Exif::Main","id":"282","val":"300 dpi"}}}}]"#
        );
        let raw = format!(
            r#"[{{"SourceFile":"D:/a.jpg","{key}":{{"table":"Exif::Main","id":"282","val":300}}}}]"#
        );
        let pretty = try_parse_exiftool_pass_json_raw(&pretty).unwrap();
        let raw = try_parse_exiftool_pass_json_raw(&raw).unwrap();
        let pretty_property = pretty.values_by_source["D:/a.jpg"].values().next().unwrap();
        let raw_property = raw.values_by_source["D:/a.jpg"].values().next().unwrap();
        assert_eq!(pretty_property.occurrence_id, raw_property.occurrence_id);
    }

    #[test]
    fn pretty_raw_join_is_occurrence_keyed_and_deterministic() {
        let registry = crate::tag_schema::TagRegistry::from_listx_xml(
            r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <tag id='282' name='XResolution' type='int32u' writable='true'>
  <desc lang='en'>X Resolution</desc>
 </tag>
</table>
</taginfo>"#,
        )
        .expect("build controlled IFD resolution registry");
        let schema = test_schema_id("EXIF::Main", "282", None);
        let info = registry.lookup(&schema).unwrap();
        let ifd0 = test_occurrence_id_for_schema("JPEG-APP1-IFD0", "282", &schema);
        let mut ifd1 = test_occurrence_id_for_schema("JPEG-APP1-IFD1", "282", &schema);
        ifd1.copy = 2;
        let raw = runtime_map(vec![
            test_runtime_property(
                ifd1.clone(),
                schema.clone(),
                "IFD1",
                "XResolution",
                None,
                serde_json::json!(72),
            ),
            test_runtime_property(
                ifd0.clone(),
                schema.clone(),
                "IFD0",
                "XResolution",
                None,
                serde_json::json!(300),
            ),
        ]);
        let pretty = runtime_map(vec![
            test_runtime_property(
                ifd0.clone(),
                schema.clone(),
                "IFD0",
                "XResolution",
                None,
                serde_json::json!("300 dpi"),
            ),
            test_runtime_property(
                ifd1.clone(),
                schema.clone(),
                "IFD1",
                "XResolution",
                None,
                serde_json::json!("72 dpi"),
            ),
        ]);

        let canonical = canonical_occurrences_from_exiftool_pair(
            &raw,
            &pretty,
            Some(&registry),
            "resolution.jpg",
            None,
        )
        .unwrap();
        assert_eq!(canonical.len(), 2);
        assert_eq!(canonical[0].occurrence.id, ifd0);
        assert_eq!(canonical[1].occurrence.id, ifd1);
        assert_eq!(canonical[0].occurrence.id.copy, 0);
        assert_eq!(canonical[1].occurrence.id.copy, 2);
        assert_eq!(canonical[0].occurrence.schema_id, schema);
        assert_eq!(
            canonical[0].occurrence.schema_id,
            canonical[1].occurrence.schema_id
        );
        assert_eq!(canonical[0].occurrence.tag_info.as_ref(), Some(info));
        assert_eq!(canonical[1].occurrence.tag_info.as_ref(), Some(info));
        assert_eq!(canonical[0].occurrence.value, MetadataValue::Integer(300));
        assert_eq!(canonical[1].occurrence.value, MetadataValue::Integer(72));
        assert_ne!(canonical[0].occurrence.id, canonical[1].occurrence.id);
        assert_eq!(
            canonical[0].occurrence.tag_info,
            canonical[1].occurrence.tag_info
        );
        let ifd0_target = canonical[0].occurrence.write_target.as_ref().unwrap();
        let ifd1_target = canonical[1].occurrence.write_target.as_ref().unwrap();
        assert_eq!(ifd0_target.group1, "IFD0");
        assert_eq!(ifd1_target.group1, "IFD1");
        assert_eq!(ifd0_target.selector(), "1IFD0:7ID-282:XResolution");
        assert_eq!(ifd1_target.selector(), "1IFD1:7ID-282:XResolution");
        assert_eq!(
            canonical[0].occurrence.tag_info.as_ref().unwrap().group,
            "IFD0"
        );
        assert_eq!(
            canonical[1].occurrence.tag_info.as_ref().unwrap().group,
            "IFD0"
        );
        assert!(canonical[0].occurrence.has_writable_target());
        assert!(canonical[1].occurrence.has_writable_target());
    }

    #[test]
    fn exact_write_target_base_eligibility_is_conservative() {
        let supported = write_target_test_info(true, TagKind::Rational);
        let cases = [
            write_target_test_occurrence(
                "Unknown",
                "XResolution",
                "unresolved",
                0,
                None,
                None,
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "ReadOnly",
                "XResolution",
                "readonly",
                0,
                None,
                Some(write_target_test_info(false, TagKind::Rational)),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "Binary",
                "XResolution",
                "binary",
                0,
                None,
                Some(write_target_test_info(true, TagKind::Binary)),
                MetadataValue::Binary,
            ),
            write_target_test_occurrence(
                "UnknownKind",
                "XResolution",
                "unknown-kind",
                0,
                None,
                Some(write_target_test_info(true, TagKind::Unknown)),
                MetadataValue::Unknown {
                    expected: Some(TagKind::Unknown),
                    raw: serde_json::json!(300),
                    reason: Some("unsupported schema kind".into()),
                },
            ),
            write_target_test_occurrence(
                "Embedded",
                "XResolution",
                "embedded",
                0,
                Some("Doc1"),
                Some(supported.clone()),
                MetadataValue::Integer(300),
            ),
        ];

        for mut occurrence in cases {
            assign_exact_write_targets(std::slice::from_mut(&mut occurrence));
            assert!(
                occurrence.occurrence.write_target.is_none(),
                "unexpected target for {}",
                occurrence.friendly_name
            );
            assert!(!occurrence.occurrence.has_writable_target());
        }
    }

    #[test]
    fn unique_nonzero_copy_receives_exact_runtime_selector() {
        let mut occurrence = write_target_test_occurrence(
            "IFD1",
            "XResolution",
            "unique-copy",
            2,
            None,
            Some(write_target_test_info(true, TagKind::Rational)),
            MetadataValue::Integer(72),
        );

        assign_exact_write_targets(std::slice::from_mut(&mut occurrence));

        let target = occurrence.occurrence.write_target.as_ref().unwrap();
        assert_eq!(target.selector(), "1IFD1:7ID-282:XResolution");
        assert!(occurrence.occurrence.has_writable_target());
    }

    #[test]
    fn copy_numbers_do_not_couple_distinct_runtime_selectors() {
        let info = write_target_test_info(true, TagKind::Rational);
        let mut occurrences = vec![
            write_target_test_occurrence(
                "JFIF",
                "XResolution",
                "jfif",
                0,
                None,
                Some(info.clone()),
                MetadataValue::Integer(72),
            ),
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "ifd0",
                1,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD1",
                "XResolution",
                "ifd1",
                2,
                None,
                Some(info),
                MetadataValue::Integer(96),
            ),
        ];

        assign_exact_write_targets(&mut occurrences);

        assert_eq!(
            occurrences
                .iter()
                .map(|item| {
                    assert_eq!(item.occurrence.tag_info.as_ref().unwrap().group, "IFD0");
                    item.occurrence.write_target.as_ref().unwrap().selector()
                })
                .collect::<Vec<_>>(),
            [
                "1JFIF:7ID-282:XResolution",
                "1IFD0:7ID-282:XResolution",
                "1IFD1:7ID-282:XResolution"
            ]
        );
    }

    #[test]
    fn same_group_and_name_with_different_runtime_family7_ids_are_distinct_targets() {
        let mut info = write_target_test_info(true, TagKind::Rational);
        info.name = "SharedName".into();
        let mut first = write_target_test_occurrence(
            "IFD0",
            "SharedName",
            "first",
            0,
            None,
            Some(info.clone()),
            MetadataValue::Integer(1),
        );
        first.occurrence.id.runtime_tag_id = "282".into();
        let mut second = write_target_test_occurrence(
            "IFD0",
            "SharedName",
            "second",
            1,
            None,
            Some(info),
            MetadataValue::Integer(2),
        );
        second.occurrence.id.runtime_tag_id = "ID-AbC".into();
        let mut occurrences = vec![first, second];

        assign_exact_write_targets(&mut occurrences);

        assert_eq!(
            occurrences
                .iter()
                .map(|item| item.occurrence.write_target.as_ref().unwrap().selector())
                .collect::<Vec<_>>(),
            ["1IFD0:7ID-282:SharedName", "1IFD0:7ID-ID-AbC:SharedName"]
        );
    }

    #[test]
    fn selector_siblings_make_every_matching_occurrence_ambiguous() {
        let info = write_target_test_info(true, TagKind::Rational);
        let copy0 = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "same-path",
            0,
            None,
            Some(info.clone()),
            MetadataValue::Integer(300),
        );
        let copy1 = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "same-path",
            1,
            None,
            Some(info.clone()),
            MetadataValue::Integer(72),
        );
        let mut copies = vec![copy0, copy1];
        assign_exact_write_targets(&mut copies);
        assert!(copies
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));

        let mut non_primary_copies = vec![
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "copy-1",
                1,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "copy-2",
                2,
                None,
                Some(info.clone()),
                MetadataValue::Integer(72),
            ),
        ];
        assign_exact_write_targets(&mut non_primary_copies);
        assert!(non_primary_copies
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));

        let mut different_paths = vec![
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "JPEG-APP1-IFD0",
                0,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "Other-IFD0-Path",
                0,
                None,
                Some(info),
                MetadataValue::Integer(300),
            ),
        ];
        assign_exact_write_targets(&mut different_paths);
        assert!(different_paths
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));
    }

    #[test]
    fn selector_ambiguity_is_ascii_case_insensitive_and_counts_ineligible_siblings() {
        let mut uppercase_info = write_target_test_info(true, TagKind::Rational);
        uppercase_info.name = "XRESOLUTION".into();
        let mut occurrences = vec![
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "primary",
                0,
                None,
                Some(write_target_test_info(true, TagKind::Rational)),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "ifd0",
                "XRESOLUTION",
                "embedded",
                0,
                Some("Doc1"),
                Some(uppercase_info),
                MetadataValue::Integer(72),
            ),
        ];
        assign_exact_write_targets(&mut occurrences);
        assert!(occurrences
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));
        assert!(occurrences
            .iter()
            .all(|item| item.occurrence.observed_selector.is_some()));
    }

    #[test]
    fn selector_uniqueness_preserves_runtime_family7_case() {
        let mut upper = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "upper",
            0,
            None,
            Some(write_target_test_info(true, TagKind::Rational)),
            MetadataValue::Integer(300),
        );
        upper.occurrence.id.runtime_tag_id = "AbC".into();
        let mut lower = write_target_test_occurrence(
            "ifd0",
            "xresolution",
            "lower",
            0,
            None,
            Some({
                let mut info = write_target_test_info(true, TagKind::Rational);
                info.name = "xresolution".into();
                info
            }),
            MetadataValue::Integer(72),
        );
        lower.occurrence.id.runtime_tag_id = "abc".into();
        let mut occurrences = vec![upper, lower];

        assign_exact_write_targets(&mut occurrences);

        assert_eq!(
            occurrences[0]
                .occurrence
                .observed_selector
                .as_ref()
                .unwrap()
                .group7,
            "ID-AbC"
        );
        assert_eq!(
            occurrences[1]
                .occurrence
                .observed_selector
                .as_ref()
                .unwrap()
                .group7,
            "ID-abc"
        );
        assert!(occurrences
            .iter()
            .all(|item| item.occurrence.write_target.is_some()));
    }

    #[test]
    fn aliases_unsafe_selectors_and_lang_alt_children_have_no_target() {
        let info = write_target_test_info(true, TagKind::Rational);
        let mut alias = write_target_test_occurrence(
            "IFD0",
            "ResolutionAlias",
            "alias",
            0,
            None,
            Some(info.clone()),
            MetadataValue::Integer(300),
        );
        assign_exact_write_targets(std::slice::from_mut(&mut alias));
        assert!(alias.occurrence.write_target.is_none());
        assert!(alias.occurrence.observed_selector.is_some());

        for (group1, tag_name) in [
            ("", "XResolution"),
            ("IFD0=bad", "XResolution"),
            ("IFD0\n", "XResolution"),
            ("IFD0", ""),
            ("IFD0", "X:Resolution"),
            ("IFD0", "XResolution=300"),
            ("IFD0", "XResolution\r"),
            ("IFD0\0", "XResolution"),
        ] {
            let mut matching_info = info.clone();
            matching_info.name = tag_name.into();
            let mut occurrence = write_target_test_occurrence(
                group1,
                tag_name,
                "unsafe",
                0,
                None,
                Some(matching_info),
                MetadataValue::Integer(300),
            );
            assign_exact_write_targets(std::slice::from_mut(&mut occurrence));
            assert!(occurrence.occurrence.write_target.is_none());
            assert!(occurrence.occurrence.observed_selector.is_none());
        }

        let mut lang_alt_info = write_target_test_info(true, TagKind::LangAlt);
        lang_alt_info.name = "Title".into();
        let mut lang_alt = write_target_test_occurrence(
            "XMP-dc",
            "Title",
            "lang-en",
            0,
            None,
            Some(lang_alt_info),
            MetadataValue::LangAlt(BTreeMap::from([("en".into(), "Hello".into())])),
        );
        lang_alt.is_lang_alt = true;
        lang_alt.language = Some("en".into());
        assign_exact_write_targets(std::slice::from_mut(&mut lang_alt));
        assert!(lang_alt.occurrence.write_target.is_none());
        assert!(lang_alt.occurrence.observed_selector.is_some());
    }

    #[test]
    fn known_schema_with_unparsed_value_can_receive_exact_target() {
        let mut occurrence = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "unique",
            0,
            None,
            Some(write_target_test_info(true, TagKind::Rational)),
            MetadataValue::Unknown {
                expected: Some(TagKind::Rational),
                raw: serde_json::json!("not a rational"),
                reason: Some("parse failed".into()),
            },
        );
        assign_exact_write_targets(std::slice::from_mut(&mut occurrence));
        assert_eq!(
            occurrence
                .occurrence
                .write_target
                .as_ref()
                .map(MetadataWriteTarget::selector),
            Some("1IFD0:7ID-282:XResolution".into())
        );
        let observed = occurrence.occurrence.observed_selector.as_ref().unwrap();
        let writable = occurrence.occurrence.write_target.as_ref().unwrap();
        assert_eq!(observed.group1, writable.group1);
        assert_eq!(observed.group7, writable.group7);
        assert_eq!(observed.tag_name, writable.tag_name);
        assert!(occurrence.occurrence.has_writable_target());
    }

    #[test]
    fn target_assignment_is_independent_of_input_order() {
        let info = write_target_test_info(true, TagKind::Rational);
        let occurrences = vec![
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "ambiguous-a",
                0,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD0",
                "XResolution",
                "ambiguous-b",
                1,
                None,
                Some(info.clone()),
                MetadataValue::Integer(300),
            ),
            write_target_test_occurrence(
                "IFD1",
                "XResolution",
                "unique",
                2,
                None,
                Some(info),
                MetadataValue::Integer(72),
            ),
        ];
        let mut forward = occurrences.clone();
        let mut reverse = occurrences;
        reverse.reverse();
        assign_exact_write_targets(&mut forward);
        assign_exact_write_targets(&mut reverse);

        let targets = |items: Vec<CanonicalRuntimeOccurrence>| {
            items
                .into_iter()
                .map(|item| (item.occurrence.id, item.occurrence.write_target))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(targets(forward), targets(reverse));
    }

    #[test]
    fn unresolved_canonical_occurrence_preserves_runtime_identity_and_unknown_value() {
        let schema_id = test_schema_id("Custom::Unknown", "schema-candidate", Some(0));
        let occurrence_id =
            test_occurrence_id_for_schema("Custom-Container", "runtime-unknown", &schema_id);
        let property = test_runtime_property(
            occurrence_id.clone(),
            schema_id.clone(),
            "Custom",
            "Mystery",
            None,
            serde_json::json!({"nested": true}),
        );

        let canonical = canonical_occurrences_from_exiftool_pair(
            &runtime_map(vec![property.clone()]),
            &runtime_map(vec![property]),
            Some(&canonical_registry()),
            "unknown.jpg",
            None,
        )
        .unwrap();
        assert_eq!(canonical.len(), 1);
        let item = &canonical[0];
        assert_eq!(item.occurrence.id, occurrence_id);
        assert_eq!(item.occurrence.schema_id, schema_id);
        assert_eq!(item.friendly_name, "Custom:Mystery");
        assert!(item.occurrence.tag_info.is_none());
        assert!(item.occurrence.write_target.is_none());
        assert!(matches!(
            &item.occurrence.value,
            MetadataValue::Unknown { raw, expected: None, .. }
                if raw == &serde_json::json!({"nested": true})
        ));
    }

    #[test]
    fn pretty_raw_join_rejects_cross_pass_property_inconsistency() {
        let occurrence = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let base_schema = test_schema_id("Exif::Main", "282", None);
        let raw_property = test_runtime_property(
            occurrence.clone(),
            base_schema.clone(),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!(300),
        );

        let cases = [
            (
                test_runtime_property(
                    occurrence.clone(),
                    base_schema.clone(),
                    "IFD1",
                    "ResolutionAlias",
                    None,
                    serde_json::json!("300 dpi"),
                ),
                "family-1 group or tag name",
            ),
            (
                test_runtime_property(
                    occurrence.clone(),
                    base_schema.clone(),
                    "IFD0",
                    "XResolution",
                    Some("en"),
                    serde_json::json!("300 dpi"),
                ),
                "language",
            ),
        ];
        for (pretty_property, expected) in cases {
            let error = canonical_occurrences_from_exiftool_pair(
                &runtime_map(vec![raw_property.clone()]),
                &runtime_map(vec![pretty_property]),
                None,
                "bad.jpg",
                None,
            )
            .unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
            assert!(error.contains("JPEG-APP1-IFD0"));
        }
    }

    #[test]
    fn pretty_raw_properties_with_different_scopes_do_not_false_join() {
        let occurrence = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let raw_property = test_runtime_property(
            occurrence.clone(),
            test_schema_id("Exif::Main", "282", None),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!(300),
        );
        let pretty_property = test_runtime_property(
            occurrence,
            test_schema_id("Exif::Other", "282", None),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!("300 dpi"),
        );

        let canonical = canonical_occurrences_from_exiftool_pair(
            &runtime_map(vec![raw_property]),
            &runtime_map(vec![pretty_property]),
            None,
            "different-scopes.jpg",
            None,
        )
        .unwrap();
        assert_eq!(canonical.len(), 2);
        assert_ne!(canonical[0].occurrence.id, canonical[1].occurrence.id);
    }

    #[test]
    fn pretty_raw_join_supports_single_pass_occurrences() {
        let schema = test_schema_id("Exif::Main", "282", None);
        let raw_only = test_runtime_property(
            test_occurrence_id("A", "282"),
            schema.clone(),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!(300),
        );
        let pretty_only = test_runtime_property(
            test_occurrence_id("B", "282"),
            schema,
            "IFD1",
            "XResolution",
            None,
            serde_json::json!("72 dpi"),
        );
        let canonical = canonical_occurrences_from_exiftool_pair(
            &runtime_map(vec![raw_only]),
            &runtime_map(vec![pretty_only]),
            None,
            "partial.jpg",
            None,
        )
        .unwrap();
        assert_eq!(canonical.len(), 2);
    }

    #[test]
    fn production_exiftool_arguments_emit_parseable_occurrence_coordinates() {
        let temp = tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test_images")
            .join("real_with_exif.jpg");
        let copy = temp.path().join("representative.jpg");
        fs::copy(source, &copy).unwrap();

        let mut command = crate::exiftool_config::exiftool_command();
        command.args(exiftool_read_args(false)).arg(&copy);
        let output = command.output().expect("run installed ExifTool");
        assert!(
            output.status.success(),
            "ExifTool failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let entries: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
        let object = entries[0].as_object().unwrap();
        let parsed: Vec<_> = object
            .keys()
            .filter(|key| key.as_str() != "SourceFile")
            .map(|key| {
                parse_runtime_property_key(key)
                    .unwrap_or_else(|error| panic!("unexpected ExifTool key `{key}`: {error}"))
            })
            .collect();

        assert!(!parsed.is_empty());
        assert!(parsed.iter().any(|key| !key.path.is_empty()));
        assert!(parsed.iter().any(|key| !key.runtime_tag_id.is_empty()));
        assert!(parsed
            .iter()
            .any(|key| { key.document.is_none() && key.copy == 0 }));
        assert!(parsed
            .iter()
            .all(|key| key.friendly_name() == format!("{}:{}", key.group1, key.tag_name)));

        let resolutions: Vec<_> = parsed
            .iter()
            .filter(|key| {
                key.tag_name == "XResolution" && matches!(key.group1.as_str(), "IFD0" | "IFD1")
            })
            .collect();
        if resolutions.len() >= 2 {
            assert_ne!(resolutions[0].path, resolutions[1].path);
        }

        let runtime_map = parse_single_source_object(object.clone(), None).unwrap();
        let runtime_resolutions: Vec<_> = runtime_map
            .values()
            .filter(|property| {
                property.tag_name == "XResolution"
                    && matches!(property.group1.as_str(), "IFD0" | "IFD1")
            })
            .collect();
        if runtime_resolutions.len() >= 2 {
            assert_eq!(
                runtime_resolutions[0].occurrence_id.tag_id_scope,
                runtime_resolutions[1].occurrence_id.tag_id_scope
            );
            assert_ne!(
                runtime_resolutions[0].occurrence_id,
                runtime_resolutions[1].occurrence_id
            );
            assert!(runtime_map.contains_key(&runtime_resolutions[0].occurrence_id));
            assert!(runtime_map.contains_key(&runtime_resolutions[1].occurrence_id));
        }
    }
    #[cfg(feature = "integration")]
    #[test]
    fn public_batch_read_exposes_only_authoritative_shared_schema_occurrences() {
        let temp = tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test_images")
            .join("real_with_exif.jpg");
        let copy = temp.path().join("public-occurrences.jpg");
        fs::copy(source, &copy).unwrap();

        let mut initialise = crate::exiftool_config::exiftool_command();
        let initial_output = initialise
            .args([
                "-overwrite_original",
                "-IFD0:XResolution=300",
                "-IFD1:XResolution=300",
                "-IFD0:YResolution=300",
                "-IFD1:YResolution=300",
            ])
            .arg(&copy)
            .output()
            .expect("initialise disposable matching IFD resolutions");
        assert!(
            initial_output.status.success(),
            "ExifTool setup failed: {}",
            String::from_utf8_lossy(&initial_output.stderr)
        );

        let relative_paths = ["public-occurrences.jpg".to_string()];
        let absolute_paths = [copy.clone()];
        let outcome = read_file_metadata_batch(&relative_paths, &absolute_paths).unwrap();
        assert!(outcome.failures.is_empty(), "{:#?}", outcome.failures);
        assert_eq!(outcome.results.len(), 1);
        let result = &outcome.results[0];
        assert!(!result.occurrences.is_empty());
        assert!(result
            .occurrences
            .0
            .windows(2)
            .all(|pair| pair[0].id <= pair[1].id));

        let wire = serde_json::to_value(result).unwrap();
        let wire_object = wire.as_object().unwrap();
        assert_eq!(wire_object.len(), 2);
        assert!(wire_object.contains_key("relative_path"));
        assert!(wire_object.contains_key("occurrences"));
        assert!(!wire_object.contains_key("metadata"));
        assert!(!wire["occurrences"].as_array().unwrap().is_empty());

        let resolutions: Vec<_> = result
            .occurrences
            .iter()
            .filter(|occurrence| {
                occurrence
                    .tag_info
                    .as_ref()
                    .is_some_and(|info| info.name == "XResolution")
                    && matches!(
                        occurrence
                            .write_target
                            .as_ref()
                            .map(|target| target.group1.as_str()),
                        Some("IFD0" | "IFD1")
                    )
            })
            .collect();
        assert_eq!(resolutions.len(), 2);
        let ifd0 = resolutions
            .iter()
            .find(|occurrence| occurrence.write_target.as_ref().unwrap().group1 == "IFD0")
            .unwrap();
        let ifd1 = resolutions
            .iter()
            .find(|occurrence| occurrence.write_target.as_ref().unwrap().group1 == "IFD1")
            .unwrap();
        assert_eq!(ifd0.id.document, None);
        assert_eq!(ifd0.id.path, "JPEG-APP1-IFD0");
        assert_eq!(ifd0.id.runtime_tag_id, "282");
        assert_eq!(
            ifd0.id.tag_id_scope,
            RuntimeTagIdScope {
                table: "Exif::Main".into(),
                tag_id: "282".into(),
                index: None,
            }
        );
        assert_eq!(ifd0.id.copy, 0);
        assert_eq!(ifd1.id.document, None);
        assert_eq!(ifd1.id.path, "JPEG-APP1-IFD1");
        assert_eq!(ifd1.id.runtime_tag_id, "282");
        assert_eq!(ifd1.id.tag_id_scope, ifd0.id.tag_id_scope);
        assert!(ifd1.id.copy > 0);
        assert_eq!(ifd0.tag_info, ifd1.tag_info);
        assert_eq!(
            ifd0.write_target.as_ref().unwrap().selector(),
            "1IFD0:7ID-282:XResolution"
        );
        assert_eq!(
            ifd1.write_target.as_ref().unwrap().selector(),
            "1IFD1:7ID-282:XResolution"
        );
        let schema = ifd0.schema_id.clone();
        assert_eq!(result.occurrences.for_schema(&schema).count(), 2);

        let mut make_conflict = crate::exiftool_config::exiftool_command();
        let conflict_output = make_conflict
            .args(["-overwrite_original", "-IFD1:XResolution=72"])
            .arg(&copy)
            .output()
            .expect("create disposable conflicting IFD resolutions");
        assert!(
            conflict_output.status.success(),
            "ExifTool conflict setup failed: {}",
            String::from_utf8_lossy(&conflict_output.stderr)
        );

        let conflicting = read_file_metadata_batch(&relative_paths, &absolute_paths).unwrap();
        assert!(
            conflicting.failures.is_empty(),
            "{:#?}",
            conflicting.failures
        );
        assert_eq!(conflicting.results.len(), 1);
        let result = &conflicting.results[0];
        let resolutions = result.occurrences.for_schema(&schema).collect::<Vec<_>>();
        assert_eq!(resolutions.len(), 2);
        assert_ne!(resolutions[0].id, resolutions[1].id);
        let whole_number = |item: &MetadataOccurrence| match &item.value {
            MetadataValue::Rational(value) if value.denominator == 1 => value.numerator,
            other => panic!("expected whole-number rational, got {other:?}"),
        };
        assert!(resolutions.iter().any(|item| {
            whole_number(item) == 300
                && item.write_target.as_ref().unwrap().selector() == "1IFD0:7ID-282:XResolution"
        }));
        assert!(resolutions.iter().any(|item| {
            whole_number(item) == 72
                && item.write_target.as_ref().unwrap().selector() == "1IFD1:7ID-282:XResolution"
        }));

        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 2);
        assert!(wire.get("metadata").is_none());
        let transported = wire["occurrences"].as_array().unwrap();
        assert!(
            transported
                .iter()
                .filter(|item| { item["tag_info"]["id"] == serde_json::to_value(&schema).unwrap() })
                .count()
                >= 2
        );
    }

    #[cfg(feature = "integration")]
    fn read_integration_occurrences(path: &Path) -> Vec<CanonicalRuntimeOccurrence> {
        let paths = [path.to_path_buf()];
        let display = metadata_reader::run_exiftool_pass(&paths, false).unwrap();
        let raw = metadata_reader::run_exiftool_pass(&paths, true).unwrap();
        let key = path.to_string_lossy().replace('\\', "/");
        canonical_occurrences_from_exiftool_pair(
            raw.values_by_source
                .get(&key)
                .expect("raw pass contains disposable file"),
            display
                .values_by_source
                .get(&key)
                .expect("display pass contains disposable file"),
            Some(crate::tag_schema::get_registry().unwrap()),
            &key,
            None,
        )
        .unwrap()
    }

    #[cfg(feature = "integration")]
    fn rational_integer_value(occurrence: &CanonicalRuntimeOccurrence) -> i64 {
        match occurrence.occurrence.value {
            MetadataValue::Rational(ref value) if value.denominator == 1 => value.numerator,
            ref other => panic!("expected whole-number rational, got {other:?}"),
        }
    }

    #[cfg(feature = "integration")]
    fn integration_resolution_occurrences(
        items: &[CanonicalRuntimeOccurrence],
    ) -> Vec<&CanonicalRuntimeOccurrence> {
        items
            .iter()
            .filter(|item| {
                item.runtime_tag_name == "XResolution"
                    && matches!(item.runtime_group1.as_str(), "IFD0" | "IFD1")
            })
            .collect()
    }

    #[cfg(feature = "integration")]
    #[test]
    fn production_copy_coordinates_allow_unique_group_writes_and_preserve_identity() {
        let temp = tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test_images")
            .join("real_with_exif.jpg");
        let copy = temp.path().join("ifd-resolution-targets.jpg");
        fs::copy(source, &copy).unwrap();

        let mut initialise = crate::exiftool_config::exiftool_command();
        let initial_output = initialise
            .args([
                "-overwrite_original",
                "-IFD0:XResolution=300",
                "-IFD1:XResolution=72",
            ])
            .arg(&copy)
            .output()
            .expect("initialise disposable IFD resolutions");
        assert!(
            initial_output.status.success(),
            "ExifTool setup failed: {}",
            String::from_utf8_lossy(&initial_output.stderr)
        );

        let initial = read_integration_occurrences(&copy);
        let initial_resolutions = integration_resolution_occurrences(&initial);
        assert_eq!(initial_resolutions.len(), 2);
        let ifd0 = initial_resolutions
            .iter()
            .find(|item| item.runtime_group1 == "IFD0")
            .unwrap();
        let ifd1 = initial_resolutions
            .iter()
            .find(|item| item.runtime_group1 == "IFD1")
            .unwrap();
        assert_ne!(ifd0.occurrence.id, ifd1.occurrence.id);
        assert_eq!(ifd0.occurrence.tag_info, ifd1.occurrence.tag_info);
        let ifd0_id = ifd0.occurrence.id.clone();
        let ifd1_id = ifd1.occurrence.id.clone();
        let ifd0_target = ifd0.occurrence.write_target.clone().unwrap();
        let ifd1_target = ifd1.occurrence.write_target.clone().unwrap();
        assert_eq!(ifd0_target.selector(), "1IFD0:7ID-282:XResolution");
        assert!(ifd1.occurrence.id.copy > 0);
        assert_eq!(ifd1_target.selector(), "1IFD1:7ID-282:XResolution");
        assert_eq!(rational_integer_value(ifd0), 300);
        assert_eq!(rational_integer_value(ifd1), 72);

        let mut write_ifd0 = crate::exiftool_config::exiftool_command();
        let ifd0_output = write_ifd0
            .args([
                "-overwrite_original".to_owned(),
                format!("-{}=240", ifd0_target.selector()),
            ])
            .arg(&copy)
            .output()
            .expect("write derived IFD0 selector");
        assert!(
            ifd0_output.status.success(),
            "ExifTool IFD0 write failed: {}",
            String::from_utf8_lossy(&ifd0_output.stderr)
        );
        let after_ifd0 = read_integration_occurrences(&copy);
        let after_ifd0_resolutions = integration_resolution_occurrences(&after_ifd0);
        assert_eq!(
            rational_integer_value(
                after_ifd0_resolutions
                    .iter()
                    .find(|item| item.runtime_group1 == "IFD0")
                    .unwrap()
            ),
            240
        );
        assert_eq!(
            rational_integer_value(
                after_ifd0_resolutions
                    .iter()
                    .find(|item| item.runtime_group1 == "IFD1")
                    .unwrap()
            ),
            72
        );

        let mut write_ifd1 = crate::exiftool_config::exiftool_command();
        let ifd1_output = write_ifd1
            .args([
                "-overwrite_original".to_owned(),
                format!("-{}=96", ifd1_target.selector()),
            ])
            .arg(&copy)
            .output()
            .expect("write derived IFD1 selector");
        assert!(
            ifd1_output.status.success(),
            "ExifTool IFD1 write failed: {}",
            String::from_utf8_lossy(&ifd1_output.stderr)
        );
        let after_ifd1 = read_integration_occurrences(&copy);
        let after_ifd1_resolutions = integration_resolution_occurrences(&after_ifd1);
        let after_ifd1_ifd0 = after_ifd1_resolutions
            .iter()
            .find(|item| item.runtime_group1 == "IFD0")
            .unwrap();
        let after_ifd1_ifd1 = after_ifd1_resolutions
            .iter()
            .find(|item| item.runtime_group1 == "IFD1")
            .unwrap();
        assert_ne!(after_ifd1_ifd0.occurrence.id, after_ifd1_ifd1.occurrence.id);
        assert_eq!(after_ifd1_ifd0.occurrence.id, ifd0_id);
        assert_eq!(after_ifd1_ifd1.occurrence.id, ifd1_id);
        assert_eq!(rational_integer_value(after_ifd1_ifd0), 240);
        assert_eq!(rational_integer_value(after_ifd1_ifd1), 96);
    }

    #[test]
    fn empty_folder_returns_no_files() {
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
        let names = [
            "a.jpg", "b.jpeg", "c.png", "d.gif", "e.bmp", "f.webp", "g.tiff", "h.tif",
        ];
        for name in &names {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
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
        let files = collect(dir.path());
        assert_eq!(files.len(), 2);
        for p in &files {
            assert!(!p.relative_path.starts_with('/'));
        }
    }

    #[test]
    fn callback_is_called_for_each_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        fs::write(dir.path().join("b.jpg"), b"x").unwrap();
        fs::write(dir.path().join("c.jpg"), b"x").unwrap();
        let mut count = 0;
        scan_folder(
            dir.path(),
            Arc::new(AtomicBool::new(false)),
            |_| count += 1,
            |_| {},
        );
        assert_eq!(count, 3);
    }

    #[test]
    fn filename_field_is_populated() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("file.jpg"), b"x").unwrap();
        assert_eq!(collect(dir.path())[0].filename, "file.jpg");
    }

    #[test]
    fn os_metadata_is_populated_for_real_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        assert!(collect(dir.path())[0].date_modified.is_some());
    }

    #[test]
    fn metadata_returns_empty_on_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.jpg");
        let results = read_file_metadata_batch(&["missing.jpg".to_string()], &[path]);
        // Should return an error for missing file
        let err = results.expect_err("missing file should fail metadata batch");
        assert!(
            err.contains("ExifTool display pass failed"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn non_image_placeholders_are_distinct_valid_jpegs() {
        assert!(placeholder_thumbnail(MediaKind::Image).is_none());

        let audio = placeholder_thumbnail(MediaKind::Audio).unwrap();
        let video = placeholder_thumbnail(MediaKind::Video).unwrap();
        assert_ne!(audio, video);

        for placeholder in [audio, video] {
            let bytes =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, placeholder)
                    .unwrap();
            let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
                .expect("placeholder should decode as JPEG");
            assert_eq!(image.width(), 64);
            assert_eq!(image.height(), 64);
        }
    }

    #[test]
    fn thumbnail_for_media_dispatches_images_and_placeholders() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("pixel.png");
        image::RgbImage::new(1, 1).save(&image_path).unwrap();

        let image_thumbnail =
            thumbnail_for_media(&image_path).expect("image should produce a thumbnail");
        assert_eq!(image_thumbnail, thumbnail_for(&image_path).unwrap());

        let audio_thumbnail = thumbnail_for_media(&dir.path().join("track.MP3"))
            .expect("audio should produce a placeholder");
        let video_thumbnail = thumbnail_for_media(&dir.path().join("clip.MP4"))
            .expect("video should produce a placeholder");
        assert_eq!(
            audio_thumbnail,
            placeholder_thumbnail(MediaKind::Audio).unwrap()
        );
        assert_eq!(
            video_thumbnail,
            placeholder_thumbnail(MediaKind::Video).unwrap()
        );
        assert!(thumbnail_for_media(&dir.path().join("notes.txt")).is_none());
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

    fn decode_thumbnail(encoded: &str) -> image::DynamicImage {
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap();
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap()
    }

    #[test]
    fn full_decode_thumbnail_applies_primary_exif_orientation() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test_images/orientation_rotate90.jpg");
        let encoded = thumbnail_for(&path).expect("fixture should produce a thumbnail");
        let thumbnail = decode_thumbnail(&encoded);

        assert_eq!(
            (thumbnail.width(), thumbnail.height()),
            (109, 160),
            "the 100x68 stored pixels have EXIF orientation 6 before thumbnail sizing"
        );
    }

    fn solid_jpeg(width: u32, height: u32, color: image::Rgb<u8>) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, color);
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        bytes
    }

    fn jpeg_with_oriented_embedded_thumbnail() -> Vec<u8> {
        let primary = solid_jpeg(320, 200, image::Rgb([10, 20, 30]));
        let thumbnail = solid_jpeg(200, 120, image::Rgb([40, 50, 60]));

        // Little-endian TIFF with Orientation=1 in IFD0 and, in IFD1,
        // Orientation=6 plus an embedded JPEG at TIFF-relative offset 68.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42_u16.to_le_bytes());
        tiff.extend_from_slice(&8_u32.to_le_bytes());

        tiff.extend_from_slice(&1_u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112_u16.to_le_bytes());
        tiff.extend_from_slice(&3_u16.to_le_bytes());
        tiff.extend_from_slice(&1_u32.to_le_bytes());
        tiff.extend_from_slice(&1_u16.to_le_bytes());
        tiff.extend_from_slice(&0_u16.to_le_bytes());
        tiff.extend_from_slice(&26_u32.to_le_bytes());

        tiff.extend_from_slice(&3_u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112_u16.to_le_bytes());
        tiff.extend_from_slice(&3_u16.to_le_bytes());
        tiff.extend_from_slice(&1_u32.to_le_bytes());
        tiff.extend_from_slice(&6_u16.to_le_bytes());
        tiff.extend_from_slice(&0_u16.to_le_bytes());
        tiff.extend_from_slice(&0x0201_u16.to_le_bytes());
        tiff.extend_from_slice(&4_u16.to_le_bytes());
        tiff.extend_from_slice(&1_u32.to_le_bytes());
        tiff.extend_from_slice(&68_u32.to_le_bytes());
        tiff.extend_from_slice(&0x0202_u16.to_le_bytes());
        tiff.extend_from_slice(&4_u16.to_le_bytes());
        tiff.extend_from_slice(&1_u32.to_le_bytes());
        tiff.extend_from_slice(&(thumbnail.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&0_u32.to_le_bytes());
        assert_eq!(tiff.len(), 68);
        tiff.extend_from_slice(&thumbnail);

        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);
        let app1_length = u16::try_from(app1.len() + 2).unwrap();

        let mut jpeg = Vec::new();
        jpeg.extend_from_slice(&primary[..2]);
        jpeg.extend_from_slice(&[0xff, 0xe1]);
        jpeg.extend_from_slice(&app1_length.to_be_bytes());
        jpeg.extend_from_slice(&app1);
        jpeg.extend_from_slice(&primary[2..]);
        jpeg
    }

    #[test]
    fn embedded_thumbnail_applies_ifd1_exif_orientation() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("embedded-orientation.jpg");
        fs::write(&path, jpeg_with_oriented_embedded_thumbnail()).unwrap();

        let encoded = thumbnail_for(&path).expect("embedded thumbnail should be extracted");
        let thumbnail = decode_thumbnail(&encoded);

        assert_eq!(
            (thumbnail.width(), thumbnail.height()),
            (120, 200),
            "the embedded thumbnail's IFD1 orientation should be applied"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn scan_preserves_literal_backslash_in_filename() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("album\\edited.jpg"), b"not-an-image").unwrap();
        let files = collect(dir.path());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, "album\\edited.jpg");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn exiftool_source_matching_preserves_literal_backslash() {
        let abs = std::path::PathBuf::from("/tmp/album\\edited.jpg");
        assert_eq!(path_identity(&abs), "/tmp/album\\edited.jpg");
    }

    #[test]
    fn walk_errors_are_reported_via_on_error_callback() {
        // Walking a path that doesn't exist produces one WalkDir error.
        // Previously these were silently dropped — the user would never know
        // a folder was unreadable.
        let mut errors = Vec::new();
        scan_folder(
            Path::new("D:/this-path-definitely-does-not-exist-_xyz_999"),
            Arc::new(AtomicBool::new(false)),
            |_| {},
            |e| errors.push(e),
        );
        assert!(
            !errors.is_empty(),
            "expected at least one WalkErrorInfo for a missing root"
        );
        assert!(!errors[0].message.is_empty());
    }

    #[test]
    fn happy_path_walk_does_not_invoke_on_error() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        let mut errors = 0;
        scan_folder(
            dir.path(),
            Arc::new(AtomicBool::new(false)),
            |_| {},
            |_| errors += 1,
        );
        assert_eq!(errors, 0);
    }

    #[test]
    fn parse_exiftool_preserves_nested_objects() {
        let json = r#"[
            {"SourceFile": "D:/a.jpg", "Fixture:Main:Copy0:Fixture-Metadata:ID-Tag:Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}},
            {"SourceFile": "D:/b.mov", "Fixture:Main:Copy0:Fixture-Metadata:ID-Keys:Keys": {"table":"TestFixture::Unknown","id":"Keys","val":{"creator":"alice","year":2024}}},
            {"SourceFile": "D:/c.jpg", "Fixture:Main:Copy0:Fixture-Metadata:ID-Tag:Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}}
        ]"#;
        let rel = vec![
            "a.jpg".to_string(),
            "b.mov".to_string(),
            "c.jpg".to_string(),
        ];
        let abs = vec![
            std::path::PathBuf::from("D:/a.jpg"),
            std::path::PathBuf::from("D:/b.mov"),
            std::path::PathBuf::from("D:/c.jpg"),
        ];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        assert_eq!(results.len(), 3);
        let b = results.iter().find(|r| r.relative_path == "b.mov").unwrap();
        let keys_id = SchemaDefinitionId {
            table: "TestFixture::Unknown".into(),
            tag_id: "Keys".into(),
            index: None,
        };
        let keys = b.occurrences.for_schema(&keys_id).next().unwrap();
        match &keys.value {
            MetadataValue::Unknown { raw, .. } => {
                assert_eq!(raw, &serde_json::json!({"creator": "alice", "year": 2024}));
            }
            other => panic!("expected unknown raw object for Keys, got {:?}", other),
        }
    }

    #[test]
    fn parse_exiftool_skips_non_object_entries_keeps_others() {
        // An entry that isn't a JSON object can't deserialize to a HashMap.
        // Per-entry isolation means the others must still come through.
        let json = r#"[
            {"SourceFile": "D:/a.jpg", "Fixture:Main:Copy0:Fixture-Metadata:ID-Tag:Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}},
            [1, 2, 3],
            {"SourceFile": "D:/c.jpg", "Fixture:Main:Copy0:Fixture-Metadata:ID-Tag:Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"ok"}}
        ]"#;
        let rel = vec!["a.jpg".to_string(), "c.jpg".to_string()];
        let abs = vec![
            std::path::PathBuf::from("D:/a.jpg"),
            std::path::PathBuf::from("D:/c.jpg"),
        ];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        assert_eq!(results.len(), 2);
        let a = results.iter().find(|r| r.relative_path == "a.jpg").unwrap();
        let c = results.iter().find(|r| r.relative_path == "c.jpg").unwrap();
        let tag_id = SchemaDefinitionId {
            table: "TestFixture::Unknown".into(),
            tag_id: "Tag".into(),
            index: None,
        };
        assert!(matches!(
            &a.occurrences.for_schema(&tag_id).next().unwrap().value,
            MetadataValue::Unknown { raw, .. } if raw == &serde_json::json!("ok")
        ));
        assert!(matches!(
            &c.occurrences.for_schema(&tag_id).next().unwrap().value,
            MetadataValue::Unknown { raw, .. } if raw == &serde_json::json!("ok")
        ));
    }

    #[test]
    fn parse_pass_json_keys_results_by_normalized_source() {
        let json = r#"[
            {"SourceFile": "D:\\a.jpg", "Fixture:Main:Copy0:Fixture-Metadata:ID-Tag:Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"X"}},
            {"SourceFile": "D:/b.jpg", "Fixture:Main:Copy0:Fixture-Metadata:ID-Tag:Tag": {"table":"TestFixture::Unknown","id":"Tag","val":"Y"}}
        ]"#;
        let map = parse_exiftool_pass_json_raw(json);
        assert_eq!(map.len(), 2);
        let first_key = if cfg!(target_os = "windows") {
            "D:/a.jpg"
        } else {
            r"D:\a.jpg"
        };
        assert_eq!(
            map.get(first_key).and_then(|m| m.get("Fixture:Tag")),
            Some(&serde_json::json!("X"))
        );
        assert_eq!(
            map.get("D:/b.jpg").and_then(|m| m.get("Fixture:Tag")),
            Some(&serde_json::json!("Y"))
        );
    }

    #[test]
    fn value_projection_does_not_upgrade_incomplete_friendly_keys() {
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IFD0:XResolution": {"table":"Exif::Main","id":"282","val":300}
        }]"#;

        assert!(parse_exiftool_pass_json_raw(json).is_empty());
        let parsed = try_parse_exiftool_pass_json_raw(json).unwrap();
        assert!(parsed.values_by_source.is_empty());
        assert!(parsed.failures_by_source.contains_key("D:/a.jpg"));
    }

    #[test]
    fn parse_pass_json_handles_struct_values() {
        // Pass A typically returns nested Keys / regions structs.
        let json = r#"[{"SourceFile":"D:/a.mov","Fixture:Main:Copy0:Fixture-Metadata:ID-Keys:Keys":{"table":"TestFixture::Unknown","id":"Keys","val":{"creator":"alice"}}}]"#;
        let map = parse_exiftool_pass_json_raw(json);
        assert_eq!(
            map.get("D:/a.mov").and_then(|m| m.get("Fixture:Keys")),
            Some(&serde_json::json!({"creator": "alice"}))
        );
    }

    #[test]
    fn parse_pass_json_raw_keeps_exiftool_boundary_as_json() {
        let json = r#"[{"SourceFile":"D:/a.jpg","Fixture:Main:Copy0:Fixture-Metadata:ID-Int:Int":{"table":"TestFixture::Unknown","id":"Int","val":5},"Fixture:Main:Copy0:Fixture-Metadata:ID-Real:Real":{"table":"TestFixture::Unknown","id":"Real","val":1.5},"Fixture:Main:Copy0:Fixture-Metadata:ID-Obj:Obj":{"table":"TestFixture::Unknown","id":"Obj","val":{"x":true}}}]"#;
        let map = parse_exiftool_pass_json_raw(json);
        let entry = map.get("D:/a.jpg").expect("entry");
        assert_eq!(entry.get("Fixture:Int"), Some(&serde_json::json!(5)));
        assert_eq!(entry.get("Fixture:Real"), Some(&serde_json::json!(1.5)));
        assert_eq!(
            entry.get("Fixture:Obj"),
            Some(&serde_json::json!({"x": true}))
        );
    }

    #[test]
    fn parse_batch_populates_semantic_occurrences() {
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IPTC:Main:Copy0:JPEG-APP13-Photoshop-IPTC:ID-60:TimeCreated": {"table": "IPTC::ApplicationRecord", "id": "60", "val": "10:56:05"},
            "ExifIFD:Main:Copy0:JPEG-APP1-IFD0-ExifIFD:ID-36881:OffsetTimeOriginal": {"table": "Exif::Main", "id": "36881", "val": "+01:00"},
            "MadeUp:Main:Copy0:Fixture-Metadata:ID-MadeUpThing:Thing": {"table": "TestFixture::Unknown", "id": "MadeUp:Thing", "val": 5}
        }]"#;
        let rel = vec!["a.jpg".to_string()];
        let abs = vec![std::path::PathBuf::from("D:/a.jpg")];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        let image = &results[0];
        assert_eq!(image.occurrences.len(), 3);
        assert!(matches!(
            &image
                .occurrences
                .for_schema(&crate::known_ids::iptc_time_created())
                .next()
                .unwrap()
                .value,
            MetadataValue::Time(t) if t.offset.is_none()
        ));
        assert!(matches!(
            &image
                .occurrences
                .for_schema(&crate::known_ids::offset_time_original())
                .next()
                .unwrap()
                .value,
            MetadataValue::TimeOffset(_)
        ));
        let unknown_schema = SchemaDefinitionId {
            table: "TestFixture::Unknown".into(),
            tag_id: "MadeUp:Thing".into(),
            index: None,
        };
        assert!(matches!(
            &image
                .occurrences
                .for_schema(&unknown_schema)
                .next()
                .unwrap()
                .value,
            MetadataValue::Unknown { expected: None, raw, .. }
                if raw == &serde_json::json!(5)
        ));
    }

    #[test]
    fn json_preview_is_bounded() {
        let value = serde_json::json!("x".repeat(400));
        let preview = json_preview(&value);
        assert!(
            preview.chars().count() <= 240,
            "preview should be capped, got {} chars",
            preview.chars().count()
        );
        assert!(preview.ends_with("..."));
    }

    #[test]
    fn json_helpers_summarise_raw_values_safely() {
        assert_eq!(json_value_kind(&serde_json::json!(null)), "null");
        assert_eq!(json_value_kind(&serde_json::json!(true)), "bool");
        assert_eq!(json_value_kind(&serde_json::json!(7)), "integer");
        assert_eq!(json_value_kind(&serde_json::json!(1.25)), "number");
        assert_eq!(json_value_kind(&serde_json::json!("line\nbreak")), "string");
        assert_eq!(json_value_kind(&serde_json::json!([1, 2])), "array");
        assert_eq!(json_value_kind(&serde_json::json!({"a": 1})), "object");
        assert_eq!(
            json_preview(&serde_json::json!("line\nbreak")),
            r#""line\nbreak""#
        );
        assert_eq!(
            tag_kind_summary(&crate::tag_schema::TagKind::Bag(Box::new(
                crate::tag_schema::TagKind::Text
            ))),
            "Bag<Text>"
        );
    }

    fn binary_registry() -> crate::tag_schema::TagRegistry {
        // `from_listx_xml` applies the hand-curated override table at the end,
        // which inserts `IFD1:ThumbnailImage` as `TagKind::Binary` even when
        // listx itself didn't enumerate it. Empty taginfo is enough.
        crate::tag_schema::TagRegistry::from_listx_xml(
            "<?xml version='1.0' encoding='UTF-8'?><taginfo></taginfo>",
        )
        .expect("build empty registry")
    }

    fn canonical_registry() -> crate::tag_schema::TagRegistry {
        crate::tag_schema::TagRegistry::from_listx_xml(
            r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Main' g0='EXIF' g1='EXIF' g2='Image'>
 <tag id='282' name='XResolution' type='int32u' writable='true'>
  <desc lang='en'>X Resolution</desc>
 </tag>
 <tag id='Make' name='Make' type='string' writable='true'>
  <desc lang='en'>Make</desc>
 </tag>
 <tag id='Model' name='Model' type='string' writable='true'>
  <desc lang='en'>Model</desc>
 </tag>
 <tag id='LensModel' name='LensModel' type='string' writable='true'>
  <desc lang='en'>Lens Model</desc>
 </tag>
 <tag id='ISO' name='ISO' type='int32u' writable='true'>
  <desc lang='en'>ISO</desc>
 </tag>
 <tag id='ExposureTime' name='ExposureTime' type='rational64u' writable='true'>
  <desc lang='en'>Exposure Time</desc>
 </tag>
</table>
<table name='EXIF::GPS' g0='EXIF' g1='GPS' g2='Location'>
 <tag id='0' name='GPSVersionID' type='int8u' count='4' writable='true'><desc lang='en'>GPS Version</desc></tag>
</table>
</taginfo>"#,
        )
        .expect("build canonical test registry")
    }

    #[allow(clippy::too_many_arguments)]
    fn explicit_runtime_property(
        document: Option<&str>,
        path: &str,
        copy: u32,
        runtime_tag_id: &str,
        wrapped_table: &str,
        wrapped_tag_id: &str,
        wrapped_index: Option<u32>,
        group1: &str,
        tag_name: &str,
        value: serde_json::Value,
    ) -> RuntimeProperty {
        let occurrence_id = MetadataOccurrenceId {
            document: document.map(str::to_owned),
            path: path.to_owned(),
            runtime_tag_id: runtime_tag_id.to_owned(),
            tag_id_scope: RuntimeTagIdScope {
                table: wrapped_table.to_owned(),
                tag_id: wrapped_tag_id.to_owned(),
                index: wrapped_index,
            },
            copy,
        };
        let raw_value =
            serde_json::value::to_raw_value(&value).expect("test value serializes as JSON");
        RuntimeProperty {
            occurrence_id,
            group1: group1.to_owned(),
            tag_name: tag_name.to_owned(),
            friendly_name: format!("{group1}:{tag_name}"),
            language: None,
            value,
            raw_value,
        }
    }

    fn lang_alt_registry() -> crate::tag_schema::TagRegistry {
        crate::tag_schema::TagRegistry::from_listx_xml(
            r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='XMP::dc' g0='XMP' g1='XMP-dc' g2='Other'>
 <tag id='description' name='Description' type='lang-alt' writable='true'>
  <desc lang='en'>Description</desc>
 </tag>
</table>
</taginfo>"#,
        )
        .expect("build LangAlt test registry")
    }

    #[test]
    fn lang_alt_fragments_merge_into_one_writable_parent_occurrence() {
        let registry = lang_alt_registry();
        let parent_id = test_schema_id("XMP::dc", "description", None);
        let parent_info = registry.lookup(&parent_id).unwrap();
        let child = |language: &str, text: &str| {
            test_runtime_property(
                test_occurrence_id("JPEG-APP1-XMP", &format!("description-{language}")),
                test_schema_id("XMP::dc", &format!("description-{language}"), None),
                "XMP-dc",
                &format!("Description-{language}"),
                Some(language),
                serde_json::json!(text),
            )
        };
        let parent = test_runtime_property(
            test_occurrence_id("JPEG-APP1-XMP", "description"),
            parent_id.clone(),
            "XMP-dc",
            "Description",
            None,
            serde_json::json!("Default"),
        );
        let properties = runtime_map(vec![parent, child("en", "Hello"), child("fr", "Bonjour")]);
        let canonical = canonical_occurrences_from_exiftool_pair(
            &properties,
            &properties,
            Some(&registry),
            "lang-alt.jpg",
            None,
        )
        .unwrap();

        assert_eq!(canonical.len(), 1);
        let item = &canonical[0];
        assert_eq!(item.occurrence.schema_id, parent_id);
        assert_eq!(item.occurrence.id.runtime_tag_id, "description");
        assert_eq!(
            item.occurrence.id.tag_id_scope.as_schema_definition_id(),
            item.occurrence.schema_id
        );
        assert_eq!(item.occurrence.tag_info.as_ref(), Some(parent_info));
        assert_eq!(
            item.occurrence.value,
            MetadataValue::LangAlt(BTreeMap::from([
                ("en".into(), "Hello".into()),
                ("fr".into(), "Bonjour".into()),
                ("x-default".into(), "Default".into()),
            ]))
        );
        assert_eq!(
            item.occurrence.write_target.as_ref().unwrap().selector(),
            "1XMP-dc:7ID-description:Description"
        );
    }

    #[test]
    fn child_only_lang_alt_does_not_consolidate_across_runtime_scope() {
        let registry = lang_alt_registry();
        let child = |path: &str, language: &str, text: &str| {
            test_runtime_property(
                test_occurrence_id(path, &format!("description-{language}")),
                test_schema_id("XMP::dc", &format!("description-{language}"), None),
                "XMP-dc",
                &format!("Description-{language}"),
                Some(language),
                serde_json::json!(text),
            )
        };
        let properties = runtime_map(vec![
            child("XMP-A", "en", "First"),
            child("XMP-A", "fr", "Premier"),
            child("XMP-B", "en", "Second"),
        ]);

        let canonical = canonical_occurrences_from_exiftool_pair(
            &properties,
            &properties,
            Some(&registry),
            "lang-alt.jpg",
            None,
        )
        .unwrap();

        assert_eq!(canonical.len(), 2);
        assert_eq!(canonical[0].occurrence.id.runtime_tag_id, "description");
        assert_eq!(canonical[1].occurrence.id.runtime_tag_id, "description");
        assert!(matches!(
            &canonical[0].occurrence.value,
            MetadataValue::LangAlt(values)
                if values == &BTreeMap::from([
                    ("en".into(), "First".into()),
                    ("fr".into(), "Premier".into()),
                ])
        ));
        assert!(matches!(
            &canonical[1].occurrence.value,
            MetadataValue::LangAlt(values)
                if values == &BTreeMap::from([("en".into(), "Second".into())])
        ));
        assert!(canonical
            .iter()
            .all(|item| item.occurrence.write_target.is_none()));
    }

    #[test]
    fn unique_child_only_lang_alt_receives_the_parent_write_target() {
        let registry = lang_alt_registry();
        let child = |language: &str, text: &str| {
            test_runtime_property(
                test_occurrence_id("JPEG-APP1-XMP", &format!("description-{language}")),
                test_schema_id("XMP::dc", &format!("description-{language}"), None),
                "XMP-dc",
                &format!("Description-{language}"),
                Some(language),
                serde_json::json!(text),
            )
        };
        let properties = runtime_map(vec![child("en", "Hello"), child("fr", "Bonjour")]);

        let canonical = canonical_occurrences_from_exiftool_pair(
            &properties,
            &properties,
            Some(&registry),
            "lang-alt.jpg",
            None,
        )
        .unwrap();

        assert_eq!(canonical.len(), 1);
        assert_eq!(canonical[0].occurrence.id.runtime_tag_id, "description");
        assert_eq!(
            canonical[0]
                .occurrence
                .write_target
                .as_ref()
                .unwrap()
                .selector(),
            "1XMP-dc:7ID-description:Description"
        );
    }

    #[test]
    fn conflicting_lang_alt_fragments_become_one_read_only_unknown() {
        let registry = lang_alt_registry();
        let parent = test_runtime_property(
            test_occurrence_id("JPEG-APP1-XMP", "description"),
            test_schema_id("XMP::dc", "description", None),
            "XMP-dc",
            "Description",
            None,
            serde_json::json!({"en": "Hello"}),
        );
        let child = test_runtime_property(
            test_occurrence_id("JPEG-APP1-XMP", "description-en"),
            test_schema_id("XMP::dc", "description-en", None),
            "XMP-dc",
            "Description-en",
            Some("en"),
            serde_json::json!("Different"),
        );
        let properties = runtime_map(vec![parent, child]);

        let canonical = canonical_occurrences_from_exiftool_pair(
            &properties,
            &properties,
            Some(&registry),
            "lang-alt.jpg",
            None,
        )
        .unwrap();

        assert_eq!(canonical.len(), 1);
        assert!(matches!(
            &canonical[0].occurrence.value,
            MetadataValue::Unknown { expected: Some(TagKind::LangAlt), reason: Some(reason), .. }
                if reason.contains("en")
        ));
        assert!(canonical[0].occurrence.write_target.is_none());
    }

    #[test]
    fn canonical_prefers_raw_primary_and_uses_display_only_as_hint() {
        let reg = canonical_registry();
        let property = |runtime_tag_id: &str, tag_name: &str, value| {
            explicit_runtime_property(
                Some("Main"),
                "JPEG-APP1-IFD0",
                0,
                runtime_tag_id,
                "EXIF::Main",
                runtime_tag_id,
                None,
                "EXIF",
                tag_name,
                value,
            )
        };
        let raw = runtime_map(vec![
            property("Make", "Make", serde_json::json!("Canon raw")),
            property("ExposureTime", "ExposureTime", serde_json::json!(0.015625)),
        ]);
        let display = runtime_map(vec![
            property("Make", "Make", serde_json::json!("Canon display")),
            property("ExposureTime", "ExposureTime", serde_json::json!("1/64")),
        ]);

        let values = canonical_values_from_explicit_runtime_pair(
            &raw,
            &display,
            Some(&reg),
            "file.jpg",
            None,
        );

        assert_eq!(
            values.get("EXIF:Make"),
            Some(&MetadataValue::Text("Canon raw".to_string()))
        );
        assert_eq!(
            values.get("EXIF:ExposureTime"),
            Some(&MetadataValue::Rational(
                crate::metadata_value::RationalValue {
                    numerator: 1,
                    denominator: 64,
                }
            ))
        );
    }

    #[test]
    fn canonical_recovers_exact_rational_from_display_hint() {
        let reg = canonical_registry();
        let property = |value| {
            explicit_runtime_property(
                Some("Main"),
                "JPEG-APP1-IFD0",
                0,
                "ExposureTime",
                "EXIF::Main",
                "ExposureTime",
                None,
                "EXIF",
                "ExposureTime",
                value,
            )
        };
        let raw = runtime_map(vec![property(serde_json::json!(0.015625))]);
        let display = runtime_map(vec![property(serde_json::json!("1/64"))]);

        let values = canonical_values_from_explicit_runtime_pair(
            &raw,
            &display,
            Some(&reg),
            "file.jpg",
            None,
        );

        match values.get("EXIF:ExposureTime") {
            Some(MetadataValue::Rational(r)) => {
                assert_eq!(r.numerator, 1);
                assert_eq!(r.denominator, 64);
            }
            other => panic!("expected rational 1/64, got {:?}", other),
        }
    }

    #[test]
    fn canonical_gps_version_id_is_text_without_warning() {
        let reg = canonical_registry();
        let property = |value| {
            explicit_runtime_property(
                Some("Main"),
                "JPEG-APP1-IFD0-GPS",
                0,
                "0",
                "EXIF::GPS",
                "0",
                None,
                "GPS",
                "GPSVersionID",
                value,
            )
        };
        let raw = runtime_map(vec![property(serde_json::json!("2 2 0 0"))]);
        let display = runtime_map(vec![property(serde_json::json!("2.2.0.0"))]);
        let mut warnings = Vec::new();

        let values = canonical_values_from_explicit_runtime_pair(
            &raw,
            &display,
            Some(&reg),
            "file.jpg",
            Some(&mut warnings),
        );

        assert_eq!(
            values.get("GPS:GPSVersionID"),
            Some(&MetadataValue::Text("2 2 0 0".to_string()))
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn canonical_includes_display_only_fallback_value() {
        let reg = canonical_registry();
        let raw = runtime_map(vec![]);
        let display = runtime_map(vec![explicit_runtime_property(
            Some("Main"),
            "JPEG-APP1-IFD0",
            0,
            "Model",
            "EXIF::Main",
            "Model",
            None,
            "EXIF",
            "Model",
            serde_json::json!("X100V"),
        )]);

        let values = canonical_values_from_explicit_runtime_pair(
            &raw,
            &display,
            Some(&reg),
            "file.jpg",
            None,
        );

        assert_eq!(
            values.get("EXIF:Model"),
            Some(&MetadataValue::Text("X100V".to_string()))
        );
    }

    #[test]
    fn canonical_includes_raw_only_value() {
        let reg = canonical_registry();
        let raw = runtime_map(vec![explicit_runtime_property(
            Some("Main"),
            "JPEG-APP1-IFD0",
            0,
            "ISO",
            "EXIF::Main",
            "ISO",
            None,
            "EXIF",
            "ISO",
            serde_json::json!(400),
        )]);
        let display = runtime_map(vec![]);

        let values = canonical_values_from_explicit_runtime_pair(
            &raw,
            &display,
            Some(&reg),
            "file.jpg",
            None,
        );

        assert_eq!(values.get("EXIF:ISO"), Some(&MetadataValue::Integer(400)));
    }

    #[test]
    fn canonical_iterates_union_of_raw_and_display_keys() {
        let reg = canonical_registry();
        let property = |runtime_tag_id: &str, tag_name: &str, value| {
            explicit_runtime_property(
                Some("Main"),
                "JPEG-APP1-IFD0",
                0,
                runtime_tag_id,
                "EXIF::Main",
                runtime_tag_id,
                None,
                "EXIF",
                tag_name,
                value,
            )
        };
        let raw = runtime_map(vec![
            property("Make", "Make", serde_json::json!("Raw make")),
            property("ISO", "ISO", serde_json::json!(200)),
        ]);
        let display = runtime_map(vec![
            property("Make", "Make", serde_json::json!("Display make")),
            property("LensModel", "LensModel", serde_json::json!("35mm f/2")),
        ]);

        let values = canonical_values_from_explicit_runtime_pair(
            &raw,
            &display,
            Some(&reg),
            "file.jpg",
            None,
        );

        assert_eq!(values.len(), 3);
        assert!(values.contains_key("EXIF:Make"));
        assert!(values.contains_key("EXIF:ISO"));
        assert!(values.contains_key("EXIF:LensModel"));
        assert_eq!(
            values.get("EXIF:Make"),
            Some(&MetadataValue::Text("Raw make".to_string()))
        );
    }

    #[test]
    fn binary_tag_values_are_replaced_with_placeholder() {
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-513:ThumbnailImage": {"table":"Exif::Main","id":"513","val":"(Binary data 3965 bytes, use -b option to extract)"},
            "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-271:Make": {"table":"Exif::Main","id":"271","val":"Canon"}
        }]"#;
        let reg = binary_registry();
        let map = parse_exiftool_pass_json_raw_with_registry(json, Some(&reg));
        let entry = map.get("D:/a.jpg").expect("entry present");
        assert_eq!(
            entry.get("IFD1:ThumbnailImage"),
            Some(&serde_json::json!("<binary>"))
        );
        // Non-binary tag passes through untouched.
        assert_eq!(entry.get("IFD0:Make"), Some(&serde_json::json!("Canon")));
    }

    #[test]
    fn regex_fallback_substitutes_when_schema_misses_tag() {
        // `File:` is exiftool's synthetic group for container-extracted
        // binaries (PreviewImage, JpgFromRaw, etc.). `-listx` does not
        // enumerate it, so the schema cannot classify these — the regex
        // fallback is the only thing that catches them.
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "File:Main:Copy0:File-Metadata:ID-PreviewImage:PreviewImage": {"table":"File::Main","id":"PreviewImage","val":"(Binary data 105557 bytes, use -b option to extract)"}
        }]"#;
        let reg = binary_registry();
        let map = parse_exiftool_pass_json_raw_with_registry(json, Some(&reg));
        let entry = map.get("D:/a.jpg").expect("entry present");
        assert_eq!(
            entry.get("File:PreviewImage"),
            Some(&serde_json::json!("<binary>"))
        );
    }

    #[test]
    fn regex_fallback_works_without_registry() {
        // No schema available: regex alone must still catch the placeholder.
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-513:ThumbnailImage": {"table":"Exif::Main","id":"513","val":"(Binary data 3965 bytes, use -b option to extract)"}
        }]"#;
        let map = parse_exiftool_pass_json_raw_with_registry(json, None);
        let entry = map.get("D:/a.jpg").expect("entry present");
        assert_eq!(
            entry.get("IFD1:ThumbnailImage"),
            Some(&serde_json::json!("<binary>"))
        );
    }

    #[test]
    fn regex_fallback_is_anchored_and_does_not_match_substrings() {
        // A free-text tag whose value mentions the placeholder phrase but is
        // not exactly the placeholder must round-trip unchanged. End-anchoring
        // protects descriptions and other prose fields.
        let json = r#"[{
            "SourceFile": "D:/a.jpg",
            "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-270:ImageDescription": {"table":"Exif::Main","id":"270","val":"Note: the exiftool stub reads \"(Binary data 99 bytes, use -b option to extract)\" in this field."}
        }]"#;
        let reg = binary_registry();
        let map = parse_exiftool_pass_json_raw_with_registry(json, Some(&reg));
        let entry = map.get("D:/a.jpg").expect("entry present");
        match entry.get("IFD0:ImageDescription") {
            Some(serde_json::Value::String(s)) => {
                assert!(s.starts_with("Note: the exiftool stub"));
                assert!(!s.contains("<binary>"));
            }
            other => panic!("expected unchanged String, got {:?}", other),
        }
    }

    #[test]
    fn parse_exiftool_malformed_outer_json_logs_and_returns_empty_occurrences() {
        let json = "not json at all";
        let rel = vec!["x.jpg".to_string()];
        let abs = vec![std::path::PathBuf::from("D:/x.jpg")];
        let results = parse_exiftool_batch_json(json, &rel, &abs);
        assert_eq!(results.len(), 1);
        assert!(results[0].occurrences.is_empty());
    }

    #[test]
    fn exif_thumbnail_too_small_is_rejected() {
        // The test image's embedded thumbnail is ~100×68 px, which is below the
        // 160 px threshold.  extract_exif_thumbnail should return None so we
        // fall through to the full-decode path.
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = workspace_root.join("test_images/real_with_exif.jpg");

        if !path.exists() {
            panic!("Test image not found at {:?}. Please ensure test_images/real_with_exif.jpg exists in the repository.", path);
        }

        let result = extract_exif_thumbnail(&path);
        assert!(
            result.is_none(),
            "Embedded thumbnail is < 160 px; should have been rejected"
        );

        // thumbnail_for should still succeed via the full-decode fallback
        let thumb = thumbnail_for(&path);
        assert!(
            thumb.is_some(),
            "Expected thumbnail_for to succeed via full decode"
        );
        assert!(!thumb.unwrap().is_empty());
    }

    #[test]
    fn exif_thumbnail_large_enough_is_used() {
        // large_with_exif.jpg has a 200×150 embedded thumbnail (≥ 160 px),
        // so extract_exif_thumbnail should return it directly.
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = workspace_root.join("test_images/large_with_exif.jpg");

        if !path.exists() {
            panic!("Test image not found at {:?}. Please ensure test_images/large_with_exif.jpg exists in the repository.", path);
        }

        let result = extract_exif_thumbnail(&path);
        assert!(
            result.is_some(),
            "Expected embedded thumbnail (200×150) to be accepted (≥ 160 px)"
        );
        assert!(!result.unwrap().is_empty());
    }

    #[test]
    fn test_warning_classification() {
        assert_eq!(
            classify_warning("no schema entry for tag"),
            ParseWarningCategory::MissingSchema
        );
        assert_eq!(
            classify_warning("schema kind is unknown"),
            ParseWarningCategory::UnknownSchemaKind
        );
        assert_eq!(
            classify_warning("expected integer for integer tag, got string"),
            ParseWarningCategory::ParseFailed
        );
        assert_eq!(
            classify_warning("expected JSON integer for integer tag"),
            ParseWarningCategory::ParseFailed
        );
    }

    #[test]
    fn test_warning_grouping_exact() {
        let warnings = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "c.jpg".to_string(),
                tag: "EXIF:OtherTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "<no schema>".to_string(),
                raw_type: "string",
                raw: serde_json::json!("raw"),
                reason: "no schema entry for tag".to_string(),
            },
        ];

        let groups = group_parse_warnings(&warnings);
        assert_eq!(groups.len(), 2);

        // Group 1: EXIF:SomeTag
        let key1 = WarningGroupKey {
            tag: "EXIF:SomeTag".to_string(),
            reason: "expected integer for integer tag, got string".to_string(),
            expected_summary: "Integer".to_string(),
            raw_type: "string",
        };
        let val1 = groups.get(&key1).expect("SomeTag group present");
        assert_eq!(val1.count, 2);
        assert_eq!(
            val1.examples,
            vec!["a.jpg".to_string(), "b.jpg".to_string()]
        );
        assert_eq!(val1.raw_preview, Some("\"Auto\"".to_string()));

        // Group 2: EXIF:OtherTag
        let key2 = WarningGroupKey {
            tag: "EXIF:OtherTag".to_string(),
            reason: "no schema entry for tag".to_string(),
            expected_summary: "<no schema>".to_string(),
            raw_type: "string",
        };
        let val2 = groups.get(&key2).expect("OtherTag group present");
        assert_eq!(val2.count, 1);
        assert_eq!(
            classify_warning(&key2.reason),
            ParseWarningCategory::MissingSchema
        );

        // Call log_aggregated_warnings to make sure it doesn't panic
        log_aggregated_warnings(&warnings);
    }

    #[test]
    fn test_warning_grouping_example_limit() {
        let warnings = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "a.jpg".to_string(), // Duplicate path, same group
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
            ParseWarning {
                rel_path: "c.jpg".to_string(), // Third path, should exceed limit
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "expected integer for integer tag, got string".to_string(),
            },
        ];

        let groups = group_parse_warnings(&warnings);
        let val = groups.values().next().expect("Exactly one group");
        assert_eq!(val.count, 4);
        // Duplicate is not repeated, and limit is 2
        assert_eq!(val.examples, vec!["a.jpg".to_string(), "b.jpg".to_string()]);
    }

    #[test]
    fn test_warning_grouping_separation() {
        // Different reason
        let warnings_diff_reason = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason B".to_string(),
            },
        ];
        let groups_diff_reason = group_parse_warnings(&warnings_diff_reason);
        assert_eq!(groups_diff_reason.len(), 2);

        // Different raw type
        let warnings_diff_raw_type = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:SomeTag".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "number",
                raw: serde_json::json!(123),
                reason: "reason A".to_string(),
            },
        ];
        let groups_diff_raw_type = group_parse_warnings(&warnings_diff_raw_type);
        assert_eq!(groups_diff_raw_type.len(), 2);

        // Different tag
        let warnings_diff_tag = vec![
            ParseWarning {
                rel_path: "a.jpg".to_string(),
                tag: "EXIF:TagA".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
            ParseWarning {
                rel_path: "b.jpg".to_string(),
                tag: "EXIF:TagB".to_string(),
                pass_name: "canonical".to_string(),
                expected: "Integer".to_string(),
                raw_type: "string",
                raw: serde_json::json!("Auto"),
                reason: "reason A".to_string(),
            },
        ];
        let groups_diff_tag = group_parse_warnings(&warnings_diff_tag);
        assert_eq!(groups_diff_tag.len(), 2);
    }

    #[test]
    fn test_parser_per_source_isolation() {
        let registry = crate::tag_schema::get_registry().ok();

        // 1. A three-source JSON array where:
        // - first source is valid
        // - second has two occurrence IDs which share one schema identity
        // - third is valid
        // All three sources parse; the schema-keyed display projection owns any later collision.
        let json = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            },
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                },
                "IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "72"
                }
            },
            {
                "SourceFile": "D:/path/Image3.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "150"
                }
            }
        ]"#;

        let res = try_parse_exiftool_pass_json_raw_with_registry(json, registry).unwrap();

        assert_eq!(res.values_by_source.len(), 3);
        assert!(res.values_by_source.contains_key("D:/path/Image1.jpg"));
        assert_eq!(res.values_by_source["D:/path/Image2.jpg"].len(), 2);
        assert!(res.values_by_source.contains_key("D:/path/Image3.jpg"));
        assert!(res.failures_by_source.is_empty());

        let ifd0 = parse_runtime_property_key("IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution")
            .unwrap();
        let ifd1 = parse_runtime_property_key("IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution")
            .unwrap();
        assert_ne!(ifd0.path, ifd1.path);

        // 5. A malformed wrapped property in one source is isolated similarly
        let json_malformed_val = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            },
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": "not-an-object"
            }
        ]"#;
        let res_malformed =
            try_parse_exiftool_pass_json_raw_with_registry(json_malformed_val, registry).unwrap();
        assert_eq!(res_malformed.values_by_source.len(), 1);
        assert!(res_malformed
            .values_by_source
            .contains_key("D:/path/Image1.jpg"));
        assert_eq!(res_malformed.failures_by_source.len(), 1);
        let fail_msg = res_malformed
            .failures_by_source
            .get("D:/path/Image2.jpg")
            .unwrap();
        assert!(fail_msg.contains("expected wrapped ExifTool runtime value"));
        assert!(!fail_msg.contains("D:/path/Image2.jpg"));

        // A malformed multi-family property name is likewise isolated to its
        // source while a neighbouring complete property remains available.
        let json_malformed_key = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main", "id": "282", "val": "300"
                }
            },
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:Main:Copy0:ID-282:XResolution": {
                    "table": "Exif::Main", "id": "282", "val": "72"
                }
            }
        ]"#;
        let malformed_key_result =
            try_parse_exiftool_pass_json_raw_with_registry(json_malformed_key, registry).unwrap();
        assert!(malformed_key_result
            .values_by_source
            .contains_key("D:/path/Image1.jpg"));
        assert_eq!(malformed_key_result.failures_by_source.len(), 1);
        assert!(
            malformed_key_result.failures_by_source["D:/path/Image2.jpg"]
                .contains("expected family 1:3:4:5:7")
        );

        // 6. An invalid runtime `index` is isolated similarly
        let json_invalid_index = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "index": "invalid",
                    "val": "300"
                }
            }
        ]"#;
        let res_invalid_index =
            try_parse_exiftool_pass_json_raw_with_registry(json_invalid_index, registry).unwrap();
        assert_eq!(res_invalid_index.values_by_source.len(), 0);
        assert_eq!(res_invalid_index.failures_by_source.len(), 1);
        let fail_msg = res_invalid_index
            .failures_by_source
            .get("D:/path/Image1.jpg")
            .unwrap();
        assert!(fail_msg.contains("invalid"));
        assert!(!fail_msg.contains("D:/path/Image1.jpg"));

        // 7. Identical values at distinct physical paths remain separate occurrences.
        let json_duplicates = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                },
                "IFD1:Main:Copy0:JPEG-APP1-IFD1:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            }
        ]"#;
        let res_duplicates =
            try_parse_exiftool_pass_json_raw_with_registry(json_duplicates, registry).unwrap();
        assert_eq!(res_duplicates.values_by_source.len(), 1);
        assert_eq!(res_duplicates.failures_by_source.len(), 0);

        // 8. Invalid top-level JSON remains a batch-wide Err
        let json_invalid_top = r#"[ { "SourceFile": "D:/path/Image1.jpg" "#;
        let res_invalid_top =
            try_parse_exiftool_pass_json_raw_with_registry(json_invalid_top, registry);
        assert!(res_invalid_top.is_err());

        // 9. A non-object array entry does not remove valid neighbouring source objects
        let json_non_obj = r#"[
            {
                "SourceFile": "D:/path/Image1.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            },
            "not-an-object",
            {
                "SourceFile": "D:/path/Image2.jpg",
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "150"
                }
            }
        ]"#;
        let res_non_obj =
            try_parse_exiftool_pass_json_raw_with_registry(json_non_obj, registry).unwrap();
        assert_eq!(res_non_obj.values_by_source.len(), 2);
        assert!(res_non_obj
            .values_by_source
            .contains_key("D:/path/Image1.jpg"));
        assert!(res_non_obj
            .values_by_source
            .contains_key("D:/path/Image2.jpg"));
        assert_eq!(res_non_obj.failures_by_source.len(), 0);

        // 10. A source-less object is logged/skipped without being assigned to another file
        let json_sourceless = r#"[
            {
                "IFD0:Main:Copy0:JPEG-APP1-IFD0:ID-282:XResolution": {
                    "table": "Exif::Main",
                    "id": "282",
                    "val": "300"
                }
            }
        ]"#;
        let res_sourceless =
            try_parse_exiftool_pass_json_raw_with_registry(json_sourceless, registry).unwrap();
        assert_eq!(res_sourceless.values_by_source.len(), 0);
        assert_eq!(res_sourceless.failures_by_source.len(), 0);
    }

    #[test]
    fn test_assemble_batch_outcome() {
        let registry = crate::tag_schema::get_registry().ok();

        let rel_paths = vec![
            "Image1.jpg".to_string(),
            "Image2.jpg".to_string(),
            "Image3.jpg".to_string(),
        ];
        let abs_paths = vec![
            std::path::PathBuf::from("D:/path/Image1.jpg"),
            std::path::PathBuf::from("D:/path/Image2.jpg"),
            std::path::PathBuf::from("D:/path/Image3.jpg"),
        ];

        // 1. Two successful files and one display-pass failure produce:
        // - two successful results
        // - one failure
        let display_pass = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert(
                    "D:/path/Image2.jpg".to_string(),
                    "display failure details".to_string(),
                );
                map
            },
        };
        let raw_pass = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };

        let mut warnings = Vec::new();
        let outcome = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass.clone(),
            raw_pass.clone(),
            registry,
            &mut warnings,
        )
        .unwrap();

        assert_eq!(outcome.results.len(), 2);
        assert_eq!(outcome.results[0].relative_path, "Image1.jpg");
        assert_eq!(outcome.results[1].relative_path, "Image3.jpg");
        assert_eq!(outcome.failures.len(), 1);
        assert_eq!(outcome.failures[0].relative_path, "Image2.jpg");
        assert!(outcome.failures[0]
            .error_message
            .contains("ExifTool display pass failed:"));
        assert!(outcome.failures[0]
            .error_message
            .contains("display failure details"));
        // Durable isolation invariant: one source can fail parsing while
        // another source in the same logical batch retains successful metadata.
        assert!(outcome
            .results
            .iter()
            .any(|result| result.relative_path == "Image1.jpg"));

        // 2. A raw-pass failure affects only that file
        let display_pass_2 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let raw_pass_2 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert(
                    "D:/path/Image2.jpg".to_string(),
                    "raw failure details".to_string(),
                );
                map
            },
        };
        let outcome_2 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_2,
            raw_pass_2,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_2.results.len(), 2);
        assert_eq!(outcome_2.failures.len(), 1);
        assert_eq!(outcome_2.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_2.failures[0]
            .error_message
            .contains("ExifTool raw (-n) pass failed:"));
        assert!(outcome_2.failures[0]
            .error_message
            .contains("raw failure details"));

        // 3. Failures in both passes produce one combined per-file failure
        let display_pass_3 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert(
                    "D:/path/Image2.jpg".to_string(),
                    "display failure".to_string(),
                );
                map
            },
        };
        let raw_pass_3 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image2.jpg".to_string(), "raw failure".to_string());
                map
            },
        };
        let outcome_3 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_3,
            raw_pass_3,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_3.results.len(), 2);
        assert_eq!(outcome_3.failures.len(), 1);
        assert_eq!(outcome_3.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_3.failures[0]
            .error_message
            .contains("ExifTool display pass failed:"));
        assert!(outcome_3.failures[0]
            .error_message
            .contains("ExifTool raw (-n) pass failed:"));

        // 4. Missing display output affects only that file
        let display_pass_4 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let raw_pass_4 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let outcome_4 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_4,
            raw_pass_4,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_4.results.len(), 2);
        assert_eq!(outcome_4.failures.len(), 1);
        assert_eq!(outcome_4.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_4.failures[0]
            .error_message
            .contains("ExifTool returned no result for this file"));

        // 5. Missing raw output affects only that file
        let display_pass_5 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image2.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let raw_pass_5 = ExifToolPassOutput {
            values_by_source: {
                let mut map = HashMap::new();
                map.insert("D:/path/Image1.jpg".to_string(), BTreeMap::new());
                map.insert("D:/path/Image3.jpg".to_string(), BTreeMap::new());
                map
            },
            failures_by_source: HashMap::new(),
        };
        let outcome_5 = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass_5,
            raw_pass_5,
            registry,
            &mut warnings,
        )
        .unwrap();
        assert_eq!(outcome_5.results.len(), 2);
        assert_eq!(outcome_5.failures.len(), 1);
        assert_eq!(outcome_5.failures[0].relative_path, "Image2.jpg");
        assert!(outcome_5.failures[0]
            .error_message
            .contains("ExifTool raw (-n) pass failed:\nExifTool returned no result for this file"));

        // 6. Every requested path is classified exactly once
        // 7. Input order is preserved
        assert_eq!(outcome.results[0].relative_path, "Image1.jpg");
        assert_eq!(outcome.results[1].relative_path, "Image3.jpg");
        assert_eq!(outcome.failures[0].relative_path, "Image2.jpg");

        // 8. Mismatched path-array lengths return a batch-wide error
        let bad_abs = vec![std::path::PathBuf::from("D:/path/Image1.jpg")];
        let outcome_err = assemble_batch_outcome(
            &rel_paths,
            &bad_abs,
            display_pass,
            raw_pass,
            registry,
            &mut warnings,
        );
        assert!(outcome_err.is_err());
    }

    #[test]
    fn same_schema_conflicting_occurrences_are_successful_and_isolated_per_file() {
        let rel_paths = vec![
            "good-before.jpg".to_string(),
            "collision.jpg".to_string(),
            "good-after.jpg".to_string(),
        ];
        let abs_paths: Vec<_> = rel_paths
            .iter()
            .map(|name| std::path::PathBuf::from(format!("D:/batch/{name}")))
            .collect();
        let registry = canonical_registry();
        let schema = test_schema_id("EXIF::Main", "282", None);
        let unrelated_schema = test_schema_id("Exif::Main", "283", None);
        let property = |path: &str, group: &str, value| {
            test_runtime_property(
                test_occurrence_id(path, "282"),
                schema.clone(),
                group,
                "XResolution",
                None,
                serde_json::json!(value),
            )
        };
        let maps = HashMap::from([
            (
                "D:/batch/good-before.jpg".to_string(),
                runtime_map(vec![property("GOOD-BEFORE", "IFD0", 300)]),
            ),
            (
                "D:/batch/collision.jpg".to_string(),
                runtime_map(vec![
                    property("JPEG-APP1-IFD0", "IFD0", 300),
                    property("JPEG-APP1-IFD1", "IFD1", 72),
                    test_runtime_property(
                        test_occurrence_id("JPEG-APP1-IFD0", "283"),
                        unrelated_schema.clone(),
                        "IFD0",
                        "YResolution",
                        None,
                        serde_json::json!(300),
                    ),
                ]),
            ),
            (
                "D:/batch/good-after.jpg".to_string(),
                runtime_map(vec![property("GOOD-AFTER", "IFD0", 600)]),
            ),
        ]);
        let display_pass = ExifToolPassOutput {
            values_by_source: maps.clone(),
            failures_by_source: HashMap::new(),
        };
        let raw_pass = ExifToolPassOutput {
            values_by_source: maps,
            failures_by_source: HashMap::new(),
        };

        let outcome = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            display_pass,
            raw_pass,
            Some(&registry),
            &mut Vec::new(),
        )
        .expect("individual files remain classifiable");
        assert_eq!(outcome.results.len(), 3);
        assert!(outcome.failures.is_empty());
        assert!(outcome
            .results
            .iter()
            .all(|result| !result.occurrences.is_empty()));

        let collision = outcome
            .results
            .iter()
            .find(|result| result.relative_path == "collision.jpg")
            .unwrap();
        let shared = collision
            .occurrences
            .for_schema(&schema)
            .collect::<Vec<_>>();
        assert_eq!(shared.len(), 2);
        assert_eq!(shared[0].value, MetadataValue::Integer(300));
        assert_eq!(shared[1].value, MetadataValue::Integer(72));
        assert_eq!(
            collision.occurrences.for_schema(&unrelated_schema).count(),
            1
        );

        let wire = serde_json::to_value(collision).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 2);
        assert!(wire.get("metadata").is_none());
        assert_eq!(wire["occurrences"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn successful_batch_result_exposes_only_authoritative_occurrences() {
        let rel_paths = vec!["shared-schema.jpg".to_string()];
        let abs_paths = vec![std::path::PathBuf::from("D:/batch/shared-schema.jpg")];
        let registry = canonical_registry();
        let schema = test_schema_id("EXIF::Main", "282", None);
        let mut ifd1_id = test_occurrence_id_for_schema("JPEG-APP1-IFD1", "282", &schema);
        ifd1_id.copy = 2;
        let unknown_id = MetadataOccurrenceId {
            document: None,
            path: "ZZZ-UNKNOWN".into(),
            runtime_tag_id: "runtime-unknown".into(),
            tag_id_scope: RuntimeTagIdScope {
                table: "Unknown::Runtime".into(),
                tag_id: "runtime-unknown".into(),
                index: None,
            },
            copy: 0,
        };
        let unknown_schema = test_schema_id("Unknown::Runtime", "runtime-unknown", None);
        let properties = runtime_map(vec![
            test_runtime_property(
                ifd1_id.clone(),
                schema.clone(),
                "IFD1",
                "XResolution",
                None,
                serde_json::json!(300),
            ),
            test_runtime_property(
                unknown_id.clone(),
                unknown_schema.clone(),
                "UnknownGroup",
                "RuntimeUnknown",
                None,
                serde_json::json!("preserved"),
            ),
            test_runtime_property(
                test_occurrence_id("JPEG-APP1-IFD0", "282"),
                schema.clone(),
                "IFD0",
                "XResolution",
                None,
                serde_json::json!(300),
            ),
        ]);
        let pass = ExifToolPassOutput {
            values_by_source: HashMap::from([(
                "D:/batch/shared-schema.jpg".to_string(),
                properties,
            )]),
            failures_by_source: HashMap::new(),
        };

        let outcome = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            pass.clone(),
            pass,
            Some(&registry),
            &mut Vec::new(),
        )
        .unwrap();

        assert!(outcome.failures.is_empty());
        assert_eq!(outcome.results.len(), 1);
        let result = &outcome.results[0];
        assert_eq!(result.relative_path, "shared-schema.jpg");
        assert_eq!(result.occurrences.len(), 3);
        assert!(result
            .occurrences
            .iter()
            .map(|occurrence| &occurrence.id)
            .collect::<Vec<_>>()
            .windows(2)
            .all(|pair| pair[0] < pair[1]));

        let shared: Vec<_> = result.occurrences.for_schema(&schema).collect();
        assert_eq!(shared.len(), 2);
        assert_eq!(shared[0].id.path, "JPEG-APP1-IFD0");
        assert_eq!(shared[1].id, ifd1_id);
        assert!(shared.iter().all(|occurrence| {
            occurrence.schema_id == schema && occurrence.write_target.is_some()
        }));
        assert_eq!(
            shared[0].write_target.as_ref().unwrap().selector(),
            "1IFD0:7ID-282:XResolution"
        );
        assert_eq!(
            shared[1].write_target.as_ref().unwrap().selector(),
            "1IFD1:7ID-282:XResolution"
        );

        let unknown = result.occurrences.get(&unknown_id).unwrap();
        assert!(unknown.tag_info.is_none());
        assert!(unknown.write_target.is_none());
        assert!(matches!(
            &unknown.value,
            MetadataValue::Unknown { raw, reason, .. }
                if raw == &serde_json::json!("preserved")
                    && reason.as_deref() == Some("no schema entry for tag")
        ));

        assert_eq!(result.occurrences.for_schema(&schema).count(), 2);
        assert_eq!(result.occurrences.for_schema(&unknown_schema).count(), 1);
    }

    #[test]
    fn canonical_to_public_conversion_sorts_without_reconstructing_occurrences() {
        let info = write_target_test_info(true, TagKind::Rational);
        let mut ifd1 = write_target_test_occurrence(
            "IFD1",
            "XResolution",
            "JPEG-APP1-IFD1",
            2,
            None,
            Some(info.clone()),
            MetadataValue::Integer(300),
        );
        ifd1.occurrence.write_target = Some(MetadataWriteTarget {
            group1: "IFD1".into(),
            group7: "ID-282".into(),
            tag_name: "XResolution".into(),
        });
        let mut ifd0 = write_target_test_occurrence(
            "IFD0",
            "XResolution",
            "JPEG-APP1-IFD0",
            0,
            None,
            Some(info),
            MetadataValue::Integer(300),
        );
        ifd0.occurrence.write_target = Some(MetadataWriteTarget {
            group1: "IFD0".into(),
            group7: "ID-282".into(),
            tag_name: "XResolution".into(),
        });

        let expected_ifd0 = ifd0.occurrence.clone();
        let expected_ifd1 = ifd1.occurrence.clone();
        let public = metadata_occurrences_from_canonical(&[ifd1, ifd0]);

        assert_eq!(public.0, vec![expected_ifd0, expected_ifd1]);
    }

    #[test]
    fn canonicalisation_failure_prefix_is_isolated_and_groups_complete_messages() {
        let rel_paths = vec![
            "good.jpg".to_string(),
            "bad-one.jpg".to_string(),
            "bad-two.jpg".to_string(),
        ];
        let abs_paths: Vec<_> = rel_paths
            .iter()
            .map(|name| std::path::PathBuf::from(format!("D:/batch/{name}")))
            .collect();
        let occurrence_id = test_occurrence_id("JPEG-APP1-IFD0", "282");
        let raw_property = test_runtime_property(
            occurrence_id.clone(),
            test_schema_id("Exif::Main", "282", None),
            "IFD0",
            "XResolution",
            None,
            serde_json::json!(300),
        );
        let mismatched_pretty = test_runtime_property(
            occurrence_id,
            test_schema_id("Exif::Main", "282", None),
            "IFD1",
            "ResolutionAlias",
            None,
            serde_json::json!("300 dpi"),
        );
        let good = test_runtime_property(
            test_occurrence_id("GOOD", "Make"),
            test_schema_id("EXIF::Main", "Make", None),
            "EXIF",
            "Make",
            None,
            serde_json::json!("Canon"),
        );
        let raw_maps = HashMap::from([
            ("D:/batch/good.jpg".into(), runtime_map(vec![good.clone()])),
            (
                "D:/batch/bad-one.jpg".into(),
                runtime_map(vec![raw_property.clone()]),
            ),
            (
                "D:/batch/bad-two.jpg".into(),
                runtime_map(vec![raw_property]),
            ),
        ]);
        let pretty_maps = HashMap::from([
            ("D:/batch/good.jpg".into(), runtime_map(vec![good])),
            (
                "D:/batch/bad-one.jpg".into(),
                runtime_map(vec![mismatched_pretty.clone()]),
            ),
            (
                "D:/batch/bad-two.jpg".into(),
                runtime_map(vec![mismatched_pretty]),
            ),
        ]);

        let outcome = assemble_batch_outcome(
            &rel_paths,
            &abs_paths,
            ExifToolPassOutput {
                values_by_source: pretty_maps,
                failures_by_source: HashMap::new(),
            },
            ExifToolPassOutput {
                values_by_source: raw_maps,
                failures_by_source: HashMap::new(),
            },
            Some(&canonical_registry()),
            &mut Vec::new(),
        )
        .unwrap();

        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].relative_path, "good.jpg");
        assert_eq!(outcome.failures.len(), 2);
        assert!(outcome.failures.iter().all(|failure| failure
            .error_message
            .starts_with("Metadata canonicalisation failed:")));
        let grouped = group_metadata_failures(&outcome.failures);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped.values().next().unwrap().len(), 2);
    }

    #[test]
    fn test_worker_failure_grouping() {
        let outcome = MetadataBatchReadOutcome {
            results: vec![
                FileMetadata {
                    relative_path: "good1.jpg".to_string(),
                    occurrences: MetadataOccurrences::default(),
                },
                FileMetadata {
                    relative_path: "good2.jpg".to_string(),
                    occurrences: MetadataOccurrences::default(),
                },
            ],
            failures: vec![
                MetadataReadFailure {
                    relative_path: "bad1.jpg".to_string(),
                    error_message: "Error A".to_string(),
                },
                MetadataReadFailure {
                    relative_path: "bad2.jpg".to_string(),
                    error_message: "Error B".to_string(),
                },
                MetadataReadFailure {
                    relative_path: "bad3.jpg".to_string(),
                    error_message: "Error A".to_string(),
                },
            ],
        };

        assert_eq!(outcome.results[0].relative_path, "good1.jpg");
        assert_eq!(outcome.results[1].relative_path, "good2.jpg");

        let grouped = group_metadata_failures(&outcome.failures);

        assert_eq!(grouped.len(), 2);
        assert!(grouped.contains_key("Error A"));
        assert!(grouped.contains_key("Error B"));

        let affected_a = grouped.get("Error A").unwrap();
        assert_eq!(
            affected_a,
            &vec!["bad1.jpg".to_string(), "bad3.jpg".to_string()]
        );

        let affected_b = grouped.get("Error B").unwrap();
        assert_eq!(affected_b, &vec!["bad2.jpg".to_string()]);
    }
}
