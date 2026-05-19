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
    /// Group E (Creator) sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<CreatorInput>,
    /// Group F (Copyright) sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copyright: Option<CopyrightInput>,
    /// Group D (Headline) sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<HeadlineInput>,
    /// Group C (Title) sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<TitleInput>,
    /// Group G (Location XMP↔IIM mirror sync) sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<LocationInput>,
    // Future groups land here as they are implemented:
    //   pub description: Option<DescriptionInput>,
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

/// Creator-group input bundle (plan §1 Group E).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct CreatorInput {
    /// `XMP-dc:Creator` — Seq of strings (ordered, primary).
    #[serde(default)]
    pub creator: Vec<String>,
    /// `EXIF:Artist` — single string, semicolon-separated when there
    /// are multiple names. `None` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// `IPTC:By-line` — repeated string.
    #[serde(default)]
    pub byline: Vec<String>,
}

/// Copyright-group input bundle (plan §1 Group F).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct CopyrightInput {
    /// `XMP-dc:Rights` (LangAlt x-default, primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rights: Option<String>,
    /// `EXIF:Copyright` (ASCII string).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exif_copyright: Option<String>,
    /// `IPTC:CopyrightNotice`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_copyright: Option<String>,
}

/// Headline-group input bundle (plan §1 Group D).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct HeadlineInput {
    /// `XMP-photoshop:Headline` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photoshop_headline: Option<String>,
    /// `IPTC:Headline` (derivative; 256-char IIM limit applied on
    /// write).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_headline: Option<String>,
}

/// Title-group input bundle (plan §1 Group C).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct TitleInput {
    /// `XMP-dc:Title` (LangAlt x-default, primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `IPTC:ObjectName` (derivative; 64-char IIM limit applied on
    /// write).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_name: Option<String>,
    /// Read-only input populated by the Group B (Description) pass:
    /// the canonical description from the same image. Used by the
    /// case-3 AI title-generation branch (plan §1 Group C) — deferred
    /// to v2 of the feature; v1 ignores this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_canonical: Option<String>,
}

/// Location-group input bundle (plan §1 Group G).
///
/// Group G is five independent XMP↔IIM mirror pairs; the bundle ships
/// one `Option<String>` per side per pair. Reverse-geocoding fills
/// these via the existing Reverse Geocode feature; normalising only
/// brings them into sync.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct LocationInput {
    /// `XMP-iptcCore:Location` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_xmp: Option<String>,
    /// `IPTC:Sub-location` (derivative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_iptc: Option<String>,
    /// `XMP-photoshop:City` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city_xmp: Option<String>,
    /// `IPTC:City` (derivative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city_iptc: Option<String>,
    /// `XMP-photoshop:State` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_xmp: Option<String>,
    /// `IPTC:Province-State` (derivative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_iptc: Option<String>,
    /// `XMP-photoshop:Country` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_xmp: Option<String>,
    /// `IPTC:Country-PrimaryLocationName` (derivative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_iptc: Option<String>,
    /// `XMP-iptcCore:CountryCode` (primary, ISO 3166-1 alpha-2,
    /// uppercased on normalisation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_code_xmp: Option<String>,
    /// `IPTC:Country-PrimaryLocationCode` (derivative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_code_iptc: Option<String>,
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

// ── Group E: Creator ───────────────────────────────────────────────────
//
// Plan §1 Group E. Canonical = ordered Seq of names, kept verbatim
// (no name normalisation). Union of all non-empty sources, dedup
// case-sensitive, preserve first-seen order.

/// Target tags written by Group E. Coherent-replacement rule (plan §4).
pub const CREATOR_TARGET_TAGS: &[&str] = &[
    "XMP-dc:Creator",
    "EXIF:Artist",
    "IPTC:By-line",
];

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
    // Discovery order: dc:Creator first (the modern primary), then
    // EXIF:Artist, then IPTC:By-line.
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
            // Case-sensitive dedup per plan: "John Smith" and "john
            // smith" are different names.
            if seen.insert(trimmed.to_string()) {
                canonical.push(trimmed.to_string());
            }
        }
    }
    canonical
}

fn creator_is_normalised(input: &CreatorInput, canonical: &[String]) -> bool {
    // Primary must equal canonical (order included).
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
mod tests_creator {
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
        // dc:Creator first wins for order; Carol from artist dedups
        // against byline's Carol; Dave appended last.
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
        // Plan §1 Group E: "do not 'normalise' name capitalisation or
        // order; risk of mangling non-English names outweighs benefit."
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
        // "Alice" and "alice" are different names.
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
        // Plan §1 conflict policy "Pick a canonical value, then project
        // to all derivatives". One source non-empty → fill the rest.
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

// ── Group F: Copyright ─────────────────────────────────────────────────
//
// Plan §1 Group F. Canonical = single-line string, leading/trailing
// whitespace trimmed. No tone/tense normalisation. No AI.
//
// Conflict policy: pick a canonical, then project.
//   1. Primary non-empty → canonical = normalise(primary).
//   2. Primary empty, ≥1 derivative non-empty → canonical =
//      normalise(longest non-empty derivative). The only group where
//      length-based pick is used; copyright notices are typically
//      appended to, so the longest is usually the most complete.
//   3. All target empty → no drafts.

pub const COPYRIGHT_TARGET_TAGS: &[&str] = &[
    "XMP-dc:Rights",
    "EXIF:Copyright",
    "IPTC:CopyrightNotice",
];

fn normalise_copyright_text(s: &str) -> String {
    // Single-line: collapse any whitespace (including newlines) into a
    // single space, then trim ends. Preserves all original characters
    // so authorship year/symbol stays intact.
    let mut out = String::with_capacity(s.len());
    let mut last_was_ws = true;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_was_ws {
                out.push(' ');
                last_was_ws = true;
            }
        } else {
            out.push(c);
            last_was_ws = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn derive_copyright_canonical(input: &CopyrightInput) -> Option<String> {
    if let Some(primary) = input.rights.as_deref() {
        let n = normalise_copyright_text(primary);
        if !n.is_empty() {
            return Some(n);
        }
    }
    // Primary empty: longest non-empty derivative wins.
    let derivatives: [&Option<String>; 2] = [&input.exif_copyright, &input.iptc_copyright];
    let mut best: Option<String> = None;
    for d in derivatives.iter() {
        if let Some(v) = d.as_deref() {
            let n = normalise_copyright_text(v);
            if n.is_empty() {
                continue;
            }
            if best.as_deref().map(|b| b.len() < n.len()).unwrap_or(true) {
                best = Some(n);
            }
        }
    }
    best
}

fn copyright_is_normalised(input: &CopyrightInput, canonical: &str) -> bool {
    input.rights.as_deref() == Some(canonical)
        && input.exif_copyright.as_deref() == Some(canonical)
        && input.iptc_copyright.as_deref() == Some(canonical)
}

/// Run Group F (Copyright) normalisation for one image.
pub fn normalise_copyright(input: &CopyrightInput) -> Option<GroupOutput> {
    let canonical = derive_copyright_canonical(input)?;
    if copyright_is_normalised(input, &canonical) {
        return None;
    }
    let edit = DraftEdit {
        value: Some(Variant::String(canonical.clone())),
        intent: EditIntent::Set,
        display: None,
    };
    let mut edits = HashMap::new();
    for tag in COPYRIGHT_TARGET_TAGS {
        edits.insert((*tag).to_string(), edit.clone());
    }
    Some(GroupOutput { edits })
}

#[cfg(test)]
mod tests_copyright {
    use super::*;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String, got {:?}", other),
        }
    }

    #[test]
    fn primary_wins_when_non_empty() {
        let input = CopyrightInput {
            rights: Some("© 2025 Acme".into()),
            exif_copyright: Some("Old EXIF copyright".into()),
            iptc_copyright: None,
        };
        let out = normalise_copyright(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025 Acme");
        assert_eq!(s(&out, "EXIF:Copyright"), "© 2025 Acme");
        assert_eq!(s(&out, "IPTC:CopyrightNotice"), "© 2025 Acme");
    }

    #[test]
    fn longest_derivative_wins_when_primary_empty() {
        let input = CopyrightInput {
            rights: None,
            exif_copyright: Some("© Acme".into()),
            iptc_copyright: Some("© 2025 Acme. All rights reserved.".into()),
        };
        let out = normalise_copyright(&input).unwrap();
        let want = "© 2025 Acme. All rights reserved.";
        assert_eq!(s(&out, "XMP-dc:Rights"), want);
        assert_eq!(s(&out, "EXIF:Copyright"), want);
        assert_eq!(s(&out, "IPTC:CopyrightNotice"), want);
    }

    #[test]
    fn whitespace_normalised_in_canonical() {
        let input = CopyrightInput {
            rights: Some("  ©   2025   Acme \t Corp  ".into()),
            ..Default::default()
        };
        let out = normalise_copyright(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025 Acme Corp");
    }

    #[test]
    fn empty_primary_falls_through_to_derivatives() {
        let input = CopyrightInput {
            rights: Some("   ".into()),
            exif_copyright: Some("© 2025".into()),
            iptc_copyright: None,
        };
        let out = normalise_copyright(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025");
    }

    #[test]
    fn all_empty_returns_no_drafts() {
        assert!(normalise_copyright(&CopyrightInput::default()).is_none());
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = CopyrightInput {
            rights: Some("© 2025 Acme".into()),
            ..Default::default()
        };
        let first = normalise_copyright(&initial).unwrap();
        let c = s(&first, "XMP-dc:Rights");
        let post = CopyrightInput {
            rights: Some(c.clone()),
            exif_copyright: Some(c.clone()),
            iptc_copyright: Some(c),
        };
        assert!(normalise_copyright(&post).is_none());
    }

    #[test]
    fn equal_but_unnormalised_triggers_normalisation() {
        let input = CopyrightInput {
            rights: Some("  © 2025 Acme  ".into()),
            exif_copyright: Some("© 2025 Acme".into()),
            iptc_copyright: Some("© 2025 Acme".into()),
        };
        let out = normalise_copyright(&input).expect("trims primary even when derivatives match");
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025 Acme");
    }
}

// ── Group D: Headline ──────────────────────────────────────────────────
//
// Plan §1 Group D. Canonical = single-sentence headline. No AI.
// Plain whitespace-collapse + trim. Derivative IPTC:Headline has a
// 256-char IIM limit and is truncated at a word boundary.

pub const HEADLINE_TARGET_TAGS: &[&str] = &[
    "XMP-photoshop:Headline",
    "IPTC:Headline",
];

const IPTC_HEADLINE_LIMIT: usize = 256;

fn normalise_headline_text(s: &str) -> String {
    // Single-sentence headlines: same whitespace collapse rule as
    // copyright. Reused but kept separate so each group's policy stays
    // legible.
    normalise_copyright_text(s)
}

/// Truncate `s` to at most `limit` bytes at a word boundary when
/// possible; falls back to a hard char-boundary cut for very long
/// single-word strings.
fn truncate_at_word(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    // Find the last space at or before `limit`.
    let mut cut = limit;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let slice = &s[..cut];
    if let Some(idx) = slice.rfind(' ') {
        slice[..idx].trim_end().to_string()
    } else {
        slice.trim_end().to_string()
    }
}

fn derive_headline_canonical(input: &HeadlineInput) -> Option<String> {
    if let Some(p) = input.photoshop_headline.as_deref() {
        let n = normalise_headline_text(p);
        if !n.is_empty() {
            return Some(n);
        }
    }
    if let Some(d) = input.iptc_headline.as_deref() {
        let n = normalise_headline_text(d);
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
    let mut edits = HashMap::new();
    edits.insert(
        "XMP-photoshop:Headline".to_string(),
        DraftEdit {
            value: Some(Variant::String(canonical.clone())),
            intent: EditIntent::Set,
            display: None,
        },
    );
    edits.insert(
        "IPTC:Headline".to_string(),
        DraftEdit {
            value: Some(Variant::String(iptc)),
            intent: EditIntent::Set,
            display: None,
        },
    );
    Some(GroupOutput { edits })
}

#[cfg(test)]
mod tests_headline {
    use super::*;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String, got {:?}", other),
        }
    }

    #[test]
    fn primary_wins() {
        let input = HeadlineInput {
            photoshop_headline: Some("Climbers descend Mont Blanc".into()),
            iptc_headline: Some("Old IPTC headline".into()),
        };
        let out = normalise_headline(&input).unwrap();
        assert_eq!(s(&out, "XMP-photoshop:Headline"), "Climbers descend Mont Blanc");
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
        // Build a long headline > 256 bytes.
        let long = "word ".repeat(80);
        let trimmed = long.trim_end().to_string();
        assert!(trimmed.len() > IPTC_HEADLINE_LIMIT);
        let input = HeadlineInput {
            photoshop_headline: Some(trimmed.clone()),
            ..Default::default()
        };
        let out = normalise_headline(&input).unwrap();
        // Primary holds the full text.
        assert_eq!(s(&out, "XMP-photoshop:Headline"), trimmed);
        // IPTC derivative ≤ 256 and ends on a word boundary.
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

// ── Group C: Title ─────────────────────────────────────────────────────
//
// Plan §1 Group C. Canonical = short title-case phrase, ≤8 words, no
// trailing punctuation.
//
// v1 deterministic implementation covers cases 1, 2 and 4 of the
// conflict policy (primary wins → derivative wins → all-empty no-op).
// Case 3 (AI-generated title from Group B description) is deferred to
// v2; this v1 simply returns `None` when all targets are empty even if
// `description_canonical` is supplied.
//
// Normalisation here is intentionally narrow: trim whitespace, collapse
// internal whitespace runs, strip trailing punctuation (`. ! ? , : ;`).
// Title-case enforcement is **not** applied — risks mangling proper
// nouns ("iPhone" → "IPhone") without a stopword list. Plan's
// "title-case ≤8 words" constraint is left to the AI generation path
// in v2 when the AI prompt enforces it.

pub const TITLE_TARGET_TAGS: &[&str] = &["XMP-dc:Title", "IPTC:ObjectName"];

const IPTC_OBJECT_NAME_LIMIT: usize = 64;

fn normalise_title_text(s: &str) -> String {
    let collapsed = normalise_copyright_text(s);
    // Strip a single run of trailing punctuation chars.
    collapsed
        .trim_end_matches(|c: char| matches!(c, '.' | '!' | '?' | ',' | ':' | ';'))
        .trim_end()
        .to_string()
}

fn derive_title_canonical(input: &TitleInput) -> Option<String> {
    if let Some(p) = input.title.as_deref() {
        let n = normalise_title_text(p);
        if !n.is_empty() {
            return Some(n);
        }
    }
    if let Some(d) = input.object_name.as_deref() {
        let n = normalise_title_text(d);
        if !n.is_empty() {
            return Some(n);
        }
    }
    // Case 3 (AI title from description) deferred to v2 — even if
    // `description_canonical` is set, v1 emits no drafts here.
    None
}

fn title_is_normalised(input: &TitleInput, canonical: &str) -> bool {
    let object_projection = truncate_at_word(canonical, IPTC_OBJECT_NAME_LIMIT);
    input.title.as_deref() == Some(canonical)
        && input.object_name.as_deref() == Some(object_projection.as_str())
}

/// Run Group C (Title) normalisation for one image — v1 deterministic
/// branches only.
pub fn normalise_title(input: &TitleInput) -> Option<GroupOutput> {
    let canonical = derive_title_canonical(input)?;
    if title_is_normalised(input, &canonical) {
        return None;
    }
    let object = truncate_at_word(&canonical, IPTC_OBJECT_NAME_LIMIT);
    let mut edits = HashMap::new();
    edits.insert(
        "XMP-dc:Title".to_string(),
        DraftEdit {
            value: Some(Variant::String(canonical.clone())),
            intent: EditIntent::Set,
            display: None,
        },
    );
    edits.insert(
        "IPTC:ObjectName".to_string(),
        DraftEdit {
            value: Some(Variant::String(object)),
            intent: EditIntent::Set,
            display: None,
        },
    );
    Some(GroupOutput { edits })
}

#[cfg(test)]
mod tests_title {
    use super::*;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String, got {:?}", other),
        }
    }

    #[test]
    fn primary_wins() {
        let input = TitleInput {
            title: Some("Sunset Over Mont Blanc".into()),
            object_name: Some("Old ObjectName".into()),
            description_canonical: None,
        };
        let out = normalise_title(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Sunset Over Mont Blanc");
        assert_eq!(s(&out, "IPTC:ObjectName"), "Sunset Over Mont Blanc");
    }

    #[test]
    fn primary_empty_uses_derivative() {
        let input = TitleInput {
            title: None,
            object_name: Some("From IPTC".into()),
            description_canonical: None,
        };
        let out = normalise_title(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "From IPTC");
    }

    #[test]
    fn trailing_punctuation_stripped() {
        let input = TitleInput {
            title: Some("Sunset Over Mont Blanc.".into()),
            ..Default::default()
        };
        let out = normalise_title(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Sunset Over Mont Blanc");
    }

    #[test]
    fn trailing_multiple_punctuation_stripped() {
        let input = TitleInput {
            title: Some("Wow!?".into()),
            ..Default::default()
        };
        let out = normalise_title(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Wow");
    }

    #[test]
    fn whitespace_normalised() {
        let input = TitleInput {
            title: Some("  Lots   of   space  ".into()),
            ..Default::default()
        };
        let out = normalise_title(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Lots of space");
    }

    #[test]
    fn capitalisation_preserved() {
        // "iPhone" must survive — we don't enforce title-case in v1.
        let input = TitleInput {
            title: Some("iPhone in the Snow".into()),
            ..Default::default()
        };
        let out = normalise_title(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "iPhone in the Snow");
    }

    #[test]
    fn all_empty_returns_no_drafts_in_v1_even_with_description() {
        // Case-3 AI generation is deferred to v2.
        let input = TitleInput {
            title: None,
            object_name: None,
            description_canonical: Some("A photo of a cat.".into()),
        };
        assert!(normalise_title(&input).is_none());
    }

    #[test]
    fn empty_input_returns_no_drafts() {
        assert!(normalise_title(&TitleInput::default()).is_none());
    }

    #[test]
    fn iptc_object_name_truncated_at_64_bytes() {
        let long = "word ".repeat(20); // 100 bytes
        let trimmed = long.trim_end().to_string();
        let input = TitleInput {
            title: Some(trimmed.clone()),
            ..Default::default()
        };
        let out = normalise_title(&input).unwrap();
        // Primary holds the full text.
        assert_eq!(s(&out, "XMP-dc:Title"), trimmed);
        let obj = s(&out, "IPTC:ObjectName");
        assert!(obj.len() <= IPTC_OBJECT_NAME_LIMIT);
        assert!(!obj.ends_with(' '));
        assert!(obj.ends_with("word"));
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = TitleInput {
            title: Some("My Title".into()),
            ..Default::default()
        };
        let first = normalise_title(&initial).unwrap();
        let post = TitleInput {
            title: Some(s(&first, "XMP-dc:Title")),
            object_name: Some(s(&first, "IPTC:ObjectName")),
            description_canonical: None,
        };
        assert!(normalise_title(&post).is_none());
    }
}

// ── Group G: Location (XMP ↔ IIM mirror sync) ──────────────────────────
//
// Plan §1 Group G. Five XMP↔IIM mirror pairs treated independently.
// Per-pair policy:
//   1. Both empty → no drafts.
//   2. Exactly one non-empty → canonical = that value (uppercased for
//      CountryCode), project to both fields.
//   3. Both non-empty AND equal after canonicalisation → write
//      canonical to both (handles e.g. `gb` vs `GB` for CountryCode).
//   4. Both non-empty AND distinct after canonicalisation → primary
//      (XMP side) wins. Stats: `n_location_xmp_iim_conflict`.
//
// No AI — never AI-merge place names. No reverse-geocoding here;
// Group G only mirrors what is already in metadata.

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

/// Canonicalise a "verbatim text" location field — trim + collapse
/// whitespace. Used for all sub-pairs except CountryCode.
fn canonicalise_location_text(s: &str) -> String {
    normalise_copyright_text(s)
}

/// Canonicalise an ISO 3166-1 alpha-2 country code — trim, collapse,
/// uppercase.
fn canonicalise_country_code(s: &str) -> String {
    canonicalise_location_text(s).to_uppercase()
}

/// Result of processing one XMP↔IIM mirror pair.
struct PairResult {
    /// `Some(canonical)` when the pair contributes drafts;
    /// `None` when the pair is already in sync or both sides empty.
    canonical: Option<String>,
    /// True when both sides were non-empty and disagreed after
    /// canonicalisation — primary won. Surfaced in stats (deferred).
    conflict: bool,
}

fn process_pair(
    xmp: Option<&str>,
    iptc: Option<&str>,
    canon: fn(&str) -> String,
) -> PairResult {
    let xc = xmp.map(canon).filter(|s| !s.is_empty());
    let ic = iptc.map(canon).filter(|s| !s.is_empty());

    let (canonical, conflict) = match (xc, ic) {
        (None, None) => (None, false),
        (Some(v), None) | (None, Some(v)) => (Some(v), false),
        (Some(x), Some(i)) if x == i => (Some(x), false),
        (Some(x), Some(_)) => (Some(x), true), // primary wins
    };
    let canonical = canonical.filter(|c| {
        // Already in sync? Skip emitting drafts.
        let want = Some(c.as_str());
        !(xmp == want && iptc == want)
    });
    PairResult { canonical, conflict }
}

/// Outcome of running Group G on one image. The bool flags how many
/// mirror pairs hit the conflict (case 4) branch — counted into the
/// per-group stats so the user can see if their manual XMP and IIM
/// values disagreed.
#[derive(Debug, Clone, Default)]
pub struct LocationOutcome {
    pub output: Option<GroupOutput>,
    pub n_xmp_iim_conflict: u32,
}

/// Run Group G (Location) normalisation for one image.
pub fn normalise_location(input: &LocationInput) -> LocationOutcome {
    let pairs: [(
        &str, &str, Option<&str>, Option<&str>, fn(&str) -> String,
    ); 5] = [
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
        output: if edits.is_empty() { None } else { Some(GroupOutput { edits }) },
        n_xmp_iim_conflict: conflicts,
    }
}

#[cfg(test)]
mod tests_location {
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
        // Equal-after-canonicalisation: both targets get "GB".
        assert_eq!(s(&out, "XMP-iptcCore:CountryCode"), "GB");
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "GB");
    }

    #[test]
    fn five_pairs_are_independent() {
        // Different pair-level states on one image:
        //   Location  — both empty (skip)
        //   City      — XMP only (copy)
        //   State     — both equal (skip)
        //   Country   — distinct (conflict)
        //   CountryCode — IIM only (copy + uppercase)
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
        // Location pair → no drafts.
        assert!(!g.edits.contains_key("XMP-iptcCore:Location"));
        assert!(!g.edits.contains_key("IPTC:Sub-location"));
        // City pair → both drafts.
        assert_eq!(s(&g, "XMP-photoshop:City"), "Paris");
        assert_eq!(s(&g, "IPTC:City"), "Paris");
        // State pair → already in sync, no drafts.
        assert!(!g.edits.contains_key("XMP-photoshop:State"));
        // Country pair → XMP wins.
        assert_eq!(s(&g, "XMP-photoshop:Country"), "France");
        assert_eq!(s(&g, "IPTC:Country-PrimaryLocationName"), "France");
        // CountryCode pair → IIM-only, uppercased.
        assert_eq!(s(&g, "XMP-iptcCore:CountryCode"), "FR");
        assert_eq!(s(&g, "IPTC:Country-PrimaryLocationCode"), "FR");
        // One conflict counted (Country pair).
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
        // CountryCode: "gb" vs "gb" — equal but not yet uppercased.
        let input = LocationInput {
            country_code_xmp: Some("gb".into()),
            country_code_iptc: Some("gb".into()),
            ..Default::default()
        };
        let out = normalise_location(&input).output.expect("must normalise to uppercase");
        assert_eq!(s(&out, "XMP-iptcCore:CountryCode"), "GB");
        assert_eq!(s(&out, "IPTC:Country-PrimaryLocationCode"), "GB");
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
