//! Group H - Dates (H1 Shutter + H2 Digitised).
//!
//! The normaliser consumes semantic `MetadataValue` inputs. EXIF offset tags
//! such as `ExifIFD:OffsetTimeOriginal` remain separate metadata values; they
//! are used only as a local comparison/projection hint.

use super::{DatesInput, GroupOutput};
use crate::draft_edits::{EditIntent, MetadataDraftEdit, SchemaMetadataEditMap};
use crate::known_ids;
use crate::metadata_value::{
    DateTimeValue, DateValue, MetadataValue, OffsetSign, TimeValue, UtcOffsetValue,
};
use crate::tag_schema::SchemaDefinitionId;
use chrono::Offset;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
struct ComparableTimestamp {
    datetime: DateTimeValue,
    offset_from_related_tag: Option<UtcOffsetValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimestampComparison {
    Equivalent,
    Conflict,
}

impl ComparableTimestamp {
    fn effective_offset(&self) -> Option<&UtcOffsetValue> {
        self.datetime
            .time
            .offset
            .as_ref()
            .or(self.offset_from_related_tag.as_ref())
    }

    fn without_inline_offset(&self) -> DateTimeValue {
        let mut dt = self.datetime.clone();
        dt.time.offset = None;
        dt
    }

    fn with_effective_offset(&self) -> DateTimeValue {
        let mut dt = self.datetime.clone();
        dt.time.offset = self.effective_offset().cloned();
        dt
    }

    fn date(&self) -> DateValue {
        self.datetime.date.clone()
    }

    fn time_with_iptc_offset(
        &self,
        existing_iptc_offset: Option<&UtcOffsetValue>,
        fallback_offset: Option<&UtcOffsetValue>,
    ) -> TimeValue {
        let mut time = self.datetime.time.clone();
        time.offset = existing_iptc_offset
            .cloned()
            .or_else(|| self.effective_offset().cloned());
        if time.offset.is_none() {
            // Pragmatic app fallback: when no inline or related EXIF offset is
            // available, write the current PC local offset so IPTC time drafts
            // stay canonical and verify against ExifTool's offset-bearing read.
            time.offset = fallback_offset.cloned();
        }
        time
    }

    fn compare_for_dates_normaliser(&self, other: &Self) -> TimestampComparison {
        if self.datetime.date != other.datetime.date
            || self.datetime.time.hour != other.datetime.time.hour
            || self.datetime.time.minute != other.datetime.time.minute
            || self.datetime.time.second != other.datetime.time.second
            || self.datetime.time.subsecond != other.datetime.time.subsecond
        {
            return TimestampComparison::Conflict;
        }

        match (self.effective_offset(), other.effective_offset()) {
            (Some(a), Some(b)) if a != b => TimestampComparison::Conflict,
            _ => TimestampComparison::Equivalent,
        }
    }
}

fn set_edit(value: MetadataValue) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(value),
        intent: EditIntent::Set,
        display: None,
    }
}

fn date_value(year: i32, month: u8, day: u8) -> DateValue {
    DateValue { year, month, day }
}

fn time_value(
    hour: u8,
    minute: u8,
    second: u8,
    subsecond: Option<String>,
    offset: Option<UtcOffsetValue>,
) -> TimeValue {
    TimeValue {
        hour,
        minute,
        second,
        subsecond,
        offset,
    }
}

fn dt_value(date: DateValue, time: TimeValue) -> DateTimeValue {
    DateTimeValue { date, time }
}

#[cfg(test)]
fn offset_to_string(offset: &UtcOffsetValue) -> String {
    let sign = match offset.sign {
        OffsetSign::Plus => '+',
        OffsetSign::Minus => '-',
    };
    format!("{}{:02}:{:02}", sign, offset.hours, offset.minutes)
}

fn parse_offset(s: &str) -> Option<UtcOffsetValue> {
    let s = s.trim();
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

fn local_offset_now() -> UtcOffsetValue {
    let seconds = chrono::Local::now().offset().fix().local_minus_utc();
    let sign = if seconds < 0 {
        OffsetSign::Minus
    } else {
        OffsetSign::Plus
    };
    let abs = seconds.unsigned_abs();
    UtcOffsetValue {
        sign,
        hours: (abs / 3600) as u8,
        minutes: ((abs % 3600) / 60) as u8,
    }
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

fn parse_date_str(s: &str) -> Option<DateValue> {
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
    Some(date_value(
        year.parse().ok()?,
        month.parse().ok()?,
        day.parse().ok()?,
    ))
}

fn parse_time_str(s: &str) -> Option<TimeValue> {
    let s = s.trim();
    let (main, offset) = split_offset(s);
    let parts: Vec<&str> = main.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let (second, subsecond) = if let Some((sec, sub)) = parts[2].split_once('.') {
        (sec, Some(sub.to_string()))
    } else {
        (parts[2], None)
    };
    Some(time_value(
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        second.parse().ok()?,
        subsecond,
        offset,
    ))
}

fn parse_datetime_str(s: &str) -> Option<DateTimeValue> {
    let s = s.trim();
    let sep_idx = s.find('T').or_else(|| s.find(' '))?;
    let date = parse_date_str(&s[..sep_idx])?;
    let time = parse_time_str(&s[sep_idx + 1..])?;
    Some(dt_value(date, time))
}

fn offset_from_value(value: Option<&MetadataValue>) -> Option<UtcOffsetValue> {
    match value {
        Some(MetadataValue::TimeOffset(offset)) => Some(offset.clone()),
        Some(MetadataValue::Text(s)) => parse_offset(s),
        _ => None,
    }
}

fn subsecond_from_value(value: Option<&MetadataValue>) -> Option<String> {
    match value {
        Some(MetadataValue::Text(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(MetadataValue::Integer(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn datetime_from_value(
    value: Option<&MetadataValue>,
    related_offset: Option<UtcOffsetValue>,
    related_subsecond: Option<String>,
) -> Option<ComparableTimestamp> {
    let mut datetime = match value? {
        MetadataValue::DateTime(dt) => dt.clone(),
        MetadataValue::Text(s) => parse_datetime_str(s)?,
        _ => return None,
    };
    if datetime.time.subsecond.is_none() {
        datetime.time.subsecond = related_subsecond;
    }
    Some(ComparableTimestamp {
        datetime,
        offset_from_related_tag: related_offset,
    })
}

fn split_datetime_from_values(
    date_value: Option<&MetadataValue>,
    time_value: Option<&MetadataValue>,
    related_offset: Option<UtcOffsetValue>,
    related_subsecond: Option<String>,
) -> Option<ComparableTimestamp> {
    let date = match date_value? {
        MetadataValue::Date(d) => d.clone(),
        MetadataValue::Text(s) => parse_date_str(s)?,
        _ => return None,
    };
    let mut time = match time_value {
        Some(MetadataValue::Time(t)) => t.clone(),
        Some(MetadataValue::Text(s)) => parse_time_str(s)?,
        None => TimeValue {
            hour: 0,
            minute: 0,
            second: 0,
            subsecond: None,
            offset: None,
        },
        _ => return None,
    };
    if time.subsecond.is_none() {
        time.subsecond = related_subsecond;
    }
    Some(ComparableTimestamp {
        datetime: dt_value(date, time),
        offset_from_related_tag: related_offset,
    })
}

fn has_non_empty_value(value: Option<&MetadataValue>) -> bool {
    match value {
        None | Some(MetadataValue::Null) => false,
        Some(MetadataValue::Text(s)) => !s.trim().is_empty(),
        Some(_) => true,
    }
}

#[derive(Debug, Clone, Default)]
struct DateSubgroupResult {
    edits: SchemaMetadataEditMap,
    conflict: bool,
}

#[allow(clippy::too_many_arguments)]
fn process_date_subgroup(
    existing_exif: Option<&ComparableTimestamp>,
    existing_xmp: Option<&ComparableTimestamp>,
    existing_iptc: Option<&ComparableTimestamp>,
    canonical_override: Option<&ComparableTimestamp>,
    exif_target_id: SchemaDefinitionId,
    xmp_target_id: SchemaDefinitionId,
    iptc_date_id: SchemaDefinitionId,
    iptc_time_id: SchemaDefinitionId,
    iptc_fallback_offset: Option<&UtcOffsetValue>,
) -> DateSubgroupResult {
    let mut conflict = false;
    let canonical = if let Some(p) = existing_exif.cloned() {
        for other in [existing_xmp, existing_iptc].into_iter().flatten() {
            if p.compare_for_dates_normaliser(other) == TimestampComparison::Conflict {
                conflict = true;
            }
        }
        p
    } else if let Some(p) = existing_xmp.cloned() {
        if let Some(other) = existing_iptc {
            if p.compare_for_dates_normaliser(other) == TimestampComparison::Conflict {
                conflict = true;
            }
        }
        p
    } else if let Some(p) = existing_iptc.cloned() {
        p
    } else if let Some(p) = canonical_override.cloned() {
        p
    } else {
        return DateSubgroupResult::default();
    };

    let mut edits = SchemaMetadataEditMap::new();
    if existing_exif
        .map(|v| v.compare_for_dates_normaliser(&canonical) == TimestampComparison::Equivalent)
        != Some(true)
    {
        edits.insert(
            exif_target_id,
            set_edit(MetadataValue::DateTime(canonical.without_inline_offset())),
        );
    }
    if existing_xmp
        .map(|v| v.compare_for_dates_normaliser(&canonical) == TimestampComparison::Equivalent)
        != Some(true)
    {
        edits.insert(
            xmp_target_id,
            set_edit(MetadataValue::DateTime(canonical.with_effective_offset())),
        );
    }
    let existing_iptc_offset = existing_iptc.and_then(ComparableTimestamp::effective_offset);
    let iptc_time = canonical.time_with_iptc_offset(existing_iptc_offset, iptc_fallback_offset);
    let iptc_matches = existing_iptc.map(|v| {
        v.datetime.date == canonical.datetime.date
            && v.datetime.time.hour == iptc_time.hour
            && v.datetime.time.minute == iptc_time.minute
            && v.datetime.time.second == iptc_time.second
            && v.datetime.time.subsecond == iptc_time.subsecond
            && v.datetime.time.offset == iptc_time.offset
    }) == Some(true);
    if !iptc_matches {
        edits.insert(
            iptc_date_id,
            set_edit(MetadataValue::Date(canonical.date())),
        );
        edits.insert(iptc_time_id, set_edit(MetadataValue::Time(iptc_time)));
    }

    DateSubgroupResult { edits, conflict }
}

#[derive(Debug, Clone, Default)]
pub struct DatesOutcome {
    pub output: Option<GroupOutput>,
    pub n_date_conflict: u32,
    pub n_unparseable_inputs: u32,
    pub n_dto_from_filename: u32,
    pub n_dto_from_filename_date_only: u32,
}

fn parse_filename_for_h1(stem: &str) -> Option<(ComparableTimestamp, bool)> {
    static PATTERNS: OnceLock<Vec<(regex::Regex, bool, bool)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            (
                regex::Regex::new(
                    r"PXL[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(\d{3})",
                )
                .unwrap(),
                true,
                true,
            ),
            (
                regex::Regex::new(r"(?:IMG|VID)[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"Screenshot[ _](\d{4})-(\d{2})-(\d{2})(?:[ _](\d{2})[.\-](\d{2})[.\-](\d{2}))?").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[.\-:](\d{2})[.\-:](\d{2})").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})").unwrap(),
                true,
                false,
            ),
            (
                regex::Regex::new(r"(\d{4})-(\d{2})-(\d{2})").unwrap(),
                false,
                false,
            ),
        ]
    });

    let current_year: i32 = chrono::Utc::now()
        .format("%Y")
        .to_string()
        .parse()
        .unwrap_or(2026);
    let year_max = current_year + 1;

    for (re, has_time, has_subsec) in patterns {
        if let Some(caps) = re.captures(stem) {
            let year: i32 = caps.get(1)?.as_str().parse().ok()?;
            let month: u8 = caps.get(2)?.as_str().parse().ok()?;
            let day: u8 = caps.get(3)?.as_str().parse().ok()?;
            if !(1900..=year_max).contains(&year)
                || !(1..=12).contains(&month)
                || day == 0
                || day > 31
            {
                continue;
            }
            let (hour, minute, second, time_present) = if *has_time {
                match (caps.get(4), caps.get(5), caps.get(6)) {
                    (Some(h), Some(m), Some(s)) => {
                        let h: u8 = h.as_str().parse().ok()?;
                        let m: u8 = m.as_str().parse().ok()?;
                        let s: u8 = s.as_str().parse().ok()?;
                        if h > 23 || m > 59 || s > 59 {
                            continue;
                        }
                        (h, m, s, true)
                    }
                    _ => (0, 0, 0, false),
                }
            } else {
                (0, 0, 0, false)
            };
            let subsecond = if *has_subsec {
                caps.get(7).map(|m| m.as_str().to_string())
            } else {
                None
            };
            return Some((
                ComparableTimestamp {
                    datetime: dt_value(
                        date_value(year, month, day),
                        time_value(hour, minute, second, subsecond, None),
                    ),
                    offset_from_related_tag: None,
                },
                !time_present,
            ));
        }
    }
    None
}

fn normalise_dates_inner(
    input: &DatesInput,
    iptc_fallback_offset: Option<UtcOffsetValue>,
) -> DatesOutcome {
    let mut edits = SchemaMetadataEditMap::new();
    let mut n_conflict = 0;
    let mut n_unparseable = 0;
    let mut n_from_filename = 0;
    let mut n_from_filename_date_only = 0;

    let offset_h1 = offset_from_value(input.offset_time_original.as_ref());
    let subsec_h1 = subsecond_from_value(input.sub_sec_time_original.as_ref());
    let exif_h1 = datetime_from_value(
        input.date_time_original.as_ref(),
        offset_h1.clone(),
        subsec_h1.clone(),
    );
    let xmp_h1 = datetime_from_value(
        input.photoshop_date_created.as_ref(),
        None,
        subsec_h1.clone(),
    );
    let iptc_h1 = split_datetime_from_values(
        input.iptc_date_created.as_ref(),
        input.iptc_time_created.as_ref(),
        None,
        subsec_h1.clone(),
    );
    if has_non_empty_value(input.date_time_original.as_ref()) && exif_h1.is_none() {
        n_unparseable += 1;
    }
    if has_non_empty_value(input.photoshop_date_created.as_ref()) && xmp_h1.is_none() {
        n_unparseable += 1;
    }
    if has_non_empty_value(input.iptc_date_created.as_ref()) && iptc_h1.is_none() {
        n_unparseable += 1;
    }

    let mut canonical_override = None;
    if exif_h1.is_none() && xmp_h1.is_none() && iptc_h1.is_none() {
        if let Some(stem) = input.file_stem.as_deref().filter(|s| !s.trim().is_empty()) {
            if let Some((parsed, date_only)) = parse_filename_for_h1(stem) {
                canonical_override = Some(parsed);
                n_from_filename += 1;
                if date_only {
                    n_from_filename_date_only += 1;
                }
            }
        }
    }

    let h1 = process_date_subgroup(
        exif_h1.as_ref(),
        xmp_h1.as_ref(),
        iptc_h1.as_ref(),
        canonical_override.as_ref(),
        known_ids::date_time_original(),
        known_ids::xmp_date_created(),
        known_ids::iptc_date_created(),
        known_ids::iptc_time_created(),
        iptc_fallback_offset.as_ref(),
    );
    if h1.conflict {
        n_conflict += 1;
    }
    edits.extend(h1.edits);

    let offset_h2 = offset_from_value(input.offset_time_digitized.as_ref());
    let subsec_h2 = subsecond_from_value(input.sub_sec_time_digitized.as_ref());
    let exif_h2 = datetime_from_value(
        input.create_date.as_ref(),
        offset_h2.clone(),
        subsec_h2.clone(),
    );
    let xmp_h2 = datetime_from_value(input.xmp_create_date.as_ref(), None, subsec_h2.clone());
    let iptc_h2 = split_datetime_from_values(
        input.iptc_digital_creation_date.as_ref(),
        input.iptc_digital_creation_time.as_ref(),
        None,
        subsec_h2.clone(),
    );
    if has_non_empty_value(input.create_date.as_ref()) && exif_h2.is_none() {
        n_unparseable += 1;
    }
    if has_non_empty_value(input.xmp_create_date.as_ref()) && xmp_h2.is_none() {
        n_unparseable += 1;
    }
    if has_non_empty_value(input.iptc_digital_creation_date.as_ref()) && iptc_h2.is_none() {
        n_unparseable += 1;
    }

    let h2 = process_date_subgroup(
        exif_h2.as_ref(),
        xmp_h2.as_ref(),
        iptc_h2.as_ref(),
        None,
        known_ids::create_date(),
        known_ids::xmp_create_date(),
        known_ids::iptc_digital_creation_date(),
        known_ids::iptc_digital_creation_time(),
        iptc_fallback_offset.as_ref(),
    );
    if h2.conflict {
        n_conflict += 1;
    }
    edits.extend(h2.edits);

    DatesOutcome {
        output: if edits.is_empty() {
            None
        } else {
            Some(GroupOutput { edits })
        },
        n_date_conflict: n_conflict,
        n_unparseable_inputs: n_unparseable,
        n_dto_from_filename: n_from_filename,
        n_dto_from_filename_date_only: n_from_filename_date_only,
    }
}

pub fn normalise_dates(input: &DatesInput) -> DatesOutcome {
    normalise_dates_inner(input, Some(local_offset_now()))
}

#[cfg(test)]
fn normalise_dates_with_fallback_offset(
    input: &DatesInput,
    fallback_offset: Option<UtcOffsetValue>,
) -> DatesOutcome {
    normalise_dates_inner(input, fallback_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> MetadataValue {
        MetadataValue::Text(s.to_string())
    }

    fn date(y: i32, m: u8, d: u8) -> MetadataValue {
        MetadataValue::Date(date_value(y, m, d))
    }

    fn time(h: u8, m: u8, s: u8, offset: Option<UtcOffsetValue>) -> MetadataValue {
        MetadataValue::Time(time_value(h, m, s, None, offset))
    }

    fn dt(
        y: i32,
        mo: u8,
        d: u8,
        h: u8,
        mi: u8,
        s: u8,
        offset: Option<UtcOffsetValue>,
    ) -> MetadataValue {
        MetadataValue::DateTime(dt_value(
            date_value(y, mo, d),
            time_value(h, mi, s, None, offset),
        ))
    }

    fn off(hours: u8) -> UtcOffsetValue {
        UtcOffsetValue {
            sign: OffsetSign::Plus,
            hours,
            minutes: 0,
        }
    }

    fn edit_value<'a>(g: &'a GroupOutput, k: &str) -> &'a MetadataValue {
        g.edits
            .get(&crate::known_ids::test_id(k))
            .unwrap()
            .value
            .as_ref()
            .unwrap()
    }

    fn display(v: &MetadataValue) -> String {
        match v {
            MetadataValue::Date(d) => format!("{:04}-{:02}-{:02}", d.year, d.month, d.day),
            MetadataValue::Time(t) => {
                let sub = t
                    .subsecond
                    .as_ref()
                    .map(|s| format!(".{s}"))
                    .unwrap_or_default();
                let offset = t.offset.as_ref().map(offset_to_string).unwrap_or_default();
                format!("{:02}:{:02}:{:02}{sub}{offset}", t.hour, t.minute, t.second)
            }
            MetadataValue::DateTime(dt) => format!(
                "{}T{}",
                display(&MetadataValue::Date(dt.date.clone())),
                display(&MetadataValue::Time(dt.time.clone()))
            ),
            other => panic!("unexpected value: {other:?}"),
        }
    }

    #[test]
    fn h1_exif_only_propagates_to_xmp_and_iptc_split() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None)
            .output
            .unwrap();
        assert!(!out
            .edits
            .contains_key(&crate::known_ids::date_time_original()));
        assert_eq!(
            display(edit_value(&out, "XMP-photoshop:DateCreated")),
            "2024-06-15T14:30:45"
        );
        assert_eq!(display(edit_value(&out, "IPTC:DateCreated")), "2024-06-15");
        assert_eq!(display(edit_value(&out, "IPTC:TimeCreated")), "14:30:45");
    }

    #[test]
    fn exif_offsetless_and_iptc_offset_wall_clock_match_is_noop() {
        let input = DatesInput {
            date_time_original: Some(dt(2007, 7, 23, 10, 56, 5, None)),
            photoshop_date_created: Some(dt(2007, 7, 23, 10, 56, 5, None)),
            iptc_date_created: Some(date(2007, 7, 23)),
            iptc_time_created: Some(time(10, 56, 5, Some(off(1)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert!(out.output.is_none(), "unexpected edits: {:?}", out.output);
        assert_eq!(out.n_date_conflict, 0);
    }

    #[test]
    fn normaliser_does_not_rewrite_solely_to_add_or_remove_iptc_offset() {
        let input = DatesInput {
            date_time_original: Some(dt(2007, 7, 23, 10, 56, 5, None)),
            photoshop_date_created: Some(dt(2007, 7, 23, 10, 56, 5, None)),
            iptc_date_created: Some(date(2007, 7, 23)),
            iptc_time_created: Some(time(10, 56, 5, Some(off(1)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert!(out.output.is_none());
    }

    #[test]
    fn offsetless_time_draft_remains_offsetless() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            iptc_date_created: Some(date(2024, 6, 15)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None)
            .output
            .unwrap();
        assert_eq!(display(edit_value(&out, "IPTC:TimeCreated")), "14:30:45");
    }

    #[test]
    fn offset_bearing_time_draft_preserves_offset() {
        let input = DatesInput {
            iptc_date_created: Some(date(2024, 6, 15)),
            iptc_time_created: Some(time(14, 30, 45, Some(off(1)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None)
            .output
            .unwrap();
        assert_eq!(
            display(edit_value(&out, "XMP-photoshop:DateCreated")),
            "2024-06-15T14:30:45+01:00"
        );
        assert_eq!(
            display(edit_value(&out, "ExifIFD:DateTimeOriginal")),
            "2024-06-15T14:30:45"
        );
    }

    #[test]
    fn offsetless_iptc_time_uses_injected_local_fallback() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            iptc_date_created: Some(date(2024, 6, 15)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)))
            .output
            .unwrap();
        assert_eq!(
            display(edit_value(&out, "IPTC:TimeCreated")),
            "14:30:45+01:00"
        );
    }

    #[test]
    fn existing_iptc_time_offset_is_preserved_over_local_fallback() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            iptc_date_created: Some(date(2024, 6, 15)),
            iptc_time_created: Some(time(14, 30, 45, Some(off(2)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)));
        let edits = out.output.unwrap().edits;
        assert!(
            !edits.contains_key(&crate::known_ids::iptc_time_created()),
            "must preserve existing IPTC offset: {:?}",
            edits
        );
    }

    #[test]
    fn related_exif_offset_wins_over_local_fallback_for_iptc_time() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            offset_time_original: Some(MetadataValue::TimeOffset(off(2))),
            iptc_date_created: Some(date(2024, 6, 15)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)))
            .output
            .unwrap();
        assert_eq!(
            display(edit_value(&out, "IPTC:TimeCreated")),
            "14:30:45+02:00"
        );
    }

    #[test]
    fn digital_creation_time_uses_same_offset_rules() {
        let input = DatesInput {
            create_date: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            iptc_digital_creation_date: Some(date(2024, 6, 15)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)))
            .output
            .unwrap();
        assert_eq!(
            display(edit_value(&out, "IPTC:DigitalCreationTime")),
            "14:30:45+01:00"
        );
    }

    #[test]
    fn offset_time_digitized_wins_over_local_fallback_for_digital_creation_time() {
        let input = DatesInput {
            create_date: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            offset_time_digitized: Some(MetadataValue::TimeOffset(off(2))),
            iptc_digital_creation_date: Some(date(2024, 6, 15)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)))
            .output
            .unwrap();
        assert_eq!(
            display(edit_value(&out, "IPTC:DigitalCreationTime")),
            "14:30:45+02:00"
        );
    }

    #[test]
    fn plain_offset_time_is_not_borrowed_for_digital_creation_time() {
        let input = DatesInput {
            create_date: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            offset_time: Some(MetadataValue::TimeOffset(off(2))),
            iptc_digital_creation_date: Some(date(2024, 6, 15)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)))
            .output
            .unwrap();
        assert_eq!(
            display(edit_value(&out, "IPTC:DigitalCreationTime")),
            "14:30:45+01:00"
        );
    }

    #[test]
    fn existing_digital_creation_time_offset_wins_over_offset_time_digitized() {
        let input = DatesInput {
            create_date: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            offset_time_digitized: Some(MetadataValue::TimeOffset(off(2))),
            iptc_digital_creation_date: Some(date(2024, 6, 15)),
            iptc_digital_creation_time: Some(time(14, 30, 45, Some(off(3)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)));
        let edits = out.output.unwrap().edits;
        assert!(
            !edits.contains_key(&crate::known_ids::iptc_digital_creation_time()),
            "must preserve existing IPTC digital creation offset: {:?}",
            edits
        );
    }

    #[test]
    fn related_exif_offset_tag_stays_separate_from_date_time_original() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            offset_time_original: Some(MetadataValue::TimeOffset(off(1))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None)
            .output
            .unwrap();
        assert!(!out
            .edits
            .contains_key(&crate::known_ids::offset_time_original()));
        assert!(!out
            .edits
            .contains_key(&crate::known_ids::date_time_original()));
        assert_eq!(
            display(edit_value(&out, "IPTC:TimeCreated")),
            "14:30:45+01:00"
        );
    }

    #[test]
    fn both_sources_with_different_offsets_conflict() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, Some(off(1)))),
            photoshop_date_created: Some(dt(2024, 6, 15, 14, 30, 45, Some(off(2)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert_eq!(out.n_date_conflict, 1);
        let g = out.output.unwrap();
        assert_eq!(
            display(edit_value(&g, "XMP-photoshop:DateCreated")),
            "2024-06-15T14:30:45+01:00"
        );
    }

    #[test]
    fn differing_wall_clock_time_conflicts_and_primary_wins() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            photoshop_date_created: Some(dt(2024, 6, 15, 15, 0, 0, None)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert_eq!(out.n_date_conflict, 1);
        let g = out.output.unwrap();
        assert_eq!(
            display(edit_value(&g, "XMP-photoshop:DateCreated")),
            "2024-06-15T14:30:45"
        );
    }

    #[test]
    fn h2_exif_only_propagates() {
        let input = DatesInput {
            create_date: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None)
            .output
            .unwrap();
        assert_eq!(
            display(edit_value(&out, "XMP-xmp:CreateDate")),
            "2024-06-15T14:30:45"
        );
        assert_eq!(
            display(edit_value(&out, "IPTC:DigitalCreationDate")),
            "2024-06-15"
        );
        assert_eq!(
            display(edit_value(&out, "IPTC:DigitalCreationTime")),
            "14:30:45"
        );
    }

    #[test]
    fn text_fallback_input_is_counted_when_unparseable() {
        let input = DatesInput {
            date_time_original: Some(text("garbage")),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert!(out.output.is_none());
        assert_eq!(out.n_unparseable_inputs, 1);
    }

    #[test]
    fn all_empty_returns_no_drafts() {
        let out = normalise_dates_with_fallback_offset(&DatesInput::default(), None);
        assert!(out.output.is_none());
        assert_eq!(out.n_date_conflict, 0);
        assert_eq!(out.n_unparseable_inputs, 0);
    }

    #[test]
    fn filename_fallback_compact_no_separator() {
        let input = DatesInput {
            file_stem: Some("20240615143045".into()),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        let g = out.output.unwrap();
        assert_eq!(
            display(edit_value(&g, "ExifIFD:DateTimeOriginal")),
            "2024-06-15T14:30:45"
        );
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 0);
    }

    #[test]
    fn filename_fallback_date_only() {
        let input = DatesInput {
            file_stem: Some("Screenshot 2024-06-15".into()),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        let g = out.output.unwrap();
        assert_eq!(
            display(edit_value(&g, "ExifIFD:DateTimeOriginal")),
            "2024-06-15T00:00:00"
        );
        assert_eq!(out.n_dto_from_filename_date_only, 1);
    }

    #[test]
    fn filename_fallback_never_overwrites_existing_dto() {
        let input = DatesInput {
            date_time_original: Some(dt(2020, 1, 1, 0, 0, 0, None)),
            file_stem: Some("IMG_20240615_143045".into()),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert_eq!(out.n_dto_from_filename, 0);
        let g = out.output.unwrap();
        assert_eq!(
            display(edit_value(&g, "XMP-photoshop:DateCreated")),
            "2020-01-01T00:00:00"
        );
    }
}
