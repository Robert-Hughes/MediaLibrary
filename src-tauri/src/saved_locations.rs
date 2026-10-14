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

/// Read exact effective schemas, including pending draft replacements/deletions.
fn effective_value(
    snapshot: &session::MediaLibrarySessionSnapshot,
    path: &str,
    id: SchemaDefinitionId,
) -> Result<Option<MetadataValue>, String> {
    let entry = snapshot
        .metadata
        .iter()
        .find(|entry| entry.relative_path == path)
        .ok_or("The file is not part of the active session")?;
    let session::MediaLibrarySessionMetadataState::Ready { occurrences } = &entry.state else {
        return Err("Authoritative metadata is unavailable for saved-location drafting".into());
    };
    let observed: Vec<_> = occurrences
        .0
        .iter()
        .filter(|occurrence| occurrence.schema_id == id)
        .collect();
    let drafts: Vec<_> = snapshot
        .drafts
        .get(path)
        .into_iter()
        .flatten()
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
    let value = |id| effective_value(snapshot, &item.rel_path, id);
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
        input.gps_altitude = match altitude {
            MetadataValue::Real(v) => Some(v),
            MetadataValue::Integer(v) => Some(v as f64),
            MetadataValue::Rational(v) if v.denominator != 0 => {
                Some(v.numerator as f64 / v.denominator as f64)
            }
            _ => return Err("Invalid GPS altitude".into()),
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
