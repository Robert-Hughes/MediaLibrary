//! Group G — canonical IPTC LocationCreated and legacy mirror projection.
//!
//! Exactly one LocationCreated structure is authoritative. Its five
//! overlapping members project to the flat XMP/IIM pairs, and an absent member
//! removes both flat fields. Multiple structures are deliberately left for
//! manual resolution: choosing one would discard a legitimate location.
//!
//! When LocationCreated is absent, the five flat pairs seed it. Each pair is
//! treated independently and XMP wins a disagreement. CountryCode is
//! uppercased semantically; the legacy IIM projection retains its fixed-width
//! padding. No AI or place-name normalization is used.

use super::{
    collapse_whitespace_single_line, text_edit, truncate_at_word, AiCallUsage, GroupOutput,
    LocationAiResult, LocationContext, LocationInput, LocationResolvePrompt, NormaliseAiClient,
    NormaliseAiError,
};
use crate::country_code::{
    canonical_country_code, canonical_iptc_country_code_readback, iptc_country_code_projection,
    xmp_country_code_projection,
};
use crate::draft_edits::{EditIntent, MetadataDraftEdit, SchemaMetadataEditMap};
use crate::known_ids;
use crate::metadata_value::{ListKind, MetadataValue};
use crate::tag_schema::SchemaDefinitionId;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet};

const IPTC_SUB_LOCATION_LIMIT: usize = 32;

fn canonicalise_location_text(s: &str) -> String {
    collapse_whitespace_single_line(s)
}

fn canonicalise_country_code(s: &str) -> String {
    canonical_country_code(s)
}

fn canonicalise_iptc_country_code(s: &str) -> String {
    canonical_iptc_country_code_readback(s)
}

struct PairResult {
    xmp_target: Option<String>,
    iptc_target: Option<String>,
    conflict: bool,
}

fn identity_projection(s: &str) -> String {
    s.to_string()
}

fn iptc_sub_location_projection(s: &str) -> String {
    truncate_at_word(s, IPTC_SUB_LOCATION_LIMIT)
}

#[derive(Debug, Clone, Default)]
struct CanonicalLocation {
    location_name: Option<String>,
    sublocation: Option<String>,
    city: Option<String>,
    state: Option<String>,
    country: Option<String>,
    country_code: Option<String>,
}

enum StructuredLocation {
    Absent,
    One(CanonicalLocation),
    Ambiguous,
}

fn struct_text(fields: &BTreeMap<String, MetadataValue>, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(MetadataValue::Text(value)) => {
            let value = canonicalise_location_text(value);
            (!value.is_empty()).then_some(value)
        }
        _ => None,
    }
}

fn struct_lang_alt(fields: &BTreeMap<String, MetadataValue>, key: &str) -> Option<String> {
    let MetadataValue::LangAlt(values) = fields.get(key)? else {
        return None;
    };
    values
        .get("x-default")
        .or_else(|| values.values().next())
        .map(|value| canonicalise_location_text(value))
        .filter(|value| !value.is_empty())
}

fn read_location_created(value: Option<&MetadataValue>) -> StructuredLocation {
    let Some(value) = value else {
        return StructuredLocation::Absent;
    };
    let MetadataValue::List { items, .. } = value else {
        return StructuredLocation::Ambiguous;
    };
    if items.is_empty() {
        return StructuredLocation::Absent;
    }
    let [MetadataValue::Struct(fields)] = items.as_slice() else {
        return StructuredLocation::Ambiguous;
    };
    StructuredLocation::One(CanonicalLocation {
        location_name: struct_lang_alt(fields, "LocationName"),
        sublocation: struct_text(fields, "Sublocation"),
        city: struct_text(fields, "City"),
        state: struct_text(fields, "ProvinceState"),
        country: struct_text(fields, "CountryName"),
        country_code: struct_text(fields, "CountryCode")
            .map(|value| canonicalise_country_code(&value))
            .filter(|value| !value.is_empty()),
    })
}

fn canonical_from_legacy(input: &LocationInput) -> CanonicalLocation {
    let pick =
        |xmp: Option<&str>, ipt: Option<&str>, canon: fn(&str) -> String| -> Option<String> {
            let xc = xmp.map(canon).filter(|s| !s.is_empty());
            let ic = ipt.map(canon).filter(|s| !s.is_empty());
            match (xc, ic) {
                (None, None) => None,
                (Some(v), None) | (None, Some(v)) => Some(v),
                (Some(x), Some(_)) => Some(x),
            }
        };
    CanonicalLocation {
        location_name: None,
        sublocation: pick(
            input.location_xmp.as_deref(),
            input.location_iptc.as_deref(),
            canonicalise_location_text,
        ),
        city: pick(
            input.city_xmp.as_deref(),
            input.city_iptc.as_deref(),
            canonicalise_location_text,
        ),
        state: pick(
            input.state_xmp.as_deref(),
            input.state_iptc.as_deref(),
            canonicalise_location_text,
        ),
        country: pick(
            input.country_xmp.as_deref(),
            input.country_iptc.as_deref(),
            canonicalise_location_text,
        ),
        country_code: pick(
            input.country_code_xmp.as_deref(),
            input.country_code_iptc.as_deref(),
            canonicalise_country_code,
        ),
    }
}

fn location_created_value(location: &CanonicalLocation) -> MetadataValue {
    let mut fields = BTreeMap::new();
    for (key, value) in [
        ("Sublocation", location.sublocation.as_deref()),
        ("City", location.city.as_deref()),
        ("ProvinceState", location.state.as_deref()),
        ("CountryName", location.country.as_deref()),
        ("CountryCode", location.country_code.as_deref()),
    ] {
        if let Some(value) = value {
            fields.insert(key.into(), MetadataValue::Text(value.into()));
        }
    }
    MetadataValue::List {
        list_kind: ListKind::Bag,
        items: vec![MetadataValue::Struct(fields)],
    }
}

fn delete_edit() -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: None,
        intent: EditIntent::Delete,
    }
}

fn project_member(
    edits: &mut SchemaMetadataEditMap,
    key: SchemaDefinitionId,
    current: Option<&str>,
    canonical: Option<&str>,
    projection: fn(&str) -> String,
) {
    match canonical {
        Some(value) => {
            let target = projection(value);
            if current != Some(target.as_str()) {
                edits.insert(key, text_edit(target));
            }
        }
        None if current.is_some() => {
            edits.insert(key, delete_edit());
        }
        None => {}
    }
}

fn process_pair(
    xmp: Option<&str>,
    iptc: Option<&str>,
    xmp_canon: fn(&str) -> String,
    iptc_canon: fn(&str) -> String,
    xmp_projection: fn(&str) -> String,
    iptc_projection: fn(&str) -> String,
) -> PairResult {
    let xc = xmp.map(xmp_canon).filter(|s| !s.is_empty());
    let ic = iptc.map(iptc_canon).filter(|s| !s.is_empty());

    let (canonical, conflict) = match (xc, ic) {
        (None, None) => (None, false),
        (Some(v), None) | (None, Some(v)) => (Some(v), false),
        (Some(x), Some(i)) if x == i => (Some(x), false),
        (Some(x), Some(i)) => {
            let projected = iptc_projection(&x);
            let conflict = i != projected;
            (Some(x), conflict)
        }
    };

    let (xmp_target, iptc_target) = match canonical.as_deref() {
        Some(canonical) => {
            let xmp_target = xmp_projection(canonical);
            let iptc_target = iptc_projection(canonical);
            (
                (xmp != Some(xmp_target.as_str())).then_some(xmp_target),
                (iptc != Some(iptc_target.as_str())).then_some(iptc_target),
            )
        }
        None => (None, None),
    };

    PairResult {
        xmp_target,
        iptc_target,
        conflict,
    }
}

/// Compute the per-pair canonical values for Group G without producing
/// drafts. Used by the dispatcher to pass POST-normalisation location
/// context into Group B / Group C AI prompts.
pub fn derive_location_canonical(input: &LocationInput) -> LocationContext {
    let canonical = match read_location_created(input.location_created.as_ref()) {
        StructuredLocation::One(location) => location,
        StructuredLocation::Absent => canonical_from_legacy(input),
        StructuredLocation::Ambiguous => return LocationContext::default(),
    };
    LocationContext {
        location: canonical.sublocation,
        city: canonical.city,
        state: canonical.state,
        country: canonical.country,
    }
}

#[derive(Debug, Clone, Default)]
pub struct LocationOutcome {
    pub output: Option<GroupOutput>,
    pub n_xmp_iim_conflict: u32,
    pub n_location_created_ambiguous: u32,
    pub ai_fired: bool,
    pub ai_error: Option<NormaliseAiError>,
    pub ai_usage: Option<AiCallUsage>,
    pub canonical: Option<LocationContext>,
}

fn evidence_text(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn evidence_scalar(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(value) if !value.trim().is_empty() => serde_json::to_string(value).ok(),
        JsonValue::Number(_) | JsonValue::Bool(_) => Some(value.to_string()),
        _ => None,
    }
}

fn evidence_string(value: Option<&JsonValue>) -> Option<&str> {
    value
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn push_evidence_section<'a>(
    lines: &mut Vec<String>,
    name: &str,
    entries: impl IntoIterator<Item = (String, &'a JsonValue)>,
) {
    let entries: Vec<_> = entries
        .into_iter()
        .filter_map(|(key, value)| evidence_scalar(value).map(|value| (key, value)))
        .collect();
    if entries.is_empty() {
        return;
    }
    lines.push(format!("{name}:"));
    lines.extend(
        entries
            .into_iter()
            .map(|(key, value)| format!("  {key}: {value}")),
    );
}

fn object_entries<'a>(
    object: Option<&'a JsonMap<String, JsonValue>>,
    keys: &[&str],
) -> Vec<(String, &'a JsonValue)> {
    let Some(object) = object else {
        return Vec::new();
    };
    keys.iter()
        .filter_map(|key| object.get(*key).map(|value| ((*key).into(), value)))
        .collect()
}

fn collect_represented_strings(
    represented: &mut BTreeSet<String>,
    object: Option<&JsonMap<String, JsonValue>>,
) {
    let Some(object) = object else {
        return;
    };
    represented.extend(
        object
            .values()
            .filter_map(JsonValue::as_str)
            .filter_map(|value| {
                let value = value.trim();
                (!value.is_empty()).then(|| value.to_lowercase())
            }),
    );
}

/// Keep the naming and hierarchy evidence used by the resolver while dropping
/// Nominatim transport metadata, coordinates, bounding boxes, licensing and
/// identifiers. Values use JSON scalar quoting inside a compact YAML-like
/// layout so punctuation and non-ASCII names remain unambiguous.
fn compact_location_evidence(
    geocode_raw: Option<&str>,
    json_v2_raw: Option<&str>,
) -> Option<String> {
    let geocode_doc = geocode_raw.and_then(|raw| serde_json::from_str::<JsonValue>(raw).ok());
    let json_v2_doc = json_v2_raw.and_then(|raw| serde_json::from_str::<JsonValue>(raw).ok());
    if geocode_doc.is_none() && json_v2_doc.is_none() {
        return None;
    }

    let geocode = geocode_doc
        .as_ref()
        .and_then(|doc| doc.pointer("/features/0/properties/geocoding"))
        .and_then(JsonValue::as_object);
    let json_v2 = json_v2_doc.as_ref().and_then(JsonValue::as_object);
    let json_address = json_v2
        .and_then(|object| object.get("address"))
        .and_then(JsonValue::as_object);
    let geocode_admin = geocode
        .and_then(|object| object.get("admin"))
        .and_then(JsonValue::as_object);

    let geocode_name = evidence_string(geocode.and_then(|object| object.get("name")));
    let json_v2_name = evidence_string(json_v2.and_then(|object| object.get("name")));
    let names_agree = geocode_name == json_v2_name;

    let mut lines = Vec::new();
    let mut feature = Vec::new();
    for (key, value) in [
        (
            "geocode_type",
            geocode.and_then(|object| object.get("type")),
        ),
        (
            "category",
            json_v2
                .and_then(|object| object.get("category"))
                .or_else(|| geocode.and_then(|object| object.get("osm_key"))),
        ),
        (
            "type",
            json_v2
                .and_then(|object| object.get("type"))
                .or_else(|| geocode.and_then(|object| object.get("osm_value"))),
        ),
        (
            "address_type",
            json_v2.and_then(|object| object.get("addresstype")),
        ),
        (
            "place_rank",
            json_v2.and_then(|object| object.get("place_rank")),
        ),
        (
            "search_importance",
            json_v2.and_then(|object| object.get("importance")),
        ),
    ] {
        if let Some(value) = value {
            feature.push((key.into(), value));
        }
    }
    if names_agree {
        if let Some(value) = json_v2.and_then(|object| object.get("name")) {
            feature.push(("name".into(), value));
        }
    } else {
        if let Some(value) = geocode.and_then(|object| object.get("name")) {
            feature.push(("geocode_name".into(), value));
        }
        if let Some(value) = json_v2.and_then(|object| object.get("name")) {
            feature.push(("jsonv2_name".into(), value));
        }
    }
    push_evidence_section(&mut lines, "feature", feature);

    push_evidence_section(
        &mut lines,
        "geocode_address",
        object_entries(
            geocode,
            &[
                "housenumber",
                "street",
                "locality",
                "district",
                "city",
                "county",
                "state",
                "postcode",
                "country",
            ],
        )
        .into_iter()
        .map(|(key, value)| {
            (
                if key == "housenumber" {
                    "house_number".into()
                } else {
                    key
                },
                value,
            )
        }),
    );

    push_evidence_section(
        &mut lines,
        "jsonv2_address",
        json_address.into_iter().flat_map(|address| {
            address
                .iter()
                .filter(|(key, _)| {
                    *key != "country_code" && !key.to_ascii_uppercase().starts_with("ISO3166")
                })
                .map(|(key, value)| (key.clone(), value))
        }),
    );
    push_evidence_section(
        &mut lines,
        "geocode_admin",
        geocode_admin
            .into_iter()
            .flat_map(|admin| admin.iter().map(|(key, value)| (key.clone(), value))),
    );

    let mut represented = BTreeSet::new();
    collect_represented_strings(&mut represented, geocode);
    collect_represented_strings(&mut represented, json_address);
    collect_represented_strings(&mut represented, geocode_admin);
    if let Some(name) = json_v2_name {
        represented.insert(name.to_lowercase());
    }
    let label = evidence_string(json_v2.and_then(|object| object.get("display_name")))
        .or_else(|| evidence_string(geocode.and_then(|object| object.get("label"))));
    let extras: Vec<_> = label
        .into_iter()
        .flat_map(|label| label.split(','))
        .map(str::trim)
        .filter(|part| !part.is_empty() && !represented.contains(&part.to_lowercase()))
        .collect();
    if !extras.is_empty() {
        lines.push("unclassified_label:".into());
        lines.push(format!(
            "  parts: {}",
            serde_json::to_string(&extras.join(" | ")).unwrap_or_default()
        ));
    }

    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn location_evidence_prompt(input: &LocationInput) -> Option<LocationResolvePrompt> {
    let geocode_json = evidence_text(&input.geocode_json);
    let json_v2 = evidence_text(&input.json_v2);
    compact_location_evidence(geocode_json.as_deref(), json_v2.as_deref())
        .map(|evidence| LocationResolvePrompt { evidence })
}

fn normalise_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| canonicalise_location_text(&value))
        .filter(|value| !value.is_empty())
}

fn raw_json(input: &Option<String>) -> Option<serde_json::Value> {
    serde_json::from_str(input.as_deref()?).ok()
}

fn valid_country_code(value: &str) -> Option<String> {
    let code = canonicalise_country_code(value);
    (code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic())).then_some(code)
}

/// CountryCode is an identifier, not a naming judgement. Copy it only when
/// every response that supplies one agrees; omit it on conflict.
fn deterministic_country_code(input: &LocationInput) -> Option<String> {
    let mut values = Vec::new();
    if let Some(value) = raw_json(&input.geocode_json)
        .and_then(|v| {
            v.pointer("/features/0/properties/geocoding/country_code")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .and_then(|v| valid_country_code(&v))
    {
        values.push(value);
    }
    if let Some(value) = raw_json(&input.json_v2)
        .and_then(|v| {
            v.pointer("/address/country_code")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .and_then(|v| valid_country_code(&v))
    {
        values.push(value);
    }
    values.sort();
    values.dedup();
    (values.len() == 1).then(|| values.remove(0))
}

fn osm_location_id(osm_type: &str, osm_id: u64) -> Option<String> {
    let kind = match osm_type.to_ascii_lowercase().as_str() {
        "n" | "node" => "node",
        "w" | "way" => "way",
        "r" | "relation" => "relation",
        _ => return None,
    };
    Some(format!("https://www.openstreetmap.org/{kind}/{osm_id}"))
}

fn deterministic_location_ids(input: &LocationInput) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(value) = raw_json(&input.geocode_json) {
        if let (Some(osm_type), Some(osm_id)) = (
            value
                .pointer("/features/0/properties/geocoding/osm_type")
                .and_then(serde_json::Value::as_str),
            value
                .pointer("/features/0/properties/geocoding/osm_id")
                .and_then(serde_json::Value::as_u64),
        ) {
            if let Some(id) = osm_location_id(osm_type, osm_id) {
                ids.push(id);
            }
        }
    }
    if let Some(value) = raw_json(&input.json_v2) {
        if let (Some(osm_type), Some(osm_id)) = (
            value.get("osm_type").and_then(serde_json::Value::as_str),
            value.get("osm_id").and_then(serde_json::Value::as_u64),
        ) {
            if let Some(id) = osm_location_id(osm_type, osm_id) {
                ids.push(id);
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn location_created_from_ai(
    input: &LocationInput,
    result: LocationAiResult,
) -> Option<(MetadataValue, LocationContext)> {
    let mut sublocation = normalise_optional_text(result.sublocation);
    let city = normalise_optional_text(result.city);
    let state = normalise_optional_text(result.province_state);
    let country = normalise_optional_text(result.country_name);
    let world_region = normalise_optional_text(result.world_region);
    let mut location_name = normalise_optional_text(result.location_name);
    if location_name
        .as_deref()
        .zip(city.as_deref())
        .is_some_and(|(location_name, city)| location_name.eq_ignore_ascii_case(city))
    {
        location_name = None;
    }
    if sublocation.as_deref().is_some_and(|sublocation| {
        city.as_deref()
            .is_some_and(|city| sublocation.eq_ignore_ascii_case(city))
            || location_name
                .as_deref()
                .is_some_and(|location_name| sublocation.eq_ignore_ascii_case(location_name))
    }) {
        sublocation = None;
    }
    let country_code = deterministic_country_code(input);

    if sublocation.is_none()
        && city.is_none()
        && state.is_none()
        && country.is_none()
        && world_region.is_none()
        && location_name.is_none()
        && country_code.is_none()
    {
        return None;
    }

    let mut fields = BTreeMap::new();
    for (key, value) in [
        ("Sublocation", sublocation.as_deref()),
        ("City", city.as_deref()),
        ("ProvinceState", state.as_deref()),
        ("CountryName", country.as_deref()),
        ("CountryCode", country_code.as_deref()),
        ("WorldRegion", world_region.as_deref()),
    ] {
        if let Some(value) = value {
            fields.insert(key.into(), MetadataValue::Text(value.into()));
        }
    }
    if let Some(value) = location_name {
        fields.insert(
            "LocationName".into(),
            MetadataValue::LangAlt(BTreeMap::from([("x-default".into(), value)])),
        );
    }
    let location_ids = deterministic_location_ids(input);
    if !location_ids.is_empty() {
        fields.insert(
            "LocationId".into(),
            MetadataValue::List {
                list_kind: ListKind::Bag,
                items: location_ids.into_iter().map(MetadataValue::Text).collect(),
            },
        );
    }
    if let Some(value) = input.gps_latitude {
        fields.insert("GPSLatitude".into(), MetadataValue::Real(value));
    }
    if let Some(value) = input.gps_longitude {
        fields.insert("GPSLongitude".into(), MetadataValue::Real(value));
    }
    if let Some(value) = input.gps_altitude {
        fields.insert("GPSAltitude".into(), MetadataValue::Real(value));
    }
    if let Some(value) = input.gps_altitude_ref {
        fields.insert(
            "GPSAltitudeRef".into(),
            MetadataValue::Integer(i64::from(value)),
        );
    }

    let context = LocationContext {
        location: sublocation,
        city,
        state,
        country,
    };
    Some((
        MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Struct(fields)],
        },
        context,
    ))
}

/// Group G AI wrapper. Existing LocationCreated remains authoritative; raw
/// evidence is interpreted only when the canonical structure is absent.
pub async fn normalise_location_with_ai(
    input: &LocationInput,
    ai: Option<&dyn NormaliseAiClient>,
) -> LocationOutcome {
    match read_location_created(input.location_created.as_ref()) {
        StructuredLocation::One(_) | StructuredLocation::Ambiguous => {
            let mut outcome = normalise_location(input);
            let context = derive_location_canonical(input);
            if context != LocationContext::default() {
                outcome.canonical = Some(context);
            }
            return outcome;
        }
        StructuredLocation::Absent => {}
    }

    let Some(prompt) = location_evidence_prompt(input) else {
        let mut outcome = normalise_location(input);
        let context = derive_location_canonical(input);
        if context != LocationContext::default() {
            outcome.canonical = Some(context);
        }
        return outcome;
    };

    let Some(client) = ai else {
        return LocationOutcome {
            ai_error: Some(NormaliseAiError::key_missing()),
            ..Default::default()
        };
    };
    match client.resolve_location(prompt).await {
        Ok((result, usage)) => {
            let Some((value, canonical)) = location_created_from_ai(input, result) else {
                return LocationOutcome {
                    ai_fired: true,
                    ai_usage: Some(usage),
                    ..Default::default()
                };
            };
            let mut edits = SchemaMetadataEditMap::new();
            edits.insert(
                known_ids::xmp_location_created(),
                MetadataDraftEdit {
                    value: Some(value),
                    intent: EditIntent::Set,
                },
            );
            // Project the newly-created canonical structure through the same
            // deterministic helper used for pre-existing LocationCreated.
            let projected_input = LocationInput {
                location_created: edits[&known_ids::xmp_location_created()].value.clone(),
                ..input.clone()
            };
            if let Some(projected) = normalise_location(&projected_input).output {
                edits.extend(projected.edits);
            }
            LocationOutcome {
                output: Some(GroupOutput { edits }),
                ai_fired: true,
                ai_usage: Some(usage),
                canonical: Some(canonical),
                ..Default::default()
            }
        }
        Err(error) => LocationOutcome {
            ai_usage: error.usage.clone(),
            ai_error: Some(error),
            ..Default::default()
        },
    }
}

/// Run Group G (Location) normalisation for one image.
pub fn normalise_location(input: &LocationInput) -> LocationOutcome {
    if matches!(
        read_location_created(input.location_created.as_ref()),
        StructuredLocation::Ambiguous
    ) {
        // LocationCreated is repeatable. Choosing one of several structures
        // would silently discard meaning, so require the user to resolve it.
        return LocationOutcome {
            n_location_created_ambiguous: 1,
            ..Default::default()
        };
    }

    if let StructuredLocation::One(canonical) =
        read_location_created(input.location_created.as_ref())
    {
        let mut edits = SchemaMetadataEditMap::new();
        // The legacy Sublocation property has deliberately broad semantics
        // and is commonly the only location label displayed by older
        // software. Prefer the structured full LocationName when present,
        // then fall back to the structured Sublocation.
        let legacy_location = canonical
            .location_name
            .as_deref()
            .or(canonical.sublocation.as_deref());
        let members = [
            (
                known_ids::xmp_location(),
                known_ids::iptc_sub_location(),
                input.location_xmp.as_deref(),
                input.location_iptc.as_deref(),
                legacy_location,
                identity_projection as fn(&str) -> String,
                iptc_sub_location_projection as fn(&str) -> String,
            ),
            (
                known_ids::xmp_city(),
                known_ids::iptc_city(),
                input.city_xmp.as_deref(),
                input.city_iptc.as_deref(),
                canonical.city.as_deref(),
                identity_projection,
                identity_projection,
            ),
            (
                known_ids::xmp_state(),
                known_ids::iptc_province_state(),
                input.state_xmp.as_deref(),
                input.state_iptc.as_deref(),
                canonical.state.as_deref(),
                identity_projection,
                identity_projection,
            ),
            (
                known_ids::xmp_country(),
                known_ids::iptc_country_name(),
                input.country_xmp.as_deref(),
                input.country_iptc.as_deref(),
                canonical.country.as_deref(),
                identity_projection,
                identity_projection,
            ),
            (
                known_ids::xmp_country_code(),
                known_ids::iptc_country_code(),
                input.country_code_xmp.as_deref(),
                input.country_code_iptc.as_deref(),
                canonical.country_code.as_deref(),
                xmp_country_code_projection,
                iptc_country_code_projection,
            ),
        ];
        for (xmp_key, iptc_key, xmp, iptc, value, xmp_projection, iptc_projection) in members {
            project_member(&mut edits, xmp_key, xmp, value, xmp_projection);
            project_member(&mut edits, iptc_key, iptc, value, iptc_projection);
        }
        return LocationOutcome {
            output: (!edits.is_empty()).then_some(GroupOutput { edits }),
            ..Default::default()
        };
    }

    type LocationPair<'a> = (
        SchemaDefinitionId,
        SchemaDefinitionId,
        Option<&'a str>,
        Option<&'a str>,
        fn(&str) -> String,
        fn(&str) -> String,
        fn(&str) -> String,
        fn(&str) -> String,
    );
    let pairs: [LocationPair<'_>; 5] = [
        (
            known_ids::xmp_location(),
            known_ids::iptc_sub_location(),
            input.location_xmp.as_deref(),
            input.location_iptc.as_deref(),
            canonicalise_location_text,
            canonicalise_location_text,
            identity_projection,
            iptc_sub_location_projection,
        ),
        (
            known_ids::xmp_city(),
            known_ids::iptc_city(),
            input.city_xmp.as_deref(),
            input.city_iptc.as_deref(),
            canonicalise_location_text,
            canonicalise_location_text,
            identity_projection,
            identity_projection,
        ),
        (
            known_ids::xmp_state(),
            known_ids::iptc_province_state(),
            input.state_xmp.as_deref(),
            input.state_iptc.as_deref(),
            canonicalise_location_text,
            canonicalise_location_text,
            identity_projection,
            identity_projection,
        ),
        (
            known_ids::xmp_country(),
            known_ids::iptc_country_name(),
            input.country_xmp.as_deref(),
            input.country_iptc.as_deref(),
            canonicalise_location_text,
            canonicalise_location_text,
            identity_projection,
            identity_projection,
        ),
        (
            known_ids::xmp_country_code(),
            known_ids::iptc_country_code(),
            input.country_code_xmp.as_deref(),
            input.country_code_iptc.as_deref(),
            canonicalise_country_code,
            canonicalise_iptc_country_code,
            xmp_country_code_projection,
            iptc_country_code_projection,
        ),
    ];

    let mut edits = SchemaMetadataEditMap::new();
    let mut conflicts: u32 = 0;
    for (xmp_key, iptc_key, xmp, iptc, xmp_canon, iptc_canon, xmp_projection, iptc_projection) in
        pairs
    {
        let result = process_pair(
            xmp,
            iptc,
            xmp_canon,
            iptc_canon,
            xmp_projection,
            iptc_projection,
        );
        if result.conflict {
            conflicts += 1;
        }
        if let Some(target) = result.xmp_target {
            edits.insert(xmp_key, text_edit(target));
        }
        if let Some(target) = result.iptc_target {
            edits.insert(iptc_key, text_edit(target));
        }
    }

    let canonical = canonical_from_legacy(input);
    if canonical.sublocation.is_some()
        || canonical.city.is_some()
        || canonical.state.is_some()
        || canonical.country.is_some()
        || canonical.country_code.is_some()
    {
        edits.insert(
            known_ids::xmp_location_created(),
            MetadataDraftEdit {
                value: Some(location_created_value(&canonical)),
                intent: EditIntent::Set,
            },
        );
    }

    LocationOutcome {
        output: if edits.is_empty() {
            None
        } else {
            Some(GroupOutput { edits })
        },
        n_xmp_iim_conflict: conflicts,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_value::MetadataValue;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(&crate::known_ids::test_id(k)).unwrap().value {
            Some(MetadataValue::Text(v)) => v.clone(),
            other => panic!("expected text value, got {:?}", other),
        }
    }

    fn location_created(g: &GroupOutput) -> MetadataValue {
        g.edits[&crate::known_ids::xmp_location_created()]
            .value
            .clone()
            .expect("LocationCreated Set value")
    }

    #[test]
    fn location_evidence_is_compacted_and_keeps_ranking_hints() {
        let input = LocationInput {
            geocode_json: Some(
                r#"{"type":"FeatureCollection","licence":"ignored","features":[{"geometry":{"coordinates":[0,0]},"properties":{"geocoding":{"place_id":123,"type":"house","osm_key":"place","osm_value":"house","name":"41 Lucerne Close","label":"41 Lucerne Close, Fulbourn, United Kingdom","housenumber":"41","street":"Lucerne Close","city":"South Cambridgeshire","county":"Cambridgeshire","state":"England","country":"United Kingdom","admin":{"level8":"Fulbourn"}}}}]}"#
                    .into(),
            ),
            json_v2: Some(
                r#"{"place_id":456,"licence":"ignored","lat":"0","lon":"0","category":"place","type":"house","addresstype":"place","name":"41 Lucerne Close","place_rank":30,"importance":0.0001,"address":{"house_number":"41","road":"Lucerne Close","village":"Fulbourn","county":"Cambridgeshire","state":"England","ISO3166-2-lvl4":"GB-ENG","country":"United Kingdom","country_code":"gb"},"boundingbox":["0","1","2","3"]}"#
                    .into(),
            ),
            ..Default::default()
        };

        let prompt = location_evidence_prompt(&input).expect("valid evidence");
        assert!(prompt.evidence.contains("feature:"));
        assert!(prompt.evidence.contains("place_rank: 30"));
        assert!(prompt.evidence.contains("search_importance: 0.0001"));
        assert!(prompt.evidence.contains("geocode_address:"));
        assert!(prompt.evidence.contains("jsonv2_address:"));
        assert!(prompt.evidence.contains("geocode_admin:"));
        assert!(prompt.evidence.contains("village: \"Fulbourn\""));
        for omitted in [
            "place_id",
            "licence",
            "country_code",
            "ISO3166",
            "boundingbox",
            "coordinates",
        ] {
            assert!(!prompt.evidence.contains(omitted), "{omitted} leaked");
        }
        assert!(prompt.evidence.len() < 700);
    }

    #[test]
    fn malformed_evidence_is_ignored_when_the_other_source_is_valid() {
        let input = LocationInput {
            geocode_json: Some("not json".into()),
            json_v2: Some(r#"{"display_name":"Ely, United Kingdom"}"#.into()),
            ..Default::default()
        };
        let prompt = location_evidence_prompt(&input).expect("JSONv2 remains useful");
        assert!(prompt.evidence.contains("unclassified_label:"));
        assert!(prompt.evidence.contains("Ely | United Kingdom"));
        assert!(!prompt.evidence.contains("not json"));
    }

    #[test]
    fn entirely_malformed_evidence_does_not_call_ai() {
        let input = LocationInput {
            geocode_json: Some("not json".into()),
            json_v2: Some("{also broken".into()),
            ..Default::default()
        };
        assert!(location_evidence_prompt(&input).is_none());
    }

    #[test]
    fn all_empty_returns_no_drafts() {
        let out = normalise_location(&LocationInput::default());
        assert!(out.output.is_none());
        assert_eq!(out.n_xmp_iim_conflict, 0);
    }

    #[test]
    fn xmp_only_copies_to_iim() {
        let input = LocationInput {
            city_xmp: Some("Paris".into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.unwrap();
        assert!(!out.edits.contains_key(&crate::known_ids::xmp_city()));
        assert_eq!(s(&out, "IPTC:City"), "Paris");
    }

    #[test]
    fn iim_only_copies_to_xmp() {
        let input = LocationInput {
            city_iptc: Some("Paris".into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.unwrap();
        assert_eq!(s(&out, "XMP-photoshop:City"), "Paris");
        assert!(!out.edits.contains_key(&crate::known_ids::iptc_city()));
    }

    #[test]
    fn both_equal_legacy_values_seed_location_created() {
        let input = LocationInput {
            city_xmp: Some("Paris".into()),
            city_iptc: Some("Paris".into()),
            ..Default::default()
        };
        let out = normalise_location(&input);
        let group = out.output.expect("legacy values must seed LocationCreated");
        assert!(group
            .edits
            .contains_key(&crate::known_ids::xmp_location_created()));
        assert_eq!(out.n_xmp_iim_conflict, 0);
    }

    #[test]
    fn both_distinct_xmp_wins_and_conflict_counted() {
        let input = LocationInput {
            city_xmp: Some("Paris".into()),
            city_iptc: Some("Berlin".into()),
            ..Default::default()
        };
        let out = normalise_location(&input);
        let g = out.output.expect("conflict must emit drafts");
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_city()));
        assert_eq!(s(&g, "IPTC:City"), "Paris");
        assert_eq!(out.n_xmp_iim_conflict, 1);
    }

    #[test]
    fn country_code_uppercased() {
        let input = LocationInput {
            country_code_xmp: Some("gb".into()),
            country_code_iptc: Some("GB".into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.unwrap();
        assert_eq!(s(&out, "XMP-iptcCore:CountryCode"), "GB");
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "GB ");
    }

    #[test]
    fn xmp_country_code_only_projects_padded_iptc() {
        let input = LocationInput {
            country_code_xmp: Some("GB".into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.unwrap();
        assert!(!out
            .edits
            .contains_key(&crate::known_ids::xmp_country_code()));
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "GB ");
    }

    #[test]
    fn padded_iptc_country_code_only_backfills_xmp_alpha_2() {
        let input = LocationInput {
            country_code_iptc: Some("GB ".into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.unwrap();
        assert_eq!(s(&out, "XMP-iptcCore:CountryCode"), "GB");
        assert!(!out
            .edits
            .contains_key(&crate::known_ids::iptc_country_code()));
    }

    #[test]
    fn synced_legacy_country_code_seeds_location_created() {
        let input = LocationInput {
            country_code_xmp: Some("GB".into()),
            country_code_iptc: Some("GB ".into()),
            ..Default::default()
        };
        let out = normalise_location(&input);
        assert!(out
            .output
            .expect("legacy values must seed LocationCreated")
            .edits
            .contains_key(&crate::known_ids::xmp_location_created()));
        assert_eq!(out.n_xmp_iim_conflict, 0);
    }

    #[test]
    fn unpadded_iptc_country_code_is_reprojected_without_conflict() {
        let input = LocationInput {
            country_code_xmp: Some("GB".into()),
            country_code_iptc: Some("GB".into()),
            ..Default::default()
        };
        let out = normalise_location(&input);
        let g = out.output.expect("must emit padded IPTC projection");
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_country_code()));
        assert_eq!(s(&g, "IPTC:Country-PrimaryLocationCode"), "GB ");
        assert_eq!(out.n_xmp_iim_conflict, 0);
    }

    #[test]
    fn five_pairs_are_independent() {
        let input = LocationInput {
            city_xmp: Some("Paris".into()),
            state_xmp: Some("Île-de-France".into()),
            state_iptc: Some("Île-de-France".into()),
            country_xmp: Some("France".into()),
            country_iptc: Some("Frankreich".into()),
            country_code_iptc: Some("fr".into()),
            ..Default::default()
        };
        let out = normalise_location(&input);
        let g = out.output.unwrap();
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_location()));
        assert!(!g.edits.contains_key(&crate::known_ids::iptc_sub_location()));
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_city()));
        assert_eq!(s(&g, "IPTC:City"), "Paris");
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_state()));
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_country()));
        assert_eq!(s(&g, "IPTC:Country-PrimaryLocationName"), "France");
        assert_eq!(s(&g, "XMP-iptcCore:CountryCode"), "FR");
        assert_eq!(s(&g, "IPTC:Country-PrimaryLocationCode"), "FR ");
        assert_eq!(out.n_xmp_iim_conflict, 1);
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = LocationInput {
            city_xmp: Some("Paris".into()),
            country_code_iptc: Some("fr".into()),
            ..Default::default()
        };
        let first = normalise_location(&initial).output.unwrap();
        let post = LocationInput {
            location_created: Some(location_created(&first)),
            city_xmp: Some("Paris".into()),
            city_iptc: Some(s(&first, "IPTC:City")),
            country_code_xmp: Some(s(&first, "XMP-iptcCore:CountryCode")),
            country_code_iptc: Some(s(&first, "IPTC:Country-PrimaryLocationCode")),
            ..Default::default()
        };
        let second = normalise_location(&post);
        assert!(second.output.is_none());
        assert_eq!(second.n_xmp_iim_conflict, 0);
    }

    #[test]
    fn equal_but_unnormalised_triggers_writes() {
        let input = LocationInput {
            country_code_xmp: Some("gb".into()),
            country_code_iptc: Some("gb".into()),
            ..Default::default()
        };
        let out = normalise_location(&input)
            .output
            .expect("must normalise to uppercase");
        assert_eq!(s(&out, "XMP-iptcCore:CountryCode"), "GB");
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "GB ");
    }

    #[test]
    fn long_xmp_location_projects_only_iptc_sub_location() {
        let full = "The Rook and Gaskill Inn, Foss Islands, York, United Kingdom";
        let input = LocationInput {
            location_xmp: Some(full.into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.unwrap();
        assert!(!out.edits.contains_key(&crate::known_ids::xmp_location()));
        let projected = s(&out, "IPTC:Sub-location");
        assert!(projected.len() <= IPTC_SUB_LOCATION_LIMIT);
        assert_eq!(projected, truncate_at_word(full, IPTC_SUB_LOCATION_LIMIT));
    }

    #[test]
    fn synced_legacy_sublocation_seeds_location_created() {
        let full = "The Rook and Gaskill Inn, Foss Islands, York, United Kingdom";
        let input = LocationInput {
            location_xmp: Some(full.into()),
            location_iptc: Some(truncate_at_word(full, IPTC_SUB_LOCATION_LIMIT)),
            ..Default::default()
        };
        let out = normalise_location(&input);
        assert!(out
            .output
            .expect("legacy values must seed LocationCreated")
            .edits
            .contains_key(&crate::known_ids::xmp_location_created()));
        assert_eq!(out.n_xmp_iim_conflict, 0);
    }

    #[test]
    fn hard_truncated_iptc_sub_location_is_reprojected_once() {
        let full = "Clifton Moor, York, United Kingdom";
        let projected = truncate_at_word(full, IPTC_SUB_LOCATION_LIMIT);
        let initial = LocationInput {
            location_xmp: Some(full.into()),
            location_iptc: Some("Clifton Moor, York, United Kingd".into()),
            ..Default::default()
        };
        let first = normalise_location(&initial);
        let g = first.output.expect("must emit projected IPTC edit");
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_location()));
        assert_eq!(s(&g, "IPTC:Sub-location"), projected);

        let post = LocationInput {
            location_created: Some(location_created(&g)),
            location_xmp: Some(full.into()),
            location_iptc: Some(projected),
            ..Default::default()
        };
        let second = normalise_location(&post);
        assert!(second.output.is_none());
    }

    #[test]
    fn location_context_keeps_full_xmp_location() {
        let full = "The Rook and Gaskill Inn, Foss Islands, York, United Kingdom";
        let ctx = derive_location_canonical(&LocationInput {
            location_xmp: Some(full.into()),
            location_iptc: Some(truncate_at_word(full, IPTC_SUB_LOCATION_LIMIT)),
            ..Default::default()
        });
        assert_eq!(ctx.location.as_deref(), Some(full));
    }

    fn structured(fields: &[(&str, &str)]) -> MetadataValue {
        MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Struct(
                fields
                    .iter()
                    .map(|(key, value)| ((*key).into(), MetadataValue::Text((*value).into())))
                    .collect(),
            )],
        }
    }

    #[test]
    fn one_location_created_projects_present_members_and_clears_missing_legacy() {
        let input = LocationInput {
            location_created: Some(structured(&[
                ("Sublocation", "Seria"),
                ("City", "Tokyo"),
                ("CountryName", "Japan"),
                ("CountryCode", "jp"),
            ])),
            state_xmp: Some("stale state".into()),
            state_iptc: Some("stale state".into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.unwrap();
        assert_eq!(s(&out, "XMP-iptcCore:Location"), "Seria");
        assert_eq!(s(&out, "IPTC:City"), "Tokyo");
        assert_eq!(s(&out, "XMP-iptcCore:CountryCode"), "JP");
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "JP ");
        for id in [known_ids::xmp_state(), known_ids::iptc_province_state()] {
            let edit = &out.edits[&id];
            assert!(matches!(edit.intent, EditIntent::Delete));
            assert!(edit.value.is_none());
        }
        assert!(!out.edits.contains_key(&known_ids::xmp_location_created()));
    }

    #[test]
    fn multiple_location_created_structures_are_left_for_manual_resolution() {
        let MetadataValue::List { items, .. } = structured(&[("City", "Tokyo")]) else {
            unreachable!()
        };
        let location = items[0].clone();
        let input = LocationInput {
            location_created: Some(MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![location.clone(), location],
            }),
            city_xmp: Some("Legacy city".into()),
            ..Default::default()
        };
        assert!(normalise_location(&input).output.is_none());
        assert_eq!(normalise_location(&input).n_location_created_ambiguous, 1);
        assert_eq!(
            derive_location_canonical(&input),
            LocationContext::default()
        );
    }

    #[test]
    fn location_created_projection_is_idempotent() {
        let value = structured(&[("City", "Tokyo"), ("CountryCode", "JP")]);
        let initial = LocationInput {
            location_created: Some(value.clone()),
            ..Default::default()
        };
        let first = normalise_location(&initial).output.unwrap();
        let post = LocationInput {
            location_created: Some(value),
            city_xmp: Some(s(&first, "XMP-photoshop:City")),
            city_iptc: Some(s(&first, "IPTC:City")),
            country_code_xmp: Some(s(&first, "XMP-iptcCore:CountryCode")),
            country_code_iptc: Some(s(&first, "IPTC:Country-PrimaryLocationCode")),
            ..Default::default()
        };
        assert!(normalise_location(&post).output.is_none());
    }

    struct LocationMock {
        result: LocationAiResult,
    }

    #[async_trait::async_trait]
    impl NormaliseAiClient for LocationMock {
        async fn merge_description(
            &self,
            _prompt: super::super::DescriptionMergePrompt,
        ) -> Result<(String, AiCallUsage), NormaliseAiError> {
            unreachable!("location test must not call description AI")
        }

        async fn generate_title(
            &self,
            _prompt: super::super::TitleGenPrompt,
        ) -> Result<(String, AiCallUsage), NormaliseAiError> {
            unreachable!("location test must not call title AI")
        }

        async fn resolve_location(
            &self,
            _prompt: LocationResolvePrompt,
        ) -> Result<(LocationAiResult, AiCallUsage), NormaliseAiError> {
            Ok((self.result.clone(), AiCallUsage::default()))
        }
    }

    fn ai_evidence_input() -> LocationInput {
        LocationInput {
            geocode_json: Some(
                r#"{"features":[{"properties":{"geocoding":{"osm_type":"node","osm_id":42,"country_code":"jp","name":"Sengaku-ji","locality":"Takanawa","city":"Tokyo","country":"Japan"}}}]}"#
                    .into(),
            ),
            json_v2: Some(
                r#"{"osm_type":"node","osm_id":42,"name":"Sengaku-ji","address":{"suburb":"Takanawa","city":"Tokyo","country":"Japan","country_code":"jp"}}"#.into(),
            ),
            gps_latitude: Some(35.62857),
            gps_longitude: Some(139.7367),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn raw_evidence_creates_location_and_projects_legacy_fields() {
        let input = ai_evidence_input();
        let ai = LocationMock {
            result: LocationAiResult {
                sublocation: Some("Takanawa".into()),
                city: Some("Minato, Tokyo".into()),
                province_state: Some("Tokyo".into()),
                country_name: Some("Japan".into()),
                world_region: Some("East Asia".into()),
                location_name: Some("Sengaku-ji".into()),
            },
        };
        let outcome = normalise_location_with_ai(&input, Some(&ai)).await;
        assert!(outcome.ai_fired);
        assert!(outcome.ai_error.is_none());
        let output = outcome.output.expect("AI result should produce drafts");
        assert_eq!(s(&output, "XMP-iptcCore:Location"), "Sengaku-ji");
        assert_eq!(s(&output, "IPTC:Sub-location"), "Sengaku-ji");
        assert_eq!(s(&output, "XMP-photoshop:City"), "Minato, Tokyo");
        assert_eq!(s(&output, "IPTC:Country-PrimaryLocationName"), "Japan");
        assert_eq!(s(&output, "XMP-iptcCore:CountryCode"), "JP");

        let Some(MetadataValue::List { items, .. }) =
            &output.edits[&known_ids::xmp_location_created()].value
        else {
            panic!("expected LocationCreated bag")
        };
        let MetadataValue::Struct(fields) = &items[0] else {
            panic!("expected LocationCreated struct")
        };
        assert_eq!(
            fields.get("GPSLatitude"),
            Some(&MetadataValue::Real(35.62857))
        );
        assert_eq!(
            fields.get("WorldRegion"),
            Some(&MetadataValue::Text("East Asia".into()))
        );
        assert_eq!(
            fields.get("Sublocation"),
            Some(&MetadataValue::Text("Takanawa".into()))
        );
        assert_eq!(
            fields.get("LocationName"),
            Some(&MetadataValue::LangAlt(BTreeMap::from([(
                "x-default".into(),
                "Sengaku-ji".into()
            )])))
        );
        assert_eq!(
            fields.get("LocationId"),
            Some(&MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![MetadataValue::Text(
                    "https://www.openstreetmap.org/node/42".into()
                )],
            })
        );
    }

    #[tokio::test]
    async fn ai_field_duplicates_are_removed_before_writing() {
        let input = ai_evidence_input();
        let ai = LocationMock {
            result: LocationAiResult {
                sublocation: Some("Tokyo".into()),
                city: Some("Tokyo".into()),
                location_name: Some("Tokyo".into()),
                ..Default::default()
            },
        };
        let output = normalise_location_with_ai(&input, Some(&ai))
            .await
            .output
            .expect("City still produces a draft");
        let Some(MetadataValue::List { items, .. }) =
            &output.edits[&known_ids::xmp_location_created()].value
        else {
            panic!("expected LocationCreated bag")
        };
        let MetadataValue::Struct(fields) = &items[0] else {
            panic!("expected LocationCreated struct")
        };
        assert_eq!(
            fields.get("City"),
            Some(&MetadataValue::Text("Tokyo".into()))
        );
        assert!(!fields.contains_key("Sublocation"));
        assert!(!fields.contains_key("LocationName"));
    }

    #[tokio::test]
    async fn existing_location_created_is_trusted_even_when_evidence_exists() {
        let input = LocationInput {
            location_created: Some(structured(&[("City", "Ely")])),
            geocode_json: Some(r#"{"features":[]}"#.into()),
            ..Default::default()
        };
        let ai = LocationMock {
            result: LocationAiResult {
                city: Some("Wrong".into()),
                ..Default::default()
            },
        };
        let outcome = normalise_location_with_ai(&input, Some(&ai)).await;
        assert!(!outcome.ai_fired);
        assert_eq!(s(&outcome.output.unwrap(), "XMP-photoshop:City"), "Ely");
    }

    #[tokio::test]
    async fn one_nonempty_evidence_field_is_enough_to_call_ai() {
        let input = LocationInput {
            json_v2: Some(r#"{"display_name":"Ely"}"#.into()),
            ..Default::default()
        };
        let ai = LocationMock {
            result: LocationAiResult {
                city: Some("Ely".into()),
                ..Default::default()
            },
        };
        let outcome = normalise_location_with_ai(&input, Some(&ai)).await;
        assert!(outcome.ai_fired);
        assert_eq!(s(&outcome.output.unwrap(), "XMP-photoshop:City"), "Ely");
    }

    #[tokio::test]
    async fn conflicting_country_codes_are_not_guessed() {
        let mut input = ai_evidence_input();
        input.json_v2 = Some(r#"{"address":{"country_code":"gb"}}"#.into());
        let ai = LocationMock {
            result: LocationAiResult {
                country_name: Some("Japan".into()),
                ..Default::default()
            },
        };
        let output = normalise_location_with_ai(&input, Some(&ai))
            .await
            .output
            .unwrap();
        assert!(!output.edits.contains_key(&known_ids::xmp_country_code()));
        assert!(!output.edits.contains_key(&known_ids::iptc_country_code()));
    }
}
