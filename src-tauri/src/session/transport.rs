use super::{MediaLibrarySessionMetadataChanged, MediaLibrarySessionMetadataState};
use crate::metadata_occurrence::{
    MetadataObservedSelector, MetadataOccurrenceId, MetadataWriteTarget,
};
#[cfg(test)]
use crate::metadata_occurrence::{MetadataOccurrence, MetadataOccurrences};
use crate::metadata_value::MetadataValue;
use crate::tag_schema::SchemaDefinitionId;
use serde::Serialize;
use std::collections::HashMap;

pub const METADATA_DICTIONARY_FORMAT: &str = "media-library-metadata-dictionary-v2";

/// Lossless per-event dictionary representation of one metadata session delta.
///
/// This is a wire projection only. The authoritative session continues to
/// store ordinary `MetadataOccurrence` values. Each ready occurrence is
/// represented by five dictionary indexes in this order:
///
/// 0. runtime occurrence ID;
/// 1. schema definition ID;
/// 2. metadata value;
/// 3. observed selector (or null);
/// 4. write target (or null).
#[derive(Debug, Serialize)]
pub struct MetadataDictionaryDelta {
    pub format: &'static str,
    pub session_id: u64,
    pub revision: u64,
    pub dictionaries: MetadataOccurrenceDictionaries,
    pub entries: Vec<MetadataDictionaryFileEntry>,
}

#[derive(Debug, Serialize)]
pub struct MetadataOccurrenceDictionaries {
    pub ids: Vec<MetadataOccurrenceId>,
    pub schema_ids: Vec<SchemaDefinitionId>,
    pub values: Vec<MetadataValue>,
    pub observed_selectors: Vec<Option<MetadataObservedSelector>>,
    pub write_targets: Vec<Option<MetadataWriteTarget>>,
}

#[derive(Debug, Serialize)]
pub struct MetadataDictionaryFileEntry {
    pub relative_path: String,
    pub state: MetadataDictionaryState,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum MetadataDictionaryState {
    Loading,
    Ready {
        /// Each item is [id, schema_id, value, observed_selector, write_target].
        occurrences: Vec<[u32; 5]>,
    },
    Failed {
        error: String,
    },
}

struct JsonInterner<T> {
    entries: Vec<T>,
    indexes: HashMap<String, u32>,
}

impl<T> Default for JsonInterner<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            indexes: HashMap::new(),
        }
    }
}

impl<T: Serialize> JsonInterner<T> {
    fn intern(&mut self, value: T) -> Result<u32, String> {
        let key = serde_json::to_string(&value)
            .map_err(|error| format!("failed to serialize metadata dictionary key: {error}"))?;
        if let Some(index) = self.indexes.get(&key) {
            return Ok(*index);
        }

        let index = u32::try_from(self.entries.len())
            .map_err(|_| "metadata dictionary contains more than u32::MAX entries".to_owned())?;
        self.entries.push(value);
        self.indexes.insert(key, index);
        Ok(index)
    }
}

impl MetadataDictionaryDelta {
    pub fn from_delta(delta: MediaLibrarySessionMetadataChanged) -> Result<Self, String> {
        let mut ids = JsonInterner::default();
        let mut schema_ids = JsonInterner::default();
        let mut values = JsonInterner::default();
        let mut observed_selectors = JsonInterner::default();
        let mut write_targets = JsonInterner::default();

        let mut entries = Vec::with_capacity(delta.entries.len());
        for entry in delta.entries {
            let state = match entry.state {
                MediaLibrarySessionMetadataState::Loading => MetadataDictionaryState::Loading,
                MediaLibrarySessionMetadataState::Failed { error } => {
                    MetadataDictionaryState::Failed { error }
                }
                MediaLibrarySessionMetadataState::Ready { occurrences } => {
                    let mut compact = Vec::with_capacity(occurrences.len());
                    for occurrence in occurrences {
                        compact.push([
                            ids.intern(occurrence.id)?,
                            schema_ids.intern(occurrence.schema_id)?,
                            values.intern(occurrence.value)?,
                            observed_selectors.intern(occurrence.observed_selector)?,
                            write_targets.intern(occurrence.write_target)?,
                        ]);
                    }
                    MetadataDictionaryState::Ready {
                        occurrences: compact,
                    }
                }
            };
            entries.push(MetadataDictionaryFileEntry {
                relative_path: entry.relative_path,
                state,
            });
        }

        Ok(Self {
            format: METADATA_DICTIONARY_FORMAT,
            session_id: delta.session_id,
            revision: delta.revision,
            dictionaries: MetadataOccurrenceDictionaries {
                ids: ids.entries,
                schema_ids: schema_ids.entries,
                values: values.entries,
                observed_selectors: observed_selectors.entries,
                write_targets: write_targets.entries,
            },
            entries,
        })
    }

    #[cfg(test)]
    fn reconstruct(self) -> Result<MediaLibrarySessionMetadataChanged, String> {
        use super::MediaLibrarySessionFileMetadata;

        let dictionaries = self.dictionaries;
        let mut entries = Vec::with_capacity(self.entries.len());

        for entry in self.entries {
            let state = match entry.state {
                MetadataDictionaryState::Loading => MediaLibrarySessionMetadataState::Loading,
                MetadataDictionaryState::Failed { error } => {
                    MediaLibrarySessionMetadataState::Failed { error }
                }
                MetadataDictionaryState::Ready { occurrences } => {
                    let mut reconstructed = Vec::with_capacity(occurrences.len());
                    for indexes in occurrences {
                        let lookup =
                            |len: usize, index: u32, name: &str| -> Result<usize, String> {
                                let index = usize::try_from(index).map_err(|_| {
                                    format!("{name} dictionary index does not fit usize")
                                })?;
                                if index >= len {
                                    return Err(format!(
                                        "{name} dictionary index {index} is out of range"
                                    ));
                                }
                                Ok(index)
                            };

                        let id_index = lookup(dictionaries.ids.len(), indexes[0], "id")?;
                        let schema_index =
                            lookup(dictionaries.schema_ids.len(), indexes[1], "schema_id")?;
                        let value_index = lookup(dictionaries.values.len(), indexes[2], "value")?;
                        let observed_index = lookup(
                            dictionaries.observed_selectors.len(),
                            indexes[3],
                            "observed_selector",
                        )?;
                        let write_target_index =
                            lookup(dictionaries.write_targets.len(), indexes[4], "write_target")?;

                        reconstructed.push(MetadataOccurrence::try_new(
                            dictionaries.ids[id_index].clone(),
                            dictionaries.schema_ids[schema_index].clone(),
                            dictionaries.values[value_index].clone(),
                            dictionaries.observed_selectors[observed_index].clone(),
                            dictionaries.write_targets[write_target_index].clone(),
                        )?);
                    }
                    MediaLibrarySessionMetadataState::Ready {
                        occurrences: MetadataOccurrences(reconstructed),
                    }
                }
            };
            entries.push(MediaLibrarySessionFileMetadata {
                relative_path: entry.relative_path,
                state,
            });
        }

        Ok(MediaLibrarySessionMetadataChanged {
            session_id: self.session_id,
            revision: self.revision,
            entries,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::RuntimeTagIdScope;

    fn occurrence(
        path: &str,
        runtime_tag_id: &str,
        copy: u32,
        value: &str,
        with_optional_fields: bool,
    ) -> MetadataOccurrence {
        let schema_id = SchemaDefinitionId {
            table: "XMP::dc".to_owned(),
            tag_id: "description".to_owned(),
            index: None,
        };
        let id = MetadataOccurrenceId {
            document: None,
            path: path.to_owned(),
            runtime_tag_id: runtime_tag_id.to_owned(),
            tag_id_scope: RuntimeTagIdScope {
                table: "XMP::dc".to_owned(),
                tag_id: runtime_tag_id.to_owned(),
                index: None,
            },
            copy,
        };
        let observed_selector = with_optional_fields.then(|| MetadataObservedSelector {
            group1: "XMP-dc".to_owned(),
            group7: format!("ID-{runtime_tag_id}"),
            tag_name: "Description".to_owned(),
        });
        let write_target = observed_selector
            .as_ref()
            .map(|selector| MetadataWriteTarget {
                group1: selector.group1.clone(),
                group7: selector.group7.clone(),
                tag_name: selector.tag_name.clone(),
            });
        MetadataOccurrence::try_new(
            id,
            schema_id,
            MetadataValue::Text(value.to_owned()),
            observed_selector,
            write_target,
        )
        .unwrap()
    }

    fn delta(occurrences: Vec<MetadataOccurrence>) -> MediaLibrarySessionMetadataChanged {
        use crate::session::MediaLibrarySessionFileMetadata;
        MediaLibrarySessionMetadataChanged {
            session_id: 7,
            revision: 12,
            entries: vec![MediaLibrarySessionFileMetadata {
                relative_path: "IMG_0001.jpg".to_owned(),
                state: MediaLibrarySessionMetadataState::Ready {
                    occurrences: MetadataOccurrences(occurrences),
                },
            }],
        }
    }

    #[test]
    fn dictionary_transport_round_trip_preserves_complete_occurrences() {
        let original = delta(vec![
            occurrence("XMP", "description", 0, "one", true),
            occurrence("XMP-alt", "description-alt", 1, "two", true),
        ]);
        let compact = MetadataDictionaryDelta::from_delta(original.clone()).unwrap();
        let reconstructed = compact.reconstruct().unwrap();
        assert_eq!(reconstructed.session_id, original.session_id);
        assert_eq!(reconstructed.revision, original.revision);
        assert_eq!(reconstructed.entries, original.entries);
    }

    #[test]
    fn dictionary_transport_preserves_null_optional_fields() {
        let original = delta(vec![occurrence("UNKNOWN", "unknown", 0, "value", false)]);
        let compact = MetadataDictionaryDelta::from_delta(original.clone()).unwrap();
        assert_eq!(compact.dictionaries.observed_selectors, vec![None]);
        assert_eq!(compact.dictionaries.write_targets, vec![None]);
        assert_eq!(compact.reconstruct().unwrap().entries, original.entries);
    }

    #[test]
    fn dictionary_transport_interns_shared_entries_without_merging_occurrences() {
        let first = occurrence("XMP-a", "description-a", 0, "same", true);
        let mut second = occurrence("XMP-b", "description-b", 1, "same", true);
        second.schema_id = first.schema_id.clone();

        let original = delta(vec![first.clone(), second.clone()]);
        let compact = MetadataDictionaryDelta::from_delta(original.clone()).unwrap();

        assert_eq!(compact.dictionaries.schema_ids.len(), 1);
        assert_eq!(compact.dictionaries.values.len(), 1);
        assert_eq!(compact.dictionaries.ids.len(), 2);
        let MetadataDictionaryState::Ready { occurrences } = &compact.entries[0].state else {
            panic!("expected ready metadata");
        };
        assert_eq!(occurrences.len(), 2);
        assert_ne!(occurrences[0][0], occurrences[1][0]);
        assert_eq!(occurrences[0][1], occurrences[1][1]);
        assert_eq!(occurrences[0][2], occurrences[1][2]);
        assert_eq!(compact.reconstruct().unwrap().entries, original.entries);
    }

    #[test]
    fn equal_values_with_different_exact_ids_remain_distinct_occurrences() {
        let first = occurrence("XMP-a", "description-a", 0, "same", true);
        let second = occurrence("XMP-b", "description-b", 1, "same", true);
        let original = delta(vec![first.clone(), second.clone()]);
        let compact = MetadataDictionaryDelta::from_delta(original).unwrap();
        assert_eq!(compact.dictionaries.values.len(), 1);
        assert_eq!(compact.dictionaries.ids.len(), 2);

        let reconstructed = compact.reconstruct().unwrap();
        let MediaLibrarySessionMetadataState::Ready { occurrences } =
            &reconstructed.entries[0].state
        else {
            panic!("expected ready metadata");
        };
        assert_eq!(occurrences.len(), 2);
        assert_eq!(occurrences.0[0].id, first.id);
        assert_eq!(occurrences.0[1].id, second.id);
    }
}
