//! Group G — Location (XMP ↔ IIM mirror sync).
//!
//! Plan §1 Group G. Five XMP↔IIM mirror pairs treated independently.
//! Per-pair policy:
//!   1. Both empty → no drafts.
//!   2. Exactly one non-empty → canonical = that value (uppercased for
//!      CountryCode), project to both fields.
//!   3. Both non-empty AND equal after canonicalisation → write
//!      canonical to both (handles e.g. `gb` vs `GB` for CountryCode).
//!   4. Both non-empty AND distinct after canonicalisation → primary
//!      (XMP side) wins. Stats: `n_location_xmp_iim_conflict`.
//!
//! No AI — never AI-merge place names. No reverse-geocoding here;
//! Group G only mirrors what is already in metadata.

use super::{collapse_whitespace_single_line, GroupOutput, LocationContext, LocationInput};
use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;
use std::collections::HashMap;

pub const LOCATION_TARGET_TAGS: &[&str] = &[
    "XMP-iptcCore:Location",
    "IPTC:Sub-location",
    "XMP-photoshop:City",
    "IPTC:City",
    "XMP-photoshop:State",
    "IPTC:Province-State",
    "XMP-photoshop:Country",
    "IPTC:Country-PrimaryLocationName",
    "XMP-iptcCore:CountryCode",
    "IPTC:Country-PrimaryLocationCode",
];

fn canonicalise_location_text(s: &str) -> String {
    collapse_whitespace_single_line(s)
}

fn canonicalise_country_code(s: &str) -> String {
    canonicalise_location_text(s).to_uppercase()
}

struct PairResult {
    canonical: Option<String>,
    conflict: bool,
}

fn process_pair(xmp: Option<&str>, iptc: Option<&str>, canon: fn(&str) -> String) -> PairResult {
    let xc = xmp.map(canon).filter(|s| !s.is_empty());
    let ic = iptc.map(canon).filter(|s| !s.is_empty());

    let (canonical, conflict) = match (xc, ic) {
        (None, None) => (None, false),
        (Some(v), None) | (None, Some(v)) => (Some(v), false),
        (Some(x), Some(i)) if x == i => (Some(x), false),
        (Some(x), Some(_)) => (Some(x), true),
    };
    let canonical = canonical.filter(|c| {
        let want = Some(c.as_str());
        !(xmp == want && iptc == want)
    });
    PairResult {
        canonical,
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
    let pairs: [(&str, &str, Option<&str>, Option<&str>, fn(&str) -> String); 5] = [
        (
            "XMP-iptcCore:Location",
            "IPTC:Sub-location",
            input.location_xmp.as_deref(),
            input.location_iptc.as_deref(),
            canonicalise_location_text,
        ),
        (
            "XMP-photoshop:City",
            "IPTC:City",
            input.city_xmp.as_deref(),
            input.city_iptc.as_deref(),
            canonicalise_location_text,
        ),
        (
            "XMP-photoshop:State",
            "IPTC:Province-State",
            input.state_xmp.as_deref(),
            input.state_iptc.as_deref(),
            canonicalise_location_text,
        ),
        (
            "XMP-photoshop:Country",
            "IPTC:Country-PrimaryLocationName",
            input.country_xmp.as_deref(),
            input.country_iptc.as_deref(),
            canonicalise_location_text,
        ),
        (
            "XMP-iptcCore:CountryCode",
            "IPTC:Country-PrimaryLocationCode",
            input.country_code_xmp.as_deref(),
            input.country_code_iptc.as_deref(),
            canonicalise_country_code,
        ),
    ];

    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    let mut conflicts: u32 = 0;
    for (xmp_key, iptc_key, xmp, iptc, canon) in pairs {
        let result = process_pair(xmp, iptc, canon);
        if result.conflict {
            conflicts += 1;
        }
        if let Some(canonical) = result.canonical {
            let edit = DraftEdit {
                value: Some(Variant::String(canonical)),
                intent: EditIntent::Set,
                display: None,
            };
            edits.insert(xmp_key.to_string(), edit.clone());
            edits.insert(iptc_key.to_string(), edit);
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

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String, got {:?}", other),
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
        assert_eq!(s(&out, "XMP-photoshop:City"), "Paris");
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
        assert_eq!(s(&out, "IPTC:City"), "Paris");
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
        assert_eq!(s(&g, "XMP-photoshop:City"), "Paris");
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
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "GB");
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
        assert!(!g.edits.contains_key("XMP-iptcCore:Location"));
        assert!(!g.edits.contains_key("IPTC:Sub-location"));
        assert_eq!(s(&g, "XMP-photoshop:City"), "Paris");
        assert_eq!(s(&g, "IPTC:City"), "Paris");
        assert!(!g.edits.contains_key("XMP-photoshop:State"));
        assert_eq!(s(&g, "XMP-photoshop:Country"), "France");
        assert_eq!(s(&g, "IPTC:Country-PrimaryLocationName"), "France");
        assert_eq!(s(&g, "XMP-iptcCore:CountryCode"), "FR");
        assert_eq!(s(&g, "IPTC:Country-PrimaryLocationCode"), "FR");
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
            city_xmp: Some(s(&first, "XMP-photoshop:City")),
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
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "GB");
    }
}
