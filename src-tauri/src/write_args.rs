//! exiftool argv construction for write-back.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §6.
//!
//! This module produces unambiguous exiftool argv from semantic draft edits and
//! `TagInfo` schema entries.  It is **pure** — no exiftool subprocess, no
//! filesystem — so it is fully unit-testable and the test matrix can be
//! exhaustive.
//!
//! Every value is rendered in ExifTool's raw/computer-readable form and the
//! caller writes the complete batch in one `-n` invocation. The scanner's raw
//! pass is MediaLibrary's canonical semantic source, so write-back must not
//! reinterpret values through ExifTool's display-oriented PrintConv layer.

use crate::draft_edits::{EditIntent, MetadataDraftEdit};
use crate::metadata_draft_target::{MetadataDraftTarget, MetadataDraftTargetError};
use crate::metadata_occurrence::{
    runtime_tag_id_from_family7_group, validate_family1_group, MetadataOccurrence,
    MetadataWriteTarget,
};
use crate::metadata_value::MetadataValue;
#[cfg(test)]
use crate::metadata_value::{DateTimeValue, DateValue, OffsetSign, TimeValue, UtcOffsetValue};
use crate::tag_schema::{EnumRepr, TagInfo, TagKind};

/// Output of `build_args` for one draft edit.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct BuiltArgs {
    /// Arguments for the single raw (`-n`) ExifTool invocation.
    pub args: Vec<String>,
}

impl BuiltArgs {
    pub fn is_empty(&self) -> bool {
        self.args.is_empty()
    }

    /// Merge other into self, preserving argument ordering.
    pub fn extend(&mut self, other: BuiltArgs) {
        self.args.extend(other.args);
    }
}

/// A structured reason that occurrence-aware write argument planning failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataTargetWriteError {
    /// A domain target rule failed. Existing-occurrence validation preserves
    /// its exact freshness reason here.
    TargetValidation(MetadataDraftTargetError),
    /// An existing-occurrence planner was given a new-property target.
    ExistingOccurrenceRequired,
    /// A new-property planner was given an existing-occurrence target.
    NewPropertyRequired,
    /// The supplied schema does not exactly match the new-property target.
    SchemaIdMismatch,
    /// A selector component cannot safely cross the ExifTool argv boundary.
    UnsafeWriteTarget,
    /// The semantic edit value cannot be encoded for this schema.
    ValueEncoding(String),
}

impl std::fmt::Display for MetadataTargetWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TargetValidation(error) => write!(formatter, "target validation failed: {error}"),
            Self::ExistingOccurrenceRequired => {
                formatter.write_str("an existing-occurrence target is required")
            }
            Self::NewPropertyRequired => formatter.write_str("a new-property target is required"),
            Self::SchemaIdMismatch => {
                formatter.write_str("target schema ID does not match the supplied schema")
            }
            Self::UnsafeWriteTarget => {
                formatter.write_str("write-target selector components are unsafe")
            }
            Self::ValueEncoding(error) => write!(formatter, "value encoding failed: {error}"),
        }
    }
}

impl std::error::Error for MetadataTargetWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::TargetValidation(error) => Some(error),
            _ => None,
        }
    }
}

/// Plans a write to one exact existing occurrence after revalidating its
/// persisted target snapshot against a freshly read authoritative occurrence.
///
/// The target-aware single-file writer uses this planner for existing targets.
pub fn build_existing_occurrence_args(
    target: &MetadataDraftTarget,
    fresh_occurrence: &MetadataOccurrence,
    edit: &MetadataDraftEdit,
) -> Result<BuiltArgs, MetadataTargetWriteError> {
    if !target.is_existing_occurrence() {
        return Err(MetadataTargetWriteError::ExistingOccurrenceRequired);
    }
    target
        .validate_existing_occurrence(fresh_occurrence)
        .map_err(MetadataTargetWriteError::TargetValidation)?;

    // Validation above guarantees both values exist and match the persisted
    // schema and selector snapshots exactly.
    let info =
        fresh_occurrence
            .tag_info
            .as_ref()
            .ok_or(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::UnknownSchema,
            ))?;
    let write_target = fresh_occurrence.write_target.as_ref().ok_or(
        MetadataTargetWriteError::TargetValidation(MetadataDraftTargetError::MissingWriteTarget),
    )?;
    let selector = validated_selector(write_target)?;

    build_metadata_args_for_selector(&selector, info, edit)
        .map_err(MetadataTargetWriteError::ValueEncoding)
}

/// Plans schema-driven creation of a property that has no runtime occurrence.
///
/// The target-aware single-file writer uses this planner for new-property targets.
pub fn build_new_property_args(
    target: &MetadataDraftTarget,
    info: &TagInfo,
    edit: &MetadataDraftEdit,
) -> Result<BuiltArgs, MetadataTargetWriteError> {
    if !target.is_new_property() {
        return Err(MetadataTargetWriteError::NewPropertyRequired);
    }
    if target.schema_id() != &info.id {
        return Err(MetadataTargetWriteError::SchemaIdMismatch);
    }
    target
        .validate_new_property(info)
        .map_err(MetadataTargetWriteError::TargetValidation)?;
    let selector = validated_selector(
        target
            .write_target()
            .ok_or(MetadataTargetWriteError::NewPropertyRequired)?,
    )?;

    build_metadata_args_for_selector(&selector, info, edit)
        .map_err(MetadataTargetWriteError::ValueEncoding)
}

/// Constructs the fully family-qualified selector only at the final write
/// boundary. Persisted drafts retain structured components, never a command
/// line argument.
fn validated_selector(target: &MetadataWriteTarget) -> Result<String, MetadataTargetWriteError> {
    let unsafe_group1 = validate_family1_group(&target.group1).is_err();
    let unsafe_group7 = runtime_tag_id_from_family7_group(&target.group7).is_none()
        || target.group7.chars().any(|character| {
            character.is_control() || character.is_whitespace() || matches!(character, '=' | ':')
        });
    let unsafe_tag_name = target.tag_name.is_empty()
        || target
            .tag_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '=' | ':'));
    if unsafe_group1 || unsafe_group7 || unsafe_tag_name {
        return Err(MetadataTargetWriteError::UnsafeWriteTarget);
    }

    Ok(target.selector())
}

fn build_metadata_args_for_selector(
    selector: &str,
    info: &TagInfo,
    edit: &MetadataDraftEdit,
) -> Result<BuiltArgs, String> {
    let tag = selector;

    match edit.intent {
        EditIntent::Delete => Ok(BuiltArgs {
            args: vec![format!("-{}=", tag)],
        }),
        EditIntent::Set => build_metadata_set(tag, Some(info), edit.value.as_ref()),
        EditIntent::ListAdd => build_metadata_list_op(tag, Some(info), edit.value.as_ref(), "+="),
        EditIntent::ListRemove => {
            build_metadata_list_op(tag, Some(info), edit.value.as_ref(), "-=")
        }
    }
}

fn build_metadata_set(
    tag: &str,
    info: Option<&TagInfo>,
    value: Option<&MetadataValue>,
) -> Result<BuiltArgs, String> {
    let kind = info.map(|i| &i.kind);
    match (kind, value) {
        (_, None) | (_, Some(MetadataValue::Null)) => Ok(BuiltArgs {
            args: vec![format!("-{}=", tag)],
        }),
        (_, Some(MetadataValue::Binary)) => Err(format!("{tag} is binary and is not writable")),
        (_, Some(MetadataValue::Unknown { reason, .. })) => Err(format!(
            "{tag} is unparsed and cannot be written{}",
            reason
                .as_ref()
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        )),
        (Some(TagKind::LangAlt), Some(MetadataValue::LangAlt(langs))) => {
            // A LangAlt Set replaces the complete rdf:Alt map. Clear the
            // parent first so languages omitted from the draft are removed,
            // then reconstruct every intended language explicitly.
            let mut args = Vec::with_capacity(langs.len() + 2);
            args.push(format!("-{}=", tag));
            for (lang, value) in langs {
                validate_exiftool_lang_alt_language(lang)?;
                args.push(format!("-{}-{}={}", tag, lang, value));
            }
            if !langs.contains_key("x-default") {
                if let Some(first) = langs.values().next() {
                    args.push(format!("-{}-x-default={}", tag, first));
                }
            }
            Ok(BuiltArgs { args })
        }
        (Some(TagKind::Bag(inner) | TagKind::Seq(inner) | TagKind::Alt(inner)), Some(value)) => {
            build_metadata_list_set(tag, inner, value)
        }
        (Some(TagKind::Struct(_)), Some(MetadataValue::Struct(map))) => Ok(BuiltArgs {
            args: vec![format!("-{}={}", tag, render_metadata_struct(map)?)],
        }),
        (Some(TagKind::Binary), _) => Err(format!("{tag} is binary and is not writable")),
        (
            Some(
                kind @ (TagKind::Integer { .. }
                | TagKind::Real
                | TagKind::Rational
                | TagKind::Boolean
                | TagKind::TimeOffset),
            ),
            Some(value),
        ) => Ok(BuiltArgs {
            args: vec![format!(
                "-{}={}",
                tag,
                render_metadata_scalar_raw(value, Some(kind))?
            )],
        }),
        (
            Some(TagKind::Enum {
                repr: EnumRepr::Integer,
                ..
            }),
            Some(value),
        ) => Ok(BuiltArgs {
            args: vec![format!(
                "-{}={}",
                tag,
                render_metadata_scalar_raw(value, kind)?
            )],
        }),
        (Some(kind @ (TagKind::Date | TagKind::Time | TagKind::DateTime)), Some(value)) => {
            Ok(BuiltArgs {
                args: vec![format!(
                    "-{}={}",
                    tag,
                    render_metadata_value_for_write(value, Some(kind))?
                )],
            })
        }
        (_, Some(MetadataValue::List { .. })) => Err(format!(
            "{tag} is a list value but schema is not a list kind"
        )),
        (_, Some(MetadataValue::Struct(_))) => Err(format!(
            "{tag} is a struct value but schema is not a struct kind"
        )),
        (_, Some(value)) => Ok(BuiltArgs {
            args: vec![format!(
                "-{}={}",
                tag,
                render_metadata_scalar_raw(value, kind)?
            )],
        }),
    }
}

fn build_metadata_list_set(
    tag: &str,
    inner: &TagKind,
    value: &MetadataValue,
) -> Result<BuiltArgs, String> {
    let items: Vec<&MetadataValue> = match value {
        MetadataValue::List { items, .. } => items.iter().collect(),
        other => vec![other],
    };
    let mut args = BuiltArgs {
        args: vec![format!("-{}=", tag)],
    };
    for item in items {
        args.args.push(format!(
            "-{}={}",
            tag,
            render_metadata_scalar_raw(item, Some(inner))?
        ));
    }
    Ok(args)
}

fn build_metadata_list_op(
    tag: &str,
    info: Option<&TagInfo>,
    value: Option<&MetadataValue>,
    op: &str,
) -> Result<BuiltArgs, String> {
    let Some(kind) = info.map(|i| &i.kind) else {
        return match op {
            "-=" => Ok(BuiltArgs {
                args: vec![format!("-{}=", tag)],
            }),
            _ => build_metadata_set(tag, info, value),
        };
    };
    let inner = match kind {
        TagKind::Bag(inner) | TagKind::Seq(inner) | TagKind::Alt(inner) => inner,
        _ => {
            return match op {
                "-=" => Ok(BuiltArgs {
                    args: vec![format!("-{}=", tag)],
                }),
                _ => build_metadata_set(tag, info, value),
            }
        }
    };

    let items: Vec<&MetadataValue> = match value {
        Some(MetadataValue::List { items, .. }) => items.iter().collect(),
        Some(v) => vec![v],
        None => vec![],
    };
    let mut args = BuiltArgs::default();
    for item in items {
        args.args.push(format!(
            "-{}{}{}",
            tag,
            op,
            render_metadata_scalar_raw(item, Some(inner))?
        ));
    }
    Ok(args)
}

fn normalise_storage_string_for_kind(value: &str, kind: Option<&TagKind>) -> String {
    match kind {
        Some(TagKind::Date) => normalise_iptc_date(value),
        Some(TagKind::Time) => normalise_iptc_time(value),
        Some(TagKind::DateTime) => normalise_exif_datetime(value),
        None => value.to_string(),
        Some(_) => value.to_string(),
    }
}

fn normalise_iptc_date(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 10
        && s[0..4].chars().all(|c| c.is_ascii_digit())
        && s[5..7].chars().all(|c| c.is_ascii_digit())
        && s[8..10].chars().all(|c| c.is_ascii_digit())
        && (&s[4..5] == "-" || &s[4..5] == ":")
        && (&s[7..8] == "-" || &s[7..8] == ":")
    {
        return format!("{}:{}:{}", &s[0..4], &s[5..7], &s[8..10]);
    }
    s.to_string()
}

fn normalise_iptc_time(s: &str) -> String {
    let s = s.trim();
    if s.len() < 8 {
        return s.to_string();
    }
    let time = &s[..8];
    if !time[0..2].chars().all(|c| c.is_ascii_digit())
        || &time[2..3] != ":"
        || !time[3..5].chars().all(|c| c.is_ascii_digit())
        || &time[5..6] != ":"
        || !time[6..8].chars().all(|c| c.is_ascii_digit())
    {
        return s.to_string();
    }
    let rest = &s[8..];
    if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) {
        return s.to_string();
    }
    if rest.len() == 5 && (rest.starts_with('+') || rest.starts_with('-')) {
        return format!("{}{}:{}", time, &rest[..3], &rest[3..]);
    }
    if rest.is_empty() {
        return time.to_string();
    }
    s.to_string()
}

fn normalise_exif_datetime(s: &str) -> String {
    let s = s.trim();
    if s.len() < 19 {
        return s.to_string();
    }
    let date = normalise_iptc_date(s);
    if date.len() != 10 {
        return s.to_string();
    }
    let sep = &s[10..11];
    if sep != "T" && sep != " " {
        return s.to_string();
    }
    let time = &s[11..19];
    if time[0..2].chars().all(|c| c.is_ascii_digit())
        && &time[2..3] == ":"
        && time[3..5].chars().all(|c| c.is_ascii_digit())
        && &time[5..6] == ":"
        && time[6..8].chars().all(|c| c.is_ascii_digit())
    {
        format!("{} {}", date, time)
    } else {
        s.to_string()
    }
}

// Value rendering is isolated from selector and argv planning.
mod render;
pub use render::render_metadata_value_for_write;
use render::{
    render_metadata_scalar_raw, render_metadata_struct, validate_exiftool_lang_alt_language,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
    use crate::metadata_value::{ListKind, RationalValue};
    use crate::tag_schema::{EnumOption, EnumRepr, SchemaDefinitionId};
    use std::collections::BTreeMap;

    fn info(kind: TagKind) -> TagInfo {
        info_named("X", "Y", kind)
    }

    fn info_named(group: &str, name: &str, kind: TagKind) -> TagInfo {
        TagInfo {
            id: SchemaDefinitionId {
                table: format!("Test::{group}"),
                tag_id: name.to_string(),
                index: None,
            },
            group0: Some("EXIF".to_string()),
            group: group.to_string(),
            name: name.to_string(),
            writable: true,
            kind,
            description: None,
            storage_count: None,
        }
    }

    fn build_new_property_fixture_args(
        group: &str,
        tag_name: &str,
        template: &TagInfo,
        edit: &MetadataDraftEdit,
    ) -> Result<BuiltArgs, String> {
        let mut info = template.clone();
        info.group = group.to_string();
        info.name = tag_name.to_string();
        let target = MetadataDraftTarget::NewProperty {
            schema_id: info.id.clone(),
            write_target: MetadataWriteTarget {
                group1: info.group.clone(),
                group7: crate::metadata_occurrence::family7_group_from_schema_id(&info.id),
                tag_name: info.name.clone(),
            },
        };
        super::build_new_property_args(&target, &info, edit).map_err(|error| error.to_string())
    }

    fn metadata_set(v: MetadataValue) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(v),
            intent: EditIntent::Set,
        }
    }
    fn metadata_delete() -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: None,
            intent: EditIntent::Delete,
        }
    }
    fn metadata_list_add(v: MetadataValue) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(v),
            intent: EditIntent::ListAdd,
        }
    }
    fn metadata_list_remove(v: MetadataValue) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(v),
            intent: EditIntent::ListRemove,
        }
    }
    fn text(value: &str) -> MetadataValue {
        MetadataValue::Text(value.to_string())
    }
    fn bag_text(items: &[&str]) -> MetadataValue {
        MetadataValue::List {
            list_kind: ListKind::Bag,
            items: items.iter().map(|item| text(item)).collect(),
        }
    }
    fn seq_text(items: &[&str]) -> MetadataValue {
        MetadataValue::List {
            list_kind: ListKind::Seq,
            items: items.iter().map(|item| text(item)).collect(),
        }
    }

    #[test]
    fn set_text_yields_single_text_arg() {
        let i = info(TagKind::Text);
        let args =
            build_new_property_fixture_args("XMP-dc", "Title", &i, &metadata_set(text("hi")))
                .unwrap();
        assert_eq!(args.args, vec!["-1XMP-dc:7ID-Y:Title=hi"]);
    }

    #[test]
    fn gps_version_id_text_uses_spaced_raw_value() {
        let i = info_named("GPS", "GPSVersionID", TagKind::Text);
        let args = build_new_property_fixture_args(
            "GPS",
            "GPSVersionID",
            &i,
            &metadata_set(text("2 3 0 0")),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec!["-1GPS:7ID-GPSVersionID:GPSVersionID=2 3 0 0"]
        );
    }

    #[test]
    fn set_integer_yields_raw_arg() {
        let i = info(TagKind::Integer {
            min: None,
            max: None,
        });
        let args = build_new_property_fixture_args(
            "XMP-xmp",
            "Rating",
            &i,
            &metadata_set(MetadataValue::Integer(5)),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1XMP-xmp:7ID-Y:Rating=5"]);
    }

    #[test]
    fn set_boolean_uses_raw_1_0_representation() {
        let i = info(TagKind::Boolean);
        let args = build_new_property_fixture_args(
            "XMP-xmpRights",
            "Marked",
            &i,
            &metadata_set(MetadataValue::Bool(true)),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1XMP-xmpRights:7ID-Y:Marked=1"]);
    }

    #[test]
    fn set_enum_integer_uses_raw_code() {
        let i = info(TagKind::Enum {
            repr: EnumRepr::Integer,
            options: vec![
                EnumOption {
                    code: "1".into(),
                    label: "Horizontal".into(),
                },
                EnumOption {
                    code: "6".into(),
                    label: "Rotate 90 CW".into(),
                },
            ],
        });
        let args = build_new_property_fixture_args(
            "IFD0",
            "Orientation",
            &i,
            &metadata_set(MetadataValue::Integer(6)),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1IFD0:7ID-Y:Orientation=6"]);
    }

    #[test]
    fn set_bag_emits_clear_then_repeated_args() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Subject",
            &i,
            &metadata_set(bag_text(&["beach", "sunset"])),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec![
                "-1XMP-dc:7ID-Y:Subject=",
                "-1XMP-dc:7ID-Y:Subject=beach",
                "-1XMP-dc:7ID-Y:Subject=sunset"
            ]
        );
    }

    #[test]
    fn set_seq_emits_clear_then_ordered_args() {
        let i = info(TagKind::Seq(Box::new(TagKind::Text)));
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Creator",
            &i,
            &metadata_set(seq_text(&["Ada", "Bea"])),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec![
                "-1XMP-dc:7ID-Y:Creator=",
                "-1XMP-dc:7ID-Y:Creator=Ada",
                "-1XMP-dc:7ID-Y:Creator=Bea"
            ]
        );
    }

    #[test]
    fn set_bag_with_scalar_treats_as_single_element() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args =
            build_new_property_fixture_args("XMP-dc", "Subject", &i, &metadata_set(text("only")))
                .unwrap();
        assert_eq!(
            args.args,
            vec!["-1XMP-dc:7ID-Y:Subject=", "-1XMP-dc:7ID-Y:Subject=only"]
        );
    }

    #[test]
    fn set_langalt_with_object_emits_per_lang_args() {
        let i = info(TagKind::LangAlt);
        let mut langs = BTreeMap::new();
        langs.insert("x-default".to_string(), "Hi".to_string());
        langs.insert("en".to_string(), "Hi".to_string());
        langs.insert("fr".to_string(), "Salut".to_string());
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Description",
            &i,
            &metadata_set(MetadataValue::LangAlt(langs)),
        )
        .unwrap();
        // BTreeMap iteration order is alphabetic; assert presence not order.
        assert!(args
            .args
            .iter()
            .any(|a| a == "-1XMP-dc:7ID-Y:Description-x-default=Hi"));
        assert!(args
            .args
            .iter()
            .any(|a| a == "-1XMP-dc:7ID-Y:Description-en=Hi"));
        assert!(args
            .args
            .iter()
            .any(|a| a == "-1XMP-dc:7ID-Y:Description-fr=Salut"));
        assert_eq!(args.args[0], "-1XMP-dc:7ID-Y:Description=");
        assert_eq!(args.args.len(), 4);
    }

    #[test]
    fn set_langalt_without_xdefault_synthesises_one() {
        let i = info(TagKind::LangAlt);
        let mut langs = BTreeMap::new();
        langs.insert("en".to_string(), "Hello".to_string());
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Description",
            &i,
            &metadata_set(MetadataValue::LangAlt(langs)),
        )
        .unwrap();
        assert!(args
            .args
            .iter()
            .any(|a| a == "-1XMP-dc:7ID-Y:Description-en=Hello"));
        assert!(args
            .args
            .iter()
            .any(|a| a == "-1XMP-dc:7ID-Y:Description-x-default=Hello"));
        assert_eq!(args.args[0], "-1XMP-dc:7ID-Y:Description=");
        assert_eq!(args.args.len(), 3);
    }

    #[test]
    fn set_empty_langalt_clears_the_complete_property() {
        let i = info(TagKind::LangAlt);
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Description",
            &i,
            &metadata_set(MetadataValue::LangAlt(BTreeMap::new())),
        )
        .unwrap();

        assert_eq!(args.args, vec!["-1XMP-dc:7ID-Y:Description="]);
    }

    #[test]
    fn delete_emits_empty_assignment() {
        let i = info(TagKind::Text);
        let args =
            build_new_property_fixture_args("XMP-dc", "Title", &i, &metadata_delete()).unwrap();
        assert_eq!(args.args, vec!["-1XMP-dc:7ID-Y:Title="]);
    }

    #[test]
    fn listadd_on_bag_emits_plus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Subject",
            &i,
            &metadata_list_add(bag_text(&["a", "b"])),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec!["-1XMP-dc:7ID-Y:Subject+=a", "-1XMP-dc:7ID-Y:Subject+=b"]
        );
    }

    #[test]
    fn listremove_on_bag_emits_minus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Subject",
            &i,
            &metadata_list_remove(text("old")),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1XMP-dc:7ID-Y:Subject-=old"]);
    }

    #[test]
    fn list_op_on_non_list_tag_degrades_safely() {
        let i = info(TagKind::Text);
        // ListAdd on a Text tag becomes a Set.
        let args =
            build_new_property_fixture_args("XMP-dc", "Title", &i, &metadata_list_add(text("hi")))
                .unwrap();
        assert_eq!(args.args, vec!["-1XMP-dc:7ID-Y:Title=hi"]);
        // ListRemove on a Text tag becomes a Delete.
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Title",
            &i,
            &metadata_list_remove(text("hi")),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1XMP-dc:7ID-Y:Title="]);
    }

    #[test]
    fn listadd_list_payload_on_non_list_tag_is_rejected() {
        let mut occurrence = target_test_occurrence("XMP-dc");
        occurrence.tag_info.as_mut().unwrap().kind = TagKind::Text;
        let target = existing_target(&occurrence);
        let edit = metadata_list_add(bag_text(&["new"]));

        let error = build_existing_occurrence_args(&target, &occurrence, &edit).unwrap_err();

        assert!(matches!(error, MetadataTargetWriteError::ValueEncoding(_)));
        assert!(error
            .to_string()
            .contains("is a list value but schema is not a list kind"));
    }

    #[test]
    fn scalar_list_fallback_contract_covers_missing_values() {
        let i = info(TagKind::Text);
        let add = MetadataDraftEdit {
            value: None,
            intent: EditIntent::ListAdd,
        };
        let remove = MetadataDraftEdit {
            value: None,
            intent: EditIntent::ListRemove,
        };

        let add_args = build_new_property_fixture_args("XMP-dc", "Title", &i, &add).unwrap();
        let remove_args = build_new_property_fixture_args("XMP-dc", "Title", &i, &remove).unwrap();
        assert_eq!(add_args.args, vec!["-1XMP-dc:7ID-Y:Title="]);
        assert_eq!(remove_args.args, vec!["-1XMP-dc:7ID-Y:Title="]);
    }

    #[test]
    fn binary_schema_is_rejected_before_argument_rendering() {
        let info = info(TagKind::Binary);
        let error =
            build_new_property_fixture_args("Thumbnail", "Bin", &info, &metadata_set(text("x")))
                .unwrap_err();
        assert!(error.contains("read-only"));
    }

    #[test]
    fn unsafe_new_property_selector_is_rejected() {
        let i = info(TagKind::Text);
        let error =
            build_new_property_fixture_args("bad\nname", "Tag", &i, &metadata_set(text("x")))
                .unwrap_err();
        assert!(error.contains("invalid") || error.contains("unsafe"));
        let error =
            build_new_property_fixture_args("", "", &i, &metadata_set(text("x"))).unwrap_err();
        assert!(error.contains("invalid") || error.contains("unsafe"));
    }

    #[test]
    fn exact_identity_and_selected_tag_info_must_match() {
        let selected = info_named("XMP-dc", "Title", TagKind::Text);
        let target = MetadataDraftTarget::NewProperty {
            schema_id: SchemaDefinitionId {
                table: "Other::dc".into(),
                tag_id: selected.id.tag_id.clone(),
                index: None,
            },
            write_target: MetadataWriteTarget {
                group1: selected.group.clone(),
                group7: "ID-Title".into(),
                tag_name: selected.name.clone(),
            },
        };
        assert_eq!(
            super::build_new_property_args(&target, &selected, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::SchemaIdMismatch)
        );
    }

    #[test]
    fn write_selector_is_derived_from_exact_selected_tag_info() {
        let selected = info_named("XMP-dc", "Title", TagKind::Text);
        let target = new_property_target(&selected);
        let args = super::build_new_property_args(&target, &selected, &metadata_set(text("value")))
            .unwrap();
        assert_eq!(args.args, vec!["-1XMP-dc:7ID-Title:Title=value"]);
    }

    #[test]
    fn exact_read_only_definition_is_rejected() {
        let mut selected = info_named("File", "BMPVersion", TagKind::Text);
        selected.writable = false;
        let target = MetadataDraftTarget::NewProperty {
            schema_id: selected.id.clone(),
            write_target: MetadataWriteTarget {
                group1: selected.group.clone(),
                group7: crate::metadata_occurrence::family7_group_from_schema_id(&selected.id),
                tag_name: selected.name.clone(),
            },
        };
        assert_eq!(
            super::build_new_property_args(&target, &selected, &metadata_set(text("Windows V3")),),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::ReadOnlySchema,
            ))
        );
    }

    #[test]
    fn float_renders_decimal_in_raw_mode() {
        let i = info(TagKind::Real);
        let args = build_new_property_fixture_args(
            "GPS",
            "GPSAltitude",
            &i,
            &metadata_set(MetadataValue::Real(123.45)),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1GPS:7ID-Y:GPSAltitude=123.45"]);
    }

    #[test]
    fn gps_reals_render_as_scalar_raw_args() {
        for (group, tag_name, value, expected) in [
            (
                "GPS",
                "GPSLatitude",
                52.2037391662611,
                "-1GPS:7ID-Y:GPSLatitude=52.2037391662611",
            ),
            (
                "GPS",
                "GPSLongitude",
                1.236557,
                "-1GPS:7ID-Y:GPSLongitude=1.236557",
            ),
            ("GPS", "GPSAltitude", 123.4, "-1GPS:7ID-Y:GPSAltitude=123.4"),
        ] {
            let i = info(TagKind::Real);
            let args = build_new_property_fixture_args(
                group,
                tag_name,
                &i,
                &metadata_set(MetadataValue::Real(value)),
            )
            .unwrap();
            assert_eq!(args.args, vec![expected]);
        }
    }

    #[test]
    fn datetime_uses_raw_representation() {
        // The literal YYYY:MM:DD HH:MM:SS±ZZ:ZZ form bypasses PrintConv
        // re-parsing with the rest of the single raw write.
        let i = info(TagKind::DateTime);
        let args = build_new_property_fixture_args(
            "ExifIFD",
            "DateTimeOriginal",
            &i,
            &metadata_set(MetadataValue::DateTime(DateTimeValue {
                date: DateValue {
                    year: 2026,
                    month: 5,
                    day: 15,
                },
                time: TimeValue {
                    hour: 10,
                    minute: 30,
                    second: 0,
                    subsecond: None,
                    offset: None,
                },
            })),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec!["-1ExifIFD:7ID-Y:DateTimeOriginal=2026:05:15 10:30:00"]
        );
    }

    #[test]
    fn ai_generated_at_datetime_uses_raw_representation_with_offset() {
        let i = info_named("XMP-mlib", "AIGeneratedAt", TagKind::DateTime);
        let args = build_new_property_fixture_args(
            "XMP-mlib",
            "AIGeneratedAt",
            &i,
            &metadata_set(MetadataValue::DateTime(DateTimeValue {
                date: DateValue {
                    year: 2026,
                    month: 7,
                    day: 6,
                },
                time: TimeValue {
                    hour: 21,
                    minute: 43,
                    second: 8,
                    subsecond: None,
                    offset: Some(UtcOffsetValue {
                        sign: OffsetSign::Plus,
                        hours: 1,
                        minutes: 0,
                    }),
                },
            })),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec!["-1XMP-mlib:7ID-AIGeneratedAt:AIGeneratedAt=2026:07:06 21:43:08+01:00"]
        );
    }

    #[test]
    fn iptc_date_renders_storage_format() {
        let i = info_named("IPTC", "DateCreated", TagKind::Date);
        let args = build_new_property_fixture_args(
            "IPTC",
            "DateCreated",
            &i,
            &metadata_set(MetadataValue::Date(DateValue {
                year: 2026,
                month: 5,
                day: 15,
            })),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec!["-1IPTC:7ID-DateCreated:DateCreated=2026:05:15"]
        );
    }

    #[test]
    fn iptc_time_without_offset_stays_offsetless() {
        let i = info_named("IPTC", "TimeCreated", TagKind::Time);
        let args = build_new_property_fixture_args(
            "IPTC",
            "TimeCreated",
            &i,
            &metadata_set(MetadataValue::Time(TimeValue {
                hour: 10,
                minute: 30,
                second: 0,
                subsecond: None,
                offset: None,
            })),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec!["-1IPTC:7ID-TimeCreated:TimeCreated=10:30:00"]
        );
    }

    #[test]
    fn metadata_time_without_offset_renders_without_offset() {
        let value = MetadataValue::Time(TimeValue {
            hour: 10,
            minute: 56,
            second: 5,
            subsecond: None,
            offset: None,
        });
        assert_eq!(
            render_metadata_value_for_write(&value, Some(&TagKind::Time)).unwrap(),
            "10:56:05"
        );
    }

    #[test]
    fn metadata_time_with_offset_preserves_offset() {
        let value = MetadataValue::Time(TimeValue {
            hour: 10,
            minute: 56,
            second: 5,
            subsecond: None,
            offset: Some(UtcOffsetValue {
                sign: OffsetSign::Plus,
                hours: 1,
                minutes: 0,
            }),
        });
        assert_eq!(
            render_metadata_value_for_write(&value, Some(&TagKind::Time)).unwrap(),
            "10:56:05+01:00"
        );
    }

    #[test]
    fn metadata_writer_uses_no_current_local_time_for_offsetless_time() {
        let value = MetadataValue::Time(TimeValue {
            hour: 10,
            minute: 56,
            second: 5,
            subsecond: None,
            offset: None,
        });
        let rendered = render_metadata_value_for_write(&value, Some(&TagKind::Time)).unwrap();
        assert!(!rendered.contains('+'));
        assert!(!rendered[8..].contains('-'));
        assert_eq!(rendered, "10:56:05");
    }

    #[test]
    fn semantic_writer_never_comma_joins_text_lists() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Subject",
            &i,
            &metadata_set(MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![
                    MetadataValue::Text("beach".into()),
                    MetadataValue::Text("sunset".into()),
                ],
            }),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec![
                "-1XMP-dc:7ID-Y:Subject=",
                "-1XMP-dc:7ID-Y:Subject=beach",
                "-1XMP-dc:7ID-Y:Subject=sunset"
            ]
        );
        assert!(!args.args.iter().any(|arg| arg.contains("beach, sunset")));
    }

    #[test]
    fn semantic_writer_handles_alt_lists() {
        let i = info(TagKind::Alt(Box::new(TagKind::Text)));
        let args = build_new_property_fixture_args(
            "XMP-dc",
            "Title",
            &i,
            &metadata_set(MetadataValue::List {
                list_kind: ListKind::Alt,
                items: vec![
                    MetadataValue::Text("one".into()),
                    MetadataValue::Text("two".into()),
                ],
            }),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec![
                "-1XMP-dc:7ID-Y:Title=",
                "-1XMP-dc:7ID-Y:Title=one",
                "-1XMP-dc:7ID-Y:Title=two"
            ]
        );
    }

    #[test]
    fn semantic_writer_handles_numeric_lists_in_raw_mode() {
        let i = info(TagKind::Bag(Box::new(TagKind::Integer {
            min: None,
            max: None,
        })));
        let args = build_new_property_fixture_args(
            "X",
            "Numbers",
            &i,
            &metadata_set(MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![MetadataValue::Integer(1), MetadataValue::Integer(2)],
            }),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec![
                "-1X:7ID-Y:Numbers=",
                "-1X:7ID-Y:Numbers=1",
                "-1X:7ID-Y:Numbers=2"
            ]
        );
    }

    #[test]
    fn semantic_writer_renders_exact_rational() {
        let i = info(TagKind::Rational);
        let args = build_new_property_fixture_args(
            "EXIF",
            "ExposureTime",
            &i,
            &metadata_set(MetadataValue::Rational(
                crate::metadata_value::RationalValue {
                    numerator: 1,
                    denominator: 250,
                },
            )),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1EXIF:7ID-Y:ExposureTime=1/250"]);
    }

    #[test]
    fn semantic_writer_blocks_unsupported_schemas_and_unparsed_values() {
        let binary = info(TagKind::Binary);
        let error = build_new_property_fixture_args(
            "File",
            "PreviewImage",
            &binary,
            &metadata_set(MetadataValue::Binary),
        )
        .unwrap_err();
        assert!(error.contains("read-only"));

        let text = info(TagKind::Text);
        let error = build_new_property_fixture_args(
            "X",
            "Bad",
            &text,
            &metadata_set(MetadataValue::Unknown {
                expected: Some(TagKind::Text),
                raw: serde_json::json!({"bad": true}),
                reason: Some("malformed".into()),
            }),
        )
        .unwrap_err();
        assert!(error.contains("unparsed"));
    }

    #[test]
    fn rational_uses_raw_representation() {
        let i = info(TagKind::Rational);
        let args = build_new_property_fixture_args(
            "EXIF",
            "ExposureTime",
            &i,
            &metadata_set(MetadataValue::Rational(
                crate::metadata_value::RationalValue {
                    numerator: 1,
                    denominator: 250,
                },
            )),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1EXIF:7ID-Y:ExposureTime=1/250"]);
    }

    // ── Phase 8 fix: struct argv uses exiftool -struct syntax, not JSON ──

    #[test]
    fn struct_render_uses_brace_syntax_not_json() {
        let mut inner = BTreeMap::new();
        inner.insert("Name".to_string(), text("John"));
        inner.insert("Type".to_string(), text("Face"));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_new_property_fixture_args(
            "XMP-mwg-rs",
            "Region",
            &i,
            &metadata_set(MetadataValue::Struct(inner)),
        )
        .unwrap();
        // Brace form, not JSON.  Field ordering is alphabetic via BTreeMap.
        assert_eq!(
            args.args,
            vec!["-1XMP-mwg-rs:7ID-Y:Region={Name=John,Type=Face}"]
        );
        // Critically: should NOT contain JSON quotes.
        assert!(
            !args.args[0].contains("\""),
            "argv must not be JSON: {:?}",
            args.args
        );
    }

    #[test]
    fn struct_render_handles_nested_object_and_list() {
        let mut area = BTreeMap::new();
        area.insert("X".to_string(), MetadataValue::Real(0.5));
        area.insert("Y".to_string(), MetadataValue::Real(0.5));
        let mut region = BTreeMap::new();
        region.insert("Area".to_string(), MetadataValue::Struct(area));
        region.insert("Names".to_string(), bag_text(&["a", "b"]));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_new_property_fixture_args(
            "X",
            "R",
            &i,
            &metadata_set(MetadataValue::Struct(region)),
        )
        .unwrap();
        assert_eq!(
            args.args,
            vec!["-1X:7ID-Y:R={Area={X=0.5,Y=0.5},Names=[a,b]}"]
        );
    }

    #[test]
    fn struct_render_uses_exiftool_pipe_escaping_for_field_values_and_list_items() {
        let o = BTreeMap::from([
            (
                "Field".to_string(),
                text(" Student Recruitment, Marketing | West } [Level=1]\\Desk"),
            ),
            ("LeadingBrace".to_string(), text("{not a nested structure")),
            (
                "List".to_string(),
                MetadataValue::List {
                    list_kind: ListKind::Bag,
                    items: vec![
                        text("[first, item]"),
                        text("pipe | and } is not the list terminator"),
                    ],
                },
            ),
        ]);
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args =
            build_new_property_fixture_args("X", "S", &i, &metadata_set(MetadataValue::Struct(o)))
                .unwrap();
        assert_eq!(
            args.args,
            vec![
                r"-1X:7ID-Y:S={Field=| Student Recruitment|, Marketing || West |} [Level=1]\Desk,LeadingBrace=|{not a nested structure,List=[|[first|, item|],pipe || and } is not the list terminator]}"
            ]
        );
    }

    #[test]
    fn struct_render_expands_nested_lang_alt_to_exiftool_sibling_fields() {
        let value = MetadataValue::Struct(BTreeMap::from([
            ("City".into(), text("Cambridge")),
            (
                "LocationName".into(),
                MetadataValue::LangAlt(BTreeMap::from([
                    ("fr".into(), "Nom, français".into()),
                    ("x-default".into(), "Default | name".into()),
                    ("zh-Hant".into(), "繁體名稱".into()),
                ])),
            ),
        ]));

        let rendered = render_metadata_struct(match &value {
            MetadataValue::Struct(fields) => fields,
            _ => unreachable!(),
        })
        .unwrap();

        assert_eq!(
            rendered,
            "{City=Cambridge,LocationName=Default || name,LocationName-fr=Nom|, français,LocationName-zh-Hant=繁體名稱}"
        );
    }

    #[test]
    fn struct_render_keeps_lang_alts_attached_to_each_repeated_struct() {
        let value = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![
                MetadataValue::Struct(BTreeMap::from([
                    ("City".into(), text("Cambridge")),
                    (
                        "LocationName".into(),
                        MetadataValue::LangAlt(BTreeMap::from([
                            ("fr".into(), "Cambridge français".into()),
                            ("x-default".into(), "Cambridge default".into()),
                        ])),
                    ),
                ])),
                MetadataValue::Struct(BTreeMap::from([
                    ("City".into(), text("York")),
                    (
                        "LocationName".into(),
                        MetadataValue::LangAlt(BTreeMap::from([
                            ("fr".into(), "York français".into()),
                            ("x-default".into(), "York default".into()),
                        ])),
                    ),
                ])),
            ],
        };
        let info = info(TagKind::Bag(Box::new(TagKind::Struct(BTreeMap::new()))));

        let args = build_new_property_fixture_args(
            "XMP-iptcExt",
            "LocationCreated",
            &info,
            &metadata_set(value),
        )
        .unwrap();

        assert_eq!(
            args.args,
            vec![
                "-1XMP-iptcExt:7ID-Y:LocationCreated=",
                "-1XMP-iptcExt:7ID-Y:LocationCreated={City=Cambridge,LocationName=Cambridge default,LocationName-fr=Cambridge français}",
                "-1XMP-iptcExt:7ID-Y:LocationCreated={City=York,LocationName=York default,LocationName-fr=York français}",
            ]
        );
    }

    #[test]
    fn struct_render_rejects_invalid_language_and_expanded_field_collision() {
        let invalid_language = BTreeMap::from([(
            "LocationName".into(),
            MetadataValue::LangAlt(BTreeMap::from([("fr,City=Bad".into(), "value".into())])),
        )]);
        assert!(render_metadata_struct(&invalid_language)
            .unwrap_err()
            .contains("invalid ExifTool language"));

        let collision = BTreeMap::from([
            (
                "LocationName".into(),
                MetadataValue::LangAlt(BTreeMap::from([("fr".into(), "one".into())])),
            ),
            ("LocationName-fr".into(), text("two")),
        ]);
        assert!(render_metadata_struct(&collision)
            .unwrap_err()
            .contains("duplicate ExifTool structure field"));
    }

    #[test]
    fn struct_render_rejects_ambiguous_field_names() {
        for field_name in ["", "two words", "name,value", "name=value", "name|value"] {
            let value =
                MetadataValue::Struct(BTreeMap::from([(field_name.to_string(), text("value"))]));
            let error = render_metadata_struct(match &value {
                MetadataValue::Struct(map) => map,
                _ => unreachable!(),
            })
            .unwrap_err();
            assert!(error.contains("field name"), "{field_name:?}: {error}");
        }
    }

    #[test]
    fn struct_render_empty_object_and_list() {
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_new_property_fixture_args(
            "X",
            "S",
            &i,
            &metadata_set(MetadataValue::Struct(BTreeMap::new())),
        )
        .unwrap();
        assert_eq!(args.args, vec!["-1X:7ID-Y:S={}"]);
    }

    #[test]
    fn builtargs_extend_preserves_argument_order() {
        let mut a = BuiltArgs {
            args: vec!["-A=1".into(), "-B=x".into()],
        };
        let b = BuiltArgs {
            args: vec!["-C=2".into(), "-D=y".into()],
        };
        a.extend(b);
        assert_eq!(a.args, vec!["-A=1", "-B=x", "-C=2", "-D=y"]);
    }

    fn target_test_info(index: Option<u32>) -> TagInfo {
        TagInfo {
            id: SchemaDefinitionId {
                table: "SchemaTableMustNotBeUsed".to_owned(),
                tag_id: "SchemaTagIdMustNotBeUsed".to_owned(),
                index,
            },
            group0: Some("EXIF".to_owned()),
            group: "SchemaGroupMustNotBeUsed".to_owned(),
            name: "FriendlyNameMustNotBeUsed".to_owned(),
            writable: true,
            kind: TagKind::Text,
            description: Some("Friendly description must not be used".to_owned()),
            storage_count: None,
        }
    }

    fn target_test_occurrence(group1: &str) -> MetadataOccurrence {
        let tag_info = target_test_info(None);
        MetadataOccurrence {
            id: MetadataOccurrenceId {
                document: None,
                path: format!("Family5PathMustNotBeUsed-{group1}"),
                runtime_tag_id: "Family7TagIdMustNotBeUsed".to_owned(),
                tag_id_scope: crate::metadata_occurrence::RuntimeTagIdScope {
                    table: "WrappedTableMustNotBeUsed".to_owned(),
                    tag_id: "WrappedTagIdMustNotBeUsed".to_owned(),
                    index: Some(7),
                },
                copy: 4,
            },
            schema_id: tag_info.id.clone(),
            value: text("old"),
            tag_info: Some(tag_info),
            observed_selector: Some(crate::metadata_occurrence::MetadataObservedSelector {
                group1: group1.to_owned(),
                group7: "ID-Family7TagIdMustNotBeUsed".to_owned(),
                tag_name: "XResolution".to_owned(),
            }),
            write_target: Some(MetadataWriteTarget {
                group1: group1.to_owned(),
                group7: "ID-Family7TagIdMustNotBeUsed".to_owned(),
                tag_name: "XResolution".to_owned(),
            }),
        }
    }

    fn existing_target(occurrence: &MetadataOccurrence) -> MetadataDraftTarget {
        MetadataDraftTarget::from_existing_occurrence(occurrence).unwrap()
    }

    fn new_property_target(info: &TagInfo) -> MetadataDraftTarget {
        MetadataDraftTarget::from_new_property(info).unwrap()
    }

    #[test]
    fn existing_writable_occurrence_uses_exact_ifd0_runtime_selector() {
        let occurrence = target_test_occurrence("IFD0");
        let target = existing_target(&occurrence);

        assert_eq!(
            build_existing_occurrence_args(&target, &occurrence, &metadata_set(text("value")))
                .unwrap()
                .args,
            vec!["-1IFD0:7ID-Family7TagIdMustNotBeUsed:XResolution=value"]
        );
    }

    #[test]
    fn existing_ifd1_selector_ignores_schema_and_friendly_identity_fields() {
        let occurrence = target_test_occurrence("IFD1");
        let target = existing_target(&occurrence);
        let args =
            build_existing_occurrence_args(&target, &occurrence, &metadata_set(text("value")))
                .unwrap();

        assert_eq!(
            args.args,
            vec!["-1IFD1:7ID-Family7TagIdMustNotBeUsed:XResolution=value"]
        );
        for forbidden in [
            "SchemaGroupMustNotBeUsed",
            "FriendlyNameMustNotBeUsed",
            "SchemaTableMustNotBeUsed",
            "SchemaTagIdMustNotBeUsed",
            "Family5PathMustNotBeUsed",
            "Copy4",
        ] {
            assert!(!args.args[0].contains(forbidden));
        }
    }

    #[test]
    fn existing_shared_schema_occurrences_keep_distinct_runtime_selectors() {
        let ifd0 = target_test_occurrence("IFD0");
        let mut ifd1 = target_test_occurrence("IFD1");
        ifd1.tag_info = ifd0.tag_info.clone();
        let edit = metadata_set(text("value"));

        let ifd0_args =
            build_existing_occurrence_args(&existing_target(&ifd0), &ifd0, &edit).unwrap();
        let ifd1_args =
            build_existing_occurrence_args(&existing_target(&ifd1), &ifd1, &edit).unwrap();

        assert_eq!(ifd0.tag_info, ifd1.tag_info);
        assert_eq!(
            ifd0_args.args,
            vec!["-1IFD0:7ID-Family7TagIdMustNotBeUsed:XResolution=value"]
        );
        assert_eq!(
            ifd1_args.args,
            vec!["-1IFD1:7ID-Family7TagIdMustNotBeUsed:XResolution=value"]
        );
        assert_ne!(ifd0_args, ifd1_args);
    }

    #[test]
    fn existing_occurrence_id_mismatch_rejects_before_value_encoding() {
        let original = target_test_occurrence("IFD0");
        let target = existing_target(&original);
        let mut fresh = original;
        fresh.id.copy += 1;

        assert_eq!(
            build_existing_occurrence_args(&target, &fresh, &metadata_set(MetadataValue::Binary),),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::OccurrenceIdMismatch
            ))
        );
    }

    #[test]
    fn existing_schema_id_mismatch_is_preserved_structurally() {
        let original = target_test_occurrence("IFD0");
        let target = existing_target(&original);
        let mut fresh = original;
        fresh.tag_info.as_mut().unwrap().id.index = Some(0);

        assert_eq!(
            build_existing_occurrence_args(&target, &fresh, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::SchemaIdMismatch
            ))
        );
    }

    #[test]
    fn existing_missing_fresh_schema_is_rejected() {
        let original = target_test_occurrence("IFD0");
        let target = existing_target(&original);
        let mut fresh = original;
        fresh.tag_info = None;

        assert_eq!(
            build_existing_occurrence_args(&target, &fresh, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::UnknownSchema
            ))
        );
    }

    #[test]
    fn existing_fresh_read_only_schema_is_rejected() {
        let original = target_test_occurrence("IFD0");
        let target = existing_target(&original);
        let mut fresh = original;
        fresh.tag_info.as_mut().unwrap().writable = false;

        assert_eq!(
            build_existing_occurrence_args(&target, &fresh, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::ReadOnlySchema
            ))
        );
    }

    #[test]
    fn existing_missing_fresh_write_target_is_rejected() {
        let original = target_test_occurrence("IFD0");
        let target = existing_target(&original);
        let mut fresh = original;
        fresh.write_target = None;

        assert_eq!(
            build_existing_occurrence_args(&target, &fresh, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::MissingWriteTarget
            ))
        );
    }

    #[test]
    fn existing_changed_fresh_write_target_is_rejected() {
        let original = target_test_occurrence("IFD0");
        let target = existing_target(&original);
        let mut fresh = original;
        fresh.write_target.as_mut().unwrap().group1 = "IFD1".to_owned();

        assert_eq!(
            build_existing_occurrence_args(&target, &fresh, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::WriteTargetMismatch
            ))
        );
    }

    #[test]
    fn existing_builder_rejects_new_property_target() {
        let occurrence = target_test_occurrence("IFD0");
        let target = new_property_target(occurrence.tag_info.as_ref().unwrap());

        assert_eq!(
            build_existing_occurrence_args(&target, &occurrence, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::ExistingOccurrenceRequired)
        );
    }

    #[test]
    fn existing_builder_rejects_every_unsafe_runtime_group_component() {
        for group in ["", "IFD\0", "IFD\r", "IFD\n", "IFD=0"] {
            let occurrence = target_test_occurrence(group);
            let target = existing_target(&occurrence);
            assert_eq!(
                build_existing_occurrence_args(&target, &occurrence, &metadata_set(text("value")),),
                Err(MetadataTargetWriteError::UnsafeWriteTarget),
                "group {group:?} should be rejected"
            );
        }
    }

    #[test]
    fn existing_builder_rejects_every_unsafe_runtime_tag_name_component() {
        for tag_name in ["", "Tag\0", "Tag\r", "Tag\n", "Tag=Name", "Tag:Name"] {
            let mut occurrence = target_test_occurrence("IFD0");
            occurrence.write_target.as_mut().unwrap().tag_name = tag_name.to_owned();
            let target = existing_target(&occurrence);
            assert_eq!(
                build_existing_occurrence_args(&target, &occurrence, &metadata_set(text("value")),),
                Err(MetadataTargetWriteError::UnsafeWriteTarget),
                "tag name {tag_name:?} should be rejected"
            );
        }
    }

    #[test]
    fn existing_builder_does_not_mutate_target_or_fresh_occurrence() {
        let occurrence = target_test_occurrence("IFD1");
        let target = existing_target(&occurrence);
        let occurrence_before = occurrence.clone();
        let target_before = target.clone();

        build_existing_occurrence_args(&target, &occurrence, &metadata_set(text("value"))).unwrap();

        assert_eq!(target, target_before);
        assert_eq!(occurrence, occurrence_before);
    }

    #[test]
    fn existing_builder_uses_fresh_tag_info_semantics_after_validation() {
        let original = target_test_occurrence("IFD0");
        let target = existing_target(&original);
        let mut fresh = original;
        fresh.tag_info.as_mut().unwrap().kind = TagKind::Integer {
            min: None,
            max: None,
        };

        let args = build_existing_occurrence_args(
            &target,
            &fresh,
            &metadata_set(MetadataValue::Integer(5)),
        )
        .unwrap();

        assert_eq!(
            args.args,
            vec!["-1IFD0:7ID-Family7TagIdMustNotBeUsed:XResolution=5"]
        );
    }

    #[test]
    fn new_property_writable_exact_schema_uses_schema_selector_only() {
        let mut info = target_test_info(None);
        info.group = "XMP-dc".to_owned();
        info.name = "Title".to_owned();
        let target = new_property_target(&info);

        let args = build_new_property_args(&target, &info, &metadata_set(text("value"))).unwrap();

        assert_eq!(
            args.args,
            vec!["-1XMP-dc:7ID-SchemaTagIdMustNotBeUsed:Title=value"]
        );
        assert_eq!(target.occurrence_id(), None);
        assert_eq!(target.write_target().unwrap().group1, "XMP-dc");
    }

    #[test]
    fn new_property_builder_preserves_the_stored_custom_family1_destination() {
        let info = info_named(
            "IFD0",
            "XResolution",
            TagKind::Integer {
                min: None,
                max: None,
            },
        );
        let mut target = new_property_target(&info);
        let MetadataDraftTarget::NewProperty { write_target, .. } = &mut target else {
            unreachable!()
        };
        write_target.group1 = "IFD1".into();

        let args =
            build_new_property_args(&target, &info, &metadata_set(MetadataValue::Integer(72)))
                .unwrap();

        assert_eq!(args.args, vec!["-1IFD1:7ID-XResolution:XResolution=72"]);
    }

    #[test]
    fn new_property_builder_rejects_frontend_tampering_of_schema_locked_components() {
        let info = info_named("XMP-dc", "Title", TagKind::Text);
        let base = new_property_target(&info);
        for (target, expected) in [
            {
                let mut target = base.clone();
                let MetadataDraftTarget::NewProperty { write_target, .. } = &mut target else {
                    unreachable!()
                };
                write_target.group7 = "ID-other".into();
                (target, MetadataDraftTargetError::NewPropertyGroup7Mismatch)
            },
            {
                let mut target = base.clone();
                let MetadataDraftTarget::NewProperty { write_target, .. } = &mut target else {
                    unreachable!()
                };
                write_target.tag_name = "Other".into();
                (target, MetadataDraftTargetError::NewPropertyTagNameMismatch)
            },
        ] {
            assert_eq!(
                build_new_property_args(&target, &info, &metadata_set(text("value"))),
                Err(MetadataTargetWriteError::TargetValidation(expected))
            );
        }
    }

    #[test]
    fn new_property_schema_id_mismatch_is_rejected() {
        let info = target_test_info(None);
        let target = MetadataDraftTarget::NewProperty {
            schema_id: SchemaDefinitionId {
                index: Some(0),
                ..info.id.clone()
            },
            write_target: MetadataWriteTarget {
                group1: info.group.clone(),
                group7: crate::metadata_occurrence::family7_group_from_schema_id(&info.id),
                tag_name: info.name.clone(),
            },
        };

        assert_eq!(
            build_new_property_args(&target, &info, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::SchemaIdMismatch)
        );
    }

    #[test]
    fn new_property_read_only_schema_is_rejected() {
        let mut info = target_test_info(None);
        let target = new_property_target(&info);
        info.writable = false;

        assert_eq!(
            build_new_property_args(&target, &info, &metadata_set(text("value"))),
            Err(MetadataTargetWriteError::TargetValidation(
                MetadataDraftTargetError::ReadOnlySchema
            ))
        );
    }

    #[test]
    fn new_property_builder_rejects_existing_occurrence_target() {
        let occurrence = target_test_occurrence("IFD0");
        let target = existing_target(&occurrence);

        assert_eq!(
            build_new_property_args(
                &target,
                occurrence.tag_info.as_ref().unwrap(),
                &metadata_set(text("value")),
            ),
            Err(MetadataTargetWriteError::NewPropertyRequired)
        );
    }

    #[test]
    fn new_property_builder_rejects_every_unsafe_schema_group_component() {
        for group in ["", "XMP\0", "XMP\r", "XMP\n", "XMP=dc"] {
            let mut info = target_test_info(None);
            info.group = group.to_owned();
            let target = new_property_target(&info);
            assert_eq!(
                build_new_property_args(&target, &info, &metadata_set(text("value"))),
                Err(MetadataTargetWriteError::TargetValidation(
                    MetadataDraftTargetError::InvalidFamily1Group,
                )),
                "group {group:?} should be rejected"
            );
        }
    }

    #[test]
    fn new_property_builder_rejects_every_unsafe_schema_tag_name_component() {
        for tag_name in ["", "Tag\0", "Tag\r", "Tag\n", "Tag=Name", "Tag:Name"] {
            let mut info = target_test_info(None);
            info.name = tag_name.to_owned();
            let target = new_property_target(&info);
            assert_eq!(
                build_new_property_args(&target, &info, &metadata_set(text("value"))),
                Err(MetadataTargetWriteError::UnsafeWriteTarget),
                "tag name {tag_name:?} should be rejected"
            );
        }
    }

    #[test]
    fn new_property_absent_and_zero_schema_indexes_validate_distinctly() {
        let absent = target_test_info(None);
        let zero = target_test_info(Some(0));
        let absent_target = new_property_target(&absent);
        let zero_target = new_property_target(&zero);
        let edit = metadata_set(text("value"));

        assert!(build_new_property_args(&absent_target, &absent, &edit).is_ok());
        assert!(build_new_property_args(&zero_target, &zero, &edit).is_ok());
        assert_eq!(
            build_new_property_args(&absent_target, &zero, &edit),
            Err(MetadataTargetWriteError::SchemaIdMismatch)
        );
        assert_eq!(
            build_new_property_args(&zero_target, &absent, &edit),
            Err(MetadataTargetWriteError::SchemaIdMismatch)
        );
    }

    #[test]
    fn new_property_builder_does_not_mutate_target_or_tag_info() {
        let info = target_test_info(None);
        let target = new_property_target(&info);
        let info_before = info.clone();
        let target_before = target.clone();

        build_new_property_args(&target, &info, &metadata_set(text("value"))).unwrap();

        assert_eq!(target, target_before);
        assert_eq!(info, info_before);
    }

    #[test]
    fn target_aware_builders_cover_the_semantic_matrix_directly() {
        let mut langs = BTreeMap::new();
        langs.insert("en".to_owned(), "Hello".to_owned());
        let mut structure = BTreeMap::new();
        structure.insert("Name".to_owned(), text("Ada"));
        let offset = UtcOffsetValue {
            sign: OffsetSign::Plus,
            hours: 1,
            minutes: 30,
        };
        let date = DateValue {
            year: 2026,
            month: 7,
            day: 13,
        };
        let time = TimeValue {
            hour: 12,
            minute: 34,
            second: 56,
            subsecond: Some("789".to_owned()),
            offset: Some(offset.clone()),
        };
        let integer_kind = TagKind::Integer {
            min: None,
            max: None,
        };
        let ok = |args: &[&str]| {
            Ok(BuiltArgs {
                args: args.iter().map(|value| (*value).to_owned()).collect(),
            })
        };
        let error = |message: &str| Err(message.to_owned());
        let cases = vec![
            (
                "delete",
                TagKind::Text,
                metadata_delete(),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue="]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue="]),
            ),
            (
                "integer set",
                integer_kind.clone(),
                metadata_set(MetadataValue::Integer(5)),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=5"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=5"]),
            ),
            (
                "real set",
                TagKind::Real,
                metadata_set(MetadataValue::Real(1.25)),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=1.25"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=1.25"]),
            ),
            (
                "rational set",
                TagKind::Rational,
                metadata_set(MetadataValue::Rational(RationalValue {
                    numerator: 1,
                    denominator: 250,
                })),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=1/250"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=1/250"]),
            ),
            (
                "boolean set",
                TagKind::Boolean,
                metadata_set(MetadataValue::Bool(true)),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=1"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=1"]),
            ),
            (
                "integer enum set",
                TagKind::Enum {
                    repr: EnumRepr::Integer,
                    options: vec![],
                },
                metadata_set(MetadataValue::Integer(6)),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=6"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=6"]),
            ),
            (
                "text enum set",
                TagKind::Enum {
                    repr: EnumRepr::String,
                    options: vec![],
                },
                metadata_set(text("active")),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=active"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=active"]),
            ),
            (
                "text set",
                TagKind::Text,
                metadata_set(text("value")),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=value"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=value"]),
            ),
            (
                "lang-alt set",
                TagKind::LangAlt,
                metadata_set(MetadataValue::LangAlt(langs)),
                ok(
                    &[
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue-en=Hello",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue-x-default=Hello",
                    ],
                ),
                ok(
                    &[
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue-en=Hello",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue-x-default=Hello",
                    ],
                ),
            ),
            (
                "text-list set",
                TagKind::Bag(Box::new(TagKind::Text)),
                metadata_set(bag_text(&["a", "b"])),
                ok(
                    &[
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=a",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=b",
                    ],
                ),
                ok(
                    &[
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=a",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=b",
                    ],
                ),
            ),
            (
                "alternate-list set",
                TagKind::Alt(Box::new(TagKind::Text)),
                metadata_set(MetadataValue::List {
                    list_kind: ListKind::Alt,
                    items: vec![text("a"), text("b")],
                }),
                ok(
                    &[
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=a",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=b",
                    ],
                ),
                ok(
                    &[
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=a",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=b",
                    ],
                ),
            ),
            (
                "integer-list set",
                TagKind::Seq(Box::new(integer_kind.clone())),
                metadata_set(MetadataValue::List {
                    list_kind: ListKind::Seq,
                    items: vec![MetadataValue::Integer(1), MetadataValue::Integer(2)],
                }),
                ok(
                    &[
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=1",
                        "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=2",
                    ],
                ),
                ok(
                    &[
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=1",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=2",
                    ],
                ),
            ),
            (
                "list add",
                TagKind::Bag(Box::new(TagKind::Text)),
                metadata_list_add(bag_text(&["a", "b"])),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue+=a", "-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue+=b"]),
                ok(
                    &[
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue+=a",
                        "-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue+=b",
                    ],
                ),
            ),
            (
                "list remove",
                TagKind::Bag(Box::new(TagKind::Text)),
                metadata_list_remove(text("old")),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue-=old"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue-=old"]),
            ),
            (
                "date",
                TagKind::Date,
                metadata_set(MetadataValue::Date(date.clone())),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=2026:07:13"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=2026:07:13"]),
            ),
            (
                "time",
                TagKind::Time,
                metadata_set(MetadataValue::Time(time.clone())),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=12:34:56.789+01:30"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=12:34:56.789+01:30"]),
            ),
            (
                "date-time",
                TagKind::DateTime,
                metadata_set(MetadataValue::DateTime(DateTimeValue { date, time })),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=2026:07:13 12:34:56.789+01:30"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=2026:07:13 12:34:56.789+01:30"]),
            ),
            (
                "time offset",
                TagKind::TimeOffset,
                metadata_set(MetadataValue::TimeOffset(offset)),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue=+01:30"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue=+01:30"]),
            ),
            (
                "struct",
                TagKind::Struct(BTreeMap::new()),
                metadata_set(MetadataValue::Struct(structure)),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue={Name=Ada}"]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue={Name=Ada}"]),
            ),
            (
                "null set",
                TagKind::Text,
                metadata_set(MetadataValue::Null),
                ok(&["-1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue="]),
                ok(&["-1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue="]),
            ),
            (
                "binary rejection",
                TagKind::Text,
                metadata_set(MetadataValue::Binary),
                error(
                    "value encoding failed: 1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue is binary and is not writable",
                ),
                error(
                    "value encoding failed: 1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue is binary and is not writable",
                ),
            ),
            (
                "unknown rejection",
                TagKind::Text,
                metadata_set(MetadataValue::Unknown {
                    expected: Some(TagKind::Text),
                    raw: serde_json::json!({ "raw": true }),
                    reason: Some("test reason".to_owned()),
                }),
                error(
                    "value encoding failed: 1IFD1:7ID-Family7TagIdMustNotBeUsed:RuntimeValue is unparsed and cannot be written: test reason",
                ),
                error(
                    "value encoding failed: 1XMP-test:7ID-SchemaTagIdMustNotBeUsed:SchemaValue is unparsed and cannot be written: test reason",
                ),
            ),
        ];

        for (case, kind, edit, expected_existing, expected_new) in cases {
            let mut info = target_test_info(None);
            info.group = "XMP-test".to_owned();
            info.name = "SchemaValue".to_owned();
            info.kind = kind;
            let mut occurrence = target_test_occurrence("IFD1");
            occurrence.tag_info = Some(info.clone());
            occurrence.write_target = Some(MetadataWriteTarget {
                group1: "IFD1".to_owned(),
                group7: crate::metadata_occurrence::family7_group_from_runtime_tag_id(
                    &occurrence.id.runtime_tag_id,
                ),
                tag_name: "RuntimeValue".to_owned(),
            });
            let existing = existing_target(&occurrence);
            let new_property = new_property_target(&info);
            let existing_result = build_existing_occurrence_args(&existing, &occurrence, &edit)
                .map_err(|error| error.to_string());
            let new_result = build_new_property_args(&new_property, &info, &edit)
                .map_err(|error| error.to_string());

            assert_eq!(existing_result, expected_existing, "existing {case}");
            assert_eq!(new_result, expected_new, "new property {case}");
        }
    }
}
