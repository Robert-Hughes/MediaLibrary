//! Tag schema registry built from `exiftool -listx`.
//!
//! See `METADATA_FORMATS_DESIGN.md` §3 for the design and rationale.
//!
//! The registry is constructed lazily on first access via `get_registry()`.
//! On the first call per process, the schema is loaded from a disk cache
//! keyed by exiftool version plus our parser version
//! (`<cache_dir>/MediaLibrary/tag_schema_p<parser>_<ver>.json`).
//! On a cache miss — or when the exiftool version has changed since the
//! last run — `exiftool -listx -f -lang en` runs, the XML is parsed, and the
//! result is written to the cache for next time.
//!
//! `-f` exposes collection semantics in the comma-separated `flags`
//! attribute (`List`, `List,Bag`, `List,Seq`, or `List,Alt`). The `count`
//! attribute is retained as storage metadata only: it may describe byte
//! width or stored component count and never determines app-facing shape.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

mod cache;
#[cfg(test)]
use cache::{cache_path_for, TAG_SCHEMA_PARSER_VERSION};

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
    Date,
    Time,
    DateTime,
    TimeOffset,
    Enum {
        repr: EnumRepr,
        options: Vec<EnumOption>,
    },
    Bag(Box<TagKind>),
    Seq(Box<TagKind>),
    Alt(Box<TagKind>),
    Struct(BTreeMap<String, TagKind>),
    Binary,
    Unknown,
}

impl TagKind {
    /// Whether this schema kind is supported by the metadata write pipeline.
    pub fn supports_metadata_write(&self) -> bool {
        !matches!(self, Self::Binary | Self::Unknown)
    }
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

/// Canonical identity of one ExifTool tag definition.
///
/// At runtime ExifTool emits this identity when JSON output (`-j`) is combined
/// with table output (`-t`) and decimal tag IDs (`-D`). The same identity is
/// reconstructed from `exiftool -listx -f -lang en`.
///
/// Unlike a display name such as `IFD0:Orientation`, this identifies the exact
/// ExifTool tag-table definition selected for the value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct SchemaDefinitionId {
    /// ExifTool's internal tag-table name. Runtime values come from the JSON
    /// `table` field emitted by `-j -t`. Static `-listx` names are normalised
    /// by removing the exact `Image::ExifTool::` prefix when present (for
    /// example, `Image::ExifTool::Exif::Main` becomes `Exif::Main`).
    pub table: String,
    /// The ID of the tag within `table`. Runtime values come from the JSON
    /// `id` field emitted by `-D`. Numeric IDs are canonical base-10 strings,
    /// while textual and symbolic IDs are preserved exactly. The ID is local
    /// to its table and is not globally unique.
    pub tag_id: String,
    /// Selects one definition when a table contains multiple `<tag>` entries
    /// with the same ID. Runtime values use ExifTool's JSON `index`; static
    /// definitions reconstruct the zero-based occurrence in document order.
    /// `None` means the table/ID pair is unambiguous and is distinct from
    /// `Some(0)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub index: Option<u32>,
}

impl std::fmt::Display for SchemaDefinitionId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}/{}", self.table, self.tag_id)?;
        if let Some(index) = self.index {
            write!(formatter, "/index={index}")?;
        }
        Ok(())
    }
}

pub fn normalize_static_table_name(table: &str) -> String {
    table
        .strip_prefix("Image::ExifTool::")
        .unwrap_or(table)
        .to_string()
}

pub fn normalize_static_tag_id(id: &str) -> String {
    if let Some(hex) = id.strip_prefix("0x").or_else(|| id.strip_prefix("0X")) {
        if let Ok(value) = u64::from_str_radix(hex, 16) {
            return value.to_string();
        }
    }
    if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) {
        if let Ok(value) = id.parse::<u64>() {
            return value.to_string();
        }
    }
    id.to_string()
}

pub fn normalize_runtime_tag_id(value: &serde_json::value::RawValue) -> Result<String, String> {
    let token = value.get().trim();
    if token.starts_with('"') {
        return serde_json::from_str::<String>(token)
            .map_err(|error| format!("invalid string ExifTool runtime tag id: {error}"));
    }
    // RawValue already guarantees valid JSON, so the first byte is enough to
    // distinguish a number without parsing it through any bounded numeric type.
    if matches!(token.as_bytes().first(), Some(b'-' | b'0'..=b'9')) {
        return Ok(token.to_string());
    }
    Err(format!(
        "ExifTool runtime tag id must be a number or string, got {token}"
    ))
}

/// Schema info for a single tag.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct TagInfo {
    pub id: SchemaDefinitionId,
    /// ExifTool family-0 information type (for example `EXIF`, `XMP`,
    /// `IPTC`, `ICC_Profile`, `PNG`, or `GIF`). This is the stable section
    /// identifier used by the per-format metadata write allow-list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "string"))]
    pub group0: Option<String>,
    /// Group-1 name (e.g. `XMP-dc`, `IFD0`, `IPTC`). Matches the prefix used
    /// in metadata keys produced by the scanner.
    pub group: String,
    /// Tag name (e.g. `Subject`, `Orientation`).
    pub name: String,
    pub writable: bool,
    pub kind: TagKind,
    pub description: Option<String>,
    /// Raw ExifTool storage width/component count. This does not imply a list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "string"))]
    pub storage_count: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataWriteOperation {
    Set,
    DeleteExisting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataWriteIneligibility {
    ReadOnlySchema,
    UnsupportedSchemaKind,
    UnsupportedFileFormat,
    UnsupportedSectionForFormat,
}

impl std::fmt::Display for MetadataWriteIneligibility {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ReadOnlySchema => "metadata schema is read-only",
            Self::UnsupportedSchemaKind => {
                "metadata schema datatype is not supported by the write pipeline"
            }
            Self::UnsupportedFileFormat => "file format has no metadata write allow-list",
            Self::UnsupportedSectionForFormat => {
                "metadata section is not supported by this file format"
            }
        })
    }
}

impl TagInfo {
    /// The sole metadata-write eligibility decision.
    ///
    /// Set operations must pass ExifTool writability, app datatype support,
    /// and the file-format/family-0 allow-list. Deleting an existing
    /// occurrence deliberately bypasses only the format allow-list so users
    /// can remove non-standard metadata that is already present.
    pub fn metadata_write_eligibility(
        &self,
        file_name: &str,
        operation: MetadataWriteOperation,
    ) -> Result<(), MetadataWriteIneligibility> {
        if !self.writable {
            return Err(MetadataWriteIneligibility::ReadOnlySchema);
        }
        if !self.kind.supports_metadata_write() {
            return Err(MetadataWriteIneligibility::UnsupportedSchemaKind);
        }
        if matches!(operation, MetadataWriteOperation::DeleteExisting) {
            return Ok(());
        }
        let allowed = allowed_group0_for_file_name(file_name)
            .ok_or(MetadataWriteIneligibility::UnsupportedFileFormat)?;
        if !self
            .group0
            .as_deref()
            .is_some_and(|group0| allowed.contains(&group0))
        {
            return Err(MetadataWriteIneligibility::UnsupportedSectionForFormat);
        }
        Ok(())
    }

    pub fn display_name(&self) -> String {
        format!("{}:{}", self.group, self.name)
    }
}

/// Errors that can occur while building the registry.
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum SchemaError {
    #[serde(rename = "exiftool_failed")]
    ExifToolFailed {
        command: String,
        stdout: String,
        stderr: String,
    },
    #[serde(rename = "xml_parse_error")]
    XmlParseError { detail: String },
}

impl SchemaError {
    fn exiftool_failed(
        command: &std::process::Command,
        stdout: impl Into<String>,
        stderr: impl Into<String>,
    ) -> Self {
        Self::ExifToolFailed {
            command: crate::exiftool_config::describe_command(command),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SchemaError::ExifToolFailed {
                command,
                stdout,
                stderr,
            } => write!(
                f,
                "ExifTool command failed.\nCommand: {command}\nstdout: {stdout}\nstderr/error: {stderr}"
            ),
            SchemaError::XmlParseError { detail } => {
                write!(f, "listx XML parse error: {detail}")
            }
        }
    }
}

impl std::error::Error for SchemaError {}

/// In-memory registry. A successful build is cached for the process lifetime.
#[derive(Debug, Clone, Default)]
pub struct TagRegistry {
    tags: BTreeMap<SchemaDefinitionId, TagInfo>,
}

impl TagRegistry {
    pub fn lookup(&self, id: &SchemaDefinitionId) -> Option<&TagInfo> {
        self.tags.get(id)
    }

    /// Return only exact requested definitions, deduplicated and ordered by ID.
    pub(crate) fn lookup_exact_batch(&self, ids: Vec<SchemaDefinitionId>) -> Vec<TagInfo> {
        ids.into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .filter_map(|id| self.lookup(&id).cloned())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.tags.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tags.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&SchemaDefinitionId, &TagInfo)> {
        self.tags.iter()
    }

    /// Transport set for the frontend. Each definition carries family-0 so the
    /// UI can apply format policy before constructing targets. This is not a
    /// write-eligibility decision and must not be used by Rust write paths.
    pub(crate) fn schema_writable_transport_set(&self) -> impl Iterator<Item = &TagInfo> {
        self.tags
            .values()
            .filter(|info| info.writable && info.kind.supports_metadata_write())
    }

    /// Build by running `exiftool -listx -f -lang en`.
    pub fn build() -> Result<Self, SchemaError> {
        let mut command = crate::exiftool_config::exiftool_command();
        command.args(["-listx", "-f", "-lang", "en"]);
        let output = command
            .output()
            .map_err(|error| SchemaError::exiftool_failed(&command, "", error.to_string()))?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(SchemaError::exiftool_failed(&command, stdout, stderr));
        }
        let xml = String::from_utf8_lossy(&output.stdout);
        Self::from_listx_xml(&xml)
    }

    /// Build with disk-cache fast path.
    ///
    /// Cache file:
    /// `<dirs::cache_dir()>/MediaLibrary/tag_schema_p<parser>_<ver>.json`.
    /// Version comes from `exiftool -ver`; a single subprocess call.  When
    /// the cache file for the current version exists and parses, it is
    /// used directly.  Otherwise we fall back to `build()` and write the
    /// result to the cache for next time.
    ///
    /// Cache failures are non-fatal: a missing cache dir, a write error,
    /// or a parse error in an existing file all degrade to the live build
    /// path, logging the reason.
    pub fn build_cached() -> Result<Self, SchemaError> {
        cache::build_cached()
    }
}

// Allow TagRegistry to serialize/deserialize for the disk cache.
impl Serialize for TagRegistry {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.tags.values().collect::<Vec<_>>().serialize(s)
    }
}

impl<'de> Deserialize<'de> for TagRegistry {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let infos = Vec::<TagInfo>::deserialize(d)?;
        let mut tags = BTreeMap::new();
        for info in infos {
            let id = info.id.clone();
            if tags.insert(id.clone(), info).is_some() {
                return Err(serde::de::Error::custom(format!(
                    "duplicate schema identity in cache: {id:?}"
                )));
            }
        }
        Ok(TagRegistry { tags })
    }
}

// ExifTool listx XML interpretation and TagKind derivation.
mod parser;
#[cfg(test)]
use parser::*;

// Application-specific schema policy and format overrides.
mod overrides;
use overrides::{allowed_group0_for_file_name, apply_overrides};

/// Process-wide registry. Built lazily on first successful access.
static REGISTRY: OnceLock<TagRegistry> = OnceLock::new();
static REGISTRY_BUILD_LOCK: Mutex<()> = Mutex::new(());

fn cache_successful_registry_build<E>(
    registry: &OnceLock<TagRegistry>,
    build_result: Result<TagRegistry, E>,
) -> Result<&TagRegistry, E> {
    if let Some(existing) = registry.get() {
        return Ok(existing);
    }

    match build_result {
        Ok(built) => {
            // Another caller may have won the race while this build was in
            // progress. Either way, the OnceLock now contains the registry we
            // should use for the rest of the process.
            let _ = registry.set(built);
            Ok(registry
                .get()
                .expect("successful schema build must initialise registry"))
        }
        Err(error) => {
            // Do not cache failures: Settings can change the ExifTool command
            // and a later preload must be able to retry in this process.
            if let Some(existing) = registry.get() {
                Ok(existing)
            } else {
                Err(error)
            }
        }
    }
}

/// Get the registry, building it on first successful call.
///
/// Returns a reference into the static so callers don't pay clone cost. A
/// failed build is deliberately not cached, allowing a corrected ExifTool
/// setting to be retried without restarting MediaLibrary.
pub fn get_registry() -> Result<&'static TagRegistry, SchemaError> {
    if let Some(existing) = REGISTRY.get() {
        return Ok(existing);
    }

    let _build_guard = REGISTRY_BUILD_LOCK
        .lock()
        .expect("tag-schema registry build lock poisoned");
    if let Some(existing) = REGISTRY.get() {
        return Ok(existing);
    }

    log::info!("[tag_schema] Initialising registry (cache-first)");
    let result = TagRegistry::build_cached();
    match cache_successful_registry_build(&REGISTRY, result) {
        Ok(registry) => {
            log::info!("[tag_schema] Registry ready with {} tags", registry.len());
            Ok(registry)
        }
        Err(error) => {
            log::error!("[tag_schema] {}", error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exiftool_failure_preserves_command_stdout_and_stderr() {
        let mut command = std::process::Command::new("/opt/homebrew/bin/exiftool");
        command.args(["-config", "/tmp/mlib config", "-ver"]);

        let error =
            SchemaError::exiftool_failed(&command, "partial stdout\n", "permission denied\n");
        match error {
            SchemaError::ExifToolFailed {
                command,
                stdout,
                stderr,
            } => {
                assert_eq!(
                    command,
                    "/opt/homebrew/bin/exiftool -config '/tmp/mlib config' -ver"
                );
                assert_eq!(stdout, "partial stdout\n");
                assert_eq!(stderr, "permission denied\n");
            }
            SchemaError::XmlParseError { .. } => panic!("expected ExifTool failure"),
        }
    }

    #[test]
    fn failed_registry_build_can_be_retried_until_success() {
        let registry = OnceLock::new();

        let first = cache_successful_registry_build(
            &registry,
            Err::<TagRegistry, String>("missing exiftool".into()),
        );
        assert_eq!(first.unwrap_err(), "missing exiftool");
        assert!(registry.get().is_none());

        let second = cache_successful_registry_build(
            &registry,
            Ok::<TagRegistry, String>(TagRegistry::default()),
        )
        .unwrap();
        assert_eq!(second.len(), 0);
        assert!(registry.get().is_some());

        let third = cache_successful_registry_build(
            &registry,
            Err::<TagRegistry, String>("should be ignored".into()),
        )
        .unwrap();
        assert!(std::ptr::eq(second, third));
    }

    #[test]
    fn metadata_write_support_matrix_rejects_only_binary_unknown_and_read_only() {
        let supported = vec![
            TagKind::Text,
            TagKind::LangAlt,
            TagKind::Integer {
                min: None,
                max: None,
            },
            TagKind::Real,
            TagKind::Rational,
            TagKind::Boolean,
            TagKind::Date,
            TagKind::Time,
            TagKind::DateTime,
            TagKind::TimeOffset,
            TagKind::Enum {
                repr: EnumRepr::String,
                options: Vec::new(),
            },
            TagKind::Bag(Box::new(TagKind::Text)),
            TagKind::Seq(Box::new(TagKind::Text)),
            TagKind::Alt(Box::new(TagKind::Text)),
            TagKind::Struct(BTreeMap::new()),
        ];
        assert!(supported.iter().all(TagKind::supports_metadata_write));
        assert!(!TagKind::Binary.supports_metadata_write());
        assert!(!TagKind::Unknown.supports_metadata_write());

        let info = |kind, writable| TagInfo {
            id: SchemaDefinitionId {
                table: "Test::Main".into(),
                tag_id: "1".into(),
                index: None,
            },
            group0: Some("EXIF".into()),
            group: "Test".into(),
            name: "Field".into(),
            writable,
            kind,
            description: None,
            storage_count: None,
        };
        assert!(info(TagKind::Text, true)
            .metadata_write_eligibility("photo.jpg", MetadataWriteOperation::Set)
            .is_ok());
        assert!(info(TagKind::Text, false)
            .metadata_write_eligibility("photo.jpg", MetadataWriteOperation::Set)
            .is_err());
        assert!(info(TagKind::Binary, true)
            .metadata_write_eligibility("photo.jpg", MetadataWriteOperation::Set)
            .is_err());
        assert!(info(TagKind::Unknown, true)
            .metadata_write_eligibility("photo.jpg", MetadataWriteOperation::Set)
            .is_err());
    }

    #[test]
    fn writable_transport_filters_every_kind_and_preserves_id_order() {
        let cases = vec![
            ("01", TagKind::Text, true),
            ("02", TagKind::LangAlt, true),
            (
                "03",
                TagKind::Integer {
                    min: None,
                    max: None,
                },
                true,
            ),
            ("04", TagKind::Real, true),
            ("05", TagKind::Rational, true),
            ("06", TagKind::Boolean, true),
            ("07", TagKind::Date, true),
            ("08", TagKind::Time, true),
            ("09", TagKind::DateTime, true),
            ("10", TagKind::TimeOffset, true),
            (
                "11",
                TagKind::Enum {
                    repr: EnumRepr::String,
                    options: Vec::new(),
                },
                true,
            ),
            ("12", TagKind::Bag(Box::new(TagKind::Text)), true),
            ("13", TagKind::Seq(Box::new(TagKind::Text)), true),
            ("14", TagKind::Alt(Box::new(TagKind::Text)), true),
            ("15", TagKind::Struct(BTreeMap::new()), true),
            ("90", TagKind::Text, false),
            ("91", TagKind::Binary, true),
            ("92", TagKind::Unknown, true),
        ];
        let tags = cases
            .into_iter()
            .map(|(tag_id, kind, writable)| {
                let id = SchemaDefinitionId {
                    table: "Test::Main".into(),
                    tag_id: tag_id.into(),
                    index: None,
                };
                let info = TagInfo {
                    id: id.clone(),
                    group0: Some("EXIF".into()),
                    group: "Test".into(),
                    name: format!("Field{tag_id}"),
                    writable,
                    kind,
                    description: None,
                    storage_count: None,
                };
                (id, info)
            })
            .collect();
        let registry = TagRegistry { tags };

        let supported = registry.schema_writable_transport_set().collect::<Vec<_>>();
        assert!(supported.iter().all(|info| {
            info.metadata_write_eligibility("photo.jpg", MetadataWriteOperation::Set)
                .is_ok()
        }));
        assert_eq!(
            supported
                .iter()
                .map(|info| info.id.tag_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14",
                "15",
            ]
        );
    }

    #[test]
    fn write_eligibility_uses_file_format_and_raw_family_zero() {
        let info = |group0: &str, writable: bool, kind: TagKind| TagInfo {
            id: SchemaDefinitionId {
                table: format!("{group0}::Main"),
                tag_id: "Field".into(),
                index: None,
            },
            group0: Some(group0.into()),
            group: "DisplayGroup".into(),
            name: "Field".into(),
            writable,
            kind,
            description: None,
            storage_count: None,
        };

        let exif = info("EXIF", true, TagKind::Text);
        let xmp = info("XMP", true, TagKind::Text);
        let iptc = info("IPTC", true, TagKind::Text);

        assert!(exif
            .metadata_write_eligibility("photo.JPEG", MetadataWriteOperation::Set)
            .is_ok());
        assert!(xmp
            .metadata_write_eligibility("animation.gif", MetadataWriteOperation::Set)
            .is_ok());
        assert_eq!(
            exif.metadata_write_eligibility("animation.gif", MetadataWriteOperation::Set),
            Err(MetadataWriteIneligibility::UnsupportedSectionForFormat)
        );
        assert_eq!(
            iptc.metadata_write_eligibility("image.png", MetadataWriteOperation::Set),
            Err(MetadataWriteIneligibility::UnsupportedSectionForFormat)
        );
        assert_eq!(
            xmp.metadata_write_eligibility("image.webp", MetadataWriteOperation::Set),
            Err(MetadataWriteIneligibility::UnsupportedFileFormat)
        );
    }

    #[test]
    fn deleting_existing_incompatible_metadata_bypasses_only_format_policy() {
        let info = |writable: bool, kind: TagKind| TagInfo {
            id: SchemaDefinitionId {
                table: "EXIF::Main".into(),
                tag_id: "Field".into(),
                index: None,
            },
            group0: Some("EXIF".into()),
            group: "IFD0".into(),
            name: "Field".into(),
            writable,
            kind,
            description: None,
            storage_count: None,
        };

        assert!(info(true, TagKind::Text)
            .metadata_write_eligibility("animation.gif", MetadataWriteOperation::DeleteExisting,)
            .is_ok());
        assert_eq!(
            info(false, TagKind::Text).metadata_write_eligibility(
                "animation.gif",
                MetadataWriteOperation::DeleteExisting,
            ),
            Err(MetadataWriteIneligibility::ReadOnlySchema)
        );
        assert_eq!(
            info(true, TagKind::Binary).metadata_write_eligibility(
                "animation.gif",
                MetadataWriteOperation::DeleteExisting,
            ),
            Err(MetadataWriteIneligibility::UnsupportedSchemaKind)
        );
    }

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
 <tag id='25' name='Keywords' type='string' count='64' writable='true' flags='List'>
  <desc lang='en'>Keywords</desc>
 </tag>
 <tag id='55' name='DateCreated' type='digits' count='8' writable='true' g2='Time'>
  <desc lang='en'>Date Created</desc>
 </tag>
 <tag id='60' name='TimeCreated' type='string' count='11' writable='true' g2='Time'>
  <desc lang='en'>Time Created</desc>
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
 <tag id='4' name='GPSLongitude' type='rational64u' count='3' writable='true'>
  <desc lang='en'>GPS Longitude</desc>
 </tag>
 <tag id='6' name='GPSAltitude' type='rational64u' writable='true'>
  <desc lang='en'>GPS Altitude</desc>
 </tag>
 <tag id='1' name='GPSLatitudeRef' type='string' count='2' writable='true'>
  <values><key id='N'><val lang='en'>North</val></key><key id='S'><val lang='en'>South</val></key></values>
 </tag>
 <tag id='3' name='GPSLongitudeRef' type='string' count='2' writable='true'>
  <values><key id='E'><val lang='en'>East</val></key><key id='W'><val lang='en'>West</val></key></values>
 </tag>
 <tag id='0' name='GPSVersionID' type='int8u' count='4' writable='true'><desc lang='en'>GPS Version</desc></tag>
</table>
<table name='EXIF::Other' g0='EXIF' g1='ExifIFD' g2='Image'>
 <tag id='0x9999' name='ThreeRationals' type='rational64u' count='3' writable='true'>
  <desc lang='en'>Three Rationals</desc>
 </tag>
</table>
<table name='XMP::dc' g0='XMP' g1='XMP-dc' g2='Other'>
 <tag id='subject' name='Subject' type='string' writable='true' flags='List,Bag' g2='Image'>
  <desc lang='en'>Subject</desc>
 </tag>
 <tag id='description' name='Description' type='lang-alt' writable='true' g2='Image'>
  <desc lang='en'>Description</desc>
 </tag>
 <tag id='creator' name='Creator' type='string' writable='true' flags='List,Seq'>
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

    fn test_id(table: &str, tag_id: &str) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: table.to_string(),
            tag_id: tag_id.to_string(),
            index: None,
        }
    }

    fn fixture_registry() -> TagRegistry {
        TagRegistry::from_listx_xml(SAMPLE_LISTX).expect("parse fixture listx")
    }

    fn exact_batch_registry() -> TagRegistry {
        let ids = [
            SchemaDefinitionId {
                table: "Table::B".into(),
                tag_id: "2".into(),
                index: None,
            },
            SchemaDefinitionId {
                table: "Table::A".into(),
                tag_id: "1".into(),
                index: None,
            },
            SchemaDefinitionId {
                table: "Table::A".into(),
                tag_id: "1".into(),
                index: Some(0),
            },
        ];
        let tags = ids
            .into_iter()
            .map(|id| {
                let info = TagInfo {
                    id: id.clone(),
                    group0: Some("EXIF".into()),
                    group: "Shared".into(),
                    name: "Name".into(),
                    writable: true,
                    kind: TagKind::Text,
                    description: None,
                    storage_count: None,
                };
                (id, info)
            })
            .collect();
        TagRegistry { tags }
    }

    #[test]
    fn exact_batch_deduplicates_requested_ids() {
        let registry = exact_batch_registry();
        let id = SchemaDefinitionId {
            table: "Table::B".into(),
            tag_id: "2".into(),
            index: None,
        };
        assert_eq!(registry.lookup_exact_batch(vec![id.clone(), id]).len(), 1);
    }

    #[test]
    fn exact_batch_keeps_same_friendly_name_definitions_separate() {
        let registry = exact_batch_registry();
        let ids: Vec<_> = registry.iter().map(|(id, _)| id.clone()).collect();
        assert_eq!(registry.lookup_exact_batch(ids).len(), 3);
    }

    #[test]
    fn exact_batch_distinguishes_missing_index_from_zero() {
        let registry = exact_batch_registry();
        let found = registry.lookup_exact_batch(vec![
            SchemaDefinitionId {
                table: "Table::A".into(),
                tag_id: "1".into(),
                index: None,
            },
            SchemaDefinitionId {
                table: "Table::A".into(),
                tag_id: "1".into(),
                index: Some(0),
            },
        ]);
        assert_eq!(found.len(), 2);
        assert_ne!(found[0].id, found[1].id);
    }

    #[test]
    fn exact_batch_omits_missing_ids() {
        let registry = exact_batch_registry();
        assert!(registry
            .lookup_exact_batch(vec![SchemaDefinitionId {
                table: "Missing".into(),
                tag_id: "404".into(),
                index: None,
            }])
            .is_empty());
    }

    #[test]
    fn exact_batch_results_are_deterministically_ordered() {
        let registry = exact_batch_registry();
        let mut ids: Vec<_> = registry.iter().map(|(id, _)| id.clone()).collect();
        ids.reverse();
        let result = registry.lookup_exact_batch(ids);
        assert!(result.windows(2).all(|pair| pair[0].id < pair[1].id));
    }

    #[test]
    fn registry_parses_basic_tags() {
        let r = fixture_registry();
        assert_eq!(
            r.lookup(&test_id("EXIF::Main", "274"))
                .and_then(|info| info.group0.as_deref()),
            Some("EXIF")
        );
        assert!(r.lookup(&test_id("EXIF::Main", "306")).is_some());
        assert_eq!(
            r.lookup(&test_id("IPTC::ApplicationRecord", "25"))
                .and_then(|info| info.group0.as_deref()),
            Some("IPTC")
        );
        assert!(r.lookup(&test_id("XMP::dc", "subject")).is_some());
        assert!(r.lookup(&test_id("XMP::dc", "description")).is_some());
    }

    #[test]
    fn orientation_is_enum_with_all_options() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("EXIF::Main", "274")).unwrap();
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
        let r = fixture_registry();
        let t = r.lookup(&test_id("IPTC::ApplicationRecord", "25")).unwrap();
        match &t.kind {
            TagKind::Bag(inner) => assert!(matches!(**inner, TagKind::Text)),
            other => panic!("expected Bag<Text>, got {:?}", other),
        }
    }

    #[test]
    fn iptc_sublocation_count_is_not_bag() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("IPTC::ApplicationRecord", "92")).unwrap();
        assert!(
            matches!(t.kind, TagKind::Text),
            "Sub-location must be scalar Text, got {:?}",
            t.kind
        );
        let c = r.lookup(&test_id("IPTC::ApplicationRecord", "90")).unwrap();
        assert!(
            matches!(c.kind, TagKind::Text),
            "City must be scalar Text, got {:?}",
            c.kind
        );
    }

    #[test]
    fn exif_gps_coordinates_are_app_facing_reals() {
        let r = fixture_registry();
        let lat = r.lookup(&test_id("EXIF::GPS", "2")).unwrap();
        assert!(
            matches!(lat.kind, TagKind::Real),
            "GPSLatitude must be scalar Real, got {:?}",
            lat.kind
        );
        let lon = r.lookup(&test_id("EXIF::GPS", "4")).unwrap();
        assert!(
            matches!(lon.kind, TagKind::Real),
            "GPSLongitude must be scalar Real, got {:?}",
            lon.kind
        );
        let alt = r.lookup(&test_id("EXIF::GPS", "6")).unwrap();
        assert!(
            matches!(alt.kind, TagKind::Real),
            "GPSAltitude must be scalar Real, got {:?}",
            alt.kind
        );
    }

    #[test]
    fn gps_version_id_is_app_facing_text() {
        let r = fixture_registry();
        let version = r
            .lookup(&test_id("EXIF::GPS", "0"))
            .expect("GPSVersionID override should add the tag");
        assert!(
            matches!(version.kind, TagKind::Text),
            "GPSVersionID must be scalar Text, got {:?}",
            version.kind
        );
    }

    #[test]
    fn gps_reference_storage_width_remains_scalar_enum() {
        let r = fixture_registry();
        for id in [test_id("EXIF::GPS", "1"), test_id("EXIF::GPS", "3")] {
            let tag = r.lookup(&id).unwrap();
            assert!(matches!(
                tag.kind,
                TagKind::Enum {
                    repr: EnumRepr::String,
                    ..
                }
            ));
            assert_eq!(tag.storage_count.as_deref(), Some("2"));
        }
    }

    #[test]
    fn numeric_storage_count_does_not_create_a_collection() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("EXIF::Other", "39321")).unwrap();
        assert!(matches!(t.kind, TagKind::Rational));
        assert_eq!(t.storage_count.as_deref(), Some("3"));
    }

    #[test]
    fn explicit_list_flags_define_collection_shape() {
        let xml = r#"<taginfo><table name='Test::Main' g1='Test'>
          <tag id='generic' name='Generic' type='string' count='64' writable='true' flags='List'><desc lang='en'>Generic</desc></tag>
          <tag id='ordered' name='Ordered' type='int32u' count='4' writable='true' flags='List,Seq'><desc lang='en'>Ordered</desc></tag>
          <tag id='alternative' name='Alternative' type='string' writable='true' flags='List,Alt'><desc lang='en'>Alternative</desc></tag>
        </table></taginfo>"#;
        let r = TagRegistry::from_listx_xml(xml).unwrap();
        assert!(matches!(
            r.lookup(&test_id("Test::Main", "generic")).unwrap().kind,
            TagKind::Bag(_)
        ));
        assert!(matches!(
            r.lookup(&test_id("Test::Main", "ordered")).unwrap().kind,
            TagKind::Seq(_)
        ));
        assert!(matches!(
            r.lookup(&test_id("Test::Main", "alternative"))
                .unwrap()
                .kind,
            TagKind::Alt(_)
        ));
    }

    #[test]
    fn xmp_dc_subject_list_flag_derives_bag() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("XMP::dc", "subject")).unwrap();
        match &t.kind {
            TagKind::Bag(inner) => assert!(matches!(**inner, TagKind::Text)),
            other => panic!("expected Bag<Text>, got {:?}", other),
        }
    }

    #[test]
    fn xmp_dc_creator_list_flag_derives_seq() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("XMP::dc", "creator")).unwrap();
        match &t.kind {
            TagKind::Seq(inner) => assert!(matches!(**inner, TagKind::Text)),
            other => panic!("expected Seq<Text>, got {:?}", other),
        }
    }

    #[test]
    fn xmp_dc_description_is_langalt() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("XMP::dc", "description")).unwrap();
        assert!(matches!(t.kind, TagKind::LangAlt));
    }

    #[test]
    fn schema_parser_cache_version_is_current() {
        assert_eq!(TAG_SCHEMA_PARSER_VERSION, 11);
    }

    #[test]
    fn flattened_members_populate_repeatable_and_nested_struct_schemas() {
        let xml = r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='XMP::iptcExt' g0='XMP' g1='XMP-iptcExt' g2='Image'>
 <tag id='LocationCreated' name='LocationCreated' type='struct' writable='true' flags='Bag,List'>
  <desc lang='en'>Location Created</desc>
 </tag>
 <tag id='LocationCreatedCity' name='LocationCreatedCity' type='string' writable='true' flags='Flattened,List' struct='LocationCreated'>
  <desc lang='en'>Location Created City</desc>
 </tag>
 <tag id='LocationCreatedGPSAltitude' name='LocationCreatedGPSAltitude' type='rational' writable='true' flags='Flattened,List' struct='LocationCreated'>
  <desc lang='en'>Location Created GPS Altitude</desc>
 </tag>
 <tag id='LocationCreatedGPSAltitudeRef' name='LocationCreatedGPSAltitudeRef' type='integer' writable='true' flags='Flattened,List' struct='LocationCreated'>
  <desc lang='en'>Location Created GPS Altitude Ref</desc>
  <values>
   <key id='0'><val lang='en'>Above Sea Level</val></key>
   <key id='1'><val lang='en'>Below Sea Level</val></key>
  </values>
 </tag>
 <tag id='LocationCreatedGPSLatitude' name='LocationCreatedGPSLatitude' type='string' writable='true' flags='Flattened,List' struct='LocationCreated'>
  <desc lang='en'>Location Created GPS Latitude</desc>
 </tag>
 <tag id='LocationCreatedLocationId' name='LocationCreatedLocationId' type='string' writable='true' flags='Bag,Flattened,List' struct='LocationCreated'>
  <desc lang='en'>Location Created Location Id</desc>
 </tag>
 <tag id='LocationCreatedLocationName' name='LocationCreatedLocationName' type='lang-alt' writable='true' flags='Flattened,List' struct='LocationCreated'>
  <desc lang='en'>Location Created Location Name</desc>
 </tag>
 <tag id='Root' name='Root' type='struct' writable='true'>
  <desc lang='en'>Root</desc>
 </tag>
 <tag id='RootChild' name='RootChild' type='struct' writable='true' flags='Flattened' struct='Root'>
  <desc lang='en'>Root Child</desc>
 </tag>
 <tag id='RootChildScore' name='RootChildScore' type='integer' writable='true' flags='Flattened' struct='RootChild'>
  <desc lang='en'>Root Child Score</desc>
 </tag>
</table>
</taginfo>"#;
        let r = TagRegistry::from_listx_xml(xml).expect("parse flattened struct fixture");

        let location = r
            .lookup(&test_id("XMP::iptcExt", "LocationCreated"))
            .unwrap();
        let TagKind::Bag(location_item) = &location.kind else {
            panic!("LocationCreated should be a Bag, got {:?}", location.kind);
        };
        let TagKind::Struct(fields) = location_item.as_ref() else {
            panic!(
                "LocationCreated items should be Struct, got {:?}",
                location_item
            );
        };
        assert!(matches!(fields["City"], TagKind::Text));
        assert!(matches!(fields["GPSAltitude"], TagKind::Real));
        assert!(matches!(fields["GPSLatitude"], TagKind::Real));
        assert!(matches!(fields["LocationName"], TagKind::LangAlt));
        assert!(matches!(
            fields["LocationId"],
            TagKind::Bag(ref inner) if matches!(inner.as_ref(), TagKind::Text)
        ));
        assert!(matches!(
            fields["GPSAltitudeRef"],
            TagKind::Enum {
                repr: EnumRepr::Integer,
                ref options,
            } if options
                == &vec![
                    EnumOption {
                        code: "0".into(),
                        label: "Above Sea Level".into(),
                    },
                    EnumOption {
                        code: "1".into(),
                        label: "Below Sea Level".into(),
                    },
                ]
        ));

        // The flattened accessor is a list across repeated parent structures,
        // while the corresponding field inside each structure remains scalar.
        let flat_city = r
            .lookup(&test_id("XMP::iptcExt", "LocationCreatedCity"))
            .unwrap();
        assert!(matches!(
            flat_city.kind,
            TagKind::Bag(ref inner) if matches!(inner.as_ref(), TagKind::Text)
        ));

        let root = r.lookup(&test_id("XMP::iptcExt", "Root")).unwrap();
        let TagKind::Struct(root_fields) = &root.kind else {
            panic!("Root should be Struct, got {:?}", root.kind);
        };
        let TagKind::Struct(child_fields) = &root_fields["Child"] else {
            panic!(
                "Root.Child should be Struct, got {:?}",
                root_fields["Child"]
            );
        };
        assert!(matches!(
            child_fields["Score"],
            TagKind::Integer {
                min: None,
                max: None
            }
        ));
    }

    #[test]
    fn duplicate_identity_is_rejected() {
        let xml = r#"<taginfo>
          <table g1='Test'><tag name='Duplicate' type='?' writable='false'><desc lang='en'>Weak</desc></tag></table>
          <table g1='Test'><tag name='Duplicate' type='string' writable='true' flags='List,Bag'><desc lang='en'>Rich</desc></tag></table>
        </taginfo>"#;
        assert!(TagRegistry::from_listx_xml(xml).is_err());
    }

    #[test]
    fn modify_date_is_datetime() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("EXIF::Main", "306")).unwrap();
        assert!(matches!(t.kind, TagKind::DateTime));
    }

    #[test]
    fn derive_kind_recognises_all_date_flavours() {
        assert!(matches!(derive_kind("date", None, &[]), TagKind::DateTime));
        assert!(matches!(derive_kind("date+", None, &[]), TagKind::DateTime));
        assert!(matches!(
            derive_kind("datetime", None, &[]),
            TagKind::DateTime
        ));
    }

    #[test]
    fn iptc_split_date_time_kinds_are_schema_derived() {
        let r = fixture_registry();
        let date = r.lookup(&test_id("IPTC::ApplicationRecord", "55")).unwrap();
        assert!(matches!(date.kind, TagKind::Date));
        let time = r.lookup(&test_id("IPTC::ApplicationRecord", "60")).unwrap();
        assert!(matches!(time.kind, TagKind::Time));
    }

    #[test]
    fn iptc_date_time_storage_shapes_derive_top_level_kinds() {
        assert!(matches!(
            derive_kind_for_tag("IPTC", "ReleaseDate", "digits", Some(8), &[]),
            TagKind::Date
        ));
        assert!(matches!(
            derive_kind_for_tag("IPTC", "ReleaseTime", "string", Some(11), &[]),
            TagKind::Time
        ));
    }

    #[test]
    fn exif_offset_time_tags_are_time_offset() {
        for name in ["OffsetTime", "OffsetTimeOriginal", "OffsetTimeDigitized"] {
            assert!(
                matches!(
                    derive_kind_for_tag("ExifIFD", name, "string", Some(7), &[]),
                    TagKind::TimeOffset
                ),
                "{name} should derive to TimeOffset"
            );
        }
    }

    #[test]
    fn exif_datetime_overrides_preserve_companion_field_kinds() {
        let xml = r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <tag id='306' name='ModifyDate' type='string' count='20' writable='true'>
  <desc lang='en'>Modify Date</desc>
 </tag>
</table>
<table name='EXIF::Exif' g0='EXIF' g1='ExifIFD' g2='Image'>
 <tag id='36867' name='DateTimeOriginal' type='string' count='20' writable='true'>
  <desc lang='en'>Date/Time Original</desc>
 </tag>
 <tag id='36868' name='CreateDate' type='string' count='20' writable='true'>
  <desc lang='en'>Create Date</desc>
 </tag>
 <tag id='36880' name='OffsetTime' type='string' count='7' writable='true'>
  <desc lang='en'>Offset Time</desc>
 </tag>
 <tag id='36881' name='OffsetTimeOriginal' type='string' count='7' writable='true'>
  <desc lang='en'>Offset Time Original</desc>
 </tag>
 <tag id='36882' name='OffsetTimeDigitized' type='string' count='7' writable='true'>
  <desc lang='en'>Offset Time Digitized</desc>
 </tag>
 <tag id='37520' name='SubSecTime' type='string' writable='true'>
  <desc lang='en'>Sub Sec Time</desc>
 </tag>
 <tag id='37521' name='SubSecTimeOriginal' type='string' writable='true'>
  <desc lang='en'>Sub Sec Time Original</desc>
 </tag>
 <tag id='37522' name='SubSecTimeDigitized' type='string' writable='true'>
  <desc lang='en'>Sub Sec Time Digitized</desc>
 </tag>
</table>
</taginfo>"#;
        let r = TagRegistry::from_listx_xml(xml).expect("parse EXIF datetime fixture");

        for (table, tag_id) in [
            ("EXIF::Main", "306"),
            ("EXIF::Exif", "36867"),
            ("EXIF::Exif", "36868"),
        ] {
            let tag = r.lookup(&test_id(table, tag_id)).unwrap();
            assert!(
                matches!(tag.kind, TagKind::DateTime),
                "{table}:{tag_id} should be DateTime"
            );
        }

        for tag_id in ["36880", "36881", "36882"] {
            let tag = r.lookup(&test_id("EXIF::Exif", tag_id)).unwrap();
            assert!(
                matches!(tag.kind, TagKind::TimeOffset),
                "{tag_id} should remain TimeOffset"
            );
        }

        for tag_id in ["37520", "37521", "37522"] {
            let tag = r.lookup(&test_id("EXIF::Exif", tag_id)).unwrap();
            assert!(
                matches!(tag.kind, TagKind::Text),
                "{tag_id} should remain Text"
            );
        }
    }

    #[test]
    fn xmp_datetime_overrides_promote_string_tags_to_datetime() {
        let r = fixture_registry();
        assert!(r.lookup(&test_id("XMP::xmp", "CreateDate")).is_none());
        assert!(r
            .lookup(&test_id("XMP::photoshop", "DateCreated"))
            .is_none());
    }

    #[test]
    fn xmp_rating_is_real() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("XMP::xmp", "Rating")).unwrap();
        assert!(matches!(t.kind, TagKind::Real));
    }

    #[test]
    fn undef_version_strings_promoted_to_text() {
        let mut tags: BTreeMap<SchemaDefinitionId, TagInfo> = BTreeMap::new();
        let id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "36864".into(),
            index: None,
        };
        tags.insert(
            id.clone(),
            TagInfo {
                id: id.clone(),
                group0: Some("EXIF".to_string()),
                group: "ExifIFD".to_string(),
                name: "ExifVersion".to_string(),
                writable: true,
                kind: TagKind::Unknown,
                description: None,
                storage_count: None,
            },
        );
        apply_overrides(&mut tags);
        let t = tags.get(&id).expect("override should keep tag");
        assert!(matches!(t.kind, TagKind::Text));
        assert!(t.writable);
    }

    #[test]
    fn xp_keywords_int8u_byte_array_is_text() {
        let xml = r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <tag id='40094' name='XPKeywords' type='int8u' count='128' writable='true'>
  <desc lang='en'>XP Keywords</desc>
 </tag>
</table>
</taginfo>"#;
        let r = TagRegistry::from_listx_xml(xml).expect("parse XPKeywords fixture");
        let t = r.lookup(&test_id("EXIF::Main", "40094")).unwrap();
        assert!(
            matches!(t.kind, TagKind::Text),
            "XPKeywords must be semantic Text, got {:?}",
            t.kind
        );
    }

    #[test]
    fn all_ifd0_xp_tags_are_text() {
        let r = TagRegistry::from_listx_xml(
            "<?xml version='1.0' encoding='UTF-8'?><taginfo></taginfo>",
        )
        .expect("parse empty fixture");
        for tag_id in [
            "40091", // XPTitle
            "40092", // XPComment
            "40093", // XPAuthor
            "40094", // XPKeywords
            "40095", // XPSubject
        ] {
            assert!(r.lookup(&test_id("EXIF::Main", tag_id)).is_none());
        }
    }

    #[test]
    fn user_comment_undef_is_text() {
        let xml = r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='EXIF::Exif' g0='EXIF' g1='ExifIFD' g2='Image'>
 <tag id='37510' name='UserComment' type='undef' writable='true'>
  <desc lang='en'>User Comment</desc>
 </tag>
</table>
</taginfo>"#;
        let r = TagRegistry::from_listx_xml(xml).expect("parse UserComment fixture");
        let t = r.lookup(&test_id("EXIF::Exif", "37510")).unwrap();
        assert!(
            matches!(t.kind, TagKind::Text),
            "UserComment must be semantic Text, got {:?}",
            t.kind
        );
    }

    #[test]
    fn undef_binary_blobs_demoted_to_binary_and_readonly() {
        let mut tags: BTreeMap<SchemaDefinitionId, TagInfo> = BTreeMap::new();
        let maker_id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "37500".into(),
            index: None,
        };
        tags.insert(
            maker_id.clone(),
            TagInfo {
                id: maker_id.clone(),
                group0: Some("EXIF".to_string()),
                group: "ExifIFD".to_string(),
                name: "MakerNoteCanon".to_string(),
                writable: true,
                kind: TagKind::Unknown,
                description: None,
                storage_count: None,
            },
        );
        let preview_id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "PreviewImage".into(),
            index: None,
        };
        tags.insert(
            preview_id.clone(),
            TagInfo {
                id: preview_id.clone(),
                group0: Some("EXIF".to_string()),
                group: "IFD0".to_string(),
                name: "PreviewImage".to_string(),
                writable: true,
                kind: TagKind::Unknown,
                description: None,
                storage_count: None,
            },
        );
        apply_overrides(&mut tags);
        let mk = tags.get(&maker_id).unwrap();
        assert!(matches!(mk.kind, TagKind::Binary));
        assert!(!mk.writable);
        let pv = tags.get(&preview_id).unwrap();
        assert!(matches!(pv.kind, TagKind::Binary));
        assert!(!pv.writable);
    }

    #[test]
    fn binary_override_does_not_grant_write_when_listx_said_no() {
        let mut tags: BTreeMap<SchemaDefinitionId, TagInfo> = BTreeMap::new();
        let id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "37500".into(),
            index: None,
        };
        tags.insert(
            id.clone(),
            TagInfo {
                id: id.clone(),
                group0: Some("EXIF".to_string()),
                group: "ExifIFD".to_string(),
                name: "MakerNoteCanon".to_string(),
                writable: false,
                kind: TagKind::Unknown,
                description: None,
                storage_count: None,
            },
        );
        apply_overrides(&mut tags);
        assert!(!tags.get(&id).unwrap().writable);
    }

    #[test]
    fn undef_type_is_unknown() {
        let r = fixture_registry();
        let t = r.lookup(&test_id("ReadOnly::Stuff", "Bin")).unwrap();
        assert!(matches!(t.kind, TagKind::Unknown));
        assert!(!t.writable);
    }

    #[test]
    fn missing_tag_returns_none() {
        let r = fixture_registry();
        assert!(r.lookup(&test_id("Nonexistent::Table", "Tag")).is_none());
        assert!(r.lookup(&test_id("XMP::dc", "NotARealField")).is_none());
    }

    #[test]
    fn registry_serde_roundtrip_for_disk_cache() {
        let original = fixture_registry();
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: TagRegistry = serde_json::from_str(&json).expect("deserialize");
        for (table, tag_id) in [
            ("EXIF::Main", "274"),
            ("IPTC::ApplicationRecord", "25"),
            ("XMP::dc", "subject"),
            ("XMP::dc", "description"),
            ("XMP::xmp", "Rating"),
            ("ReadOnly::Stuff", "Bin"),
        ] {
            let id = test_id(table, tag_id);
            let a = original.lookup(&id);
            let b = restored.lookup(&id);
            assert_eq!(a, b, "lookup mismatch after roundtrip for {id:?}");
        }

        // Regions is absent in the fixture registry, but let's check it roundtrips None
        let regions_id = test_id("XMP::mwg-rs", "Regions");
        assert_eq!(original.lookup(&regions_id), None);
        assert_eq!(restored.lookup(&regions_id), None);

        assert_eq!(original.len(), restored.len());
    }

    #[test]
    fn build_cached_applies_overrides() {
        let reg = TagRegistry::build_cached().expect("build_cached failed");
        assert!(!reg.is_empty());
    }

    #[test]
    fn cache_path_sanitises_version_string() {
        let p = cache_path_for("13.57").unwrap();
        assert!(p.to_string_lossy().contains("tag_schema_p11_13.57.json"));
        let p2 = cache_path_for("13/57 weird!").unwrap();
        let s = p2.to_string_lossy().into_owned();
        assert!(s.contains("tag_schema_p11_13_57_weird_.json"));
        assert!(
            !s.contains('/') || s.contains("MediaLibrary"),
            "no stray slashes in version segment"
        );
        assert!(!s.contains(' '));
        assert!(!s.contains('!'));
    }

    #[test]
    fn mwg_regions_is_not_synthesized_without_listx_entry() {
        let r = fixture_registry();
        assert!(r.lookup(&test_id("XMP::mwg-rs", "Regions")).is_none());
    }
}
