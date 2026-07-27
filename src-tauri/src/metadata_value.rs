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
    #[cfg_attr(test, ts(type = "number"))]
    pub numerator: i64,
    #[cfg_attr(test, ts(type = "number"))]
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

fn json_type_name(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

fn gcd(mut a: i64, mut b: i64) -> i64 {
    while b != 0 {
        let temp = b;
        b = a % b;
        a = temp;
    }
    a.abs()
}

fn parse_decimal_caps(caps: &regex::Captures) -> Option<RationalValue> {
    let sign = caps.get(1).map_or("", |m| m.as_str());
    let int_part = caps.get(2).map_or("", |m| m.as_str());
    let frac_part = caps.get(3).map_or("", |m| m.as_str());
    if frac_part.is_empty() || frac_part.len() > 15 {
        return None;
    }
    let int_val = if int_part.is_empty() {
        0
    } else {
        int_part.parse::<i64>().ok()?
    };
    let frac_val = frac_part.parse::<i64>().ok()?;
    let denominator = 10i64.checked_pow(frac_part.len() as u32)?;
    let numerator = int_val.checked_mul(denominator)?.checked_add(frac_val)?;
    let mut numerator = numerator;
    if sign == "-" {
        numerator = -numerator;
    }
    let g = gcd(numerator, denominator);
    let mut num = numerator / g;
    let mut den = denominator / g;
    if den < 0 {
        num = -num;
        den = -den;
    }
    Some(RationalValue {
        numerator: num,
        denominator: den,
    })
}

fn parse_known(
    kind: &TagKind,
    raw: &serde_json::Value,
    display: Option<&serde_json::Value>,
) -> Result<MetadataValue, String> {
    match kind {
        TagKind::Text => match raw {
            serde_json::Value::String(s) => Ok(MetadataValue::Text(s.clone())),
            serde_json::Value::Number(n) => Ok(MetadataValue::Text(n.to_string())),
            serde_json::Value::Bool(b) => Ok(MetadataValue::Text(b.to_string())),
            _ => Err(format!("expected text scalar, got {}", json_type_name(raw))),
        },
        TagKind::Boolean => raw
            .as_bool()
            .map(MetadataValue::Bool)
            .ok_or_else(|| "expected JSON bool for boolean tag".to_string()),
        TagKind::Integer { .. } => parse_i64(raw).map(MetadataValue::Integer).ok_or_else(|| {
            format!(
                "expected integer for integer tag, got {}",
                json_type_name(raw)
            )
        }),
        TagKind::Real => parse_f64(raw).map(MetadataValue::Real).ok_or_else(|| {
            "expected finite JSON number or numeric string for real tag".to_string()
        }),
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
                .ok_or_else(|| {
                    format!(
                        "expected integer or string enum value, got {}",
                        json_type_name(raw)
                    )
                }),
            crate::tag_schema::EnumRepr::String => match raw {
                serde_json::Value::String(s) => Ok(MetadataValue::Text(s.clone())),
                serde_json::Value::Number(n) => Ok(MetadataValue::Text(n.to_string())),
                serde_json::Value::Bool(b) => Ok(MetadataValue::Text(b.to_string())),
                _ => Err(format!(
                    "expected string enum value, got {}",
                    json_type_name(raw)
                )),
            },
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
    match v {
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i)
            } else if let Some(u) = n.as_u64() {
                i64::try_from(u).ok()
            } else if let Some(f) = n.as_f64() {
                if f.is_finite()
                    && f.fract() == 0.0
                    && f >= (i64::MIN as f64)
                    && f <= (i64::MAX as f64)
                {
                    Some(f as i64)
                } else {
                    None
                }
            } else {
                None
            }
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            trimmed.parse::<i64>().ok()
        }
        _ => None,
    }
}

fn parse_f64(v: &serde_json::Value) -> Option<f64> {
    let value = match v {
        serde_json::Value::Number(_) => v.as_f64()?,
        // ExifTool quotes values with more than 16 fractional digits in JSON
        // to protect consumers that cannot preserve their precision.
        serde_json::Value::String(value) => value.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    value.is_finite().then_some(value)
}

fn parse_rational(
    raw: &serde_json::Value,
    display: Option<&serde_json::Value>,
) -> Result<MetadataValue, String> {
    if let Some(s) = display.and_then(|v| v.as_str()).or_else(|| raw.as_str()) {
        let s = s.trim();
        static FRACTION_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let fraction_re = FRACTION_RE.get_or_init(|| {
            regex::Regex::new(r"^\s*([+-]?\d+)\s*/\s*([+-]?\d+)")
                .expect("static fraction regex must compile")
        });
        if let Some(caps) = fraction_re.captures(s) {
            let n = caps.get(1).unwrap().as_str().parse::<i64>().ok();
            let d = caps.get(2).unwrap().as_str().parse::<i64>().ok();
            if let (Some(numerator), Some(denominator)) = (n, d) {
                if denominator != 0 {
                    let g = gcd(numerator, denominator);
                    let mut num = numerator / g;
                    let mut den = denominator / g;
                    if den < 0 {
                        num = -num;
                        den = -den;
                    }
                    return Ok(MetadataValue::Rational(RationalValue {
                        numerator: num,
                        denominator: den,
                    }));
                }
            }
        }
        static DECIMAL_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let decimal_re = DECIMAL_RE.get_or_init(|| {
            regex::Regex::new(r"^\s*([+-]?)\s*(\d*)\.(\d+)\s*$")
                .expect("static decimal regex must compile")
        });
        if let Some(caps) = decimal_re.captures(s) {
            if let Some(rational) = parse_decimal_caps(&caps) {
                return Ok(MetadataValue::Rational(rational));
            }
        }
        if let Ok(n) = s.parse::<i64>() {
            return Ok(MetadataValue::Rational(RationalValue {
                numerator: n,
                denominator: 1,
            }));
        }
    }

    if let serde_json::Value::Number(n) = raw {
        if let Some(i) = parse_i64(raw) {
            return Ok(MetadataValue::Rational(RationalValue {
                numerator: i,
                denominator: 1,
            }));
        }
        let s = n.to_string();
        static DECIMAL_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let decimal_re = DECIMAL_RE.get_or_init(|| {
            regex::Regex::new(r"^\s*([+-]?)\s*(\d*)\.(\d+)\s*$")
                .expect("static decimal regex must compile")
        });
        if let Some(caps) = decimal_re.captures(&s) {
            if let Some(rational) = parse_decimal_caps(&caps) {
                return Ok(MetadataValue::Rational(rational));
            }
        }
    }

    Err("could not recover exact rational numerator/denominator".to_string())
}

fn parse_lang_alt(raw: &serde_json::Value) -> Result<MetadataValue, String> {
    if let Some(s) = raw.as_str() {
        let mut out = BTreeMap::new();
        out.insert("x-default".to_string(), s.to_string());
        return Ok(MetadataValue::LangAlt(out));
    }
    let obj = raw.as_object().ok_or_else(|| {
        format!(
            "expected language alternative object or string, got {}",
            json_type_name(raw)
        )
    })?;
    let mut out = BTreeMap::new();
    for (lang, value) in obj {
        let Some(s) = value.as_str() else {
            return Err(format!("language alternative {lang} is not a string"));
        };
        out.insert(lang.clone(), s.to_string());
    }
    Ok(MetadataValue::LangAlt(out))
}

/// Combined view of ExifTool's flattened fragments for one logical LangAlt.
///
/// ExifTool exposes both top-level and structured language alternatives as
/// separate `Tag`, `Tag-fr`, ... values. Keeping the merge and conflict rule
/// here prevents those two read paths from interpreting the same XMP shape
/// differently.
pub(crate) struct ConsolidatedLangAlt {
    pub languages: BTreeMap<String, String>,
    pub observed: BTreeMap<String, Vec<String>>,
    pub conflicting_languages: Vec<String>,
}

pub(crate) fn consolidate_lang_alt_maps<'a>(
    fragments: impl IntoIterator<Item = &'a BTreeMap<String, String>>,
) -> ConsolidatedLangAlt {
    let mut observed = BTreeMap::<String, Vec<String>>::new();
    for fragment in fragments {
        for (language, text) in fragment {
            let values = observed.entry(language.clone()).or_default();
            if !values.contains(text) {
                values.push(text.clone());
            }
        }
    }
    let conflicting_languages = observed
        .iter()
        .filter(|(_, values)| values.len() > 1)
        .map(|(language, _)| language.clone())
        .collect::<Vec<_>>();
    let languages = observed
        .iter()
        .filter_map(|(language, values)| {
            values.first().map(|text| (language.clone(), text.clone()))
        })
        .collect();
    ConsolidatedLangAlt {
        languages,
        observed,
        conflicting_languages,
    }
}

/// ExifTool appends XMP language identifiers to flattened tag and field
/// names. Keep recognition and write validation aligned for top-level and
/// structured LangAlt values. This accepts the ASCII alphanumeric and hyphen
/// form used by BCP 47 tags, including `x-default`, script and region subtags.
pub(crate) fn is_exiftool_language_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .split('-')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()))
}

fn parse_list(
    list_kind: ListKind,
    inner: &TagKind,
    raw: &serde_json::Value,
) -> Result<MetadataValue, String> {
    if let Some(arr) = raw.as_array() {
        let items = arr
            .iter()
            .map(|item| parse_known(inner, item, None))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MetadataValue::List { list_kind, items })
    } else {
        let item = parse_known(inner, raw, None).map_err(|_| {
            format!(
                "expected array or scalar list item, got {}",
                json_type_name(raw)
            )
        })?;
        Ok(MetadataValue::List {
            list_kind,
            items: vec![item],
        })
    }
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
        if matches!(fields.get(key), Some(TagKind::LangAlt)) {
            let MetadataValue::LangAlt(languages) = parse_lang_alt(value)? else {
                unreachable!("parse_lang_alt always returns LangAlt")
            };
            merge_struct_lang_alt(&mut out, key, languages)?;
            continue;
        }

        // ExifTool flattens language alternatives nested in an XMP
        // structure into sibling fields. For example, the structured JSON
        // representation uses `LocationName` for x-default and
        // `LocationName-fr` for French. Reconstitute those siblings into the
        // LangAlt shape described by the schema so read/write verification
        // sees the same typed value that was written.
        let lang_alt_parent = fields
            .iter()
            .filter(|(_, kind)| matches!(kind, TagKind::LangAlt))
            .filter_map(|(field, _)| {
                key.strip_prefix(field)
                    .and_then(|suffix| suffix.strip_prefix('-'))
                    .filter(|language| is_exiftool_language_identifier(language))
                    .map(|language| (field, language))
            })
            .max_by_key(|(field, _)| field.len());
        if let Some((field, language)) = lang_alt_parent {
            let text = value.as_str().ok_or_else(|| {
                format!("language alternative {key} in struct field {field} is not a string")
            })?;
            merge_struct_lang_alt(
                &mut out,
                field,
                BTreeMap::from([(language.to_string(), text.to_string())]),
            )?;
            continue;
        }

        let parsed = fields
            .get(key)
            .map(|kind| parse_known(kind, value, None))
            .unwrap_or_else(|| Ok(parse_json_shape(value)));
        out.insert(key.clone(), parsed?);
    }
    Ok(MetadataValue::Struct(out))
}

fn merge_struct_lang_alt(
    out: &mut BTreeMap<String, MetadataValue>,
    field: &str,
    languages: BTreeMap<String, String>,
) -> Result<(), String> {
    let entry = out
        .entry(field.to_string())
        .or_insert_with(|| MetadataValue::LangAlt(BTreeMap::new()));
    let MetadataValue::LangAlt(existing) = entry else {
        return Err(format!(
            "struct field {field} mixes language alternatives with another value"
        ));
    };
    let consolidated = consolidate_lang_alt_maps([&*existing, &languages]);
    if !consolidated.conflicting_languages.is_empty() {
        return Err(format!(
            "struct field {field} has conflicting {} language alternatives",
            consolidated.conflicting_languages.join(", ")
        ));
    }
    *existing = consolidated.languages;
    Ok(())
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
    fn real_parses_high_precision_numeric_string_from_exiftool() {
        assert_eq!(
            parse_metadata_value(
                "GPS:GPSLongitude",
                Some(&TagKind::Real),
                &json!("0.00959444444444444"),
                None
            ),
            MetadataValue::Real(0.00959444444444444)
        );
    }

    #[test]
    fn gps_version_id_raw_string_parses_as_text() {
        assert_eq!(
            parse_metadata_value(
                "GPS:GPSVersionID",
                Some(&TagKind::Text),
                &json!("2 2 0 0"),
                Some(&json!("2.2.0.0")),
            ),
            MetadataValue::Text("2 2 0 0".to_string())
        );
    }

    #[test]
    fn gps_real_schema_parses_scalar_numbers_as_reals() {
        assert_eq!(
            parse_metadata_value(
                "GPS:GPSLatitude",
                Some(&TagKind::Real),
                &json!(52.2037391662611),
                None
            ),
            MetadataValue::Real(52.2037391662611)
        );
        assert_eq!(
            parse_metadata_value(
                "GPS:GPSLongitude",
                Some(&TagKind::Real),
                &json!(0.123724997044444),
                None
            ),
            MetadataValue::Real(0.123724997044444)
        );
        assert_eq!(
            parse_metadata_value("GPS:GPSAltitude", Some(&TagKind::Real), &json!(123.4), None),
            MetadataValue::Real(123.4)
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
    fn struct_parser_consolidates_flattened_lang_alt_members() {
        let kind = TagKind::Struct(BTreeMap::from([
            ("City".into(), TagKind::Text),
            ("LocationName".into(), TagKind::LangAlt),
        ]));
        let parsed = parse_metadata_value(
            "XMP-iptcExt:LocationCreated",
            Some(&kind),
            &json!({
                "City": "Cambridge",
                "LocationName": "Default name",
                "LocationName-fr": "Nom français",
                "LocationName-zh-Hant": "繁體名稱"
            }),
            None,
        );

        assert_eq!(
            parsed,
            MetadataValue::Struct(BTreeMap::from([
                ("City".into(), MetadataValue::Text("Cambridge".into())),
                (
                    "LocationName".into(),
                    MetadataValue::LangAlt(BTreeMap::from([
                        ("fr".into(), "Nom français".into()),
                        ("x-default".into(), "Default name".into()),
                        ("zh-Hant".into(), "繁體名稱".into()),
                    ])),
                ),
            ]))
        );
    }

    #[test]
    fn struct_parser_rejects_conflicting_flattened_lang_alt_members() {
        let kind = TagKind::Struct(BTreeMap::from([("LocationName".into(), TagKind::LangAlt)]));
        let parsed = parse_known(
            &kind,
            &json!({
                "LocationName": {"fr": "first"},
                "LocationName-fr": "second"
            }),
            None,
        );

        assert_eq!(
            parsed.unwrap_err(),
            "struct field LocationName has conflicting fr language alternatives"
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

    #[test]
    fn improved_parsing_checks() {
        use crate::tag_schema::EnumRepr;

        // 1. Integer tests
        // integer accepts numeric string
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Integer {
                    min: None,
                    max: None
                }),
                &json!("6"),
                None
            ),
            MetadataValue::Integer(6)
        );
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Integer {
                    min: None,
                    max: None
                }),
                &json!("+6"),
                None
            ),
            MetadataValue::Integer(6)
        );
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Integer {
                    min: None,
                    max: None
                }),
                &json!("-6"),
                None
            ),
            MetadataValue::Integer(-6)
        );
        // integer accepts integral real
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Integer {
                    min: None,
                    max: None
                }),
                &json!(6.0),
                None
            ),
            MetadataValue::Integer(6)
        );
        // integer still returns Unknown for "Auto" with a useful reason
        let v_auto = parse_metadata_value(
            "X",
            Some(&TagKind::Integer {
                min: None,
                max: None,
            }),
            &json!("Auto"),
            None,
        );
        assert!(
            matches!(v_auto, MetadataValue::Unknown { reason: Some(ref r), .. } if r == "expected integer for integer tag, got string")
        );

        // 2. Text tests
        // text accepts numeric scalar
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::Text), &json!(123), None),
            MetadataValue::Text("123".to_string())
        );
        // text accepts bool
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::Text), &json!(true), None),
            MetadataValue::Text("true".to_string())
        );
        // text with object still returns Unknown
        let v_obj = parse_metadata_value("X", Some(&TagKind::Text), &json!({"a": 1}), None);
        assert!(
            matches!(v_obj, MetadataValue::Unknown { reason: Some(ref r), .. } if r == "expected text scalar, got object")
        );

        // 3. String Enum tests
        // string enum accepts numeric scalar
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Enum {
                    repr: EnumRepr::String,
                    options: Vec::new()
                }),
                &json!(1),
                None
            ),
            MetadataValue::Text("1".to_string())
        );
        // string enum accepts bool
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Enum {
                    repr: EnumRepr::String,
                    options: Vec::new()
                }),
                &json!(true),
                None
            ),
            MetadataValue::Text("true".to_string())
        );
        // integer enum with raw string "6" -> Integer(6)
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Enum {
                    repr: EnumRepr::Integer,
                    options: Vec::new()
                }),
                &json!("6"),
                None
            ),
            MetadataValue::Integer(6)
        );

        // 4. List tests
        // Bag<Text> with raw "keyword" -> list with one text item
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Bag(Box::new(TagKind::Text))),
                &json!("keyword"),
                None
            ),
            MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![MetadataValue::Text("keyword".to_string())]
            }
        );
        // Bag<Text> with raw 123 -> list with one text item "123"
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Bag(Box::new(TagKind::Text))),
                &json!(123),
                None
            ),
            MetadataValue::List {
                list_kind: ListKind::Bag,
                items: vec![MetadataValue::Text("123".to_string())]
            }
        );

        // 5. LangAlt tests
        // LangAlt string "Caption" -> { "x-default": "Caption" }
        let mut expected_lang = BTreeMap::new();
        expected_lang.insert("x-default".to_string(), "Caption".to_string());
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::LangAlt), &json!("Caption"), None),
            MetadataValue::LangAlt(expected_lang)
        );

        // 6. Rational tests
        // rational display "1/250 sec" + raw 0.004 -> Rational(1, 250)
        assert_eq!(
            parse_metadata_value(
                "X",
                Some(&TagKind::Rational),
                &json!(0.004),
                Some(&json!("1/250 sec"))
            ),
            MetadataValue::Rational(RationalValue {
                numerator: 1,
                denominator: 250
            })
        );
        // rational raw 0.004 without display -> Rational(1, 250)
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::Rational), &json!(0.004), None),
            MetadataValue::Rational(RationalValue {
                numerator: 1,
                denominator: 250
            })
        );
        // rational raw string "2.8" -> Rational(14, 5)
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::Rational), &json!("2.8"), None),
            MetadataValue::Rational(RationalValue {
                numerator: 14,
                denominator: 5
            })
        );
        // rational raw integer 2 -> Rational(2, 1)
        assert_eq!(
            parse_metadata_value("X", Some(&TagKind::Rational), &json!(2), None),
            MetadataValue::Rational(RationalValue {
                numerator: 2,
                denominator: 1
            })
        );
        // rational invalid string "unknown" still returns Unknown
        let v_rat_err =
            parse_metadata_value("X", Some(&TagKind::Rational), &json!("unknown"), None);
        assert!(
            matches!(v_rat_err, MetadataValue::Unknown { reason: Some(ref r), .. } if r == "could not recover exact rational numerator/denominator")
        );
    }
}
