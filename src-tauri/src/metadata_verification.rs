//! Semantic verification shared by the target-aware metadata apply pipeline.

use crate::metadata_value::{ListKind, MetadataValue};
use crate::tag_schema::{SchemaDefinitionId, TagKind};

pub(crate) fn verify_set_value(
    key: &SchemaDefinitionId,
    expected: Option<&MetadataValue>,
    observed: Option<&MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(value) => value,
        None => return ("Match".to_string(), None),
    };

    if metadata_empty_value(expected) && metadata_empty_or_absent(observed) {
        return ("Match".to_string(), None);
    }
    if observed.is_none() {
        return (
            "MissingPostWrite".to_string(),
            Some(format!(
                "Tag {key} absent after write (format may not support it)"
            )),
        );
    }
    if key.table == "IPTC::ApplicationRecord"
        && key.tag_id == "100"
        && key.index.is_none()
        && observed.is_some_and(|actual| iptc_country_code_values_match(actual, expected))
    {
        return ("Match".to_string(), None);
    }
    if observed.is_some_and(|value| metadata_strict_eq(value, expected)) {
        return ("Match".to_string(), None);
    }
    if observed.is_some_and(metadata_unparsed) {
        return (
            "UnparsedPostWrite".to_string(),
            Some(format!(
                "Post-write value for {key} could not be parsed semantically"
            )),
        );
    }
    if matches_metadata_value(observed, expected, kind) {
        return (
            "Coerced".to_string(),
            Some(format!(
                "exiftool normalised {key}: sent {expected:?}, file holds {observed:?}"
            )),
        );
    }
    (
        "Mismatch".to_string(),
        Some(format!(
            "Verification failed for {key}: expected {expected:?}, got {observed:?}"
        )),
    )
}

pub(crate) fn verify_delete_value(
    key: &SchemaDefinitionId,
    observed: Option<&MetadataValue>,
) -> (String, Option<String>) {
    if metadata_empty_or_absent(observed) {
        ("DeleteOk".to_string(), None)
    } else {
        (
            "DeleteLingering".to_string(),
            Some(format!(
                "Delete verification failed for {key}: tag still present ({observed:?})"
            )),
        )
    }
}

pub(crate) fn verify_list_add_value(
    key: &SchemaDefinitionId,
    expected: Option<&MetadataValue>,
    observed: Option<&MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    if kind.is_some_and(|kind| !matches!(kind, TagKind::Bag(_) | TagKind::Seq(_) | TagKind::Alt(_)))
    {
        return verify_set_value(key, expected, observed, kind);
    }
    let expected = match expected {
        Some(value) => value,
        None => return ("Match".to_string(), None),
    };
    if metadata_list_contains_all(observed, expected, kind) {
        return ("Match".to_string(), None);
    }
    (
        "Mismatch".to_string(),
        Some(format!(
            "ListAdd verification failed for {key}: items {expected:?} not all present"
        )),
    )
}

pub(crate) fn verify_list_remove_value(
    key: &SchemaDefinitionId,
    expected: Option<&MetadataValue>,
    observed: Option<&MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    if kind.is_some_and(|kind| !matches!(kind, TagKind::Bag(_) | TagKind::Seq(_) | TagKind::Alt(_)))
    {
        return verify_delete_value(key, observed);
    }
    let expected = match expected {
        Some(value) => value,
        None => return ("Match".to_string(), None),
    };
    if metadata_list_contains_none(observed, expected, kind) {
        return ("Match".to_string(), None);
    }
    (
        "Mismatch".to_string(),
        Some(format!(
            "ListRemove verification failed for {key}: items {expected:?} still present"
        )),
    )
}

fn iptc_country_code_values_match(actual: &MetadataValue, expected: &MetadataValue) -> bool {
    match (actual, expected) {
        (MetadataValue::Text(actual), MetadataValue::Text(expected)) => {
            crate::country_code::iptc_country_code_storage_equivalent(expected, actual)
        }
        _ => false,
    }
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
        || matches!(value, MetadataValue::Text(text) if text.is_empty())
        || matches!(value, MetadataValue::LangAlt(languages) if languages.values().all(String::is_empty))
        || matches!(value, MetadataValue::List { items, .. } if items.is_empty())
}

fn metadata_empty_or_absent(value: Option<&MetadataValue>) -> bool {
    value.is_none_or(metadata_empty_value)
}

const STRICT_FLOAT_EPS: f64 = 1e-9;

fn metadata_strict_eq(left: &MetadataValue, right: &MetadataValue) -> bool {
    match (left, right) {
        (MetadataValue::Null, MetadataValue::Null) => true,
        (MetadataValue::Text(left), MetadataValue::Text(right)) => left == right,
        (MetadataValue::Bool(left), MetadataValue::Bool(right)) => left == right,
        (MetadataValue::Integer(left), MetadataValue::Integer(right)) => left == right,
        (MetadataValue::Real(left), MetadataValue::Real(right)) => {
            (left - right).abs() < STRICT_FLOAT_EPS
        }
        (MetadataValue::Rational(left), MetadataValue::Rational(right)) => {
            (left.numerator as i128) * (right.denominator as i128)
                == (right.numerator as i128) * (left.denominator as i128)
        }
        (MetadataValue::Date(left), MetadataValue::Date(right)) => left == right,
        (MetadataValue::Time(left), MetadataValue::Time(right)) => left == right,
        (MetadataValue::DateTime(left), MetadataValue::DateTime(right)) => left == right,
        (MetadataValue::TimeOffset(left), MetadataValue::TimeOffset(right)) => left == right,
        (MetadataValue::LangAlt(left), MetadataValue::LangAlt(right)) => left == right,
        (
            MetadataValue::List {
                list_kind: left_kind,
                items: left,
            },
            MetadataValue::List {
                list_kind: right_kind,
                items: right,
            },
        ) => left_kind == right_kind && metadata_lists_strict_eq(left, right, left_kind),
        (MetadataValue::Struct(left), MetadataValue::Struct(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left_value)| {
                    right
                        .get(key)
                        .is_some_and(|right_value| metadata_strict_eq(left_value, right_value))
                })
        }
        (MetadataValue::Binary, MetadataValue::Binary) => true,
        (
            MetadataValue::Unknown {
                expected: left_expected,
                raw: left_raw,
                ..
            },
            MetadataValue::Unknown {
                expected: right_expected,
                raw: right_raw,
                ..
            },
        ) => left_expected == right_expected && left_raw == right_raw,
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
        (MetadataValue::Integer(actual), MetadataValue::Real(expected)) => {
            (*actual as f64 - *expected).abs() < 1e-6
        }
        (MetadataValue::Real(actual), MetadataValue::Integer(expected)) => {
            (*actual - *expected as f64).abs() < 1e-6
        }
        (MetadataValue::Real(actual), MetadataValue::Real(expected)) => {
            (actual - expected).abs() < 1e-6
        }
        (MetadataValue::Rational(actual), MetadataValue::Rational(expected)) => {
            (actual.numerator as i128) * (expected.denominator as i128)
                == (expected.numerator as i128) * (actual.denominator as i128)
        }
        (
            MetadataValue::List {
                list_kind: actual_kind,
                items: actual,
            },
            MetadataValue::List {
                list_kind: expected_kind,
                items: expected,
            },
        ) => {
            actual_kind == expected_kind
                && metadata_lists_match(actual, expected, actual_kind, kind)
        }
        (MetadataValue::Struct(actual), MetadataValue::Struct(expected)) => {
            expected.iter().all(|(key, expected_value)| {
                actual.get(key).is_some_and(|actual_value| {
                    matches_metadata_value(
                        Some(actual_value),
                        expected_value,
                        struct_field_kind(kind, key),
                    )
                })
            })
        }
        (
            MetadataValue::Unknown { raw: actual, .. },
            MetadataValue::Unknown { raw: expected, .. },
        ) => actual == expected,
        _ => false,
    }
}

fn metadata_lists_strict_eq(
    left: &[MetadataValue],
    right: &[MetadataValue],
    list_kind: &ListKind,
) -> bool {
    if left.len() != right.len() {
        return false;
    }
    match list_kind {
        ListKind::Seq => left
            .iter()
            .zip(right)
            .all(|(left, right)| metadata_strict_eq(left, right)),
        ListKind::Bag | ListKind::Alt | ListKind::Unknown => {
            let mut used = vec![false; right.len()];
            'left: for left_value in left {
                for (index, right_value) in right.iter().enumerate() {
                    if !used[index] && metadata_strict_eq(left_value, right_value) {
                        used[index] = true;
                        continue 'left;
                    }
                }
                return false;
            }
            true
        }
    }
}

fn metadata_lists_match(
    actual: &[MetadataValue],
    expected: &[MetadataValue],
    list_kind: &ListKind,
    kind: Option<&TagKind>,
) -> bool {
    let inner_kind = list_inner_kind(kind);
    match list_kind {
        ListKind::Seq => {
            actual.len() == expected.len()
                && actual.iter().zip(expected).all(|(actual, expected)| {
                    matches_metadata_value(Some(actual), expected, inner_kind)
                })
        }
        ListKind::Bag | ListKind::Alt | ListKind::Unknown => {
            if actual.len() != expected.len() {
                return false;
            }
            let mut used = vec![false; actual.len()];
            'expected: for expected in expected {
                for (index, actual) in actual.iter().enumerate() {
                    if !used[index] && matches_metadata_value(Some(actual), expected, inner_kind) {
                        used[index] = true;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_value::{
        DateValue, ListKind, OffsetSign, RationalValue, TimeValue, UtcOffsetValue,
    };
    use std::collections::BTreeMap;

    fn id(table: &str, tag_id: &str) -> SchemaDefinitionId {
        SchemaDefinitionId {
            table: table.to_string(),
            tag_id: tag_id.to_string(),
            index: None,
        }
    }

    #[test]
    fn set_distinguishes_exact_coerced_mismatch_missing_and_unparsed() {
        let key = id("XMP::Main", "Title");
        assert_eq!(
            verify_set_value(
                &key,
                Some(&MetadataValue::Integer(3)),
                Some(&MetadataValue::Integer(3)),
                None
            )
            .0,
            "Match"
        );
        assert_eq!(
            verify_set_value(
                &key,
                Some(&MetadataValue::Real(3.0)),
                Some(&MetadataValue::Integer(3)),
                None
            )
            .0,
            "Coerced"
        );
        assert_eq!(
            verify_set_value(
                &key,
                Some(&MetadataValue::Integer(3)),
                Some(&MetadataValue::Integer(4)),
                None
            )
            .0,
            "Mismatch"
        );
        assert_eq!(
            verify_set_value(&key, Some(&MetadataValue::Integer(3)), None, None).0,
            "MissingPostWrite"
        );
        let unknown = MetadataValue::Unknown {
            expected: None,
            raw: serde_json::json!("bad"),
            reason: Some("invalid".to_string()),
        };
        assert_eq!(
            verify_set_value(&key, Some(&MetadataValue::Integer(3)), Some(&unknown), None).0,
            "UnparsedPostWrite"
        );
    }

    #[test]
    fn rationals_compare_by_mathematical_value_and_reals_use_tolerance() {
        let key = id("Composite", "GPSLatitude");
        let half = MetadataValue::Rational(RationalValue {
            numerator: 1,
            denominator: 2,
        });
        let two_fourths = MetadataValue::Rational(RationalValue {
            numerator: 2,
            denominator: 4,
        });
        assert_eq!(
            verify_set_value(&key, Some(&half), Some(&two_fourths), None).0,
            "Match"
        );
        assert_eq!(
            verify_set_value(
                &key,
                Some(&MetadataValue::Real(51.5000004)),
                Some(&MetadataValue::Real(51.5)),
                None
            )
            .0,
            "Coerced"
        );
    }

    #[test]
    fn bags_are_unordered_sequences_are_ordered_and_nested_structs_compare() {
        let key = id("XMP::dc", "Subject");
        let a = MetadataValue::Text("a".to_string());
        let b = MetadataValue::Text("b".to_string());
        let bag = |items| MetadataValue::List {
            list_kind: ListKind::Bag,
            items,
        };
        assert_eq!(
            verify_set_value(
                &key,
                Some(&bag(vec![a.clone(), b.clone()])),
                Some(&bag(vec![b.clone(), a.clone()])),
                None
            )
            .0,
            "Match"
        );
        let seq = |items| MetadataValue::List {
            list_kind: ListKind::Seq,
            items,
        };
        assert_eq!(
            verify_set_value(
                &key,
                Some(&seq(vec![a.clone(), b.clone()])),
                Some(&seq(vec![b, a])),
                None
            )
            .0,
            "Mismatch"
        );
        let mut expected = BTreeMap::new();
        expected.insert("child".to_string(), bag(vec![MetadataValue::Integer(1)]));
        let mut actual = BTreeMap::new();
        actual.insert("child".to_string(), bag(vec![MetadataValue::Integer(1)]));
        assert_eq!(
            verify_set_value(
                &key,
                Some(&MetadataValue::Struct(expected)),
                Some(&MetadataValue::Struct(actual)),
                None
            )
            .0,
            "Match"
        );
    }

    #[test]
    fn date_time_and_explicit_offset_distinctions_are_preserved() {
        let key = id("EXIF::Main", "DateTimeOriginal");
        let date = MetadataValue::Date(DateValue {
            year: 2025,
            month: 1,
            day: 2,
        });
        assert_eq!(
            verify_set_value(&key, Some(&date), Some(&date), None).0,
            "Match"
        );
        let plain = MetadataValue::Time(TimeValue {
            hour: 3,
            minute: 4,
            second: 5,
            subsecond: None,
            offset: None,
        });
        let offset = MetadataValue::Time(TimeValue {
            hour: 3,
            minute: 4,
            second: 5,
            subsecond: None,
            offset: Some(UtcOffsetValue {
                sign: OffsetSign::Plus,
                hours: 1,
                minutes: 0,
            }),
        });
        assert_eq!(
            verify_set_value(&key, Some(&plain), Some(&offset), None).0,
            "Mismatch"
        );
    }

    #[test]
    fn country_code_padding_compatibility_is_narrow() {
        let country = id("IPTC::ApplicationRecord", "100");
        let other = id("IPTC::ApplicationRecord", "101");
        let expected = MetadataValue::Text("GB".to_string());
        let padded = MetadataValue::Text("GB ".to_string());
        assert_eq!(
            verify_set_value(&country, Some(&expected), Some(&padded), None).0,
            "Match"
        );
        assert_eq!(
            verify_set_value(&other, Some(&expected), Some(&padded), None).0,
            "Mismatch"
        );
    }

    #[test]
    fn delete_list_add_and_list_remove_are_verified_semantically() {
        let key = id("XMP::dc", "Subject");
        assert_eq!(verify_delete_value(&key, None).0, "DeleteOk");
        assert_eq!(
            verify_delete_value(&key, Some(&MetadataValue::Text("left".to_string()))).0,
            "DeleteLingering"
        );
        let staged = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Text("new".to_string())],
        };
        let observed = MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![
                MetadataValue::Text("old".to_string()),
                MetadataValue::Text("new".to_string()),
            ],
        };
        assert_eq!(
            verify_list_add_value(&key, Some(&staged), Some(&observed), None).0,
            "Match"
        );
        assert_eq!(
            verify_list_remove_value(
                &key,
                Some(&staged),
                Some(&MetadataValue::List {
                    list_kind: ListKind::Bag,
                    items: vec![MetadataValue::Text("old".to_string())]
                }),
                None
            )
            .0,
            "Match"
        );
    }

    #[test]
    fn non_list_list_operations_verify_as_set_and_delete() {
        let key = id("XMP::dc", "Title");
        let staged = MetadataValue::Text("new".to_string());
        let lingering = MetadataValue::Text("old".to_string());

        assert_eq!(
            verify_list_add_value(&key, Some(&staged), Some(&staged), Some(&TagKind::Text)).0,
            "Match"
        );
        assert_eq!(
            verify_list_remove_value(&key, Some(&staged), Some(&lingering), Some(&TagKind::Text)).0,
            "DeleteLingering"
        );
        assert_eq!(
            verify_list_remove_value(&key, Some(&staged), None, Some(&TagKind::Text)).0,
            "DeleteOk"
        );
    }
}
