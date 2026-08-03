use super::*;

pub(super) struct FormatGroup0Support {
    extensions: &'static [&'static str],
    allowed_group0: &'static [&'static str],
}

// Explicit, fail-closed format-to-section write policy, kept beside the
// hand-curated schema overrides below. The section names are ExifTool
// family-0 strings taken directly from `-listx`; no app aliases are involved.
const FORMAT_GROUP0_SUPPORT: &[FormatGroup0Support] = &[
    FormatGroup0Support {
        extensions: &["jpg", "jpeg", "jpe", "jfif", "jif"],
        allowed_group0: &[
            "JPEG",
            "JFIF",
            "Adobe",
            "Ducky",
            "EXIF",
            "XMP",
            "IPTC",
            "ICC_Profile",
            "Photoshop",
        ],
    },
    FormatGroup0Support {
        extensions: &["png"],
        allowed_group0: &["PNG", "EXIF", "XMP", "ICC_Profile"],
    },
    FormatGroup0Support {
        extensions: &["gif"],
        allowed_group0: &["GIF", "XMP", "ICC_Profile"],
    },
];

pub(super) fn allowed_group0_for_file_name(file_name: &str) -> Option<&'static [&'static str]> {
    let extension = std::path::Path::new(file_name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    FORMAT_GROUP0_SUPPORT
        .iter()
        .find(|support| support.extensions.contains(&extension.as_str()))
        .map(|support| support.allowed_group0)
}

/// Hand-curated semantic overrides for cases where listx's physical storage
/// type is insufficient, plus targeted fix-ups for the long tail of
/// `type='undef'` EXIF tags. See `AGENTS.md` (Tag-schema overrides) for the
/// invariants this table is allowed to break.
pub(super) fn apply_overrides(tags: &mut BTreeMap<SchemaDefinitionId, TagInfo>) {
    // `Binary` overrides also force `writable=false`: ExifTool reports these
    // as writable, but only via `-Tag<=file.bin`, and the UI has no editor
    // that produces that input.  Treating them as read-only keeps them out
    // of the autocomplete and prevents bogus "write failed" surprises.
    fn writable_for(kind: &TagKind) -> bool {
        !matches!(kind, TagKind::Binary)
    }
    type TagKindFactory = fn() -> TagKind;
    let overrides: &[(&str, TagKindFactory)] = &[
        // Phase 8 fix-up: XMP and classic EXIF store these datetime values
        // as strings even though their semantics are defined date/time
        // formats. Promoting them here means the DateTime editor lights up,
        // the verifier compares with date-aware semantics, and write_args
        // sends them through the numeric (-n) group per design §6.
        ("IFD0:ModifyDate", || TagKind::DateTime),
        ("ExifIFD:DateTimeOriginal", || TagKind::DateTime),
        ("ExifIFD:CreateDate", || TagKind::DateTime),
        ("XMP-xmp:CreateDate", || TagKind::DateTime),
        ("XMP-xmp:ModifyDate", || TagKind::DateTime),
        ("XMP-xmp:MetadataDate", || TagKind::DateTime),
        ("XMP-photoshop:DateCreated", || TagKind::DateTime),
        ("XMP-exif:DateTimeOriginal", || TagKind::DateTime),
        ("XMP-exif:DateTimeDigitized", || TagKind::DateTime),
        ("XMP-iptcCore:DateCreated", || TagKind::DateTime),
        ("ExifIFD:OffsetTime", || TagKind::TimeOffset),
        ("ExifIFD:OffsetTimeOriginal", || TagKind::TimeOffset),
        ("ExifIFD:OffsetTimeDigitized", || TagKind::TimeOffset),
        // ExifTool -listx describes EXIF GPSLatitude/GPSLongitude as
        // rational64u count=3 because the file stores D/M/S rationals.
        // However the JSON API used by the scanner reports these as scalar
        // decimal degrees under -n, and ExifTool accepts scalar decimal
        // degrees on write with -n. Treat them as app-facing Real values;
        // the EXIF storage detail remains ExifTool's responsibility.
        ("GPS:GPSLatitude", || TagKind::Real),
        ("GPS:GPSLongitude", || TagKind::Real),
        ("GPS:GPSAltitude", || TagKind::Real),
        // listx describes GPSVersionID as `int8u count=4`, matching its
        // four stored bytes. Both display JSON (`2.3.0.0`) and raw `-n`
        // JSON (`2 3 0 0`) expose one version string, not a numeric array,
        // so keep the app-facing schema aligned with that scalar shape.
        ("GPS:GPSVersionID", || TagKind::Text),
        // ── XMP-mlib namespace (AI-generated metadata) ────────────────
        // Registered with exiftool via the embedded user-defined config
        // (see `exiftool_config.rs`). `-listx` does not enumerate
        // user-defined namespaces, so the entries here are the only place
        // these tags appear in the schema.
        ("XMP-mlib:AIDescription", || TagKind::Text),
        ("XMP-mlib:ReverseGeocodeGeocodeJSON", || TagKind::Text),
        ("XMP-mlib:ReverseGeocodeJSONv2", || TagKind::Text),
        ("XMP-mlib:AIInterpretation", || TagKind::Text),
        ("XMP-mlib:AITags", || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-mlib:AIObjects", || {
            TagKind::Bag(Box::new(TagKind::Text))
        }),
        ("XMP-mlib:AIOcrText", || {
            TagKind::Bag(Box::new(TagKind::Text))
        }),
        ("XMP-mlib:AIModel", || TagKind::Text),
        ("XMP-mlib:AIGeneratedAt", || TagKind::DateTime),
        ("XMP-mlib:AIPromptVersion", || TagKind::Text),
        // ── Unknown-kind cleanups ──────────────────────────────────────
        // `-listx` reports `type='undef'` for a long tail of EXIF tags.
        // That maps to `TagKind::Unknown`, which the UI then treats as
        // "unknown editor — fall back to text".  In practice the tags
        // split into two camps:
        //
        //   1. Short ASCII version strings that ExifTool will happily
        //      accept via `-Tag=value`.  Promote these to `Text` so the
        //      user gets a real editor.
        //
        //   2. Opaque binary blobs (MakerNotes, preview/thumbnail JPEG
        //      streams, the entire XMP packet as a single tag) which are
        //      technically `writable='true'` per listx but only via
        //      `-Tag<=file.bin`.  Demote these to `Binary` so the UI marks
        //      them read-only and stops listing them in autocomplete.

        // (1) ASCII version strings — writable as 4-char ASCII via `-Tag=`.
        ("ExifIFD:ExifVersion", || TagKind::Text),
        ("ExifIFD:FlashpixVersion", || TagKind::Text),
        ("InteropIFD:InteropVersion", || TagKind::Text),
        // (1b) Physical byte/undef storage, semantic text. ExifTool may
        // expose these fields as `int8u` byte arrays or `undef`, but they
        // are user-facing text fields. XP* tags are Windows Explorer XP
        // metadata decoded by ExifTool to strings; UserComment is the EXIF
        // comment field and should use the text editor rather than showing
        // Unparsed. Keep this targeted so generic int8u/undef tags continue
        // to parse conservatively.
        ("IFD0:XPTitle", || TagKind::Text),
        ("IFD0:XPComment", || TagKind::Text),
        ("IFD0:XPAuthor", || TagKind::Text),
        ("IFD0:XPKeywords", || TagKind::Text),
        ("IFD0:XPSubject", || TagKind::Text),
        ("ExifIFD:UserComment", || TagKind::Text),
        // (2) Binary blobs — writable only via file redirection.  Marking
        //     them Binary makes the UI treat them as read-only and the
        //     writable filter on autocomplete drops them too (Binary +
        //     no editor = nothing for the user to do here).
        ("ExifIFD:MakerNoteApple", || TagKind::Binary),
        ("ExifIFD:MakerNoteCanon", || TagKind::Binary),
        ("ExifIFD:MakerNoteCasio", || TagKind::Binary),
        ("ExifIFD:MakerNoteCasio2", || TagKind::Binary),
        ("ExifIFD:MakerNoteDJI", || TagKind::Binary),
        ("ExifIFD:MakerNoteDJIInfo", || TagKind::Binary),
        ("ExifIFD:MakerNoteFLIR", || TagKind::Binary),
        ("ExifIFD:MakerNoteFujiFilm", || TagKind::Binary),
        ("ExifIFD:MakerNoteGE", || TagKind::Binary),
        ("ExifIFD:MakerNoteNikon", || TagKind::Binary),
        ("ExifIFD:MakerNoteOlympus", || TagKind::Binary),
        ("ExifIFD:MakerNotePanasonic", || TagKind::Binary),
        ("ExifIFD:MakerNotePentax", || TagKind::Binary),
        ("ExifIFD:MakerNoteRicoh", || TagKind::Binary),
        ("ExifIFD:MakerNoteSamsung1a", || TagKind::Binary),
        ("ExifIFD:MakerNoteSamsung2", || TagKind::Binary),
        ("ExifIFD:MakerNoteSanyo", || TagKind::Binary),
        ("ExifIFD:MakerNoteSigma", || TagKind::Binary),
        ("ExifIFD:MakerNoteSony", || TagKind::Binary),
        ("IFD0:DNGPrivateData", || TagKind::Binary),
        ("IFD0:DustRemovalData", || TagKind::Binary),
        ("IFD0:ThumbnailImage", || TagKind::Binary),
        ("IFD1:ThumbnailImage", || TagKind::Binary),
        ("IFD0:PreviewImage", || TagKind::Binary),
        ("IFD0:XMP", || TagKind::Binary),
    ];

    for (key, build) in overrides {
        let kind = build();
        let writable = writable_for(&kind);
        let (group, name) = key.split_once(':').unwrap_or((*key, ""));
        for existing in tags
            .values_mut()
            .filter(|info| info.group == group && info.name == name)
        {
            existing.kind = kind.clone();
            existing.writable = existing.writable && writable;
        }
    }
}
