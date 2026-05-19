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
use std::collections::HashMap;

use crate::draft_edits::DraftEdit;

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
