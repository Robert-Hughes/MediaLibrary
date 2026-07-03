//! Group E — Creator.
//!
//! Plan §1 Group E. Canonical = ordered Seq of names, kept verbatim
//! (no name normalisation). Union of all non-empty sources, dedup
//! case-sensitive, preserve first-seen order.

use super::{bag_edit, CreatorInput, GroupOutput};
use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;
use std::collections::{HashMap, HashSet};

/// Target tags written by Group E. Coherent-replacement rule (plan §4).
pub const CREATOR_TARGET_TAGS: &[&str] = &["XMP-dc:Creator", "EXIF:Artist", "IPTC:By-line"];

/// Separator used by `EXIF:Artist` when multiple names are present.
const ARTIST_SEPARATOR: &str = "; ";

/// Parse `EXIF:Artist` into the list of names it represents.
fn parse_artist(s: &str) -> Vec<String> {
    s.split(';')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.to_string())
        .collect()
}

/// Derive the canonical Group E ordered Seq of names.
pub fn derive_creator_canonical(input: &CreatorInput) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut canonical: Vec<String> = Vec::new();
    let artist_split = input
        .artist
        .as_deref()
        .map(parse_artist)
        .unwrap_or_default();
    let sources: [&[String]; 3] = [&input.creator, &artist_split, &input.byline];
    for src in sources {
        for raw in src {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            if seen.insert(trimmed.to_string()) {
                canonical.push(trimmed.to_string());
            }
        }
    }
    canonical
}

fn creator_is_normalised(input: &CreatorInput, canonical: &[String]) -> bool {
    if input.creator != canonical {
        return false;
    }
    let artist_now = input.artist.as_deref().unwrap_or("");
    let artist_expected = canonical.join(ARTIST_SEPARATOR);
    if artist_now != artist_expected {
        return false;
    }
    if input.byline != canonical {
        return false;
    }
    true
}

/// Run Group E (Creator) normalisation for one image.
pub fn normalise_creator(input: &CreatorInput) -> Option<GroupOutput> {
    let canonical = derive_creator_canonical(input);
    if canonical.is_empty() {
        return None;
    }
    if creator_is_normalised(input, &canonical) {
        return None;
    }

    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    edits.insert("XMP-dc:Creator".to_string(), bag_edit(&canonical));
    edits.insert(
        "EXIF:Artist".to_string(),
        DraftEdit {
            value: Some(Variant::String(canonical.join(ARTIST_SEPARATOR))),
            intent: EditIntent::Set,
            display: None,
        },
    );
    edits.insert("IPTC:By-line".to_string(), bag_edit(&canonical));

    Some(GroupOutput { edits })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(g: &GroupOutput, key: &str) -> Vec<String> {
        match &g.edits.get(key).unwrap().value {
            Some(Variant::List(items)) => items
                .iter()
                .map(|v| match v {
                    Variant::String(s) => s.clone(),
                    _ => panic!("expected String"),
                })
                .collect(),
            other => panic!("expected List for {}, got {:?}", key, other),
        }
    }

    fn string(g: &GroupOutput, key: &str) -> String {
        match &g.edits.get(key).unwrap().value {
            Some(Variant::String(s)) => s.clone(),
            other => panic!("expected String for {}, got {:?}", key, other),
        }
    }

    #[test]
    fn union_in_discovery_order() {
        let input = CreatorInput {
            creator: vec!["Alice".into()],
            artist: Some("Bob; Carol".into()),
            byline: vec!["Carol".into(), "Dave".into()],
        };
        let out = normalise_creator(&input).unwrap();
        assert_eq!(
            list(&out, "XMP-dc:Creator"),
            vec!["Alice", "Bob", "Carol", "Dave"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        );
        assert_eq!(string(&out, "EXIF:Artist"), "Alice; Bob; Carol; Dave");
        assert_eq!(
            list(&out, "IPTC:By-line"),
            vec!["Alice", "Bob", "Carol", "Dave"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        );
    }

    #[test]
    fn name_capitalisation_kept_verbatim() {
        let input = CreatorInput {
            creator: vec!["JOHN smith".into(), "André Müller".into()],
            ..Default::default()
        };
        let out = normalise_creator(&input).unwrap();
        assert_eq!(
            list(&out, "XMP-dc:Creator"),
            vec!["JOHN smith".to_string(), "André Müller".to_string()],
        );
    }

    #[test]
    fn case_sensitive_dedup() {
        let input = CreatorInput {
            creator: vec!["Alice".into(), "alice".into(), "Alice".into()],
            ..Default::default()
        };
        let out = normalise_creator(&input).unwrap();
        assert_eq!(
            list(&out, "XMP-dc:Creator"),
            vec!["Alice".to_string(), "alice".to_string()],
        );
    }

    #[test]
    fn empty_input_returns_no_drafts() {
        assert!(normalise_creator(&CreatorInput::default()).is_none());
    }

    #[test]
    fn whitespace_only_input_returns_no_drafts() {
        let input = CreatorInput {
            creator: vec!["   ".into()],
            artist: Some("  ".into()),
            byline: vec!["".into()],
        };
        assert!(normalise_creator(&input).is_none());
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = CreatorInput {
            artist: Some("Alice; Bob".into()),
            ..Default::default()
        };
        let first = normalise_creator(&initial).unwrap();
        let canonical = list(&first, "XMP-dc:Creator");

        let post = CreatorInput {
            creator: canonical.clone(),
            artist: Some(canonical.join(ARTIST_SEPARATOR)),
            byline: canonical,
        };
        assert!(normalise_creator(&post).is_none());
    }

    #[test]
    fn single_source_propagates_to_all_targets() {
        let input = CreatorInput {
            creator: vec!["Alice".into()],
            ..Default::default()
        };
        let out = normalise_creator(&input).unwrap();
        assert_eq!(string(&out, "EXIF:Artist"), "Alice");
        assert_eq!(list(&out, "IPTC:By-line"), vec!["Alice".to_string()]);
    }

    #[test]
    fn artist_with_no_separator_treated_as_single_name() {
        let input = CreatorInput {
            artist: Some("Alice Smith".into()),
            ..Default::default()
        };
        let out = normalise_creator(&input).unwrap();
        assert_eq!(
            list(&out, "XMP-dc:Creator"),
            vec!["Alice Smith".to_string()],
        );
    }

    #[test]
    fn artist_split_trims_each_name() {
        let input = CreatorInput {
            artist: Some(" Alice ;Bob ; ; Carol ".into()),
            ..Default::default()
        };
        let out = normalise_creator(&input).unwrap();
        assert_eq!(
            list(&out, "XMP-dc:Creator"),
            vec!["Alice".to_string(), "Bob".to_string(), "Carol".to_string()],
        );
    }
}
