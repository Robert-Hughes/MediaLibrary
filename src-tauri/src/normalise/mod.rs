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
//! draft store. AI calls for Description, Title, and evidence-backed Location
//! creation are fully integrated.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use crate::draft_edits::{EditIntent, MetadataDraftEdit, SchemaMetadataEditMap};
use crate::metadata_value::{ListKind, MetadataValue};

// Per-group implementation modules. The dispatcher (`process_image`)
// composes these in the pass order documented in plan §2; each
// submodule owns its target tags constant, canonical derivation,
// idempotency detector, normaliser, and unit tests for that group.
mod keywords;
pub use keywords::{
    derive_keywords_canonical, normalise_keywords, normalise_keywords_with_canonical,
};

mod creator;
pub use creator::{derive_creator_canonical, normalise_creator};

mod copyright;
pub use copyright::normalise_copyright;

mod headline;
pub use headline::normalise_headline;

mod title;
pub use title::{build_title_gen_prompt, normalise_title, TitleOutcome};

mod location;
pub use location::{
    derive_location_canonical, normalise_location, normalise_location_with_ai, LocationOutcome,
};

mod dates;
pub use dates::{normalise_dates, DatesOutcome};

mod ai;
pub use ai::{
    AiCallUsage, CapturingAiClient, DescriptionMergePrompt, LocationAiResult,
    LocationResolvePrompt, NormaliseAiClient, NormaliseAiError, NormaliseAuditEntry,
    PerImageAiCall, TitleGenPrompt,
};

mod description;
pub use description::{build_description_merge_prompt, normalise_description, DescriptionOutcome};

mod iptc_utf8;
pub use iptc_utf8::normalise_iptc_utf8;

/// The semantic groups the user can toggle on/off in the confirm
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
    IptcUtf8,
}

impl NormaliseGroup {
    /// All groups in canonical wire order. Used by the frontend to
    /// build the per-group checkbox list and by the dispatcher to walk
    /// enabled groups deterministically.
    pub const ALL: &'static [NormaliseGroup] = &[
        NormaliseGroup::Keywords,
        NormaliseGroup::Creator,
        NormaliseGroup::Copyright,
        NormaliseGroup::IptcUtf8,
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
            NormaliseGroup::IptcUtf8 => "iptc_utf8",
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
    /// IPTC UTF-8 conversion marker state. The group emits only the
    /// CodedCharacterSet draft; apply planning derives the physical rewrites
    /// needed to preserve existing non-ASCII IPTC text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_utf8: Option<IptcUtf8Input>,
}

/// Input for the IPTC UTF-8 conversion group.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct IptcUtf8Input {
    /// Whether the effective metadata view contains any IPTC property.
    #[serde(default)]
    pub has_iptc: bool,
    /// Effective `IPTC:CodedCharacterSet`, including staged drafts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coded_character_set: Option<String>,
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
    /// `IFD0:Artist` — single string, semicolon-separated when there
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
    /// `IFD0:Copyright` (ASCII string).
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
/// LocationCreated is canonical when it contains exactly one structure.
/// Otherwise the five XMP↔IIM mirror pairs can seed a new structure.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct LocationInput {
    /// `XMP-iptcExt:LocationCreated` (canonical structured source).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_created: Option<MetadataValue>,
    /// Exact Nominatim GeocodeJSON response recorded by Reverse Geocode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geocode_json: Option<String>,
    /// Exact Nominatim JSONv2 response recorded by Reverse Geocode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_v2: Option<String>,
    /// Camera coordinates copied deterministically into LocationCreated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps_latitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps_longitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps_altitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps_altitude_ref: Option<i32>,
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
/// Date/time fields hold semantic `MetadataValue` values as parsed at
/// scan time. Related EXIF offset tags stay separate `TimeOffset`
/// values and are considered only by the Dates normaliser's local
/// comparison/projection policy.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct DatesInput {
    // ── H1: Shutter time ──
    /// `ExifIFD:DateTimeOriginal` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_original: Option<MetadataValue>,
    /// `ExifIFD:OffsetTimeOriginal` — `"+01:00"` etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_time_original: Option<MetadataValue>,
    /// `ExifIFD:SubSecTimeOriginal` — fractional seconds digits, e.g.
    /// `"123"` meaning `.123`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_sec_time_original: Option<MetadataValue>,
    /// `XMP-photoshop:DateCreated` — full ISO datetime mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photoshop_date_created: Option<MetadataValue>,
    /// `IPTC:DateCreated` — `"YYYY-MM-DD"` portion of the H1 mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_date_created: Option<MetadataValue>,
    /// `IPTC:TimeCreated` — `"HH:MM:SS[±HH:MM]"` portion of H1 mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_time_created: Option<MetadataValue>,

    // ── H2: Digitised time ──
    /// `ExifIFD:CreateDate` (primary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_date: Option<MetadataValue>,
    /// `ExifIFD:OffsetTimeDigitized` — paired with `CreateDate` per EXIF spec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_time_digitized: Option<MetadataValue>,
    /// `ExifIFD:OffsetTime` — modify-time offset; kept for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_time: Option<MetadataValue>,
    /// `ExifIFD:SubSecTimeDigitized` — fractional-seconds digits for H2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_sec_time_digitized: Option<MetadataValue>,
    /// `XMP-xmp:CreateDate` — full ISO datetime mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xmp_create_date: Option<MetadataValue>,
    /// `IPTC:DigitalCreationDate` — `"YYYY-MM-DD"` portion of H2 mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_digital_creation_date: Option<MetadataValue>,
    /// `IPTC:DigitalCreationTime` — `"HH:MM:SS[±HH:MM]"` portion of H2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iptc_digital_creation_time: Option<MetadataValue>,

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
    /// `IFD0:ImageDescription` (ASCII string, derivative target).
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
    pub edits: SchemaMetadataEditMap,
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

/// Build a set-value draft for a scalar text tag.
pub(crate) fn text_edit(value: String) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(MetadataValue::Text(value)),
        intent: EditIntent::Set,
    }
}

/// Build a set-value draft for a LangAlt primary with x-default text.
pub(crate) fn lang_alt_edit(value: String) -> MetadataDraftEdit {
    let mut langs = BTreeMap::new();
    langs.insert("x-default".to_string(), value);
    MetadataDraftEdit {
        value: Some(MetadataValue::LangAlt(langs)),
        intent: EditIntent::Set,
    }
}

/// Build a set-value draft for a Bag/Seq-of-Text tag from a list of
/// canonical strings. Shared by Group A (Keywords) and Group E
/// (Creator).
pub(crate) fn bag_edit(items: &[String]) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(MetadataValue::List {
            list_kind: ListKind::Bag,
            items: items.iter().cloned().map(MetadataValue::Text).collect(),
        }),
        intent: EditIntent::Set,
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
    /// case 2 or case 5; Group C case 3). 0 for all other groups.
    pub n_normalised_ai: u32,
    /// Generic conflict counter — incremented whenever the group
    /// resolved disagreement by preferring the primary source over a
    /// derivative. Group-specific counters below give the detail.
    pub n_conflict_primary_won: u32,
    /// Group G only — XMP↔IIM mirror pair disagreed before
    /// canonicalisation (summed across the 5 sub-pairs).
    pub n_location_xmp_iim_conflict: u32,
    /// Group G only — LocationCreated contained multiple or malformed
    /// structures and was left for manual resolution.
    pub n_location_created_ambiguous: u32,
    /// Group H only — H1/H2 target source set disagreed after ISO
    /// normalisation (summed across H1+H2).
    pub n_date_conflict: u32,
    /// Group H only — DTO filled from filename regex match.
    pub n_dto_from_filename: u32,
    /// Group H only — filename match was date-only (no time portion).
    pub n_dto_from_filename_date_only: u32,
    /// Group H only — date input string was non-empty but unparseable.
    pub n_unparseable_date_inputs: u32,
    /// Groups B / C / G only — AI call returned an error or the key
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
    /// Groups that actually emitted at least one non-delete IPTC draft.
    /// Used by cost estimation to make IPTC UTF-8 applicability depend on
    /// the user's prospective group selection. This is internal scheduling
    /// evidence, not part of the public progress wire shape.
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub iptc_output_groups: BTreeSet<NormaliseGroup>,
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
        self.per_group
            .values()
            .all(|s| s.n_normalised_deterministic == 0 && s.n_normalised_ai == 0)
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
///   * Prospective applicability: IPTC UTF-8 runs last so semantic groups
///     selected in the same operation can make it applicable.
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
    edits: &mut SchemaMetadataEditMap,
    stats: &mut PerImageStats,
    run: impl FnOnce(&T) -> Option<GroupOutput>,
) {
    if !enabled {
        return;
    }
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
        stats.group(group).n_noop += 1;
        return;
    };
    match run(input) {
        Some(out) => {
            if group_output_writes_iptc(&out) {
                stats.iptc_output_groups.insert(group);
            }
            edits.extend(out.edits);
            stats.group(group).n_normalised_deterministic += 1;
        }
        None => {
            stats.group(group).n_noop += 1;
        }
    }
}

fn group_output_writes_iptc(output: &GroupOutput) -> bool {
    output.edits.iter().any(|(schema_id, edit)| {
        schema_id.table.starts_with("IPTC::") && !matches!(edit.intent, EditIntent::Delete)
    })
}

/// Returns `true` if the caller-supplied cancel flag has been
/// signalled. Defaults to `false` when no flag is supplied (eg.
/// unit-test calls that don't need to model cancellation).
fn is_cancelled(cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>) -> bool {
    cancel
        .map(|f| f.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

fn derive_date_context(input: &DatesInput) -> Option<String> {
    fn date_context(v: &MetadataValue) -> Option<String> {
        match v {
            MetadataValue::DateTime(dt) => Some(format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                dt.date.year,
                dt.date.month,
                dt.date.day,
                dt.time.hour,
                dt.time.minute,
                dt.time.second
            )),
            MetadataValue::Date(d) => Some(format!("{:04}-{:02}-{:02}", d.year, d.month, d.day)),
            MetadataValue::Text(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
            _ => None,
        }
    }
    input
        .date_time_original
        .as_ref()
        .or(input.photoshop_date_created.as_ref())
        .or(input.iptc_date_created.as_ref())
        .and_then(date_context)
}

pub async fn process_image(
    item: &NormaliseRequestItem,
    enabled: &[NormaliseGroup],
    ai: Option<&dyn NormaliseAiClient>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> (
    SchemaMetadataEditMap,
    PerImageStats,
    Option<NormaliseAiError>,
    Vec<PerImageAiCall>,
) {
    let mut edits = SchemaMetadataEditMap::new();
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
    let write_enabled = |g: NormaliseGroup| enabled.contains(&g) && !is_cancelled(cancel);
    let title_writes_enabled = write_enabled(NormaliseGroup::Title);
    let description_writes_enabled = write_enabled(NormaliseGroup::Description);
    let keywords_writes_enabled = write_enabled(NormaliseGroup::Keywords);
    let location_writes_enabled = write_enabled(NormaliseGroup::Location);
    let dates_writes_enabled = write_enabled(NormaliseGroup::Dates);

    // ── Pass 1: independents ──
    //
    // Derive read-only dependency context independently from write
    // execution. Context-only upstream groups must not emit drafts,
    // stats, AI calls, or done-panel rows.
    let needs_keywords_context =
        keywords_writes_enabled || description_writes_enabled || title_writes_enabled;
    let needs_location_context =
        location_writes_enabled || description_writes_enabled || title_writes_enabled;
    let needs_date_context = dates_writes_enabled || description_writes_enabled;
    let needs_description_context = description_writes_enabled || title_writes_enabled;

    let (keywords_paths, keywords_leaves) = if needs_keywords_context && !is_cancelled(cancel) {
        item.group_inputs
            .keywords
            .as_ref()
            .map(derive_keywords_canonical)
            .unwrap_or_default()
    } else {
        (Vec::new(), Vec::new())
    };
    let mut location_context =
        if needs_location_context && !location_writes_enabled && !is_cancelled(cancel) {
            item.group_inputs
                .location
                .as_ref()
                .map(derive_location_canonical)
        } else {
            None
        };
    let date_context = if needs_date_context && !is_cancelled(cancel) {
        item.group_inputs
            .dates
            .as_ref()
            .and_then(derive_date_context)
    } else {
        None
    };

    if write_enabled(NormaliseGroup::Keywords) {
        if let Some(input) = item.group_inputs.keywords.as_ref() {
            match normalise_keywords_with_canonical(input, &keywords_paths, &keywords_leaves) {
                Some(out) => {
                    if group_output_writes_iptc(&out) {
                        stats.iptc_output_groups.insert(NormaliseGroup::Keywords);
                    }
                    edits.extend(out.edits);
                    stats
                        .group(NormaliseGroup::Keywords)
                        .n_normalised_deterministic += 1;
                }
                None => stats.group(NormaliseGroup::Keywords).n_noop += 1,
            }
        } else {
            log::warn!("[normalise] group keywords enabled but no input bundle supplied; counting as no-op");
            stats.group(NormaliseGroup::Keywords).n_noop += 1;
        }
    }

    apply_simple_group(
        NormaliseGroup::Creator,
        write_enabled(NormaliseGroup::Creator),
        item.group_inputs.creator.as_ref(),
        &mut edits,
        &mut stats,
        normalise_creator,
    );
    apply_simple_group(
        NormaliseGroup::Copyright,
        write_enabled(NormaliseGroup::Copyright),
        item.group_inputs.copyright.as_ref(),
        &mut edits,
        &mut stats,
        normalise_copyright,
    );
    apply_simple_group(
        NormaliseGroup::Headline,
        write_enabled(NormaliseGroup::Headline),
        item.group_inputs.headline.as_ref(),
        &mut edits,
        &mut stats,
        normalise_headline,
    );

    if write_enabled(NormaliseGroup::Location) {
        if let Some(input) = item.group_inputs.location.as_ref() {
            let outcome = normalise_location_with_ai(input, ai).await;
            if outcome.ai_fired {
                if let Some(usage) = outcome.ai_usage.clone() {
                    ai_calls.push(PerImageAiCall {
                        group: "location",
                        usage,
                        error: None,
                    });
                }
            }
            if let Some(error) = outcome.ai_error.clone() {
                stats.group(NormaliseGroup::Location).n_ai_errors += 1;
                ai_calls.push(PerImageAiCall {
                    group: "location",
                    usage: error.usage.clone().unwrap_or_default(),
                    error: Some(error.detail.clone()),
                });
                if first_ai_error.is_none() {
                    first_ai_error = Some(error);
                }
            }
            location_context = outcome.canonical.clone();
            let ai_fired = outcome.ai_fired;
            if outcome
                .output
                .as_ref()
                .is_some_and(group_output_writes_iptc)
            {
                stats.iptc_output_groups.insert(NormaliseGroup::Location);
            }
            let g = stats.group(NormaliseGroup::Location);
            g.n_location_xmp_iim_conflict = outcome.n_xmp_iim_conflict;
            g.n_location_created_ambiguous = outcome.n_location_created_ambiguous;
            if outcome.n_xmp_iim_conflict > 0 {
                g.n_conflict_primary_won = 1;
            }
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
            log::warn!("[normalise] group location enabled but no input bundle supplied; counting as no-op");
            stats.group(NormaliseGroup::Location).n_noop += 1;
        }
    }

    if write_enabled(NormaliseGroup::Dates) {
        if let Some(input) = item.group_inputs.dates.as_ref() {
            let outcome = normalise_dates(input);
            if outcome
                .output
                .as_ref()
                .is_some_and(group_output_writes_iptc)
            {
                stats.iptc_output_groups.insert(NormaliseGroup::Dates);
            }
            let g = stats.group(NormaliseGroup::Dates);
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
            log::warn!(
                "[normalise] group dates enabled but no input bundle supplied; counting as no-op"
            );
            stats.group(NormaliseGroup::Dates).n_noop += 1;
        }
    }

    // ── Pass 2: Description (reads pass-1 context) ──
    let mut description_canonical: Option<String> =
        if needs_description_context && !description_writes_enabled && !is_cancelled(cancel) {
            item.group_inputs
                .description
                .as_ref()
                .and_then(description::derive_description_canonical_without_ai)
        } else {
            None
        };
    if write_enabled(NormaliseGroup::Description) {
        if let Some(input) = item.group_inputs.description.as_ref() {
            // Augment the caller-supplied bundle with pass-1
            // context. Caller-provided values win when both are set.
            let mut augmented = input.clone();
            // If the user opted into IPTC UTF-8, Description should project
            // its prospective Caption-Abstract as UTF-8 even when IPTC does
            // not exist yet. The marker group runs after semantic groups and
            // will become a no-op if none of them actually emits IPTC.
            if write_enabled(NormaliseGroup::IptcUtf8) {
                augmented.iptc_charset_is_utf8 = true;
            }
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
                    usage: err.usage.clone().unwrap_or_default(),
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
            if outcome
                .output
                .as_ref()
                .is_some_and(group_output_writes_iptc)
            {
                stats.iptc_output_groups.insert(NormaliseGroup::Description);
            }
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
    if write_enabled(NormaliseGroup::Title) {
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
                    usage: err.usage.clone().unwrap_or_default(),
                    error: Some(err.detail.clone()),
                });
                if first_ai_error.is_none() {
                    first_ai_error = Some(err);
                }
            }
            let ai_fired = outcome.ai_fired;
            if outcome
                .output
                .as_ref()
                .is_some_and(group_output_writes_iptc)
            {
                stats.iptc_output_groups.insert(NormaliseGroup::Title);
            }
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
            log::warn!(
                "[normalise] group title enabled but no input bundle supplied; counting as no-op"
            );
            stats.group(NormaliseGroup::Title).n_noop += 1;
        }
    }

    // IPTC UTF-8 is opt-in, but its applicability is prospective: semantic
    // groups selected in the same run may create IPTC on a file that did not
    // contain it at input time. Evaluate it after those outputs are known.
    if write_enabled(NormaliseGroup::IptcUtf8) {
        if let Some(input) = item.group_inputs.iptc_utf8.as_ref() {
            let mut prospective = input.clone();
            prospective.has_iptc = prospective.has_iptc || !stats.iptc_output_groups.is_empty();
            match normalise_iptc_utf8(&prospective) {
                Some(out) => {
                    edits.extend(out.edits);
                    stats
                        .group(NormaliseGroup::IptcUtf8)
                        .n_normalised_deterministic += 1;
                }
                None => stats.group(NormaliseGroup::IptcUtf8).n_noop += 1,
            }
        } else {
            log::warn!(
                "[normalise] group iptc_utf8 enabled but no input bundle supplied; counting as no-op"
            );
            stats.group(NormaliseGroup::IptcUtf8).n_noop += 1;
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
    /// Sum of USD cost across every AI call (description + title + location)
    /// emitted by this batch. Driven by the audit-log writer in
    /// `lib.rs`, which has access to the pricing table.
    pub ai_cost_total_usd: f64,
    /// Total successful + failed AI calls across the batch
    /// (description + title + location). Matches the number of rows appended to
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
            dst.n_location_created_ambiguous += src.n_location_created_ambiguous;
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
    async fn prospective_iptc_output_makes_utf8_group_applicable() {
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                keywords: Some(KeywordsInput {
                    dc_subject: vec!["landscape".into()],
                    ..Default::default()
                }),
                iptc_utf8: Some(IptcUtf8Input::default()),
                ..Default::default()
            },
        };

        let (edits, stats, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Keywords, NormaliseGroup::IptcUtf8],
            None,
            None,
        )
        .await;

        assert!(edits.contains_key(&crate::known_ids::iptc_keywords()));
        assert_eq!(
            edits[&crate::known_ids::iptc_coded_character_set()].value,
            Some(MetadataValue::Text("UTF8".into()))
        );
        assert!(stats.iptc_output_groups.contains(&NormaliseGroup::Keywords));
        assert_eq!(
            stats.per_group[&NormaliseGroup::IptcUtf8].n_normalised_deterministic,
            1
        );
    }

    #[tokio::test]
    async fn prospective_iptc_utf8_remains_opt_in() {
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                keywords: Some(KeywordsInput {
                    dc_subject: vec!["landscape".into()],
                    ..Default::default()
                }),
                iptc_utf8: Some(IptcUtf8Input::default()),
                ..Default::default()
            },
        };

        let (edits, stats, _err, _calls) =
            process_image(&item, &[NormaliseGroup::Keywords], None, None).await;

        assert!(edits.contains_key(&crate::known_ids::iptc_keywords()));
        assert!(!edits.contains_key(&crate::known_ids::iptc_coded_character_set()));
        assert!(!stats.per_group.contains_key(&NormaliseGroup::IptcUtf8));
    }

    #[tokio::test]
    async fn prospective_utf8_preserves_unicode_description_projection() {
        let canonical = "Café beside the Rhône.";
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    description: Some(canonical.into()),
                    iptc_charset_is_utf8: false,
                    ..Default::default()
                }),
                iptc_utf8: Some(IptcUtf8Input::default()),
                ..Default::default()
            },
        };

        let (edits, _stats, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Description, NormaliseGroup::IptcUtf8],
            None,
            None,
        )
        .await;

        assert_eq!(
            edits[&crate::known_ids::iptc_caption()].value,
            Some(MetadataValue::Text(canonical.into()))
        );
        assert_eq!(
            edits[&crate::known_ids::iptc_coded_character_set()].value,
            Some(MetadataValue::Text("UTF8".into()))
        );
    }

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
        let (edits, stats, _err, _calls) =
            process_image(&item, &[NormaliseGroup::Keywords], None, None).await;
        assert!(edits.contains_key(&crate::known_ids::xmp_subject()));
        assert!(!edits.contains_key(&crate::known_ids::xmp_creator()));
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
        )
        .await;
        assert!(edits.is_empty());
        assert_eq!(stats.per_group.len(), 8);
        for g in stats.per_group.values() {
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
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                *self.captured.lock().await = Some(p);
                Ok(("merged".into(), AiCallUsage::default()))
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                unreachable!()
            }
        }
        let ai = ContextCapturingAi {
            captured: tokio::sync::Mutex::new(None),
        };
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
        )
        .await;
        let captured = ai
            .captured
            .lock()
            .await
            .take()
            .expect("AI must fire on distinct sources");
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
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                unreachable!()
            }
            async fn generate_title(
                &self,
                p: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                *self.captured_description.lock().await = Some(p.description);
                Ok(("Generated Title".into(), AiCallUsage::default()))
            }
        }
        let ai = TitleAi {
            captured_description: tokio::sync::Mutex::new(None),
        };
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
        )
        .await;
        let captured = ai
            .captured_description
            .lock()
            .await
            .take()
            .expect("title AI must fire");
        assert_eq!(captured, "A factual sentence.");
        // Generated title became a draft.
        let title_draft = edits
            .get(&crate::known_ids::xmp_title())
            .expect("title draft present");
        match &title_draft.value {
            Some(MetadataValue::LangAlt(langs)) => {
                assert_eq!(
                    langs.get("x-default").map(String::as_str),
                    Some("Generated Title")
                );
            }
            other => panic!("expected lang-alt value, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn title_gets_description_context_when_description_not_write_enabled() {
        struct TitleAi {
            calls: tokio::sync::Mutex<Vec<&'static str>>,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for TitleAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                panic!("context-only description must not call AI");
            }
            async fn generate_title(
                &self,
                p: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                assert_eq!(p.description, "A cat sitting on a windowsill.");
                self.calls.lock().await.push("title");
                Ok(("Cat On Windowsill".into(), AiCallUsage::default()))
            }
        }
        let ai = TitleAi {
            calls: tokio::sync::Mutex::new(Vec::new()),
        };
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                title: Some(TitleInput::default()),
                description: Some(DescriptionInput {
                    description: Some("A cat sitting on a windowsill.".into()),
                    image_description: Some("A cat sitting on a windowsill.".into()),
                    caption_abstract: Some("A cat sitting on a windowsill.".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        };
        let (edits, stats, _err, ai_calls) =
            process_image(&item, &[NormaliseGroup::Title], Some(&ai), None).await;

        assert_eq!(
            match &edits
                .get(&crate::known_ids::xmp_title())
                .expect("title draft")
                .value
            {
                Some(MetadataValue::LangAlt(langs)) => langs.get("x-default").unwrap().as_str(),
                other => panic!("expected lang-alt value, got {:?}", other),
            },
            "Cat On Windowsill"
        );
        assert_eq!(
            match &edits
                .get(&crate::known_ids::iptc_object_name())
                .expect("object name draft")
                .value
            {
                Some(MetadataValue::Text(s)) => s.as_str(),
                other => panic!("expected text value, got {:?}", other),
            },
            "Cat On Windowsill"
        );
        let title = stats.per_group.get(&NormaliseGroup::Title).unwrap();
        assert_eq!(title.n_normalised_ai, 1);
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Description));
        assert_eq!(ai.calls.lock().await.as_slice(), &["title"]);
        assert_eq!(ai_calls.len(), 1);
        assert_eq!(ai_calls[0].group, "title");
    }

    #[tokio::test]
    async fn description_gets_context_when_upstream_groups_not_write_enabled() {
        struct DescriptionAi {
            calls: tokio::sync::Mutex<Vec<&'static str>>,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for DescriptionAi {
            async fn merge_description(
                &self,
                p: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                assert!(p.keywords.contains(&"cat".to_string()));
                assert_eq!(
                    p.location.get("city").and_then(serde_json::Value::as_str),
                    Some("Cambridge")
                );
                assert_eq!(
                    p.location
                        .get("country")
                        .and_then(serde_json::Value::as_str),
                    Some("United Kingdom")
                );
                assert_eq!(p.date.as_deref(), Some("2024-06-15 14:30:45"));
                self.calls.lock().await.push("description");
                Ok(("Merged caption.".into(), AiCallUsage::default()))
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                panic!("title AI must not fire");
            }
        }
        let ai = DescriptionAi {
            calls: tokio::sync::Mutex::new(Vec::new()),
        };
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    description: Some("Old caption.".into()),
                    image_description: Some("Different caption.".into()),
                    ..Default::default()
                }),
                keywords: Some(KeywordsInput {
                    hierarchical_subject: vec!["animals|cat".into()],
                    dc_subject: vec!["cat".into()],
                    ..Default::default()
                }),
                location: Some(LocationInput {
                    city_xmp: Some("Cambridge".into()),
                    city_iptc: Some("Cambridge".into()),
                    country_xmp: Some("United Kingdom".into()),
                    country_iptc: Some("United Kingdom".into()),
                    ..Default::default()
                }),
                dates: Some(DatesInput {
                    date_time_original: Some(MetadataValue::DateTime(
                        crate::metadata_value::DateTimeValue {
                            date: crate::metadata_value::DateValue {
                                year: 2024,
                                month: 6,
                                day: 15,
                            },
                            time: crate::metadata_value::TimeValue {
                                hour: 14,
                                minute: 30,
                                second: 45,
                                subsecond: None,
                                offset: None,
                            },
                        },
                    )),
                    ..Default::default()
                }),
                ..Default::default()
            },
        };
        let (edits, stats, _err, ai_calls) =
            process_image(&item, &[NormaliseGroup::Description], Some(&ai), None).await;

        assert!(edits.contains_key(&crate::known_ids::xmp_description()));
        let desc = stats.per_group.get(&NormaliseGroup::Description).unwrap();
        assert_eq!(desc.n_normalised_ai, 1);
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Keywords));
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Location));
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Dates));
        assert_eq!(ai.calls.lock().await.as_slice(), &["description"]);
        assert_eq!(ai_calls.len(), 1);
        assert_eq!(ai_calls[0].group, "description");
    }

    #[tokio::test]
    async fn title_gets_keywords_and_location_context_when_not_write_enabled() {
        struct TitleContextAi {
            calls: tokio::sync::Mutex<Vec<&'static str>>,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for TitleContextAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                panic!("context-only description must not call AI");
            }
            async fn generate_title(
                &self,
                p: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                assert_eq!(p.description, "A cat sitting on a windowsill.");
                assert!(p.keywords.contains(&"cat".to_string()));
                assert_eq!(
                    p.location.get("city").and_then(serde_json::Value::as_str),
                    Some("Cambridge")
                );
                assert_eq!(
                    p.location
                        .get("country")
                        .and_then(serde_json::Value::as_str),
                    Some("United Kingdom")
                );
                self.calls.lock().await.push("title");
                Ok(("Cat On Windowsill".into(), AiCallUsage::default()))
            }
        }
        let ai = TitleContextAi {
            calls: tokio::sync::Mutex::new(Vec::new()),
        };
        let item = NormaliseRequestItem {
            rel_path: "x.jpg".into(),
            group_inputs: GroupInputs {
                title: Some(TitleInput::default()),
                description: Some(DescriptionInput {
                    description: Some("A cat sitting on a windowsill.".into()),
                    image_description: Some("A cat sitting on a windowsill.".into()),
                    caption_abstract: Some("A cat sitting on a windowsill.".into()),
                    ..Default::default()
                }),
                keywords: Some(KeywordsInput {
                    hierarchical_subject: vec!["animals|cat".into()],
                    ..Default::default()
                }),
                location: Some(LocationInput {
                    city_xmp: Some("Cambridge".into()),
                    city_iptc: Some("Cambridge".into()),
                    country_xmp: Some("United Kingdom".into()),
                    country_iptc: Some("United Kingdom".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        };
        let (_edits, stats, _err, ai_calls) =
            process_image(&item, &[NormaliseGroup::Title], Some(&ai), None).await;

        let title = stats.per_group.get(&NormaliseGroup::Title).unwrap();
        assert_eq!(title.n_normalised_ai, 1);
        assert_eq!(stats.per_group.len(), 1);
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Description));
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Keywords));
        assert!(!stats.per_group.contains_key(&NormaliseGroup::Location));
        assert_eq!(ai.calls.lock().await.as_slice(), &["title"]);
        assert_eq!(ai_calls.len(), 1);
        assert_eq!(ai_calls[0].group, "title");
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
        )
        .await;
        assert!(edits.is_empty());
        assert!(stats.per_group.is_empty());
        // Sanity: clearing the flag and rerunning emits drafts.
        cancel.store(false, Ordering::Relaxed);
        let (edits, stats, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Keywords, NormaliseGroup::Creator],
            None,
            Some(&cancel),
        )
        .await;
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
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                self.cancel.store(true, Ordering::Relaxed);
                Ok(("Merged version.".into(), AiCallUsage::default()))
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                panic!("title AI must NOT fire after cancel");
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let ai = CancellingAi {
            cancel: cancel.clone(),
        };
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
        )
        .await;
        // Description drafts survived.
        assert!(edits.contains_key(&crate::known_ids::xmp_description()));
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
            (
                NormaliseGroup::Keywords,
                PerGroupStats {
                    n_normalised_deterministic: 1,
                    ..Default::default()
                },
            ),
            (
                NormaliseGroup::Location,
                PerGroupStats {
                    n_normalised_deterministic: 1,
                    n_conflict_primary_won: 1,
                    n_location_xmp_iim_conflict: 1,
                    ..Default::default()
                },
            ),
            (
                NormaliseGroup::Dates,
                PerGroupStats {
                    n_noop: 1,
                    n_dto_from_filename: 1,
                    n_dto_from_filename_date_only: 1,
                    ..Default::default()
                },
            ),
            (
                NormaliseGroup::Description,
                PerGroupStats {
                    n_normalised_ai: 1,
                    ..Default::default()
                },
            ),
        ]));
        summary.accumulate(&make_per_image(&[
            (
                NormaliseGroup::Keywords,
                PerGroupStats {
                    n_normalised_deterministic: 1,
                    ..Default::default()
                },
            ),
            (
                NormaliseGroup::Dates,
                PerGroupStats {
                    n_normalised_deterministic: 1,
                    n_date_conflict: 1,
                    n_conflict_primary_won: 1,
                    n_unparseable_date_inputs: 2,
                    ..Default::default()
                },
            ),
            (
                NormaliseGroup::Title,
                PerGroupStats {
                    n_normalised_ai: 1,
                    ..Default::default()
                },
            ),
            (
                NormaliseGroup::Description,
                PerGroupStats {
                    n_ai_errors: 1,
                    ..Default::default()
                },
            ),
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
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                Ok((
                    "Merged factual description.".into(),
                    AiCallUsage {
                        input_tokens: 800,
                        output_tokens: 250,
                        ..Default::default()
                    },
                ))
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                Err(
                    NormaliseAiError::from("simulated rate limit").with_usage(AiCallUsage {
                        input_tokens: 700,
                        cached_input_tokens: 100,
                        cache_write_input_tokens: 50,
                        output_tokens: 1200,
                        reasoning_tokens: 1150,
                        service_tier: "default".into(),
                        reasoning_effort: "medium".into(),
                    }),
                )
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let item = NormaliseRequestItem {
            rel_path: "trip/file.jpg".into(),
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
        let success = ai_calls
            .iter()
            .find(|c| c.error.is_none())
            .expect("description call ok");
        assert_eq!(success.group, "description");
        let failure = ai_calls
            .iter()
            .find(|c| c.error.is_some())
            .expect("title call err");
        assert_eq!(failure.group, "title");
        assert_eq!(failure.usage.output_tokens, 1200);
        assert_eq!(failure.usage.reasoning_tokens, 1150);

        // Write audit rows the way lib.rs does, then read them back
        // and assert the wire shape matches what users would see in
        // the JSONL.
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("normalise_audit.jsonl");
        let mut summary = NormaliseSummary::default();
        let pricing = crate::openai_describe::pricing_for("gpt-5.6-luna").unwrap();
        let cost_per_call = |u: &AiCallUsage| u.cost(&pricing);
        for call in &ai_calls {
            let cost = cost_per_call(&call.usage);
            let entry = NormaliseAuditEntry {
                ts: "2026-05-20T12:00:00Z".to_string(),
                model: "gpt-5.6-luna".to_string(),
                prompt_version: "v1".to_string(),
                group: call.group.to_string(),
                input_tokens: call.usage.input_tokens,
                cached_input_tokens: call.usage.cached_input_tokens,
                cache_write_input_tokens: call.usage.cache_write_input_tokens,
                output_tokens: call.usage.output_tokens,
                reasoning_tokens: call.usage.reasoning_tokens,
                non_reasoning_output_tokens: call.usage.non_reasoning_output_tokens(),
                service_tier: call.usage.service_tier.clone(),
                reasoning_effort: call.usage.reasoning_effort.clone(),
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
            cached_input_tokens: u32,
            cache_write_input_tokens: u32,
            output_tokens: u32,
            reasoning_tokens: u32,
            non_reasoning_output_tokens: u32,
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
        assert_eq!(desc_row.model, "gpt-5.6-luna");
        assert_eq!(desc_row.prompt_version, "v1");
        assert_eq!(desc_row.ts, "2026-05-20T12:00:00Z");
        assert_eq!(desc_row.relative_path, "trip/file.jpg");
        assert!(desc_row.cost_usd > 0.0);
        assert!(desc_row.error.is_empty());
        let title_row = parsed.iter().find(|r| r.group == "title").unwrap();
        assert_eq!(title_row.input_tokens, 700);
        assert_eq!(title_row.cached_input_tokens, 100);
        assert_eq!(title_row.cache_write_input_tokens, 50);
        assert_eq!(title_row.output_tokens, 1200);
        assert_eq!(title_row.reasoning_tokens, 1150);
        assert_eq!(title_row.non_reasoning_output_tokens, 50);
        assert!(title_row.cost_usd > 0.0);
        assert_eq!(title_row.error, "simulated rate limit");

        // Batch-level totals reflect both calls.
        assert_eq!(summary.ai_calls_total, 2);
        let expected_total = cost_per_call(&success.usage) + cost_per_call(&failure.usage);
        assert!((summary.ai_cost_total_usd - expected_total).abs() < 1e-9);
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

    #[tokio::test]
    async fn description_regeneration_feeds_title_generation() {
        struct MockRegenAi {
            calls: tokio::sync::Mutex<Vec<&'static str>>,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for MockRegenAi {
            async fn merge_description(
                &self,
                p: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                assert!(p.description_sources.is_empty());
                assert!(p.ai_context.contains_key("XMP-mlib:AIDescription"));
                self.calls.lock().await.push("description");
                Ok((
                    "A black cat sitting by a window.".into(),
                    AiCallUsage::default(),
                ))
            }
            async fn generate_title(
                &self,
                p: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                assert_eq!(p.description, "A black cat sitting by a window.");
                self.calls.lock().await.push("title");
                Ok(("Cat By Window".into(), AiCallUsage::default()))
            }
        }
        let ai = MockRegenAi {
            calls: tokio::sync::Mutex::new(Vec::new()),
        };
        let item = NormaliseRequestItem {
            rel_path: "cat.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    ai_description: Some("AIDesc: black cat".into()),
                    ..Default::default()
                }),
                title: Some(TitleInput::default()),
                ..Default::default()
            },
        };
        let (edits, stats, err, ai_calls) = process_image(
            &item,
            &[NormaliseGroup::Description, NormaliseGroup::Title],
            Some(&ai),
            None,
        )
        .await;

        assert!(err.is_none());
        assert_eq!(ai.calls.lock().await.as_slice(), &["description", "title"]);
        assert_eq!(ai_calls.len(), 2);
        assert_eq!(ai_calls[0].group, "description");
        assert_eq!(ai_calls[1].group, "title");

        // Verify Description drafts
        assert_eq!(
            match &edits
                .get(&crate::known_ids::xmp_description())
                .expect("description draft")
                .value
            {
                Some(MetadataValue::LangAlt(langs)) => langs.get("x-default").unwrap().as_str(),
                other => panic!("expected lang-alt value, got {:?}", other),
            },
            "A black cat sitting by a window."
        );
        // Verify Title drafts
        assert_eq!(
            match &edits
                .get(&crate::known_ids::xmp_title())
                .expect("title draft")
                .value
            {
                Some(MetadataValue::LangAlt(langs)) => langs.get("x-default").unwrap().as_str(),
                other => panic!("expected lang-alt value, got {:?}", other),
            },
            "Cat By Window"
        );

        let desc_stats = stats.per_group.get(&NormaliseGroup::Description).unwrap();
        assert_eq!(desc_stats.n_normalised_ai, 1);
        let title_stats = stats.per_group.get(&NormaliseGroup::Title).unwrap();
        assert_eq!(title_stats.n_normalised_ai, 1);
    }

    #[tokio::test]
    async fn estimate_empty_description_and_title_ai_calls() {
        let capturing = CapturingAiClient::default();
        let item = NormaliseRequestItem {
            rel_path: "cat.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    ai_description: Some("AIDesc: black cat".into()),
                    ..Default::default()
                }),
                title: Some(TitleInput::default()),
                ..Default::default()
            },
        };
        let (edits, stats, _err, _calls) = process_image(
            &item,
            &[NormaliseGroup::Description, NormaliseGroup::Title],
            Some(&capturing as &dyn NormaliseAiClient),
            None,
        )
        .await;

        let description_prompts = capturing.description_prompts.lock().await.clone();
        let title_prompts = capturing.title_prompts.lock().await.clone();
        assert_eq!(description_prompts.len(), 1);
        assert_eq!(title_prompts.len(), 1);
        assert_eq!(title_prompts[0].description, "Placeholder description.");

        let desc_stats = stats.per_group.get(&NormaliseGroup::Description).unwrap();
        assert_eq!(desc_stats.n_normalised_ai, 1);
        let title_stats = stats.per_group.get(&NormaliseGroup::Title).unwrap();
        assert_eq!(title_stats.n_normalised_ai, 1);

        assert!(edits.contains_key(&crate::known_ids::xmp_description()));
        assert!(edits.contains_key(&crate::known_ids::xmp_title()));
    }

    #[tokio::test]
    async fn dispatcher_description_empty_ai_desc_present_title_empty_regen() {
        struct MockRegenAi {
            calls: tokio::sync::Mutex<Vec<&'static str>>,
            canonical_desc: String,
        }
        #[async_trait::async_trait]
        impl NormaliseAiClient for MockRegenAi {
            async fn merge_description(
                &self,
                p: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                assert!(p.description_sources.is_empty());
                assert!(p.ai_context.contains_key("XMP-mlib:AIDescription"));
                self.calls.lock().await.push("description");
                Ok((self.canonical_desc.clone(), AiCallUsage::default()))
            }
            async fn generate_title(
                &self,
                p: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), NormaliseAiError> {
                assert_eq!(p.description, self.canonical_desc);
                self.calls.lock().await.push("title");
                Ok(("Mock Title".into(), AiCallUsage::default()))
            }
        }
        let canonical_desc = "A canonical Description".to_string();
        let ai = MockRegenAi {
            calls: tokio::sync::Mutex::new(Vec::new()),
            canonical_desc: canonical_desc.clone(),
        };
        let item = NormaliseRequestItem {
            rel_path: "cat.jpg".into(),
            group_inputs: GroupInputs {
                description: Some(DescriptionInput {
                    description: None,
                    image_description: None,
                    caption_abstract: None,
                    ai_description: Some("AIDesc: black cat".into()),
                    ..Default::default()
                }),
                title: Some(TitleInput {
                    title: None,
                    object_name: None,
                    ..Default::default()
                }),
                ..Default::default()
            },
        };
        let (edits, stats, err, ai_calls) = process_image(
            &item,
            &[NormaliseGroup::Description, NormaliseGroup::Title],
            Some(&ai),
            None,
        )
        .await;

        assert!(err.is_none());
        assert_eq!(ai.calls.lock().await.as_slice(), &["description", "title"]);
        assert_eq!(ai_calls.len(), 2);

        // Assert Description draft contains the returned canonical description
        assert_eq!(
            match &edits
                .get(&crate::known_ids::xmp_description())
                .expect("description draft")
                .value
            {
                Some(MetadataValue::LangAlt(langs)) => langs.get("x-default").unwrap().as_str(),
                other => panic!("expected lang-alt value, got {:?}", other),
            },
            canonical_desc
        );

        // Assert Title draft contains the generated title
        assert_eq!(
            match &edits
                .get(&crate::known_ids::xmp_title())
                .expect("title draft")
                .value
            {
                Some(MetadataValue::LangAlt(langs)) => langs.get("x-default").unwrap().as_str(),
                other => panic!("expected lang-alt value, got {:?}", other),
            },
            "Mock Title"
        );

        let desc_stats = stats.per_group.get(&NormaliseGroup::Description).unwrap();
        assert_eq!(desc_stats.n_normalised_ai, 1);
        let title_stats = stats.per_group.get(&NormaliseGroup::Title).unwrap();
        assert_eq!(title_stats.n_normalised_ai, 1);
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
