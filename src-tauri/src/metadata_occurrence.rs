use serde::{Deserialize, Serialize};

use crate::metadata_value::MetadataValue;
use crate::tag_schema::TagInfo;

/// Identifies one concrete metadata field occurrence within a single source
/// file.
///
/// This is runtime identity, not schema identity. It describes which extracted
/// value in the file an entry represents, independently of how that value is
/// interpreted.
///
/// The ID is composed from ExifTool metadata-family information:
///
/// - family 3: embedded document or timed-metadata sample;
/// - family 5: complete metadata container path;
/// - family 7: the tag's runtime ID;
/// - family 4: duplicate-instance number within that location.
///
/// `MetadataOccurrenceId` is unique only within one source file. Code requiring
/// identity across files must combine it with the file's relative path.
///
/// The primary family-4 occurrence is normalised to `copy = 0`, whether
/// ExifTool reports it without a family-4 group or explicitly as `Copy0`.
///
/// This type deliberately contains no `SchemaDefinitionId`. Multiple runtime
/// occurrences may resolve to the same static schema definition.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataOccurrenceId {
    /// ExifTool family 3.
    ///
    /// Identifies an embedded document or timed-metadata sample when relevant.
    /// `None` represents the main document where ExifTool supplies no distinct
    /// family-3 value.
    #[cfg_attr(test, ts(type = "string | null"))]
    pub document: Option<String>,

    /// ExifTool family 5.
    ///
    /// The complete metadata container path, such as:
    ///
    /// - `JPEG-APP1-IFD0`
    /// - `JPEG-APP1-IFD1`
    /// - `JPEG-APP1-IFD0-ExifIFD`
    pub path: String,

    /// ExifTool family 7.
    ///
    /// The runtime tag ID used to distinguish tags within the same metadata
    /// path. This is runtime occurrence information and is not necessarily
    /// identical to the tag ID used by the static schema registry.
    pub tag_id: String,

    /// ExifTool family 4, normalised to a zero-based instance number.
    ///
    /// `0` represents the primary occurrence. Values greater than zero
    /// represent additional copies of the same runtime tag in the same
    /// metadata location.
    pub copy: u32,
}

/// Describes an exact ExifTool selector for safely writing one metadata field.
///
/// This type is present only when the application can target the intended
/// occurrence unambiguously using ExifTool's supported write syntax.
///
/// The selector components are stored separately rather than as a preformatted
/// command-line argument. This avoids parsing strings and allows the final
/// ExifTool argument to be constructed at the write boundary.
///
/// Runtime family 1 is retained here because it identifies the writable
/// metadata destination, such as `IFD0` or `IFD1`. It is occurrence-specific
/// information and must not be taken from the static `TagInfo`.
///
/// An occurrence has no `MetadataWriteTarget` when an exact write cannot be
/// demonstrated, including cases such as:
///
/// - family-4 copies that ExifTool cannot individually target;
/// - unsupported embedded documents or timed-metadata samples;
/// - unknown or read-only schema definitions;
/// - ambiguous runtime locations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataWriteTarget {
    /// ExifTool family-1 group identifying the concrete write destination,
    /// such as `IFD0`, `IFD1`, `ExifIFD`, `GPS` or `XMP-dc`.
    pub group1: String,

    /// ExifTool tag name to qualify with `group1`.
    ///
    /// This should be the canonical writable tag name retained from runtime
    /// extraction or derived from an exactly resolved `TagInfo`.
    pub tag_name: String,
}

impl MetadataWriteTarget {
    /// Returns the group-qualified ExifTool selector without a leading `-`.
    ///
    /// Examples:
    ///
    /// ```text
    /// IFD0:XResolution
    /// IFD1:XResolution
    /// XMP-dc:Description
    /// ```
    pub fn selector(&self) -> String {
        format!("{}:{}", self.group1, self.tag_name)
    }
}

/// One concrete metadata field occurrence read from a source file.
///
/// The occurrence combines four independent concerns:
///
/// - `id` identifies which runtime field in the file this is;
/// - `value` contains its current canonical semantic value;
/// - `tag_info` describes how the value is interpreted when exact schema
///   resolution succeeds;
/// - `write_target` describes how the occurrence can be written safely when an
///   exact ExifTool selector is available.
///
/// `tag_info` is optional because ExifTool may return runtime fields that do not
/// resolve to the static schema registry. Such occurrences must still be
/// retained and displayed, but are treated as unknown and read-only.
///
/// `TagInfo::id` is the sole schema identity. A separate
/// `SchemaDefinitionId` is intentionally not duplicated here.
///
/// `write_target` is also optional and is stricter than schema writability.
/// A writable schema definition does not by itself prove that a particular
/// runtime occurrence can be targeted unambiguously.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataOccurrence {
    /// Runtime identity of this field within its source file.
    pub id: MetadataOccurrenceId,

    /// Current canonical semantic value read from the file.
    pub value: MetadataValue,

    /// Exactly resolved static schema information.
    ///
    /// `None` means that no exact schema definition was found. Consumers must
    /// not guess a schema from friendly names or related definitions.
    pub tag_info: Option<TagInfo>,

    /// Exact ExifTool write destination for this occurrence.
    ///
    /// `None` means that this occurrence is read-only through the application,
    /// even if its resolved schema is generally writable.
    pub write_target: Option<MetadataWriteTarget>,
}

impl MetadataOccurrence {
    /// Returns true only when both the static schema and this concrete
    /// occurrence permit an exact write.
    pub fn is_writable(&self) -> bool {
        self.tag_info.as_ref().is_some_and(|info| info.writable) && self.write_target.is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::tag_schema::{SchemaDefinitionId, TagKind};

    fn occurrence_id(
        document: Option<&str>,
        path: &str,
        tag_id: &str,
        copy: u32,
    ) -> MetadataOccurrenceId {
        MetadataOccurrenceId {
            document: document.map(str::to_owned),
            path: path.to_owned(),
            tag_id: tag_id.to_owned(),
            copy,
        }
    }

    fn tag_info(writable: bool) -> TagInfo {
        TagInfo {
            id: SchemaDefinitionId {
                table: "Exif::Main".to_owned(),
                tag_id: "282".to_owned(),
                index: None,
            },
            group: "IFD0".to_owned(),
            name: "XResolution".to_owned(),
            writable,
            kind: TagKind::Rational,
            description: Some("X resolution".to_owned()),
            storage_count: None,
        }
    }

    fn target(group1: &str) -> MetadataWriteTarget {
        MetadataWriteTarget {
            group1: group1.to_owned(),
            tag_name: "XResolution".to_owned(),
        }
    }

    fn occurrence(
        tag_info: Option<TagInfo>,
        write_target: Option<MetadataWriteTarget>,
    ) -> MetadataOccurrence {
        MetadataOccurrence {
            id: occurrence_id(None, "JPEG-APP1-IFD0", "282", 0),
            value: MetadataValue::Integer(300),
            tag_info,
            write_target,
        }
    }

    #[test]
    fn equal_ids_compare_and_hash_equally() {
        let a = occurrence_id(None, "JPEG-APP1-IFD0", "282", 0);
        let b = occurrence_id(None, "JPEG-APP1-IFD0", "282", 0);
        assert_eq!(a, b);
        assert!(HashSet::from([a]).contains(&b));
    }

    #[test]
    fn every_runtime_component_participates_in_identity() {
        let base = occurrence_id(None, "JPEG-APP1-IFD0", "282", 0);
        assert_ne!(
            base,
            occurrence_id(Some("Doc1"), "JPEG-APP1-IFD0", "282", 0)
        );
        assert_ne!(base, occurrence_id(None, "JPEG-APP1-IFD1", "282", 0));
        assert_ne!(base, occurrence_id(None, "JPEG-APP1-IFD0", "283", 0));
        assert_ne!(base, occurrence_id(None, "JPEG-APP1-IFD0", "282", 1));
    }

    #[test]
    fn ordering_includes_all_components_deterministically() {
        let mut ids = vec![
            occurrence_id(Some("Doc1"), "A", "1", 0),
            occurrence_id(None, "B", "1", 0),
            occurrence_id(None, "A", "2", 0),
            occurrence_id(None, "A", "1", 1),
            occurrence_id(None, "A", "1", 0),
        ];
        ids.sort();
        assert_eq!(
            ids,
            vec![
                occurrence_id(None, "A", "1", 0),
                occurrence_id(None, "A", "1", 1),
                occurrence_id(None, "A", "2", 0),
                occurrence_id(None, "B", "1", 0),
                occurrence_id(Some("Doc1"), "A", "1", 0),
            ]
        );
    }

    #[test]
    fn json_round_trip_preserves_null_document_and_primary_copy() {
        let id = occurrence_id(None, "JPEG-APP1-IFD0", "282", 0);
        let json = serde_json::to_value(&id).unwrap();
        assert_eq!(json["document"], serde_json::Value::Null);
        assert_eq!(json["copy"], 0);
        assert_eq!(
            serde_json::from_value::<MetadataOccurrenceId>(json).unwrap(),
            id
        );
    }

    #[test]
    fn write_target_selector_is_group_qualified_without_dash() {
        assert_eq!(target("IFD1").selector(), "IFD1:XResolution");
    }

    #[test]
    fn occurrence_is_writable_only_with_writable_schema_and_exact_target() {
        assert!(occurrence(Some(tag_info(true)), Some(target("IFD0"))).is_writable());
        assert!(!occurrence(None, Some(target("IFD0"))).is_writable());
        assert!(!occurrence(Some(tag_info(false)), Some(target("IFD0"))).is_writable());
        assert!(!occurrence(Some(tag_info(true)), None).is_writable());
    }

    #[test]
    fn shared_schema_does_not_collapse_occurrence_identity_or_write_target() {
        let schema = tag_info(true);
        let first = occurrence(Some(schema.clone()), Some(target("IFD0")));
        let mut second = occurrence(Some(schema), Some(target("IFD1")));
        second.id.path = "JPEG-APP1-IFD1".to_owned();

        assert_eq!(first.tag_info, second.tag_info);
        assert_ne!(first.id, second.id);
        assert_ne!(first.write_target, second.write_target);
    }
}
