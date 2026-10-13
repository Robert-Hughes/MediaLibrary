//! Group H - Dates (H1 Shutter + H2 Digitised).
//!
//! The normaliser consumes semantic `MetadataValue` inputs. EXIF offset tags
//! such as `ExifIFD:OffsetTimeOriginal` remain separate metadata values; they
//! are used only as a local comparison/projection hint.

use super::{DatesInput, GroupConflictDetail, GroupOutput, NormaliseGroup};
use crate::draft_edits::{EditIntent, MetadataDraftEdit, SchemaMetadataEditMap};
use crate::known_ids;
use crate::metadata_value::{
    DateTimeValue, DateValue, MetadataValue, OffsetSign, TimeValue, UtcOffsetValue,
};
use crate::tag_schema::SchemaDefinitionId;
use chrono::{Datelike, Offset, Timelike};
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
        // IPTC IIM time fields (storage_count=11: HH:MM:SS±HH:MM) cannot
        // represent sub-second precision. Strip it so the draft matches
        // what ExifTool will actually write — the same projection pattern
        // used by description (ASCII-fold), headline (truncation) and
        // location (field-limit truncation).
        time.subsecond = None;
        time.offset = existing_iptc_offset
            .cloned()
            .or_else(|| self.effective_offset().cloned());
        if time.offset.is_none() {
            // Pragmatic app fallback: when no inline or related EXIF offset is
            // available, write the current PC local offset so IPTC time drafts
            // stay canonical and verify against ExifTool's offset-bearing read.
            time.offset = fallback_offset.cloned();
        }
        canonicalize_iptc_time_for_write(time)
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

        if offsets_match(self.effective_offset(), other.effective_offset(), true) {
            TimestampComparison::Equivalent
        } else {
            TimestampComparison::Conflict
        }
    }
}

fn canonicalize_iptc_time_for_write(mut time: TimeValue) -> TimeValue {
    if let Some(offset) = &mut time.offset {
        // ExifTool canonicalises negative zero only for IPTC IIM time fields.
        // Preserve the source sign for EXIF/XMP, but project the value that
        // IPTC will actually store so a successful write verifies exactly.
        if offset.hours == 0 && offset.minutes == 0 {
            offset.sign = OffsetSign::Plus;
        }
    }
    time
}

fn offsets_match(
    left: Option<&UtcOffsetValue>,
    right: Option<&UtcOffsetValue>,
    missing_matches_known: bool,
) -> bool {
    match (left, right) {
        (Some(left), Some(right))
            if left.hours == 0 && left.minutes == 0 && right.hours == 0 && right.minutes == 0 =>
        {
            true
        }
        (Some(left), Some(right)) => left == right,
        (None, None) => true,
        _ => missing_matches_known,
    }
}

fn iptc_times_match(left: &TimeValue, right: &TimeValue) -> bool {
    left.hour == right.hour
        && left.minute == right.minute
        && left.second == right.second
        && left.subsecond == right.subsecond
        && offsets_match(left.offset.as_ref(), right.offset.as_ref(), false)
}

fn set_edit(value: MetadataValue) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(value),
        intent: EditIntent::Set,
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
        && (&s[4..5] == ":" || &s[4..5] == "-" || &s[4..5] == "/")
        && (&s[7..8] == ":" || &s[7..8] == "-" || &s[7..8] == "/")
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

fn date_from_value(value: Option<&MetadataValue>) -> Option<DateValue> {
    match value? {
        MetadataValue::Date(date) => Some(date.clone()),
        MetadataValue::Text(text) => parse_date_str(text),
        _ => None,
    }
}

fn time_from_value(value: Option<&MetadataValue>) -> Option<TimeValue> {
    match value? {
        MetadataValue::Time(time) => Some(time.clone()),
        MetadataValue::Text(text) => parse_time_str(text),
        _ => None,
    }
}

fn split_datetime_from_values(
    date_value: Option<&MetadataValue>,
    time_value: Option<&MetadataValue>,
    related_offset: Option<UtcOffsetValue>,
    related_subsecond: Option<String>,
) -> Option<ComparableTimestamp> {
    let date = date_from_value(date_value)?;
    let mut time = match time_from_value(time_value) {
        Some(time) => time,
        None if time_value.is_none() => TimeValue {
            hour: 0,
            minute: 0,
            second: 0,
            subsecond: None,
            offset: None,
        },
        None => return None,
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
    /// Winning source label + timestamp. `Some` only when `conflict`.
    primary: Option<(String, ComparableTimestamp)>,
    /// Secondary sources whose timestamps diverged from the primary.
    diverged: Vec<(String, ComparableTimestamp)>,
}

#[allow(clippy::too_many_arguments)]
fn process_date_subgroup(
    existing_exif: Option<&ComparableTimestamp>,
    existing_xmp: Option<&ComparableTimestamp>,
    existing_iptc: Option<&ComparableTimestamp>,
    effective_iptc_date: Option<&MetadataValue>,
    effective_iptc_time: Option<&MetadataValue>,
    canonical_override: Option<&ComparableTimestamp>,
    exif_target_id: SchemaDefinitionId,
    xmp_target_id: SchemaDefinitionId,
    iptc_date_id: SchemaDefinitionId,
    iptc_time_id: SchemaDefinitionId,
    iptc_fallback_offset: Option<&UtcOffsetValue>,
) -> DateSubgroupResult {
    let mut conflict = false;
    let mut diverged: Vec<(String, ComparableTimestamp)> = Vec::new();
    let (canonical, primary_source) = if let Some(p) = existing_exif.cloned() {
        for (label, other) in [("XMP", existing_xmp), ("IPTC", existing_iptc)]
            .into_iter()
            .filter_map(|(label, ts)| ts.map(|ts| (label, ts)))
        {
            if p.compare_for_dates_normaliser(other) == TimestampComparison::Conflict {
                conflict = true;
                diverged.push((label.to_string(), other.clone()));
            }
        }
        (p, "EXIF")
    } else if let Some(p) = existing_xmp.cloned() {
        if let Some(other) = existing_iptc {
            if p.compare_for_dates_normaliser(other) == TimestampComparison::Conflict {
                conflict = true;
                diverged.push(("IPTC".to_string(), other.clone()));
            }
        }
        (p, "XMP")
    } else if let Some(p) = existing_iptc.cloned() {
        (p, "IPTC")
    } else if let Some(p) = canonical_override.cloned() {
        (p, "filename")
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
    // The combined IPTC timestamp above is enriched with the related EXIF
    // subsecond solely for canonical selection and conflict detection. For
    // idempotency, compare each split IPTC field against its own current
    // effective value so target projection remains observable.
    let iptc_date = canonical.date();
    let effective_iptc_time = time_from_value(effective_iptc_time);
    let existing_iptc_offset = effective_iptc_time
        .as_ref()
        .and_then(|time| time.offset.as_ref());
    let iptc_time = canonical.time_with_iptc_offset(existing_iptc_offset, iptc_fallback_offset);

    if date_from_value(effective_iptc_date).as_ref() != Some(&iptc_date) {
        edits.insert(iptc_date_id, set_edit(MetadataValue::Date(iptc_date)));
    }
    if !effective_iptc_time
        .as_ref()
        .is_some_and(|current| iptc_times_match(current, &iptc_time))
    {
        edits.insert(iptc_time_id, set_edit(MetadataValue::Time(iptc_time)));
    }

    DateSubgroupResult {
        edits,
        conflict,
        primary: conflict.then(|| (primary_source.to_string(), canonical.clone())),
        diverged: if conflict { diverged } else { Vec::new() },
    }
}

fn render_offset(offset: &UtcOffsetValue) -> String {
    let sign = match offset.sign {
        OffsetSign::Plus => '+',
        OffsetSign::Minus => '-',
    };
    format!("{sign}{:02}:{:02}", offset.hours, offset.minutes)
}

fn render_ts(ts: &ComparableTimestamp) -> String {
    let dt = &ts.datetime;
    let mut s = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        dt.date.year, dt.date.month, dt.date.day, dt.time.hour, dt.time.minute, dt.time.second,
    );
    if let Some(subsecond) = &dt.time.subsecond {
        s.push('.');
        s.push_str(subsecond);
    }
    if let Some(offset) = ts.effective_offset() {
        s.push_str(&render_offset(offset));
    }
    s
}

/// One rendered date-conflict row: which secondary source diverged from
/// the primary (winning) source and by how much.
fn date_conflict_detail(subunit: &str, result: &DateSubgroupResult) -> GroupConflictDetail {
    let (primary_source, primary_ts) = result
        .primary
        .as_ref()
        .expect("conflicting subgroup always records its primary");
    let mut summary = String::new();
    for (source, ts) in &result.diverged {
        if !summary.is_empty() {
            summary.push_str("; ");
        }
        summary.push_str(&format!(
            "{source} {} diverges from primary {primary_source} {}",
            render_ts(ts),
            render_ts(primary_ts),
        ));
    }
    summary.push_str("; primary wins");
    GroupConflictDetail {
        group: NormaliseGroup::Dates,
        subunit: subunit.to_string(),
        summary,
    }
}

#[derive(Debug, Clone, Default)]
pub struct DatesOutcome {
    pub output: Option<GroupOutput>,
    pub n_date_conflict: u32,
    pub n_unparseable_inputs: u32,
    pub n_dto_from_filename: u32,
    pub n_dto_from_filename_date_only: u32,
    /// Per-conflict detail (subgroup + which source diverged from the
    /// primary). Empty when nothing conflicted.
    pub conflicts: Vec<GroupConflictDetail>,
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
                // These names spell out HHMMSS after a separated date. The
                // optional two-digit suffix has no confirmed precision meaning.
                // Try this before Screenshot's optional date-only match.
                regex::Regex::new(r"(\d{4})-(\d{2})-(\d{2})[ _T-](\d{2})(\d{2})(\d{2})(?:\d{2})?(?:$|[^\d])").unwrap(),
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
    parse_unix_milliseconds_filename(stem, year_max).map(|timestamp| (timestamp, false))
}

fn parse_unix_milliseconds_filename(stem: &str, year_max: i32) -> Option<ComparableTimestamp> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex::Regex::new(r"[0-9]{13}").unwrap());
    let mut earliest: Option<i64> = None;
    let mut latest: Option<i64> = None;
    for matched in pattern.find_iter(stem) {
        // Do not mistake a fragment of a longer numeric identifier for a date.
        let bytes = stem.as_bytes();
        if matched.start() > 0 && bytes[matched.start() - 1].is_ascii_digit()
            || matched.end() < bytes.len() && bytes[matched.end()].is_ascii_digit()
        {
            continue;
        }
        let milliseconds = matched.as_str().parse::<i64>().ok()?;
        let datetime = chrono::DateTime::from_timestamp_millis(milliseconds)?;
        if !(1900..=year_max).contains(&datetime.year()) {
            continue;
        }
        earliest = Some(earliest.map_or(milliseconds, |value| value.min(milliseconds)));
        latest = Some(latest.map_or(milliseconds, |value| value.max(milliseconds)));
        if latest.unwrap() - earliest.unwrap() > 60_000 {
            // Check the total spread, not adjacent gaps: chained timestamps
            // must not turn a genuinely conflicting date into a valid fallback.
            return None;
        }
    }
    let datetime = chrono::DateTime::from_timestamp_millis(earliest?)?;
    Some(ComparableTimestamp {
        datetime: dt_value(
            date_value(
                datetime.year(),
                datetime.month() as u8,
                datetime.day() as u8,
            ),
            time_value(
                datetime.hour() as u8,
                datetime.minute() as u8,
                datetime.second() as u8,
                Some(format!("{:03}", datetime.timestamp_subsec_millis())),
                Some(UtcOffsetValue {
                    sign: OffsetSign::Plus,
                    hours: 0,
                    minutes: 0,
                }),
            ),
        ),
        offset_from_related_tag: None,
    })
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
    let mut conflicts: Vec<GroupConflictDetail> = Vec::new();

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
        // No filesystem timestamp fallback: Created/Modified times are mutable
        // transport/storage metadata and are not reliable evidence of capture time.
    }

    let unix_filename = canonical_override
        .as_ref()
        .filter(|timestamp| timestamp.effective_offset().is_some());
    let mut h1 = process_date_subgroup(
        exif_h1.as_ref(),
        xmp_h1.as_ref(),
        iptc_h1.as_ref(),
        input.iptc_date_created.as_ref(),
        // An orphan IPTC time's offset cannot override the filename's known UTC.
        if unix_filename.is_some() {
            None
        } else {
            input.iptc_time_created.as_ref()
        },
        canonical_override.as_ref(),
        known_ids::date_time_original(),
        known_ids::xmp_date_created(),
        known_ids::iptc_date_created(),
        known_ids::iptc_time_created(),
        iptc_fallback_offset.as_ref(),
    );
    if let Some(timestamp) = unix_filename {
        // EXIF stores the fraction and offset in companion tags rather than
        // DateTimeOriginal. Project all three so write/read and repeat runs agree.
        if let Some(edit) = h1.edits.get_mut(&known_ids::date_time_original()) {
            let mut datetime = timestamp.without_inline_offset();
            datetime.time.subsecond = None;
            edit.value = Some(MetadataValue::DateTime(datetime));
        }
        let offset = timestamp.effective_offset().unwrap();
        if offset_from_value(input.offset_time_original.as_ref()).as_ref() != Some(offset) {
            h1.edits.insert(
                known_ids::offset_time_original(),
                set_edit(MetadataValue::TimeOffset(offset.clone())),
            );
        }
        let subsecond = timestamp.datetime.time.subsecond.as_ref().unwrap();
        if subsecond_from_value(input.sub_sec_time_original.as_ref()).as_ref() != Some(subsecond) {
            h1.edits.insert(
                known_ids::sub_sec_time_original(),
                set_edit(MetadataValue::Text(subsecond.clone())),
            );
        }
    }
    if h1.conflict {
        n_conflict += 1;
        conflicts.push(date_conflict_detail("H1", &h1));
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
        input.iptc_digital_creation_date.as_ref(),
        input.iptc_digital_creation_time.as_ref(),
        None,
        known_ids::create_date(),
        known_ids::xmp_create_date(),
        known_ids::iptc_digital_creation_date(),
        known_ids::iptc_digital_creation_time(),
        iptc_fallback_offset.as_ref(),
    );
    if h2.conflict {
        n_conflict += 1;
        conflicts.push(date_conflict_detail("H2", &h2));
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
        conflicts,
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

    fn negative_zero() -> UtcOffsetValue {
        UtcOffsetValue {
            sign: OffsetSign::Minus,
            hours: 0,
            minutes: 0,
        }
    }

    fn edit_value<'a>(g: &'a GroupOutput, k: &str) -> &'a MetadataValue {
        let id = match k {
            "ExifIFD:OffsetTimeOriginal" => known_ids::offset_time_original(),
            "ExifIFD:SubSecTimeOriginal" => known_ids::sub_sec_time_original(),
            _ => crate::known_ids::test_id(k),
        };
        g.edits.get(&id).unwrap().value.as_ref().unwrap()
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
    fn related_exif_negative_zero_is_canonicalized_only_for_new_iptc_time() {
        let input = DatesInput {
            date_time_original: Some(dt(2021, 2, 25, 12, 19, 11, None)),
            offset_time_original: Some(MetadataValue::TimeOffset(negative_zero())),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)))
            .output
            .unwrap();

        assert_eq!(
            display(edit_value(&out, "XMP-photoshop:DateCreated")),
            "2021-02-25T12:19:11-00:00"
        );
        assert_eq!(
            display(edit_value(&out, "IPTC:TimeCreated")),
            "12:19:11+00:00"
        );
    }

    #[test]
    fn existing_iptc_negative_zero_does_not_trigger_sign_only_rewrite() {
        let input = DatesInput {
            date_time_original: Some(dt(2021, 2, 25, 12, 19, 11, None)),
            offset_time_original: Some(MetadataValue::TimeOffset(negative_zero())),
            photoshop_date_created: Some(dt(2021, 2, 25, 12, 19, 11, Some(negative_zero()))),
            iptc_date_created: Some(date(2021, 2, 25)),
            iptc_time_created: Some(time(12, 19, 11, Some(negative_zero()))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)));

        assert!(out.output.is_none(), "unexpected edits: {:?}", out.output);
        assert_eq!(out.n_date_conflict, 0);
    }

    #[test]
    fn opposite_signed_zero_offsets_are_equivalent_everywhere() {
        let input = DatesInput {
            date_time_original: Some(dt(2021, 2, 25, 12, 19, 11, None)),
            offset_time_original: Some(MetadataValue::TimeOffset(negative_zero())),
            photoshop_date_created: Some(dt(2021, 2, 25, 12, 19, 11, Some(negative_zero()))),
            iptc_date_created: Some(date(2021, 2, 25)),
            iptc_time_created: Some(time(12, 19, 11, Some(off(0)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)));

        assert!(out.output.is_none(), "unexpected edits: {:?}", out.output);
        assert_eq!(out.n_date_conflict, 0);
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
    fn digital_creation_negative_zero_is_canonicalized_for_iptc() {
        let input = DatesInput {
            create_date: Some(dt(2021, 2, 25, 12, 19, 11, None)),
            offset_time_digitized: Some(MetadataValue::TimeOffset(negative_zero())),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(1)))
            .output
            .unwrap();

        assert_eq!(
            display(edit_value(&out, "XMP-xmp:CreateDate")),
            "2021-02-25T12:19:11-00:00"
        );
        assert_eq!(
            display(edit_value(&out, "IPTC:DigitalCreationTime")),
            "12:19:11+00:00"
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
    fn slash_formatted_exif_datetime_is_parseable() {
        let input = DatesInput {
            date_time_original: Some(text("2011/07/25 19:22:48")),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert_eq!(out.n_unparseable_inputs, 0);
        let g = out.output.unwrap();
        assert_eq!(
            display(edit_value(&g, "XMP-photoshop:DateCreated")),
            "2011-07-25T19:22:48"
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
    fn unix_filename_fallback_projects_utc_and_milliseconds_without_touching_h2() {
        let input = DatesInput {
            file_stem: Some("upload_1500122345839_photo".into()),
            // Orphan hints must not replace the timestamp's known fraction/UTC.
            offset_time_original: Some(MetadataValue::TimeOffset(off(1))),
            sub_sec_time_original: Some(text("123")),
            iptc_time_created: Some(time(9, 0, 0, Some(off(2)))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, Some(off(5)));
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 0);
        let g = out.output.unwrap();
        assert_eq!(g.edits.len(), 6);
        assert_eq!(
            display(edit_value(&g, "ExifIFD:DateTimeOriginal")),
            "2017-07-15T12:39:05"
        );
        assert_eq!(
            edit_value(&g, "ExifIFD:OffsetTimeOriginal"),
            &MetadataValue::TimeOffset(off(0))
        );
        assert_eq!(edit_value(&g, "ExifIFD:SubSecTimeOriginal"), &text("839"));
        assert_eq!(
            display(edit_value(&g, "XMP-photoshop:DateCreated")),
            "2017-07-15T12:39:05.839+00:00"
        );
        assert_eq!(
            display(edit_value(&g, "IPTC:TimeCreated")),
            "12:39:05+00:00"
        );

        let reread = DatesInput {
            date_time_original: Some(edit_value(&g, "ExifIFD:DateTimeOriginal").clone()),
            offset_time_original: Some(edit_value(&g, "ExifIFD:OffsetTimeOriginal").clone()),
            sub_sec_time_original: Some(edit_value(&g, "ExifIFD:SubSecTimeOriginal").clone()),
            photoshop_date_created: Some(edit_value(&g, "XMP-photoshop:DateCreated").clone()),
            iptc_date_created: Some(edit_value(&g, "IPTC:DateCreated").clone()),
            iptc_time_created: Some(edit_value(&g, "IPTC:TimeCreated").clone()),
            ..input
        };
        let repeated = normalise_dates_with_fallback_offset(&reread, Some(off(5)));
        assert!(repeated.output.is_none());
        assert_eq!(repeated.n_dto_from_filename, 0);
    }

    #[test]
    fn unix_filename_detection_accepts_runs_but_rejects_long_ids_and_ambiguity() {
        for stem in [
            "1500122345839",
            "FB_IMG_1500122345839",
            "USER_SCOPED_TEMP_DATA_MSGR_PHOTO_FOR_UPLOAD_1500122345839_6829147487384714442",
            "photo1500122345839copy",
        ] {
            let (timestamp, date_only) = parse_filename_for_h1(stem).unwrap();
            assert_eq!(
                render_ts(&timestamp),
                "2017-07-15 12:39:05.839+00:00",
                "{stem}"
            );
            assert!(!date_only);
        }
        for stem in [
            "150012234583",
            "15001223458390",
            "01500122345839",
            "received_6829147487384714442",
            "9999999999999",
            "1500122345839_1500122405840",
        ] {
            assert!(parse_filename_for_h1(stem).is_none(), "{stem}");
        }
        assert!(parse_unix_milliseconds_filename("1500122345839", 2016).is_none());
        let zero_fraction = parse_filename_for_h1("1500122345000").unwrap().0;
        assert_eq!(
            zero_fraction.datetime.time.subsecond.as_deref(),
            Some("000")
        );
        // Existing calendar patterns keep their precedence.
        assert_eq!(
            render_ts(
                &parse_filename_for_h1("IMG_20240615_143045_1500122345839")
                    .unwrap()
                    .0
            ),
            "2024-06-15 14:30:45"
        );
    }

    #[test]
    fn unix_filename_nearby_timestamps_choose_earliest_within_one_minute() {
        for stem in [
            "orca-image-1514031538419.jpg_1514031538972",
            "orca-image-1514031538972.jpg_1514031538419",
            "1514031538419_1514031598419",
            "1514031538419_1514031538419",
            "1514031568419_1514031538419_1514031598419",
            "9999999999999_1514031538419_1514031538972",
        ] {
            let (timestamp, date_only) = parse_filename_for_h1(stem).unwrap();
            assert_eq!(
                render_ts(&timestamp),
                "2017-12-23 12:18:58.419+00:00",
                "{stem}"
            );
            assert!(!date_only);
        }
        for stem in [
            "1514031538419_1514031598420",
            "1514031628419_1514031538419",
            "1514031538419_1514031583419_1514031628419",
        ] {
            assert!(parse_filename_for_h1(stem).is_none(), "{stem}");
        }
    }

    #[test]
    fn unix_filename_never_overrides_a_usable_capture_source() {
        for source in 0..3 {
            let mut input = DatesInput {
                file_stem: Some("1500122345839".into()),
                ..Default::default()
            };
            match source {
                0 => input.date_time_original = Some(dt(2020, 1, 1, 0, 0, 0, None)),
                1 => input.photoshop_date_created = Some(dt(2020, 1, 1, 0, 0, 0, None)),
                _ => input.iptc_date_created = Some(date(2020, 1, 1)),
            }
            let out = normalise_dates_with_fallback_offset(&input, None);
            assert_eq!(out.n_dto_from_filename, 0);
            let g = out.output.unwrap();
            assert!(!g.edits.contains_key(&known_ids::offset_time_original()));
            assert!(!g.edits.contains_key(&known_ids::sub_sec_time_original()));
        }
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
    fn filename_fallback_separated_date_compact_clock() {
        for (stem, expected) in [
            ("IMG_2016-07-23-12190350", "2016-07-23T12:19:03"),
            ("IMG_2017-08-19-17305482", "2017-08-19T17:30:54"),
            ("IMG_2017-12-02-19143216", "2017-12-02T19:14:32"),
            ("Screenshot 2017-12-02 19143216", "2017-12-02T19:14:32"),
            ("photo_2024-06-15_143045", "2024-06-15T14:30:45"),
            ("2024-06-15T143045", "2024-06-15T14:30:45"),
            ("IMG_2024-06-15-14304550_copy", "2024-06-15T14:30:45"),
        ] {
            let input = DatesInput {
                file_stem: Some(stem.into()),
                ..Default::default()
            };
            let out = normalise_dates_with_fallback_offset(&input, None);
            assert_eq!(out.n_dto_from_filename, 1, "{stem}");
            assert_eq!(out.n_dto_from_filename_date_only, 0, "{stem}");
            let g = out.output.unwrap();
            assert_eq!(
                display(edit_value(&g, "ExifIFD:DateTimeOriginal")),
                expected,
                "{stem}"
            );
            assert_eq!(
                display(edit_value(&g, "XMP-photoshop:DateCreated")),
                expected,
                "{stem}"
            );
        }
    }

    #[test]
    fn separated_date_clock_does_not_consume_long_ids_or_invalid_times() {
        for stem in [
            "IMG_2017-12-02-1914321",
            "IMG_2017-12-02-191432161",
            "IMG_2017-12-02-25143216",
            "IMG_2017-12-02-19643216",
            "IMG_2017-12-02-19146216",
        ] {
            // The date-only fallback remains available, but malformed numeric
            // suffixes must not be represented as a trustworthy clock time.
            let (ts, date_only) = parse_filename_for_h1(stem).unwrap();
            assert!(date_only, "{stem}");
            assert_eq!(render_ts(&ts), "2017-12-02 00:00:00", "{stem}");
        }
        let input = DatesInput {
            file_stem: Some("IMG_2017-12-02-19143216".into()),
            date_time_original: Some(dt(2020, 1, 1, 10, 0, 0, None)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert_eq!(out.n_dto_from_filename, 0);
        assert_eq!(
            display(edit_value(
                &out.output.unwrap(),
                "XMP-photoshop:DateCreated"
            )),
            "2020-01-01T10:00:00"
        );
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
            file_date_created: Some(1_700_000_000),
            file_date_modified: Some(1_600_000_000),
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

    #[test]
    fn filename_fallback_remains_available_when_os_timestamps_are_present() {
        let input = DatesInput {
            file_stem: Some("IMG_20240615_143045".into()),
            file_date_created: Some(1_700_000_000),
            file_date_modified: Some(1_600_000_000),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        let g = out.output.unwrap();
        assert_eq!(
            display(edit_value(&g, "ExifIFD:DateTimeOriginal")),
            "2024-06-15T14:30:45"
        );
        assert_eq!(out.n_dto_from_filename, 1);
    }

    #[test]
    fn os_timestamps_are_not_used_as_h1_fallback() {
        let input = DatesInput {
            file_stem: Some("received_without_date".into()),
            file_date_created: Some(1_700_000_000),
            file_date_modified: Some(1_600_000_000),
            ..Default::default()
        };

        let out = normalise_dates_with_fallback_offset(&input, None);
        assert!(out.output.is_none());
        assert_eq!(out.n_dto_from_filename, 0);
        assert_eq!(out.n_dto_from_filename_date_only, 0);
    }

    #[test]
    fn iptc_time_strips_subsecond() {
        let input = DatesInput {
            date_time_original: Some(MetadataValue::DateTime(dt_value(
                date_value(2024, 6, 15),
                time_value(14, 30, 45, Some("123".into()), None),
            ))),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None)
            .output
            .unwrap();
        // EXIF/XMP should carry subsecond through.
        let xmp = edit_value(&out, "XMP-photoshop:DateCreated");
        assert_eq!(display(xmp), "2024-06-15T14:30:45.123");
        // IPTC time must have subsecond stripped (projection).
        let iptc = edit_value(&out, "IPTC:TimeCreated");
        match iptc {
            MetadataValue::Time(t) => {
                assert_eq!(t.subsecond, None, "IPTC time must not carry subsecond");
            }
            other => panic!("expected Time value, got {:?}", other),
        }
    }

    #[test]
    fn clean_iptc_value_with_related_subsecond_is_noop() {
        // When IPTC already has the correct h/m/s/offset, no IPTC drafts
        // should be emitted — even though the canonical carries subsecond.
        let input = DatesInput {
            date_time_original: Some(MetadataValue::DateTime(dt_value(
                date_value(2024, 6, 15),
                time_value(14, 30, 45, Some("456".into()), None),
            ))),
            photoshop_date_created: Some(MetadataValue::DateTime(dt_value(
                date_value(2024, 6, 15),
                time_value(14, 30, 45, Some("456".into()), None),
            ))),
            iptc_date_created: Some(date(2024, 6, 15)),
            iptc_time_created: Some(time(14, 30, 45, None)),
            ..Default::default()
        };
        let out = normalise_dates_with_fallback_offset(&input, None);
        assert!(
            out.output.is_none(),
            "clean IPTC projection must not churn: {:?}",
            out.output
        );
    }

    #[test]
    fn stale_iptc_subsecond_draft_is_reprojected_without_rewriting_date() {
        let input = DatesInput {
            date_time_original: Some(MetadataValue::DateTime(dt_value(
                date_value(2024, 6, 15),
                time_value(14, 30, 45, Some("456".into()), None),
            ))),
            photoshop_date_created: Some(MetadataValue::DateTime(dt_value(
                date_value(2024, 6, 15),
                time_value(14, 30, 45, Some("456".into()), None),
            ))),
            iptc_date_created: Some(date(2024, 6, 15)),
            iptc_time_created: Some(MetadataValue::Time(time_value(
                14,
                30,
                45,
                Some("456".into()),
                None,
            ))),
            ..Default::default()
        };

        let output = normalise_dates_with_fallback_offset(&input, None)
            .output
            .expect("stale IPTC time draft must be reprojected");

        assert!(
            !output
                .edits
                .contains_key(&crate::known_ids::iptc_date_created()),
            "already-correct IPTC date must not be rewritten: {:?}",
            output.edits
        );
        let time = edit_value(&output, "IPTC:TimeCreated");
        assert_eq!(display(time), "14:30:45");
    }

    #[test]
    fn iptc_split_fields_are_compared_independently() {
        let input = DatesInput {
            date_time_original: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            photoshop_date_created: Some(dt(2024, 6, 15, 14, 30, 45, None)),
            iptc_date_created: Some(date(2024, 6, 14)),
            iptc_time_created: Some(time(14, 30, 45, None)),
            ..Default::default()
        };

        let output = normalise_dates_with_fallback_offset(&input, None)
            .output
            .expect("incorrect IPTC date must be reprojected");

        assert_eq!(
            display(edit_value(&output, "IPTC:DateCreated")),
            "2024-06-15"
        );
        assert!(
            !output
                .edits
                .contains_key(&crate::known_ids::iptc_time_created()),
            "already-correct IPTC time must not be rewritten: {:?}",
            output.edits
        );
    }
    #[test]
    fn stale_digital_creation_subsecond_draft_is_reprojected_without_rewriting_date() {
        let input = DatesInput {
            create_date: Some(MetadataValue::DateTime(dt_value(
                date_value(2024, 6, 15),
                time_value(14, 30, 45, Some("456".into()), None),
            ))),
            xmp_create_date: Some(MetadataValue::DateTime(dt_value(
                date_value(2024, 6, 15),
                time_value(14, 30, 45, Some("456".into()), None),
            ))),
            iptc_digital_creation_date: Some(date(2024, 6, 15)),
            iptc_digital_creation_time: Some(MetadataValue::Time(time_value(
                14,
                30,
                45,
                Some("456".into()),
                None,
            ))),
            ..Default::default()
        };

        let output = normalise_dates_with_fallback_offset(&input, None)
            .output
            .expect("stale IPTC digital creation time draft must be reprojected");

        assert!(
            !output
                .edits
                .contains_key(&crate::known_ids::iptc_digital_creation_date()),
            "already-correct IPTC digital creation date must not be rewritten: {:?}",
            output.edits
        );
        let time = edit_value(&output, "IPTC:DigitalCreationTime");
        assert_eq!(display(time), "14:30:45");
    }
}
