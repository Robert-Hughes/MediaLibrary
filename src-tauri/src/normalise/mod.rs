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

// ── Group B: Description ───────────────────────────────────────────────
//
// Plan §1 Group B. Canonical = single paragraph, sentence-cased,
// factual tone, UTF-8 in the LangAlt primary. Derivatives adapt:
//   * `EXIF:ImageDescription` is ASCII-folded.
//   * `IPTC:Caption-Abstract` is truncated at 2000 bytes at a word
//     boundary; encoding depends on whether the file declares UTF-8
//     via `IPTC:CodedCharacterSet`.
//
// Conflict policy (plan §1):
//   1. All target sources empty → no drafts.
//   2. Exactly one target source non-empty → normalise + project.
//   3. Multiple target sources non-empty AND equal after normalise →
//      write the normalised form.
//   4. Multiple target sources non-empty AND distinct → **AI merge**
//      (case 5 in earlier plan numbering; here case 4 to match the
//      revised policy). Falls through to "best deterministic guess"
//      when no AI client is available — prefer the primary
//      `XMP-dc:Description` value or, if absent, the longest source.

pub const DESCRIPTION_TARGET_TAGS: &[&str] = &[
    "XMP-dc:Description",
    "EXIF:ImageDescription",
    "IPTC:Caption-Abstract",
];

const IPTC_CAPTION_ABSTRACT_LIMIT: usize = 2000;

/// Normalise a description string — collapse internal whitespace, trim
/// ends, leave casing alone (the AI prompt enforces sentence case in
/// case 4; we don't fight user-provided text in cases 2/3).
fn normalise_description_text(s: &str) -> String {
    collapse_whitespace_single_line(s)
}

/// ASCII-fold for `EXIF:ImageDescription`. Strip diacritics, replace
/// common smart-quotes / dashes with ASCII equivalents, drop
/// anything outside the printable ASCII range.
fn ascii_fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let replacement: &str = match c {
            '“' | '”' | '„' | '‟' => "\"",
            '‘' | '’' | '‚' | '‛' => "'",
            '–' | '—' => "--",
            '…' => "...",
            '«' | '»' => "\"",
            // Common accented chars — strip to base. Sufficient for
            // the EXIF ASCII spec which fails open on UTF-8 anyway.
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => "a",
            'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => "A",
            'é' | 'è' | 'ê' | 'ë' => "e",
            'É' | 'È' | 'Ê' | 'Ë' => "E",
            'í' | 'ì' | 'î' | 'ï' => "i",
            'Í' | 'Ì' | 'Î' | 'Ï' => "I",
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' => "o",
            'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => "O",
            'ú' | 'ù' | 'û' | 'ü' => "u",
            'Ú' | 'Ù' | 'Û' | 'Ü' => "U",
            'ñ' => "n",
            'Ñ' => "N",
            'ç' => "c",
            'Ç' => "C",
            'ß' => "ss",
            _ if c.is_ascii() => {
                out.push(c);
                continue;
            }
            _ => "", // drop anything else
        };
        out.push_str(replacement);
    }
    out
}

/// Build the IPTC Caption-Abstract projection.
fn project_caption_abstract(canonical: &str, charset_is_utf8: bool) -> String {
    let body = if charset_is_utf8 {
        canonical.to_string()
    } else {
        ascii_fold(canonical)
    };
    truncate_at_word(&body, IPTC_CAPTION_ABSTRACT_LIMIT)
}

/// Typed AI failure surfaced by Group B / Group C up to the dispatcher.
/// Mapped to a `BatchFailureKind` so per-image failure rows preserve
/// the failure mode (rate-limit, transport, bad JSON, missing key).
#[derive(Debug, Clone)]
pub struct NormaliseAiError {
    pub kind: crate::batch_job::BatchFailureKind,
    pub detail: String,
}

impl NormaliseAiError {
    pub fn key_missing() -> Self {
        Self {
            kind: crate::batch_job::BatchFailureKind::AiKeyMissing,
            detail: "OpenAI API key is not configured. Open Settings to enter your key.".into(),
        }
    }

    /// Classify a `String` error returned by `NormaliseAiClient` calls
    /// into a typed BatchFailureKind. Recognises `HTTP 429` for rate
    /// limiting, `HTTP <other>` and `network error:` prefixes for
    /// transport failures, schema-shaped strings for malformed
    /// responses, and falls back to `AiCallFailed` otherwise.
    pub fn from_client_string(detail: String) -> Self {
        use crate::batch_job::BatchFailureKind as K;
        let kind = if detail.starts_with("HTTP 429") {
            K::AiRateLimited
        } else if detail.starts_with("HTTP ") || detail.starts_with("network error:") {
            K::AiCallFailed
        } else if detail.starts_with("missing output[")
            || detail.starts_with("bad description JSON")
            || detail.starts_with("bad title JSON")
            || detail.starts_with("bad JSON")
        {
            K::AiSchemaInvalid
        } else {
            K::AiCallFailed
        };
        Self { kind, detail }
    }
}

/// AI-call inputs passed to the Description merge prompt builder.
/// Surfaced separately so tests can inspect the prompt without a real
/// HTTP client.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct DescriptionMergePrompt {
    pub description_sources: std::collections::BTreeMap<String, String>,
    pub ai_context: std::collections::BTreeMap<String, serde_json::Value>,
    pub location: serde_json::Value,
    pub keywords: Vec<String>,
    pub date: Option<String>,
}

/// Build the prompt body sent to the AI merge call. Pure function so
/// tests can pin the wire shape.
pub fn build_description_merge_prompt(input: &DescriptionInput) -> DescriptionMergePrompt {
    let mut description_sources = std::collections::BTreeMap::new();
    if let Some(s) = input.description.as_deref().filter(|s| !s.trim().is_empty()) {
        description_sources.insert("XMP-dc:Description".into(), s.trim().to_string());
    }
    if let Some(s) = input.image_description.as_deref().filter(|s| !s.trim().is_empty()) {
        description_sources.insert("EXIF:ImageDescription".into(), s.trim().to_string());
    }
    if let Some(s) = input.caption_abstract.as_deref().filter(|s| !s.trim().is_empty()) {
        description_sources.insert("IPTC:Caption-Abstract".into(), s.trim().to_string());
    }

    let mut ai_context = std::collections::BTreeMap::new();
    if let Some(s) = input.ai_description.as_deref().filter(|s| !s.trim().is_empty()) {
        ai_context.insert(
            "XMP-mlib:AIDescription".into(),
            serde_json::Value::String(s.trim().to_string()),
        );
    }
    if let Some(s) = input.ai_interpretation.as_deref().filter(|s| !s.trim().is_empty()) {
        ai_context.insert(
            "XMP-mlib:AIInterpretation".into(),
            serde_json::Value::String(s.trim().to_string()),
        );
    }
    if !input.ai_ocr_text.is_empty() {
        ai_context.insert(
            "XMP-mlib:AIOcrText".into(),
            serde_json::Value::Array(
                input.ai_ocr_text.iter().map(|s| serde_json::Value::String(s.clone())).collect(),
            ),
        );
    }
    if !input.ai_objects.is_empty() {
        ai_context.insert(
            "XMP-mlib:AIObjects".into(),
            serde_json::Value::Array(
                input.ai_objects.iter().map(|s| serde_json::Value::String(s.clone())).collect(),
            ),
        );
    }

    let location = match &input.location_context {
        Some(lc) => {
            let mut m = serde_json::Map::new();
            if let Some(s) = lc.location.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("location".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.city.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("city".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.state.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("state".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.country.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("country".into(), serde_json::Value::String(s.into()));
            }
            serde_json::Value::Object(m)
        }
        None => serde_json::Value::Null,
    };

    DescriptionMergePrompt {
        description_sources,
        ai_context,
        location,
        keywords: input.keywords_context.clone(),
        date: input.date_context.clone(),
    }
}

/// Captures the prompts that would have fired so the estimate phase
/// (plan §7) can preflight them against `/responses/input_tokens`
/// without actually dispatching. Returns deterministic stand-ins from
/// the trait calls so the dispatcher can still walk Group C with a
/// plausible description canonical when Group B is in case-4.
#[derive(Default)]
pub struct CapturingAiClient {
    pub description_prompts: tokio::sync::Mutex<Vec<DescriptionMergePrompt>>,
    pub title_prompts: tokio::sync::Mutex<Vec<TitleGenPrompt>>,
}

#[async_trait::async_trait]
impl NormaliseAiClient for CapturingAiClient {
    async fn merge_description(
        &self,
        p: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), String> {
        let stand_in = p
            .description_sources
            .values()
            .find(|s| !s.is_empty())
            .cloned()
            .unwrap_or_default();
        self.description_prompts.lock().await.push(p);
        Ok((stand_in, AiCallUsage::default()))
    }

    async fn generate_title(
        &self,
        p: TitleGenPrompt,
    ) -> Result<(String, AiCallUsage), String> {
        let stand_in = p
            .description
            .split_whitespace()
            .take(8)
            .collect::<Vec<_>>()
            .join(" ");
        self.title_prompts.lock().await.push(p);
        Ok((stand_in, AiCallUsage::default()))
    }
}

/// Coherent-replacement helper (plan §4 strict). For each target tag in
/// `group_targets`, if the group's projection has no value for that
/// tag AND the current state holds a non-empty value, emit a
/// remove-tag draft. Set-value drafts are the responsibility of each
/// group's own function — this helper exists to handle the
/// "canonical has N fields populated and M derivatives empty" case
/// the plan describes.
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

/// Per-AI-call record returned by `process_image` so the dispatcher
/// can append a row to the JSONL audit log for each one. Includes
/// successful calls (with usage) and failed calls (with detail).
#[derive(Debug, Clone)]
pub struct PerImageAiCall {
    /// `"description"` (Group B) or `"title"` (Group C).
    pub group: &'static str,
    pub usage: AiCallUsage,
    /// `None` on success; `Some(detail)` when the call failed.
    pub error: Option<String>,
}

/// Per-call token usage returned by `NormaliseAiClient` implementors.
/// Mock clients can return `Default::default()`; the production
/// `OpenAiNormaliseClient` parses these out of the `/responses`
/// response body so the audit log can record real cost.
#[derive(Debug, Clone, Default)]
pub struct AiCallUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// Audit-log row recorded for one AI call. Written to a JSONL file by
/// the dispatcher; shape matches plan §6 "cost audit".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NormaliseAuditEntry {
    pub ts: String,
    pub model: String,
    pub prompt_version: String,
    /// `"description"` (Group B) or `"title"` (Group C).
    pub group: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cost_usd: f64,
    /// Empty string on success; failure detail otherwise.
    pub error: String,
    pub relative_path: String,
}

/// Trait that an injected AI client implements for Group B (and Group
/// C). Tests substitute a mock; production wires
/// `OpenAiNormaliseClient` (see `openai_normalise.rs`).
#[async_trait::async_trait]
pub trait NormaliseAiClient: Send + Sync {
    /// Returns the canonical merged description plus per-call token
    /// usage. Errors are surfaced to the caller and turned into
    /// per-image failure rows.
    async fn merge_description(
        &self,
        prompt: DescriptionMergePrompt,
    ) -> Result<(String, AiCallUsage), String>;

    /// Generate a short title from a description + context. Case-3
    /// Title AI path.
    async fn generate_title(
        &self,
        prompt: TitleGenPrompt,
    ) -> Result<(String, AiCallUsage), String>;
}

/// Title-generation prompt body.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct TitleGenPrompt {
    pub description: String,
    pub location: serde_json::Value,
    pub keywords: Vec<String>,
}

/// Outcome of Group B normalisation. Tracks whether the AI fired so
/// stats / audit log can count.
#[derive(Debug, Clone, Default)]
pub struct DescriptionOutcome {
    pub output: Option<GroupOutput>,
    pub ai_fired: bool,
    /// Set when Group B needed to call AI but the call failed OR the
    /// API key was not configured. Surfaced as a per-image failure row
    /// by the dispatcher. Deterministic cases never populate this.
    pub ai_error: Option<NormaliseAiError>,
    /// Token usage when the AI fired (success or error if usage is
    /// available). Drives the audit-log entry written by the dispatcher.
    pub ai_usage: Option<AiCallUsage>,
    /// The canonical description string the group resolved on, regardless
    /// of whether any drafts were emitted. Populated whenever Group B
    /// reaches a non-empty canonical (cases 2/3/4 success); `None` for
    /// all-empty case 1 and for AI failures. Surfaced so pass-3 (Title)
    /// can read the canonical without fishing it out of the edits map.
    pub canonical: Option<String>,
}

/// Run Group B (Description) normalisation. Async because case-4 may
/// call the injected AI client.
pub async fn normalise_description(
    input: &DescriptionInput,
    ai: Option<&dyn NormaliseAiClient>,
) -> DescriptionOutcome {
    let primary = normalise_description_text(input.description.as_deref().unwrap_or(""));
    let image_desc = normalise_description_text(input.image_description.as_deref().unwrap_or(""));
    let caption = normalise_description_text(input.caption_abstract.as_deref().unwrap_or(""));

    let target_sources: Vec<(&str, String)> = vec![
        ("XMP-dc:Description", primary),
        ("EXIF:ImageDescription", image_desc),
        ("IPTC:Caption-Abstract", caption),
    ];
    let non_empty: Vec<(&str, String)> = target_sources
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .cloned()
        .collect();

    // Case 1: all-empty → no drafts.
    if non_empty.is_empty() {
        return DescriptionOutcome::default();
    }

    // Cases 2 and 3 — single source OR multiple equal-after-normalise.
    let distinct: std::collections::BTreeSet<&str> =
        non_empty.iter().map(|(_, v)| v.as_str()).collect();
    let mut ai_usage: Option<AiCallUsage> = None;
    let (canonical, ai_fired) = if distinct.len() == 1 {
        (non_empty[0].1.clone(), false)
    } else {
        // Case 4: AI merge when sources distinct. Plan §1 Group B
        // requires AI here; no deterministic fallback. When the AI
        // client is absent or the call fails the image surfaces as
        // a failure row and no Group B drafts are emitted.
        let prompt = build_description_merge_prompt(input);
        match ai {
            Some(client) => match client.merge_description(prompt).await {
                Ok((merged, usage)) => {
                    ai_usage = Some(usage);
                    (normalise_description_text(&merged), true)
                }
                Err(e) => {
                    return DescriptionOutcome {
                        ai_error: Some(NormaliseAiError::from_client_string(e)),
                        ..Default::default()
                    };
                }
            },
            None => {
                return DescriptionOutcome {
                    ai_error: Some(NormaliseAiError::key_missing()),
                    ..Default::default()
                };
            }
        }
    };

    if canonical.is_empty() {
        return DescriptionOutcome { ai_fired, ai_usage, ..Default::default() };
    }

    let projection_image = ascii_fold(&canonical);
    let projection_caption = project_caption_abstract(&canonical, input.iptc_charset_is_utf8);

    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    if input.description.as_deref() != Some(canonical.as_str()) {
        edits.insert(
            "XMP-dc:Description".to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical.clone())),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if input.image_description.as_deref() != Some(projection_image.as_str()) {
        edits.insert(
            "EXIF:ImageDescription".to_string(),
            DraftEdit {
                value: Some(Variant::String(projection_image)),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if input.caption_abstract.as_deref() != Some(projection_caption.as_str()) {
        edits.insert(
            "IPTC:Caption-Abstract".to_string(),
            DraftEdit {
                value: Some(Variant::String(projection_caption)),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }

    DescriptionOutcome {
        output: if edits.is_empty() { None } else { Some(GroupOutput { edits }) },
        ai_fired,
        ai_error: None,
        ai_usage,
        canonical: Some(canonical),
    }
}

#[cfg(test)]
mod tests_description {
    use super::*;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String for {}, got {:?}", k, other),
        }
    }

    #[tokio::test]
    async fn all_empty_returns_no_drafts() {
        let out = normalise_description(&DescriptionInput::default(), None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
    }

    #[tokio::test]
    async fn single_source_propagates_to_all_targets() {
        let input = DescriptionInput {
            description: Some("A sunset on the bay.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        assert_eq!(s(&g, "EXIF:ImageDescription"), "A sunset on the bay.");
        assert_eq!(s(&g, "IPTC:Caption-Abstract"), "A sunset on the bay.");
    }

    #[tokio::test]
    async fn whitespace_normalisation_triggers_drafts() {
        let input = DescriptionInput {
            description: Some("  A   sunset  ".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        assert_eq!(s(&g, "XMP-dc:Description"), "A sunset");
    }

    #[tokio::test]
    async fn equal_after_normalise_propagates() {
        let input = DescriptionInput {
            description: Some("A sunset.".into()),
            image_description: Some("A sunset.".into()),
            caption_abstract: Some("A sunset.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        // Already in sync — idempotency check below ensures no drafts.
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        // Canonical is still surfaced so pass-3 can use it.
        assert_eq!(out.canonical.as_deref(), Some("A sunset."));
    }

    #[tokio::test]
    async fn canonical_none_when_all_sources_empty() {
        let out = normalise_description(&DescriptionInput::default(), None).await;
        assert!(out.canonical.is_none());
    }

    #[tokio::test]
    async fn canonical_populated_for_single_source() {
        let input = DescriptionInput {
            description: Some("A misty morning.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        assert_eq!(out.canonical.as_deref(), Some("A misty morning."));
    }

    #[tokio::test]
    async fn ascii_fold_for_image_description() {
        let input = DescriptionInput {
            description: Some("André Müller’s café".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        // EXIF:ImageDescription ASCII-folded.
        assert_eq!(s(&g, "EXIF:ImageDescription"), "Andre Muller's cafe");
        // XMP-dc:Description equals the input already — no draft for
        // it; the canonical is the input.
        assert!(!g.edits.contains_key("XMP-dc:Description"));
    }

    #[tokio::test]
    async fn caption_abstract_truncated_at_2000_bytes() {
        let long = "word ".repeat(500); // ~2500 bytes
        let trimmed = long.trim_end().to_string();
        let input = DescriptionInput {
            description: Some(trimmed.clone()),
            iptc_charset_is_utf8: true,
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        let cap = s(&g, "IPTC:Caption-Abstract");
        assert!(cap.len() <= IPTC_CAPTION_ABSTRACT_LIMIT);
        assert!(!cap.ends_with(' '));
        assert!(cap.ends_with("word"));
    }

    #[tokio::test]
    async fn distinct_sources_with_no_ai_returns_key_missing_error() {
        let input = DescriptionInput {
            description: Some("Primary version.".into()),
            image_description: Some("Different version.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        // Plan §1 Group B case-4: AI required. No deterministic
        // fallback. No drafts emitted; ai_error surfaces as a per-image
        // failure row in the dispatcher.
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiKeyMissing);
    }

    #[tokio::test]
    async fn distinct_sources_with_ai_use_merged_canonical() {
        struct MockAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for MockAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                Ok(("Merged factual description.".into(), AiCallUsage::default()))
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
        }
        let input = DescriptionInput {
            description: Some("Primary.".into()),
            image_description: Some("Different.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, Some(&MockAi)).await;
        let g = out.output.unwrap();
        assert_eq!(s(&g, "XMP-dc:Description"), "Merged factual description.");
        assert!(out.ai_fired);
    }

    #[tokio::test]
    async fn ai_error_returns_no_drafts_and_records_typed_error() {
        struct FailingAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for FailingAi {
            async fn merge_description(&self, _: DescriptionMergePrompt) -> Result<(String, AiCallUsage), String> {
                Err("HTTP 429: too many requests".into())
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
        }
        let input = DescriptionInput {
            description: Some("Primary.".into()),
            image_description: Some("Different.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, Some(&FailingAi)).await;
        // Plan §1: no fallback. No drafts; failure surfaces to dispatcher.
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiRateLimited);
        assert!(err.detail.contains("HTTP 429"));
    }

    #[test]
    fn merge_prompt_strips_empty_sources_and_includes_ai_context() {
        let input = DescriptionInput {
            description: Some("Primary".into()),
            image_description: Some("".into()),
            ai_description: Some("AI-generated".into()),
            ai_ocr_text: vec!["signage".into()],
            ai_objects: vec!["statue".into()],
            keywords_context: vec!["statue".into(), "london".into()],
            date_context: Some("2024-08-12".into()),
            location_context: Some(LocationContext {
                city: Some("London".into()),
                country: Some("UK".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let prompt = build_description_merge_prompt(&input);
        assert!(prompt.description_sources.contains_key("XMP-dc:Description"));
        assert!(!prompt.description_sources.contains_key("EXIF:ImageDescription"));
        assert!(prompt.ai_context.contains_key("XMP-mlib:AIDescription"));
        assert!(prompt.ai_context.contains_key("XMP-mlib:AIOcrText"));
        assert!(prompt.ai_context.contains_key("XMP-mlib:AIObjects"));
        assert_eq!(prompt.keywords, vec!["statue".to_string(), "london".to_string()]);
        assert_eq!(prompt.date.as_deref(), Some("2024-08-12"));
        assert_eq!(prompt.location["city"], "London");
        assert_eq!(prompt.location["country"], "UK");
    }

    #[tokio::test]
    async fn idempotent_after_one_pass() {
        let input = DescriptionInput {
            description: Some("A sunset.".into()),
            ..Default::default()
        };
        let first = normalise_description(&input, None).await.output.unwrap();
        // Build post-apply state. XMP-dc:Description equalled the
        // input so no draft fired for it — read back from the input.
        // The other two targets adopted the canonical from `first`.
        let post = DescriptionInput {
            description: Some("A sunset.".into()),
            image_description: Some(s(&first, "EXIF:ImageDescription")),
            caption_abstract: Some(s(&first, "IPTC:Caption-Abstract")),
            ..Default::default()
        };
        let second = normalise_description(&post, None).await;
        assert!(second.output.is_none());
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
    collapse_whitespace_single_line(s)
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
    let collapsed = collapse_whitespace_single_line(s);
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
    None
}

/// Build the Group C AI-title prompt body. Pure function so tests can
/// pin the wire shape.
pub fn build_title_gen_prompt(input: &TitleInput) -> Option<TitleGenPrompt> {
    let description = input
        .description_canonical
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let location = match &input.location_context {
        Some(lc) => {
            let mut m = serde_json::Map::new();
            if let Some(s) = lc.location.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("location".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.city.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("city".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.state.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("state".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.country.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("country".into(), serde_json::Value::String(s.into()));
            }
            serde_json::Value::Object(m)
        }
        None => serde_json::Value::Null,
    };
    Some(TitleGenPrompt {
        description,
        location,
        keywords: input.keywords_context.clone(),
    })
}

/// Outcome of Title normalisation. Mirrors `DescriptionOutcome` so the
/// dispatcher can record AI-fired stats and audit-log errors.
#[derive(Debug, Clone, Default)]
pub struct TitleOutcome {
    pub output: Option<GroupOutput>,
    pub ai_fired: bool,
    /// Populated when case-3 (AI title generation) was required but
    /// failed or the AI client was unavailable. Surfaced as a failure
    /// row by the dispatcher; never set for deterministic cases.
    pub ai_error: Option<NormaliseAiError>,
    pub ai_usage: Option<AiCallUsage>,
}

fn title_is_normalised(input: &TitleInput, canonical: &str) -> bool {
    let object_projection = truncate_at_word(canonical, IPTC_OBJECT_NAME_LIMIT);
    input.title.as_deref() == Some(canonical)
        && input.object_name.as_deref() == Some(object_projection.as_str())
}

/// Run Group C (Title) normalisation for one image.
///
/// Cases 1, 2 are deterministic (primary or derivative wins).
/// Case 3 fires the AI title-generation path when all targets are
/// empty and `description_canonical` is non-empty AND an AI client is
/// supplied. Without an AI client this case is a no-op.
pub async fn normalise_title(
    input: &TitleInput,
    ai: Option<&dyn NormaliseAiClient>,
) -> TitleOutcome {
    let mut ai_fired = false;
    let mut ai_usage: Option<AiCallUsage> = None;

    let canonical_opt = derive_title_canonical(input);
    let canonical = match canonical_opt {
        Some(c) => c,
        None => {
            // Case 3: AI title generation from description. Plan §1
            // Group C: required when targets are all empty and a
            // description canonical exists. Without AI, surface as a
            // failure row; without a description, no-op (case 4).
            match build_title_gen_prompt(input) {
                None => return TitleOutcome::default(),
                Some(prompt) => match ai {
                    None => {
                        return TitleOutcome {
                            ai_error: Some(NormaliseAiError::key_missing()),
                            ..Default::default()
                        };
                    }
                    Some(client) => match client.generate_title(prompt).await {
                        Ok((generated, usage)) => {
                            ai_fired = true;
                            ai_usage = Some(usage);
                            let n = normalise_title_text(&generated);
                            if n.is_empty() {
                                return TitleOutcome { ai_fired, ai_usage, ..Default::default() };
                            }
                            n
                        }
                        Err(e) => {
                            return TitleOutcome {
                                ai_error: Some(NormaliseAiError::from_client_string(e)),
                                ..Default::default()
                            };
                        }
                    },
                },
            }
        }
    };

    if title_is_normalised(input, &canonical) {
        return TitleOutcome { ai_fired, ai_usage, ..Default::default() };
    }
    let object = truncate_at_word(&canonical, IPTC_OBJECT_NAME_LIMIT);
    let mut edits = HashMap::new();
    if input.title.as_deref() != Some(canonical.as_str()) {
        edits.insert(
            "XMP-dc:Title".to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical.clone())),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if input.object_name.as_deref() != Some(object.as_str()) {
        edits.insert(
            "IPTC:ObjectName".to_string(),
            DraftEdit {
                value: Some(Variant::String(object)),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    TitleOutcome {
        output: if edits.is_empty() { None } else { Some(GroupOutput { edits }) },
        ai_fired,
        ai_error: None,
        ai_usage,
    }
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

    #[tokio::test]
    async fn primary_wins() {
        let input = TitleInput {
            title: Some("Sunset Over Mont Blanc".into()),
            object_name: Some("Old ObjectName".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        // Primary equals canonical → no draft for XMP-dc:Title;
        // derivative gets the canonical projection.
        assert!(!out.edits.contains_key("XMP-dc:Title"));
        assert_eq!(s(&out, "IPTC:ObjectName"), "Sunset Over Mont Blanc");
    }

    #[tokio::test]
    async fn primary_empty_uses_derivative() {
        let input = TitleInput {
            title: None,
            object_name: Some("From IPTC".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "From IPTC");
    }

    #[tokio::test]
    async fn trailing_punctuation_stripped() {
        let input = TitleInput {
            title: Some("Sunset Over Mont Blanc.".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Sunset Over Mont Blanc");
    }

    #[tokio::test]
    async fn trailing_multiple_punctuation_stripped() {
        let input = TitleInput {
            title: Some("Wow!?".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Wow");
    }

    #[tokio::test]
    async fn whitespace_normalised() {
        let input = TitleInput {
            title: Some("  Lots   of   space  ".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Lots of space");
    }

    #[tokio::test]
    async fn capitalisation_preserved() {
        // "iPhone" must survive — we don't enforce title-case in v1.
        let input = TitleInput {
            title: Some("iPhone in the Snow".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        // Primary equals canonical → only derivative gets draft.
        assert_eq!(s(&out, "IPTC:ObjectName"), "iPhone in the Snow");
    }

    #[tokio::test]
    async fn empty_targets_no_ai_returns_key_missing_error() {
        // Plan §1 Group C case-3: AI is required when targets empty
        // and a description canonical exists. Without an AI client we
        // surface a typed failure rather than silently no-op.
        let input = TitleInput {
            description_canonical: Some("A photo of a cat.".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiKeyMissing);
    }

    #[tokio::test]
    async fn case_3_ai_generates_title_from_description() {
        struct MockAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for MockAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
            async fn generate_title(&self, p: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                assert_eq!(p.description, "Climbers descending Mont Blanc at sunset.");
                assert_eq!(p.keywords, vec!["mountains".to_string()]);
                Ok(("Climbers At Sunset".into(), AiCallUsage::default()))
            }
        }
        let input = TitleInput {
            description_canonical: Some("Climbers descending Mont Blanc at sunset.".into()),
            keywords_context: vec!["mountains".into()],
            ..Default::default()
        };
        let out = normalise_title(&input, Some(&MockAi)).await;
        let g = out.output.unwrap();
        assert_eq!(s(&g, "XMP-dc:Title"), "Climbers At Sunset");
        assert!(out.ai_fired);
    }

    #[tokio::test]
    async fn case_3_ai_error_records_error_and_no_drafts() {
        struct FailingAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for FailingAi {
            async fn merge_description(&self, _: DescriptionMergePrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                Err("rate limited".into())
            }
        }
        let input = TitleInput {
            description_canonical: Some("A photo.".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, Some(&FailingAi)).await;
        assert!(out.output.is_none());
        let err = out.ai_error.expect("ai_error must be populated");
        // Plain "rate limited" string doesn't match an HTTP prefix → AiCallFailed.
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiCallFailed);
    }

    #[tokio::test]
    async fn case_3_no_description_no_ai_call() {
        struct ShouldNotFireAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for ShouldNotFireAi {
            async fn merge_description(&self, _: DescriptionMergePrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                panic!("AI should not fire when description is empty")
            }
        }
        let input = TitleInput::default();
        let out = normalise_title(&input, Some(&ShouldNotFireAi)).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
    }

    #[tokio::test]
    async fn iptc_object_name_truncated_at_64_bytes() {
        let long = "word ".repeat(20); // 100 bytes
        let trimmed = long.trim_end().to_string();
        let input = TitleInput {
            title: Some(trimmed.clone()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        let obj = s(&out, "IPTC:ObjectName");
        assert!(obj.len() <= IPTC_OBJECT_NAME_LIMIT);
        assert!(!obj.ends_with(' '));
        assert!(obj.ends_with("word"));
    }

    #[tokio::test]
    async fn idempotent_after_one_pass() {
        let initial = TitleInput {
            title: Some("My Title".into()),
            ..Default::default()
        };
        let first = normalise_title(&initial, None).await.output.unwrap();
        let post = TitleInput {
            title: Some("My Title".into()),
            object_name: Some(s(&first, "IPTC:ObjectName")),
            ..Default::default()
        };
        let second = normalise_title(&post, None).await;
        assert!(second.output.is_none());
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
    collapse_whitespace_single_line(s)
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

/// Compute the per-pair canonical values for Group G without producing
/// drafts. Used by the dispatcher to pass POST-normalisation location
/// context into Group B / Group C AI prompts (plan §2 pass ordering;
/// Group B reads Group G output, not raw input).
pub fn derive_location_canonical(input: &LocationInput) -> LocationContext {
    let pick = |xmp: Option<&str>, ipt: Option<&str>, canon: fn(&str) -> String| -> Option<String> {
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
            // Plan §1 Group H pattern #6: 14-digit compact stem with
            // NO separator between date and time (e.g. `20240812143000`).
            // Listed after the separator-required variant so the more
            // permissive form doesn't swallow stems that have a clean
            // separator first.
            (
                regex::Regex::new(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})").unwrap(),
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
    fn filename_fallback_compact_no_separator() {
        // Plan §1 Group H pattern #6: 14 digits with no separator between
        // date and time, e.g. `20240615143045.jpg`.
        let input = DatesInput {
            file_stem: Some("20240615143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "EXIF:DateTimeOriginal"), "2024-06-15T14:30:45");
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 0);
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
