use crate::tag_schema::TagKind;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MetadataValue {
    Null,
    Text(String),
    Bool(bool),
    Integer(#[cfg_attr(test, ts(type = "number"))] i64),
    Real(f64),
    Rational(RationalValue),
    Date(DateValue),
    Time(TimeValue),
    DateTime(DateTimeValue),
    TimeOffset(UtcOffsetValue),
    LangAlt(BTreeMap<String, String>),
    List {
        list_kind: ListKind,
        items: Vec<MetadataValue>,
    },
    Struct(BTreeMap<String, MetadataValue>),
    Binary,
    Unknown {
        expected: Option<TagKind>,
        #[cfg_attr(
            test,
            ts(
                type = "null | boolean | number | string | Array<unknown> | { [key in string]?: unknown }"
            )
        )]
        raw: serde_json::Value,
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct RationalValue {
    pub numerator: i64,
    pub denominator: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct DateValue {
    pub year: i32,
    pub month: u8,
    pub day: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct TimeValue {
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub subsecond: Option<String>,
    pub offset: Option<UtcOffsetValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct DateTimeValue {
    pub date: DateValue,
    pub time: TimeValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct UtcOffsetValue {
    pub sign: OffsetSign,
    pub hours: u8,
    pub minutes: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum OffsetSign {
    Plus,
    Minus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum ListKind {
    Bag,
    Seq,
    Alt,
    Unknown,
}

pub fn parse_metadata_value(
    _key: &str,
    kind: Option<&TagKind>,
    raw: &serde_json::Value,
    display: Option<&serde_json::Value>,
) -> MetadataValue {
    let Some(kind) = kind else {
        return unknown(None, raw, "no schema entry for tag");
    };

    parse_known(kind, raw, display)
        .unwrap_or_else(|reason| unknown(Some(kind.clone()), raw, reason))
}

fn parse_known(
    kind: &TagKind,
    raw: &serde_json::Value,
    display: Option<&serde_json::Value>,
) -> Result<MetadataValue, String> {
    match kind {
        TagKind::Text => raw
            .as_str()
            .map(|s| MetadataValue::Text(s.to_string()))
            .ok_or_else(|| "expected JSON string for text tag".to_string()),
        TagKind::Boolean => raw
            .as_bool()
            .map(MetadataValue::Bool)
            .ok_or_else(|| "expected JSON bool for boolean tag".to_string()),
        TagKind::Integer { .. } => parse_i64(raw)
            .map(MetadataValue::Integer)
            .ok_or_else(|| "expected JSON integer for integer tag".to_string()),
        TagKind::Real => parse_f64(raw)
            .map(MetadataValue::Real)
            .ok_or_else(|| "expected JSON number for real tag".to_string()),
        TagKind::Rational => parse_rational(raw, display),
        TagKind::Date => raw
            .as_str()
            .and_then(parse_date)
            .map(MetadataValue::Date)
            .ok_or_else(|| "expected valid date string".to_string()),
        TagKind::Time => raw
            .as_str()
            .and_then(parse_time)
            .map(MetadataValue::Time)
            .ok_or_else(|| "expected valid time string".to_string()),
        TagKind::DateTime => raw
            .as_str()
            .and_then(parse_datetime)
            .map(MetadataValue::DateTime)
            .ok_or_else(|| "expected valid datetime string".to_string()),
        TagKind::TimeOffset => raw
            .as_str()
            .and_then(parse_offset)
            .map(MetadataValue::TimeOffset)
            .ok_or_else(|| "expected valid UTC offset string".to_string()),
        TagKind::LangAlt => parse_lang_alt(raw),
        TagKind::Bag(inner) => parse_list(ListKind::Bag, inner, raw),
        TagKind::Seq(inner) => parse_list(ListKind::Seq, inner, raw),
        TagKind::Alt(inner) => parse_list(ListKind::Alt, inner, raw),
        TagKind::Struct(fields) => parse_struct(fields, raw),
        TagKind::Binary => Ok(MetadataValue::Binary),
        TagKind::Enum { repr, .. } => match repr {
            crate::tag_schema::EnumRepr::Integer => parse_i64(raw)
                .map(MetadataValue::Integer)
                .or_else(|| raw.as_str().map(|s| MetadataValue::Text(s.to_string())))
                .ok_or_else(|| "expected integer or string enum value".to_string()),
            crate::tag_schema::EnumRepr::String => raw
                .as_str()
                .map(|s| MetadataValue::Text(s.to_string()))
                .ok_or_else(|| "expected string enum value".to_string()),
        },
        TagKind::Unknown => Err("schema kind is unknown".to_string()),
    }
}

fn unknown(
    expected: Option<TagKind>,
    raw: &serde_json::Value,
    reason: impl Into<String>,
) -> MetadataValue {
    MetadataValue::Unknown {
        expected,
        raw: raw.clone(),
        reason: Some(reason.into()),
    }
}

fn parse_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().and_then(|n| i64::try_from(n).ok()))
}

fn parse_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
}

fn parse_rational(
    raw: &serde_json::Value,
    display: Option<&serde_json::Value>,
) -> Result<MetadataValue, String> {
    if let Some(s) = display.and_then(|v| v.as_str()).or_else(|| raw.as_str()) {
        if let Some((n, d)) = s.split_once('/') {
            let numerator = n.trim().parse::<i64>().ok();
            let denominator = d.trim().parse::<i64>().ok();
            if let (Some(numerator), Some(denominator)) = (numerator, denominator) {
                if denominator != 0 {
                    return Ok(MetadataValue::Rational(RationalValue {
                        numerator,
                        denominator,
                    }));
                }
            }
        }
    }
    if let Some(n) = parse_i64(raw) {
        return Ok(MetadataValue::Rational(RationalValue {
            numerator: n,
            denominator: 1,
        }));
    }
    Err("could not recover exact rational numerator/denominator".to_string())
}

fn parse_lang_alt(raw: &serde_json::Value) -> Result<MetadataValue, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "expected language alternative object".to_string())?;
    let mut out = BTreeMap::new();
    for (lang, value) in obj {
        let Some(s) = value.as_str() else {
            return Err(format!("language alternative {lang} is not a string"));
        };
        out.insert(lang.clone(), s.to_string());
    }
    Ok(MetadataValue::LangAlt(out))
}

fn parse_list(
    list_kind: ListKind,
    inner: &TagKind,
    raw: &serde_json::Value,
) -> Result<MetadataValue, String> {
    let items = raw
        .as_array()
        .ok_or_else(|| "expected JSON array for list tag".to_string())?
        .iter()
        .map(|item| parse_known(inner, item, None))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MetadataValue::List { list_kind, items })
}

fn parse_struct(
    fields: &BTreeMap<String, TagKind>,
    raw: &serde_json::Value,
) -> Result<MetadataValue, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "expected JSON object for struct tag".to_string())?;
    let mut out = BTreeMap::new();
    for (key, value) in obj {
        let parsed = fields
            .get(key)
            .map(|kind| parse_known(kind, value, None))
            .unwrap_or_else(|| Ok(parse_json_shape(value)));
        out.insert(key.clone(), parsed?);
    }
    Ok(MetadataValue::Struct(out))
}

fn parse_json_shape(value: &serde_json::Value) -> MetadataValue {
    match value {
        serde_json::Value::Null => MetadataValue::Null,
        serde_json::Value::Bool(b) => MetadataValue::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n
                .as_i64()
                .or_else(|| n.as_u64().and_then(|u| i64::try_from(u).ok()))
            {
                MetadataValue::Integer(i)
            } else {
                MetadataValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => MetadataValue::Text(s.clone()),
        serde_json::Value::Array(items) => MetadataValue::List {
            list_kind: ListKind::Unknown,
            items: items.iter().map(parse_json_shape).collect(),
        },
        serde_json::Value::Object(obj) => MetadataValue::Struct(
            obj.iter()
                .map(|(k, v)| (k.clone(), parse_json_shape(v)))
                .collect(),
        ),
    }
}

fn parse_date(s: &str) -> Option<DateValue> {
    let s = s.trim();
    let (year, month, day) = if s.len() == 8 && s.chars().all(|c| c.is_ascii_digit()) {
        (&s[0..4], &s[4..6], &s[6..8])
    } else if s.len() >= 10
        && (&s[4..5] == ":" || &s[4..5] == "-")
        && (&s[7..8] == ":" || &s[7..8] == "-")
    {
        (&s[0..4], &s[5..7], &s[8..10])
    } else {
        return None;
    };
    let date = DateValue {
        year: year.parse().ok()?,
        month: month.parse().ok()?,
        day: day.parse().ok()?,
    };
    valid_date(&date).then_some(date)
}

fn parse_time(s: &str) -> Option<TimeValue> {
    let s = s.trim();
    let (main, offset) = split_offset(s);
    let parts: Vec<&str> = main.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let second_part = parts.get(2).copied().unwrap_or("0");
    let (second, subsecond) = if let Some((sec, sub)) = second_part.split_once('.') {
        (sec, Some(sub.to_string()))
    } else {
        (second_part, None)
    };
    let time = TimeValue {
        hour: parts[0].parse().ok()?,
        minute: parts[1].parse().ok()?,
        second: second.parse().ok()?,
        subsecond,
        offset,
    };
    valid_time(&time).then_some(time)
}

fn parse_datetime(s: &str) -> Option<DateTimeValue> {
    let s = s.trim();
    let sep_idx = s.find('T').or_else(|| s.find(' '))?;
    let date = parse_date(&s[..sep_idx])?;
    let time = parse_time(&s[sep_idx + 1..])?;
    Some(DateTimeValue { date, time })
}

fn split_offset(s: &str) -> (&str, Option<UtcOffsetValue>) {
    if let Some(rest) = s.strip_suffix('Z') {
        return (
            rest,
            Some(UtcOffsetValue {
                sign: OffsetSign::Plus,
                hours: 0,
                minutes: 0,
            }),
        );
    }
    for idx in (1..s.len()).rev() {
        let ch = s.as_bytes()[idx] as char;
        if ch == '+' || ch == '-' {
            if let Some(offset) = parse_offset(&s[idx..]) {
                return (&s[..idx], Some(offset));
            }
        }
    }
    (s, None)
}

fn parse_offset(s: &str) -> Option<UtcOffsetValue> {
    let sign = match s.as_bytes().first().copied()? as char {
        '+' => OffsetSign::Plus,
        '-' => OffsetSign::Minus,
        _ => return None,
    };
    let body = &s[1..];
    let (hours, minutes) = if let Some((h, m)) = body.split_once(':') {
        (h, m)
    } else if body.len() == 4 {
        (&body[0..2], &body[2..4])
    } else {
        return None;
    };
    let offset = UtcOffsetValue {
        sign,
        hours: hours.parse().ok()?,
        minutes: minutes.parse().ok()?,
    };
    (offset.hours <= 23 && offset.minutes <= 59).then_some(offset)
}

fn valid_date(date: &DateValue) -> bool {
    if !(1..=12).contains(&date.month) || date.day == 0 {
        return false;
    }
    let max_day = match date.month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(date.year) => 29,
        2 => 28,
        _ => return false,
    };
    date.day <= max_day
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn valid_time(time: &TimeValue) -> bool {
    time.hour <= 23 && time.minute <= 59 && time.second <= 60
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use ts_rs::TS;

    #[test]
    fn metadata_value_serde_is_discriminated() {
        let v = MetadataValue::Integer(5);
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json, json!({"kind":"Integer","value":5}));
        assert_eq!(serde_json::from_value::<MetadataValue>(json).unwrap(), v);
    }

    #[test]
    fn metadata_value_typescript_is_discriminated() {
        let decl = MetadataValue::decl();
        assert!(decl.contains(r#""kind": "Integer""#), "{decl}");
        assert!(decl.contains(r#""kind": "Real""#), "{decl}");
        assert!(decl.contains(r#""kind": "Rational""#), "{decl}");
        assert!(decl.contains(r#""kind": "LangAlt""#), "{decl}");
        assert!(decl.contains(r#""kind": "Struct""#), "{decl}");
    }

    #[test]
    fn text_parses_strings() {
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::Text), &json!("hello"), None),
            MetadataValue::Text("hello".into())
        );
    }

    #[test]
    fn integer_rejects_non_integral_float() {
        assert!(matches!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Integer {
                    min: None,
                    max: None
                }),
                &json!(1.5),
                None
            ),
            MetadataValue::Unknown {
                expected: Some(TagKind::Integer { .. }),
                ..
            }
        ));
    }

    #[test]
    fn real_parses_numbers() {
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::Real), &json!(2), None),
            MetadataValue::Real(2.0)
        );
    }

    #[test]
    fn rational_prefers_exact_display_fraction() {
        assert_eq!(
            parse_metadata_value(
                "EXIF:ExposureTime",
                Some(&TagKind::Rational),
                &json!(0.004),
                Some(&json!("1/250"))
            ),
            MetadataValue::Rational(RationalValue {
                numerator: 1,
                denominator: 250
            })
        );
    }

    #[test]
    fn date_time_and_datetime_parse_offsets_only_when_inline() {
        assert_eq!(
            parse_metadata_value(
                "IPTC:DateCreated",
                Some(&TagKind::Date),
                &json!("20260704"),
                None
            ),
            MetadataValue::Date(DateValue {
                year: 2026,
                month: 7,
                day: 4
            })
        );
        assert_eq!(
            parse_metadata_value(
                "IPTC:TimeCreated",
                Some(&TagKind::Time),
                &json!("10:56:05"),
                None
            ),
            MetadataValue::Time(TimeValue {
                hour: 10,
                minute: 56,
                second: 5,
                subsecond: None,
                offset: None
            })
        );
        assert_eq!(
            parse_metadata_value(
                "XMP:Date",
                Some(&TagKind::DateTime),
                &json!("2026-07-04T10:56:05+01:00"),
                None
            ),
            MetadataValue::DateTime(DateTimeValue {
                date: DateValue {
                    year: 2026,
                    month: 7,
                    day: 4
                },
                time: TimeValue {
                    hour: 10,
                    minute: 56,
                    second: 5,
                    subsecond: None,
                    offset: Some(UtcOffsetValue {
                        sign: OffsetSign::Plus,
                        hours: 1,
                        minutes: 0
                    })
                }
            })
        );
    }

    #[test]
    fn offset_tags_parse_as_time_offset() {
        assert_eq!(
            parse_metadata_value(
                "ExifIFD:OffsetTimeOriginal",
                Some(&TagKind::TimeOffset),
                &json!("+01:00"),
                None
            ),
            MetadataValue::TimeOffset(UtcOffsetValue {
                sign: OffsetSign::Plus,
                hours: 1,
                minutes: 0
            })
        );
    }

    #[test]
    fn no_schema_becomes_unknown_without_text_coercion() {
        assert!(matches!(
            parse_metadata_value("MadeUp:Thing", None, &json!("raw"), None),
            MetadataValue::Unknown { expected: None, raw, .. } if raw == json!("raw")
        ));
    }

    #[test]
    fn lang_alt_and_lists_preserve_semantics() {
        let mut langs = BTreeMap::new();
        langs.insert("x-default".to_string(), "Hi".to_string());
        assert_eq!(
            parse_metadata_value(
                "XMP-dc:Description",
                Some(&TagKind::LangAlt),
                &json!({"x-default":"Hi"}),
                None
            ),
            MetadataValue::LangAlt(langs)
        );
        assert_eq!(
            parse_metadata_value(
                "XMP-dc:Subject",
                Some(&TagKind::Bag(Box::new(TagKind::Text))),
                &json!(["a", "b"]),
                None
            ),
            MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![
                    MetadataValue::Text("a".into()),
                    MetadataValue::Text("b".into())
                ]
            }
        );
    }

    #[test]
    fn structs_parse_unknown_fields_without_stringifying_scalars() {
        let value = parse_metadata_value(
            "X:Struct",
            Some(&TagKind::Struct(BTreeMap::new())),
            &json!({"Name":"Ada","Score":5,"Nested":{"Ok":true}}),
            None,
        );
        let MetadataValue::Struct(map) = value else {
            panic!("expected struct");
        };
        assert_eq!(map["Score"], MetadataValue::Integer(5));
        assert!(matches!(map["Nested"], MetadataValue::Struct(_)));
    }

    #[test]
    fn binary_is_semantic_readonly_marker() {
        assert_eq!(
            parse_metadata_value(
                "File:PreviewImage",
                Some(&TagKind::Binary),
                &json!("anything"),
                None
            ),
            MetadataValue::Binary
        );
    }
}
