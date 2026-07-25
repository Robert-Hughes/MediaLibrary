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
    collapse_whitespace_single_line, text_edit, truncate_at_word, GroupOutput, LocationContext,
    LocationInput,
};
use crate::country_code::{
    canonical_country_code, canonical_iptc_country_code_readback, iptc_country_code_projection,
    xmp_country_code_projection,
};
use crate::draft_edits::{EditIntent, MetadataDraftEdit, SchemaMetadataEditMap};
use crate::known_ids;
use crate::metadata_value::{ListKind, MetadataValue};
use crate::tag_schema::SchemaDefinitionId;
use std::collections::BTreeMap;

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
        let members = [
            (
                known_ids::xmp_location(),
                known_ids::iptc_sub_location(),
                input.location_xmp.as_deref(),
                input.location_iptc.as_deref(),
                canonical.sublocation.as_deref(),
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
            n_xmp_iim_conflict: 0,
            n_location_created_ambiguous: 0,
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
        n_location_created_ambiguous: 0,
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
}
