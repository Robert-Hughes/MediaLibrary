use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::metadata_value::{ListKind, MetadataValue};
use crate::scanner;
use crate::tag_schema::TagKind;

/// Run one exiftool write invocation against `path` with the provided args.
/// `numeric=true` prepends `-n` so values are interpreted as raw numerics.
fn run_exiftool_write(path: &Path, args: &[String], numeric: bool) -> Result<(), String> {
    let mut cmd = crate::exiftool_config::exiftool_command();
    cmd.arg("-overwrite_original");
    if numeric {
        cmd.arg("-n");
    }
    for a in args {
        cmd.arg(a);
    }
    cmd.arg(path);

    let output = cmd.output().map_err(|e| {
        format!(
            "Failed to execute ExifTool: {}. Please ensure ExifTool is installed.",
            e
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ExifTool failed ({}): {}",
            if numeric { "-n pass" } else { "text pass" },
            stderr.trim()
        ));
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct FailedFile {
    pub relative_path: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataTagOutcome {
    pub tag: String,
    pub kind: String,
    pub sent: Option<MetadataValue>,
    pub before: Option<MetadataValue>,
    pub observed: Option<MetadataValue>,
    pub message: Option<String>,
}

pub struct MetadataSingleFileOutcome {
    pub fresh_metadata: Option<HashMap<String, MetadataValue>>,
    pub error: Option<String>,
    pub outcomes: Vec<MetadataTagOutcome>,
    pub tags_to_clear: Vec<String>,
}

impl MetadataSingleFileOutcome {
    fn hard_failure(reason: String) -> Self {
        Self {
            fresh_metadata: None,
            error: Some(reason),
            outcomes: Vec::new(),
            tags_to_clear: Vec::new(),
        }
    }
}

#[derive(Serialize, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyEditsResult {
    pub applied: Vec<String>,
    pub failed: Vec<FailedFile>,
    pub fresh_metadata: HashMap<String, HashMap<String, MetadataValue>>,
}

pub fn apply_single_file_metadata(
    folder_path: &str,
    rel_path: &str,
    edits: &HashMap<String, crate::draft_edits::MetadataDraftEdit>,
) -> MetadataSingleFileOutcome {
    if edits.is_empty() {
        return MetadataSingleFileOutcome::hard_failure("No edits to apply".to_string());
    }

    let abs_path =
        Path::new(folder_path).join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));

    for key in edits.keys() {
        if key.contains('\n') || key.contains('\0') {
            return MetadataSingleFileOutcome::hard_failure(format!("Invalid tag key: {:?}", key));
        }
    }

    if !abs_path.exists() {
        return MetadataSingleFileOutcome::hard_failure(format!(
            "File not found: {}",
            abs_path.display()
        ));
    }

    let registry = crate::tag_schema::get_registry().ok();

    let (before_metadata, before_read_failed) = match scanner::read_image_metadata_batch(
        &[rel_path.to_string()],
        std::slice::from_ref(&abs_path),
    ) {
        Ok(mut results) => match results.pop() {
            Some(r) => (r.metadata, false),
            None => (HashMap::new(), false),
        },
        Err(e) => {
            log::warn!(
                "[apply_edits] Semantic pre-write read failed for {}: {}",
                rel_path,
                e
            );
            (HashMap::new(), true)
        }
    };

    let mut combined = crate::write_args::BuiltArgs::default();
    let mut argv_by_tag: HashMap<String, Vec<String>> = HashMap::new();
    for (key, edit) in edits {
        let info = registry.and_then(|r| r.lookup(key));
        let args = match crate::write_args::build_metadata_args(key, info, edit) {
            Ok(args) => args,
            Err(e) => return MetadataSingleFileOutcome::hard_failure(e),
        };
        let mut tag_argv = args.numeric.clone();
        tag_argv.extend(args.text.clone());
        argv_by_tag.insert(key.clone(), tag_argv);
        combined.extend(args);
    }

    if combined.is_empty() {
        return MetadataSingleFileOutcome::hard_failure(
            "build_metadata_args produced no arguments (all tags rejected?)".to_string(),
        );
    }

    if !combined.numeric.is_empty() {
        if let Err(e) = run_exiftool_write(&abs_path, &combined.numeric, true) {
            return MetadataSingleFileOutcome::hard_failure(e);
        }
    }
    if !combined.text.is_empty() {
        if let Err(e) = run_exiftool_write(&abs_path, &combined.text, false) {
            return MetadataSingleFileOutcome::hard_failure(e);
        }
    }

    let fresh_metadata =
        match scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path]) {
            Ok(mut results) => match results.pop() {
                Some(r) => r.metadata,
                None => {
                    return MetadataSingleFileOutcome::hard_failure(
                        "Post-write read returned no entry".to_string(),
                    )
                }
            },
            Err(e) => {
                return MetadataSingleFileOutcome::hard_failure(format!(
                    "Post-write read failed: {}",
                    e
                ))
            }
        };

    use crate::draft_edits::EditIntent;
    let mut tag_outcomes = Vec::with_capacity(edits.len());
    let mut tags_to_clear = Vec::new();
    let mut first_mismatch = None;

    for (key, edit) in edits {
        let info = registry.and_then(|r| r.lookup(key));
        let kind = info.map(|i| i.kind.clone());
        let (outcome_kind, message) = match edit.intent {
            EditIntent::Delete => verify_metadata_delete(key, &fresh_metadata),
            EditIntent::Set => {
                verify_metadata_set(key, edit.value.as_ref(), &fresh_metadata, kind.as_ref())
            }
            EditIntent::ListAdd => {
                verify_metadata_list_add(key, edit.value.as_ref(), &fresh_metadata, kind.as_ref())
            }
            EditIntent::ListRemove => verify_metadata_list_remove(
                key,
                edit.value.as_ref(),
                &fresh_metadata,
                kind.as_ref(),
            ),
        };

        match outcome_kind.as_str() {
            "Match" | "DeleteOk" => tags_to_clear.push(key.clone()),
            "Coerced" => {}
            _ => {
                if first_mismatch.is_none() {
                    first_mismatch = message.clone();
                }
            }
        }

        tag_outcomes.push(MetadataTagOutcome {
            tag: key.clone(),
            kind: outcome_kind,
            sent: edit.value.clone(),
            before: before_metadata.get(key).cloned(),
            observed: fresh_metadata.get(key).cloned(),
            message,
        });
    }

    crate::apply_log::append_metadata_entries(
        folder_path,
        rel_path,
        edits,
        &argv_by_tag,
        &before_metadata,
        &fresh_metadata,
        &tag_outcomes,
        before_read_failed,
    );

    MetadataSingleFileOutcome {
        fresh_metadata: Some(fresh_metadata),
        error: first_mismatch,
        outcomes: tag_outcomes,
        tags_to_clear,
    }
}

fn verify_metadata_set(
    key: &str,
    expected: Option<&MetadataValue>,
    fresh_metadata: &HashMap<String, MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };

    let observed = fresh_metadata.get(key);

    if metadata_empty_value(expected) && metadata_empty_or_absent(observed) {
        return ("Match".to_string(), None);
    }

    if observed.is_none() {
        return (
            "MissingPostWrite".to_string(),
            Some(format!(
                "Tag {} absent after write (format may not support it)",
                key
            )),
        );
    }

    if observed.is_some_and(|v| metadata_strict_eq(v, expected)) {
        return ("Match".to_string(), None);
    }

    if observed.is_some_and(metadata_unparsed) {
        return (
            "UnparsedPostWrite".to_string(),
            Some(format!(
                "Post-write value for {} could not be parsed semantically",
                key
            )),
        );
    }

    if matches_metadata_value(observed, expected, kind) {
        return (
            "Coerced".to_string(),
            Some(format!(
                "exiftool normalised {}: sent {:?}, file holds {:?}",
                key, expected, observed
            )),
        );
    }

    (
        "Mismatch".to_string(),
        Some(format!(
            "Verification failed for {}: expected {:?}, got {:?}",
            key, expected, observed
        )),
    )
}

fn verify_metadata_delete(
    key: &str,
    fresh_metadata: &HashMap<String, MetadataValue>,
) -> (String, Option<String>) {
    if metadata_empty_or_absent(fresh_metadata.get(key)) {
        ("DeleteOk".to_string(), None)
    } else {
        (
            "DeleteLingering".to_string(),
            Some(format!(
                "Delete verification failed for {}: tag still present ({:?})",
                key,
                fresh_metadata.get(key)
            )),
        )
    }
}

fn verify_metadata_list_add(
    key: &str,
    expected: Option<&MetadataValue>,
    fresh_metadata: &HashMap<String, MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };
    if metadata_list_contains_all(fresh_metadata.get(key), expected, kind) {
        return ("Match".to_string(), None);
    }
    (
        "Mismatch".to_string(),
        Some(format!(
            "ListAdd verification failed for {}: items {:?} not all present",
            key, expected
        )),
    )
}

fn verify_metadata_list_remove(
    key: &str,
    expected: Option<&MetadataValue>,
    fresh_metadata: &HashMap<String, MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };
    if metadata_list_contains_none(fresh_metadata.get(key), expected, kind) {
        return ("Match".to_string(), None);
    }
    (
        "Mismatch".to_string(),
        Some(format!(
            "ListRemove verification failed for {}: items {:?} still present",
            key, expected
        )),
    )
}

fn metadata_list_contains_all(
    actual: Option<&MetadataValue>,
    expected: &MetadataValue,
    kind: Option<&TagKind>,
) -> bool {
    let expected_items: &[MetadataValue] = match expected {
        MetadataValue::List { items, .. } => items,
        scalar => return matches_metadata_value(actual, scalar, kind),
    };
    let Some(MetadataValue::List {
        items: actual_items,
        ..
    }) = actual
    else {
        return false;
    };
    expected_items.iter().all(|expected| {
        actual_items
            .iter()
            .any(|actual| matches_metadata_value(Some(actual), expected, list_inner_kind(kind)))
    })
}

fn metadata_list_contains_none(
    actual: Option<&MetadataValue>,
    expected: &MetadataValue,
    kind: Option<&TagKind>,
) -> bool {
    let expected_items: &[MetadataValue] = match expected {
        MetadataValue::List { items, .. } => items,
        scalar => std::slice::from_ref(scalar),
    };
    let Some(MetadataValue::List {
        items: actual_items,
        ..
    }) = actual
    else {
        return true;
    };
    expected_items.iter().all(|expected| {
        actual_items
            .iter()
            .all(|actual| !matches_metadata_value(Some(actual), expected, list_inner_kind(kind)))
    })
}

fn metadata_unparsed(value: &MetadataValue) -> bool {
    matches!(value, MetadataValue::Unknown { .. })
}

fn metadata_empty_value(value: &MetadataValue) -> bool {
    matches!(value, MetadataValue::Null)
        || matches!(value, MetadataValue::Text(s) if s.is_empty())
        || matches!(value, MetadataValue::List { items, .. } if items.is_empty())
}

fn metadata_empty_or_absent(value: Option<&MetadataValue>) -> bool {
    match value {
        None => true,
        Some(value) => metadata_empty_value(value),
    }
}

const STRICT_FLOAT_EPS: f64 = 1e-9;

fn metadata_strict_eq(a: &MetadataValue, b: &MetadataValue) -> bool {
    match (a, b) {
        (MetadataValue::Null, MetadataValue::Null) => true,
        (MetadataValue::Text(a), MetadataValue::Text(b)) => a == b,
        (MetadataValue::Bool(a), MetadataValue::Bool(b)) => a == b,
        (MetadataValue::Integer(a), MetadataValue::Integer(b)) => a == b,
        (MetadataValue::Real(a), MetadataValue::Real(b)) => (a - b).abs() < STRICT_FLOAT_EPS,
        (MetadataValue::Rational(a), MetadataValue::Rational(b)) => {
            (a.numerator as i128) * (b.denominator as i128)
                == (b.numerator as i128) * (a.denominator as i128)
        }
        (MetadataValue::Date(a), MetadataValue::Date(b)) => a == b,
        (MetadataValue::Time(a), MetadataValue::Time(b)) => a == b,
        (MetadataValue::DateTime(a), MetadataValue::DateTime(b)) => a == b,
        (MetadataValue::TimeOffset(a), MetadataValue::TimeOffset(b)) => a == b,
        (MetadataValue::LangAlt(a), MetadataValue::LangAlt(b)) => a == b,
        (
            MetadataValue::List {
                list_kind: ak,
                items: a,
            },
            MetadataValue::List {
                list_kind: bk,
                items: b,
            },
        ) => {
            ak == bk && a.len() == b.len() && a.iter().zip(b).all(|(a, b)| metadata_strict_eq(a, b))
        }
        (MetadataValue::Struct(a), MetadataValue::Struct(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, av)| b.get(key).is_some_and(|bv| metadata_strict_eq(av, bv)))
        }
        (MetadataValue::Binary, MetadataValue::Binary) => true,
        (
            MetadataValue::Unknown {
                expected: ae,
                raw: ar,
                reason: _,
            },
            MetadataValue::Unknown {
                expected: be,
                raw: br,
                reason: _,
            },
        ) => ae == be && ar == br,
        _ => false,
    }
}

fn matches_metadata_value(
    actual: Option<&MetadataValue>,
    expected: &MetadataValue,
    kind: Option<&TagKind>,
) -> bool {
    let Some(actual) = actual else {
        return matches!(expected, MetadataValue::Null);
    };

    if metadata_strict_eq(actual, expected) {
        return true;
    }

    match (actual, expected) {
        (MetadataValue::Integer(a), MetadataValue::Real(b)) => (*a as f64 - *b).abs() < 1e-6,
        (MetadataValue::Real(a), MetadataValue::Integer(b)) => (*a - *b as f64).abs() < 1e-6,
        (MetadataValue::Real(a), MetadataValue::Real(b)) => (a - b).abs() < 1e-6,
        (MetadataValue::Rational(a), MetadataValue::Rational(b)) => {
            (a.numerator as i128) * (b.denominator as i128)
                == (b.numerator as i128) * (a.denominator as i128)
        }
        (
            MetadataValue::List {
                list_kind,
                items: actual_items,
            },
            MetadataValue::List {
                items: expected_items,
                ..
            },
        ) => metadata_lists_match(actual_items, expected_items, list_kind, kind),
        (MetadataValue::Struct(actual), MetadataValue::Struct(expected)) => {
            expected.iter().all(|(key, ev)| {
                actual.get(key).is_some_and(|av| {
                    matches_metadata_value(Some(av), ev, struct_field_kind(kind, key))
                })
            })
        }
        (MetadataValue::Unknown { raw: ar, .. }, MetadataValue::Unknown { raw: er, .. }) => {
            ar == er
        }
        _ => false,
    }
}

fn metadata_lists_match(
    actual: &[MetadataValue],
    expected: &[MetadataValue],
    list_kind: &ListKind,
    kind: Option<&TagKind>,
) -> bool {
    let inner_kind = match kind {
        Some(TagKind::Bag(inner) | TagKind::Seq(inner) | TagKind::Alt(inner)) => {
            Some(inner.as_ref())
        }
        _ => None,
    };
    match list_kind {
        ListKind::Seq => {
            actual.len() == expected.len()
                && actual
                    .iter()
                    .zip(expected)
                    .all(|(a, e)| matches_metadata_value(Some(a), e, inner_kind))
        }
        ListKind::Bag | ListKind::Alt | ListKind::Unknown => {
            let mut used = vec![false; actual.len()];
            'expected: for e in expected {
                for (idx, a) in actual.iter().enumerate() {
                    if !used[idx] && matches_metadata_value(Some(a), e, inner_kind) {
                        used[idx] = true;
                        continue 'expected;
                    }
                }
                return false;
            }
            true
        }
    }
}

fn struct_field_kind<'a>(kind: Option<&'a TagKind>, key: &str) -> Option<&'a TagKind> {
    match kind {
        Some(TagKind::Struct(fields)) => fields.get(key),
        _ => None,
    }
}

fn list_inner_kind(kind: Option<&TagKind>) -> Option<&TagKind> {
    match kind {
        Some(TagKind::Bag(inner) | TagKind::Seq(inner) | TagKind::Alt(inner)) => Some(inner),
        _ => None,
    }
}

pub fn apply_metadata_draft_edits(
    folder_path: &str,
    rel_paths: &[String],
    drafts: &HashMap<String, HashMap<String, crate::draft_edits::MetadataDraftEdit>>,
) -> MetadataApplyEditsResult {
    let mut applied = Vec::new();
    let mut failed = Vec::new();
    let mut fresh_metadata = HashMap::new();

    for rel_path in rel_paths {
        let edits = match drafts.get(rel_path) {
            Some(e) if !e.is_empty() => e,
            _ => continue,
        };
        let outcome = apply_single_file_metadata(folder_path, rel_path, edits);
        if let Some(meta) = outcome.fresh_metadata {
            fresh_metadata.insert(rel_path.clone(), meta);
        }
        match outcome.error {
            None => applied.push(rel_path.clone()),
            Some(reason) => failed.push(FailedFile {
                relative_path: rel_path.clone(),
                reason,
            }),
        }
    }

    MetadataApplyEditsResult {
        applied,
        failed,
        fresh_metadata,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_value::{DateValue, OffsetSign, RationalValue, TimeValue, UtcOffsetValue};

    fn metadata_map(pairs: &[(&str, MetadataValue)]) -> HashMap<String, MetadataValue> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    fn metadata_edit(value: MetadataValue) -> crate::draft_edits::MetadataDraftEdit {
        crate::draft_edits::MetadataDraftEdit {
            value: Some(value),
            intent: crate::draft_edits::EditIntent::Set,
            display: None,
        }
    }

    #[test]
    fn semantic_apply_empty_edits_is_hard_failure() {
        let outcome = apply_single_file_metadata("/tmp", "photo.jpg", &HashMap::new());
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("No edits"));
    }

    #[test]
    fn semantic_apply_invalid_key_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert(
            "Bad\nKey".to_string(),
            metadata_edit(MetadataValue::Text("x".into())),
        );
        let outcome = apply_single_file_metadata("/tmp", "photo.jpg", &edits);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("Invalid tag key"));
    }

    #[test]
    fn semantic_apply_missing_file_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert(
            "XMP-dc:Title".to_string(),
            metadata_edit(MetadataValue::Text("x".into())),
        );
        let outcome = apply_single_file_metadata("/tmp", "missing_metadata_semantic.jpg", &edits);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("File not found"));
    }

    #[test]
    fn semantic_apply_blocks_binary_before_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        std::fs::write(&path, b"not a real image").unwrap();
        let mut edits = HashMap::new();
        edits.insert(
            "IFD1:ThumbnailImage".to_string(),
            metadata_edit(MetadataValue::Binary),
        );
        let outcome = apply_single_file_metadata(dir.path().to_str().unwrap(), "a.jpg", &edits);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("binary"));
    }

    #[test]
    fn verify_metadata_set_distinguishes_match_coerced_mismatch_missing_and_unparsed() {
        let metadata = metadata_map(&[("X", MetadataValue::Integer(5))]);
        let (kind, _) = verify_metadata_set("X", Some(&MetadataValue::Integer(5)), &metadata, None);
        assert_eq!(kind, "Match");

        let metadata = metadata_map(&[("X", MetadataValue::Real(5.0))]);
        let (kind, _) = verify_metadata_set("X", Some(&MetadataValue::Integer(5)), &metadata, None);
        assert_eq!(kind, "Coerced");

        let metadata = metadata_map(&[("X", MetadataValue::Text("other".into()))]);
        let (kind, _) = verify_metadata_set("X", Some(&MetadataValue::Integer(5)), &metadata, None);
        assert_eq!(kind, "Mismatch");

        let (kind, _) =
            verify_metadata_set("X", Some(&MetadataValue::Integer(5)), &HashMap::new(), None);
        assert_eq!(kind, "MissingPostWrite");

        let metadata = metadata_map(&[(
            "X",
            MetadataValue::Unknown {
                expected: Some(TagKind::Integer {
                    min: None,
                    max: None,
                }),
                raw: serde_json::json!("bad"),
                reason: Some("bad integer".into()),
            },
        )]);
        let (kind, _) = verify_metadata_set("X", Some(&MetadataValue::Integer(5)), &metadata, None);
        assert_eq!(kind, "UnparsedPostWrite");
    }

    #[test]
    fn verify_metadata_rational_equivalence_uses_cross_multiply() {
        let metadata = metadata_map(&[(
            "EXIF:ExposureTime",
            MetadataValue::Rational(RationalValue {
                numerator: 2,
                denominator: 500,
            }),
        )]);
        let expected = MetadataValue::Rational(RationalValue {
            numerator: 1,
            denominator: 250,
        });
        let (kind, _) = verify_metadata_set(
            "EXIF:ExposureTime",
            Some(&expected),
            &metadata,
            Some(&TagKind::Rational),
        );
        assert_eq!(kind, "Match");
    }

    #[test]
    fn verify_metadata_bag_ignores_order_but_seq_respects_order() {
        let actual = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![
                MetadataValue::Text("b".into()),
                MetadataValue::Text("a".into()),
            ],
        };
        let expected = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![
                MetadataValue::Text("a".into()),
                MetadataValue::Text("b".into()),
            ],
        };
        assert!(matches_metadata_value(
            Some(&actual),
            &expected,
            Some(&TagKind::Bag(Box::new(TagKind::Text)))
        ));

        let actual = MetadataValue::List {
            list_kind: ListKind::Seq,
            items: vec![
                MetadataValue::Text("b".into()),
                MetadataValue::Text("a".into()),
            ],
        };
        let expected = MetadataValue::List {
            list_kind: ListKind::Seq,
            items: vec![
                MetadataValue::Text("a".into()),
                MetadataValue::Text("b".into()),
            ],
        };
        assert!(!matches_metadata_value(
            Some(&actual),
            &expected,
            Some(&TagKind::Seq(Box::new(TagKind::Text)))
        ));
    }

    #[test]
    fn verify_metadata_time_offset_presence_is_not_globally_equal() {
        let offsetless = MetadataValue::Time(TimeValue {
            hour: 10,
            minute: 56,
            second: 5,
            subsecond: None,
            offset: None,
        });
        let offset = MetadataValue::Time(TimeValue {
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
        assert!(!matches_metadata_value(
            Some(&offset),
            &offsetless,
            Some(&TagKind::Time)
        ));
    }

    #[test]
    fn verify_metadata_date_values_match_exactly() {
        let metadata = metadata_map(&[(
            "IPTC:DateCreated",
            MetadataValue::Date(DateValue {
                year: 2026,
                month: 7,
                day: 4,
            }),
        )]);
        let expected = MetadataValue::Date(DateValue {
            year: 2026,
            month: 7,
            day: 4,
        });
        let (kind, _) = verify_metadata_set(
            "IPTC:DateCreated",
            Some(&expected),
            &metadata,
            Some(&TagKind::Date),
        );
        assert_eq!(kind, "Match");
    }
}
