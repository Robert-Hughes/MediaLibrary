//! Group A — Keywords.
//!
//! Plan §1 Group A. Canonical form: bag of `Parent|Child|Leaf`
//! hierarchical paths, every component lowercase + hyphen-separated.
//! Both the hierarchical bag and the derived flat fields are sorted
//! alphabetically (full path string for the hierarchical bag, leaf
//! string for the flat fields) so the primary and derivatives stay
//! visibly consistent and re-runs are byte-stable.
//!
//! Conflict policy: always-union (no AI). Multiple non-empty distinct
//! sources are merged. Flat keywords that already appear as a leaf of
//! some hierarchical path are absorbed; orphan flat keywords are
//! promoted to degenerate single-component paths.

use super::{
    bag_edit, join_hierarchical_path, normalise_keyword, split_hierarchical_path, GroupOutput,
    KeywordsInput,
};
use crate::draft_edits::DraftEdit;
use std::collections::{HashMap, HashSet};

/// Target tags written by Group A. Coherent-replacement rule (plan §4)
/// means every entry here either gets a set-value draft (canonical
/// non-empty) or a remove-tag draft (canonical empty). Read-only
/// input tags (`XMP-mlib:AITags`, `XMP-mlib:AIObjects`) are NOT in
/// this list and never get drafts.
pub const KEYWORDS_TARGET_TAGS: &[&str] = &[
    "XMP-lr:HierarchicalSubject",
    "XMP-dc:Subject",
    "IPTC:Keywords",
];

/// Derive the canonical Group A bag for one image.
///
/// Returns `(paths, leaves)` where `paths` is the canonical bag of
/// `Parent|Child|Leaf` strings and `leaves` is the sorted unique set
/// of leaf components projected for the flat derivative fields. Both
/// are post-normalisation.
///
/// The union rule (plan §1 Group A, "Derivation — union across all
/// sources") is:
///   1. Every path from `hierarchical_subject` (after path-component
///      normalisation, empties dropped).
///   2. Every flat keyword in `dc_subject` ∪ `iptc_keywords` ∪
///      `ai_tags` ∪ `ai_objects` (after normalisation) that is **not
///      already the leaf of some path from step 1**. Each such orphan
///      flat keyword is promoted to a degenerate single-component
///      path.
///
/// Dedup is by full normalised path string.
pub fn derive_keywords_canonical(input: &KeywordsInput) -> (Vec<String>, Vec<String>) {
    // ── Step 1: normalise hierarchical paths ──
    let mut paths: Vec<String> = Vec::new();
    let mut path_set: HashSet<String> = HashSet::new();
    for raw in &input.hierarchical_subject {
        let components: Vec<String> = split_hierarchical_path(raw)
            .into_iter()
            .map(|c| normalise_keyword(&c))
            .filter(|c| !c.is_empty())
            .collect();
        if components.is_empty() {
            continue;
        }
        let path = join_hierarchical_path(&components);
        if path_set.insert(path.clone()) {
            paths.push(path);
        }
    }

    // Leaves of the hierarchical paths (for absorbing flat keywords
    // that match an existing leaf).
    let mut leaf_set: HashSet<String> = paths
        .iter()
        .filter_map(|p| p.rsplit('|').next().map(|s| s.to_string()))
        .collect();

    // ── Step 2: promote orphan flat keywords ──
    //
    // Walk (dc_subject → iptc_keywords → ai_tags → ai_objects) to gather
    // orphans. Discovery order is unimportant — `paths` is sorted at the
    // end of derivation — but the fixed walk order keeps the
    // pre-sort state deterministic for debugging.
    for flat_source in [
        &input.dc_subject,
        &input.iptc_keywords,
        &input.ai_tags,
        &input.ai_objects,
    ] {
        for raw in flat_source.iter() {
            let leaf = normalise_keyword(raw);
            if leaf.is_empty() || leaf_set.contains(&leaf) {
                continue;
            }
            if path_set.insert(leaf.clone()) {
                paths.push(leaf.clone());
                leaf_set.insert(leaf);
            }
        }
    }

    // Sort the hierarchical bag alphabetically by full path string.
    // XMP bag semantics are unordered (readers must not infer meaning
    // from order), so we are free to pick any canonical order. Sorting
    // matches Lightroom / Bridge / digiKam conventions, keeps the
    // hierarchical primary visibly consistent with the sorted flat
    // derivatives below, and makes re-runs byte-stable regardless of
    // which source supplied a tag first.
    paths.sort();

    // Leaves projected for the flat derivative fields: sorted unique.
    let mut leaves: Vec<String> = paths
        .iter()
        .filter_map(|p| p.rsplit('|').next().map(|s| s.to_string()))
        .collect();
    leaves.sort();
    leaves.dedup();

    (paths, leaves)
}

/// True if the image's keyword fields are already in canonical form
/// AND in sync with each other — re-running the group would be a
/// no-op. See plan §5 (idempotency detector).
fn keywords_is_normalised(
    input: &KeywordsInput,
    canonical_paths: &[String],
    canonical_leaves: &[String],
) -> bool {
    if input.hierarchical_subject.len() != canonical_paths.len() {
        return false;
    }
    for (existing, canonical) in input.hierarchical_subject.iter().zip(canonical_paths) {
        if existing != canonical {
            return false;
        }
    }
    if input.dc_subject != canonical_leaves {
        return false;
    }
    if input.iptc_keywords != canonical_leaves {
        return false;
    }
    true
}

/// Run Group A (Keywords) normalisation for one image.
///
/// Takes the canonical bag precomputed by `derive_keywords_canonical`
/// so the dispatcher can capture the leaves for pass-2 context without
/// re-deriving them.
///
/// Returns `None` when the group is a no-op (idempotency detector
/// reports already-normalised, or all sources empty). Otherwise emits
/// set-value drafts for every Group A target tag whose existing value
/// differs from the canonical projection; an all-empty canonical
/// yields a no-op rather than a flood of remove-tag drafts (plan §4
/// "all-empty groups").
pub fn normalise_keywords_with_canonical(
    input: &KeywordsInput,
    canonical_paths: &[String],
    canonical_leaves: &[String],
) -> Option<GroupOutput> {
    if canonical_paths.is_empty() {
        return None;
    }
    if keywords_is_normalised(input, canonical_paths, canonical_leaves) {
        return None;
    }
    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    edits.insert(
        "XMP-lr:HierarchicalSubject".to_string(),
        bag_edit(canonical_paths),
    );
    edits.insert("XMP-dc:Subject".to_string(), bag_edit(canonical_leaves));
    edits.insert("IPTC:Keywords".to_string(), bag_edit(canonical_leaves));

    Some(GroupOutput { edits })
}

/// Convenience wrapper that derives the canonical bag internally.
/// Callers that already have a canonical (e.g. the dispatcher) should
/// use `normalise_keywords_with_canonical` directly.
pub fn normalise_keywords(input: &KeywordsInput) -> Option<GroupOutput> {
    let (canonical_paths, canonical_leaves) = derive_keywords_canonical(input);
    normalise_keywords_with_canonical(input, &canonical_paths, &canonical_leaves)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::Variant;

    fn paths_of(g: &GroupOutput, key: &str) -> Vec<String> {
        match &g.edits.get(key).unwrap().value {
            Some(Variant::List(items)) => items
                .iter()
                .map(|v| match v {
                    Variant::String(s) => s.clone(),
                    _ => panic!("expected String variant in bag"),
                })
                .collect(),
            other => panic!("expected List variant for {}, got {:?}", key, other),
        }
    }

    #[test]
    fn worked_example_from_plan() {
        let input = KeywordsInput {
            hierarchical_subject: vec!["A|B|C".into(), "1|2|3".into()],
            iptc_keywords: vec!["C".into(), "D".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).expect("non-empty input → drafts");
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["1|2|3".to_string(), "a|b|c".to_string(), "d".to_string()],
        );
        assert_eq!(
            paths_of(&out, "XMP-dc:Subject"),
            vec!["3".to_string(), "c".to_string(), "d".to_string()],
        );
        assert_eq!(
            paths_of(&out, "IPTC:Keywords"),
            vec!["3".to_string(), "c".to_string(), "d".to_string()],
        );
    }

    #[test]
    fn flat_keyword_matching_existing_leaf_is_absorbed() {
        let input = KeywordsInput {
            hierarchical_subject: vec!["A|B|C".into()],
            dc_subject: vec!["C".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).unwrap();
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["a|b|c".to_string()],
        );
        assert_eq!(paths_of(&out, "XMP-dc:Subject"), vec!["c".to_string()]);
    }

    #[test]
    fn ai_tags_and_ai_objects_are_unioned_too() {
        let input = KeywordsInput {
            ai_tags: vec!["lion".into()],
            ai_objects: vec!["statue".into(), "lion".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).unwrap();
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["lion".to_string(), "statue".to_string()],
        );
        assert_eq!(
            paths_of(&out, "XMP-dc:Subject"),
            vec!["lion".to_string(), "statue".to_string()],
        );
    }

    #[test]
    fn capitalisation_and_separators_get_normalised() {
        let input = KeywordsInput {
            iptc_keywords: vec![
                "New_York".into(),
                "los angeles".into(),
                "SAN-FRANCISCO".into(),
            ],
            ..Default::default()
        };
        let out = normalise_keywords(&input).unwrap();
        let leaves = paths_of(&out, "XMP-dc:Subject");
        assert!(leaves.contains(&"new-york".to_string()));
        assert!(leaves.contains(&"los-angeles".to_string()));
        assert!(leaves.contains(&"san-francisco".to_string()));
    }

    #[test]
    fn duplicate_paths_are_deduped() {
        let input = KeywordsInput {
            hierarchical_subject: vec![
                "Travel|France|Paris".into(),
                "travel|france|paris".into(),
                "TRAVEL|FRANCE|PARIS".into(),
            ],
            ..Default::default()
        };
        let out = normalise_keywords(&input).unwrap();
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["travel|france|paris".to_string()],
        );
    }

    #[test]
    fn all_empty_input_returns_no_drafts() {
        let input = KeywordsInput::default();
        assert!(normalise_keywords(&input).is_none());
    }

    #[test]
    fn all_whitespace_input_returns_no_drafts() {
        let input = KeywordsInput {
            hierarchical_subject: vec!["   ".into(), "|".into(), "||".into()],
            dc_subject: vec!["".into(), "   ".into()],
            ..Default::default()
        };
        assert!(normalise_keywords(&input).is_none());
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = KeywordsInput {
            hierarchical_subject: vec!["A|B|C".into()],
            iptc_keywords: vec!["D".into()],
            ..Default::default()
        };
        let first = normalise_keywords(&initial).unwrap();
        let new_paths = paths_of(&first, "XMP-lr:HierarchicalSubject");
        let new_leaves = paths_of(&first, "XMP-dc:Subject");
        let post = KeywordsInput {
            hierarchical_subject: new_paths.clone(),
            dc_subject: new_leaves.clone(),
            iptc_keywords: new_leaves.clone(),
            ..Default::default()
        };
        assert!(normalise_keywords(&post).is_none());
    }

    #[test]
    fn equal_but_unnormalised_triggers_normalisation() {
        let input = KeywordsInput {
            hierarchical_subject: vec!["Tower".into()],
            dc_subject: vec!["Tower".into()],
            iptc_keywords: vec!["Tower".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).expect("uppercase 'Tower' must normalise");
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["tower".to_string()],
        );
        assert_eq!(paths_of(&out, "XMP-dc:Subject"), vec!["tower".to_string()]);
    }

    #[test]
    fn ai_input_alone_triggers_normalisation() {
        let input = KeywordsInput {
            ai_tags: vec!["holiday".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).expect("AI-only input must still emit drafts");
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["holiday".to_string()],
        );
    }

    #[test]
    fn hierarchical_bag_is_sorted_alphabetically() {
        // Sources deliberately supplied out of alphabetical order to
        // prove the canonical bag is sorted regardless of input order.
        let input = KeywordsInput {
            hierarchical_subject: vec!["Zebra".into(), "Apple|Pie".into(), "Middle".into()],
            iptc_keywords: vec!["banana".into()],
            ai_tags: vec!["yak".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).unwrap();
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec![
                "apple|pie".to_string(),
                "banana".to_string(),
                "middle".to_string(),
                "yak".to_string(),
                "zebra".to_string(),
            ],
        );
        // Flat derivatives are leaves of the same sorted bag.
        assert_eq!(
            paths_of(&out, "XMP-dc:Subject"),
            vec![
                "banana".to_string(),
                "middle".to_string(),
                "pie".to_string(),
                "yak".to_string(),
                "zebra".to_string(),
            ],
        );
    }

    #[test]
    fn unsorted_existing_hierarchy_triggers_resort() {
        // Already-normalised content (lowercase, hyphenated) but in a
        // non-sorted order should still trigger a draft so the bag
        // becomes sorted.
        let input = KeywordsInput {
            hierarchical_subject: vec!["zebra".into(), "apple".into()],
            dc_subject: vec!["apple".into(), "zebra".into()],
            iptc_keywords: vec!["apple".into(), "zebra".into()],
            ..Default::default()
        };
        let out =
            normalise_keywords(&input).expect("unsorted hierarchy must redraft into sorted order");
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["apple".to_string(), "zebra".to_string()],
        );
    }

    #[test]
    fn multi_hierarchy_with_orphan_keyword() {
        let input = KeywordsInput {
            hierarchical_subject: vec!["Travel|France|Paris".into(), "People|Family|Mum".into()],
            iptc_keywords: vec!["Mum".into(), "Eiffel-Tower".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).unwrap();
        let paths = paths_of(&out, "XMP-lr:HierarchicalSubject");
        assert_eq!(paths.len(), 3);
        assert!(paths.contains(&"travel|france|paris".to_string()));
        assert!(paths.contains(&"people|family|mum".to_string()));
        assert!(paths.contains(&"eiffel-tower".to_string()));
    }
}
