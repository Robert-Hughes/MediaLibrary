//! Semantic metadata value rendering for ExifTool's raw write boundary.

use super::normalise_storage_string_for_kind;
use crate::metadata_value::{
    is_exiftool_language_identifier, DateTimeValue, DateValue, MetadataValue, OffsetSign,
    TimeValue, UtcOffsetValue,
};
use crate::tag_schema::TagKind;

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

pub(super) fn render_metadata_scalar_raw(
    value: &MetadataValue,
    kind: Option<&TagKind>,
) -> Result<String, String> {
    match value {
        MetadataValue::Bool(b) => Ok(if *b { "1".into() } else { "0".into() }),
        MetadataValue::Text(s) => Ok(normalise_storage_string_for_kind(s, kind)),
        MetadataValue::List { .. } => Err("nested list cannot be rendered as scalar".into()),
        MetadataValue::Struct(map) => render_metadata_struct(map),
        other => render_metadata_value_for_write(other, kind),
    }
}

#[derive(Clone, Copy)]
enum ExifToolStructStringContext {
    StructFieldValue,
    ListItem,
}

/// Escape a string using ExifTool's default structured-information syntax.
///
/// This is distinct from shell quoting and from the C escaping applied later
/// to assignment values transported through an ExifTool `-@` argfile with
/// `-ec`.
/// ExifTool structure strings use `|` as their escape character:
/// https://exiftool.org/struct.html#Serialization
fn escape_exiftool_struct_string(s: &str, context: ExifToolStructStringContext) -> String {
    let mut out = String::with_capacity(s.len());
    for (index, c) in s.chars().enumerate() {
        let closes_container = match context {
            ExifToolStructStringContext::StructFieldValue => c == '}',
            ExifToolStructStringContext::ListItem => c == ']',
        };
        let special_at_start =
            index == 0 && (matches!(c, '{' | '[') || matches!(c, ' ' | '\t' | '\r' | '\n'));
        if matches!(c, '|' | ',') || closes_container || special_at_start {
            out.push('|');
        }
        out.push(c);
    }
    out
}

fn validate_exiftool_struct_field_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, ',' | '=' | '{' | '}' | '[' | ']' | '|'))
    {
        return Err(format!(
            "invalid ExifTool structure field name for serialization: {name:?}"
        ));
    }
    Ok(())
}

pub(super) fn validate_exiftool_lang_alt_language(language: &str) -> Result<(), String> {
    if !is_exiftool_language_identifier(language) {
        return Err(format!(
            "invalid ExifTool language alternative identifier: {language:?}"
        ));
    }
    Ok(())
}

pub(super) fn render_metadata_struct(
    map: &std::collections::BTreeMap<String, MetadataValue>,
) -> Result<String, String> {
    fn render(
        value: &MetadataValue,
        context: ExifToolStructStringContext,
    ) -> Result<String, String> {
        match value {
            MetadataValue::Null => Ok(String::new()),
            MetadataValue::Text(s) => Ok(escape_exiftool_struct_string(s, context)),
            MetadataValue::Bool(b) => Ok(if *b { "1".into() } else { "0".into() }),
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
                    .map(|item| render(item, ExifToolStructStringContext::ListItem))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(",");
                Ok(format!("[{}]", inner))
            }
            MetadataValue::Struct(map) => render_metadata_struct(map),
            MetadataValue::LangAlt(_) => {
                Err("lang-alt requires a named struct field for serialization".into())
            }
            MetadataValue::Binary => Err("binary metadata is not writable".into()),
            MetadataValue::Unknown { .. } => Err("unknown metadata is not writable".into()),
        }
    }

    let mut rendered_fields = std::collections::BTreeMap::<String, String>::new();
    for (key, value) in map {
        validate_exiftool_struct_field_name(key)?;
        match value {
            MetadataValue::LangAlt(languages) => {
                // ExifTool represents a LangAlt member of a structure as
                // sibling fields: `LocationName` is x-default and
                // `LocationName-fr` is French. This form also keeps each
                // alternative attached to the correct item when the parent
                // structure is repeatable.
                for (language, text) in languages {
                    validate_exiftool_lang_alt_language(language)?;
                    let expanded_key = if language == "x-default" {
                        key.clone()
                    } else {
                        format!("{key}-{language}")
                    };
                    validate_exiftool_struct_field_name(&expanded_key)?;
                    if rendered_fields
                        .insert(
                            expanded_key.clone(),
                            escape_exiftool_struct_string(
                                text,
                                ExifToolStructStringContext::StructFieldValue,
                            ),
                        )
                        .is_some()
                    {
                        return Err(format!(
                            "duplicate ExifTool structure field after expanding language alternatives: {expanded_key:?}"
                        ));
                    }
                }
            }
            _ => {
                if rendered_fields
                    .insert(
                        key.clone(),
                        render(value, ExifToolStructStringContext::StructFieldValue)?,
                    )
                    .is_some()
                {
                    return Err(format!(
                        "duplicate ExifTool structure field during serialization: {key:?}"
                    ));
                }
            }
        }
    }

    let inner = rendered_fields
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("{{{}}}", inner))
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
