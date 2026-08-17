use super::*;

pub(super) struct ExifToolRuntimeValue {
    pub tag_id_scope: RuntimeTagIdScope,
    pub language: Option<String>,
    pub value: serde_json::Value,
    pub raw_value: Box<RawValue>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ExifToolRuntimeValueWire {
    pub table: String,
    /// ExifTool has legitimate non-integer tag IDs (for example `0.1` in
    /// `MPF::MPImage`). Keep the original JSON token so exact schema identity
    /// never round-trips through `f64`; ExifTool's JSONQ mode is unsuitable
    /// because it also quotes every metadata value.
    pub id: Box<RawValue>,
    pub index: Option<u32>,
    pub lang: Option<String>,
    /// ExifTool may serialize text-typed metadata as an unquoted JSON number.
    /// Retain the complete token tree until the schema is known: eagerly
    /// parsing to `serde_json::Value` would normalize text such as `1.60` to
    /// `1.6`, including when it appears inside a Bag, Seq, Alt, or Struct.
    pub val: Box<RawValue>,
}

#[derive(Debug, Clone)]
pub(super) struct RuntimeProperty {
    pub occurrence_id: MetadataOccurrenceId,
    pub group1: String,
    pub tag_name: String,
    pub friendly_name: String,
    pub language: Option<String>,
    pub value: serde_json::Value,
    pub raw_value: Box<RawValue>,
}

pub(super) type RuntimeMap = BTreeMap<MetadataOccurrenceId, RuntimeProperty>;
pub(super) type RawExifToolObject = BTreeMap<String, Box<RawValue>>;

#[derive(Debug, Clone, Default)]
pub(super) struct ExifToolPassOutput {
    pub values_by_source: HashMap<String, RuntimeMap>,
    pub failures_by_source: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ParsedRuntimePropertyKey {
    pub(super) group1: String,
    pub(super) document: Option<String>,
    pub(super) copy: u32,
    pub(super) path: String,
    pub(super) runtime_tag_id: String,
    pub(super) tag_name: String,
}

impl ParsedRuntimePropertyKey {
    pub(super) fn friendly_name(&self) -> String {
        format!("{}:{}", self.group1, self.tag_name)
    }
}

pub(super) fn parse_runtime_property_key(key: &str) -> Result<ParsedRuntimePropertyKey, String> {
    // Confirmed with ExifTool 13.57 and `-G:1:3:4:5:7`: every requested
    // position is retained as
    // `IFD0:Main::JPEG-APP1-IFD0:ID-282:XResolution`. The empty family-4
    // position is the primary copy; explicit duplicates use `Copy1`, etc.
    let mut parts = key.splitn(6, ':');
    let group1 = parts.next().unwrap_or_default();
    let document_group = parts.next();
    let copy_group = parts.next();
    let path = parts.next();
    let family7 = parts.next();
    let tag_name = parts.next();

    let (document_group, copy_group, path, family7, tag_name) =
        match (document_group, copy_group, path, family7, tag_name) {
            (Some(document), Some(copy), Some(path), Some(family7), Some(tag_name)) => {
                (document, copy, path, family7, tag_name)
            }
            _ => return Err("expected family 1:3:4:5:7 and tag-name components".to_string()),
        };

    if group1.is_empty() {
        return Err("family-1 group is empty".to_string());
    }
    if document_group.is_empty() {
        return Err("family-3 document/sample group is empty".to_string());
    }
    if path.is_empty() {
        return Err("family-5 metadata path is empty".to_string());
    }
    if tag_name.is_empty() {
        return Err("runtime tag name is empty".to_string());
    }

    let copy = match copy_group {
        "" | "Copy0" => 0,
        value => value
            .strip_prefix("Copy")
            .filter(|digits| {
                !digits.is_empty()
                    && !digits.starts_with('0')
                    && digits.chars().all(|digit| digit.is_ascii_digit())
            })
            .ok_or_else(|| format!("invalid family-4 copy group `{value}`"))?
            .parse::<u32>()
            .map_err(|_| format!("invalid family-4 copy group `{value}`"))?,
    };
    let runtime_tag_id = family7
        .strip_prefix("ID-")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("invalid family-7 runtime tag ID `{family7}`"))?;

    Ok(ParsedRuntimePropertyKey {
        document: (document_group != "Main").then(|| document_group.to_string()),
        path: path.to_string(),
        runtime_tag_id: runtime_tag_id.to_string(),
        copy,
        group1: group1.to_string(),
        tag_name: tag_name.to_string(),
    })
}

pub(super) fn parse_runtime_value(value: &RawValue) -> Result<ExifToolRuntimeValue, String> {
    let wire: ExifToolRuntimeValueWire = serde_json::from_str(value.get()).map_err(|error| {
        format!(
            "expected wrapped ExifTool runtime value, got {}: {error}",
            value.get()
        )
    })?;
    let tag_id = normalize_runtime_tag_id(&wire.id)?;
    let parsed_value = serde_json::from_str(wire.val.get())
        .map_err(|error| format!("invalid wrapped ExifTool `val`: {error}"))?;
    Ok(ExifToolRuntimeValue {
        tag_id_scope: RuntimeTagIdScope {
            table: wire.table,
            tag_id,
            index: wire.index,
        },
        language: wire.lang,
        value: parsed_value,
        raw_value: wire.val,
    })
}

#[cfg(test)]
pub(super) fn parse_single_source_object(
    obj: serde_json::Map<String, serde_json::Value>,
    registry: Option<&crate::tag_schema::TagRegistry>,
) -> Result<RuntimeMap, String> {
    let raw_obj = obj
        .into_iter()
        .map(|(key, value)| {
            serde_json::value::to_raw_value(&value)
                .map(|raw| (key, raw))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<RawExifToolObject, String>>()?;
    parse_single_source_object_with_context(raw_obj, registry, "<direct source object>", None)
}

pub(super) fn safe_value_diagnostic(value: &serde_json::Value) -> String {
    fn bounded_text(text: &str) -> String {
        const MAX_CHARS: usize = 160;
        let mut chars = text.chars();
        let preview = chars.by_ref().take(MAX_CHARS).collect::<String>();
        if chars.next().is_some() {
            format!("{preview}…<truncated>")
        } else {
            preview
        }
    }

    fn describe(value: &serde_json::Value, depth: usize) -> String {
        match value {
            serde_json::Value::Null => "null".to_string(),
            serde_json::Value::Bool(value) => format!("boolean {value}"),
            serde_json::Value::Number(value) => format!("number {value}"),
            serde_json::Value::String(text) => format!(
                "string(len={}) {}",
                text.chars().count(),
                serde_json::to_string(&bounded_text(text))
                    .unwrap_or_else(|_| "\"<unprintable>\"".to_string())
            ),
            serde_json::Value::Array(items) => {
                if depth >= 2 {
                    return format!("array(len={})", items.len());
                }
                let preview = items
                    .iter()
                    .take(3)
                    .map(|item| describe(item, depth + 1))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("array(len={}, preview=[{}])", items.len(), preview)
            }
            serde_json::Value::Object(fields) => {
                if depth >= 2 {
                    return format!("object(fields={})", fields.len());
                }
                let preview = fields
                    .iter()
                    .take(3)
                    .map(|(key, value)| {
                        format!("{}: {}", bounded_text(key), describe(value, depth + 1))
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("object(fields={}, preview={{{}}})", fields.len(), preview)
            }
        }
    }

    describe(value, 0)
}

pub(super) fn parse_single_source_object_with_context(
    obj: RawExifToolObject,
    registry: Option<&crate::tag_schema::TagRegistry>,
    source_context: &str,
    pass_context: Option<&str>,
) -> Result<RuntimeMap, String> {
    let mut map = RuntimeMap::new();
    for (key, val) in obj {
        if key == "SourceFile" {
            continue;
        }
        let parsed_key =
            parse_runtime_property_key(&key).map_err(|error| format!("property {key}: {error}"))?;
        let friendly_name = parsed_key.friendly_name();
        let runtime = parse_runtime_value(&val)
            .map_err(|error| format!("property {friendly_name}: {error}"))?;
        let occurrence_id = MetadataOccurrenceId {
            document: parsed_key.document,
            path: parsed_key.path,
            runtime_tag_id: parsed_key.runtime_tag_id,
            tag_id_scope: runtime.tag_id_scope,
            copy: parsed_key.copy,
        };
        let raw_schema_id = occurrence_id.tag_id_scope.as_schema_definition_id();
        let (value, raw_value) = if is_binary_tag(&raw_schema_id, registry)
            || is_exiftool_binary_placeholder(&runtime.value)
        {
            let value = serde_json::Value::String("<binary>".to_string());
            let raw_value =
                serde_json::value::to_raw_value(&value).map_err(|error| error.to_string())?;
            (value, raw_value)
        } else {
            (runtime.value, runtime.raw_value)
        };
        let property = RuntimeProperty {
            occurrence_id,
            group1: parsed_key.group1,
            tag_name: parsed_key.tag_name,
            friendly_name,
            language: runtime.language,
            value,
            raw_value,
        };
        debug_assert_eq!(
            property.friendly_name,
            format!("{}:{}", property.group1, property.tag_name)
        );
        if let Some(previous) = map.get(&property.occurrence_id) {
            return Err(format!(
                "duplicate complete runtime occurrence ID {occurrence:#?} within one ExifTool pass; source={source:?} pass={pass:?}\nfirst: group1={first_group:?} tag_name={first_tag:?} raw_scope={first_scope:#?} language={first_language:?} value={first_value}\nsecond: group1={second_group:?} tag_name={second_tag:?} raw_scope={second_scope:#?} language={second_language:?} value={second_value}",
                occurrence = property.occurrence_id,
                source = source_context,
                pass = pass_context.unwrap_or("<unknown pass>"),
                first_group = previous.group1,
                first_tag = previous.tag_name,
                first_scope = previous.occurrence_id.tag_id_scope,
                first_language = previous.language,
                first_value = safe_value_diagnostic(&previous.value),
                second_group = property.group1,
                second_tag = property.tag_name,
                second_scope = property.occurrence_id.tag_id_scope,
                second_language = property.language,
                second_value = safe_value_diagnostic(&property.value),
            ));
        } else {
            map.insert(property.occurrence_id.clone(), property);
        }
    }
    Ok(map)
}

#[cfg(test)]
pub(super) fn try_parse_exiftool_pass_json_raw(json: &str) -> Result<ExifToolPassOutput, String> {
    try_parse_exiftool_pass_json_raw_with_registry(json, crate::tag_schema::get_registry().ok())
}

#[cfg(test)]
pub(super) fn try_parse_exiftool_pass_json_raw_with_registry(
    json: &str,
    registry: Option<&crate::tag_schema::TagRegistry>,
) -> Result<ExifToolPassOutput, String> {
    try_parse_exiftool_pass_json_raw_with_registry_and_context(json, registry, None)
}

pub(super) fn try_parse_exiftool_pass_json_raw_with_registry_and_context(
    json: &str,
    registry: Option<&crate::tag_schema::TagRegistry>,
    pass_context: Option<&str>,
) -> Result<ExifToolPassOutput, String> {
    let raw_entries: Vec<Box<RawValue>> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            let preview: String = json.chars().take(200).collect();
            log::error!(
                "[parse_exiftool] Failed to parse outer ExifTool JSON: {}. First 200 chars: {:?}",
                e,
                preview
            );
            return Err(format!("invalid ExifTool JSON: {e}"));
        }
    };

    let mut values_by_source = HashMap::new();
    let mut failures_by_source = HashMap::new();

    for (idx, raw) in raw_entries.into_iter().enumerate() {
        let mut obj: RawExifToolObject = match serde_json::from_str(raw.get()) {
            Ok(obj) => obj,
            Err(_) => {
                log::warn!(
                        "[parse_exiftool] Skipping entry {} (<no SourceFile>): expected JSON object, got {}",
                        idx,
                        raw.get()
                    );
                continue;
            }
        };
        let source = obj
            .remove("SourceFile")
            .and_then(|value| serde_json::from_str::<String>(value.get()).ok());

        let Some(s) = source else {
            log::warn!(
                "[parse_exiftool] Entry {} has no SourceFile; cannot map to a request path",
                idx
            );
            continue;
        };

        let normalized_path = super::path_identity(std::path::Path::new(&s));

        let exiftool_error = obj.iter().find_map(|(key, value)| {
            let parsed_key = parse_runtime_property_key(key).ok()?;
            if parsed_key.group1 != "ExifTool" || parsed_key.tag_name != "Error" {
                return None;
            }
            let runtime = parse_runtime_value(value).ok()?;
            Some(match runtime.value {
                serde_json::Value::String(message) => message,
                value => safe_value_diagnostic(&value),
            })
        });
        if let Some(error) = exiftool_error {
            failures_by_source.insert(normalized_path, error);
            continue;
        }

        match parse_single_source_object_with_context(obj, registry, &normalized_path, pass_context)
        {
            Ok(map) => {
                values_by_source.insert(normalized_path, map);
            }
            Err(e) => {
                log::error!(
                    "[parse_exiftool] Error parsing metadata for SourceFile {}: {}",
                    normalized_path,
                    e
                );
                failures_by_source.insert(normalized_path, e);
            }
        }
    }

    Ok(ExifToolPassOutput {
        values_by_source,
        failures_by_source,
    })
}

pub(super) fn assemble_batch_outcome(
    rel_paths: &[String],
    abs_paths: &[std::path::PathBuf],
    mut display_pass: ExifToolPassOutput,
    mut raw_pass: ExifToolPassOutput,
    registry: Option<&crate::tag_schema::TagRegistry>,
    batch_warnings: &mut Vec<ParseWarning>,
) -> Result<MetadataBatchReadOutcome, String> {
    if rel_paths.len() != abs_paths.len() {
        return Err(format!(
            "Mismatched paths length: relative paths count ({}) does not match absolute paths count ({})",
            rel_paths.len(),
            abs_paths.len()
        ));
    }

    let mut results = Vec::new();
    let mut failures = Vec::new();

    for (i, rel_path) in rel_paths.iter().enumerate() {
        let abs_path = &abs_paths[i];
        let key = super::path_identity(abs_path);

        let display_failure = display_pass.failures_by_source.remove(&key);
        let raw_failure = raw_pass.failures_by_source.remove(&key);

        let has_display_val = display_pass.values_by_source.contains_key(&key);
        let has_raw_val = raw_pass.values_by_source.contains_key(&key);

        let mut error_messages = Vec::new();

        if let Some(df) = display_failure {
            error_messages.push(format!("ExifTool display pass failed:\n{}", df));
        } else if !has_display_val {
            error_messages.push(
                "ExifTool display pass failed:\nExifTool returned no result for this file"
                    .to_string(),
            );
        }

        if let Some(rf) = raw_failure {
            error_messages.push(format!("ExifTool raw (-n) pass failed:\n{}", rf));
        } else if !has_raw_val {
            error_messages.push(
                "ExifTool raw (-n) pass failed:\nExifTool returned no result for this file"
                    .to_string(),
            );
        }

        if !error_messages.is_empty() {
            let combined_error = error_messages.join("\n\n");
            failures.push(MetadataReadFailure {
                relative_path: rel_path.clone(),
                error_message: combined_error,
            });
        } else {
            let display_values = display_pass
                .values_by_source
                .remove(&key)
                .unwrap_or_default();
            let raw_values = raw_pass.values_by_source.remove(&key).unwrap_or_default();

            let occurrences = canonical_occurrences_from_exiftool_pair(
                &raw_values,
                &display_values,
                registry,
                rel_path,
                Some(batch_warnings),
            );

            let occurrences = match occurrences {
                Ok(occurrences) => occurrences,
                Err(error) => {
                    failures.push(MetadataReadFailure {
                        relative_path: rel_path.clone(),
                        error_message: format!("Metadata canonicalisation failed:\n{error}"),
                    });
                    continue;
                }
            };

            results.push(FileMetadata {
                relative_path: rel_path.clone(),
                occurrences: metadata_occurrences_from_canonical(&occurrences),
            });
        }
    }

    Ok(MetadataBatchReadOutcome { results, failures })
}

pub fn group_metadata_failures(failures: &[MetadataReadFailure]) -> BTreeMap<String, Vec<String>> {
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for fail in failures {
        grouped
            .entry(fail.error_message.clone())
            .or_default()
            .push(fail.relative_path.clone());
    }
    grouped
}

#[cfg(test)]
pub(super) fn parse_exiftool_pass_json_raw(
    json: &str,
) -> HashMap<String, HashMap<String, serde_json::Value>> {
    parse_exiftool_pass_json_raw_with_registry(json, crate::tag_schema::get_registry().ok())
}

#[cfg(test)]
pub(super) fn parse_exiftool_pass_json_raw_with_registry(
    json: &str,
    registry: Option<&TagRegistry>,
) -> HashMap<String, HashMap<String, serde_json::Value>> {
    try_parse_exiftool_pass_json_raw_with_registry(json, registry)
        .unwrap_or_else(|_| ExifToolPassOutput {
            values_by_source: HashMap::new(),
            failures_by_source: HashMap::new(),
        })
        .values_by_source
        .into_iter()
        .map(|(source, properties)| {
            let values = properties
                .into_values()
                .map(|property| (property.friendly_name, property.value))
                .collect();
            (source, values)
        })
        .collect()
}
