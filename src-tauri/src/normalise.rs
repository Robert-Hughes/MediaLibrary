//! Metadata-normalisation batch feature.
//!
//! See `docs/NORMALISE_METADATA_PLAN.md` for the full design. This module
//! holds:
//!
//! - The shared wire types passed from the frontend per image
//!   ([`NormaliseRequestItem`], [`GroupInputs`]).
//! - The per-group enum ([`NormaliseGroup`]) the user toggles in the
//!   confirm dialog.
//! - The per-group output shape ([`GroupOutput`]) — a draft-edit bag
//!   under the coherent-replacement rule (set-value drafts for fields in
//!   the canonical projection, remove-tag drafts for fields absent from
//!   it).
//! - Free functions per group (`normalise_keywords`, `normalise_title`,
//!   etc.) that consume their slice of [`GroupInputs`] and return either
//!   `None` (idempotency no-op or all-empty) or `Some(GroupOutput)`.
//! - The [`NormaliseJob`] driver that walks enabled groups in pass order
//!   and assembles draft edits per image.
//!
//! The free-functions / no-state pattern keeps groups testable in
//! isolation without spinning up a Tauri app, an HTTP client, or the
//! draft store. AI calls (Group B description merge, Group C title
//! generation) are deferred to v2 of the feature.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;

/// The eight semantic groups the user can toggle on/off in the confirm
/// dialog. See plan §1 for the definition of each group, its target /
/// derivative fields, and conflict policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum NormaliseGroup {
    Keywords,
    Description,
    Title,
    Headline,
    Creator,
    Copyright,
    Location,
    Dates,
}

impl NormaliseGroup {
    /// All groups in canonical wire order. Used by the frontend to
    /// build the per-group checkbox list and by the dispatcher to walk
    /// enabled groups deterministically.
    pub const ALL: &'static [NormaliseGroup] = &[
        NormaliseGroup::Keywords,
        NormaliseGroup::Creator,
        NormaliseGroup::Copyright,
        NormaliseGroup::Location,
        NormaliseGroup::Dates,
        NormaliseGroup::Description,
        NormaliseGroup::Title,
        NormaliseGroup::Headline,
    ];

    pub fn as_wire(&self) -> &'static str {
        match self {
            NormaliseGroup::Keywords => "keywords",
            NormaliseGroup::Description => "description",
            NormaliseGroup::Title => "title",
            NormaliseGroup::Headline => "headline",
            NormaliseGroup::Creator => "creator",
            NormaliseGroup::Copyright => "copyright",
            NormaliseGroup::Location => "location",
            NormaliseGroup::Dates => "dates",
        }
    }
}

/// Resolved per-field input bundle for one image, shipped from the
/// frontend so the backend never needs to read the typed-draft JSONL
/// during a run.
///
/// The front end resolves the draft-overlay (draft beats metadata) for
/// every relevant target / read-only field across all enabled groups
/// and passes the resulting strings here. See plan §3.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct GroupInputs {
    /// Group A (Keywords) sources. `None` when the group is not enabled
    /// or when no relevant fields exist on the image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<KeywordsInput>,
    // Future groups land here as they are implemented:
    //   pub description: Option<DescriptionInput>,
    //   pub title: Option<TitleInput>,
    //   pub headline: Option<HeadlineInput>,
    //   pub creator: Option<CreatorInput>,
    //   pub copyright: Option<CopyrightInput>,
    //   pub location: Option<LocationInput>,
    //   pub dates: Option<DatesInput>,
}

/// Keywords-group input bundle (plan §1 Group A).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct KeywordsInput {
    /// `XMP-lr:HierarchicalSubject` — Bag of `Parent|Child|Leaf` paths.
    #[serde(default)]
    pub hierarchical_subject: Vec<String>,
    /// `XMP-dc:Subject` — Bag of flat keywords.
    #[serde(default)]
    pub dc_subject: Vec<String>,
    /// `IPTC:Keywords` — Bag of flat keywords.
    #[serde(default)]
    pub iptc_keywords: Vec<String>,
    /// `XMP-mlib:AITags` — Bag of flat keywords (read-only input).
    #[serde(default)]
    pub ai_tags: Vec<String>,
    /// `XMP-mlib:AIObjects` — Bag of flat keywords (read-only input).
    #[serde(default)]
    pub ai_objects: Vec<String>,
}

/// One image's payload shipped to `normalise_metadata_cmd`.
///
/// `enabled_groups` lives on the request itself (not the image) but is
/// included here for the per-image dispatcher to consult cheaply
/// without a back-reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct NormaliseRequestItem {
    pub rel_path: String,
    #[serde(default)]
    pub group_inputs: GroupInputs,
}

/// Per-group result: the set of draft edits to apply for this group.
///
/// Under the coherent-replacement rule (plan §4) a group either emits
/// `None` (idempotency no-op or all-empty inputs — no drafts at all)
/// or emits `Some(GroupOutput)` covering every target field of the
/// group: set-value drafts for fields present in the canonical
/// projection, remove-tag drafts for fields absent from it.
#[derive(Debug, Clone, Default)]
pub struct GroupOutput {
    pub edits: HashMap<String, DraftEdit>,
}

impl GroupOutput {
    pub fn is_empty(&self) -> bool {
        self.edits.is_empty()
    }
}

// ── Shared normalisation utilities ─────────────────────────────────────

/// Lowercase + hyphen-separated normalisation for keyword leaves and
/// hierarchical-path components.
///
/// Plan §1 Group A canonical form: `"new-york"`, not `"New_York"` or
/// `"NewYork"`. Internal whitespace, underscores, and existing hyphens
/// are collapsed into single hyphens; leading/trailing separators are
/// trimmed; empty components are dropped by the caller (this function
/// itself returns the empty string if its input is whitespace-only).
pub fn normalise_keyword(s: &str) -> String {
    // Lowercase, then map any run of separator chars (whitespace, `_`,
    // `-`) to a single `-`. Don't split CamelCase into hyphenated words
    // — that risks mangling proper nouns (`McDonalds` → `mc-donalds`)
    // and the plan example uses already-spaced inputs.
    let lowered = s.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut last_was_sep = true; // suppress leading separators
    for c in lowered.chars() {
        if c.is_whitespace() || c == '_' || c == '-' {
            if !last_was_sep {
                out.push('-');
                last_was_sep = true;
            }
        } else {
            out.push(c);
            last_was_sep = false;
        }
    }
    // Trim trailing separator (loop appended one when the last input
    // char was a separator).
    if out.ends_with('-') {
        out.pop();
    }
    out
}

/// Split a `Parent|Child|Leaf` hierarchical-subject string into its
/// components, dropping empty segments and trimming whitespace from
/// each.
pub fn split_hierarchical_path(s: &str) -> Vec<String> {
    s.split('|')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string())
        .collect()
}

/// Join hierarchical-path components into `Parent|Child|Leaf` form.
pub fn join_hierarchical_path(components: &[String]) -> String {
    components.join("|")
}

// ── Group A: Keywords ──────────────────────────────────────────────────
//
// Plan §1 Group A. Canonical form: bag of `Parent|Child|Leaf`
// hierarchical paths, every component lowercase + hyphen-separated.
// Derived flat fields are sorted unique leaves.
//
// Conflict policy: always-union (no AI). Multiple non-empty distinct
// sources are merged. Flat keywords that already appear as a leaf of
// some hierarchical path are absorbed; orphan flat keywords are
// promoted to degenerate single-component paths.

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
    // Preserve discovery order across (dc_subject → iptc_keywords →
    // ai_tags → ai_objects) so the canonical bag has a deterministic
    // ordering for re-runs. Each orphan promotes to its own path; the
    // path is then added to `path_set` so a later duplicate is
    // absorbed.
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
fn keywords_is_normalised(input: &KeywordsInput, canonical_paths: &[String], canonical_leaves: &[String]) -> bool {
    // Every existing hierarchical path must already be in normalised
    // form *and* the bag must equal the canonical bag — order
    // included, because the canonical bag's order is the
    // discovery-order rule above.
    if input.hierarchical_subject.len() != canonical_paths.len() {
        return false;
    }
    for (existing, canonical) in input.hierarchical_subject.iter().zip(canonical_paths) {
        if existing != canonical {
            return false;
        }
    }

    // Flat derivative fields must equal the sorted leaves. The
    // canonical projection is sorted; if the existing field is in a
    // different order or has duplicates, we consider it not yet
    // normalised so the run emits a draft to fix it.
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
/// Returns `None` when the group is a no-op (idempotency detector
/// reports already-normalised, or all sources empty). Otherwise emits
/// set-value drafts for every Group A target tag whose existing value
/// differs from the canonical projection; an all-empty canonical
/// yields a no-op rather than a flood of remove-tag drafts (plan §4
/// "all-empty groups").
pub fn normalise_keywords(input: &KeywordsInput) -> Option<GroupOutput> {
    let (canonical_paths, canonical_leaves) = derive_keywords_canonical(input);

    // All-empty group → no drafts (plan §4 all-empty rule). Note that
    // *all* sources, including read-only AI inputs, must be empty —
    // otherwise the canonical would have non-empty entries.
    if canonical_paths.is_empty() {
        return None;
    }

    if keywords_is_normalised(input, &canonical_paths, &canonical_leaves) {
        return None;
    }

    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    edits.insert(
        "XMP-lr:HierarchicalSubject".to_string(),
        bag_edit(&canonical_paths),
    );
    edits.insert("XMP-dc:Subject".to_string(), bag_edit(&canonical_leaves));
    edits.insert("IPTC:Keywords".to_string(), bag_edit(&canonical_leaves));

    Some(GroupOutput { edits })
}

/// Build a set-value draft for a Bag-of-Text tag from a list of
/// canonical strings.
fn bag_edit(items: &[String]) -> DraftEdit {
    let value = Variant::List(items.iter().cloned().map(Variant::String).collect());
    DraftEdit {
        value: Some(value),
        intent: EditIntent::Set,
        display: None,
    }
}

#[cfg(test)]
mod tests_keywords {
    use super::*;

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
        // Plan §1 Group A worked example:
        //   HierarchicalSubject = [A|B|C, 1|2|3], Keywords = [C, D]
        //   → canonical paths = [A|B|C, 1|2|3, D]
        //
        // Inputs are upper-case here; the normaliser lowercases.
        let input = KeywordsInput {
            hierarchical_subject: vec!["A|B|C".into(), "1|2|3".into()],
            iptc_keywords: vec!["C".into(), "D".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).expect("non-empty input → drafts");
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["a|b|c".to_string(), "1|2|3".to_string(), "d".to_string()],
        );
        // Sorted unique leaves: lex sort over "3" < "c" < "d".
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
        // "C" appears as the leaf of "A|B|C" — must not promote to a
        // duplicate degenerate path.
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
        // Plan: read-only inputs `XMP-mlib:AITags` and `XMP-mlib:AIObjects`
        // feed the union step. They are not written to (read-only) but
        // their contents end up in the canonical bag via the flat
        // promotion rule.
        let input = KeywordsInput {
            ai_tags: vec!["lion".into()],
            ai_objects: vec!["statue".into(), "lion".into()],
            ..Default::default()
        };
        let out = normalise_keywords(&input).unwrap();
        // Discovery order: ai_tags first, then ai_objects with the
        // "lion" duplicate absorbed.
        assert_eq!(
            paths_of(&out, "XMP-lr:HierarchicalSubject"),
            vec!["lion".to_string(), "statue".to_string()],
        );
        // Leaves are sorted.
        assert_eq!(
            paths_of(&out, "XMP-dc:Subject"),
            vec!["lion".to_string(), "statue".to_string()],
        );
    }

    #[test]
    fn capitalisation_and_separators_get_normalised() {
        let input = KeywordsInput {
            iptc_keywords: vec!["New_York".into(), "los angeles".into(), "SAN-FRANCISCO".into()],
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
        // First pass.
        let initial = KeywordsInput {
            hierarchical_subject: vec!["A|B|C".into()],
            iptc_keywords: vec!["D".into()],
            ..Default::default()
        };
        let first = normalise_keywords(&initial).unwrap();
        let new_paths = paths_of(&first, "XMP-lr:HierarchicalSubject");
        let new_leaves = paths_of(&first, "XMP-dc:Subject");

        // Build "post-apply" state.
        let post = KeywordsInput {
            hierarchical_subject: new_paths.clone(),
            dc_subject: new_leaves.clone(),
            iptc_keywords: new_leaves.clone(),
            ..Default::default()
        };

        // Second pass over the post-apply state must produce no
        // drafts.
        assert!(normalise_keywords(&post).is_none());
    }

    #[test]
    fn equal_but_unnormalised_triggers_normalisation() {
        // Plan §5: equal mirrors but not in normal form must still
        // trigger drafts so the case/separator/etc. is fixed.
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
        // The AI inputs ai_tags / ai_objects are read-only inputs but
        // they still drive the canonical bag — if they are the only
        // non-empty source, drafts get emitted for the three target
        // tags so the hierarchy/flat fields land for the user.
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
    fn multi_hierarchy_with_orphan_keyword() {
        // Several hierarchies on one image. A flat keyword that
        // matches a leaf of any hierarchy gets absorbed; otherwise it
        // promotes.
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

#[cfg(test)]
mod tests_shared {
    use super::*;

    #[test]
    fn normalise_keyword_lowercases_and_hyphenates() {
        assert_eq!(normalise_keyword("New York"), "new-york");
        assert_eq!(normalise_keyword("New_York"), "new-york");
        assert_eq!(normalise_keyword("New-York"), "new-york");
        assert_eq!(normalise_keyword("  new   york  "), "new-york");
    }

    #[test]
    fn normalise_keyword_preserves_compound_words() {
        // We deliberately do NOT split CamelCase — risks mangling
        // proper nouns and the plan example uses already-spaced
        // inputs.
        assert_eq!(normalise_keyword("McDonalds"), "mcdonalds");
        assert_eq!(normalise_keyword("NewYork"), "newyork");
    }

    #[test]
    fn normalise_keyword_collapses_separator_runs() {
        assert_eq!(normalise_keyword("a___b---c   d"), "a-b-c-d");
    }

    #[test]
    fn normalise_keyword_empty_input_returns_empty() {
        assert_eq!(normalise_keyword(""), "");
        assert_eq!(normalise_keyword("   "), "");
        assert_eq!(normalise_keyword("___"), "");
    }

    #[test]
    fn split_hierarchical_path_basic() {
        assert_eq!(
            split_hierarchical_path("A|B|C"),
            vec!["A".to_string(), "B".to_string(), "C".to_string()],
        );
    }

    #[test]
    fn split_hierarchical_path_drops_empties_and_trims() {
        assert_eq!(
            split_hierarchical_path("  A  | | B||C  "),
            vec!["A".to_string(), "B".to_string(), "C".to_string()],
        );
    }

    #[test]
    fn join_hierarchical_path_basic() {
        assert_eq!(
            join_hierarchical_path(&["A".into(), "B".into(), "C".into()]),
            "A|B|C",
        );
    }

    #[test]
    fn normalise_group_wire_strings_are_snake_case() {
        for g in NormaliseGroup::ALL {
            // Every variant must serialise to a non-empty wire string
            // and round-trip through serde.
            let wire = g.as_wire();
            assert!(!wire.is_empty());
            let json = serde_json::to_string(g).unwrap();
            assert_eq!(json, format!("\"{}\"", wire));
            let parsed: NormaliseGroup = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, *g);
        }
    }
}
