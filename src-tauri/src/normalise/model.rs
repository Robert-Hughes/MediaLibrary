//! Wire inputs and shared domain output types for metadata normalisation.

use serde::{Deserialize, Serialize};

use crate::draft_edits::SchemaMetadataEditMap;
use crate::metadata_value::MetadataValue;

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
