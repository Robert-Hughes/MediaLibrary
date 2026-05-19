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
use std::sync::OnceLock;

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
    /// Group H (Dates — H1 Shutter time + H2 Digitised time) sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dates: Option<DatesInput>,
    // Future groups land here as they are implemented:
    //   pub description: Option<DescriptionInput>,
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

/// Dates-group input bundle (plan §1 Group H, H1 + H2 sub-groups).
///
/// H3 (Modify time) is intentionally omitted — exiftool auto-updates
/// modify timestamps on every write, so normalising them is pointless
/// and fights the tool.
///
/// All string fields hold raw values as exiftool emits them; the
/// parser accepts both `"YYYY:MM:DD HH:MM:SS"` (EXIF) and
/// `"YYYY-MM-DDTHH:MM:SS"` (XMP/ISO), with optional sub-second and
/// timezone offset.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct DatesInput {
    // ── H1: Shutter time ──
    /// `EXIF:DateTimeOriginal` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_original: Option<String>,
    /// `EXIF:OffsetTimeOriginal` — `"+01:00"` etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_time_original: Option<String>,
    /// `EXIF:SubSecTimeOriginal` — fractional seconds digits, e.g.
    /// `"123"` meaning `.123`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_sec_time_original: Option<String>,
    /// `XMP-photoshop:DateCreated` — full ISO datetime mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photoshop_date_created: Option<String>,
    /// `IPTC:DateCreated` — `"YYYY-MM-DD"` portion of the H1 mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_date_created: Option<String>,
    /// `IPTC:TimeCreated` — `"HH:MM:SS[±HH:MM]"` portion of H1 mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_time_created: Option<String>,

    // ── H2: Digitised time ──
    /// `EXIF:CreateDate` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_date: Option<String>,
    /// `EXIF:OffsetTime` — paired with `CreateDate` per EXIF spec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_time: Option<String>,
    /// `EXIF:SubSecTimeDigitized` — fractional-seconds digits for H2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_sec_time_digitized: Option<String>,
    /// `XMP-xmp:CreateDate` — full ISO datetime mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xmp_create_date: Option<String>,
    /// `IPTC:DigitalCreationDate` — `"YYYY-MM-DD"` portion of H2 mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_digital_creation_date: Option<String>,
    /// `IPTC:DigitalCreationTime` — `"HH:MM:SS[±HH:MM]"` portion of H2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_digital_creation_time: Option<String>,

    /// Filename stem — read-only input used by the H1 filename
    /// fallback when all H1 fields are empty (plan §1 Group H).
    /// Implementation in a follow-up commit; v1 ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_stem: Option<String>,
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

/// Shared cancel-flag state for the normaliser batch run.
pub type NormaliseState = crate::batch_job::BatchJobCancelState;

// ── Dispatcher ─────────────────────────────────────────────────────────
//
// `process_image` is the per-image entrypoint called by the batch
// loop. It walks the enabled groups in pass order (plan §2), building
// up a flat draft-edits map plus a stats struct.

/// Per-image stats tracking from one `process_image` call. Aggregated
/// across the whole batch into `NormaliseSummary`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct PerImageStats {
    /// Number of enabled groups that emitted drafts.
    pub n_groups_normalised: u32,
    /// Number of enabled groups whose idempotency detector returned
    /// no-op (already normalised).
    pub n_groups_noop: u32,
    /// Per-group conflict counters (Location: XMP↔IIM disagree;
    /// Dates: H1/H2 primary vs mirror disagree).
    pub n_location_xmp_iim_conflict: u32,
    pub n_date_conflict: u32,
    /// Dates-specific filename-fallback counters.
    pub n_dto_from_filename: u32,
    pub n_dto_from_filename_date_only: u32,
    /// Number of date input fields that were non-empty but
    /// unparseable.
    pub n_unparseable_date_inputs: u32,
}

/// Process one image. Walks the enabled groups in pass order; returns
/// the aggregated draft-edit map plus per-image stats.
pub fn process_image(
    item: &NormaliseRequestItem,
    enabled: &[NormaliseGroup],
) -> (HashMap<String, DraftEdit>, PerImageStats) {
    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    let mut stats = PerImageStats::default();

    let is_enabled = |g: NormaliseGroup| enabled.contains(&g);

    // Pass 1: independent groups (any order). Pass 2 (Description),
    // pass 3 (Title/Headline) are v2 — Title's deterministic branches
    // run independently in v1.
    if is_enabled(NormaliseGroup::Keywords) {
        if let Some(input) = item.group_inputs.keywords.as_ref() {
            match normalise_keywords(input) {
                Some(out) => {
                    edits.extend(out.edits);
                    stats.n_groups_normalised += 1;
                }
                None => stats.n_groups_noop += 1,
            }
        } else {
            stats.n_groups_noop += 1;
        }
    }

    if is_enabled(NormaliseGroup::Creator) {
        if let Some(input) = item.group_inputs.creator.as_ref() {
            match normalise_creator(input) {
                Some(out) => {
                    edits.extend(out.edits);
                    stats.n_groups_normalised += 1;
                }
                None => stats.n_groups_noop += 1,
            }
        } else {
            stats.n_groups_noop += 1;
        }
    }

    if is_enabled(NormaliseGroup::Copyright) {
        if let Some(input) = item.group_inputs.copyright.as_ref() {
            match normalise_copyright(input) {
                Some(out) => {
                    edits.extend(out.edits);
                    stats.n_groups_normalised += 1;
                }
                None => stats.n_groups_noop += 1,
            }
        } else {
            stats.n_groups_noop += 1;
        }
    }

    if is_enabled(NormaliseGroup::Headline) {
        if let Some(input) = item.group_inputs.headline.as_ref() {
            match normalise_headline(input) {
                Some(out) => {
                    edits.extend(out.edits);
                    stats.n_groups_normalised += 1;
                }
                None => stats.n_groups_noop += 1,
            }
        } else {
            stats.n_groups_noop += 1;
        }
    }

    if is_enabled(NormaliseGroup::Title) {
        if let Some(input) = item.group_inputs.title.as_ref() {
            match normalise_title(input) {
                Some(out) => {
                    edits.extend(out.edits);
                    stats.n_groups_normalised += 1;
                }
                None => stats.n_groups_noop += 1,
            }
        } else {
            stats.n_groups_noop += 1;
        }
    }

    if is_enabled(NormaliseGroup::Location) {
        if let Some(input) = item.group_inputs.location.as_ref() {
            let outcome = normalise_location(input);
            stats.n_location_xmp_iim_conflict = outcome.n_xmp_iim_conflict;
            match outcome.output {
                Some(out) => {
                    edits.extend(out.edits);
                    stats.n_groups_normalised += 1;
                }
                None => stats.n_groups_noop += 1,
            }
        } else {
            stats.n_groups_noop += 1;
        }
    }

    if is_enabled(NormaliseGroup::Dates) {
        if let Some(input) = item.group_inputs.dates.as_ref() {
            let outcome = normalise_dates(input);
            stats.n_date_conflict = outcome.n_date_conflict;
            stats.n_dto_from_filename = outcome.n_dto_from_filename;
            stats.n_dto_from_filename_date_only = outcome.n_dto_from_filename_date_only;
            stats.n_unparseable_date_inputs = outcome.n_unparseable_inputs;
            match outcome.output {
                Some(out) => {
                    edits.extend(out.edits);
                    stats.n_groups_normalised += 1;
                }
                None => stats.n_groups_noop += 1,
            }
        } else {
            stats.n_groups_noop += 1;
        }
    }

    // Group B (Description) deferred to v2.

    (edits, stats)
}

/// Whole-batch summary emitted with the `normalise_complete` event.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct NormaliseSummary {
    pub n_succeeded: u32,
    pub n_failed: u32,
    /// Images for which every enabled group was a no-op
    /// (idempotency). Counted toward `n_succeeded`.
    pub n_skipped_all_normalised: u32,
    /// Total per-group counters across the batch.
    pub n_groups_normalised_total: u32,
    pub n_groups_noop_total: u32,
    pub n_location_xmp_iim_conflict_total: u32,
    pub n_date_conflict_total: u32,
    pub n_dto_from_filename_total: u32,
    pub n_dto_from_filename_date_only_total: u32,
    pub n_unparseable_date_inputs_total: u32,
}

impl NormaliseSummary {
    pub fn accumulate(&mut self, per_image: &PerImageStats) {
        self.n_groups_normalised_total += per_image.n_groups_normalised;
        self.n_groups_noop_total += per_image.n_groups_noop;
        self.n_location_xmp_iim_conflict_total += per_image.n_location_xmp_iim_conflict;
        self.n_date_conflict_total += per_image.n_date_conflict;
        self.n_dto_from_filename_total += per_image.n_dto_from_filename;
        self.n_dto_from_filename_date_only_total += per_image.n_dto_from_filename_date_only;
        self.n_unparseable_date_inputs_total += per_image.n_unparseable_date_inputs;
    }
}

#[cfg(test)]
mod tests_dispatcher {
    use super::*;

    #[test]
    fn enabled_groups_filter() {
        // Only Keywords enabled; Creator input present but should be
        // skipped.
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                keywords: Some(KeywordsInput {
                    dc_subject: vec!["A".into()],
                    ..Default::default()
                }),
                creator: Some(CreatorInput {
                    creator: vec!["alice".into()],
                    ..Default::default()
                }),
                ..Default::default()
            },
        };
        let (edits, stats) = process_image(&item, &[NormaliseGroup::Keywords]);
        assert!(edits.contains_key("XMP-dc:Subject"));
        assert!(!edits.contains_key("XMP-dc:Creator"));
        assert_eq!(stats.n_groups_normalised, 1);
        assert_eq!(stats.n_groups_noop, 0);
    }

    #[test]
    fn all_groups_noop_when_already_normalised() {
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs::default(),
        };
        let (edits, stats) = process_image(
            &item,
            &[
                NormaliseGroup::Keywords,
                NormaliseGroup::Creator,
                NormaliseGroup::Copyright,
                NormaliseGroup::Headline,
                NormaliseGroup::Title,
                NormaliseGroup::Location,
                NormaliseGroup::Dates,
            ],
        );
        assert!(edits.is_empty());
        assert_eq!(stats.n_groups_normalised, 0);
        assert_eq!(stats.n_groups_noop, 7);
    }

    #[test]
    fn summary_accumulates_per_image_stats() {
        let mut summary = NormaliseSummary::default();
        summary.accumulate(&PerImageStats {
            n_groups_normalised: 2,
            n_groups_noop: 1,
            n_location_xmp_iim_conflict: 1,
            n_date_conflict: 0,
            n_dto_from_filename: 1,
            n_dto_from_filename_date_only: 1,
            n_unparseable_date_inputs: 0,
        });
        summary.accumulate(&PerImageStats {
            n_groups_normalised: 3,
            n_groups_noop: 0,
            n_location_xmp_iim_conflict: 0,
            n_date_conflict: 1,
            n_dto_from_filename: 0,
            n_dto_from_filename_date_only: 0,
            n_unparseable_date_inputs: 2,
        });
        assert_eq!(summary.n_groups_normalised_total, 5);
        assert_eq!(summary.n_groups_noop_total, 1);
        assert_eq!(summary.n_location_xmp_iim_conflict_total, 1);
        assert_eq!(summary.n_date_conflict_total, 1);
        assert_eq!(summary.n_dto_from_filename_total, 1);
        assert_eq!(summary.n_dto_from_filename_date_only_total, 1);
        assert_eq!(summary.n_unparseable_date_inputs_total, 2);
    }
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

// ── Group H: Dates (H1 Shutter + H2 Digitised) ─────────────────────────
//
// Plan §1 Group H. Two sub-groups, treated independently:
//
//   H1 Shutter time   — `EXIF:DateTimeOriginal` is primary; mirrors
//                       are `XMP-photoshop:DateCreated`,
//                       `IPTC:DateCreated` + `IPTC:TimeCreated`.
//   H2 Digitised time — `EXIF:CreateDate` is primary; mirrors are
//                       `XMP-xmp:CreateDate`,
//                       `IPTC:DigitalCreationDate` +
//                       `IPTC:DigitalCreationTime`.
//
// H3 (Modify time) is intentionally skipped — exiftool auto-updates
// modify timestamps on every write.
//
// Filename fallback for H1 missing DTO is a separate follow-up commit;
// this one handles only ISO sync across the existing mirrors.
//
// Canonical form: ISO 8601 datetime, optional sub-second precision
// preserved when any source supplies it, optional timezone offset
// preserved when any EXIF Offset* tag supplies it. Output is the
// canonical string for each target.

/// Parsed datetime that drives both projection (to derivatives) and
/// equality comparison (idempotency). All fields are kept as strings
/// because we don't need to do arithmetic — only render in canonical
/// form.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedDateTime {
    /// "YYYY-MM-DD".
    date: String,
    /// "HH:MM:SS".
    time: String,
    /// Sub-second digits without leading dot, e.g. "123" → ".123";
    /// empty when no source had sub-seconds.
    subsec: String,
    /// "+HH:MM" / "-HH:MM" / "Z"; empty when no offset known.
    offset: String,
}

impl ParsedDateTime {
    fn to_canonical(&self) -> String {
        let mut s = String::with_capacity(32);
        s.push_str(&self.date);
        s.push('T');
        s.push_str(&self.time);
        if !self.subsec.is_empty() {
            s.push('.');
            s.push_str(&self.subsec);
        }
        s.push_str(&self.offset);
        s
    }

    fn iptc_date(&self) -> String {
        self.date.clone()
    }

    /// `HH:MM:SS[.subsec][±HH:MM]` for IPTC TimeCreated / DigitalCreationTime.
    fn iptc_time(&self) -> String {
        let mut s = String::with_capacity(16);
        s.push_str(&self.time);
        if !self.subsec.is_empty() {
            s.push('.');
            s.push_str(&self.subsec);
        }
        s.push_str(&self.offset);
        s
    }
}

/// Parse a datetime string in any of the common shapes we see:
///   * `"YYYY:MM:DD HH:MM:SS"`               (EXIF)
///   * `"YYYY-MM-DD HH:MM:SS"`               (some IPTC tools)
///   * `"YYYY-MM-DDTHH:MM:SS"`               (XMP / ISO)
///   * `"YYYY-MM-DDTHH:MM:SS.sss"`           (with sub-seconds)
///   * `"…[+HH:MM]"` / `"…[-HH:MM]"` / `"…Z"` (with offset)
fn parse_datetime_str(s: &str, default_offset: &str, default_subsec: &str) -> Option<ParsedDateTime> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    // Need at least YYYY-MM-DD HH:MM:SS shape = 19 chars.
    if bytes.len() < 19 {
        return None;
    }
    // Extract YYYY, MM, DD with either '-' or ':' as separator.
    let year = &s[0..4];
    let m_sep = bytes[4] as char;
    if m_sep != '-' && m_sep != ':' {
        return None;
    }
    let month = &s[5..7];
    let d_sep = bytes[7] as char;
    if d_sep != '-' && d_sep != ':' {
        return None;
    }
    let day = &s[8..10];
    if !year.chars().all(|c| c.is_ascii_digit())
        || !month.chars().all(|c| c.is_ascii_digit())
        || !day.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let dt_sep = bytes[10] as char;
    if dt_sep != ' ' && dt_sep != 'T' {
        return None;
    }
    let hour = &s[11..13];
    if bytes[13] as char != ':' {
        return None;
    }
    let minute = &s[14..16];
    if bytes[16] as char != ':' {
        return None;
    }
    let second = &s[17..19];
    if !hour.chars().all(|c| c.is_ascii_digit())
        || !minute.chars().all(|c| c.is_ascii_digit())
        || !second.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let mut rest = &s[19..];
    let mut subsec = String::new();
    if rest.starts_with('.') {
        let after_dot = &rest[1..];
        let digits: String = after_dot.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        subsec = digits.clone();
        rest = &rest[1 + digits.len()..];
    }
    let offset = if rest.is_empty() {
        default_offset.to_string()
    } else if rest == "Z" {
        "+00:00".to_string()
    } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) {
        rest.to_string()
    } else if rest.len() == 5 && (rest.starts_with('+') || rest.starts_with('-')) {
        // "+0100" → "+01:00"
        let mut o = String::with_capacity(6);
        o.push_str(&rest[..3]);
        o.push(':');
        o.push_str(&rest[3..]);
        o
    } else {
        return None;
    };
    if subsec.is_empty() && !default_subsec.is_empty() {
        subsec = default_subsec.to_string();
    }
    Some(ParsedDateTime {
        date: format!("{}-{}-{}", year, month, day),
        time: format!("{}:{}:{}", hour, minute, second),
        subsec,
        offset,
    })
}

/// Combine a date string (`YYYY-MM-DD`) and time string
/// (`HH:MM:SS[.sub][±HH:MM]` or `HH:MM:SS`) into a single
/// `ParsedDateTime`.
fn parse_iptc_date_time(date_s: &str, time_s: Option<&str>, default_offset: &str, default_subsec: &str) -> Option<ParsedDateTime> {
    let date_s = date_s.trim();
    if date_s.len() < 10 {
        return None;
    }
    // Build a synthetic "YYYY-MM-DDTHH:MM:SS[.sub][±HH:MM]" string and
    // reuse the main parser.
    let time_part = time_s.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("00:00:00");
    let synthetic = format!("{}T{}", &date_s[..10], time_part);
    parse_datetime_str(&synthetic, default_offset, default_subsec)
}

/// Outcome of processing one Group H sub-group (H1 or H2).
#[derive(Debug, Clone, Default)]
struct DateSubgroupResult {
    edits: HashMap<String, DraftEdit>,
    /// True when multiple non-empty sources disagreed and primary won.
    conflict: bool,
}

/// Compute drafts for one H sub-group.
///
/// `existing_exif` / `existing_xmp` / `existing_iptc` describe what is
/// already on disk for each target (post-parse; `None` means absent or
/// unparseable). `canonical_override` is set by the filename-fallback
/// path when the existing sources are all empty but a filename-derived
/// datetime is being adopted.
///
/// Conflict policy: primary wins. Two sources disagreeing → conflict
/// counted; primary's value is the canonical.
fn process_date_subgroup(
    existing_exif: Option<&ParsedDateTime>,
    existing_xmp: Option<&ParsedDateTime>,
    existing_iptc: Option<&ParsedDateTime>,
    canonical_override: Option<&ParsedDateTime>,
    exif_target_key: &str,
    xmp_target_key: &str,
    iptc_date_key: &str,
    iptc_time_key: &str,
) -> DateSubgroupResult {
    // Derive canonical from existing sources in priority order:
    // EXIF primary > XMP mirror > IPTC split. Override (filename
    // fallback) is used only when no existing source exists.
    let mut conflict = false;
    let canonical: ParsedDateTime = if let Some(p) = existing_exif.cloned() {
        if let Some(o) = existing_xmp {
            if o != &p { conflict = true; }
        }
        if let Some(o) = existing_iptc {
            if o != &p { conflict = true; }
        }
        p
    } else if let Some(p) = existing_xmp.cloned() {
        if let Some(o) = existing_iptc {
            if o != &p { conflict = true; }
        }
        p
    } else if let Some(p) = existing_iptc.cloned() {
        p
    } else if let Some(p) = canonical_override.cloned() {
        p
    } else {
        return DateSubgroupResult::default();
    };

    // Project canonical to each target; emit a draft only when the
    // existing-on-disk value differs.
    let mut edits = HashMap::new();
    let canonical_full = canonical.to_canonical();
    let canonical_date = canonical.iptc_date();
    let canonical_time = canonical.iptc_time();

    if existing_exif != Some(&canonical) {
        edits.insert(
            exif_target_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_full.clone())),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if existing_xmp != Some(&canonical) {
        edits.insert(
            xmp_target_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_full)),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if existing_iptc != Some(&canonical) {
        edits.insert(
            iptc_date_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_date)),
                intent: EditIntent::Set,
                display: None,
            },
        );
        edits.insert(
            iptc_time_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_time)),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }

    DateSubgroupResult { edits, conflict }
}

/// Outcome of running Group H on one image.
#[derive(Debug, Clone, Default)]
pub struct DatesOutcome {
    pub output: Option<GroupOutput>,
    /// Counts H1 and H2 conflicts (primary disagreed with mirrors).
    pub n_date_conflict: u32,
    /// Number of source fields that were non-empty but unparseable —
    /// they are ignored and the user sees the count in stats.
    pub n_unparseable_inputs: u32,
    /// True when the H1 datetime was filled from a filename regex
    /// (all H1 sources were empty). Surfaced in stats.
    pub n_dto_from_filename: u32,
    /// True when the filename match supplied only a date and the time
    /// was defaulted to `00:00:00`. Subset of `n_dto_from_filename`.
    pub n_dto_from_filename_date_only: u32,
}

/// Filename-regex fallback for missing H1 (`EXIF:DateTimeOriginal`).
///
/// Triggered only when all H1 sources are empty (plan §1 Group H).
/// Patterns are tried in order; first match wins. Date-only matches
/// fill time as `00:00:00` and are flagged in stats so the user can
/// audit. Sanity bound on year: 1900 ≤ year ≤ (current year + 1).
///
/// Returns `(ParsedDateTime, date_only_flag)` on a match.
fn parse_filename_for_h1(stem: &str) -> Option<(ParsedDateTime, bool)> {
    // Patterns at any position in the stem. Listed in the order we
    // want them to be tried — most specific first (Pixel with subsec
    // before generic ISO, otherwise the generic regex eats the
    // datetime first and we lose the subsec digits).
    static PATTERNS: OnceLock<Vec<(regex::Regex, bool, bool)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        // (regex, has_time, has_subsec)
        // Each regex captures (year, month, day, [hour, minute, second, [subsec]]).
        vec![
            (
                regex::Regex::new(r"PXL[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(\d{3})").unwrap(),
                true,
                true,
            ),
            (
                regex::Regex::new(r"(?:IMG|VID)[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"Screenshot[ _](\d{4})-(\d{2})-(\d{2})(?:[ _](\d{2})[.\-](\d{2})[.\-](\d{2}))?").unwrap(),
                true, // captures may have None for time when truly absent
                false,
            ),
            (
                regex::Regex::new(r"(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[.\-:](\d{2})[.\-:](\d{2})").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"(\d{4})-(\d{2})-(\d{2})").unwrap(),
                false,
                false,
            ),
        ]
    });

    let current_year: i32 = chrono::Utc::now()
        .format("%Y")
        .to_string()
        .parse()
        .unwrap_or(2025);
    let year_max = current_year + 1;
    const YEAR_MIN: i32 = 1900;

    for (re, has_time, has_subsec) in patterns {
        if let Some(caps) = re.captures(stem) {
            let year: i32 = caps.get(1)?.as_str().parse().ok()?;
            let month: u32 = caps.get(2)?.as_str().parse().ok()?;
            let day: u32 = caps.get(3)?.as_str().parse().ok()?;
            if year < YEAR_MIN || year > year_max {
                continue;
            }
            if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
                continue;
            }
            let (hour, minute, second, time_present) = if *has_time {
                match (caps.get(4), caps.get(5), caps.get(6)) {
                    (Some(h), Some(m), Some(s)) => {
                        let h: u32 = h.as_str().parse().ok()?;
                        let m: u32 = m.as_str().parse().ok()?;
                        let s: u32 = s.as_str().parse().ok()?;
                        if h > 23 || m > 59 || s > 59 {
                            continue;
                        }
                        (h, m, s, true)
                    }
                    _ => (0, 0, 0, false),
                }
            } else {
                (0, 0, 0, false)
            };
            let subsec = if *has_subsec {
                caps.get(7).map(|m| m.as_str().to_string()).unwrap_or_default()
            } else {
                String::new()
            };
            let parsed = ParsedDateTime {
                date: format!("{:04}-{:02}-{:02}", year, month, day),
                time: format!("{:02}:{:02}:{:02}", hour, minute, second),
                subsec,
                offset: String::new(),
            };
            return Some((parsed, !time_present));
        }
    }
    None
}

/// Run Group H (Dates — H1 + H2) normalisation for one image.
pub fn normalise_dates(input: &DatesInput) -> DatesOutcome {
    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    let mut n_conflict: u32 = 0;
    let mut n_unparseable: u32 = 0;
    let mut n_from_filename: u32 = 0;
    let mut n_from_filename_date_only: u32 = 0;

    // ── H1: Shutter time ──
    let default_offset_h1 = input.offset_time_original.as_deref().unwrap_or("").trim().to_string();
    let default_subsec_h1 = input.sub_sec_time_original.as_deref().unwrap_or("").trim().to_string();
    let parse = |s: Option<&str>| -> Option<ParsedDateTime> {
        s.filter(|v| !v.trim().is_empty())
            .and_then(|v| parse_datetime_str(v, &default_offset_h1, &default_subsec_h1))
    };
    let count_unparseable_if = |s: Option<&str>, parsed: &Option<ParsedDateTime>| -> u32 {
        match (s, parsed) {
            (Some(v), None) if !v.trim().is_empty() => 1,
            _ => 0,
        }
    };
    let exif_parsed = parse(input.date_time_original.as_deref());
    n_unparseable += count_unparseable_if(input.date_time_original.as_deref(), &exif_parsed);
    let xmp_parsed = parse(input.photoshop_date_created.as_deref());
    n_unparseable += count_unparseable_if(input.photoshop_date_created.as_deref(), &xmp_parsed);
    let iptc_split = match (input.iptc_date_created.as_deref(), input.iptc_time_created.as_deref()) {
        (Some(d), t) if !d.trim().is_empty() => parse_iptc_date_time(d, t, &default_offset_h1, &default_subsec_h1),
        _ => None,
    };
    if input.iptc_date_created.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) && iptc_split.is_none() {
        n_unparseable += 1;
    }

    // Filename fallback: only fires when *all* H1 sources are empty
    // (or unparseable). Never overwrites an existing DTO. Tracked
    // separately so the projection step knows the EXIF target is
    // still empty on disk (i.e. needs a set-value draft).
    let mut canonical_override: Option<ParsedDateTime> = None;
    if exif_parsed.is_none() && xmp_parsed.is_none() && iptc_split.is_none() {
        if let Some(stem) = input.file_stem.as_deref().filter(|s| !s.trim().is_empty()) {
            if let Some((parsed, date_only)) = parse_filename_for_h1(stem) {
                canonical_override = Some(parsed);
                n_from_filename += 1;
                if date_only {
                    n_from_filename_date_only += 1;
                }
            }
        }
    }

    let h1 = process_date_subgroup(
        exif_parsed.as_ref(),
        xmp_parsed.as_ref(),
        iptc_split.as_ref(),
        canonical_override.as_ref(),
        "EXIF:DateTimeOriginal",
        "XMP-photoshop:DateCreated",
        "IPTC:DateCreated",
        "IPTC:TimeCreated",
    );
    if h1.conflict {
        n_conflict += 1;
    }
    edits.extend(h1.edits);

    // ── H2: Digitised time ──
    let default_offset_h2 = input.offset_time.as_deref().unwrap_or("").trim().to_string();
    let default_subsec_h2 = input.sub_sec_time_digitized.as_deref().unwrap_or("").trim().to_string();
    let parse2 = |s: Option<&str>| -> Option<ParsedDateTime> {
        s.filter(|v| !v.trim().is_empty())
            .and_then(|v| parse_datetime_str(v, &default_offset_h2, &default_subsec_h2))
    };
    let exif2 = parse2(input.create_date.as_deref());
    n_unparseable += count_unparseable_if(input.create_date.as_deref(), &exif2);
    let xmp2 = parse2(input.xmp_create_date.as_deref());
    n_unparseable += count_unparseable_if(input.xmp_create_date.as_deref(), &xmp2);
    let iptc2 = match (input.iptc_digital_creation_date.as_deref(), input.iptc_digital_creation_time.as_deref()) {
        (Some(d), t) if !d.trim().is_empty() => parse_iptc_date_time(d, t, &default_offset_h2, &default_subsec_h2),
        _ => None,
    };
    if input.iptc_digital_creation_date.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) && iptc2.is_none() {
        n_unparseable += 1;
    }
    let h2 = process_date_subgroup(
        exif2.as_ref(),
        xmp2.as_ref(),
        iptc2.as_ref(),
        None,
        "EXIF:CreateDate",
        "XMP-xmp:CreateDate",
        "IPTC:DigitalCreationDate",
        "IPTC:DigitalCreationTime",
    );
    if h2.conflict {
        n_conflict += 1;
    }
    edits.extend(h2.edits);

    DatesOutcome {
        output: if edits.is_empty() { None } else { Some(GroupOutput { edits }) },
        n_date_conflict: n_conflict,
        n_unparseable_inputs: n_unparseable,
        n_dto_from_filename: n_from_filename,
        n_dto_from_filename_date_only: n_from_filename_date_only,
    }
}

#[cfg(test)]
mod tests_dates {
    use super::*;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String for {}, got {:?}", k, other),
        }
    }

    #[test]
    fn parse_exif_style_colon_separator() {
        let p = parse_datetime_str("2024:06:15 14:30:45", "", "").unwrap();
        assert_eq!(p.date, "2024-06-15");
        assert_eq!(p.time, "14:30:45");
        assert_eq!(p.subsec, "");
        assert_eq!(p.offset, "");
        assert_eq!(p.to_canonical(), "2024-06-15T14:30:45");
    }

    #[test]
    fn parse_iso_with_offset_and_subsec() {
        let p = parse_datetime_str("2024-06-15T14:30:45.123+01:00", "", "").unwrap();
        assert_eq!(p.subsec, "123");
        assert_eq!(p.offset, "+01:00");
        assert_eq!(p.to_canonical(), "2024-06-15T14:30:45.123+01:00");
    }

    #[test]
    fn parse_iso_with_z_offset() {
        let p = parse_datetime_str("2024-06-15T14:30:45Z", "", "").unwrap();
        assert_eq!(p.offset, "+00:00");
        assert_eq!(p.to_canonical(), "2024-06-15T14:30:45+00:00");
    }

    #[test]
    fn parse_picks_up_default_offset_when_input_has_none() {
        let p = parse_datetime_str("2024-06-15T14:30:45", "+01:00", "").unwrap();
        assert_eq!(p.offset, "+01:00");
    }

    #[test]
    fn parse_picks_up_default_subsec_when_input_has_none() {
        let p = parse_datetime_str("2024-06-15T14:30:45", "", "123").unwrap();
        assert_eq!(p.subsec, "123");
    }

    #[test]
    fn parse_garbage_returns_none() {
        assert!(parse_datetime_str("not a date", "", "").is_none());
        assert!(parse_datetime_str("2024", "", "").is_none());
    }

    #[test]
    fn h1_exif_only_propagates_to_xmp_and_iptc_split() {
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        // EXIF source matches canonical → no draft for EXIF target.
        assert!(out.edits.get("EXIF:DateTimeOriginal").is_none());
        assert_eq!(s(&out, "XMP-photoshop:DateCreated"), "2024-06-15T14:30:45");
        assert_eq!(s(&out, "IPTC:DateCreated"), "2024-06-15");
        assert_eq!(s(&out, "IPTC:TimeCreated"), "14:30:45");
    }

    #[test]
    fn h1_with_offset_and_subsec_round_trip() {
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            offset_time_original: Some("+01:00".into()),
            sub_sec_time_original: Some("123".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert_eq!(s(&out, "XMP-photoshop:DateCreated"), "2024-06-15T14:30:45.123+01:00");
        assert_eq!(s(&out, "IPTC:DateCreated"), "2024-06-15");
        assert_eq!(s(&out, "IPTC:TimeCreated"), "14:30:45.123+01:00");
    }

    #[test]
    fn h1_conflict_exif_vs_xmp_primary_wins() {
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            photoshop_date_created: Some("2024-06-15T15:00:00".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        // Primary (EXIF) stays untouched; mirror overwritten.
        assert_eq!(s(&g, "XMP-photoshop:DateCreated"), "2024-06-15T14:30:45");
        assert_eq!(out.n_date_conflict, 1);
    }

    #[test]
    fn h1_and_h2_independent() {
        // H1 set, H2 absent — only H1 emits drafts.
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert!(out.edits.contains_key("XMP-photoshop:DateCreated"));
        assert!(!out.edits.contains_key("XMP-xmp:CreateDate"));
        assert!(!out.edits.contains_key("EXIF:CreateDate"));
    }

    #[test]
    fn h2_exif_only_propagates() {
        let input = DatesInput {
            create_date: Some("2024-06-15T14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert_eq!(s(&out, "XMP-xmp:CreateDate"), "2024-06-15T14:30:45");
        assert_eq!(s(&out, "IPTC:DigitalCreationDate"), "2024-06-15");
        assert_eq!(s(&out, "IPTC:DigitalCreationTime"), "14:30:45");
    }

    #[test]
    fn unparseable_input_is_counted_not_aborted() {
        let input = DatesInput {
            date_time_original: Some("garbage".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
        assert_eq!(out.n_unparseable_inputs, 1);
    }

    #[test]
    fn all_empty_returns_no_drafts() {
        let out = normalise_dates(&DatesInput::default());
        assert!(out.output.is_none());
        assert_eq!(out.n_date_conflict, 0);
        assert_eq!(out.n_unparseable_inputs, 0);
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            offset_time_original: Some("+01:00".into()),
            ..Default::default()
        };
        let first = normalise_dates(&initial).output.unwrap();
        // Build post-apply state.
        let post = DatesInput {
            date_time_original: Some("2024-06-15T14:30:45+01:00".into()),
            offset_time_original: Some("+01:00".into()),
            photoshop_date_created: Some(s(&first, "XMP-photoshop:DateCreated")),
            iptc_date_created: Some(s(&first, "IPTC:DateCreated")),
            iptc_time_created: Some(s(&first, "IPTC:TimeCreated")),
            ..Default::default()
        };
        let second = normalise_dates(&post);
        assert!(second.output.is_none(), "expected idempotent, got {:?}", second.output);
    }

    #[test]
    fn filename_fallback_pixel_with_subsec() {
        let input = DatesInput {
            file_stem: Some("PXL_20240615_143045123".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.expect("filename fallback must emit drafts");
        assert_eq!(s(&g, "EXIF:DateTimeOriginal"), "2024-06-15T14:30:45.123");
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 0);
    }

    #[test]
    fn filename_fallback_ios_img() {
        let input = DatesInput {
            file_stem: Some("IMG_20240615_143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "EXIF:DateTimeOriginal"), "2024-06-15T14:30:45");
    }

    #[test]
    fn filename_fallback_screenshot_date_only() {
        let input = DatesInput {
            file_stem: Some("Screenshot 2024-06-15".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "EXIF:DateTimeOriginal"), "2024-06-15T00:00:00");
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 1);
    }

    #[test]
    fn filename_fallback_screenshot_with_time() {
        // Plan §1 H regex table specifies `[ _]` between date and
        // time (single space/underscore separator) — not " at ".
        let input = DatesInput {
            file_stem: Some("Screenshot 2024-06-15 14.30.45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "EXIF:DateTimeOriginal"), "2024-06-15T14:30:45");
        assert_eq!(out.n_dto_from_filename_date_only, 0);
    }

    #[test]
    fn filename_fallback_generic_iso() {
        let input = DatesInput {
            file_stem: Some("my photo 2024-06-15T14:30:45 final".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "EXIF:DateTimeOriginal"), "2024-06-15T14:30:45");
    }

    #[test]
    fn filename_fallback_compact() {
        let input = DatesInput {
            file_stem: Some("20240615_143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "EXIF:DateTimeOriginal"), "2024-06-15T14:30:45");
    }

    #[test]
    fn filename_fallback_never_overwrites_existing_dto() {
        let input = DatesInput {
            date_time_original: Some("2020:01:01 00:00:00".into()),
            file_stem: Some("IMG_20240615_143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        // DTO already present → filename ignored. Counter stays 0.
        assert_eq!(out.n_dto_from_filename, 0);
        // Canonical = the existing DTO (2020 win), mirrors get
        // projection drafts but EXIF:DateTimeOriginal isn't rewritten.
        let g = out.output.unwrap();
        assert_eq!(s(&g, "XMP-photoshop:DateCreated"), "2020-01-01T00:00:00");
    }

    #[test]
    fn filename_year_out_of_bounds_rejected() {
        let input = DatesInput {
            file_stem: Some("IMG_18900101_120000".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
        assert_eq!(out.n_dto_from_filename, 0);
    }

    #[test]
    fn filename_invalid_month_rejected() {
        let input = DatesInput {
            file_stem: Some("IMG_20241335_120000".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
    }

    #[test]
    fn filename_no_match_returns_no_drafts() {
        let input = DatesInput {
            file_stem: Some("random_filename.jpg".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
        assert_eq!(out.n_dto_from_filename, 0);
    }

    #[test]
    fn iptc_split_alone_drives_canonical() {
        let input = DatesInput {
            iptc_date_created: Some("2024-06-15".into()),
            iptc_time_created: Some("14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert_eq!(s(&out, "EXIF:DateTimeOriginal"), "2024-06-15T14:30:45");
        assert_eq!(s(&out, "XMP-photoshop:DateCreated"), "2024-06-15T14:30:45");
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
