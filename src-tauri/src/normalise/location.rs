//! Group G — Location (XMP ↔ IIM mirror sync).
//!
//! Plan §1 Group G. Five XMP↔IIM mirror pairs treated independently.
//! Per-pair policy:
//!   1. Both empty → no drafts.
//!   2. Exactly one non-empty → canonical = that value, project to both fields.
//!      For the CountryCode pair:
//!        - The canonical semantic value is trimmed, whitespace-collapsed,
//!          and uppercased alpha-2-style text (this is not alpha-3 conversion
//!          and does not use a lookup table).
//!        - XMP projection writes the canonical value, e.g. `GB`.
//!        - IPTC projection writes the legacy fixed-width padded storage form
//!          for 2-character ASCII codes, e.g. `GB `.
//!   3. Both non-empty AND equal after canonicalisation → write to both.
//!      Handles e.g. `gb` vs `GB` for CountryCode, where IPTC readback
//!      canonicalisation trims trailing fixed-width space padding before comparison.
//!   4. Both non-empty AND distinct after canonicalisation → primary
//!      (XMP side) wins. Stats: `n_location_xmp_iim_conflict`.
//!
//! No AI — never AI-merge place names. No reverse-geocoding here;
//! Group G only mirrors what is already in metadata.

use super::{
    collapse_whitespace_single_line, text_edit, truncate_at_word, GroupOutput, LocationContext,
    LocationInput,
};
use crate::country_code::{
    canonical_country_code, canonical_iptc_country_code_readback, iptc_country_code_projection,
    xmp_country_code_projection,
};
use crate::draft_edits::SchemaMetadataEditMap;
use crate::known_ids;
use crate::tag_schema::SchemaDefinitionId;

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
    LocationContext {
        location: pick(
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
    }
}

#[derive(Debug, Clone, Default)]
pub struct LocationOutcome {
    pub output: Option<GroupOutput>,
    pub n_xmp_iim_conflict: u32,
}

/// Run Group G (Location) normalisation for one image.
pub fn normalise_location(input: &LocationInput) -> LocationOutcome {
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

    LocationOutcome {
        output: if edits.is_empty() {
            None
        } else {
            Some(GroupOutput { edits })
        },
        n_xmp_iim_conflict: conflicts,
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
    fn both_equal_in_sync_no_drafts_for_that_pair() {
        let input = LocationInput {
            city_xmp: Some("Paris".into()),
            city_iptc: Some("Paris".into()),
            ..Default::default()
        };
        let out = normalise_location(&input);
        assert!(out.output.is_none());
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
    fn xmp_country_code_and_padded_iptc_readback_are_in_sync() {
        let input = LocationInput {
            country_code_xmp: Some("GB".into()),
            country_code_iptc: Some("GB ".into()),
            ..Default::default()
        };
        let out = normalise_location(&input);
        assert!(out.output.is_none());
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
    fn long_xmp_location_with_projected_iptc_is_idempotent() {
        let full = "The Rook and Gaskill Inn, Foss Islands, York, United Kingdom";
        let input = LocationInput {
            location_xmp: Some(full.into()),
            location_iptc: Some(truncate_at_word(full, IPTC_SUB_LOCATION_LIMIT)),
            ..Default::default()
        };
        let out = normalise_location(&input);
        assert!(out.output.is_none());
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
}
