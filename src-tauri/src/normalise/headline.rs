//! Group D — Headline.
//!
//! Plan §1 Group D. Canonical = single-sentence headline. No AI.
//! Plain whitespace-collapse + trim. Derivative IPTC:Headline has a
//! 256-char IIM limit and is truncated at a word boundary.

use super::{
    collapse_whitespace_single_line, text_edit, truncate_at_word, GroupOutput, HeadlineInput,
};
use crate::draft_edits::SchemaMetadataEditMap;

use crate::known_ids;

const IPTC_HEADLINE_LIMIT: usize = 256;

fn derive_headline_canonical(input: &HeadlineInput) -> Option<String> {
    if let Some(p) = input.photoshop_headline.as_deref() {
        let n = collapse_whitespace_single_line(p);
        if !n.is_empty() {
            return Some(n);
        }
    }
    if let Some(d) = input.iptc_headline.as_deref() {
        let n = collapse_whitespace_single_line(d);
        if !n.is_empty() {
            return Some(n);
        }
    }
    None
}

fn headline_is_normalised(input: &HeadlineInput, canonical: &str) -> bool {
    let iptc_projection = truncate_at_word(canonical, IPTC_HEADLINE_LIMIT);
    input.photoshop_headline.as_deref() == Some(canonical)
        && input.iptc_headline.as_deref() == Some(iptc_projection.as_str())
}

/// Run Group D (Headline) normalisation for one image.
pub fn normalise_headline(input: &HeadlineInput) -> Option<GroupOutput> {
    let canonical = derive_headline_canonical(input)?;
    if headline_is_normalised(input, &canonical) {
        return None;
    }
    let iptc = truncate_at_word(&canonical, IPTC_HEADLINE_LIMIT);
    let mut edits = SchemaMetadataEditMap::new();
    edits.insert(known_ids::xmp_headline(), text_edit(canonical.clone()));
    edits.insert(known_ids::iptc_headline(), text_edit(iptc));
    Some(GroupOutput { edits })
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
    fn primary_wins() {
        let input = HeadlineInput {
            photoshop_headline: Some("Climbers descend Mont Blanc".into()),
            iptc_headline: Some("Old IPTC headline".into()),
        };
        let out = normalise_headline(&input).unwrap();
        assert_eq!(
            s(&out, "XMP-photoshop:Headline"),
            "Climbers descend Mont Blanc"
        );
        assert_eq!(s(&out, "IPTC:Headline"), "Climbers descend Mont Blanc");
    }

    #[test]
    fn primary_empty_uses_derivative() {
        let input = HeadlineInput {
            photoshop_headline: None,
            iptc_headline: Some("From the IPTC side".into()),
        };
        let out = normalise_headline(&input).unwrap();
        assert_eq!(s(&out, "XMP-photoshop:Headline"), "From the IPTC side");
        assert_eq!(s(&out, "IPTC:Headline"), "From the IPTC side");
    }

    #[test]
    fn all_empty_returns_no_drafts() {
        assert!(normalise_headline(&HeadlineInput::default()).is_none());
    }

    #[test]
    fn whitespace_normalised() {
        let input = HeadlineInput {
            photoshop_headline: Some("  Headline   with   gaps  ".into()),
            ..Default::default()
        };
        let out = normalise_headline(&input).unwrap();
        assert_eq!(s(&out, "XMP-photoshop:Headline"), "Headline with gaps");
    }

    #[test]
    fn iptc_headline_truncated_at_word_boundary_when_over_256_bytes() {
        let long = "word ".repeat(80);
        let trimmed = long.trim_end().to_string();
        assert!(trimmed.len() > IPTC_HEADLINE_LIMIT);
        let input = HeadlineInput {
            photoshop_headline: Some(trimmed.clone()),
            ..Default::default()
        };
        let out = normalise_headline(&input).unwrap();
        assert_eq!(s(&out, "XMP-photoshop:Headline"), trimmed);
        let iptc = s(&out, "IPTC:Headline");
        assert!(iptc.len() <= IPTC_HEADLINE_LIMIT);
        assert!(!iptc.ends_with(' '));
        assert!(iptc.ends_with("word"));
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = HeadlineInput {
            photoshop_headline: Some("My Headline".into()),
            ..Default::default()
        };
        let first = normalise_headline(&initial).unwrap();
        let post = HeadlineInput {
            photoshop_headline: Some(s(&first, "XMP-photoshop:Headline")),
            iptc_headline: Some(s(&first, "IPTC:Headline")),
        };
        assert!(normalise_headline(&post).is_none());
    }
}
