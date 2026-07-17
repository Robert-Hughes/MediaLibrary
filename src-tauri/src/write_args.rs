//! exiftool argv construction for write-back.
//!
//! See `docs/METADATA_FORMATS_DESIGN.md` §6.
//!
//! This module produces unambiguous exiftool argv from semantic draft edits and
//! `TagInfo` schema entries.  It is **pure** — no exiftool subprocess, no
//! filesystem — so it is fully unit-testable and the test matrix can be
//! exhaustive.
//!
//! Output shape: `BuiltArgs { numeric, text }`.  Two groups so the caller can
//! run two exiftool invocations — one with `-n` for numeric/enum/boolean
//! values, one without for text/lang-alt/list-of-text — because `-n` is
//! global to an invocation.  Numeric runs first; text-group edits can depend
//! on numeric tags being already set (rare but possible for derived fields).

use crate::draft_edits::{EditIntent, MetadataDraftEdit};
use crate::metadata_draft_target::{MetadataDraftTarget, MetadataDraftTargetError};
use crate::metadata_occurrence::MetadataOccurrence;
use crate::metadata_value::{
    DateTimeValue, DateValue, MetadataValue, OffsetSign, TimeValue, UtcOffsetValue,
};
use crate::tag_schema::{EnumRepr, SchemaDefinitionId, TagInfo, TagKind};

/// Output of `build_args` for one draft edit.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct BuiltArgs {
    /// Args for the `-n` exiftool invocation (raw numeric/enum/bool form).
    pub numeric: Vec<String>,
    /// Args for the no-`-n` invocation (text, lang-alt, lists of text).
    pub text: Vec<String>,
}

impl BuiltArgs {
    pub fn is_empty(&self) -> bool {
        self.numeric.is_empty() && self.text.is_empty()
    }

    /// Merge other into self, preserving group ordering.
    pub fn extend(&mut self, other: BuiltArgs) {
        self.numeric.extend(other.numeric);
        self.text.extend(other.text);
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

pub fn build_metadata_args(
    id: &SchemaDefinitionId,
    info: &TagInfo,
    edit: &MetadataDraftEdit,
) -> Result<BuiltArgs, String> {
    if info.id != *id {
        return Err(format!(
            "schema identity mismatch: requested {id:?}, got {:?}",
            info.id
        ));
    }
    if !info.writable {
        return Err(format!("{} ({id:?}) is read-only", info.display_name()));
    }
    let tag = info.exiftool_write_name();
    let tag = tag.as_str();
    if info.group.is_empty() || info.name.is_empty() || tag.contains('\n') || tag.contains('\0') {
        return Ok(BuiltArgs::default());
    }

    build_metadata_args_for_selector(tag, info, edit)
}

/// Plans a write to one exact existing occurrence after revalidating its
/// persisted target snapshot against a freshly read authoritative occurrence.
///
/// The schema-v5 single-file writer uses this planner for existing targets.
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
    let selector = validated_selector(&write_target.group1, &write_target.tag_name)?;

    build_metadata_args_for_selector(&selector, info, edit)
        .map_err(MetadataTargetWriteError::ValueEncoding)
}

/// Plans schema-driven creation of a property that has no runtime occurrence.
///
/// The schema-v5 single-file writer uses this planner for new-property targets.
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
    if !info.writable {
        return Err(MetadataTargetWriteError::TargetValidation(
            MetadataDraftTargetError::ReadOnlySchema,
        ));
    }
    let selector = validated_selector(&info.group, &info.name)?;

    build_metadata_args_for_selector(&selector, info, edit)
        .map_err(MetadataTargetWriteError::ValueEncoding)
}

fn validated_selector(group: &str, tag_name: &str) -> Result<String, MetadataTargetWriteError> {
    let unsafe_group = group.is_empty()
        || group
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n' | '='));
    let unsafe_tag_name = tag_name.is_empty()
        || tag_name
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n' | '=' | ':'));
    if unsafe_group || unsafe_tag_name {
        return Err(MetadataTargetWriteError::UnsafeWriteTarget);
    }

    Ok(format!("{group}:{tag_name}"))
}

fn build_metadata_args_for_selector(
    selector: &str,
    info: &TagInfo,
    edit: &MetadataDraftEdit,
) -> Result<BuiltArgs, String> {
    let tag = selector;

    match edit.intent {
        EditIntent::Delete => Ok(BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}=", tag)],
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
            numeric: vec![],
            text: vec![format!("-{}=", tag)],
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
            let mut text = Vec::with_capacity(langs.len());
            for (lang, value) in langs {
                text.push(format!("-{}-{}={}", tag, lang, value));
            }
            if !langs.contains_key("x-default") {
                if let Some(first) = langs.values().next() {
                    text.push(format!("-{}-x-default={}", tag, first));
                }
            }
            Ok(BuiltArgs {
                numeric: vec![],
                text,
            })
        }
        (Some(TagKind::Bag(inner) | TagKind::Seq(inner) | TagKind::Alt(inner)), Some(value)) => {
            build_metadata_list_set(tag, inner, value)
        }
        (Some(TagKind::Struct(_)), Some(MetadataValue::Struct(map))) => Ok(BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}={}", tag, render_metadata_struct(map)?)],
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
            numeric: vec![format!(
                "-{}={}",
                tag,
                render_metadata_scalar_numeric(value, Some(kind))?
            )],
            text: vec![],
        }),
        (
            Some(TagKind::Enum {
                repr: EnumRepr::Integer,
                ..
            }),
            Some(value),
        ) => Ok(BuiltArgs {
            numeric: vec![format!(
                "-{}={}",
                tag,
                render_metadata_scalar_numeric(value, kind)?
            )],
            text: vec![],
        }),
        (Some(kind @ (TagKind::Date | TagKind::Time | TagKind::DateTime)), Some(value)) => {
            Ok(BuiltArgs {
                numeric: vec![format!(
                    "-{}={}",
                    tag,
                    render_metadata_value_for_write(value, Some(kind))?
                )],
                text: vec![],
            })
        }
        (_, Some(MetadataValue::List { .. })) => Err(format!(
            "{tag} is a list value but schema is not a list kind"
        )),
        (_, Some(MetadataValue::Struct(_))) => Err(format!(
            "{tag} is a struct value but schema is not a struct kind"
        )),
        (_, Some(value)) => Ok(BuiltArgs {
            numeric: vec![],
            text: vec![format!(
                "-{}={}",
                tag,
                render_metadata_scalar_text(value, kind)?
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
        numeric: vec![],
        text: vec![],
    };
    let numeric_items = is_numeric_kind(inner);
    if numeric_items {
        args.numeric.push(format!("-{}=", tag));
        for item in items {
            args.numeric.push(format!(
                "-{}={}",
                tag,
                render_metadata_scalar_numeric(item, Some(inner))?
            ));
        }
    } else {
        args.text.push(format!("-{}=", tag));
        for item in items {
            args.text.push(format!(
                "-{}={}",
                tag,
                render_metadata_scalar_text(item, Some(inner))?
            ));
        }
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
                numeric: vec![],
                text: vec![format!("-{}=", tag)],
            }),
            _ => build_metadata_set(tag, info, value),
        };
    };
    let inner = match kind {
        TagKind::Bag(inner) | TagKind::Seq(inner) | TagKind::Alt(inner) => inner,
        _ => {
            return match op {
                "-=" => Ok(BuiltArgs {
                    numeric: vec![],
                    text: vec![format!("-{}=", tag)],
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
        args.text.push(format!(
            "-{}{}{}",
            tag,
            op,
            render_metadata_scalar_text(item, Some(inner))?
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

pub fn render_metadata_value_for_write(
    value: &MetadataValue,
    kind: Option<&TagKind>,
) -> Result<String, String> {
    match value {
        MetadataValue::Null => Ok(String::new()),
        MetadataValue::Text(s) => Ok(normalise_storage_string_for_kind(s, kind)),
        MetadataValue::Bool(b) => Ok(if *b { "1".into() } else { "0".into() }),
        MetadataValue::Integer(n) => Ok(n.to_string()),
        MetadataValue::Real(f) => Ok(f.to_string()),
        MetadataValue::Rational(r) => Ok(format!("{}/{}", r.numerator, r.denominator)),
        MetadataValue::Date(d) => Ok(render_date(d)),
        MetadataValue::Time(t) => Ok(render_time(t)),
        MetadataValue::DateTime(dt) => Ok(render_datetime(dt)),
        MetadataValue::TimeOffset(offset) => Ok(render_offset(offset)),
        MetadataValue::LangAlt(_) => {
            Err("lang-alt values require per-language write args".to_string())
        }
        MetadataValue::List { .. } => Err("list values require repeated write args".to_string()),
        MetadataValue::Struct(_) => Err("struct values require struct write rendering".to_string()),
        MetadataValue::Binary => Err("binary metadata is not writable".to_string()),
        MetadataValue::Unknown { reason, .. } => Err(format!(
            "unknown metadata value is not writable{}",
            reason
                .as_ref()
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        )),
    }
}

fn render_metadata_scalar_text(
    value: &MetadataValue,
    kind: Option<&TagKind>,
) -> Result<String, String> {
    match value {
        MetadataValue::Bool(b) => Ok(if *b { "True".into() } else { "False".into() }),
        MetadataValue::List { .. } => Err("nested list cannot be rendered as scalar text".into()),
        MetadataValue::Struct(map) => render_metadata_struct(map),
        other => render_metadata_value_for_write(other, kind),
    }
}

fn render_metadata_scalar_numeric(
    value: &MetadataValue,
    kind: Option<&TagKind>,
) -> Result<String, String> {
    match value {
        MetadataValue::Bool(b) => Ok(if *b { "1".into() } else { "0".into() }),
        MetadataValue::Text(s) => Ok(normalise_storage_string_for_kind(s, kind)),
        other => render_metadata_value_for_write(other, kind),
    }
}

fn render_metadata_struct(
    map: &std::collections::BTreeMap<String, MetadataValue>,
) -> Result<String, String> {
    fn escape_scalar(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            if matches!(c, ',' | '{' | '}' | '[' | ']' | '=' | '\\') {
                out.push('\\');
            }
            out.push(c);
        }
        out
    }
    fn render(value: &MetadataValue) -> Result<String, String> {
        match value {
            MetadataValue::Null => Ok(String::new()),
            MetadataValue::Text(s) => Ok(escape_scalar(s)),
            MetadataValue::Bool(b) => Ok(if *b { "True".into() } else { "False".into() }),
            MetadataValue::Integer(n) => Ok(n.to_string()),
            MetadataValue::Real(f) => Ok(f.to_string()),
            MetadataValue::Rational(r) => Ok(format!("{}/{}", r.numerator, r.denominator)),
            MetadataValue::Date(d) => Ok(render_date(d)),
            MetadataValue::Time(t) => Ok(render_time(t)),
            MetadataValue::DateTime(dt) => Ok(render_datetime(dt)),
            MetadataValue::TimeOffset(offset) => Ok(render_offset(offset)),
            MetadataValue::List { items, .. } => {
                let inner = items
                    .iter()
                    .map(render)
                    .collect::<Result<Vec<_>, _>>()?
                    .join(",");
                Ok(format!("[{}]", inner))
            }
            MetadataValue::Struct(map) => render_metadata_struct(map),
            MetadataValue::LangAlt(_) => {
                Err("lang-alt cannot be nested in struct write syntax".into())
            }
            MetadataValue::Binary => Err("binary metadata is not writable".into()),
            MetadataValue::Unknown { .. } => Err("unknown metadata is not writable".into()),
        }
    }

    let inner = map
        .iter()
        .map(|(key, value)| Ok(format!("{}={}", escape_scalar(key), render(value)?)))
        .collect::<Result<Vec<String>, String>>()?
        .join(",");
    Ok(format!("{{{}}}", inner))
}

fn is_numeric_kind(kind: &TagKind) -> bool {
    matches!(
        kind,
        TagKind::Integer { .. }
            | TagKind::Real
            | TagKind::Rational
            | TagKind::Boolean
            | TagKind::TimeOffset
            | TagKind::Enum {
                repr: EnumRepr::Integer,
                ..
            }
    )
}

fn render_date(date: &DateValue) -> String {
    format!("{:04}:{:02}:{:02}", date.year, date.month, date.day)
}

fn render_time(time: &TimeValue) -> String {
    let mut out = format!("{:02}:{:02}:{:02}", time.hour, time.minute, time.second);
    if let Some(subsecond) = &time.subsecond {
        out.push('.');
        out.push_str(subsecond);
    }
    if let Some(offset) = &time.offset {
        out.push_str(&render_offset(offset));
    }
    out
}

fn render_datetime(datetime: &DateTimeValue) -> String {
    format!(
        "{} {}",
        render_date(&datetime.date),
        render_time(&datetime.time)
    )
}

fn render_offset(offset: &UtcOffsetValue) -> String {
    let sign = match offset.sign {
        OffsetSign::Plus => '+',
        OffsetSign::Minus => '-',
    };
    format!("{}{:02}:{:02}", sign, offset.hours, offset.minutes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_occurrence::{MetadataOccurrenceId, MetadataWriteTarget};
    use crate::metadata_value::{ListKind, RationalValue};
    use crate::tag_schema::{EnumOption, EnumRepr};
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
            group: group.to_string(),
            name: name.to_string(),
            writable: true,
            kind,
            description: None,
            storage_count: None,
        }
    }

    /// Friendly selectors are concise test-fixture shorthand only. Each call
    /// immediately constructs an exact ID-bearing TagInfo before exercising
    /// the production exact-ID API.
    fn build_fixture_args(
        selector: &str,
        template: &TagInfo,
        edit: &MetadataDraftEdit,
    ) -> Result<BuiltArgs, String> {
        let (group, name) = selector.split_once(':').unwrap_or((selector, ""));
        let mut info = template.clone();
        info.id = SchemaDefinitionId {
            table: format!("TestFixture::{group}"),
            tag_id: name.to_string(),
            index: None,
        };
        info.group = group.to_string();
        info.name = name.to_string();
        super::build_metadata_args(&info.id, &info, edit)
    }

    fn metadata_set(v: MetadataValue) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(v),
            intent: EditIntent::Set,
            display: None,
        }
    }
    fn metadata_delete() -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: None,
            intent: EditIntent::Delete,
            display: None,
        }
    }
    fn metadata_list_add(v: MetadataValue) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(v),
            intent: EditIntent::ListAdd,
            display: None,
        }
    }
    fn metadata_list_remove(v: MetadataValue) -> MetadataDraftEdit {
        MetadataDraftEdit {
            value: Some(v),
            intent: EditIntent::ListRemove,
            display: None,
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
        let args = build_fixture_args("XMP-dc:Title", &i, &metadata_set(text("hi"))).unwrap();
        assert!(args.numeric.is_empty());
        assert_eq!(args.text, vec!["-XMP-dc:Title=hi"]);
    }

    #[test]
    fn gps_version_id_text_uses_spaced_raw_value() {
        let i = info_named("GPS", "GPSVersionID", TagKind::Text);
        let args =
            build_fixture_args("GPS:GPSVersionID", &i, &metadata_set(text("2 3 0 0"))).unwrap();
        assert_eq!(args.text, vec!["-GPS:GPSVersionID=2 3 0 0"]);
        assert!(args.numeric.is_empty());
    }

    #[test]
    fn set_integer_yields_numeric_arg() {
        let i = info(TagKind::Integer {
            min: None,
            max: None,
        });
        let args = build_fixture_args(
            "XMP-xmp:Rating",
            &i,
            &metadata_set(MetadataValue::Integer(5)),
        )
        .unwrap();
        assert!(args.text.is_empty());
        assert_eq!(args.numeric, vec!["-XMP-xmp:Rating=5"]);
    }

    #[test]
    fn set_boolean_uses_1_0_in_numeric_group() {
        let i = info(TagKind::Boolean);
        let args = build_fixture_args(
            "XMP-xmpRights:Marked",
            &i,
            &metadata_set(MetadataValue::Bool(true)),
        )
        .unwrap();
        assert_eq!(args.numeric, vec!["-XMP-xmpRights:Marked=1"]);
        assert!(args.text.is_empty());
    }

    #[test]
    fn set_enum_integer_uses_numeric_group() {
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
        let args = build_fixture_args(
            "IFD0:Orientation",
            &i,
            &metadata_set(MetadataValue::Integer(6)),
        )
        .unwrap();
        assert_eq!(args.numeric, vec!["-IFD0:Orientation=6"]);
    }

    #[test]
    fn set_bag_emits_clear_then_repeated_args() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_fixture_args(
            "XMP-dc:Subject",
            &i,
            &metadata_set(bag_text(&["beach", "sunset"])),
        )
        .unwrap();
        assert_eq!(
            args.text,
            vec![
                "-XMP-dc:Subject=",
                "-XMP-dc:Subject=beach",
                "-XMP-dc:Subject=sunset"
            ]
        );
        assert!(args.numeric.is_empty());
    }

    #[test]
    fn set_seq_emits_clear_then_ordered_args() {
        let i = info(TagKind::Seq(Box::new(TagKind::Text)));
        let args = build_fixture_args(
            "XMP-dc:Creator",
            &i,
            &metadata_set(seq_text(&["Ada", "Bea"])),
        )
        .unwrap();
        assert_eq!(
            args.text,
            vec![
                "-XMP-dc:Creator=",
                "-XMP-dc:Creator=Ada",
                "-XMP-dc:Creator=Bea"
            ]
        );
    }

    #[test]
    fn set_bag_with_scalar_treats_as_single_element() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_fixture_args("XMP-dc:Subject", &i, &metadata_set(text("only"))).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Subject=", "-XMP-dc:Subject=only"]);
    }

    #[test]
    fn set_langalt_with_object_emits_per_lang_args() {
        let i = info(TagKind::LangAlt);
        let mut langs = BTreeMap::new();
        langs.insert("x-default".to_string(), "Hi".to_string());
        langs.insert("en".to_string(), "Hi".to_string());
        langs.insert("fr".to_string(), "Salut".to_string());
        let args = build_fixture_args(
            "XMP-dc:Description",
            &i,
            &metadata_set(MetadataValue::LangAlt(langs)),
        )
        .unwrap();
        // BTreeMap iteration order is alphabetic; assert presence not order.
        assert!(args
            .text
            .iter()
            .any(|a| a == "-XMP-dc:Description-x-default=Hi"));
        assert!(args.text.iter().any(|a| a == "-XMP-dc:Description-en=Hi"));
        assert!(args
            .text
            .iter()
            .any(|a| a == "-XMP-dc:Description-fr=Salut"));
        assert_eq!(args.text.len(), 3);
    }

    #[test]
    fn set_langalt_without_xdefault_synthesises_one() {
        let i = info(TagKind::LangAlt);
        let mut langs = BTreeMap::new();
        langs.insert("en".to_string(), "Hello".to_string());
        let args = build_fixture_args(
            "XMP-dc:Description",
            &i,
            &metadata_set(MetadataValue::LangAlt(langs)),
        )
        .unwrap();
        assert!(args
            .text
            .iter()
            .any(|a| a == "-XMP-dc:Description-en=Hello"));
        assert!(args
            .text
            .iter()
            .any(|a| a == "-XMP-dc:Description-x-default=Hello"));
    }

    #[test]
    fn delete_emits_empty_assignment() {
        let i = info(TagKind::Text);
        let args = build_fixture_args("XMP-dc:Title", &i, &metadata_delete()).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Title="]);
        assert!(args.numeric.is_empty());
    }

    #[test]
    fn listadd_on_bag_emits_plus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_fixture_args(
            "XMP-dc:Subject",
            &i,
            &metadata_list_add(bag_text(&["a", "b"])),
        )
        .unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Subject+=a", "-XMP-dc:Subject+=b"]);
    }

    #[test]
    fn listremove_on_bag_emits_minus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args =
            build_fixture_args("XMP-dc:Subject", &i, &metadata_list_remove(text("old"))).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Subject-=old"]);
    }

    #[test]
    fn list_op_on_non_list_tag_degrades_safely() {
        let i = info(TagKind::Text);
        // ListAdd on a Text tag becomes a Set.
        let args = build_fixture_args("XMP-dc:Title", &i, &metadata_list_add(text("hi"))).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Title=hi"]);
        // ListRemove on a Text tag becomes a Delete.
        let args =
            build_fixture_args("XMP-dc:Title", &i, &metadata_list_remove(text("hi"))).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Title="]);
    }

    #[test]
    fn binary_tag_yields_no_args() {
        let i = info(TagKind::Binary);
        let err = build_fixture_args("Thumbnail:Bin", &i, &metadata_set(text("x"))).unwrap_err();
        assert!(err.contains("binary"));
    }

    #[test]
    fn invalid_tag_name_yields_no_args() {
        let i = info(TagKind::Text);
        let args = build_fixture_args("bad\nname", &i, &metadata_set(text("x"))).unwrap();
        assert!(args.is_empty());
        let args = build_fixture_args("", &i, &metadata_set(text("x"))).unwrap();
        assert!(args.is_empty());
    }

    #[test]
    fn exact_identity_and_selected_tag_info_must_match() {
        let selected = info_named("XMP-dc", "Title", TagKind::Text);
        let sibling_id = SchemaDefinitionId {
            table: "Other::dc".into(),
            tag_id: selected.id.tag_id.clone(),
            index: None,
        };
        let err = super::build_metadata_args(&sibling_id, &selected, &metadata_set(text("value")))
            .unwrap_err();
        assert!(err.contains("schema identity mismatch"));
    }

    #[test]
    fn write_selector_is_derived_from_exact_selected_tag_info() {
        let selected = info_named("XMP-dc", "Title", TagKind::Text);
        let args =
            super::build_metadata_args(&selected.id, &selected, &metadata_set(text("value")))
                .unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Title=value"]);
    }

    #[test]
    fn exact_read_only_definition_is_rejected() {
        let mut selected = info_named("File", "BMPVersion", TagKind::Text);
        selected.writable = false;
        let err =
            super::build_metadata_args(&selected.id, &selected, &metadata_set(text("Windows V3")))
                .unwrap_err();
        assert!(err.contains("read-only"));
    }

    #[test]
    fn float_renders_decimal_in_numeric_group() {
        let i = info(TagKind::Real);
        let args = build_fixture_args(
            "Composite:GPSAltitude",
            &i,
            &metadata_set(MetadataValue::Real(123.45)),
        )
        .unwrap();
        assert_eq!(args.numeric, vec!["-Composite:GPSAltitude=123.45"]);
    }

    #[test]
    fn gps_reals_render_as_scalar_numeric_args() {
        for (tag, value, expected) in [
            (
                "GPS:GPSLatitude",
                52.2037391662611,
                "-GPS:GPSLatitude=52.2037391662611",
            ),
            ("GPS:GPSLongitude", 1.236557, "-GPS:GPSLongitude=1.236557"),
            ("GPS:GPSAltitude", 123.4, "-GPS:GPSAltitude=123.4"),
        ] {
            let i = info(TagKind::Real);
            let args =
                build_fixture_args(tag, &i, &metadata_set(MetadataValue::Real(value))).unwrap();
            assert_eq!(args.numeric, vec![expected]);
            assert!(args.text.is_empty());
        }
    }

    #[test]
    fn datetime_uses_numeric_group() {
        // Phase 8.7: design §6 puts DateTime in the -n group so the literal
        // YYYY:MM:DD HH:MM:SS±ZZ:ZZ form bypasses PrintConv re-parsing.
        let i = info(TagKind::DateTime);
        let args = build_fixture_args(
            "ExifIFD:DateTimeOriginal",
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
            args.numeric,
            vec!["-ExifIFD:DateTimeOriginal=2026:05:15 10:30:00"]
        );
        assert!(args.text.is_empty());
    }

    #[test]
    fn ai_generated_at_datetime_uses_numeric_group_with_offset() {
        let i = info_named("XMP-mlib", "AIGeneratedAt", TagKind::DateTime);
        let args = build_fixture_args(
            "XMP-mlib:AIGeneratedAt",
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
            args.numeric,
            vec!["-XMP-mlib:AIGeneratedAt=2026:07:06 21:43:08+01:00"]
        );
        assert!(args.text.is_empty());
    }

    #[test]
    fn iptc_date_renders_storage_format() {
        let i = info_named("IPTC", "DateCreated", TagKind::Date);
        let args = build_fixture_args(
            "IPTC:DateCreated",
            &i,
            &metadata_set(MetadataValue::Date(DateValue {
                year: 2026,
                month: 5,
                day: 15,
            })),
        )
        .unwrap();
        assert_eq!(args.numeric, vec!["-IPTC:DateCreated=2026:05:15"]);
    }

    #[test]
    fn iptc_time_without_offset_stays_offsetless() {
        let i = info_named("IPTC", "TimeCreated", TagKind::Time);
        let args = build_fixture_args(
            "IPTC:TimeCreated",
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
        assert_eq!(args.numeric, vec!["-IPTC:TimeCreated=10:30:00"]);
        assert!(args.text.is_empty());
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
        let args = build_fixture_args(
            "XMP-dc:Subject",
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
            args.text,
            vec![
                "-XMP-dc:Subject=",
                "-XMP-dc:Subject=beach",
                "-XMP-dc:Subject=sunset"
            ]
        );
        assert!(!args.text.iter().any(|arg| arg.contains("beach, sunset")));
    }

    #[test]
    fn semantic_writer_handles_alt_lists() {
        let i = info(TagKind::Alt(Box::new(TagKind::Text)));
        let args = build_fixture_args(
            "XMP-dc:Title",
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
            args.text,
            vec!["-XMP-dc:Title=", "-XMP-dc:Title=one", "-XMP-dc:Title=two"]
        );
    }

    #[test]
    fn semantic_writer_handles_numeric_lists_in_numeric_group() {
        let i = info(TagKind::Bag(Box::new(TagKind::Integer {
            min: None,
            max: None,
        })));
        let args = build_fixture_args(
            "X:Numbers",
            &i,
            &metadata_set(MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![MetadataValue::Integer(1), MetadataValue::Integer(2)],
            }),
        )
        .unwrap();
        assert_eq!(args.text, Vec::<String>::new());
        assert_eq!(
            args.numeric,
            vec!["-X:Numbers=", "-X:Numbers=1", "-X:Numbers=2"]
        );
    }

    #[test]
    fn semantic_writer_renders_exact_rational() {
        let i = info(TagKind::Rational);
        let args = build_fixture_args(
            "EXIF:ExposureTime",
            &i,
            &metadata_set(MetadataValue::Rational(
                crate::metadata_value::RationalValue {
                    numerator: 1,
                    denominator: 250,
                },
            )),
        )
        .unwrap();
        assert_eq!(args.numeric, vec!["-EXIF:ExposureTime=1/250"]);
    }

    #[test]
    fn semantic_writer_blocks_binary_and_unknown() {
        let binary = info(TagKind::Binary);
        let err = build_fixture_args(
            "File:PreviewImage",
            &binary,
            &metadata_set(MetadataValue::Binary),
        )
        .unwrap_err();
        assert!(err.contains("binary"));

        let text = info(TagKind::Text);
        let err = build_fixture_args(
            "X:Bad",
            &text,
            &metadata_set(MetadataValue::Unknown {
                expected: Some(TagKind::Text),
                raw: serde_json::json!({"bad": true}),
                reason: Some("malformed".into()),
            }),
        )
        .unwrap_err();
        assert!(err.contains("unparsed"));
    }

    #[test]
    fn rational_uses_numeric_group() {
        let i = info(TagKind::Rational);
        let args = build_fixture_args(
            "EXIF:ExposureTime",
            &i,
            &metadata_set(MetadataValue::Rational(
                crate::metadata_value::RationalValue {
                    numerator: 1,
                    denominator: 250,
                },
            )),
        )
        .unwrap();
        assert_eq!(args.numeric, vec!["-EXIF:ExposureTime=1/250"]);
    }

    // ── Phase 8 fix: struct argv uses exiftool -struct syntax, not JSON ──

    #[test]
    fn struct_render_uses_brace_syntax_not_json() {
        let mut inner = BTreeMap::new();
        inner.insert("Name".to_string(), text("John"));
        inner.insert("Type".to_string(), text("Face"));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_fixture_args(
            "XMP-mwg-rs:Region",
            &i,
            &metadata_set(MetadataValue::Struct(inner)),
        )
        .unwrap();
        // Brace form, not JSON.  Field ordering is alphabetic via BTreeMap.
        assert_eq!(args.text, vec!["-XMP-mwg-rs:Region={Name=John,Type=Face}"]);
        // Critically: should NOT contain JSON quotes.
        assert!(
            !args.text[0].contains("\""),
            "argv must not be JSON: {:?}",
            args.text
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
        let args =
            build_fixture_args("X:R", &i, &metadata_set(MetadataValue::Struct(region))).unwrap();
        assert_eq!(args.text, vec!["-X:R={Area={X=0.5,Y=0.5},Names=[a,b]}"]);
    }

    #[test]
    fn struct_render_escapes_metacharacters_in_scalars() {
        let mut o = BTreeMap::new();
        // Value containing every metachar exiftool struct parser cares about.
        o.insert("k".to_string(), text("a,b{c}d[e]f=g\\h"));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_fixture_args("X:S", &i, &metadata_set(MetadataValue::Struct(o))).unwrap();
        assert_eq!(args.text, vec![r"-X:S={k=a\,b\{c\}d\[e\]f\=g\\h}"]);
    }

    #[test]
    fn struct_render_empty_object_and_list() {
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_fixture_args(
            "X:S",
            &i,
            &metadata_set(MetadataValue::Struct(BTreeMap::new())),
        )
        .unwrap();
        assert_eq!(args.text, vec!["-X:S={}"]);
    }

    #[test]
    fn builtargs_extend_concatenates_groups() {
        let mut a = BuiltArgs {
            numeric: vec!["-A=1".into()],
            text: vec!["-B=x".into()],
        };
        let b = BuiltArgs {
            numeric: vec!["-C=2".into()],
            text: vec!["-D=y".into()],
        };
        a.extend(b);
        assert_eq!(a.numeric, vec!["-A=1", "-C=2"]);
        assert_eq!(a.text, vec!["-B=x", "-D=y"]);
    }

    fn target_test_info(index: Option<u32>) -> TagInfo {
        TagInfo {
            id: SchemaDefinitionId {
                table: "SchemaTableMustNotBeUsed".to_owned(),
                tag_id: "SchemaTagIdMustNotBeUsed".to_owned(),
                index,
            },
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
                tag_id: "Family7TagIdMustNotBeUsed".to_owned(),
                copy: 4,
            },
            schema_id: tag_info.id.clone(),
            value: text("old"),
            tag_info: Some(tag_info),
            write_target: Some(MetadataWriteTarget {
                group1: group1.to_owned(),
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
                .text,
            vec!["-IFD0:XResolution=value"]
        );
    }

    #[test]
    fn existing_ifd1_selector_ignores_schema_and_friendly_identity_fields() {
        let occurrence = target_test_occurrence("IFD1");
        let target = existing_target(&occurrence);
        let args =
            build_existing_occurrence_args(&target, &occurrence, &metadata_set(text("value")))
                .unwrap();

        assert_eq!(args.text, vec!["-IFD1:XResolution=value"]);
        for forbidden in [
            "SchemaGroupMustNotBeUsed",
            "FriendlyNameMustNotBeUsed",
            "SchemaTableMustNotBeUsed",
            "SchemaTagIdMustNotBeUsed",
            "Family5PathMustNotBeUsed",
            "Family7TagIdMustNotBeUsed",
            "Copy4",
        ] {
            assert!(!args.text[0].contains(forbidden));
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
        assert_eq!(ifd0_args.text, vec!["-IFD0:XResolution=value"]);
        assert_eq!(ifd1_args.text, vec!["-IFD1:XResolution=value"]);
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

        assert_eq!(args.numeric, vec!["-IFD0:XResolution=5"]);
        assert!(args.text.is_empty());
    }

    #[test]
    fn new_property_writable_exact_schema_uses_schema_selector_only() {
        let mut info = target_test_info(None);
        info.group = "XMP-dc".to_owned();
        info.name = "Title".to_owned();
        let target = new_property_target(&info);

        let args = build_new_property_args(&target, &info, &metadata_set(text("value"))).unwrap();

        assert_eq!(args.text, vec!["-XMP-dc:Title=value"]);
        assert_eq!(target.occurrence_id(), None);
        assert_eq!(target.write_target(), None);
    }

    #[test]
    fn new_property_schema_id_mismatch_is_rejected() {
        let info = target_test_info(None);
        let target = MetadataDraftTarget::NewProperty {
            schema_id: SchemaDefinitionId {
                index: Some(0),
                ..info.id.clone()
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
                Err(MetadataTargetWriteError::UnsafeWriteTarget),
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
    fn target_aware_builders_have_legacy_semantic_parity() {
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
        let cases = vec![
            ("delete", TagKind::Text, metadata_delete()),
            (
                "integer set",
                integer_kind.clone(),
                metadata_set(MetadataValue::Integer(5)),
            ),
            (
                "real set",
                TagKind::Real,
                metadata_set(MetadataValue::Real(1.25)),
            ),
            (
                "rational set",
                TagKind::Rational,
                metadata_set(MetadataValue::Rational(RationalValue {
                    numerator: 1,
                    denominator: 250,
                })),
            ),
            (
                "boolean set",
                TagKind::Boolean,
                metadata_set(MetadataValue::Bool(true)),
            ),
            (
                "integer enum set",
                TagKind::Enum {
                    repr: EnumRepr::Integer,
                    options: vec![],
                },
                metadata_set(MetadataValue::Integer(6)),
            ),
            (
                "text enum set",
                TagKind::Enum {
                    repr: EnumRepr::String,
                    options: vec![],
                },
                metadata_set(text("active")),
            ),
            ("text set", TagKind::Text, metadata_set(text("value"))),
            (
                "lang-alt set",
                TagKind::LangAlt,
                metadata_set(MetadataValue::LangAlt(langs)),
            ),
            (
                "text-list set",
                TagKind::Bag(Box::new(TagKind::Text)),
                metadata_set(bag_text(&["a", "b"])),
            ),
            (
                "alternate-list set",
                TagKind::Alt(Box::new(TagKind::Text)),
                metadata_set(MetadataValue::List {
                    list_kind: ListKind::Alt,
                    items: vec![text("a"), text("b")],
                }),
            ),
            (
                "numeric-list set",
                TagKind::Seq(Box::new(integer_kind.clone())),
                metadata_set(MetadataValue::List {
                    list_kind: ListKind::Seq,
                    items: vec![MetadataValue::Integer(1), MetadataValue::Integer(2)],
                }),
            ),
            (
                "list add",
                TagKind::Bag(Box::new(TagKind::Text)),
                metadata_list_add(bag_text(&["a", "b"])),
            ),
            (
                "list remove",
                TagKind::Bag(Box::new(TagKind::Text)),
                metadata_list_remove(text("old")),
            ),
            (
                "date",
                TagKind::Date,
                metadata_set(MetadataValue::Date(date.clone())),
            ),
            (
                "time",
                TagKind::Time,
                metadata_set(MetadataValue::Time(time.clone())),
            ),
            (
                "date-time",
                TagKind::DateTime,
                metadata_set(MetadataValue::DateTime(DateTimeValue { date, time })),
            ),
            (
                "time offset",
                TagKind::TimeOffset,
                metadata_set(MetadataValue::TimeOffset(offset)),
            ),
            (
                "struct",
                TagKind::Struct(BTreeMap::new()),
                metadata_set(MetadataValue::Struct(structure)),
            ),
            ("null set", TagKind::Text, metadata_set(MetadataValue::Null)),
            (
                "binary rejection",
                TagKind::Text,
                metadata_set(MetadataValue::Binary),
            ),
            (
                "unknown rejection",
                TagKind::Text,
                metadata_set(MetadataValue::Unknown {
                    expected: Some(TagKind::Text),
                    raw: serde_json::json!({ "raw": true }),
                    reason: Some("test reason".to_owned()),
                }),
            ),
        ];

        for (case, kind, edit) in cases {
            let mut info = target_test_info(None);
            info.group = "IFD0".to_owned();
            info.name = "XResolution".to_owned();
            info.kind = kind;
            let mut occurrence = target_test_occurrence("IFD0");
            occurrence.tag_info = Some(info.clone());
            let existing = existing_target(&occurrence);
            let new_property = new_property_target(&info);
            let legacy = build_metadata_args(&info.id, &info, &edit);
            let existing_result = build_existing_occurrence_args(&existing, &occurrence, &edit);
            let new_result = build_new_property_args(&new_property, &info, &edit);

            match legacy {
                Ok(expected) => {
                    assert_eq!(existing_result, Ok(expected.clone()), "existing {case}");
                    assert_eq!(new_result, Ok(expected), "new property {case}");
                }
                Err(expected) => {
                    assert_eq!(
                        existing_result,
                        Err(MetadataTargetWriteError::ValueEncoding(expected.clone())),
                        "existing {case}"
                    );
                    assert_eq!(
                        new_result,
                        Err(MetadataTargetWriteError::ValueEncoding(expected)),
                        "new property {case}"
                    );
                }
            }
        }
    }
}
