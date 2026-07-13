//! Locked draft-target model for the upcoming occurrence-aware draft migration.
//!
//! Persisted and in-memory drafts remain schema-keyed v4 in this foundation
//! change. Production draft, apply, and write paths do not consume this model
//! yet.

use serde::{Deserialize, Serialize};

use crate::metadata_occurrence::{MetadataOccurrence, MetadataOccurrenceId, MetadataWriteTarget};
use crate::tag_schema::{SchemaDefinitionId, TagInfo};

/// Distinguishes editing one existing runtime occurrence from creating a new
/// property selected from the static schema.
///
/// The source file's relative path remains the outer draft-map context and is
/// intentionally not duplicated in either target variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "PascalCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MetadataDraftTarget {
    /// An edit to one exact runtime occurrence already present in a file.
    ExistingOccurrence {
        /// Runtime identity of the occurrence selected by the user.
        occurrence_id: MetadataOccurrenceId,
        /// Exact static schema used to interpret its semantic value.
        schema_id: SchemaDefinitionId,
        /// Snapshot of the exact supported selector selected with the
        /// occurrence.
        ///
        /// This snapshot does not authorise a blind future write. Before an
        /// occurrence-targeted draft is applied, the later apply pipeline must
        /// reread authoritative occurrences, find this exact occurrence ID,
        /// validate the schema and selector snapshot, reject stale or ambiguous
        /// targets, and only then construct the ExifTool write.
        write_target: MetadataWriteTarget,
    },

    /// Creation of a property selected from one exact static schema definition.
    /// No runtime occurrence or exact occurrence selector exists yet.
    NewProperty { schema_id: SchemaDefinitionId },
}

/// A specific reason a draft target cannot be constructed or revalidated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataDraftTargetError {
    UnknownSchema,
    ReadOnlySchema,
    MissingWriteTarget,
    WrongTargetKind,
    OccurrenceIdMismatch,
    SchemaIdMismatch,
    WriteTargetMismatch,
}

impl std::fmt::Display for MetadataDraftTargetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::UnknownSchema => "metadata occurrence has no exactly resolved schema",
            Self::ReadOnlySchema => "metadata schema is read-only",
            Self::MissingWriteTarget => "metadata occurrence has no exact write target",
            Self::WrongTargetKind => "draft target is not an existing occurrence",
            Self::OccurrenceIdMismatch => {
                "stored occurrence ID does not match the fresh occurrence"
            }
            Self::SchemaIdMismatch => "stored schema ID does not match the fresh occurrence",
            Self::WriteTargetMismatch => {
                "stored write-target snapshot does not match the fresh occurrence"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for MetadataDraftTargetError {}

impl MetadataDraftTarget {
    pub fn schema_id(&self) -> &SchemaDefinitionId {
        match self {
            Self::ExistingOccurrence { schema_id, .. } | Self::NewProperty { schema_id } => {
                schema_id
            }
        }
    }

    pub fn occurrence_id(&self) -> Option<&MetadataOccurrenceId> {
        match self {
            Self::ExistingOccurrence { occurrence_id, .. } => Some(occurrence_id),
            Self::NewProperty { .. } => None,
        }
    }

    pub fn write_target(&self) -> Option<&MetadataWriteTarget> {
        match self {
            Self::ExistingOccurrence { write_target, .. } => Some(write_target),
            Self::NewProperty { .. } => None,
        }
    }

    pub fn is_existing_occurrence(&self) -> bool {
        matches!(self, Self::ExistingOccurrence { .. })
    }

    pub fn is_new_property(&self) -> bool {
        matches!(self, Self::NewProperty { .. })
    }

    /// Captures all three independent identities from one explicitly selected,
    /// writable runtime occurrence.
    pub fn from_existing_occurrence(
        occurrence: &MetadataOccurrence,
    ) -> Result<Self, MetadataDraftTargetError> {
        let info = occurrence
            .tag_info
            .as_ref()
            .ok_or(MetadataDraftTargetError::UnknownSchema)?;
        if !info.writable {
            return Err(MetadataDraftTargetError::ReadOnlySchema);
        }
        let write_target = occurrence
            .write_target
            .as_ref()
            .ok_or(MetadataDraftTargetError::MissingWriteTarget)?;

        Ok(Self::ExistingOccurrence {
            occurrence_id: occurrence.id.clone(),
            schema_id: info.id.clone(),
            write_target: write_target.clone(),
        })
    }

    /// Creates a schema-driven property target from one exactly resolved,
    /// writable schema definition.
    pub fn from_new_property(info: &TagInfo) -> Result<Self, MetadataDraftTargetError> {
        if !info.writable {
            return Err(MetadataDraftTargetError::ReadOnlySchema);
        }

        Ok(Self::NewProperty {
            schema_id: info.id.clone(),
        })
    }

    /// Revalidates an existing-occurrence target against a freshly read exact
    /// occurrence before a future apply pipeline is allowed to write it.
    pub fn validate_existing_occurrence(
        &self,
        occurrence: &MetadataOccurrence,
    ) -> Result<(), MetadataDraftTargetError> {
        let Self::ExistingOccurrence {
            occurrence_id,
            schema_id,
            write_target,
        } = self
        else {
            return Err(MetadataDraftTargetError::WrongTargetKind);
        };

        if occurrence_id != &occurrence.id {
            return Err(MetadataDraftTargetError::OccurrenceIdMismatch);
        }
        let info = occurrence
            .tag_info
            .as_ref()
            .ok_or(MetadataDraftTargetError::UnknownSchema)?;
        if schema_id != &info.id {
            return Err(MetadataDraftTargetError::SchemaIdMismatch);
        }
        if !info.writable {
            return Err(MetadataDraftTargetError::ReadOnlySchema);
        }
        let fresh_write_target = occurrence
            .write_target
            .as_ref()
            .ok_or(MetadataDraftTargetError::MissingWriteTarget)?;
        if write_target != fresh_write_target {
            return Err(MetadataDraftTargetError::WriteTargetMismatch);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_value::MetadataValue;
    use crate::tag_schema::TagKind;

    fn schema_id(index: Option<u32>) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: "Exif::Main".to_owned(),
            tag_id: "282".to_owned(),
            index,
        }
    }

    fn info(writable: bool, index: Option<u32>) -> TagInfo {
        TagInfo {
            id: schema_id(index),
            group: "SchemaGroupMustNotBecomeTarget".to_owned(),
            name: "FriendlyNameMustNotBecomeTarget".to_owned(),
            writable,
            kind: TagKind::Rational,
            description: None,
            storage_count: None,
        }
    }

    fn occurrence_id() -> MetadataOccurrenceId {
        MetadataOccurrenceId {
            document: None,
            path: "JPEG-APP1-IFD0".to_owned(),
            tag_id: "282".to_owned(),
            copy: 2,
        }
    }

    fn write_target() -> MetadataWriteTarget {
        MetadataWriteTarget {
            group1: "IFD0".to_owned(),
            tag_name: "XResolution".to_owned(),
        }
    }

    fn occurrence() -> MetadataOccurrence {
        MetadataOccurrence {
            id: occurrence_id(),
            value: MetadataValue::Integer(300),
            tag_info: Some(info(true, None)),
            write_target: Some(write_target()),
        }
    }

    #[test]
    fn writable_existing_occurrence_preserves_all_three_exact_identities() {
        let occurrence = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&occurrence).unwrap();

        assert_eq!(target.occurrence_id(), Some(&occurrence.id));
        assert_eq!(
            target.schema_id(),
            &occurrence.tag_info.as_ref().unwrap().id
        );
        assert_eq!(target.write_target(), occurrence.write_target.as_ref());
        assert!(target.is_existing_occurrence());
        assert!(!target.is_new_property());
    }

    #[test]
    fn existing_occurrence_requires_an_exact_schema() {
        let mut occurrence = occurrence();
        occurrence.tag_info = None;

        assert_eq!(
            MetadataDraftTarget::from_existing_occurrence(&occurrence),
            Err(MetadataDraftTargetError::UnknownSchema)
        );
    }

    #[test]
    fn existing_occurrence_requires_a_writable_schema() {
        let mut occurrence = occurrence();
        occurrence.tag_info.as_mut().unwrap().writable = false;

        assert_eq!(
            MetadataDraftTarget::from_existing_occurrence(&occurrence),
            Err(MetadataDraftTargetError::ReadOnlySchema)
        );
    }

    #[test]
    fn existing_occurrence_requires_an_exact_write_target() {
        let mut occurrence = occurrence();
        occurrence.write_target = None;

        assert_eq!(
            MetadataDraftTarget::from_existing_occurrence(&occurrence),
            Err(MetadataDraftTargetError::MissingWriteTarget)
        );
    }

    #[test]
    fn new_property_uses_only_the_exact_writable_schema() {
        let info = info(true, Some(0));
        let target = MetadataDraftTarget::from_new_property(&info).unwrap();

        assert_eq!(target.schema_id(), &info.id);
        assert_eq!(target.occurrence_id(), None);
        assert_eq!(target.write_target(), None);
        assert!(!target.is_existing_occurrence());
        assert!(target.is_new_property());
    }

    #[test]
    fn new_property_rejects_a_read_only_schema() {
        assert_eq!(
            MetadataDraftTarget::from_new_property(&info(false, None)),
            Err(MetadataDraftTargetError::ReadOnlySchema)
        );
    }

    #[test]
    fn existing_target_validates_against_the_unchanged_fresh_occurrence() {
        let occurrence = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&occurrence).unwrap();

        assert_eq!(target.validate_existing_occurrence(&occurrence), Ok(()));
    }

    #[test]
    fn validation_rejects_an_occurrence_id_mismatch_first() {
        let original = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&original).unwrap();
        let mut fresh = original;
        fresh.id.path = "JPEG-APP1-IFD1".to_owned();

        assert_eq!(
            target.validate_existing_occurrence(&fresh),
            Err(MetadataDraftTargetError::OccurrenceIdMismatch)
        );
    }

    #[test]
    fn validation_rejects_a_schema_id_mismatch() {
        let original = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&original).unwrap();
        let mut fresh = original;
        fresh.tag_info.as_mut().unwrap().id.index = Some(0);

        assert_eq!(
            target.validate_existing_occurrence(&fresh),
            Err(MetadataDraftTargetError::SchemaIdMismatch)
        );
    }

    #[test]
    fn validation_rejects_a_changed_write_target() {
        let original = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&original).unwrap();
        let mut fresh = original;
        fresh.write_target.as_mut().unwrap().group1 = "IFD1".to_owned();

        assert_eq!(
            target.validate_existing_occurrence(&fresh),
            Err(MetadataDraftTargetError::WriteTargetMismatch)
        );
    }

    #[test]
    fn validation_rejects_a_missing_fresh_schema() {
        let original = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&original).unwrap();
        let mut fresh = original;
        fresh.tag_info = None;

        assert_eq!(
            target.validate_existing_occurrence(&fresh),
            Err(MetadataDraftTargetError::UnknownSchema)
        );
    }

    #[test]
    fn validation_rejects_a_fresh_schema_that_became_read_only() {
        let original = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&original).unwrap();
        let mut fresh = original;
        fresh.tag_info.as_mut().unwrap().writable = false;

        assert_eq!(
            target.validate_existing_occurrence(&fresh),
            Err(MetadataDraftTargetError::ReadOnlySchema)
        );
    }

    #[test]
    fn validation_rejects_a_missing_fresh_write_target() {
        let original = occurrence();
        let target = MetadataDraftTarget::from_existing_occurrence(&original).unwrap();
        let mut fresh = original;
        fresh.write_target = None;

        assert_eq!(
            target.validate_existing_occurrence(&fresh),
            Err(MetadataDraftTargetError::MissingWriteTarget)
        );
    }

    #[test]
    fn new_property_cannot_validate_as_an_existing_occurrence() {
        let target = MetadataDraftTarget::from_new_property(&info(true, None)).unwrap();

        assert_eq!(
            target.validate_existing_occurrence(&occurrence()),
            Err(MetadataDraftTargetError::WrongTargetKind)
        );
    }

    #[test]
    fn json_round_trip_preserves_both_exact_variant_shapes_without_a_file_path() {
        let existing = MetadataDraftTarget::from_existing_occurrence(&occurrence()).unwrap();
        let new_property = MetadataDraftTarget::from_new_property(&info(true, Some(0))).unwrap();

        for (target, expected_kind) in [
            (existing, "ExistingOccurrence"),
            (new_property, "NewProperty"),
        ] {
            let json = serde_json::to_value(&target).unwrap();
            assert_eq!(json["kind"], expected_kind);
            assert!(json.get("relative_path").is_none());
            assert_eq!(
                serde_json::from_value::<MetadataDraftTarget>(json).unwrap(),
                target
            );
        }
    }

    #[test]
    fn absent_and_zero_schema_indexes_remain_distinct() {
        let absent = MetadataDraftTarget::from_new_property(&info(true, None)).unwrap();
        let zero = MetadataDraftTarget::from_new_property(&info(true, Some(0))).unwrap();

        assert_ne!(absent, zero);
        assert!(serde_json::to_value(absent).unwrap()["schema_id"]
            .get("index")
            .is_none());
        assert_eq!(serde_json::to_value(zero).unwrap()["schema_id"]["index"], 0);
    }

    #[test]
    fn generated_typescript_union_retains_all_exact_nested_domain_types() {
        use ts_rs::TS;

        let declaration = MetadataDraftTarget::decl();
        assert!(declaration.contains("{ \"kind\": \"ExistingOccurrence\""));
        assert!(declaration.contains("occurrence_id: MetadataOccurrenceId"));
        assert!(declaration.contains("schema_id: SchemaDefinitionId"));
        assert!(declaration.contains("write_target: MetadataWriteTarget"));
        assert!(
            declaration.contains("| { \"kind\": \"NewProperty\", schema_id: SchemaDefinitionId")
        );
    }
}
