use serde::{Deserialize, Serialize};

use crate::metadata_value::MetadataValue;
use crate::tag_schema::{SchemaDefinitionId, TagInfo, TagKind};

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
/// - family 4: ExifTool extraction instance/copy number for a same-named
///   runtime tag.
///
/// `MetadataOccurrenceId` is unique only within one source file. Code requiring
/// identity across files must combine it with the file's relative path.
///
/// ExifTool family values are normalised at the read boundary as follows:
///
/// - family 3 `Main` is stored as `document = None`;
/// - the empty primary family-4 position (and explicit `Copy0`) is stored as
///   `copy = 0`;
/// - family-4 `CopyN` values retain their numeric `N` exactly;
/// - the family-7 transport prefix `ID-` is omitted from stored `tag_id`.
///
/// Family-4 numbering may span different family-1 groups and family-5 paths.
/// It is runtime occurrence identity, not an "Nth copy within this path"
/// coordinate, and is not independently sufficient to target a write.
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
    /// `None` represents ExifTool's primary `Main` document group.
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
    /// path, with ExifTool's `ID-` group-name prefix omitted. This is runtime
    /// occurrence information and is not necessarily identical to the tag ID
    /// used by the static schema registry.
    pub tag_id: String,

    /// ExifTool family 4 extraction instance/copy number.
    ///
    /// `0` represents ExifTool's empty primary family-4 position or explicit
    /// `Copy0`. A `CopyN` value is retained as the numeric `N` exactly.
    /// Numbering may span family-1 groups and family-5 paths, so this is
    /// runtime occurrence identity rather than an "Nth copy within this path"
    /// coordinate. It is not independently a write coordinate.
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
/// - occurrences whose only distinguishing coordinates are unsupported by
///   the available family-1/tag-name selector, including several occurrences
///   that share that one selector;
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
/// The occurrence combines five independent concerns:
///
/// - `id` identifies which concrete runtime field in the file this is;
/// - `schema_id` identifies the exact static schema definition reported by
///   ExifTool;
/// - `value` contains the current canonical semantic value;
/// - `tag_info` contains registry interpretation and presentation metadata when
///   that exact schema resolves;
/// - `write_target` describes how the occurrence can be written safely when an
///   exact ExifTool selector is available.
///
/// Runtime occurrence identity and schema identity are independent. Several
/// concrete occurrences may share one `schema_id`, and the same runtime tag ID
/// text does not imply the same schema.
///
/// `tag_info` is optional because ExifTool may return runtime fields that do not
/// resolve to the static schema registry. `None` does not mean the exact schema
/// identity is unknown: `schema_id` remains authoritative. When `tag_info` is
/// present, `TagInfo::id` must exactly equal `schema_id`.
///
/// Neither schema identity nor a runtime selector alone proves writability.
/// `write_target` is optional and stricter than schema writability; an unknown
/// or unsupported schema remains read-only even if runtime coordinates exist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "MetadataOccurrenceWire")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataOccurrence {
    /// Runtime identity of this field within its source file.
    pub id: MetadataOccurrenceId,

    /// Exact static schema identity reported by ExifTool.
    ///
    /// This is independent of runtime occurrence identity. Multiple occurrences
    /// may share one schema definition.
    pub schema_id: SchemaDefinitionId,

    /// Current canonical semantic value read from the file.
    pub value: MetadataValue,

    /// Exactly resolved static schema information.
    ///
    /// `None` means that the exact schema did not resolve in the local registry.
    /// Consumers must not guess interpretation from friendly names or related
    /// definitions. When present, `TagInfo::id` must equal `schema_id`.
    pub tag_info: Option<TagInfo>,

    /// Exact ExifTool write destination for this occurrence.
    ///
    /// `None` means that this occurrence is read-only through the application,
    /// even if its resolved schema is generally writable.
    pub write_target: Option<MetadataWriteTarget>,
}

#[derive(Deserialize)]
struct MetadataOccurrenceWire {
    id: MetadataOccurrenceId,
    schema_id: SchemaDefinitionId,
    value: MetadataValue,
    tag_info: Option<TagInfo>,
    write_target: Option<MetadataWriteTarget>,
}

impl TryFrom<MetadataOccurrenceWire> for MetadataOccurrence {
    type Error = String;

    fn try_from(wire: MetadataOccurrenceWire) -> Result<Self, Self::Error> {
        Self::try_new(
            wire.id,
            wire.schema_id,
            wire.value,
            wire.tag_info,
            wire.write_target,
        )
    }
}

impl MetadataOccurrence {
    pub fn try_new(
        id: MetadataOccurrenceId,
        schema_id: SchemaDefinitionId,
        value: MetadataValue,
        tag_info: Option<TagInfo>,
        write_target: Option<MetadataWriteTarget>,
    ) -> Result<Self, String> {
        let occurrence = Self {
            id,
            schema_id,
            value,
            tag_info,
            write_target,
        };
        occurrence.validate_schema_identity()?;
        Ok(occurrence)
    }

    /// Validates that optional registry interpretation belongs to the exact
    /// schema reported for this occurrence.
    pub fn validate_schema_identity(&self) -> Result<(), String> {
        if let Some(info) = &self.tag_info {
            if info.id != self.schema_id {
                return Err(format!(
                    "metadata occurrence schema mismatch: occurrence_id={:?} occurrence_schema_id={:?} tag_info_schema_id={:?}",
                    self.id, self.schema_id, info.id
                ));
            }
        }
        Ok(())
    }

    /// Returns true only when matching resolved schema interpretation and this
    /// concrete occurrence both permit an exact supported write.
    pub fn is_writable(&self) -> bool {
        self.tag_info.as_ref().is_some_and(|info| {
            info.id == self.schema_id
                && info.writable
                && !matches!(info.kind, TagKind::Binary | TagKind::Unknown)
        }) && self.write_target.is_some()
    }
}

/// Ordered collection of concrete metadata occurrences read from one source
/// file.
///
/// Entries are identified by `MetadataOccurrenceId`, not by schema identity.
/// Several entries may therefore contain the same `TagInfo`.
///
/// The collection order is deterministic and follows
/// `MetadataOccurrenceId` ordering.
///
/// This type must not provide a helper which silently chooses one occurrence
/// for a `SchemaDefinitionId`. Schema-based callers must explicitly handle
/// missing, unique and multiple matches.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(transparent)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataOccurrences(pub Vec<MetadataOccurrence>);

impl MetadataOccurrences {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn get(&self, id: &MetadataOccurrenceId) -> Option<&MetadataOccurrence> {
        self.0.iter().find(|occurrence| occurrence.id == *id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &MetadataOccurrence> {
        self.0.iter()
    }

    pub fn for_schema<'a>(
        &'a self,
        id: &'a SchemaDefinitionId,
    ) -> impl Iterator<Item = &'a MetadataOccurrence> {
        self.0
            .iter()
            .filter(move |occurrence| &occurrence.schema_id == id)
    }
}

impl IntoIterator for MetadataOccurrences {
    type Item = MetadataOccurrence;
    type IntoIter = std::vec::IntoIter<MetadataOccurrence>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::tag_schema::TagKind;

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
        schema_id: SchemaDefinitionId,
        tag_info: Option<TagInfo>,
        write_target: Option<MetadataWriteTarget>,
    ) -> MetadataOccurrence {
        MetadataOccurrence {
            id: occurrence_id(None, "JPEG-APP1-IFD0", "282", 0),
            schema_id,
            value: MetadataValue::Integer(300),
            tag_info,
            write_target,
        }
    }

    fn shared_schema_occurrences() -> MetadataOccurrences {
        let schema = tag_info(true);
        let first = occurrence(
            schema.id.clone(),
            Some(schema.clone()),
            Some(target("IFD0")),
        );
        let mut second = occurrence(schema.id.clone(), Some(schema), Some(target("IFD1")));
        second.id.path = "JPEG-APP1-IFD1".to_owned();
        second.id.copy = 2;
        MetadataOccurrences(vec![first, second])
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
        assert!(occurrence(
            tag_info(true).id,
            Some(tag_info(true)),
            Some(target("IFD0"))
        )
        .is_writable());
        assert!(!occurrence(tag_info(true).id, None, Some(target("IFD0"))).is_writable());
        assert!(!occurrence(
            tag_info(false).id,
            Some(tag_info(false)),
            Some(target("IFD0"))
        )
        .is_writable());
        assert!(!occurrence(tag_info(true).id, Some(tag_info(true)), None).is_writable());
    }

    #[test]
    fn known_occurrence_serialises_with_explicit_schema_identity() {
        let info = tag_info(true);
        let value = occurrence(info.id.clone(), Some(info.clone()), Some(target("IFD0")));
        let json = serde_json::to_value(&value).unwrap();

        assert_eq!(json["schema_id"]["table"], "Exif::Main");
        assert_eq!(json["schema_id"]["tag_id"], "282");
        assert_eq!(json["tag_info"]["id"], json["schema_id"]);
    }

    #[test]
    fn unknown_schema_occurrence_retains_exact_table_tag_and_index() {
        let schema_id = SchemaDefinitionId {
            table: "Unknown::ExactTable".to_owned(),
            tag_id: "0x1234".to_owned(),
            index: Some(0),
        };
        let value = occurrence(schema_id.clone(), None, None);
        let round_trip: MetadataOccurrence =
            serde_json::from_value(serde_json::to_value(&value).unwrap()).unwrap();

        assert_eq!(round_trip.schema_id, schema_id);
        assert!(round_trip.tag_info.is_none());
        assert!(round_trip.write_target.is_none());
        assert!(!round_trip.is_writable());
    }

    #[test]
    fn mismatched_schema_and_tag_info_are_rejected_with_all_identities() {
        let occurrence_schema_id = SchemaDefinitionId {
            table: "Exif::Main".to_owned(),
            tag_id: "282".to_owned(),
            index: None,
        };
        let mut conflicting_info = tag_info(true);
        conflicting_info.id = SchemaDefinitionId {
            table: "Exif::Other".to_owned(),
            tag_id: "282".to_owned(),
            index: Some(0),
        };
        let json = serde_json::json!({
            "id": occurrence_id(None, "JPEG-APP1-IFD0", "282", 0),
            "schema_id": occurrence_schema_id,
            "value": MetadataValue::Integer(300),
            "tag_info": conflicting_info,
            "write_target": target("IFD0"),
        });

        let error = serde_json::from_value::<MetadataOccurrence>(json)
            .expect_err("mismatched schema interpretation must be rejected")
            .to_string();
        assert!(error.contains("JPEG-APP1-IFD0"));
        assert!(error.contains("Exif::Main"));
        assert!(error.contains("Exif::Other"));
    }

    #[test]
    fn absent_schema_index_remains_distinct_from_index_zero() {
        let unindexed = SchemaDefinitionId {
            table: "Exif::Main".to_owned(),
            tag_id: "282".to_owned(),
            index: None,
        };
        let indexed = SchemaDefinitionId {
            index: Some(0),
            ..unindexed.clone()
        };

        assert_ne!(unindexed, indexed);
        assert_ne!(
            occurrence(unindexed, None, None).schema_id,
            occurrence(indexed, None, None).schema_id
        );
    }

    #[test]
    fn mismatched_or_unsupported_tag_info_never_makes_an_occurrence_writable() {
        let schema_id = tag_info(true).id;
        let mut mismatched = tag_info(true);
        mismatched.id.table = "Exif::Other".to_owned();
        assert!(
            !occurrence(schema_id.clone(), Some(mismatched), Some(target("IFD0"))).is_writable()
        );

        let mut binary = tag_info(true);
        binary.kind = TagKind::Binary;
        assert!(!occurrence(schema_id, Some(binary), Some(target("IFD0"))).is_writable());
    }

    #[test]
    fn shared_schema_does_not_collapse_occurrence_identity_or_write_target() {
        let schema = tag_info(true);
        let first = occurrence(
            schema.id.clone(),
            Some(schema.clone()),
            Some(target("IFD0")),
        );
        let mut second = occurrence(schema.id.clone(), Some(schema), Some(target("IFD1")));
        second.id.path = "JPEG-APP1-IFD1".to_owned();

        assert_eq!(first.tag_info, second.tag_info);
        assert_ne!(first.id, second.id);
        assert_ne!(first.write_target, second.write_target);
    }

    #[test]
    fn default_collection_is_empty_and_reports_length() {
        let empty = MetadataOccurrences::default();
        assert!(empty.is_empty());
        assert_eq!(empty.len(), 0);

        let populated = shared_schema_occurrences();
        assert!(!populated.is_empty());
        assert_eq!(populated.len(), 2);
    }

    #[test]
    fn exact_lookup_keeps_family_five_and_family_four_identity_distinct() {
        let occurrences = shared_schema_occurrences();
        let ifd0 = occurrence_id(None, "JPEG-APP1-IFD0", "282", 0);
        let ifd1_copy2 = occurrence_id(None, "JPEG-APP1-IFD1", "282", 2);

        assert_eq!(occurrences.get(&ifd0).unwrap().id, ifd0);
        assert_eq!(occurrences.get(&ifd1_copy2).unwrap().id, ifd1_copy2);
        assert!(occurrences
            .get(&occurrence_id(None, "JPEG-APP1-IFD1", "282", 0))
            .is_none());
        assert!(occurrences
            .get(&occurrence_id(None, "JPEG-APP1-IFD0", "282", 2))
            .is_none());
    }

    #[test]
    fn schema_lookup_returns_every_match_including_unknown_occurrences() {
        let mut occurrences = shared_schema_occurrences();
        let schema_id = occurrences.0[0].schema_id.clone();
        let unknown_schema = SchemaDefinitionId {
            table: "Unknown::Table".to_owned(),
            tag_id: schema_id.tag_id.clone(),
            index: None,
        };
        let mut unknown = occurrence(unknown_schema.clone(), None, None);
        unknown.id.tag_id = schema_id.tag_id.clone();
        unknown.id.path = "UNKNOWN".to_owned();
        occurrences.0.push(unknown);

        let matches: Vec<_> = occurrences.for_schema(&schema_id).collect();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].id.path, "JPEG-APP1-IFD0");
        assert_eq!(matches[1].id.path, "JPEG-APP1-IFD1");
        assert!(matches.iter().all(|item| item.tag_info.is_some()));

        let unknown_matches: Vec<_> = occurrences.for_schema(&unknown_schema).collect();
        assert_eq!(unknown_matches.len(), 1);
        assert_eq!(unknown_matches[0].id.path, "UNKNOWN");
        assert!(unknown_matches[0].tag_info.is_none());
    }

    #[test]
    fn borrowed_and_owned_iteration_preserve_deterministic_order() {
        let occurrences = shared_schema_occurrences();
        let borrowed: Vec<_> = occurrences.iter().map(|item| item.id.clone()).collect();
        let owned: Vec<_> = occurrences
            .clone()
            .into_iter()
            .map(|item| item.id)
            .collect();

        assert_eq!(borrowed, owned);
        assert!(owned.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn collection_json_round_trip_preserves_every_nested_field() {
        let occurrences = shared_schema_occurrences();
        let json = serde_json::to_string(&occurrences).unwrap();
        let round_trip: MetadataOccurrences = serde_json::from_str(&json).unwrap();

        assert_eq!(round_trip, occurrences);
        assert_eq!(round_trip.0[0].tag_info, occurrences.0[0].tag_info);
        assert_eq!(round_trip.0[1].write_target, occurrences.0[1].write_target);
    }

    #[test]
    fn generated_typescript_representation_is_metadata_occurrence_array() {
        use ts_rs::TS;

        assert_eq!(
            MetadataOccurrences::decl(),
            "type MetadataOccurrences = Array<MetadataOccurrence>;"
        );
    }
}
