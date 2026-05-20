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

// Per-group implementation modules. The dispatcher (`process_image`)
// composes these in the pass order documented in plan §2; each
// submodule owns its target tags constant, canonical derivation,
// idempotency detector, normaliser, and unit tests for that group.
mod keywords;
pub use keywords::{
    derive_keywords_canonical, normalise_keywords, normalise_keywords_with_canonical,
    KEYWORDS_TARGET_TAGS,
};

mod creator;
pub use creator::{derive_creator_canonical, normalise_creator, CREATOR_TARGET_TAGS};

mod copyright;
pub use copyright::{normalise_copyright, COPYRIGHT_TARGET_TAGS};

mod headline;
pub use headline::{normalise_headline, HEADLINE_TARGET_TAGS};

mod title;
pub use title::{build_title_gen_prompt, normalise_title, TitleOutcome, TITLE_TARGET_TAGS};

mod location;
pub use location::{
    derive_location_canonical, normalise_location, LocationOutcome, LOCATION_TARGET_TAGS,
};

mod dates;
pub use dates::{normalise_dates, DatesOutcome};

mod ai;
pub use ai::{
    AiCallUsage, CapturingAiClient, DescriptionMergePrompt, NormaliseAiClient,
    NormaliseAiError, NormaliseAuditEntry, PerImageAiCall, TitleGenPrompt,
};

mod description;
pub use description::{
    build_description_merge_prompt, normalise_description, DescriptionOutcome,
    DESCRIPTION_TARGET_TAGS,
};

/// The eight semantic groups the user can toggle on/off in the confirm
/// dialog. See plan §1 for the definition of each group, its target /
/// derivative fields, and conflict policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
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
    /// Group B (Description) sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<DescriptionInput>,
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
    /// case-3 AI title-generation branch (plan §1 Group C).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_canonical: Option<String>,
    /// Location context used by case-3 AI title generation for
    /// disambiguation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_context: Option<LocationContext>,
    /// Keyword context used by case-3 AI title generation.
    #[serde(default)]
    pub keywords_context: Vec<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_stem: Option<String>,
}

/// Description-group input bundle (plan §1 Group B).
///
/// Per plan, three target fields share a canonical paragraph; three
/// read-only inputs from the AI Describe feature contribute context,
/// plus location, keywords, and date context from other groups
/// (resolved post-pass-1 in the dispatcher). `EXIF:UserComment` is
/// explicitly excluded — semantically "user note", not caption.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct DescriptionInput {
    /// `XMP-dc:Description` (LangAlt x-default, primary target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `EXIF:ImageDescription` (ASCII string, derivative target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_description: Option<String>,
    /// `IPTC:Caption-Abstract` (string, 2000-char IIM limit;
    /// derivative target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_abstract: Option<String>,

    /// Whether the file declares `IPTC:CodedCharacterSet` as UTF-8
    /// (`ESC % G`). Controls whether `caption_abstract` is written as
    /// UTF-8 or ASCII-folded.
    #[serde(default)]
    pub iptc_charset_is_utf8: bool,

    // ── Read-only AI inputs (XMP-mlib namespace) ──
    /// `XMP-mlib:AIDescription` — feeds the AI merge context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_description: Option<String>,
    /// `XMP-mlib:AIInterpretation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_interpretation: Option<String>,
    /// `XMP-mlib:AIOcrText` — Bag of strings, read-only.
    #[serde(default)]
    pub ai_ocr_text: Vec<String>,
    /// `XMP-mlib:AIObjects` — Bag of strings, read-only.
    #[serde(default)]
    pub ai_objects: Vec<String>,

    // ── Cross-group read-only inputs (populated by dispatcher) ──
    /// Group F (Location) canonical strings from this image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_context: Option<LocationContext>,
    /// Group A (Keywords) canonical leaves from this image (after
    /// pass-1 normalisation).
    #[serde(default)]
    pub keywords_context: Vec<String>,
    /// Group H (Dates) canonical H1 shutter-time string from this
    /// image (after pass-1 normalisation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_context: Option<String>,
}

/// Subset of the Location group surfaced to Group B for AI context.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct LocationContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
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

/// Build a set-value draft for a Bag/Seq-of-Text tag from a list of
/// canonical strings. Shared by Group A (Keywords) and Group E
/// (Creator).
pub(crate) fn bag_edit(items: &[String]) -> DraftEdit {
    let value = Variant::List(items.iter().cloned().map(Variant::String).collect());
    DraftEdit {
        value: Some(value),
        intent: EditIntent::Set,
        display: None,
    }
}

/// Collapse any run of whitespace (including newlines) into a single
/// space and trim the result. Used as the single-line normaliser by
/// Group F (Copyright), Group D (Headline) and Group C (Title) — none
/// alter content beyond whitespace; they layer further rules on top.
pub(crate) fn collapse_whitespace_single_line(s: &str) -> String {
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

/// Coherent-replacement helper (plan §4 strict). For each target tag in
/// `group_targets`, if the group's projection has no value for that
/// tag AND the current state holds a non-empty value, emit a
/// remove-tag draft.
///
/// **In v1/v2 every group either produces a complete projection across
/// its target tags or no drafts at all (`all-empty` rule),** so this
/// helper is currently invoked only for forward-compatibility — when a
/// future group exposes the partial case it can call this on top of
/// its existing set-value emission to satisfy plan §4 without a second
/// rewrite.
pub fn append_remove_tag_drafts_for_missing_projections(
    edits: &mut HashMap<String, DraftEdit>,
    group_targets: &[&str],
    projection: &HashMap<&'static str, Variant>,
    current_value_is_non_empty: impl Fn(&str) -> bool,
) {
    for tag in group_targets {
        if projection.contains_key(*tag) {
            continue;
        }
        if edits.contains_key(*tag) {
            continue;
        }
        if !current_value_is_non_empty(tag) {
            continue;
        }
        edits.insert(
            (*tag).to_string(),
            DraftEdit {
                value: None,
                intent: EditIntent::Delete,
                display: None,
            },
        );
    }
}

/// Truncate `s` to at most `limit` bytes at a word boundary when
/// possible; falls back to a hard char-boundary cut for very long
/// single-word strings. Shared by Group C (IPTC:ObjectName 64
/// chars), Group D (IPTC:Headline 256 chars), Group B
/// (IPTC:Caption-Abstract 2000 chars).
pub(crate) fn truncate_at_word(s: &str, limit: usize) -> String {
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

/// Normaliser cancellation state.
///
/// Newtype around `BatchJobCancelState` rather than an alias: Tauri
/// keys its `State<T>` registry by `TypeId`, so two distinct alias
/// names for the same struct would collide at startup (the geocode
/// state is also a `BatchJobCancelState` wrapper). A newtype gives
/// each batch job its own `TypeId` while keeping the shared lifecycle
/// code.
#[derive(Default)]
pub struct NormaliseState(crate::batch_job::BatchJobCancelState);

impl NormaliseState {
    pub fn install(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.0.install()
    }
    pub fn clear(&self) {
        self.0.clear();
    }
    pub fn signal_cancel(&self) -> bool {
        self.0.signal_cancel()
    }
}

// ── Dispatcher ─────────────────────────────────────────────────────────
//
// `process_image` is the per-image entrypoint called by the batch
// loop. It walks the enabled groups in pass order (plan §2), building
// up a flat draft-edits map plus a stats struct.

/// Per-group counters tracked for one image. Mirrors plan §10's
/// `NormaliseSummary.perGroup[group]` shape, but at the per-image
/// granularity that `NormaliseSummary::accumulate` later sums into
/// the whole-batch breakdown.
///
/// Each `u32` field is 0 or 1 at the per-image scale (a group fires
/// at most once per image); they grow only after accumulation into
/// the batch-wide `NormaliseSummary.per_group` map.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct PerGroupStats {
    /// Idempotency detector reported the group already normalised, or
    /// every source was empty (plan §4 all-empty rule). No drafts.
    pub n_noop: u32,
    /// Group emitted set-value drafts via the deterministic branches.
    pub n_normalised_deterministic: u32,
    /// Group emitted set-value drafts via the AI branch (Group B
    /// case 4; Group C case 3). 0 for all other groups.
    pub n_normalised_ai: u32,
    /// Generic conflict counter — incremented whenever the group
    /// resolved disagreement by preferring the primary source over a
    /// derivative. Group-specific counters below give the detail.
    pub n_conflict_primary_won: u32,
    /// Group G only — XMP↔IIM mirror pair disagreed before
    /// canonicalisation (summed across the 5 sub-pairs).
    pub n_location_xmp_iim_conflict: u32,
    /// Group H only — H1/H2 target source set disagreed after ISO
    /// normalisation (summed across H1+H2).
    pub n_date_conflict: u32,
    /// Group H only — DTO filled from filename regex match.
    pub n_dto_from_filename: u32,
    /// Group H only — filename match was date-only (no time portion).
    pub n_dto_from_filename_date_only: u32,
    /// Group H only — date input string was non-empty but unparseable.
    pub n_unparseable_date_inputs: u32,
    /// Group B / Group C only — AI call returned an error or the key
    /// was missing.
    pub n_ai_errors: u32,
}

/// Per-image stats tracking from one `process_image` call. Aggregated
/// across the whole batch into `NormaliseSummary`. Keyed by enum so
/// the wire format produces stable snake_case group names.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct PerImageStats {
    /// Per-group counter map. Entry is present only for groups that
    /// the dispatcher actually visited (i.e. enabled + bundle
    /// supplied).
    pub per_group: std::collections::BTreeMap<NormaliseGroup, PerGroupStats>,
}

impl PerImageStats {
    /// Mutable entry for a group; inserts a default `PerGroupStats`
    /// the first time the group is visited on this image.
    pub fn group(&mut self, g: NormaliseGroup) -> &mut PerGroupStats {
        self.per_group.entry(g).or_default()
    }

    /// True when no group emitted any drafts (every visited group was
    /// a noop). Used by the batch loop to count `n_skipped_all_normalised`.
    pub fn all_noop(&self) -> bool {
        self.per_group.values().all(|s| {
            s.n_normalised_deterministic == 0 && s.n_normalised_ai == 0
        })
    }
}

/// Process one image. Walks the enabled groups in pass order; returns
/// the aggregated draft-edit map plus per-image stats.
/// Process one image. Walks the enabled groups in the plan's three-pass
/// order:
///   * Pass 1 (independents): Keywords, Creator, Copyright, Location,
///     Dates, Headline. Captures keywords / location / date context
///     for downstream passes.
///   * Pass 2: Description. Reads Group A canonical leaves, Group F
///     location, Group H date as context for the AI merge.
///   * Pass 3: Title. Reads Group B's canonical description for the
///     case-3 AI title generation.
///
/// `ai` is the injected AI client. When `None`, any group whose
/// conflict policy requires AI returns a typed failure rather than
/// silently falling back. The first such failure is returned in the
/// third tuple element and the dispatcher surfaces it as a per-image
/// failure row; non-AI groups for the same image still emit their
/// drafts.
/// Shared dispatcher boilerplate for "simple" deterministic groups
/// (Creator, Copyright, Headline) — those whose `process_image` block
/// only needs to: skip if disabled, count noop if the bundle is
/// absent, then merge the group's `GroupOutput` into the running
/// edits map and bump the appropriate stat counter.
///
/// Groups with side effects beyond that pattern (Keywords captures
/// leaves for pass-2, Location captures context + conflict counter,
/// Dates captures date context + filename stats, Description / Title
/// are async + AI) keep bespoke dispatcher blocks.
fn apply_simple_group<T>(
    group: NormaliseGroup,
    enabled: bool,
    input: Option<&T>,
    edits: &mut HashMap<String, DraftEdit>,
    stats: &mut PerImageStats,
    run: impl FnOnce(&T) -> Option<GroupOutput>,
) {
    if !enabled {
        return;
    }
    let g = stats.group(group);
    let Some(input) = input else {
        // Group enabled but the frontend shipped no bundle for it.
        // Currently unreachable — `buildNormaliseItems` always
        // populates every requested group's bundle — but the
        // dispatcher tolerates it so a future code path that ships
        // partial bundles still runs cleanly. Surface it so the
        // mismatch doesn't silently masquerade as "already normalised".
        log::warn!(
            "[normalise] group {} enabled but no input bundle supplied; counting as no-op",
            group.as_wire(),
        );
        g.n_noop += 1;
        return;
    };
    match run(input) {
        Some(out) => {
            edits.extend(out.edits);
            g.n_normalised_deterministic += 1;
        }
        None => {
            g.n_noop += 1;
        }
    }
}

/// Returns `true` if the caller-supplied cancel flag has been
/// signalled. Defaults to `false` when no flag is supplied (eg.
/// unit-test calls that don't need to model cancellation).
fn is_cancelled(cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>) -> bool {
    cancel
        .map(|f| f.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

pub async fn process_image(
    item: &NormaliseRequestItem,
    enabled: &[NormaliseGroup],
    ai: Option<&dyn NormaliseAiClient>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> (
    HashMap<String, DraftEdit>,
    PerImageStats,
    Option<NormaliseAiError>,
    Vec<PerImageAiCall>,
) {
    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    let mut stats = PerImageStats::default();
    let mut first_ai_error: Option<NormaliseAiError> = None;
    let mut ai_calls: Vec<PerImageAiCall> = Vec::new();

    // Plan §12: cancellation is checked between groups. A flip
    // mid-group does not abort an in-flight call (the HTTP layer
    // doesn't support that yet), but the next group's guard will see
    // it and skip the rest of the image. Groups skipped by
    // cancellation are NOT recorded as noops — they're silently
    // absent from `per_group`, distinguishing user-cancel from
    // already-normalised.
    let is_enabled = |g: NormaliseGroup| enabled.contains(&g) && !is_cancelled(cancel);

    // ── Pass 1: independents ──
    //
    // Capture canonical-ish context as we go for pass 2/3 read-only
    // inputs. The dispatcher constructs these from already-resolved
    // input values, not from the drafts (which are downstream of the
    // canonical and don't yet exist when pass 1 runs).
    let mut keywords_leaves: Vec<String> = Vec::new();
    let mut location_context: Option<LocationContext> = None;
    let mut date_context: Option<String> = None;

    if is_enabled(NormaliseGroup::Keywords) {
        let g = stats.group(NormaliseGroup::Keywords);
        if let Some(input) = item.group_inputs.keywords.as_ref() {
            let (paths, leaves) = derive_keywords_canonical(input);
            keywords_leaves = leaves.clone();
            match normalise_keywords_with_canonical(input, &paths, &leaves) {
                Some(out) => {
                    edits.extend(out.edits);
                    g.n_normalised_deterministic += 1;
                }
                None => g.n_noop += 1,
            }
        } else {
            log::warn!("[normalise] group keywords enabled but no input bundle supplied; counting as no-op");
            g.n_noop += 1;
        }
    }

    apply_simple_group(
        NormaliseGroup::Creator,
        is_enabled(NormaliseGroup::Creator),
        item.group_inputs.creator.as_ref(),
        &mut edits,
        &mut stats,
        normalise_creator,
    );
    apply_simple_group(
        NormaliseGroup::Copyright,
        is_enabled(NormaliseGroup::Copyright),
        item.group_inputs.copyright.as_ref(),
        &mut edits,
        &mut stats,
        normalise_copyright,
    );
    apply_simple_group(
        NormaliseGroup::Headline,
        is_enabled(NormaliseGroup::Headline),
        item.group_inputs.headline.as_ref(),
        &mut edits,
        &mut stats,
        normalise_headline,
    );

    if is_enabled(NormaliseGroup::Location) {
        let g = stats.group(NormaliseGroup::Location);
        if let Some(input) = item.group_inputs.location.as_ref() {
            // Plan §2: Group B / Group C see POST-normalisation
            // location context. Use the same primary-wins canonical
            // logic Group G uses to populate drafts.
            location_context = Some(derive_location_canonical(input));
            let outcome = normalise_location(input);
            g.n_location_xmp_iim_conflict = outcome.n_xmp_iim_conflict;
            if outcome.n_xmp_iim_conflict > 0 {
                g.n_conflict_primary_won = 1;
            }
            match outcome.output {
                Some(out) => {
                    edits.extend(out.edits);
                    g.n_normalised_deterministic += 1;
                }
                None => g.n_noop += 1,
            }
        } else {
            log::warn!("[normalise] group location enabled but no input bundle supplied; counting as no-op");
            g.n_noop += 1;
        }
    }

    if is_enabled(NormaliseGroup::Dates) {
        let g = stats.group(NormaliseGroup::Dates);
        if let Some(input) = item.group_inputs.dates.as_ref() {
            // Capture date context for pass-2 — use whatever H1 source
            // resolves cleanest (DTO first).
            date_context = input
                .date_time_original
                .clone()
                .or_else(|| input.photoshop_date_created.clone())
                .or_else(|| input.iptc_date_created.clone())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let outcome = normalise_dates(input);
            g.n_date_conflict = outcome.n_date_conflict;
            g.n_dto_from_filename = outcome.n_dto_from_filename;
            g.n_dto_from_filename_date_only = outcome.n_dto_from_filename_date_only;
            g.n_unparseable_date_inputs = outcome.n_unparseable_inputs;
            if outcome.n_date_conflict > 0 {
                g.n_conflict_primary_won = 1;
            }
            match outcome.output {
                Some(out) => {
                    edits.extend(out.edits);
                    g.n_normalised_deterministic += 1;
                }
                None => g.n_noop += 1,
            }
        } else {
            log::warn!("[normalise] group dates enabled but no input bundle supplied; counting as no-op");
            g.n_noop += 1;
        }
    }

    // ── Pass 2: Description (reads pass-1 context) ──
    let mut description_canonical: Option<String> = None;
    if is_enabled(NormaliseGroup::Description) {
        if let Some(input) = item.group_inputs.description.as_ref() {
            // Augment the caller-supplied bundle with pass-1
            // context. Caller-provided values win when both are set.
            let mut augmented = input.clone();
            if augmented.keywords_context.is_empty() {
                augmented.keywords_context = keywords_leaves.clone();
            }
            if augmented.location_context.is_none() {
                augmented.location_context = location_context.clone();
            }
            if augmented.date_context.is_none() {
                augmented.date_context = date_context.clone();
            }
            let outcome = normalise_description(&augmented, ai).await;
            if outcome.ai_fired {
                if let Some(u) = outcome.ai_usage.clone() {
                    ai_calls.push(PerImageAiCall {
                        group: "description",
                        usage: u,
                        error: None,
                    });
                }
            }
            if let Some(err) = outcome.ai_error.clone() {
                stats.group(NormaliseGroup::Description).n_ai_errors += 1;
                ai_calls.push(PerImageAiCall {
                    group: "description",
                    usage: AiCallUsage::default(),
                    error: Some(err.detail.clone()),
                });
                if first_ai_error.is_none() {
                    first_ai_error = Some(err);
                }
            }
            // Pass-3 (Title) reads the canonical description directly
            // from the outcome — populated for every successful case
            // (1/2/3/4-success) and `None` only for AI failures or
            // all-empty inputs.
            description_canonical = outcome.canonical.clone();
            let ai_fired = outcome.ai_fired;
            let g = stats.group(NormaliseGroup::Description);
            match outcome.output {
                Some(out) => {
                    edits.extend(out.edits);
                    if ai_fired {
                        g.n_normalised_ai += 1;
                    } else {
                        g.n_normalised_deterministic += 1;
                    }
                }
                None => g.n_noop += 1,
            }
        } else {
            log::warn!("[normalise] group description enabled but no input bundle supplied; counting as no-op");
            stats.group(NormaliseGroup::Description).n_noop += 1;
        }
    }

    // ── Pass 3: Title (reads pass-2 canonical) ──
    if is_enabled(NormaliseGroup::Title) {
        if let Some(input) = item.group_inputs.title.as_ref() {
            let mut augmented = input.clone();
            if augmented.description_canonical.is_none() {
                augmented.description_canonical = description_canonical.clone();
            }
            if augmented.location_context.is_none() {
                augmented.location_context = location_context.clone();
            }
            if augmented.keywords_context.is_empty() {
                augmented.keywords_context = keywords_leaves.clone();
            }
            let outcome = normalise_title(&augmented, ai).await;
            if outcome.ai_fired {
                if let Some(u) = outcome.ai_usage.clone() {
                    ai_calls.push(PerImageAiCall {
                        group: "title",
                        usage: u,
                        error: None,
                    });
                }
            }
            if let Some(err) = outcome.ai_error.clone() {
                stats.group(NormaliseGroup::Title).n_ai_errors += 1;
                ai_calls.push(PerImageAiCall {
                    group: "title",
                    usage: AiCallUsage::default(),
                    error: Some(err.detail.clone()),
                });
                if first_ai_error.is_none() {
                    first_ai_error = Some(err);
                }
            }
            let ai_fired = outcome.ai_fired;
            let g = stats.group(NormaliseGroup::Title);
            match outcome.output {
                Some(out) => {
                    edits.extend(out.edits);
                    if ai_fired {
                        g.n_normalised_ai += 1;
                    } else {
                        g.n_normalised_deterministic += 1;
                    }
                }
                None => g.n_noop += 1,
            }
        } else {
            log::warn!("[normalise] group title enabled but no input bundle supplied; counting as no-op");
            stats.group(NormaliseGroup::Title).n_noop += 1;
        }
    }

    (edits, stats, first_ai_error, ai_calls)
}

/// Whole-batch summary emitted with the `normalise_complete` event.
/// Shape matches plan §10.
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
    /// Per-group counters summed across every image in the batch.
    /// Only includes entries for groups that the dispatcher actually
    /// visited; absent keys mean the group was disabled for every
    /// image.
    pub per_group: std::collections::BTreeMap<NormaliseGroup, PerGroupStats>,
    /// Sum of USD cost across every AI call (description + title)
    /// emitted by this batch. Driven by the audit-log writer in
    /// `lib.rs`, which has access to the pricing table.
    pub ai_cost_total_usd: f64,
    /// Total successful + failed AI calls across the batch
    /// (description + title). Matches the number of rows appended to
    /// the audit log JSONL.
    pub ai_calls_total: u32,
}

impl NormaliseSummary {
    pub fn accumulate(&mut self, per_image: &PerImageStats) {
        for (group, src) in &per_image.per_group {
            let dst = self.per_group.entry(*group).or_default();
            dst.n_noop += src.n_noop;
            dst.n_normalised_deterministic += src.n_normalised_deterministic;
            dst.n_normalised_ai += src.n_normalised_ai;
            dst.n_conflict_primary_won += src.n_conflict_primary_won;
            dst.n_location_xmp_iim_conflict += src.n_location_xmp_iim_conflict;
            dst.n_date_conflict += src.n_date_conflict;
            dst.n_dto_from_filename += src.n_dto_from_filename;
            dst.n_dto_from_filename_date_only += src.n_dto_from_filename_date_only;
            dst.n_unparseable_date_inputs += src.n_unparseable_date_inputs;
            dst.n_ai_errors += src.n_ai_errors;
        }
    }

    /// Record a per-image audit-log row's cost. Called by the
    /// dispatcher in `lib.rs` for every AI call (success or failure)
    /// after it has computed the USD cost from the pricing table.
    pub fn record_ai_call(&mut self, cost_usd: f64) {
        self.ai_calls_total += 1;
        self.ai_cost_total_usd += cost_usd;
    }
}

#[cfg(test)]
mod tests_dispatcher {
    use super::*;

    #[tokio::test]
    async fn enabled_groups_filter() {
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
        let (edits, stats, _err, _calls) = process_image(&item, &[NormaliseGroup::Keywords], None, None).await;
        assert!(edits.contains_key("XMP-dc:Subject"));
        assert!(!edits.contains_key("XMP-dc:Creator"));
        let kw = stats.per_group.get(&NormaliseGroup::Keywords).unwrap();
        assert_eq!(kw.n_normalised_deterministic, 1);
        assert_eq!(kw.n_noop, 0);
        // Creator was disabled — should not appear in the per-group
        // map at all.
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Creator));
    }

    #[tokio::test]
    async fn all_groups_noop_when_already_normalised() {
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs::default(),
        };
        let (edits, stats, _err, _calls) = process_image(
            &item,
            &[
                NormaliseGroup::Keywords,
                NormaliseGroup::Creator,
                NormaliseGroup::Copyright,
                NormaliseGroup::Headline,
                NormaliseGroup::Title,
                NormaliseGroup::Location,
                NormaliseGroup::Dates,
                NormaliseGroup::Description,
            ],
            None,
            None,
        ).await;
        assert!(edits.is_empty());
        assert_eq!(stats.per_group.len(), 8);
        for (_, g) in &stats.per_group {
            assert_eq!(g.n_normalised_deterministic, 0);
            assert_eq!(g.n_normalised_ai, 0);
            assert_eq!(g.n_noop, 1);
        }
        assert!(stats.all_noop());
    }

    #[tokio::test]
    async fn description_inherits_keywords_context_from_pass1() {
        // Keywords runs first → its canonical leaves are passed into
        // Group B's input as `keywords_context`.
        struct ContextCapturingAi {
            captured: tokio::sync::Mutex<Option<DescriptionMergePrompt>>,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for ContextCapturingAi {
            async fn merge_description(
                &self,
                p: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                *self.captured.lock().await = Some(p);
                Ok(("merged".into(), AiCallUsage::default()))
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
        }
        let ai = ContextCapturingAi { captured: tokio::sync::Mutex::new(None) };
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                keywords: Some(KeywordsInput {
                    dc_subject: vec!["Lion".into(), "Statue".into()],
                    ..Default::default()
                }),
                description: Some(DescriptionInput {
                    description: Some("first version".into()),
                    image_description: Some("different version".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        };
        let _ = process_image(
            &item,
            &[NormaliseGroup::Keywords, NormaliseGroup::Description],
            Some(&ai),
            None,
        ).await;
        let captured = ai.captured.lock().await.take().expect("AI must fire on distinct sources");
        assert!(captured.keywords.contains(&"lion".to_string()));
        assert!(captured.keywords.contains(&"statue".to_string()));
    }

    #[tokio::test]
    async fn title_case3_inherits_description_canonical_from_pass2() {
        struct TitleAi {
            captured_description: tokio::sync::Mutex<Option<String>>,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for TitleAi {
            async fn merge_description(&self, _: DescriptionMergePrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
            async fn generate_title(&self, p: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                *self.captured_description.lock().await = Some(p.description);
                Ok(("Generated Title".into(), AiCallUsage::default()))
            }
        }
        let ai = TitleAi { captured_description: tokio::sync::Mutex::new(None) };
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    description: Some("A factual sentence.".into()),
                    ..Default::default()
                }),
                title: Some(TitleInput::default()), // all targets empty → case 3
                ..Default::default()
            },
        };
        let (edits, _, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Description, NormaliseGroup::Title],
            Some(&ai),
            None,
        ).await;
        let captured = ai.captured_description.lock().await.take().expect("title AI must fire");
        assert_eq!(captured, "A factual sentence.");
        // Generated title became a draft.
        let title_draft = edits.get("XMP-dc:Title").expect("title draft present");
        match &title_draft.value {
            Some(Variant::String(s)) => assert_eq!(s, "Generated Title"),
            other => panic!("expected String, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn cancelled_flag_skips_remaining_groups() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        // Cancel flag pre-set: every group should be skipped, the
        // per_group map stays empty (plan §12: cancelled groups are
        // NOT counted as noops).
        let cancel = Arc::new(AtomicBool::new(true));
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
        let (edits, stats, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Keywords, NormaliseGroup::Creator],
            None,
            Some(&cancel),
        ).await;
        assert!(edits.is_empty());
        assert!(stats.per_group.is_empty());
        // Sanity: clearing the flag and rerunning emits drafts.
        cancel.store(false, Ordering::Relaxed);
        let (edits, stats, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Keywords, NormaliseGroup::Creator],
            None,
            Some(&cancel),
        ).await;
        assert!(!edits.is_empty());
        assert_eq!(stats.per_group.len(), 2);
    }

    #[tokio::test]
    async fn cancellation_mid_image_preserves_earlier_drafts() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        // Mock AI that flips the cancel flag during the description
        // merge call. Title (next group) should then be skipped, but
        // the description drafts from this image survive.
        struct CancellingAi {
            cancel: Arc<AtomicBool>,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for CancellingAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                self.cancel.store(true, Ordering::Relaxed);
                Ok(("Merged version.".into(), AiCallUsage::default()))
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                panic!("title AI must NOT fire after cancel");
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let ai = CancellingAi { cancel: cancel.clone() };
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    description: Some("Version A.".into()),
                    image_description: Some("Different version B.".into()),
                    ..Default::default()
                }),
                title: Some(TitleInput::default()),
                ..Default::default()
            },
        };
        let (edits, stats, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Description, NormaliseGroup::Title],
            Some(&ai),
            Some(&cancel),
        ).await;
        // Description drafts survived.
        assert!(edits.contains_key("XMP-dc:Description"));
        // Title was skipped — never appears in per_group.
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Title));
        // Description recorded an AI-normalised count.
        let d = stats.per_group.get(&NormaliseGroup::Description).unwrap();
        assert_eq!(d.n_normalised_ai, 1);
    }

    fn make_per_image(entries: &[(NormaliseGroup, PerGroupStats)]) -> PerImageStats {
        let mut p = PerImageStats::default();
        for (g, s) in entries {
            *p.group(*g) = s.clone();
        }
        p
    }

    #[test]
    fn summary_accumulates_per_image_stats() {
        let mut summary = NormaliseSummary::default();
        summary.accumulate(&make_per_image(&[
            (NormaliseGroup::Keywords, PerGroupStats {
                n_normalised_deterministic: 1,
                ..Default::default()
            }),
            (NormaliseGroup::Location, PerGroupStats {
                n_normalised_deterministic: 1,
                n_conflict_primary_won: 1,
                n_location_xmp_iim_conflict: 1,
                ..Default::default()
            }),
            (NormaliseGroup::Dates, PerGroupStats {
                n_noop: 1,
                n_dto_from_filename: 1,
                n_dto_from_filename_date_only: 1,
                ..Default::default()
            }),
            (NormaliseGroup::Description, PerGroupStats {
                n_normalised_ai: 1,
                ..Default::default()
            }),
        ]));
        summary.accumulate(&make_per_image(&[
            (NormaliseGroup::Keywords, PerGroupStats {
                n_normalised_deterministic: 1,
                ..Default::default()
            }),
            (NormaliseGroup::Dates, PerGroupStats {
                n_normalised_deterministic: 1,
                n_date_conflict: 1,
                n_conflict_primary_won: 1,
                n_unparseable_date_inputs: 2,
                ..Default::default()
            }),
            (NormaliseGroup::Title, PerGroupStats {
                n_normalised_ai: 1,
                ..Default::default()
            }),
            (NormaliseGroup::Description, PerGroupStats {
                n_ai_errors: 1,
                ..Default::default()
            }),
        ]));
        let kw = summary.per_group.get(&NormaliseGroup::Keywords).unwrap();
        assert_eq!(kw.n_normalised_deterministic, 2);
        let loc = summary.per_group.get(&NormaliseGroup::Location).unwrap();
        assert_eq!(loc.n_location_xmp_iim_conflict, 1);
        assert_eq!(loc.n_conflict_primary_won, 1);
        let dates = summary.per_group.get(&NormaliseGroup::Dates).unwrap();
        assert_eq!(dates.n_normalised_deterministic, 1);
        assert_eq!(dates.n_noop, 1);
        assert_eq!(dates.n_dto_from_filename, 1);
        assert_eq!(dates.n_date_conflict, 1);
        assert_eq!(dates.n_unparseable_date_inputs, 2);
        let desc = summary.per_group.get(&NormaliseGroup::Description).unwrap();
        assert_eq!(desc.n_normalised_ai, 1);
        assert_eq!(desc.n_ai_errors, 1);
        let title = summary.per_group.get(&NormaliseGroup::Title).unwrap();
        assert_eq!(title.n_normalised_ai, 1);
    }

    #[tokio::test]
    async fn audit_log_roundtrip_for_ai_calls() {
        // Integration check: a Group B AI success and a Group C AI
        // failure both produce `PerImageAiCall` entries that write
        // distinct, parseable JSONL rows when fed through
        // `batch_audit_log::append`, with cost rolling into the
        // batch-level summary totals. Mirrors what lib.rs does at
        // runtime, just without the Tauri command shell.
        use crate::batch_audit_log;
        use serde::Deserialize;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        use tempfile::tempdir;

        struct MixedAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for MixedAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                Ok((
                    "Merged factual description.".into(),
                    AiCallUsage { input_tokens: 800, output_tokens: 250 },
                ))
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), String> {
                Err("simulated rate limit".into())
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let item = NormaliseRequestItem {
            rel_path: "trip/photo.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    description: Some("Version A.".into()),
                    image_description: Some("Different version B.".into()),
                    ..Default::default()
                }),
                title: Some(TitleInput::default()),
                ..Default::default()
            },
        };
        let (_edits, stats, _err, ai_calls) = process_image(
            &item,
            &[NormaliseGroup::Description, NormaliseGroup::Title],
            Some(&MixedAi),
            Some(&cancel),
        )
        .await;
        // Two AI calls were attempted (one ok, one error).
        assert_eq!(ai_calls.len(), 2);
        let success = ai_calls.iter().find(|c| c.error.is_none()).expect("description call ok");
        assert_eq!(success.group, "description");
        let failure = ai_calls.iter().find(|c| c.error.is_some()).expect("title call err");
        assert_eq!(failure.group, "title");

        // Write audit rows the way lib.rs does, then read them back
        // and assert the wire shape matches what users would see in
        // the JSONL.
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("normalise_audit.jsonl");
        let mut summary = NormaliseSummary::default();
        // Synthetic pricing — input $0.10/M, output $0.40/M → ~$0.000180 per call.
        let cost_per_call = |u: &AiCallUsage| {
            (u.input_tokens as f64 / 1_000_000.0) * 0.10
                + (u.output_tokens as f64 / 1_000_000.0) * 0.40
        };
        for call in &ai_calls {
            let cost = cost_per_call(&call.usage);
            let entry = NormaliseAuditEntry {
                ts: "2026-05-20T12:00:00Z".to_string(),
                model: "gpt-test".to_string(),
                prompt_version: "v1".to_string(),
                group: call.group.to_string(),
                input_tokens: call.usage.input_tokens,
                output_tokens: call.usage.output_tokens,
                cost_usd: cost,
                error: call.error.clone().unwrap_or_default(),
                relative_path: item.rel_path.clone(),
            };
            batch_audit_log::append(&log_path, &entry).unwrap();
            summary.record_ai_call(cost);
        }
        summary.accumulate(&stats);

        // NormaliseAuditEntry serialises snake_case (matches the
        // describe audit-log wire shape — the JSONL is read by us
        // / users grepping, not the frontend).
        #[derive(Debug, Deserialize)]
        struct ReadEntry {
            ts: String,
            model: String,
            prompt_version: String,
            group: String,
            input_tokens: u32,
            output_tokens: u32,
            cost_usd: f64,
            error: String,
            relative_path: String,
        }
        let log = std::fs::read_to_string(&log_path).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2, "two rows written");
        let parsed: Vec<ReadEntry> = lines
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let desc_row = parsed.iter().find(|r| r.group == "description").unwrap();
        assert_eq!(desc_row.input_tokens, 800);
        assert_eq!(desc_row.output_tokens, 250);
        assert_eq!(desc_row.model, "gpt-test");
        assert_eq!(desc_row.prompt_version, "v1");
        assert_eq!(desc_row.ts, "2026-05-20T12:00:00Z");
        assert_eq!(desc_row.relative_path, "trip/photo.jpg");
        assert!(desc_row.cost_usd > 0.0);
        assert!(desc_row.error.is_empty());
        let title_row = parsed.iter().find(|r| r.group == "title").unwrap();
        assert_eq!(title_row.input_tokens, 0);
        assert_eq!(title_row.output_tokens, 0);
        assert_eq!(title_row.cost_usd, 0.0);
        assert_eq!(title_row.error, "simulated rate limit");

        // Batch-level totals reflect both calls.
        assert_eq!(summary.ai_calls_total, 2);
        assert!((summary.ai_cost_total_usd - cost_per_call(&success.usage)).abs() < 1e-9);
        let desc = summary.per_group.get(&NormaliseGroup::Description).unwrap();
        assert_eq!(desc.n_normalised_ai, 1);
        let title = summary.per_group.get(&NormaliseGroup::Title).unwrap();
        assert_eq!(title.n_ai_errors, 1);
    }

    #[test]
    fn summary_record_ai_call_accumulates_cost_and_count() {
        let mut summary = NormaliseSummary::default();
        summary.record_ai_call(0.0001);
        summary.record_ai_call(0.0002);
        summary.record_ai_call(0.0);
        assert_eq!(summary.ai_calls_total, 3);
        assert!((summary.ai_cost_total_usd - 0.0003).abs() < 1e-9);
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
