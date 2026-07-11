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

pub trait WriteTarget<'a> {
    fn resolve(self) -> Result<(SchemaDefinitionId, &'a TagInfo, String), String>;
}

impl<'a> WriteTarget<'a> for (&'a SchemaDefinitionId, &'a TagInfo) {
    fn resolve(self) -> Result<(SchemaDefinitionId, &'a TagInfo, String), String> {
        Ok((self.0.clone(), self.1, self.1.exiftool_write_name()))
    }
}

#[cfg(test)]
impl<'a> WriteTarget<'a> for (&'a str, Option<&'a TagInfo>) {
    fn resolve(self) -> Result<(SchemaDefinitionId, &'a TagInfo, String), String> {
        let info = self
            .1
            .ok_or_else(|| format!("missing schema for {}", self.0))?;
        Ok((info.id.clone(), info, self.0.to_string()))
    }
}

pub fn build_metadata_args<'a, A, B>(
    id: A,
    info: B,
    edit: &MetadataDraftEdit,
) -> Result<BuiltArgs, String>
where
    (A, B): WriteTarget<'a>,
{
    let (id, info, tag) = (id, info).resolve()?;
    if info.id != id {
        return Err(format!(
            "schema identity mismatch: requested {id:?}, got {:?}",
            info.id
        ));
    }
    if !info.writable {
        return Err(format!("{} ({id:?}) is read-only", info.display_name()));
    }
    let tag = tag.as_str();
    if tag.is_empty() || tag.contains('\n') || tag.contains('\0') {
        return Ok(BuiltArgs::default());
    }

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
    use crate::metadata_value::ListKind;
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
        let args =
            build_metadata_args("XMP-dc:Title", Some(&i), &metadata_set(text("hi"))).unwrap();
        assert!(args.numeric.is_empty());
        assert_eq!(args.text, vec!["-XMP-dc:Title=hi"]);
    }

    #[test]
    fn gps_version_id_text_uses_spaced_raw_value() {
        let i = info_named("GPS", "GPSVersionID", TagKind::Text);
        let args =
            build_metadata_args("GPS:GPSVersionID", Some(&i), &metadata_set(text("2 3 0 0")))
                .unwrap();
        assert_eq!(args.text, vec!["-GPS:GPSVersionID=2 3 0 0"]);
        assert!(args.numeric.is_empty());
    }

    #[test]
    fn set_integer_yields_numeric_arg() {
        let i = info(TagKind::Integer {
            min: None,
            max: None,
        });
        let args = build_metadata_args(
            "XMP-xmp:Rating",
            Some(&i),
            &metadata_set(MetadataValue::Integer(5)),
        )
        .unwrap();
        assert!(args.text.is_empty());
        assert_eq!(args.numeric, vec!["-XMP-xmp:Rating=5"]);
    }

    #[test]
    fn set_boolean_uses_1_0_in_numeric_group() {
        let i = info(TagKind::Boolean);
        let args = build_metadata_args(
            "XMP-xmpRights:Marked",
            Some(&i),
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
        let args = build_metadata_args(
            "IFD0:Orientation",
            Some(&i),
            &metadata_set(MetadataValue::Integer(6)),
        )
        .unwrap();
        assert_eq!(args.numeric, vec!["-IFD0:Orientation=6"]);
    }

    #[test]
    fn set_bag_emits_clear_then_repeated_args() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_metadata_args(
            "XMP-dc:Subject",
            Some(&i),
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
        let args = build_metadata_args(
            "XMP-dc:Creator",
            Some(&i),
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
        let args =
            build_metadata_args("XMP-dc:Subject", Some(&i), &metadata_set(text("only"))).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Subject=", "-XMP-dc:Subject=only"]);
    }

    #[test]
    fn set_langalt_with_object_emits_per_lang_args() {
        let i = info(TagKind::LangAlt);
        let mut langs = BTreeMap::new();
        langs.insert("x-default".to_string(), "Hi".to_string());
        langs.insert("en".to_string(), "Hi".to_string());
        langs.insert("fr".to_string(), "Salut".to_string());
        let args = build_metadata_args(
            "XMP-dc:Description",
            Some(&i),
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
        let args = build_metadata_args(
            "XMP-dc:Description",
            Some(&i),
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
        let args = build_metadata_args("XMP-dc:Title", Some(&i), &metadata_delete()).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Title="]);
        assert!(args.numeric.is_empty());
    }

    #[test]
    fn listadd_on_bag_emits_plus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_metadata_args(
            "XMP-dc:Subject",
            Some(&i),
            &metadata_list_add(bag_text(&["a", "b"])),
        )
        .unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Subject+=a", "-XMP-dc:Subject+=b"]);
    }

    #[test]
    fn listremove_on_bag_emits_minus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_metadata_args(
            "XMP-dc:Subject",
            Some(&i),
            &metadata_list_remove(text("old")),
        )
        .unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Subject-=old"]);
    }

    #[test]
    fn list_op_on_non_list_tag_degrades_safely() {
        let i = info(TagKind::Text);
        // ListAdd on a Text tag becomes a Set.
        let args =
            build_metadata_args("XMP-dc:Title", Some(&i), &metadata_list_add(text("hi"))).unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Title=hi"]);
        // ListRemove on a Text tag becomes a Delete.
        let args = build_metadata_args("XMP-dc:Title", Some(&i), &metadata_list_remove(text("hi")))
            .unwrap();
        assert_eq!(args.text, vec!["-XMP-dc:Title="]);
    }

    #[test]
    fn unknown_tag_falls_back_to_text() {
        let err = build_metadata_args(
            "MakerNotes:CustomCameraField",
            None,
            &metadata_set(text("abc")),
        )
        .unwrap_err();
        assert!(err.contains("missing schema"));
    }

    #[test]
    fn binary_tag_yields_no_args() {
        let i = info(TagKind::Binary);
        let err =
            build_metadata_args("Thumbnail:Bin", Some(&i), &metadata_set(text("x"))).unwrap_err();
        assert!(err.contains("binary"));
    }

    #[test]
    fn invalid_tag_name_yields_no_args() {
        let i = info(TagKind::Text);
        let args = build_metadata_args("bad\nname", Some(&i), &metadata_set(text("x"))).unwrap();
        assert!(args.is_empty());
        let args = build_metadata_args("", Some(&i), &metadata_set(text("x"))).unwrap();
        assert!(args.is_empty());
    }

    #[test]
    fn float_renders_decimal_in_numeric_group() {
        let i = info(TagKind::Real);
        let args = build_metadata_args(
            "Composite:GPSAltitude",
            Some(&i),
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
                build_metadata_args(tag, Some(&i), &metadata_set(MetadataValue::Real(value)))
                    .unwrap();
            assert_eq!(args.numeric, vec![expected]);
            assert!(args.text.is_empty());
        }
    }

    #[test]
    fn datetime_uses_numeric_group() {
        // Phase 8.7: design §6 puts DateTime in the -n group so the literal
        // YYYY:MM:DD HH:MM:SS±ZZ:ZZ form bypasses PrintConv re-parsing.
        let i = info(TagKind::DateTime);
        let args = build_metadata_args(
            "ExifIFD:DateTimeOriginal",
            Some(&i),
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
        let args = build_metadata_args(
            "XMP-mlib:AIGeneratedAt",
            Some(&i),
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
        let args = build_metadata_args(
            "IPTC:DateCreated",
            Some(&i),
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
        let args = build_metadata_args(
            "IPTC:TimeCreated",
            Some(&i),
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
        let args = build_metadata_args(
            "XMP-dc:Subject",
            Some(&i),
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
        let args = build_metadata_args(
            "XMP-dc:Title",
            Some(&i),
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
        let args = build_metadata_args(
            "X:Numbers",
            Some(&i),
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
        let args = build_metadata_args(
            "EXIF:ExposureTime",
            Some(&i),
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
        let err = build_metadata_args(
            "File:PreviewImage",
            Some(&binary),
            &metadata_set(MetadataValue::Binary),
        )
        .unwrap_err();
        assert!(err.contains("binary"));

        let text = info(TagKind::Text);
        let err = build_metadata_args(
            "X:Bad",
            Some(&text),
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
        let args = build_metadata_args(
            "EXIF:ExposureTime",
            Some(&i),
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
        let args = build_metadata_args(
            "XMP-mwg-rs:Region",
            Some(&i),
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
        let args = build_metadata_args(
            "X:R",
            Some(&i),
            &metadata_set(MetadataValue::Struct(region)),
        )
        .unwrap();
        assert_eq!(args.text, vec!["-X:R={Area={X=0.5,Y=0.5},Names=[a,b]}"]);
    }

    #[test]
    fn struct_render_escapes_metacharacters_in_scalars() {
        let mut o = BTreeMap::new();
        // Value containing every metachar exiftool struct parser cares about.
        o.insert("k".to_string(), text("a,b{c}d[e]f=g\\h"));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args =
            build_metadata_args("X:S", Some(&i), &metadata_set(MetadataValue::Struct(o))).unwrap();
        assert_eq!(args.text, vec![r"-X:S={k=a\,b\{c\}d\[e\]f\=g\\h}"]);
    }

    #[test]
    fn struct_render_empty_object_and_list() {
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_metadata_args(
            "X:S",
            Some(&i),
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
}
