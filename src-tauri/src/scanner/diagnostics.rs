use super::json_preview;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub(super) struct ParseWarning {
    pub rel_path: String,
    pub tag: String,
    pub pass_name: String,
    pub expected: String,
    pub raw_type: &'static str,
    pub raw: serde_json::Value,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum ParseWarningCategory {
    MissingSchema,
    UnknownSchemaKind,
    ParseFailed,
}

pub(super) fn classify_warning(reason: &str) -> ParseWarningCategory {
    if reason == "no schema entry for tag" {
        ParseWarningCategory::MissingSchema
    } else if reason == "schema kind is unknown" {
        ParseWarningCategory::UnknownSchemaKind
    } else {
        ParseWarningCategory::ParseFailed
    }
}

pub(super) fn log_single_warning(w: &ParseWarning) {
    let category = classify_warning(&w.reason);
    match category {
        ParseWarningCategory::MissingSchema | ParseWarningCategory::UnknownSchemaKind => {
            log::warn!(
                "[parse_exiftool] Schema gap: file={} tag={} pass={} raw_type={} raw={} reason={}",
                w.rel_path,
                w.tag,
                w.pass_name,
                w.raw_type,
                json_preview(&w.raw),
                w.reason
            );
        }
        ParseWarningCategory::ParseFailed => {
            log::warn!(
                "[parse_exiftool] Unparsed metadata: file={} tag={} pass={} expected={} raw_type={} raw={} reason={}",
                w.rel_path,
                w.tag,
                w.pass_name,
                w.expected,
                w.raw_type,
                json_preview(&w.raw),
                w.reason
            );
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) struct WarningGroupKey {
    pub(super) tag: String,
    pub(super) reason: String,
    pub(super) expected_summary: String,
    pub(super) raw_type: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WarningGroupValue {
    pub(super) count: usize,
    pub(super) examples: Vec<String>,
    pub(super) raw_preview: Option<String>,
}

pub(super) fn group_parse_warnings(
    warnings: &[ParseWarning],
) -> BTreeMap<WarningGroupKey, WarningGroupValue> {
    let mut groups: BTreeMap<WarningGroupKey, WarningGroupValue> = BTreeMap::new();
    for w in warnings {
        let key = WarningGroupKey {
            tag: w.tag.clone(),
            reason: w.reason.clone(),
            expected_summary: w.expected.clone(),
            raw_type: w.raw_type,
        };
        let entry = groups.entry(key).or_insert_with(|| WarningGroupValue {
            count: 0,
            examples: Vec::new(),
            raw_preview: None,
        });
        entry.count += 1;
        if entry.examples.len() < 2 && !entry.examples.contains(&w.rel_path) {
            entry.examples.push(w.rel_path.clone());
        }
        if entry.raw_preview.is_none() {
            entry.raw_preview = Some(json_preview(&w.raw));
        }
    }
    groups
}

pub(super) fn log_aggregated_warnings(warnings: &[ParseWarning]) {
    for w in warnings {
        log::debug!(
            "[parse_exiftool] Unparsed metadata debug: file={} tag={} pass={} expected={} raw_type={} raw={} reason={}",
            w.rel_path,
            w.tag,
            w.pass_name,
            w.expected,
            w.raw_type,
            json_preview(&w.raw),
            w.reason
        );
    }

    let groups = group_parse_warnings(warnings);

    for (key, val) in groups {
        let category = classify_warning(&key.reason);
        match category {
            ParseWarningCategory::MissingSchema | ParseWarningCategory::UnknownSchemaKind => {
                log::warn!(
                    "[parse_exiftool] Schema gap summary: count={} tag={} raw_type={} reason={} examples={:?} raw_example={}",
                    val.count,
                    key.tag,
                    key.raw_type,
                    key.reason,
                    val.examples,
                    val.raw_preview.as_deref().unwrap_or("")
                );
            }
            ParseWarningCategory::ParseFailed => {
                log::warn!(
                    "[parse_exiftool] Unparsed metadata summary: count={} tag={} expected={} raw_type={} reason={} examples={:?} raw_example={}",
                    val.count,
                    key.tag,
                    key.expected_summary,
                    key.raw_type,
                    key.reason,
                    val.examples,
                    val.raw_preview.as_deref().unwrap_or("")
                );
            }
        }
    }
}
