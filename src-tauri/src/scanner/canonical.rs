use super::*;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct CanonicalRuntimeOccurrence {
    // Runtime identity, exact schema identity, optional registry interpretation
    // and the supported write selector answer different questions and must stay
    // independent.
    pub(super) occurrence: MetadataOccurrence,
    pub(super) friendly_name: String,
    pub(super) runtime_group1: String,
    pub(super) runtime_tag_name: String,
    pub(super) language: Option<String>,
    pub(super) is_lang_alt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct LangAltOccurrenceGroupKey {
    schema_id: SchemaDefinitionId,
    document: Option<String>,
    path: String,
    copy: u32,
    parent_runtime_tag_id: String,
}

pub(super) fn lang_alt_group_key(
    canonical: &CanonicalRuntimeOccurrence,
) -> Option<LangAltOccurrenceGroupKey> {
    let info = canonical.occurrence.tag_info.as_ref()?;
    if !matches!(info.kind, TagKind::LangAlt) {
        return None;
    }

    let parent_runtime_tag_id = match canonical.language.as_deref() {
        Some(language) => canonical
            .occurrence
            .id
            .runtime_tag_id
            .strip_suffix(&format!("-{language}"))?
            .to_string(),
        None => canonical.occurrence.id.runtime_tag_id.clone(),
    };

    Some(LangAltOccurrenceGroupKey {
        schema_id: canonical.occurrence.schema_id.clone(),
        document: canonical.occurrence.id.document.clone(),
        path: canonical.occurrence.id.path.clone(),
        copy: canonical.occurrence.id.copy,
        parent_runtime_tag_id,
    })
}

/// Reassemble ExifTool's flattened `Description-fr`-style accessors into the
/// single LangAlt property stored in XMP. Runtime document/path/copy scope is
/// retained so distinct XMP containers never collapse into one occurrence.
pub(super) fn consolidate_lang_alt_occurrences(
    occurrences: Vec<CanonicalRuntimeOccurrence>,
) -> Vec<CanonicalRuntimeOccurrence> {
    let mut ordinary = Vec::new();
    let mut groups = BTreeMap::<LangAltOccurrenceGroupKey, Vec<CanonicalRuntimeOccurrence>>::new();

    for canonical in occurrences {
        if let Some(key) = lang_alt_group_key(&canonical) {
            groups.entry(key).or_default().push(canonical);
        } else {
            ordinary.push(canonical);
        }
    }

    for (key, mut fragments) in groups {
        fragments.sort_by(|left, right| left.occurrence.id.cmp(&right.occurrence.id));
        let parent_index = fragments
            .iter()
            .position(|fragment| {
                fragment.language.is_none()
                    && fragment.occurrence.id.runtime_tag_id == key.parent_runtime_tag_id
            })
            .unwrap_or(0);
        let mut parent = fragments.remove(parent_index);
        let mut language_fragments = Vec::new();
        let mut malformed_fragments = Vec::new();

        for fragment in std::iter::once(&parent).chain(fragments.iter()) {
            match &fragment.occurrence.value {
                MetadataValue::LangAlt(languages) => language_fragments.push(languages),
                value => malformed_fragments.push(serde_json::json!({
                    "occurrence_id": &fragment.occurrence.id,
                    "value": value,
                })),
            }
        }

        let consolidated = consolidate_lang_alt_maps(language_fragments);
        let has_malformed_fragments = !malformed_fragments.is_empty();
        let invalid = !consolidated.conflicting_languages.is_empty() || has_malformed_fragments;
        parent.occurrence.value = if !invalid {
            MetadataValue::LangAlt(consolidated.languages)
        } else {
            let languages = serde_json::Value::Object(
                consolidated
                    .observed
                    .into_iter()
                    .map(|(language, values)| {
                        let value = if values.len() == 1 {
                            serde_json::Value::String(values.into_iter().next().unwrap())
                        } else {
                            serde_json::Value::Array(
                                values.into_iter().map(serde_json::Value::String).collect(),
                            )
                        };
                        (language, value)
                    })
                    .collect(),
            );
            let raw = serde_json::json!({
                "languages": languages,
                "malformed_fragments": malformed_fragments,
            });
            let mut problems = Vec::new();
            if !consolidated.conflicting_languages.is_empty() {
                problems.push(format!(
                    "conflicting values for language(s): {}",
                    consolidated.conflicting_languages.join(", ")
                ));
            }
            if has_malformed_fragments {
                problems.push("one or more fragments could not be parsed".to_string());
            }
            MetadataValue::Unknown {
                expected: Some(TagKind::LangAlt),
                raw,
                reason: Some(format!("invalid LangAlt property: {}", problems.join("; "))),
            }
        };

        let info_name = parent
            .occurrence
            .tag_info
            .as_ref()
            .expect("LangAlt grouping requires TagInfo")
            .name
            .clone();
        parent.occurrence.id.runtime_tag_id = key.parent_runtime_tag_id;
        parent.occurrence.id.tag_id_scope = RuntimeTagIdScope {
            table: key.schema_id.table.clone(),
            tag_id: key.schema_id.tag_id.clone(),
            index: key.schema_id.index,
        };
        parent.friendly_name = format!("{}:{info_name}", parent.runtime_group1);
        parent.runtime_tag_name = info_name;
        parent.language = None;
        // A conflicting property remains visible but must not receive a write
        // target. Valid consolidated LangAlt values use the canonical parent.
        parent.is_lang_alt = invalid;
        ordinary.push(parent);
    }

    ordinary.sort_by(|left, right| left.occurrence.id.cmp(&right.occurrence.id));
    ordinary
}

pub(super) fn selector_component_is_safe(component: &str, reject_colon: bool) -> bool {
    !component.is_empty()
        && !component.chars().any(|character| {
            matches!(character, '\0' | '\r' | '\n' | '=') || reject_colon && character == ':'
        })
}

pub(super) fn assign_exact_write_targets(occurrences: &mut [CanonicalRuntimeOccurrence]) {
    let mut selector_counts = BTreeMap::new();
    for canonical in occurrences.iter_mut() {
        canonical.occurrence.observed_selector = None;
        canonical.occurrence.write_target = None;
        // Restore family 7 from runtime identity, never static schema identity.
        let group7 = family7_group_from_runtime_tag_id(&canonical.occurrence.id.runtime_tag_id);
        if selector_component_is_safe(&canonical.runtime_group1, false)
            && selector_component_is_safe(&group7, true)
            && selector_component_is_safe(&canonical.runtime_tag_name, true)
        {
            let observed = MetadataObservedSelector {
                group1: canonical.runtime_group1.clone(),
                group7,
                tag_name: canonical.runtime_tag_name.clone(),
            };
            *selector_counts
                .entry(MetadataSelectorKey::from_observed_selector(&observed))
                .or_insert(0usize) += 1;
            canonical.occurrence.observed_selector = Some(observed);
        }
    }

    for canonical in occurrences {
        let Some(observed) = canonical.occurrence.observed_selector.as_ref() else {
            continue;
        };
        let selector_key = MetadataSelectorKey::from_observed_selector(observed);
        let Some(tag_info) = canonical.occurrence.tag_info.as_ref() else {
            continue;
        };
        if (!tag_info.writable || !tag_info.kind.supports_metadata_write())
            || canonical.occurrence.id.document.is_some()
            || canonical.is_lang_alt
            || canonical.language.is_some()
            || canonical.runtime_tag_name != tag_info.name
            || selector_counts.get(&selector_key) != Some(&1)
        {
            continue;
        }

        // Families 3, 4 and 5 remain extraction identity rather than supported
        // direct-write coordinates. Exactness comes from the complete
        // family-1/family-7/tag-name selector identifying one occurrence.
        // Schema table/index and TagInfo::group are not occurrence destinations.
        canonical.occurrence.write_target = Some(MetadataWriteTarget {
            group1: observed.group1.clone(),
            group7: observed.group7.clone(),
            tag_name: observed.tag_name.clone(),
        });
    }
}

pub(super) fn canonical_occurrences_from_exiftool_pair(
    raw_values: &RuntimeMap,
    display_values: &RuntimeMap,
    registry: Option<&TagRegistry>,
    rel_path: &str,
    mut warnings_accumulator: Option<&mut Vec<ParseWarning>>,
) -> Result<Vec<CanonicalRuntimeOccurrence>, String> {
    let mut values = Vec::new();
    let occurrence_ids: BTreeSet<_> = raw_values
        .keys()
        .chain(display_values.keys())
        .cloned()
        .collect();

    for occurrence_id in occurrence_ids {
        let raw_property = raw_values.get(&occurrence_id);
        let display_property = display_values.get(&occurrence_id);
        let property = raw_property
            .or(display_property)
            .expect("key came from one of the source maps");
        if raw_property.is_none() || display_property.is_none() {
            log::warn!(
                "[parse_exiftool] pass mismatch: file={} occurrence_id={occurrence_id:?} raw_friendly_name={:?} pretty_friendly_name={:?} raw_schema_id={:?} pretty_schema_id={:?} missing={}",
                rel_path,
                raw_property.map(|p| p.friendly_name.as_str()),
                display_property.map(|p| p.friendly_name.as_str()),
                raw_property.map(|p| &p.occurrence_id.tag_id_scope),
                display_property.map(|p| &p.occurrence_id.tag_id_scope),
                if raw_property.is_none() { "raw" } else { "pretty" }
            );
        }
        if let (Some(raw), Some(pretty)) = (raw_property, display_property) {
            let conflict = if raw.group1 != pretty.group1 || raw.tag_name != pretty.tag_name {
                Some("family-1 group or tag name")
            } else if raw.friendly_name != pretty.friendly_name {
                Some("canonical friendly name")
            } else if raw.language != pretty.language {
                Some("language")
            } else {
                None
            };
            if let Some(conflict) = conflict {
                return Err(format!(
                    "pretty/raw extraction disagrees on {conflict} for occurrence ID {occurrence_id:#?}\nraw: schema={raw_schema:#?} friendly={raw_name:?} group1={raw_group:?} tag_name={raw_tag:?} language={raw_language:?}\npretty: schema={pretty_schema:#?} friendly={pretty_name:?} group1={pretty_group:?} tag_name={pretty_tag:?} language={pretty_language:?}",
                    raw_schema = raw.occurrence_id.tag_id_scope,
                    raw_name = raw.friendly_name,
                    raw_group = raw.group1,
                    raw_tag = raw.tag_name,
                    raw_language = raw.language,
                    pretty_schema = pretty.occurrence_id.tag_id_scope,
                    pretty_name = pretty.friendly_name,
                    pretty_group = pretty.group1,
                    pretty_tag = pretty.tag_name,
                    pretty_language = pretty.language,
                ));
            }
        }
        let (id, info, language) = resolve_schema_identity(property, registry);
        let primary_property = raw_property.unwrap_or(property);
        let primary = &primary_property.value;
        let primary_raw = &primary_property.raw_value;
        let display_hint = display_property.map(|p| &p.value);
        if let (Some(language), Some(info)) = (language, info) {
            if matches!(info.kind, TagKind::LangAlt) {
                let text_value = parse_metadata_value_from_raw_json(
                    &property.friendly_name,
                    Some(&TagKind::Text),
                    primary_raw,
                    display_hint,
                );
                let text = match text_value {
                    MetadataValue::Text(text) => text,
                    _ => primary
                        .as_str()
                        .or_else(|| display_hint.and_then(serde_json::Value::as_str))
                        .unwrap_or_default()
                        .to_string(),
                };
                let occurrence = MetadataOccurrence::try_new(
                    occurrence_id,
                    id.clone(),
                    MetadataValue::LangAlt(BTreeMap::from([(language.clone(), text)])),
                    Some(info.clone()),
                    None,
                    None,
                )
                .map_err(|error| {
                    format!(
                        "invalid LangAlt metadata occurrence constructed for {rel_path}: {error}"
                    )
                })?;
                values.push(CanonicalRuntimeOccurrence {
                    occurrence,
                    friendly_name: property.friendly_name.clone(),
                    runtime_group1: property.group1.clone(),
                    runtime_tag_name: property.tag_name.clone(),
                    language: Some(language),
                    is_lang_alt: true,
                });
                continue;
            }
        }
        let value = parse_metadata_value_from_raw_json(
            &property.friendly_name,
            info.map(|i| &i.kind),
            primary_raw,
            display_hint,
        );
        warn_unknown_metadata_value(
            rel_path,
            &format!("{id:?} ({})", property.friendly_name),
            "canonical",
            primary,
            info,
            &value,
            warnings_accumulator.as_deref_mut(),
        );
        let occurrence = MetadataOccurrence::try_new(
            occurrence_id,
            id.clone(),
            value,
            info.cloned(),
            None,
            None,
        )
        .map_err(|error| {
            format!("invalid metadata occurrence constructed for {rel_path}: {error}")
        })?;
        values.push(CanonicalRuntimeOccurrence {
            occurrence,
            friendly_name: property.friendly_name.clone(),
            runtime_group1: property.group1.clone(),
            runtime_tag_name: property.tag_name.clone(),
            language: None,
            is_lang_alt: false,
        });
    }

    let mut values = consolidate_lang_alt_occurrences(values);

    // Write targets are assigned after the complete per-file occurrence set is
    // materialised and LangAlt fragments are consolidated, so selector
    // ambiguity can be evaluated globally against canonical properties.
    assign_exact_write_targets(&mut values);
    Ok(values)
}

#[cfg(test)]
pub(super) fn canonical_values_from_exiftool_pair_exact(
    raw_values: &RuntimeMap,
    display_values: &RuntimeMap,
    registry: Option<&TagRegistry>,
    rel_path: &str,
    warnings_accumulator: Option<&mut Vec<ParseWarning>>,
) -> Result<Vec<CanonicalRuntimeOccurrence>, String> {
    canonical_occurrences_from_exiftool_pair(
        raw_values,
        display_values,
        registry,
        rel_path,
        warnings_accumulator,
    )
}

#[cfg(test)]
pub(super) fn canonical_values_from_explicit_runtime_pair(
    raw_values: &RuntimeMap,
    display_values: &RuntimeMap,
    registry: Option<&TagRegistry>,
    rel_path: &str,
    warnings: Option<&mut Vec<ParseWarning>>,
) -> HashMap<String, MetadataValue> {
    canonical_values_from_exiftool_pair_exact(
        raw_values,
        display_values,
        registry,
        rel_path,
        warnings,
    )
    .expect("test fixture canonicalisation")
    .into_iter()
    .map(|canonical| (canonical.friendly_name, canonical.occurrence.value))
    .collect()
}

pub(super) fn resolve_schema_identity<'a>(
    property: &RuntimeProperty,
    registry: Option<&'a TagRegistry>,
) -> (
    SchemaDefinitionId,
    Option<&'a crate::tag_schema::TagInfo>,
    Option<String>,
) {
    let Some(registry) = registry else {
        return (
            property
                .occurrence_id
                .tag_id_scope
                .as_schema_definition_id(),
            None,
            None,
        );
    };
    let schema_candidate = property
        .occurrence_id
        .tag_id_scope
        .as_schema_definition_id();
    if let Some(info) = registry.lookup(&schema_candidate) {
        return (schema_candidate, Some(info), None);
    }
    let language = property.language.clone().or_else(|| {
        let (_, suffix) = schema_candidate.tag_id.rsplit_once('-')?;
        is_exiftool_language_identifier(suffix).then(|| suffix.to_string())
    });
    let Some(language) = language else {
        return (schema_candidate, None, None);
    };
    let suffix = format!("-{language}");
    let Some(base_tag_id) = schema_candidate.tag_id.strip_suffix(&suffix) else {
        return (schema_candidate, None, None);
    };
    let base_id = SchemaDefinitionId {
        table: schema_candidate.table.clone(),
        tag_id: base_tag_id.to_string(),
        index: schema_candidate.index,
    };
    match registry.lookup(&base_id) {
        Some(info) if matches!(info.kind, TagKind::LangAlt) => {
            (base_id, Some(info), Some(language))
        }
        _ => (schema_candidate, None, None),
    }
}

pub(super) fn warn_unknown_metadata_value(
    rel_path: &str,
    key: &str,
    pass_name: &str,
    raw: &serde_json::Value,
    info: Option<&crate::tag_schema::TagInfo>,
    value: &MetadataValue,
    warnings_accumulator: Option<&mut Vec<ParseWarning>>,
) {
    if let MetadataValue::Unknown {
        expected, reason, ..
    } = value
    {
        let expected_str = expected
            .as_ref()
            .map(tag_kind_summary)
            .or_else(|| info.map(|i| tag_kind_summary(&i.kind)))
            .unwrap_or_else(|| "<no schema>".to_string());
        let reason_str = reason.as_deref().unwrap_or("<unknown>").to_string();

        let warning = ParseWarning {
            rel_path: rel_path.to_string(),
            tag: key.to_string(),
            pass_name: pass_name.to_string(),
            expected: expected_str,
            raw_type: json_value_kind(raw),
            raw: raw.clone(),
            reason: reason_str,
        };

        if let Some(acc) = warnings_accumulator {
            acc.push(warning);
        } else {
            log_single_warning(&warning);
        }
    }
}

pub(super) fn json_value_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

pub(super) fn json_preview(value: &serde_json::Value) -> String {
    const MAX_CHARS: usize = 240;
    const ELLIPSIS: &str = "...";
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "<unserializable>".to_string());
    let mut chars = raw.chars();
    let preview: String = chars.by_ref().take(MAX_CHARS - ELLIPSIS.len()).collect();
    if chars.next().is_some() {
        format!("{preview}{ELLIPSIS}")
    } else {
        raw
    }
}

pub(super) fn tag_kind_summary(kind: &crate::tag_schema::TagKind) -> String {
    use crate::tag_schema::TagKind;

    match kind {
        TagKind::Text => "Text".to_string(),
        TagKind::LangAlt => "LangAlt".to_string(),
        TagKind::Integer { .. } => "Integer".to_string(),
        TagKind::Real => "Real".to_string(),
        TagKind::Rational => "Rational".to_string(),
        TagKind::Boolean => "Boolean".to_string(),
        TagKind::Date => "Date".to_string(),
        TagKind::Time => "Time".to_string(),
        TagKind::DateTime => "DateTime".to_string(),
        TagKind::TimeOffset => "TimeOffset".to_string(),
        TagKind::Enum { repr, options } => format!("Enum({repr:?}, {} options)", options.len()),
        TagKind::Bag(inner) => format!("Bag<{}>", tag_kind_summary(inner)),
        TagKind::Seq(inner) => format!("Seq<{}>", tag_kind_summary(inner)),
        TagKind::Alt(inner) => format!("Alt<{}>", tag_kind_summary(inner)),
        TagKind::Struct(fields) => format!("Struct({} fields)", fields.len()),
        TagKind::Binary => "Binary".to_string(),
        TagKind::Unknown => "Unknown".to_string(),
    }
}

pub(super) fn is_binary_tag(id: &SchemaDefinitionId, registry: Option<&TagRegistry>) -> bool {
    registry
        .and_then(|r| r.lookup(id))
        .map(|info| matches!(info.kind, crate::tag_schema::TagKind::Binary))
        .unwrap_or(false)
}

/// Match exiftool's literal binary-placeholder string, exactly as emitted
/// in `-j` output: `(Binary data N bytes, use -b option to extract)`.
///
/// Used as a fallback when the schema does not classify the tag — most
/// importantly for the synthetic `File:` group, which `-listx` does not
/// enumerate. The pattern is anchored end-to-end so a free-text tag whose
/// value happens to contain the phrase will not match unless the entire
/// value is the placeholder.
pub(super) fn is_exiftool_binary_placeholder(val: &serde_json::Value) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"^\(Binary data \d+ bytes, use -b option to extract\)$")
            .expect("static regex must compile")
    });
    val.as_str().is_some_and(|s| re.is_match(s))
}
