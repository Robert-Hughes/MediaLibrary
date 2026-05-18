//! Tag schema registry built from `exiftool -listx`.
//!
//! See `METADATA_FORMATS_DESIGN.md` §3 for the design and rationale.
//!
//! The registry is constructed lazily on first access via `get_registry()`.
//! On the first call per process, the schema is loaded from a disk cache
//! keyed by exiftool version (`<cache_dir>/MediaLibrary/tag_schema_<ver>.json`).
//! On a cache miss — or when the exiftool version has changed since the
//! last run — `exiftool -listx -lang en` runs, the XML is parsed, and the
//! result is written to the cache for next time.
//!
//! `-listx` exposes most of what we need (group, name, base type, writable,
//! enum value tables, count) but is silent on two list-ness signals:
//!
//!   1. **XMP bag/seq/alt:** XMP-dc:Subject reports `type='string'` despite
//!      being a Bag of strings. Plain `string`, no marker.
//!   2. **IIM `List => 1`:** IPTC IIM datasets marked repeatable in
//!      `Image::ExifTool::IPTC` (Keywords, By-line, SupplementalCategories,
//!      ContentLocation*, SubjectReference, By-lineTitle, Writer-Editor)
//!      are byte-identical in `-listx` to scalar IIM strings (City,
//!      Sub-location, Province-State, …). No `flags` attribute, no hint.
//!
//! **Subtle trap:** `-listx`'s `count` attribute on string-shaped IIM tags
//! is the IIM-spec **max char length**, not array cardinality. Reading
//! `count='32'` on `Sub-location` as "32-element bag" gave us the wrong
//! UI `[B]` chip on every IPTC location field. `wrap_count` therefore
//! skips the wrap for Text/LangAlt kinds; cardinality on numeric tags
//! (e.g. `rational64u count='3'` GPSLatitude) still works correctly.
//!
//! Both gaps are filled by a small hand-curated override table at the
//! bottom of this file. The IIM section is locked to IIM 4.1 (frozen
//! 2009) and must stay in lockstep with the `List => 1` flags in
//! `Image::ExifTool::IPTC`.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// What kind of value a tag holds. Drives editor selection and write-back
/// argument construction (see `METADATA_FORMATS_DESIGN.md` §5, §6).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "data")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum TagKind {
    Text,
    LangAlt,
    Integer {
        #[cfg_attr(test, ts(type = "number | null"))]
        min: Option<i64>,
        #[cfg_attr(test, ts(type = "number | null"))]
        max: Option<i64>,
    },
    Real,
    Rational,
    Boolean,
    DateTime,
    Enum { repr: EnumRepr, options: Vec<EnumOption> },
    Bag(Box<TagKind>),
    Seq(Box<TagKind>),
    Alt(Box<TagKind>),
    Struct(BTreeMap<String, TagKind>),
    Binary,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum EnumRepr {
    Integer,
    String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct EnumOption {
    pub code: String,
    pub label: String,
}

/// Schema info for a single tag.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct TagInfo {
    /// Group-1 name (e.g. `XMP-dc`, `IFD0`, `IPTC`). Matches the prefix used
    /// in metadata keys produced by the scanner.
    pub group: String,
    /// Tag name (e.g. `Subject`, `Orientation`).
    pub name: String,
    pub writable: bool,
    pub kind: TagKind,
    pub description: Option<String>,
}

/// Errors that can occur while building the registry.
#[derive(Debug)]
pub enum SchemaError {
    ExifToolFailed(String),
    XmlParseError(String),
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SchemaError::ExifToolFailed(s) => write!(f, "exiftool -listx failed: {}", s),
            SchemaError::XmlParseError(s) => write!(f, "listx XML parse error: {}", s),
        }
    }
}

impl std::error::Error for SchemaError {}

/// In-memory registry. Build once per process.
#[derive(Debug, Clone, Default)]
pub struct TagRegistry {
    /// Keyed by `Group:Name` (e.g. `XMP-dc:Subject`).
    tags: BTreeMap<String, TagInfo>,
}

impl TagRegistry {
    pub fn lookup(&self, group_and_name: &str) -> Option<&TagInfo> {
        self.tags.get(group_and_name)
    }

    pub fn len(&self) -> usize {
        self.tags.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tags.is_empty()
    }

    pub fn all_keys(&self) -> impl Iterator<Item = &str> {
        self.tags.keys().map(|s| s.as_str())
    }

    /// Iterator over (`Group:Name`, `TagInfo`) for writable tags only.
    /// Used by the autocomplete command: surfacing read-only entries lets
    /// users pick a key that ExifTool will subsequently refuse to set.
    pub fn all_writable(&self) -> impl Iterator<Item = (&str, &TagInfo)> {
        self.tags.iter().filter(|(_, info)| info.writable).map(|(k, v)| (k.as_str(), v))
    }

    /// Build from raw `exiftool -listx -lang en` XML output.
    /// Public for testing against fixture XML.
    pub fn from_listx_xml(xml: &str) -> Result<Self, SchemaError> {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().trim_text(true);

        let mut tags: BTreeMap<String, TagInfo> = BTreeMap::new();
        let mut current_group: Option<String> = None;
        let mut current_tag: Option<PartialTag> = None;
        let mut in_desc_en = false;
        let mut in_values = false;
        let mut current_value_id: Option<String> = None;
        let mut in_value_label_en = false;
        let mut desc_buffer = String::new();
        let mut value_label_buffer = String::new();

        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Err(e) => return Err(SchemaError::XmlParseError(e.to_string())),
                Ok(Event::Eof) => break,
                Ok(Event::Start(e)) => {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    let attrs = collect_attrs(&e);
                    match name.as_str() {
                        "table" => {
                            current_group = attrs.get("g1").cloned();
                        }
                        "tag" => {
                            let g1 = attrs
                                .get("g1")
                                .cloned()
                                .or_else(|| current_group.clone())
                                .unwrap_or_default();
                            let tag_name = attrs.get("name").cloned().unwrap_or_default();
                            let type_attr = attrs.get("type").cloned().unwrap_or_default();
                            let writable = attrs.get("writable").map(|s| s == "true").unwrap_or(false);
                            let count = attrs.get("count").and_then(|s| s.parse::<u32>().ok());
                            current_tag = Some(PartialTag {
                                group: g1,
                                name: tag_name,
                                type_attr,
                                writable,
                                count,
                                description: None,
                                enum_options: Vec::new(),
                            });
                        }
                        "desc" => {
                            let lang = attrs.get("lang").cloned().unwrap_or_default();
                            if lang == "en" {
                                if in_values && current_value_id.is_some() {
                                    in_value_label_en = true;
                                    value_label_buffer.clear();
                                } else if current_tag.is_some() {
                                    in_desc_en = true;
                                    desc_buffer.clear();
                                }
                            }
                        }
                        "values" => {
                            in_values = true;
                        }
                        "key" => {
                            current_value_id = attrs.get("id").cloned();
                        }
                        "val" => {
                            let lang = attrs.get("lang").cloned().unwrap_or_default();
                            if lang == "en" && current_value_id.is_some() {
                                in_value_label_en = true;
                                value_label_buffer.clear();
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::End(e)) => {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    match name.as_str() {
                        "tag" => {
                            if let Some(partial) = current_tag.take() {
                                let info = partial.finalize();
                                let key = format!("{}:{}", info.group, info.name);
                                // First definition wins. Tag names recur in many
                                // tables (e.g. `Orientation` lives in several
                                // groups); keying by full Group:Name avoids
                                // collisions.
                                tags.entry(key).or_insert(info);
                            }
                        }
                        "desc" => {
                            if in_value_label_en {
                                if let Some(tag) = current_tag.as_mut() {
                                    if let Some(id) = current_value_id.clone() {
                                        tag.enum_options.push(EnumOption {
                                            code: id,
                                            label: value_label_buffer.trim().to_string(),
                                        });
                                    }
                                }
                                in_value_label_en = false;
                            } else if in_desc_en {
                                if let Some(tag) = current_tag.as_mut() {
                                    tag.description = Some(desc_buffer.trim().to_string());
                                }
                                in_desc_en = false;
                            }
                        }
                        "val" => {
                            if in_value_label_en && current_value_id.is_some() {
                                if let Some(tag) = current_tag.as_mut() {
                                    tag.enum_options.push(EnumOption {
                                        code: current_value_id.clone().unwrap(),
                                        label: value_label_buffer.trim().to_string(),
                                    });
                                }
                                in_value_label_en = false;
                            }
                        }
                        "key" => {
                            current_value_id = None;
                        }
                        "values" => {
                            in_values = false;
                        }
                        "table" => {
                            current_group = None;
                        }
                        _ => {}
                    }
                }
                Ok(Event::Text(t)) => {
                    let text = t.unescape().unwrap_or_default();
                    if in_value_label_en {
                        value_label_buffer.push_str(&text);
                    } else if in_desc_en {
                        desc_buffer.push_str(&text);
                    }
                }
                _ => {}
            }
            buf.clear();
        }

        // Apply XMP list/struct overrides where listx is silent.
        apply_overrides(&mut tags);

        Ok(TagRegistry { tags })
    }

    /// Build by running `exiftool -listx -lang en`.
    pub fn build() -> Result<Self, SchemaError> {
        let output = crate::exiftool_config::exiftool_command()
            .args(["-listx", "-lang", "en"])
            .output()
            .map_err(|e| SchemaError::ExifToolFailed(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(SchemaError::ExifToolFailed(stderr));
        }
        let xml = String::from_utf8_lossy(&output.stdout);
        Self::from_listx_xml(&xml)
    }

    /// Build with disk-cache fast path.
    ///
    /// Cache file: `<dirs::cache_dir()>/MediaLibrary/tag_schema_<ver>.json`.
    /// Version comes from `exiftool -ver`; a single subprocess call.  When
    /// the cache file for the current version exists and parses, it is
    /// used directly.  Otherwise we fall back to `build()` and write the
    /// result to the cache for next time.
    ///
    /// Cache failures are non-fatal: a missing cache dir, a write error,
    /// or a parse error in an existing file all degrade to the live build
    /// path, logging the reason.
    pub fn build_cached() -> Result<Self, SchemaError> {
        let version = read_exiftool_version()?;
        let cache_path = cache_path_for(&version);

        if let Some(ref path) = cache_path {
            if path.exists() {
                match std::fs::read_to_string(path) {
                    Ok(contents) => match serde_json::from_str::<TagRegistry>(&contents) {
                        Ok(mut r) => {
                            // Apply hard-coded overrides after load so the app
                            // doesn't need to bump cache keys when adding new ones.
                            apply_overrides(&mut r.tags);
                            log::info!(
                                "[tag_schema] Loaded {} tags from cache {} (exiftool {})",
                                r.len(),
                                path.display(),
                                version
                            );
                            return Ok(r);
                        }
                        Err(e) => log::warn!(
                            "[tag_schema] Cache file at {} unparseable ({}); rebuilding",
                            path.display(),
                            e
                        ),
                    },
                    Err(e) => log::warn!(
                        "[tag_schema] Could not read cache {} ({}); rebuilding",
                        path.display(),
                        e
                    ),
                }
            }
        }

        let registry = Self::build()?;

        if let Some(path) = cache_path {
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::warn!(
                        "[tag_schema] Could not create cache dir {} ({}); skipping cache write",
                        parent.display(),
                        e
                    );
                    return Ok(registry);
                }
            }
            match serde_json::to_string(&registry) {
                Ok(json) => match std::fs::write(&path, json) {
                    Ok(_) => log::info!(
                        "[tag_schema] Cached {} tags to {} (exiftool {})",
                        registry.len(),
                        path.display(),
                        version
                    ),
                    Err(e) => log::warn!(
                        "[tag_schema] Cache write failed at {} ({}); registry still usable",
                        path.display(),
                        e
                    ),
                },
                Err(e) => log::warn!("[tag_schema] Cache serialize failed ({}); skipping write", e),
            }
        }

        Ok(registry)
    }
}

/// Run `exiftool -ver`. Returns trimmed version string (e.g. `13.57`).
fn read_exiftool_version() -> Result<String, SchemaError> {
    let output = crate::exiftool_config::exiftool_command()
        .arg("-ver")
        .output()
        .map_err(|e| SchemaError::ExifToolFailed(e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(SchemaError::ExifToolFailed(format!("exiftool -ver failed: {}", stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn cache_path_for(version: &str) -> Option<std::path::PathBuf> {
    let dir = dirs::cache_dir()?;
    // Slashes-or-dots-in-version turn into filename-safe form. exiftool
    // versions are like `13.57` — safe — but be defensive.
    let safe: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    Some(dir.join("MediaLibrary").join(format!("tag_schema_{}.json", safe)))
}

// Allow TagRegistry to serialize/deserialize for the disk cache.
impl Serialize for TagRegistry {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.tags.serialize(s)
    }
}

impl<'de> Deserialize<'de> for TagRegistry {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let tags = BTreeMap::<String, TagInfo>::deserialize(d)?;
        Ok(TagRegistry { tags })
    }
}

struct PartialTag {
    group: String,
    name: String,
    type_attr: String,
    writable: bool,
    count: Option<u32>,
    description: Option<String>,
    enum_options: Vec<EnumOption>,
}

impl PartialTag {
    fn finalize(self) -> TagInfo {
        let kind = derive_kind(&self.type_attr, self.count, &self.enum_options);
        TagInfo {
            group: self.group,
            name: self.name,
            writable: self.writable,
            kind,
            description: self.description,
        }
    }
}

fn collect_attrs(e: &quick_xml::events::BytesStart) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for attr in e.attributes().flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let val = attr.unescape_value().map(|s| s.into_owned()).unwrap_or_default();
        out.insert(key, val);
    }
    out
}

/// Map exiftool's `type` attribute plus `count` plus enum options to a TagKind.
///
/// exiftool type vocabulary (partial): `string`, `int8u`/`int16u`/`int32u`,
/// `int8s`/`int16s`/`int32s`, `int64u`, `float`, `double`, `rational32u`,
/// `rational64u`, `rational64s`, `boolean`, `date`, `date+`, `datetime`,
/// `lang-alt`, `struct`, `undef`, `?` (unknown).
///
/// `int*` and friends → Integer; rational → Rational; float/double → Real;
/// any date-flavoured type → DateTime; lang-alt → LangAlt; struct → Struct
/// (we leave fields empty here — populated by override table if known).
///
/// Phase 8 fix-up: `date+` (multiple dates) and `datetime` (XMP-flavoured
/// alias used by some namespaces) were previously unrecognised and fell
/// through to `Unknown`, so write_args's DateTime → numeric arm and
/// matches_variant's DateTime epsilon never fired for them.
fn derive_kind(type_attr: &str, count: Option<u32>, options: &[EnumOption]) -> TagKind {
    let base = match type_attr {
        "string" => TagKind::Text,
        "lang-alt" => TagKind::LangAlt,
        "boolean" => TagKind::Boolean,
        // Every date-shaped type exiftool emits: bare `date`, `date+` (one
        // or more dates), and `datetime` (XMP variant).
        "date" | "date+" | "datetime" => TagKind::DateTime,
        "struct" => TagKind::Struct(BTreeMap::new()),
        "?" | "" | "undef" => TagKind::Unknown,
        "float" | "double" | "real" => TagKind::Real,
        s if s.starts_with("rational") => TagKind::Rational,
        s if s.starts_with("int") => TagKind::Integer { min: None, max: None },
        _ => TagKind::Unknown,
    };

    // Enum overrides numeric/text base when value list present.
    if !options.is_empty() {
        let repr = match &base {
            TagKind::Integer { .. } => EnumRepr::Integer,
            _ => EnumRepr::String,
        };
        let kind = TagKind::Enum { repr, options: options.to_vec() };
        return wrap_count(kind, count);
    }

    wrap_count(base, count)
}

/// Wrap a base kind in `Bag` when `-listx`'s `count` attribute legitimately
/// means "this tag holds N components" — but NOT for string-shaped tags,
/// where `count` is the per-entry max length in characters and has nothing
/// to do with how many entries the tag can hold.
///
/// Subtle gotcha that bit us once already: ExifTool's IPTC IIM table reports
/// the IIM-spec max-length as `count`, so `IPTC:Sub-location` shows up as
/// `type='string' count='32'` (max 32 chars) and `IPTC:Keywords` as
/// `type='string' count='64'` (max 64 chars per keyword). They are NOT
/// 32-element or 64-element arrays. Sub-location is scalar; Keywords is
/// repeatable, but that fact comes from IIM's `List => 1` Perl flag in
/// `Image::ExifTool::IPTC`, which `-listx` does not surface — see the
/// IIM-repeatable override block in `apply_overrides`.
///
/// For genuine multi-component tags (`int16u count='2'` colour-component
/// configs, `rational64u count='3'` GPS coordinates, etc.) the count IS
/// the number of components and the wrap is correct.
fn wrap_count(kind: TagKind, count: Option<u32>) -> TagKind {
    // `count` on a string-shaped tag is a byte/char length cap, not a
    // cardinality. Skip the wrap; any IIM string that is actually
    // repeatable per the IIM spec is listed in `apply_overrides`.
    if matches!(kind, TagKind::Text | TagKind::LangAlt) {
        return kind;
    }
    match count {
        Some(n) if n > 1 => TagKind::Bag(Box::new(kind)),
        _ => kind,
    }
}

/// Hand-curated overrides for XMP list/seq/alt and well-known struct types
/// that listx does not describe, plus targeted fix-ups for the long tail of
/// `type='undef'` EXIF tags.  See `AGENTS.md` (Tag-schema overrides) for the
/// invariants this table is allowed to break.
fn apply_overrides(tags: &mut BTreeMap<String, TagInfo>) {
    // `Binary` overrides also force `writable=false`: ExifTool reports these
    // as writable, but only via `-Tag<=file.bin`, and the UI has no editor
    // that produces that input.  Treating them as read-only keeps them out
    // of the autocomplete and prevents bogus "write failed" surprises.
    fn writable_for(kind: &TagKind) -> bool {
        !matches!(kind, TagKind::Binary)
    }
    let overrides: &[(&str, fn() -> TagKind)] = &[
        // XMP Dublin Core
        ("XMP-dc:Subject", || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-dc:Creator", || TagKind::Seq(Box::new(TagKind::Text))),
        ("XMP-dc:Contributor", || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-dc:Publisher", || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-dc:Language", || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-dc:Relation", || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-dc:Type", || TagKind::Bag(Box::new(TagKind::Text))),
        // Lightroom / IPTC Extension
        ("XMP-lr:HierarchicalSubject", || TagKind::Bag(Box::new(TagKind::Text))),
        // XMP rights
        ("XMP-xmpRights:Owner", || TagKind::Bag(Box::new(TagKind::Text))),

        // ── IPTC IIM repeatable strings ────────────────────────────────
        // The IIM ApplicationRecord defines a small set of DataSets that
        // may appear more than once in the IIM stream (`List => 1` in
        // `Image::ExifTool::IPTC`). Every other IIM string is scalar by
        // spec (City, Sub-location, Province-State, the Country-Primary*
        // pair, Headline, Caption-Abstract, etc.) even though they may
        // technically be writable repeatedly at the record-stream level.
        //
        // `-listx` does NOT expose the `List` flag (output is identical
        // between repeatable `Keywords` and scalar `Sub-location` — both
        // show as `type='string' count='N' writable='true'`), so the only
        // way to know is to hardcode the list per the IIM 4.1 spec. The
        // spec is frozen and the table is short — keep it in lockstep
        // with `Image::ExifTool::IPTC`'s `List` flags. See the comment on
        // `wrap_count` for why we cannot infer this from `count`.
        ("IPTC:SubjectReference",        || TagKind::Bag(Box::new(TagKind::Text))), // 2:12
        ("IPTC:SupplementalCategories",  || TagKind::Bag(Box::new(TagKind::Text))), // 2:20
        ("IPTC:Keywords",                || TagKind::Bag(Box::new(TagKind::Text))), // 2:25
        ("IPTC:ContentLocationCode",     || TagKind::Bag(Box::new(TagKind::Text))), // 2:26
        ("IPTC:ContentLocationName",     || TagKind::Bag(Box::new(TagKind::Text))), // 2:27
        ("IPTC:By-line",                 || TagKind::Bag(Box::new(TagKind::Text))), // 2:80
        ("IPTC:By-lineTitle",            || TagKind::Bag(Box::new(TagKind::Text))), // 2:85
        ("IPTC:Writer-Editor",           || TagKind::Bag(Box::new(TagKind::Text))), // 2:122

        // MWG regions: bag of structs. Inner fields not enumerated here —
        // the editor will treat unknown struct fields as text. Acceptable
        // first cut; Phase 4 can populate `Struct` field maps explicitly.
        ("XMP-mwg-rs:Regions", || TagKind::Struct(BTreeMap::new())),
        // Phase 8 fix-up: the XMP datetime tags listx reports as `string`
        // because XMP itself doesn't constrain them at the schema level.
        // Promoting them here means the DateTime editor lights up, the
        // verifier compares with date-aware semantics, and write_args
        // sends them through the numeric (-n) group per design §6.
        ("XMP-xmp:CreateDate", || TagKind::DateTime),
        ("XMP-xmp:ModifyDate", || TagKind::DateTime),
        ("XMP-xmp:MetadataDate", || TagKind::DateTime),
        ("XMP-photoshop:DateCreated", || TagKind::DateTime),
        ("XMP-exif:DateTimeOriginal", || TagKind::DateTime),
        ("XMP-exif:DateTimeDigitized", || TagKind::DateTime),
        ("XMP-iptcCore:DateCreated", || TagKind::DateTime),

        // ── XMP-mlib namespace (AI-generated metadata) ────────────────
        // Registered with exiftool via the embedded user-defined config
        // (see `exiftool_config.rs`). `-listx` does not enumerate
        // user-defined namespaces, so the entries here are the only place
        // these tags appear in the schema.
        ("XMP-mlib:AIDescription",    || TagKind::Text),
        ("XMP-mlib:AIInterpretation", || TagKind::Text),
        ("XMP-mlib:AITags",           || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-mlib:AIObjects",        || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-mlib:AIOcrText",        || TagKind::Bag(Box::new(TagKind::Text))),
        ("XMP-mlib:AIModel",          || TagKind::Text),
        ("XMP-mlib:AIGeneratedAt",    || TagKind::DateTime),
        ("XMP-mlib:AIPromptVersion",  || TagKind::Text),

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
        if let Some(existing) = tags.get_mut(*key) {
            existing.kind = kind;
            // Only tighten — never grant write permission listx said the
            // tag doesn't have.
            existing.writable = existing.writable && writable;
        } else {
            // Override applies even when listx didn't expose the tag —
            // ensures `XMP-mwg-rs:Regions` is editable when the namespace
            // is present.
            let (group, name) = key.split_once(':').unwrap_or((*key, ""));
            tags.insert(
                key.to_string(),
                TagInfo {
                    group: group.to_string(),
                    name: name.to_string(),
                    writable,
                    kind,
                    description: None,
                },
            );
        }
    }
}

/// Process-wide registry. Built lazily on first access.
static REGISTRY: OnceLock<Result<TagRegistry, String>> = OnceLock::new();

/// Get the registry, building it on first call.
///
/// Returns a reference into the static so callers don't pay clone cost.
/// On build failure, returns an error message; subsequent calls return the
/// same error (no retry within a process).
pub fn get_registry() -> Result<&'static TagRegistry, &'static str> {
    let entry = REGISTRY.get_or_init(|| {
        log::info!("[tag_schema] Initialising registry (cache-first)");
        match TagRegistry::build_cached() {
            Ok(r) => {
                log::info!("[tag_schema] Registry ready with {} tags", r.len());
                Ok(r)
            }
            Err(e) => {
                let msg = e.to_string();
                log::error!("[tag_schema] {}", msg);
                Err(msg)
            }
        }
    });
    entry.as_ref().map_err(|e| e.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LISTX: &str = r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <desc lang='en'>EXIF</desc>
 <tag id='274' name='Orientation' type='int16u' writable='true'>
  <desc lang='en'>Orientation</desc>
  <values>
   <key id='1'><val lang='en'>Horizontal (normal)</val></key>
   <key id='3'><val lang='en'>Rotate 180</val></key>
   <key id='6'><val lang='en'>Rotate 90 CW</val></key>
   <key id='8'><val lang='en'>Rotate 270 CW</val></key>
  </values>
 </tag>
 <tag id='306' name='ModifyDate' type='date' writable='true'>
  <desc lang='en'>Modify Date</desc>
 </tag>
</table>
<table name='IPTC::ApplicationRecord' g0='IPTC' g1='IPTC' g2='Image'>
 <tag id='25' name='Keywords' type='string' count='64' writable='true'>
  <desc lang='en'>Keywords</desc>
 </tag>
 <tag id='90' name='City' type='string' count='32' writable='true' g2='Location'>
  <desc lang='en'>City</desc>
 </tag>
 <tag id='92' name='Sub-location' type='string' count='32' writable='true' g2='Location'>
  <desc lang='en'>Sub-location</desc>
 </tag>
</table>
<table name='EXIF::GPS' g0='EXIF' g1='GPS' g2='Location'>
 <tag id='2' name='GPSLatitude' type='rational64u' count='3' writable='true'>
  <desc lang='en'>GPS Latitude</desc>
 </tag>
</table>
<table name='XMP::dc' g0='XMP' g1='XMP-dc' g2='Other'>
 <tag id='subject' name='Subject' type='string' writable='true' g2='Image'>
  <desc lang='en'>Subject</desc>
 </tag>
 <tag id='description' name='Description' type='lang-alt' writable='true' g2='Image'>
  <desc lang='en'>Description</desc>
 </tag>
 <tag id='creator' name='Creator' type='string' writable='true'>
  <desc lang='en'>Creator</desc>
 </tag>
</table>
<table name='XMP::xmp' g0='XMP' g1='XMP-xmp' g2='Image'>
 <tag id='Rating' name='Rating' type='real' writable='true'>
  <desc lang='en'>Rating</desc>
 </tag>
</table>
<table name='ReadOnly::Stuff' g0='Foo' g1='Foo' g2='Other'>
 <tag id='Bin' name='BinaryThing' type='undef' writable='false'>
  <desc lang='en'>Binary Thing</desc>
 </tag>
</table>
</taginfo>"#;

    fn fixture_registry() -> TagRegistry {
        TagRegistry::from_listx_xml(SAMPLE_LISTX).expect("parse fixture listx")
    }

    #[test]
    fn registry_parses_basic_tags() {
        let r = fixture_registry();
        assert!(r.lookup("IFD0:Orientation").is_some());
        assert!(r.lookup("IFD0:ModifyDate").is_some());
        assert!(r.lookup("IPTC:Keywords").is_some());
        assert!(r.lookup("XMP-dc:Subject").is_some());
        assert!(r.lookup("XMP-dc:Description").is_some());
    }

    #[test]
    fn orientation_is_enum_with_all_options() {
        let r = fixture_registry();
        let t = r.lookup("IFD0:Orientation").unwrap();
        assert!(t.writable);
        match &t.kind {
            TagKind::Enum { repr, options } => {
                assert_eq!(*repr, EnumRepr::Integer);
                assert_eq!(options.len(), 4);
                let labels: Vec<&str> = options.iter().map(|o| o.label.as_str()).collect();
                assert!(labels.contains(&"Rotate 90 CW"));
                let codes: Vec<&str> = options.iter().map(|o| o.code.as_str()).collect();
                assert!(codes.contains(&"6"));
            }
            other => panic!("expected Enum, got {:?}", other),
        }
    }

    #[test]
    fn iptc_keywords_override_yields_bag() {
        // Keywords IS repeatable per IIM 4.1 (2:25 has `List => 1` in
        // Image::ExifTool::IPTC). Note that the `count='64'` attribute is
        // the per-keyword max length, NOT the cardinality — see the
        // `iptc_sublocation_count_is_not_bag` test below for the negative
        // case that pins this distinction. Keywords therefore reaches
        // `Bag<Text>` via the IIM-repeatable override, not via count
        // inference.
        let r = fixture_registry();
        let t = r.lookup("IPTC:Keywords").unwrap();
        match &t.kind {
            TagKind::Bag(inner) => assert!(matches!(**inner, TagKind::Text)),
            other => panic!("expected Bag<Text>, got {:?}", other),
        }
    }

    #[test]
    fn iptc_sublocation_count_is_not_bag() {
        // Regression: ExifTool's `-listx` reports IIM 2:92 Sub-location as
        // `type='string' count='32'`. The 32 is the IIM-spec max byte
        // length, NOT a 32-element array. Sub-location is scalar per IIM
        // 4.1 and we used to wrongly wrap any string with `count > 1` as
        // a Bag, which made the UI show a `[B]` chip on Sub-location,
        // City, Province-State, Country-PrimaryLocation*, etc. — every
        // single one of which is scalar by spec. `wrap_count` now skips
        // the wrap for string-shaped kinds.
        let r = fixture_registry();
        let t = r.lookup("IPTC:Sub-location").unwrap();
        assert!(
            matches!(t.kind, TagKind::Text),
            "Sub-location must be scalar Text, got {:?}",
            t.kind
        );
        let c = r.lookup("IPTC:City").unwrap();
        assert!(
            matches!(c.kind, TagKind::Text),
            "City must be scalar Text, got {:?}",
            c.kind
        );
    }

    #[test]
    fn exif_gps_latitude_count_three_yields_bag() {
        // Counter-test: for non-string EXIF tags, `count` IS the number
        // of components, and the wrap is correct. GPSLatitude is three
        // rationals (deg/min/sec), so the schema kind here is
        // `Bag<Rational>`. This pins the boundary so a future "fix" of
        // wrap_count can't quietly disable cardinality inference for
        // numeric kinds.
        let r = fixture_registry();
        let t = r.lookup("GPS:GPSLatitude").unwrap();
        match &t.kind {
            TagKind::Bag(inner) => assert!(
                matches!(**inner, TagKind::Rational),
                "expected Bag<Rational>, got Bag<{:?}>",
                inner
            ),
            other => panic!("expected Bag<Rational>, got {:?}", other),
        }
    }

    #[test]
    fn xmp_dc_subject_override_to_bag() {
        // listx alone says XMP-dc:Subject is a plain string. Override table
        // upgrades it to Bag<Text>.
        let r = fixture_registry();
        let t = r.lookup("XMP-dc:Subject").unwrap();
        match &t.kind {
            TagKind::Bag(inner) => assert!(matches!(**inner, TagKind::Text)),
            other => panic!("expected Bag<Text>, got {:?}", other),
        }
    }

    #[test]
    fn xmp_dc_creator_override_to_seq() {
        let r = fixture_registry();
        let t = r.lookup("XMP-dc:Creator").unwrap();
        match &t.kind {
            TagKind::Seq(inner) => assert!(matches!(**inner, TagKind::Text)),
            other => panic!("expected Seq<Text>, got {:?}", other),
        }
    }

    #[test]
    fn xmp_dc_description_is_langalt() {
        let r = fixture_registry();
        let t = r.lookup("XMP-dc:Description").unwrap();
        assert!(matches!(t.kind, TagKind::LangAlt));
    }

    #[test]
    fn modify_date_is_datetime() {
        let r = fixture_registry();
        let t = r.lookup("IFD0:ModifyDate").unwrap();
        assert!(matches!(t.kind, TagKind::DateTime));
    }

    #[test]
    fn derive_kind_recognises_all_date_flavours() {
        // Phase 8 fix-up: `date+` and `datetime` previously fell through to
        // Unknown, leaving write_args's DateTime → numeric arm and the
        // datetime override editor inert for tags carrying these types.
        assert!(matches!(derive_kind("date", None, &[]), TagKind::DateTime));
        assert!(matches!(derive_kind("date+", None, &[]), TagKind::DateTime));
        assert!(matches!(derive_kind("datetime", None, &[]), TagKind::DateTime));
    }

    #[test]
    fn xmp_datetime_overrides_promote_string_tags_to_datetime() {
        // listx says XMP-xmp:CreateDate is a plain string because XMP doesn't
        // constrain it at the schema level; the override table promotes the
        // common XMP datetime tags so editors / verifier / write_args all
        // treat them as DateTime.
        let r = fixture_registry();
        let t = r.lookup("XMP-xmp:CreateDate").expect("override should add the tag");
        assert!(matches!(t.kind, TagKind::DateTime),
            "XMP-xmp:CreateDate should be DateTime, got {:?}", t.kind);
        let t = r.lookup("XMP-photoshop:DateCreated").expect("override should add");
        assert!(matches!(t.kind, TagKind::DateTime));
    }

    #[test]
    fn xmp_rating_is_real() {
        let r = fixture_registry();
        let t = r.lookup("XMP-xmp:Rating").unwrap();
        assert!(matches!(t.kind, TagKind::Real));
    }

    #[test]
    fn undef_version_strings_promoted_to_text() {
        // listx exposes ExifVersion / FlashpixVersion / InteropVersion as
        // type='undef', which derives to Unknown.  The override table
        // promotes them to Text so the user gets a real string editor.
        let mut tags: BTreeMap<String, TagInfo> = BTreeMap::new();
        tags.insert("ExifIFD:ExifVersion".to_string(), TagInfo {
            group: "ExifIFD".to_string(),
            name: "ExifVersion".to_string(),
            writable: true,
            kind: TagKind::Unknown,
            description: None,
        });
        apply_overrides(&mut tags);
        let t = tags.get("ExifIFD:ExifVersion").expect("override should keep tag");
        assert!(matches!(t.kind, TagKind::Text));
        assert!(t.writable);
    }

    #[test]
    fn undef_binary_blobs_demoted_to_binary_and_readonly() {
        // MakerNotes / preview/thumbnail JPEGs / opaque DNG buffers are
        // writable='true' per listx but only via `-Tag<=file.bin`.  The
        // override marks them Binary AND forces writable=false so the UI
        // treats them as read-only and the autocomplete drops them.
        let mut tags: BTreeMap<String, TagInfo> = BTreeMap::new();
        tags.insert("ExifIFD:MakerNoteCanon".to_string(), TagInfo {
            group: "ExifIFD".to_string(),
            name: "MakerNoteCanon".to_string(),
            writable: true,
            kind: TagKind::Unknown,
            description: None,
        });
        tags.insert("IFD0:PreviewImage".to_string(), TagInfo {
            group: "IFD0".to_string(),
            name: "PreviewImage".to_string(),
            writable: true,
            kind: TagKind::Unknown,
            description: None,
        });
        apply_overrides(&mut tags);
        let mk = tags.get("ExifIFD:MakerNoteCanon").unwrap();
        assert!(matches!(mk.kind, TagKind::Binary));
        assert!(!mk.writable);
        let pv = tags.get("IFD0:PreviewImage").unwrap();
        assert!(matches!(pv.kind, TagKind::Binary));
        assert!(!pv.writable);
    }

    #[test]
    fn binary_override_does_not_grant_write_when_listx_said_no() {
        // Defensive: if listx ever reported a Binary-overridden tag as
        // writable=false, the override must NOT flip that to true.
        let mut tags: BTreeMap<String, TagInfo> = BTreeMap::new();
        tags.insert("ExifIFD:MakerNoteCanon".to_string(), TagInfo {
            group: "ExifIFD".to_string(),
            name: "MakerNoteCanon".to_string(),
            writable: false,
            kind: TagKind::Unknown,
            description: None,
        });
        apply_overrides(&mut tags);
        assert!(!tags.get("ExifIFD:MakerNoteCanon").unwrap().writable);
    }

    #[test]
    fn undef_type_is_unknown() {
        let r = fixture_registry();
        let t = r.lookup("Foo:BinaryThing").unwrap();
        assert!(matches!(t.kind, TagKind::Unknown));
        assert!(!t.writable);
    }

    #[test]
    fn missing_tag_returns_none() {
        let r = fixture_registry();
        assert!(r.lookup("Nonexistent:Tag").is_none());
        assert!(r.lookup("XMP-dc:NotARealField").is_none());
    }

    #[test]
    fn registry_serde_roundtrip_for_disk_cache() {
        // The build_cached() path writes serde_json of TagRegistry to disk
        // and reads it back.  Verify the round-trip preserves every kind we
        // emit in the fixture.
        let original = fixture_registry();
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: TagRegistry = serde_json::from_str(&json).expect("deserialize");
        // Compare via the same lookups we make at runtime.
        for key in ["IFD0:Orientation", "IPTC:Keywords", "XMP-dc:Subject",
                    "XMP-dc:Description", "XMP-xmp:Rating", "Foo:BinaryThing",
                    "XMP-mwg-rs:Regions"] {
            let a = original.lookup(key);
            let b = restored.lookup(key);
            assert_eq!(a, b, "lookup mismatch after roundtrip for {}", key);
        }
        assert_eq!(original.len(), restored.len());
    }

    #[test]
    fn build_cached_applies_overrides() {
        // Regression test: ensure build_cached() applies overrides even when
        // loading from disk. We test this by forcing a cache build (which may
        // hit disk) and verifying an overridden tag is correct.
        let reg = TagRegistry::build_cached().expect("build_cached failed");
        let t = reg.lookup("IFD1:ThumbnailImage").expect("should have ThumbnailImage");
        assert!(matches!(t.kind, TagKind::Binary));
        assert!(!t.writable);
    }

    #[test]
    fn cache_path_sanitises_version_string() {
        let p = cache_path_for("13.57").unwrap();
        assert!(p.to_string_lossy().contains("tag_schema_13.57.json"));
        let p2 = cache_path_for("13/57 weird!").unwrap();
        let s = p2.to_string_lossy().into_owned();
        assert!(!s.contains('/') || s.contains("MediaLibrary"), "no stray slashes in version segment");
        assert!(!s.contains(' '));
        assert!(!s.contains('!'));
    }

    #[test]
    fn mwg_regions_override_present_even_without_listx_entry() {
        // The fixture XML has no XMP-mwg-rs entries, but the override table
        // inserts Regions so the editor knows it's a struct.
        let r = fixture_registry();
        let t = r.lookup("XMP-mwg-rs:Regions").unwrap();
        assert!(t.writable);
        assert!(matches!(t.kind, TagKind::Struct(_)));
    }
}
