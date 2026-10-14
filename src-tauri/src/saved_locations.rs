//! Explicit local reverse-geocoding rules. No provider evidence is fabricated.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::draft_edits::{EditIntent, MetadataDraftEdit, SchemaMetadataEditMap};
use crate::metadata_value::{ListKind, MetadataValue};
use crate::{
    geocode::GeocodeRequestItem, known_ids, normalise, session, tag_schema::SchemaDefinitionId,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SavedLocation {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub latitude: f64,
    pub longitude: f64,
    pub radius_m: f64,
    pub location: SavedLocationFields,
}

/// Every field is required; empty strings clear the corresponding member.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SavedLocationFields {
    pub location_name: String,
    pub sublocation: String,
    pub city: String,
    pub province_state: String,
    pub country_name: String,
    pub country_code: String,
    pub world_region: String,
}

pub fn validate_saved_locations(locations: &[SavedLocation]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for place in locations {
        if place.id.is_empty()
            || !place
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            || !ids.insert(&place.id)
        {
            return Err(
                "Saved location IDs must be unique nonempty letters, numbers, '-', '_' or '.'"
                    .into(),
            );
        }
        if place.name.trim().is_empty()
            || !place.latitude.is_finite()
            || !(-90.0..=90.0).contains(&place.latitude)
            || !place.longitude.is_finite()
            || !(-180.0..=180.0).contains(&place.longitude)
            || !place.radius_m.is_finite()
            || place.radius_m <= 0.0
        {
            return Err(format!(
                "Saved location '{}' has an invalid name, centre or radius",
                place.id
            ));
        }
        let code = &place.location.country_code;
        if !code.is_empty() && (code.len() != 2 || !code.bytes().all(|c| c.is_ascii_uppercase())) {
            return Err(format!(
                "Saved location '{}' CountryCode must be empty or two uppercase letters",
                place.id
            ));
        }
        if place
            .location
            .values()
            .iter()
            .all(|(_, value)| value.trim().is_empty())
        {
            return Err(format!(
                "Saved location '{}' must contain a descriptive value",
                place.id
            ));
        }
    }
    Ok(())
}

impl SavedLocationFields {
    fn values(&self) -> [(&str, &str); 7] {
        [
            ("LocationName", &self.location_name),
            ("Sublocation", &self.sublocation),
            ("City", &self.city),
            ("ProvinceState", &self.province_state),
            ("CountryName", &self.country_name),
            ("CountryCode", &self.country_code),
            ("WorldRegion", &self.world_region),
        ]
    }
}

pub fn matching_location(
    locations: &[SavedLocation],
    lat: f64,
    lon: f64,
) -> Result<Option<&SavedLocation>, String> {
    if !lat.is_finite()
        || !lon.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
    {
        return Err("Invalid GPS coordinates".into());
    }
    let mut matches: Vec<_> = locations
        .iter()
        .filter(|place| {
            place.enabled
                && crate::geocode_cache::haversine_meters(lat, lon, place.latitude, place.longitude)
                    <= place.radius_m
        })
        .collect();
    matches.sort_by(|a, b| a.radius_m.total_cmp(&b.radius_m));
    if matches.first().is_some_and(|first| {
        matches
            .iter()
            .skip(1)
            .any(|other| other.radius_m == first.radius_m && other.location != first.location)
    }) {
        return Err("Conflicting saved locations have the same matching radius".into());
    }
    Ok(matches.first().copied())
}

/// Owned location-only input, safe to process after releasing the session lock.
#[derive(Debug)]
pub(crate) struct SavedLocationMetadata {
    occurrences: crate::metadata_occurrence::MetadataOccurrences,
    drafts: Vec<crate::draft_edits::MetadataTargetDraftEntry>,
}

fn is_saved_location_input(id: &SchemaDefinitionId) -> bool {
    crate::session_commands::is_normalise_schema(id, &[normalise::NormaliseGroup::Location])
        || id == &known_ids::gps_altitude()
        || id == &known_ids::gps_altitude_ref()
}

/// Scan session rows once, copying only requested files and relevant schemas.
pub(crate) fn capture_saved_location_metadata(
    snapshot: &session::MediaLibrarySessionSnapshot,
    paths: &HashSet<&str>,
) -> BTreeMap<String, Result<SavedLocationMetadata, String>> {
    let mut inputs: BTreeMap<_, _> = paths
        .iter()
        .map(|path| {
            (
                (*path).to_owned(),
                Err("The file is not part of the active session".into()),
            )
        })
        .collect();
    for entry in &snapshot.metadata {
        if !paths.contains(entry.relative_path.as_str()) {
            continue;
        }
        let input = match &entry.state {
            session::MediaLibrarySessionMetadataState::Ready { occurrences } => {
                Ok(SavedLocationMetadata {
                    occurrences: crate::metadata_occurrence::MetadataOccurrences(
                        occurrences
                            .0
                            .iter()
                            .filter(|occurrence| is_saved_location_input(&occurrence.schema_id))
                            .cloned()
                            .collect(),
                    ),
                    drafts: snapshot
                        .drafts
                        .get(&entry.relative_path)
                        .into_iter()
                        .flatten()
                        .filter(|entry| is_saved_location_input(entry.target.schema_id()))
                        .cloned()
                        .collect(),
                })
            }
            _ => Err("Authoritative metadata is unavailable for saved-location drafting".into()),
        };
        inputs.insert(entry.relative_path.clone(), input);
    }
    inputs
}

/// Read exact effective schemas, including pending draft replacements/deletions.
fn effective_value(
    input: &SavedLocationMetadata,
    id: SchemaDefinitionId,
) -> Result<Option<MetadataValue>, String> {
    let observed: Vec<_> = input
        .occurrences
        .0
        .iter()
        .filter(|occurrence| occurrence.schema_id == id)
        .collect();
    let drafts: Vec<_> = input
        .drafts
        .iter()
        .filter(|entry| entry.target.schema_id() == &id)
        .collect();
    if observed.len() > 1 || drafts.len() > 1 {
        return Err("Ambiguous metadata schema in saved-location input".into());
    }
    if let Some(entry) = drafts.first() {
        return match entry.edit.intent {
            EditIntent::Set => Ok(entry.edit.value.clone()),
            EditIntent::Delete => Ok(None),
            _ => Err("Resolve pending list edits before saved-location geocoding".into()),
        };
    }
    Ok(observed.first().map(|occurrence| occurrence.value.clone()))
}

pub fn compose_saved_location_edits(
    place: &SavedLocation,
    input: &normalise::LocationInput,
    lat: f64,
    lon: f64,
) -> Result<SchemaMetadataEditMap, String> {
    let mut fields = match &input.location_created {
        None => BTreeMap::new(),
        Some(MetadataValue::List { items, .. }) if items.is_empty() => BTreeMap::new(),
        Some(MetadataValue::List { items, .. }) => match items.as_slice() {
            [MetadataValue::Struct(fields)] => fields.clone(),
            _ => {
                return Err(
                    "Resolve ambiguous LocationCreated before saved-location geocoding".into(),
                )
            }
        },
        _ => return Err("Resolve invalid LocationCreated before saved-location geocoding".into()),
    };
    for (key, value) in place.location.values() {
        fields.remove(key);
        let value = normalise::collapse_whitespace_single_line(value);
        if !value.is_empty() {
            fields.insert(
                key.into(),
                if key == "LocationName" {
                    MetadataValue::LangAlt(BTreeMap::from([("x-default".into(), value)]))
                } else {
                    MetadataValue::Text(value)
                },
            );
        }
    }
    fields.insert(
        "LocationId".into(),
        MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Text(format!(
                "urn:medialibrary:saved-location:{}",
                place.id
            ))],
        },
    );
    fields.insert("GPSLatitude".into(), MetadataValue::Real(lat));
    fields.insert("GPSLongitude".into(), MetadataValue::Real(lon));
    if let Some(value) = input.gps_altitude {
        fields.insert("GPSAltitude".into(), MetadataValue::Real(value));
    }
    if let Some(value) = input.gps_altitude_ref {
        fields.insert(
            "GPSAltitudeRef".into(),
            MetadataValue::Integer(i64::from(value)),
        );
    }
    let canonical = MetadataValue::List {
        list_kind: ListKind::Bag,
        items: vec![MetadataValue::Struct(fields)],
    };
    let projected = normalise::LocationInput {
        location_created: Some(canonical.clone()),
        ..input.clone()
    };
    let mut edits = normalise::normalise_location(&projected)
        .output
        .map(|output| output.edits)
        .unwrap_or_default();
    // Share apply verification's numeric storage tolerance so a subsequent
    // run does not redraft coordinates rounded by ExifTool.
    let (status, _) = crate::metadata_verification::verify_set_value(
        &known_ids::xmp_location_created(),
        Some(&canonical),
        input.location_created.as_ref(),
        None,
    );
    if !matches!(status.as_str(), "Match" | "Coerced") {
        edits.insert(
            known_ids::xmp_location_created(),
            MetadataDraftEdit {
                intent: EditIntent::Set,
                value: Some(canonical),
            },
        );
    }
    Ok(edits)
}

pub fn plan_saved_location(
    snapshot: &session::MediaLibrarySessionSnapshot,
    item: &GeocodeRequestItem,
    place: &SavedLocation,
) -> Result<SchemaMetadataEditMap, String> {
    let mut captured =
        capture_saved_location_metadata(snapshot, &HashSet::from([item.rel_path.as_str()]));
    let input = captured
        .remove(&item.rel_path)
        .expect("requested file result")?;
    plan_saved_location_from_metadata(&input, item, place)
}

pub(crate) fn plan_saved_location_from_metadata(
    metadata: &SavedLocationMetadata,
    item: &GeocodeRequestItem,
    place: &SavedLocation,
) -> Result<SchemaMetadataEditMap, String> {
    let value = |id| effective_value(metadata, id);
    let text = |id| -> Result<Option<String>, String> {
        Ok(match value(id)? {
            Some(MetadataValue::Text(s)) => Some(s),
            None => None,
            _ => return Err("Invalid location mirror value".into()),
        })
    };
    let mut input = normalise::LocationInput {
        location_created: value(known_ids::xmp_location_created())?,
        location_xmp: text(known_ids::xmp_location())?,
        location_iptc: text(known_ids::iptc_sub_location())?,
        city_xmp: text(known_ids::xmp_city())?,
        city_iptc: text(known_ids::iptc_city())?,
        state_xmp: text(known_ids::xmp_state())?,
        state_iptc: text(known_ids::iptc_province_state())?,
        country_xmp: text(known_ids::xmp_country())?,
        country_iptc: text(known_ids::iptc_country_name())?,
        country_code_xmp: text(known_ids::xmp_country_code())?,
        country_code_iptc: text(known_ids::iptc_country_code())?,
        ..Default::default()
    };
    if let Some(altitude) = value(known_ids::gps_altitude())? {
        // Altitude is optional. Cameras may store an undefined rational,
        // exposed by ExifTool as `undef` and correctly parsed as Unknown.
        // Preserve the source tag and any existing canonical altitude rather
        // than failing an otherwise valid latitude/longitude location update.
        input.gps_altitude = match altitude {
            MetadataValue::Real(v) if v.is_finite() => Some(v),
            MetadataValue::Integer(v) => Some(v as f64),
            MetadataValue::Rational(v) if v.denominator != 0 => {
                Some(v.numerator as f64 / v.denominator as f64)
            }
            _ => None,
        };
    }
    if let Some(MetadataValue::Integer(reference)) = value(known_ids::gps_altitude_ref())? {
        input.gps_altitude_ref = i32::try_from(reference).ok();
    }
    compose_saved_location_edits(
        place,
        &input,
        item.lat.ok_or("Missing latitude")?,
        item.lon.ok_or("Missing longitude")?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_unusable_altitude_does_not_block_saved_location_or_invent_zero() {
        let place = home();
        let item = GeocodeRequestItem {
            rel_path: "example.jpg".into(),
            lat: Some(place.latitude),
            lon: Some(place.longitude),
        };
        let unknown = MetadataValue::Unknown {
            expected: Some(crate::tag_schema::TagKind::Real),
            raw: serde_json::json!("undef"),
            reason: Some("expected finite JSON number or numeric string for real tag".into()),
        };
        for altitude in [
            unknown,
            MetadataValue::Null,
            MetadataValue::Real(f64::INFINITY),
            MetadataValue::Rational(crate::metadata_value::RationalValue {
                numerator: 0,
                denominator: 0,
            }),
        ] {
            for previous_altitude in [None, Some(42.0)] {
                let mut occurrences = vec![occurrence(known_ids::gps_altitude(), altitude.clone())];
                if let Some(previous) = previous_altitude {
                    occurrences.push(occurrence(
                        known_ids::xmp_location_created(),
                        MetadataValue::List {
                            list_kind: ListKind::Bag,
                            items: vec![MetadataValue::Struct(BTreeMap::from([(
                                "GPSAltitude".into(),
                                MetadataValue::Real(previous),
                            )]))],
                        },
                    ));
                }
                let metadata = SavedLocationMetadata {
                    occurrences: crate::metadata_occurrence::MetadataOccurrences(occurrences),
                    drafts: Vec::new(),
                };
                let edits = plan_saved_location_from_metadata(&metadata, &item, &place).unwrap();
                assert!(edits.keys().all(|id| id.table != "GPS::Main"));
                let Some(MetadataValue::List { items, .. }) =
                    &edits[&known_ids::xmp_location_created()].value
                else {
                    panic!()
                };
                let MetadataValue::Struct(fields) = &items[0] else {
                    panic!()
                };
                assert_eq!(
                    fields.get("GPSAltitude"),
                    previous_altitude.map(MetadataValue::Real).as_ref()
                );
                assert_eq!(fields["GPSLatitude"], MetadataValue::Real(place.latitude));
                assert_eq!(
                    fields["Sublocation"],
                    MetadataValue::Text("Example Place".into())
                );
            }
        }
        for (altitude, expected) in [
            (MetadataValue::Integer(12), 12.0),
            (MetadataValue::Real(12.5), 12.5),
            (
                MetadataValue::Rational(crate::metadata_value::RationalValue {
                    numerator: 25,
                    denominator: 2,
                }),
                12.5,
            ),
        ] {
            let metadata = SavedLocationMetadata {
                occurrences: crate::metadata_occurrence::MetadataOccurrences(vec![occurrence(
                    known_ids::gps_altitude(),
                    altitude,
                )]),
                drafts: Vec::new(),
            };
            let edits = plan_saved_location_from_metadata(&metadata, &item, &place).unwrap();
            let Some(MetadataValue::List { items, .. }) =
                &edits[&known_ids::xmp_location_created()].value
            else {
                panic!()
            };
            let MetadataValue::Struct(fields) = &items[0] else {
                panic!()
            };
            assert_eq!(fields["GPSAltitude"], MetadataValue::Real(expected));
        }
    }

    fn occurrence(
        id: SchemaDefinitionId,
        value: MetadataValue,
    ) -> crate::metadata_occurrence::MetadataOccurrence {
        crate::metadata_occurrence::MetadataOccurrence {
            id: crate::metadata_occurrence::MetadataOccurrenceId {
                document: None,
                path: "Test".into(),
                runtime_tag_id: id.tag_id.clone(),
                tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                    table: id.table.clone(),
                    tag_id: id.tag_id.clone(),
                    index: id.index,
                },
                copy: 0,
            },
            schema_id: id,
            value,
            observed_selector: None,
            write_target: None,
        }
    }

    #[test]
    fn captured_location_input_excludes_other_files_and_unrelated_metadata() {
        let state = session::MediaLibrarySessionState::new();
        let id = state.begin_open("/test".into()).session_id.unwrap();
        state
            .install_draft_load_result(id, Ok(Default::default()))
            .unwrap();
        state.mark_loaded(id, "/test").unwrap();
        state
            .add_files(
                id,
                ["selected.jpg", "unselected.jpg", "loading.jpg"]
                    .into_iter()
                    .map(|name| crate::scanner::FileInfo {
                        relative_path: name.into(),
                        filename: name.into(),
                        media_kind: crate::scanner::MediaKind::Image,
                        date_modified: None,
                        date_created: None,
                    })
                    .collect(),
            )
            .unwrap();
        state
            .commit_metadata_results(
                id,
                vec![
                    crate::scanner::FileMetadata {
                        relative_path: "selected.jpg".into(),
                        occurrences: crate::metadata_occurrence::MetadataOccurrences(vec![
                            occurrence(
                                known_ids::xmp_city(),
                                MetadataValue::Text("Original city".into()),
                            ),
                            occurrence(known_ids::gps_altitude(), MetadataValue::Real(15.0)),
                            occurrence(
                                known_ids::mlib_reverse_geocode_json_v2(),
                                MetadataValue::Text(
                                    "unrelated large provider payload".repeat(10000),
                                ),
                            ),
                        ]),
                    },
                    crate::scanner::FileMetadata {
                        relative_path: "unselected.jpg".into(),
                        occurrences: crate::metadata_occurrence::MetadataOccurrences(vec![
                            occurrence(
                                known_ids::xmp_city(),
                                MetadataValue::Text("Other city".into()),
                            ),
                        ]),
                    },
                ],
            )
            .unwrap();
        let registry = crate::tag_schema::get_registry().unwrap();
        let target = crate::metadata_draft_target::MetadataDraftTarget::from_new_property(
            registry.lookup(&known_ids::xmp_city()).unwrap(),
        )
        .unwrap();
        state
            .commit_draft_row(
                id,
                "selected.jpg".into(),
                vec![crate::draft_edits::MetadataTargetDraftEntry {
                    target,
                    edit: MetadataDraftEdit {
                        intent: EditIntent::Set,
                        value: Some(MetadataValue::Text("Pending city".into())),
                    },
                }],
            )
            .unwrap();
        let captured = state.inspect(|snapshot| {
            capture_saved_location_metadata(
                snapshot,
                &HashSet::from(["selected.jpg", "loading.jpg", "missing.jpg"]),
            )
        });
        assert_eq!(captured.len(), 3);
        assert!(!captured.contains_key("unselected.jpg"));
        assert!(captured["loading.jpg"].is_err());
        assert!(captured["missing.jpg"].is_err());
        let input = captured["selected.jpg"].as_ref().unwrap();
        assert_eq!(input.occurrences.0.len(), 2);
        assert_eq!(input.drafts.len(), 1);
        assert_eq!(
            effective_value(input, known_ids::xmp_city()).unwrap(),
            Some(MetadataValue::Text("Pending city".into()))
        );
        assert!(
            effective_value(input, known_ids::mlib_reverse_geocode_json_v2())
                .unwrap()
                .is_none()
        );
        // The copied input remains valid after the authoritative session retires.
        state.begin_close(id).unwrap();
        state.finish_close(id).unwrap();
        assert_eq!(
            effective_value(input, known_ids::gps_altitude()).unwrap(),
            Some(MetadataValue::Real(15.0))
        );
    }

    fn home() -> SavedLocation {
        SavedLocation {
            id: "example-place".into(),
            name: "Home".into(),
            enabled: true,
            latitude: 0.123456789012345,
            longitude: 0.234567890123456,
            radius_m: 20.0,
            location: SavedLocationFields {
                location_name: "Example Place".into(),
                sublocation: "Example Place".into(),
                city: "Example City".into(),
                province_state: "England".into(),
                country_name: "United Kingdom".into(),
                country_code: "GB".into(),
                world_region: "Europe".into(),
            },
        }
    }

    #[test]
    fn settings_roundtrip_and_required_non_null_fields() {
        let dir = tempfile::tempdir().unwrap();
        let settings = crate::settings::Settings {
            saved_locations: vec![home()],
            ..Default::default()
        };
        crate::settings::save_settings(dir.path(), &settings).unwrap();
        assert_eq!(
            crate::settings::load_settings(dir.path()).unwrap(),
            settings
        );
        assert!(serde_json::from_str::<crate::settings::Settings>("{}")
            .unwrap()
            .saved_locations
            .is_empty());
        for invalid in [serde_json::Value::Null, serde_json::json!(12)] {
            let mut json = serde_json::to_value(home()).unwrap();
            json["location"]["City"] = invalid;
            assert!(serde_json::from_value::<SavedLocation>(json).is_err());
        }
        let mut json = serde_json::to_value(home()).unwrap();
        json["location"].as_object_mut().unwrap().remove("City");
        assert!(serde_json::from_value::<SavedLocation>(json).is_err());
    }

    #[test]
    fn validation_and_circle_matching() {
        let home = home();
        assert!(
            matching_location(std::slice::from_ref(&home), home.latitude, home.longitude)
                .unwrap()
                .is_some()
        );
        assert!(matching_location(
            std::slice::from_ref(&home),
            home.latitude + 0.001,
            home.longitude
        )
        .unwrap()
        .is_none());
        assert!(matching_location(&[], f64::NAN, 0.0).is_err());
        for radius in [0.0, -1.0, f64::INFINITY] {
            let mut bad = home.clone();
            bad.radius_m = radius;
            assert!(validate_saved_locations(&[bad]).is_err());
        }
        assert!(validate_saved_locations(&[home.clone(), home.clone()]).is_err());
        let mut disabled = home.clone();
        disabled.enabled = false;
        assert!(
            matching_location(&[disabled], home.latitude, home.longitude)
                .unwrap()
                .is_none()
        );
        let mut bigger = home.clone();
        bigger.id = "larger".into();
        bigger.radius_m = 50.0;
        bigger.location.city = "Other".into();
        let places = [bigger, home.clone()];
        assert_eq!(
            matching_location(&places, home.latitude, home.longitude)
                .unwrap()
                .unwrap()
                .id,
            home.id
        );
        let mut conflict = home.clone();
        conflict.id = "conflict".into();
        conflict.location.city = "Other".into();
        assert!(matching_location(
            &[home.clone(), home.clone(), conflict],
            home.latitude,
            home.longitude
        )
        .is_err());
    }

    #[test]
    fn canonical_and_mirrors_are_final_preserve_gps_and_clear_empty_fields() {
        let mut place = home();
        place.location.city.clear();
        let previous = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Struct(BTreeMap::from([
                ("GPSAltitude".into(), MetadataValue::Real(15.0)),
                ("GPSAltitudeRef".into(), MetadataValue::Integer(0)),
                (
                    "LocationId".into(),
                    MetadataValue::List {
                        list_kind: ListKind::Bag,
                        items: vec![MetadataValue::Text(
                            "https://www.openstreetmap.org/way/123456".into(),
                        )],
                    },
                ),
            ]))],
        };
        let input = normalise::LocationInput {
            location_created: Some(previous),
            city_xmp: Some("Wrong".into()),
            city_iptc: Some("Wrong".into()),
            geocode_json: Some("old raw evidence".into()),
            ..Default::default()
        };
        let edits = compose_saved_location_edits(&place, &input, 0.12346, 0.23457).unwrap();
        assert!(edits.keys().all(|id| id.table != "UserDefined::mlib"));
        assert_eq!(edits[&known_ids::xmp_city()].intent, EditIntent::Delete);
        assert_eq!(edits[&known_ids::iptc_city()].intent, EditIntent::Delete);
        let canonical = edits[&known_ids::xmp_location_created()]
            .value
            .clone()
            .unwrap();
        let MetadataValue::List { items, .. } = &canonical else {
            panic!()
        };
        let MetadataValue::Struct(fields) = &items[0] else {
            panic!()
        };
        assert_eq!(fields["GPSLatitude"], MetadataValue::Real(0.12346));
        assert_eq!(fields["GPSAltitude"], MetadataValue::Real(15.0));
        assert!(!fields.contains_key("City"));
        let final_input = normalise::LocationInput {
            location_created: Some(canonical),
            location_xmp: Some("Example Place".into()),
            location_iptc: Some("Example Place".into()),
            state_xmp: Some("England".into()),
            state_iptc: Some("England".into()),
            country_xmp: Some("United Kingdom".into()),
            country_iptc: Some("United Kingdom".into()),
            country_code_xmp: Some("GB".into()),
            country_code_iptc: Some("GB ".into()),
            ..Default::default()
        };
        assert!(normalise::normalise_location(&final_input).output.is_none());
        assert!(
            compose_saved_location_edits(&place, &final_input, 0.12346, 0.23457)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn repeatable_location_is_not_silently_discarded_and_projection_truncates() {
        let place = home();
        let input = normalise::LocationInput {
            location_created: Some(MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![
                    MetadataValue::Struct(Default::default()),
                    MetadataValue::Struct(Default::default()),
                ],
            }),
            ..Default::default()
        };
        assert!(
            compose_saved_location_edits(&place, &input, place.latitude, place.longitude).is_err()
        );
        let mut place = place;
        place.location.location_name =
            "A very long full location name which exceeds the legacy limit".into();
        let edits = compose_saved_location_edits(
            &place,
            &Default::default(),
            place.latitude,
            place.longitude,
        )
        .unwrap();
        let Some(MetadataValue::Text(short)) = &edits[&known_ids::iptc_sub_location()].value else {
            panic!()
        };
        assert!(short.len() <= 32);
        assert_eq!(
            edits[&known_ids::xmp_location()].value,
            Some(MetadataValue::Text(place.location.location_name))
        );
    }
}
