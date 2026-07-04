//! Group H — Dates (H1 Shutter + H2 Digitised).
//!
//! Plan §1 Group H. Two sub-groups, treated independently:
//!
//!   H1 Shutter time   — `ExifIFD:DateTimeOriginal` is primary; mirrors
//!                       are `XMP-photoshop:DateCreated`,
//!                       `IPTC:DateCreated` + `IPTC:TimeCreated`.
//!   H2 Digitised time — `ExifIFD:CreateDate` is primary; mirrors are
//!                       `XMP-xmp:CreateDate`,
//!                       `IPTC:DigitalCreationDate` +
//!                       `IPTC:DigitalCreationTime`.
//!
//! H3 (Modify time) is intentionally skipped — exiftool auto-updates
//! modify timestamps on every write.
//!
//! Canonical form: ISO 8601 datetime, optional sub-second precision
//! preserved when any source supplies it, optional timezone offset
//! preserved when any EXIF Offset* tag supplies it.

use super::{DatesInput, GroupOutput};
use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Parsed datetime that drives both projection (to derivatives) and
/// equality comparison (idempotency).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedDateTime {
    /// "YYYY-MM-DD".
    date: String,
    /// "HH:MM:SS".
    time: String,
    /// Sub-second digits without leading dot, e.g. "123" → ".123";
    /// empty when no source had sub-seconds.
    subsec: String,
    /// "+HH:MM" / "-HH:MM" / "Z"; empty when no offset known.
    offset: String,
}

impl ParsedDateTime {
    fn to_canonical(&self) -> String {
        let mut s = String::with_capacity(32);
        s.push_str(&self.date);
        s.push('T');
        s.push_str(&self.time);
        if !self.subsec.is_empty() {
            s.push('.');
            s.push_str(&self.subsec);
        }
        s.push_str(&self.offset);
        s
    }

    fn iptc_date(&self) -> String {
        self.date.clone()
    }

    fn iptc_time(&self) -> String {
        let mut s = String::with_capacity(16);
        s.push_str(&self.time);
        if !self.subsec.is_empty() {
            s.push('.');
            s.push_str(&self.subsec);
        }
        s.push_str(&self.offset);
        s
    }
}

/// Parse a datetime string in any of the common shapes we see:
///   * `"YYYY:MM:DD HH:MM:SS"`               (EXIF)
///   * `"YYYY-MM-DD HH:MM:SS"`               (some IPTC tools)
///   * `"YYYY-MM-DDTHH:MM:SS"`               (XMP / ISO)
///   * `"YYYY-MM-DDTHH:MM:SS.sss"`           (with sub-seconds)
///   * `"…[+HH:MM]"` / `"…[-HH:MM]"` / `"…Z"` (with offset)
fn parse_datetime_str(
    s: &str,
    default_offset: &str,
    default_subsec: &str,
) -> Option<ParsedDateTime> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year = &s[0..4];
    let m_sep = bytes[4] as char;
    if m_sep != '-' && m_sep != ':' {
        return None;
    }
    let month = &s[5..7];
    let d_sep = bytes[7] as char;
    if d_sep != '-' && d_sep != ':' {
        return None;
    }
    let day = &s[8..10];
    if !year.chars().all(|c| c.is_ascii_digit())
        || !month.chars().all(|c| c.is_ascii_digit())
        || !day.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let dt_sep = bytes[10] as char;
    if dt_sep != ' ' && dt_sep != 'T' {
        return None;
    }
    let hour = &s[11..13];
    if bytes[13] as char != ':' {
        return None;
    }
    let minute = &s[14..16];
    if bytes[16] as char != ':' {
        return None;
    }
    let second = &s[17..19];
    if !hour.chars().all(|c| c.is_ascii_digit())
        || !minute.chars().all(|c| c.is_ascii_digit())
        || !second.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let mut rest = &s[19..];
    let mut subsec = String::new();
    if rest.starts_with('.') {
        let after_dot = &rest[1..];
        let digits: String = after_dot
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            return None;
        }
        subsec = digits.clone();
        rest = &rest[1 + digits.len()..];
    }
    let offset = if rest.is_empty() {
        default_offset.to_string()
    } else if rest == "Z" {
        "+00:00".to_string()
    } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) {
        rest.to_string()
    } else if rest.len() == 5 && (rest.starts_with('+') || rest.starts_with('-')) {
        let mut o = String::with_capacity(6);
        o.push_str(&rest[..3]);
        o.push(':');
        o.push_str(&rest[3..]);
        o
    } else {
        return None;
    };
    if subsec.is_empty() && !default_subsec.is_empty() {
        subsec = default_subsec.to_string();
    }
    Some(ParsedDateTime {
        date: format!("{}-{}-{}", year, month, day),
        time: format!("{}:{}:{}", hour, minute, second),
        subsec,
        offset,
    })
}

fn parse_iptc_date_time(
    date_s: &str,
    time_s: Option<&str>,
    default_offset: &str,
    default_subsec: &str,
) -> Option<ParsedDateTime> {
    let date_s = date_s.trim();
    if date_s.len() < 10 {
        return None;
    }
    let time_part = time_s
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("00:00:00");
    let synthetic = format!("{}T{}", &date_s[..10], time_part);
    parse_datetime_str(&synthetic, default_offset, default_subsec)
}

#[derive(Debug, Clone, Default)]
struct DateSubgroupResult {
    edits: HashMap<String, DraftEdit>,
    conflict: bool,
}

#[allow(clippy::too_many_arguments)]
fn process_date_subgroup(
    existing_exif: Option<&ParsedDateTime>,
    existing_xmp: Option<&ParsedDateTime>,
    existing_iptc: Option<&ParsedDateTime>,
    canonical_override: Option<&ParsedDateTime>,
    exif_target_key: &str,
    xmp_target_key: &str,
    iptc_date_key: &str,
    iptc_time_key: &str,
) -> DateSubgroupResult {
    let mut conflict = false;
    let canonical: ParsedDateTime = if let Some(p) = existing_exif.cloned() {
        if let Some(o) = existing_xmp {
            if o != &p {
                conflict = true;
            }
        }
        if let Some(o) = existing_iptc {
            if o != &p {
                conflict = true;
            }
        }
        p
    } else if let Some(p) = existing_xmp.cloned() {
        if let Some(o) = existing_iptc {
            if o != &p {
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

    let mut edits = HashMap::new();
    let canonical_full = canonical.to_canonical();
    let canonical_date = canonical.iptc_date();
    let canonical_time = canonical.iptc_time();

    if existing_exif != Some(&canonical) {
        edits.insert(
            exif_target_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_full.clone())),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if existing_xmp != Some(&canonical) {
        edits.insert(
            xmp_target_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_full)),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if existing_iptc != Some(&canonical) {
        edits.insert(
            iptc_date_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_date)),
                intent: EditIntent::Set,
                display: None,
            },
        );
        edits.insert(
            iptc_time_key.to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical_time)),
                intent: EditIntent::Set,
                display: None,
            },
        );
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

/// Filename-regex fallback for missing H1 (`ExifIFD:DateTimeOriginal`).
/// Returns `(ParsedDateTime, date_only_flag)` on a match.
fn parse_filename_for_h1(stem: &str) -> Option<(ParsedDateTime, bool)> {
    static PATTERNS: OnceLock<Vec<(regex::Regex, bool, bool)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            (
                regex::Regex::new(r"PXL[_-](\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(\d{3})").unwrap(),
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
            // Plan §1 Group H pattern #6: 14-digit compact stem with
            // NO separator between date and time (e.g. `20240812143000`).
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
        .unwrap_or(2025);
    let year_max = current_year + 1;
    const YEAR_MIN: i32 = 1900;

    for (re, has_time, has_subsec) in patterns {
        if let Some(caps) = re.captures(stem) {
            let year: i32 = caps.get(1)?.as_str().parse().ok()?;
            let month: u32 = caps.get(2)?.as_str().parse().ok()?;
            let day: u32 = caps.get(3)?.as_str().parse().ok()?;
            if year < YEAR_MIN || year > year_max {
                continue;
            }
            if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
                continue;
            }
            let (hour, minute, second, time_present) = if *has_time {
                match (caps.get(4), caps.get(5), caps.get(6)) {
                    (Some(h), Some(m), Some(s)) => {
                        let h: u32 = h.as_str().parse().ok()?;
                        let m: u32 = m.as_str().parse().ok()?;
                        let s: u32 = s.as_str().parse().ok()?;
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
            let subsec = if *has_subsec {
                caps.get(7)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let parsed = ParsedDateTime {
                date: format!("{:04}-{:02}-{:02}", year, month, day),
                time: format!("{:02}:{:02}:{:02}", hour, minute, second),
                subsec,
                offset: String::new(),
            };
            return Some((parsed, !time_present));
        }
    }
    None
}

/// Run Group H (Dates — H1 + H2) normalisation for one image.
pub fn normalise_dates(input: &DatesInput) -> DatesOutcome {
    let mut edits: HashMap<String, DraftEdit> = HashMap::new();
    let mut n_conflict: u32 = 0;
    let mut n_unparseable: u32 = 0;
    let mut n_from_filename: u32 = 0;
    let mut n_from_filename_date_only: u32 = 0;

    // ── H1: Shutter time ──
    let default_offset_h1 = input
        .offset_time_original
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let default_subsec_h1 = input
        .sub_sec_time_original
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let parse = |s: Option<&str>| -> Option<ParsedDateTime> {
        s.filter(|v| !v.trim().is_empty())
            .and_then(|v| parse_datetime_str(v, &default_offset_h1, &default_subsec_h1))
    };
    let count_unparseable_if = |s: Option<&str>, parsed: &Option<ParsedDateTime>| -> u32 {
        match (s, parsed) {
            (Some(v), None) if !v.trim().is_empty() => 1,
            _ => 0,
        }
    };
    let exif_parsed = parse(input.date_time_original.as_deref());
    n_unparseable += count_unparseable_if(input.date_time_original.as_deref(), &exif_parsed);
    let xmp_parsed = parse(input.photoshop_date_created.as_deref());
    n_unparseable += count_unparseable_if(input.photoshop_date_created.as_deref(), &xmp_parsed);
    let iptc_split = match (
        input.iptc_date_created.as_deref(),
        input.iptc_time_created.as_deref(),
    ) {
        (Some(d), t) if !d.trim().is_empty() => {
            parse_iptc_date_time(d, t, &default_offset_h1, &default_subsec_h1)
        }
        _ => None,
    };
    if input
        .iptc_date_created
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        && iptc_split.is_none()
    {
        n_unparseable += 1;
    }

    let mut canonical_override: Option<ParsedDateTime> = None;
    if exif_parsed.is_none() && xmp_parsed.is_none() && iptc_split.is_none() {
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
        exif_parsed.as_ref(),
        xmp_parsed.as_ref(),
        iptc_split.as_ref(),
        canonical_override.as_ref(),
        "ExifIFD:DateTimeOriginal",
        "XMP-photoshop:DateCreated",
        "IPTC:DateCreated",
        "IPTC:TimeCreated",
    );
    if h1.conflict {
        n_conflict += 1;
    }
    edits.extend(h1.edits);

    // ── H2: Digitised time ──
    let default_offset_h2 = input
        .offset_time
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let default_subsec_h2 = input
        .sub_sec_time_digitized
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let parse2 = |s: Option<&str>| -> Option<ParsedDateTime> {
        s.filter(|v| !v.trim().is_empty())
            .and_then(|v| parse_datetime_str(v, &default_offset_h2, &default_subsec_h2))
    };
    let exif2 = parse2(input.create_date.as_deref());
    n_unparseable += count_unparseable_if(input.create_date.as_deref(), &exif2);
    let xmp2 = parse2(input.xmp_create_date.as_deref());
    n_unparseable += count_unparseable_if(input.xmp_create_date.as_deref(), &xmp2);
    let iptc2 = match (
        input.iptc_digital_creation_date.as_deref(),
        input.iptc_digital_creation_time.as_deref(),
    ) {
        (Some(d), t) if !d.trim().is_empty() => {
            parse_iptc_date_time(d, t, &default_offset_h2, &default_subsec_h2)
        }
        _ => None,
    };
    if input
        .iptc_digital_creation_date
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        && iptc2.is_none()
    {
        n_unparseable += 1;
    }
    let h2 = process_date_subgroup(
        exif2.as_ref(),
        xmp2.as_ref(),
        iptc2.as_ref(),
        None,
        "ExifIFD:CreateDate",
        "XMP-xmp:CreateDate",
        "IPTC:DigitalCreationDate",
        "IPTC:DigitalCreationTime",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String for {}, got {:?}", k, other),
        }
    }

    #[test]
    fn parse_exif_style_colon_separator() {
        let p = parse_datetime_str("2024:06:15 14:30:45", "", "").unwrap();
        assert_eq!(p.date, "2024-06-15");
        assert_eq!(p.time, "14:30:45");
        assert_eq!(p.subsec, "");
        assert_eq!(p.offset, "");
        assert_eq!(p.to_canonical(), "2024-06-15T14:30:45");
    }

    #[test]
    fn parse_iso_with_offset_and_subsec() {
        let p = parse_datetime_str("2024-06-15T14:30:45.123+01:00", "", "").unwrap();
        assert_eq!(p.subsec, "123");
        assert_eq!(p.offset, "+01:00");
        assert_eq!(p.to_canonical(), "2024-06-15T14:30:45.123+01:00");
    }

    #[test]
    fn parse_iso_with_z_offset() {
        let p = parse_datetime_str("2024-06-15T14:30:45Z", "", "").unwrap();
        assert_eq!(p.offset, "+00:00");
        assert_eq!(p.to_canonical(), "2024-06-15T14:30:45+00:00");
    }

    #[test]
    fn parse_picks_up_default_offset_when_input_has_none() {
        let p = parse_datetime_str("2024-06-15T14:30:45", "+01:00", "").unwrap();
        assert_eq!(p.offset, "+01:00");
    }

    #[test]
    fn parse_picks_up_default_subsec_when_input_has_none() {
        let p = parse_datetime_str("2024-06-15T14:30:45", "", "123").unwrap();
        assert_eq!(p.subsec, "123");
    }

    #[test]
    fn parse_garbage_returns_none() {
        assert!(parse_datetime_str("not a date", "", "").is_none());
        assert!(parse_datetime_str("2024", "", "").is_none());
    }

    #[test]
    fn h1_exif_only_propagates_to_xmp_and_iptc_split() {
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert!(!out.edits.contains_key("ExifIFD:DateTimeOriginal"));
        assert_eq!(s(&out, "XMP-photoshop:DateCreated"), "2024-06-15T14:30:45");
        assert_eq!(s(&out, "IPTC:DateCreated"), "2024-06-15");
        assert_eq!(s(&out, "IPTC:TimeCreated"), "14:30:45");
    }

    #[test]
    fn h1_with_offset_and_subsec_round_trip() {
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            offset_time_original: Some("+01:00".into()),
            sub_sec_time_original: Some("123".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert_eq!(
            s(&out, "XMP-photoshop:DateCreated"),
            "2024-06-15T14:30:45.123+01:00"
        );
        assert_eq!(s(&out, "IPTC:DateCreated"), "2024-06-15");
        assert_eq!(s(&out, "IPTC:TimeCreated"), "14:30:45.123+01:00");
    }

    #[test]
    fn h1_conflict_exif_vs_xmp_primary_wins() {
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            photoshop_date_created: Some("2024-06-15T15:00:00".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "XMP-photoshop:DateCreated"), "2024-06-15T14:30:45");
        assert_eq!(out.n_date_conflict, 1);
    }

    #[test]
    fn h1_and_h2_independent() {
        let input = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert!(out.edits.contains_key("XMP-photoshop:DateCreated"));
        assert!(!out.edits.contains_key("XMP-xmp:CreateDate"));
        assert!(!out.edits.contains_key("ExifIFD:CreateDate"));
    }

    #[test]
    fn h2_exif_only_propagates() {
        let input = DatesInput {
            create_date: Some("2024-06-15T14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert_eq!(s(&out, "XMP-xmp:CreateDate"), "2024-06-15T14:30:45");
        assert_eq!(s(&out, "IPTC:DigitalCreationDate"), "2024-06-15");
        assert_eq!(s(&out, "IPTC:DigitalCreationTime"), "14:30:45");
    }

    #[test]
    fn unparseable_input_is_counted_not_aborted() {
        let input = DatesInput {
            date_time_original: Some("garbage".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
        assert_eq!(out.n_unparseable_inputs, 1);
    }

    #[test]
    fn all_empty_returns_no_drafts() {
        let out = normalise_dates(&DatesInput::default());
        assert!(out.output.is_none());
        assert_eq!(out.n_date_conflict, 0);
        assert_eq!(out.n_unparseable_inputs, 0);
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = DatesInput {
            date_time_original: Some("2024:06:15 14:30:45".into()),
            offset_time_original: Some("+01:00".into()),
            ..Default::default()
        };
        let first = normalise_dates(&initial).output.unwrap();
        let post = DatesInput {
            date_time_original: Some("2024-06-15T14:30:45+01:00".into()),
            offset_time_original: Some("+01:00".into()),
            photoshop_date_created: Some(s(&first, "XMP-photoshop:DateCreated")),
            iptc_date_created: Some(s(&first, "IPTC:DateCreated")),
            iptc_time_created: Some(s(&first, "IPTC:TimeCreated")),
            ..Default::default()
        };
        let second = normalise_dates(&post);
        assert!(
            second.output.is_none(),
            "expected idempotent, got {:?}",
            second.output
        );
    }

    #[test]
    fn filename_fallback_pixel_with_subsec() {
        let input = DatesInput {
            file_stem: Some("PXL_20240615_143045123".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.expect("filename fallback must emit drafts");
        assert_eq!(s(&g, "ExifIFD:DateTimeOriginal"), "2024-06-15T14:30:45.123");
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 0);
    }

    #[test]
    fn filename_fallback_ios_img() {
        let input = DatesInput {
            file_stem: Some("IMG_20240615_143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "ExifIFD:DateTimeOriginal"), "2024-06-15T14:30:45");
    }

    #[test]
    fn filename_fallback_screenshot_date_only() {
        let input = DatesInput {
            file_stem: Some("Screenshot 2024-06-15".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "ExifIFD:DateTimeOriginal"), "2024-06-15T00:00:00");
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 1);
    }

    #[test]
    fn filename_fallback_screenshot_with_time() {
        let input = DatesInput {
            file_stem: Some("Screenshot 2024-06-15 14.30.45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "ExifIFD:DateTimeOriginal"), "2024-06-15T14:30:45");
        assert_eq!(out.n_dto_from_filename_date_only, 0);
    }

    #[test]
    fn filename_fallback_generic_iso() {
        let input = DatesInput {
            file_stem: Some("my photo 2024-06-15T14:30:45 final".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "ExifIFD:DateTimeOriginal"), "2024-06-15T14:30:45");
    }

    #[test]
    fn filename_fallback_compact() {
        let input = DatesInput {
            file_stem: Some("20240615_143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "ExifIFD:DateTimeOriginal"), "2024-06-15T14:30:45");
    }

    #[test]
    fn filename_fallback_compact_no_separator() {
        let input = DatesInput {
            file_stem: Some("20240615143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "ExifIFD:DateTimeOriginal"), "2024-06-15T14:30:45");
        assert_eq!(out.n_dto_from_filename, 1);
        assert_eq!(out.n_dto_from_filename_date_only, 0);
    }

    #[test]
    fn filename_fallback_never_overwrites_existing_dto() {
        let input = DatesInput {
            date_time_original: Some("2020:01:01 00:00:00".into()),
            file_stem: Some("IMG_20240615_143045".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert_eq!(out.n_dto_from_filename, 0);
        let g = out.output.unwrap();
        assert_eq!(s(&g, "XMP-photoshop:DateCreated"), "2020-01-01T00:00:00");
    }

    #[test]
    fn filename_year_out_of_bounds_rejected() {
        let input = DatesInput {
            file_stem: Some("IMG_18900101_120000".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
        assert_eq!(out.n_dto_from_filename, 0);
    }

    #[test]
    fn filename_invalid_month_rejected() {
        let input = DatesInput {
            file_stem: Some("IMG_20241335_120000".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
    }

    #[test]
    fn filename_no_match_returns_no_drafts() {
        let input = DatesInput {
            file_stem: Some("random_filename.jpg".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input);
        assert!(out.output.is_none());
        assert_eq!(out.n_dto_from_filename, 0);
    }

    #[test]
    fn iptc_split_alone_drives_canonical() {
        let input = DatesInput {
            iptc_date_created: Some("2024-06-15".into()),
            iptc_time_created: Some("14:30:45".into()),
            ..Default::default()
        };
        let out = normalise_dates(&input).output.unwrap();
        assert_eq!(s(&out, "ExifIFD:DateTimeOriginal"), "2024-06-15T14:30:45");
        assert_eq!(s(&out, "XMP-photoshop:DateCreated"), "2024-06-15T14:30:45");
    }
}
