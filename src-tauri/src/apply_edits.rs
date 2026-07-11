use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;

use crate::metadata_value::{ListKind, MetadataValue};
use crate::scanner;
use crate::tag_schema::{SchemaDefinitionId, TagKind};

fn render_argfile_argument(arg: &str) -> Result<String, String> {
    if arg.contains('\0') {
        return Err("ExifTool argfile cannot encode argument containing NUL".to_string());
    }

    let needs_cstr = arg.contains('\n')
        || arg.contains('\r')
        || arg.contains('\t')
        || arg.contains('\\')
        || arg.starts_with('#')
        || arg.starts_with(char::is_whitespace)
        || arg.ends_with(char::is_whitespace)
        || arg.is_empty();

    if !needs_cstr {
        return Ok(arg.to_string());
    }

    let mut escaped = String::new();
    for ch in arg.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c => escaped.push(c),
        }
    }

    Ok(format!("#[CSTR]{}", escaped))
}

fn build_exiftool_write_argfile_args(
    path: &Path,
    args: &[String],
    numeric: bool,
) -> Result<Vec<String>, String> {
    let mut logical_args = vec![
        "-overwrite_original".to_string(),
        "-charset".to_string(),
        "utf8".to_string(),
        "-charset".to_string(),
        "filename=utf8".to_string(),
    ];
    if numeric {
        logical_args.push("-n".to_string());
    }
    for arg in args {
        logical_args.push(arg.clone());
    }
    logical_args.push(path.to_string_lossy().into_owned());
    Ok(logical_args)
}

fn render_exiftool_argfile(logical_args: &[String]) -> Result<String, String> {
    let mut rendered_lines = Vec::with_capacity(logical_args.len());
    for arg in logical_args {
        rendered_lines.push(render_argfile_argument(arg)?);
    }
    let mut contents = rendered_lines.join("\n");
    contents.push('\n');
    Ok(contents)
}

/// Run one exiftool write invocation with the pre-rendered argfile contents.
/// `numeric=true` indicates the numeric pass (for logging/errors).
fn run_exiftool_write(rendered_contents: &str, numeric: bool) -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|e| format!("Failed to create ExifTool argfile: {e}"))?;
    let argfile_path = dir.path().join("medialibrary-exiftool.args");
    let mut argfile = std::fs::File::create(&argfile_path)
        .map_err(|e| format!("Failed to create ExifTool argfile: {e}"))?;
    argfile
        .write_all(rendered_contents.as_bytes())
        .map_err(|e| format!("Failed to write ExifTool argfile as UTF-8: {e}"))?;
    argfile
        .flush()
        .map_err(|e| format!("Failed to flush ExifTool argfile: {e}"))?;
    drop(argfile);

    let mut cmd = crate::exiftool_config::exiftool_command();
    cmd.arg("-@").arg(&argfile_path);

    let output = cmd.output().map_err(|e| {
        format!(
            "Failed to execute ExifTool: {}. Please ensure ExifTool is installed.",
            e
        )
    })?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "ExifTool failed ({}): {}",
            if numeric { "-n pass" } else { "text pass" },
            stderr.trim()
        ));
    }
    if !stderr.trim().is_empty() {
        log::warn!(
            "[apply_edits] ExifTool write emitted stderr on {}: {}",
            if numeric { "-n pass" } else { "text pass" },
            stderr.trim()
        );
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
    pub id: SchemaDefinitionId,
    pub display_name: String,
    pub kind: String,
    pub sent: Option<MetadataValue>,
    pub before: Option<MetadataValue>,
    pub observed: Option<MetadataValue>,
    pub message: Option<String>,
}

pub struct MetadataSingleFileOutcome {
    pub fresh_metadata: Option<scanner::MetadataMap>,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub outcomes: Vec<MetadataTagOutcome>,
    pub tags_to_clear: Vec<SchemaDefinitionId>,
}

impl MetadataSingleFileOutcome {
    fn hard_failure(reason: String) -> Self {
        Self {
            fresh_metadata: None,
            error: Some(reason),
            warning: None,
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
    pub fresh_metadata: HashMap<String, Vec<scanner::MetadataEntry>>,
}

trait MetadataWriteClient {
    fn read_metadata(
        &self,
        rel_path: &str,
        abs_path: &Path,
    ) -> Result<scanner::MetadataMap, String>;

    fn write_metadata(&self, numeric: bool, rendered_contents: &str) -> Result<(), String>;
}

struct RealMetadataWriteClient;

impl MetadataWriteClient for RealMetadataWriteClient {
    fn read_metadata(
        &self,
        rel_path: &str,
        abs_path: &Path,
    ) -> Result<scanner::MetadataMap, String> {
        let mut results =
            scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path.to_path_buf()])
                .map_err(|e| e.to_string())?;

        results
            .pop()
            .map(|r| {
                r.metadata
                    .into_iter()
                    .map(|entry| (entry.id, entry.value))
                    .collect()
            })
            .ok_or_else(|| "No metadata returned".to_string())
    }

    fn write_metadata(&self, numeric: bool, rendered_contents: &str) -> Result<(), String> {
        run_exiftool_write(rendered_contents, numeric)
    }
}

struct ApplyDiagnostics {
    error: Option<String>,
    warning: Option<String>,
}

fn format_apply_diagnostics(
    numeric_attempted: bool,
    numeric_result: &Result<(), String>,
    text_attempted: bool,
    text_result: &Result<(), String>,
    verified_count: usize,
    total_count: usize,
) -> ApplyDiagnostics {
    let pass_info = match (
        numeric_attempted,
        numeric_result.is_ok(),
        text_attempted,
        text_result.is_err(),
    ) {
        (true, true, true, true) => {
            let err = text_result.as_ref().unwrap_err();
            Some(format!(
                "ExifTool text pass failed ({}) after numeric pass succeeded",
                err
            ))
        }
        (true, false, _, _) => {
            let err = numeric_result.as_ref().unwrap_err();
            Some(format!("ExifTool numeric pass failed ({})", err))
        }
        (false, _, true, true) => {
            let err = text_result.as_ref().unwrap_err();
            Some(format!("ExifTool text pass failed ({})", err))
        }
        _ => None,
    };

    if let Some(info) = pass_info {
        if verified_count == total_count {
            ApplyDiagnostics {
                error: None,
                warning: Some(format!(
                    "{}, but all intended tags verified successfully on readback.",
                    info
                )),
            }
        } else {
            ApplyDiagnostics {
                error: Some(format!(
                    "{}; post-write verification found {}/{} tags applied.",
                    info, verified_count, total_count
                )),
                warning: None,
            }
        }
    } else {
        ApplyDiagnostics {
            error: None,
            warning: None,
        }
    }
}

pub fn apply_single_file_metadata(
    folder_path: &str,
    rel_path: &str,
    edits: &[crate::draft_edits::MetadataDraftEntry],
) -> MetadataSingleFileOutcome {
    apply_single_file_metadata_with_client(folder_path, rel_path, edits, &RealMetadataWriteClient)
}

fn apply_single_file_metadata_with_client<C: MetadataWriteClient>(
    folder_path: &str,
    rel_path: &str,
    edits: &[crate::draft_edits::MetadataDraftEntry],
    client: &C,
) -> MetadataSingleFileOutcome {
    if edits.is_empty() {
        return MetadataSingleFileOutcome::hard_failure("No edits to apply".to_string());
    }

    let abs_path =
        Path::new(folder_path).join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));

    if !abs_path.exists() {
        return MetadataSingleFileOutcome::hard_failure(format!(
            "File not found: {}",
            abs_path.display()
        ));
    }

    let registry = crate::tag_schema::get_registry().ok();

    let (before_metadata, before_read_failed) = match client.read_metadata(rel_path, &abs_path) {
        Ok(meta) => (meta, false),
        Err(e) => {
            log::warn!(
                "[apply_edits] Semantic pre-write read failed for {}: {}",
                rel_path,
                e
            );
            (BTreeMap::new(), true)
        }
    };

    let mut combined = crate::write_args::BuiltArgs::default();
    let mut argv_by_tag: BTreeMap<SchemaDefinitionId, Vec<String>> = BTreeMap::new();
    for entry in edits {
        let info = registry.and_then(|r| r.lookup(&entry.id));
        let args = match info
            .ok_or_else(|| format!("missing schema for {:?}", entry.id))
            .and_then(|info| crate::write_args::build_metadata_args(&entry.id, info, &entry.edit))
        {
            Ok(args) => args,
            Err(e) => return MetadataSingleFileOutcome::hard_failure(e),
        };
        let mut tag_argv = args.numeric.clone();
        tag_argv.extend(args.text.clone());
        argv_by_tag.insert(entry.id.clone(), tag_argv);
        combined.extend(args);
    }

    if combined.is_empty() {
        return MetadataSingleFileOutcome::hard_failure(
            "build_metadata_args produced no arguments (all tags rejected?)".to_string(),
        );
    }

    // Pre-render argfile contents to catch any rendering/encoding errors early
    let numeric_argfile_content = if !combined.numeric.is_empty() {
        match build_exiftool_write_argfile_args(&abs_path, &combined.numeric, true)
            .and_then(|args| render_exiftool_argfile(&args))
        {
            Ok(content) => Some(content),
            Err(e) => return MetadataSingleFileOutcome::hard_failure(e),
        }
    } else {
        None
    };

    let text_argfile_content = if !combined.text.is_empty() {
        match build_exiftool_write_argfile_args(&abs_path, &combined.text, false)
            .and_then(|args| render_exiftool_argfile(&args))
        {
            Ok(content) => Some(content),
            Err(e) => return MetadataSingleFileOutcome::hard_failure(e),
        }
    } else {
        None
    };

    let mut numeric_attempted = false;
    let mut numeric_result = Ok(());
    if let Some(content) = &numeric_argfile_content {
        numeric_attempted = true;
        numeric_result = client.write_metadata(true, content);
    }

    let mut text_attempted = false;
    let mut text_result = Ok(());
    if numeric_result.is_ok() {
        if let Some(content) = &text_argfile_content {
            text_attempted = true;
            text_result = client.write_metadata(false, content);
        }
    }

    let launched = numeric_attempted || text_attempted;
    if !launched {
        return MetadataSingleFileOutcome::hard_failure(
            "No ExifTool write pass was attempted".to_string(),
        );
    }

    let fresh_metadata_result = client.read_metadata(rel_path, &abs_path);

    let write_err_msg = match (
        numeric_attempted,
        &numeric_result,
        text_attempted,
        &text_result,
    ) {
        (true, Err(e), _, _) => Some(format!("numeric pass failed: {}", e)),
        (_, _, true, Err(e)) => Some(format!("text pass failed: {}", e)),
        _ => None,
    };

    let fresh_metadata = match fresh_metadata_result {
        Ok(meta) => meta,
        Err(read_err) => {
            let error_reason = match write_err_msg {
                Some(w_err) => format!("ExifTool failed ({}) and post-write readback also failed ({}); file contents could not be verified.", w_err, read_err),
                None => format!("Post-write readback failed: {}", read_err),
            };

            let mut tag_outcomes = Vec::with_capacity(edits.len());
            for entry in edits {
                let display_name = registry
                    .and_then(|r| r.lookup(&entry.id))
                    .map(|info| info.display_name())
                    .unwrap_or_else(|| format!("{:?}", entry.id));
                tag_outcomes.push(MetadataTagOutcome {
                    id: entry.id.clone(),
                    display_name,
                    kind: "ReadbackFailed".to_string(),
                    sent: entry.edit.value.clone(),
                    before: before_metadata.get(&entry.id).cloned(),
                    observed: None,
                    message: Some(format!("Verification could not be completed because post-write readback failed: {}", read_err)),
                });
            }

            crate::apply_log::append_metadata_entries(
                folder_path,
                rel_path,
                edits,
                &argv_by_tag,
                &before_metadata,
                &BTreeMap::new(),
                &tag_outcomes,
                before_read_failed,
                Some(&error_reason),
            );

            return MetadataSingleFileOutcome {
                fresh_metadata: None,
                error: Some(error_reason),
                warning: None,
                outcomes: tag_outcomes,
                tags_to_clear: Vec::new(),
            };
        }
    };

    use crate::draft_edits::EditIntent;
    let mut tag_outcomes = Vec::with_capacity(edits.len());
    let mut tags_to_clear = Vec::new();
    let mut first_mismatch = None;

    for entry in edits {
        let key = &entry.id;
        let edit = &entry.edit;
        let info = registry.and_then(|r| r.lookup(key));
        let kind = info.map(|i| i.kind.clone());
        let (outcome_kind, mut message) = match edit.intent {
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
                if let Some(w_err) = &write_err_msg {
                    message = Some(match message {
                        Some(m) => format!("{} (ExifTool write failed: {})", m, w_err),
                        None => format!("ExifTool write failed: {}", w_err),
                    });
                }
                if first_mismatch.is_none() {
                    first_mismatch = message.clone();
                }
            }
        }

        tag_outcomes.push(MetadataTagOutcome {
            id: key.clone(),
            display_name: info
                .map(|value| value.display_name())
                .unwrap_or_else(|| format!("{key:?}")),
            kind: outcome_kind,
            sent: edit.value.clone(),
            before: before_metadata.get(key).cloned(),
            observed: fresh_metadata.get(key).cloned(),
            message,
        });
    }

    let diagnostics = format_apply_diagnostics(
        numeric_attempted,
        &numeric_result,
        text_attempted,
        &text_result,
        tags_to_clear.len(),
        edits.len(),
    );

    let error = diagnostics.error.clone().or(first_mismatch);
    let warning = diagnostics.warning;

    crate::apply_log::append_metadata_entries(
        folder_path,
        rel_path,
        edits,
        &argv_by_tag,
        &before_metadata,
        &fresh_metadata,
        &tag_outcomes,
        before_read_failed,
        diagnostics.error.as_deref().or(warning.as_deref()),
    );

    MetadataSingleFileOutcome {
        fresh_metadata: Some(fresh_metadata),
        error,
        warning,
        outcomes: tag_outcomes,
        tags_to_clear,
    }
}

fn verify_metadata_set(
    key: &SchemaDefinitionId,
    expected: Option<&MetadataValue>,
    fresh_metadata: &scanner::MetadataMap,
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

    if key.table == "IPTC::ApplicationRecord"
        && key.tag_id == "100"
        && key.index.is_none()
        && observed.is_some_and(|actual| iptc_country_code_values_match(actual, expected))
    {
        return ("Match".to_string(), None);
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

fn iptc_country_code_values_match(actual: &MetadataValue, expected: &MetadataValue) -> bool {
    match (actual, expected) {
        (MetadataValue::Text(actual), MetadataValue::Text(expected)) => {
            crate::country_code::iptc_country_code_storage_equivalent(expected, actual)
        }
        _ => false,
    }
}

fn verify_metadata_delete(
    key: &SchemaDefinitionId,
    fresh_metadata: &scanner::MetadataMap,
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
    key: &SchemaDefinitionId,
    expected: Option<&MetadataValue>,
    fresh_metadata: &scanner::MetadataMap,
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
    key: &SchemaDefinitionId,
    expected: Option<&MetadataValue>,
    fresh_metadata: &scanner::MetadataMap,
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
    drafts: &crate::draft_edits::MetadataDraftEdits,
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
            fresh_metadata.insert(
                rel_path.clone(),
                meta.into_iter()
                    .map(|(id, value)| scanner::MetadataEntry { id, value })
                    .collect(),
            );
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

    fn test_id(display_name: &str) -> SchemaDefinitionId {
        if display_name == "X" {
            return SchemaDefinitionId {
                table: "Test::Legacy".into(),
                tag_id: "X".into(),
                index: None,
            };
        }
        let registry = crate::tag_schema::get_registry().expect("registry");
        let matches: Vec<_> = registry
            .iter()
            .filter_map(|(id, info)| (info.display_name() == display_name).then_some(id.clone()))
            .collect();
        if matches.len() == 1 {
            matches.into_iter().next().unwrap()
        } else {
            SchemaDefinitionId {
                table: "Test::Legacy".into(),
                tag_id: display_name.into(),
                index: None,
            }
        }
    }

    fn metadata_map(pairs: &[(&str, MetadataValue)]) -> scanner::MetadataMap {
        pairs
            .iter()
            .map(|(key, value)| (test_id(key), value.clone()))
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
        let outcome = apply_single_file_metadata("/tmp", "photo.jpg", &[]);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("No edits"));
    }

    #[test]
    fn semantic_apply_invalid_key_is_hard_failure() {
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: SchemaDefinitionId {
                table: "Test::Legacy".into(),
                tag_id: "Bad\nKey".into(),
                index: None,
            },
            edit: metadata_edit(MetadataValue::Text("x".into())),
        }];
        let outcome = apply_single_file_metadata("/tmp", "photo.jpg", &edits);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("File not found"));
    }

    #[test]
    fn semantic_apply_missing_file_is_hard_failure() {
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: test_id("XMP-dc:Title"),
            edit: metadata_edit(MetadataValue::Text("x".into())),
        }];
        let outcome = apply_single_file_metadata("/tmp", "missing_metadata_semantic.jpg", &edits);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("File not found"));
    }

    #[test]
    fn semantic_apply_blocks_binary_before_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        std::fs::write(&path, b"not a real image").unwrap();
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: SchemaDefinitionId {
                table: "Exif::Main".into(),
                tag_id: "IFD1:ThumbnailImage".into(),
                index: None,
            },
            edit: metadata_edit(MetadataValue::Binary),
        }];
        let outcome = apply_single_file_metadata(dir.path().to_str().unwrap(), "a.jpg", &edits);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("missing schema"));
    }

    #[test]
    fn verify_metadata_set_distinguishes_match_coerced_mismatch_missing_and_unparsed() {
        let metadata = metadata_map(&[("X", MetadataValue::Integer(5))]);
        let (kind, _) = verify_metadata_set(
            &test_id("X"),
            Some(&MetadataValue::Integer(5)),
            &metadata,
            None,
        );
        assert_eq!(kind, "Match");

        let metadata = metadata_map(&[("X", MetadataValue::Real(5.0))]);
        let (kind, _) = verify_metadata_set(
            &test_id("X"),
            Some(&MetadataValue::Integer(5)),
            &metadata,
            None,
        );
        assert_eq!(kind, "Coerced");

        let metadata = metadata_map(&[("X", MetadataValue::Text("other".into()))]);
        let (kind, _) = verify_metadata_set(
            &test_id("X"),
            Some(&MetadataValue::Integer(5)),
            &metadata,
            None,
        );
        assert_eq!(kind, "Mismatch");

        let (kind, _) = verify_metadata_set(
            &test_id("X"),
            Some(&MetadataValue::Integer(5)),
            &BTreeMap::new(),
            None,
        );
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
        let (kind, _) = verify_metadata_set(
            &test_id("X"),
            Some(&MetadataValue::Integer(5)),
            &metadata,
            None,
        );
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
            &test_id("EXIF:ExposureTime"),
            Some(&expected),
            &metadata,
            Some(&TagKind::Rational),
        );
        assert_eq!(kind, "Match");
    }

    #[test]
    fn verify_metadata_gps_real_matches_readback_with_float_tolerance() {
        let metadata = metadata_map(&[("GPS:GPSLatitude", MetadataValue::Real(52.2037391662333))]);
        let expected = MetadataValue::Real(52.2037391662611);
        let (kind, _) = verify_metadata_set(
            &test_id("GPS:GPSLatitude"),
            Some(&expected),
            &metadata,
            Some(&TagKind::Real),
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
            &test_id("IPTC:DateCreated"),
            Some(&expected),
            &metadata,
            Some(&TagKind::Date),
        );
        assert_eq!(kind, "Match");
    }

    #[test]
    fn verify_metadata_accepts_legacy_iptc_country_code_padding_only_for_that_tag() {
        let metadata = metadata_map(&[(
            "IPTC:Country-PrimaryLocationCode",
            MetadataValue::Text("GB ".into()),
        )]);
        let expected = MetadataValue::Text("GB".into());
        let (kind, _) = verify_metadata_set(
            &test_id("IPTC:Country-PrimaryLocationCode"),
            Some(&expected),
            &metadata,
            Some(&TagKind::Text),
        );
        assert_eq!(kind, "Match");

        let metadata = metadata_map(&[("X", MetadataValue::Text("GB ".into()))]);
        let (kind, _) = verify_metadata_set(
            &test_id("X"),
            Some(&expected),
            &metadata,
            Some(&TagKind::Text),
        );
        assert_eq!(kind, "Mismatch");
    }

    #[test]
    fn argfile_numeric_pass_contains_numeric_and_charset_lines() {
        let logical_args = build_exiftool_write_argfile_args(
            Path::new("photo.jpg"),
            &[String::from("-XMP-xmp:Rating=5")],
            true,
        )
        .unwrap();
        assert_eq!(
            &logical_args[..6],
            &[
                "-overwrite_original",
                "-charset",
                "utf8",
                "-charset",
                "filename=utf8",
                "-n"
            ]
        );
        assert_eq!(logical_args.last().unwrap(), "photo.jpg");
    }

    #[test]
    fn argfile_text_pass_omits_numeric_but_keeps_utf8_and_spaces() {
        let logical_args = build_exiftool_write_argfile_args(
            Path::new("photo.jpg"),
            &[String::from("-XMP-mlib:AIDescription=a café table")],
            false,
        )
        .unwrap();
        assert_eq!(
            &logical_args[..5],
            &[
                "-overwrite_original",
                "-charset",
                "utf8",
                "-charset",
                "filename=utf8"
            ]
        );
        assert!(!logical_args.iter().any(|line| line == "-n"));
        assert!(logical_args.contains(&"-XMP-mlib:AIDescription=a café table".to_string()));
        let contents = render_exiftool_argfile(&logical_args).unwrap();
        assert!(contents.contains("-XMP-mlib:AIDescription=a café table\n"));
    }

    #[test]
    fn argfile_text_pass_preserves_trailing_value_spaces() {
        let logical_args = build_exiftool_write_argfile_args(
            Path::new("photo.jpg"),
            &[String::from("-IPTC:Country-PrimaryLocationCode=GB ")],
            false,
        )
        .unwrap();
        let contents = render_exiftool_argfile(&logical_args).unwrap();
        assert!(contents.contains("#[CSTR]-IPTC:Country-PrimaryLocationCode=GB \n"));
    }

    #[test]
    fn render_argfile_argument_scenarios() {
        // 1. Plain safe argument
        assert_eq!(
            render_argfile_argument("-XMP-dc:Title=Hello").unwrap(),
            "-XMP-dc:Title=Hello"
        );

        // 2. Multiline OCR value encoded as one physical line
        assert_eq!(
            render_argfile_argument("-XMP-mlib:AIOcrText=cpp\nCertificate\nOf\nAchievement")
                .unwrap(),
            "#[CSTR]-XMP-mlib:AIOcrText=cpp\\nCertificate\\nOf\\nAchievement"
        );

        // 3. Carriage return and CRLF encoded safely
        assert_eq!(render_argfile_argument("val\r").unwrap(), "#[CSTR]val\\r");
        assert_eq!(
            render_argfile_argument("val\r\nnext").unwrap(),
            "#[CSTR]val\\r\\nnext"
        );

        // 4. Tab encoded safely
        assert_eq!(
            render_argfile_argument("val\tnext").unwrap(),
            "#[CSTR]val\\tnext"
        );

        // 5. Literal backslashes preserved
        assert_eq!(
            render_argfile_argument("C:\\tmp\\foo").unwrap(),
            "#[CSTR]C:\\\\tmp\\\\foo"
        );

        // 6. Leading # encoded
        assert_eq!(
            render_argfile_argument("#comment").unwrap(),
            "#[CSTR]#comment"
        );

        // 7. Leading/trailing whitespace preserved
        assert_eq!(
            render_argfile_argument(" leading").unwrap(),
            "#[CSTR] leading"
        );
        assert_eq!(
            render_argfile_argument("trailing ").unwrap(),
            "#[CSTR]trailing "
        );

        // 8. NUL is rejected
        assert!(render_argfile_argument("val\0").is_err());
    }

    #[test]
    fn render_complete_argfile_has_correct_physical_lines() {
        let logical_args = vec![
            "-overwrite_original".to_string(),
            "-XMP-mlib:AIOcrText=cpp\nCertificate\nOf\nAchievement".to_string(),
            "photo.jpg".to_string(),
        ];
        let rendered = render_exiftool_argfile(&logical_args).unwrap();
        // Should contain exactly three lines (plus final trailing newline)
        let lines: Vec<&str> = rendered.split('\n').filter(|s| !s.is_empty()).collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "-overwrite_original");
        assert_eq!(
            lines[1],
            "#[CSTR]-XMP-mlib:AIOcrText=cpp\\nCertificate\\nOf\\nAchievement"
        );
        assert_eq!(lines[2], "photo.jpg");
    }

    struct MockMetadataWriteClient {
        read_results: std::cell::RefCell<Vec<Result<scanner::MetadataMap, String>>>,
        write_results: std::cell::RefCell<Vec<Result<(), String>>>,
        write_calls: std::cell::RefCell<Vec<(bool, String)>>,
    }

    impl MetadataWriteClient for MockMetadataWriteClient {
        fn read_metadata(
            &self,
            _rel_path: &str,
            _abs_path: &Path,
        ) -> Result<scanner::MetadataMap, String> {
            let mut results = self.read_results.borrow_mut();
            if results.is_empty() {
                Ok(BTreeMap::new())
            } else {
                results.remove(0)
            }
        }

        fn write_metadata(&self, numeric: bool, rendered_contents: &str) -> Result<(), String> {
            self.write_calls
                .borrow_mut()
                .push((numeric, rendered_contents.to_string()));
            let mut results = self.write_results.borrow_mut();
            if results.is_empty() {
                Ok(())
            } else {
                results.remove(0)
            }
        }
    }

    #[test]
    fn write_pipeline_prevalidation_failure() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"").unwrap();
        let client = MockMetadataWriteClient {
            read_results: std::cell::RefCell::new(vec![Ok(BTreeMap::new())]),
            write_results: std::cell::RefCell::new(vec![]),
            write_calls: std::cell::RefCell::new(vec![]),
        };
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: SchemaDefinitionId {
                table: "Exif::IFD1".to_string(),
                tag_id: "ThumbnailImage".to_string(),
                index: None,
            },
            edit: metadata_edit(MetadataValue::Binary),
        }];

        let outcome = apply_single_file_metadata_with_client(folder, "photo.jpg", &edits, &client);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.error.unwrap().contains("missing schema"));
        assert!(client.write_calls.borrow().is_empty());
    }

    #[test]
    fn write_pipeline_numeric_pass_fails() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"").unwrap();
        let client = MockMetadataWriteClient {
            read_results: std::cell::RefCell::new(vec![
                Ok(metadata_map(&[(
                    "XMP-xmp:Rating",
                    MetadataValue::Integer(1),
                )])), // before
                Ok(metadata_map(&[(
                    "XMP-xmp:Rating",
                    MetadataValue::Integer(5),
                )])), // after
            ]),
            write_results: std::cell::RefCell::new(vec![Err("exiftool locked".to_string())]),
            write_calls: std::cell::RefCell::new(vec![]),
        };
        let rating_id = SchemaDefinitionId {
            table: "XMP::xmp".to_string(),
            tag_id: "Rating".to_string(),
            index: None,
        };
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: rating_id.clone(),
            edit: metadata_edit(MetadataValue::Integer(5)),
        }];

        let outcome = apply_single_file_metadata_with_client(folder, "photo.jpg", &edits, &client);
        assert_eq!(outcome.tags_to_clear, vec![rating_id]);
        assert_eq!(outcome.outcomes.len(), 1);
        assert_eq!(outcome.outcomes[0].kind, "Match");
        assert!(outcome.error.is_none());
        let warning = outcome.warning.unwrap();
        assert!(warning.contains("exiftool locked"));
        assert!(warning.contains("verified successfully"));
        assert_eq!(client.write_calls.borrow().len(), 1);
        assert!(client.write_calls.borrow()[0].0);
    }

    #[test]
    fn write_pipeline_numeric_succeeds_text_fails() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"").unwrap();
        let client = MockMetadataWriteClient {
            read_results: std::cell::RefCell::new(vec![
                Ok(metadata_map(&[
                    ("XMP-xmp:Rating", MetadataValue::Integer(1)),
                    ("XMP-dc:Title", MetadataValue::Text("old".to_string())),
                ])), // before
                Ok(metadata_map(&[
                    ("XMP-xmp:Rating", MetadataValue::Integer(5)),
                    ("XMP-dc:Title", MetadataValue::Text("old".to_string())),
                ])), // after
            ]),
            write_results: std::cell::RefCell::new(vec![Ok(()), Err("disk full".to_string())]),
            write_calls: std::cell::RefCell::new(vec![]),
        };
        let rating_id = SchemaDefinitionId {
            table: "XMP::xmp".to_string(),
            tag_id: "Rating".to_string(),
            index: None,
        };
        let title_id = SchemaDefinitionId {
            table: "XMP::dc".to_string(),
            tag_id: "title".to_string(),
            index: None,
        };
        let edits = vec![
            crate::draft_edits::MetadataDraftEntry {
                id: rating_id.clone(),
                edit: metadata_edit(MetadataValue::Integer(5)),
            },
            crate::draft_edits::MetadataDraftEntry {
                id: title_id,
                edit: metadata_edit(MetadataValue::Text("new".to_string())),
            },
        ];

        let outcome = apply_single_file_metadata_with_client(folder, "photo.jpg", &edits, &client);
        assert_eq!(outcome.tags_to_clear, vec![rating_id]);
        assert!(outcome.warning.is_none());
        let err = outcome.error.unwrap();
        assert!(err.contains("disk full"));
        assert!(err.contains("verification found 1/2"));
        assert_eq!(client.write_calls.borrow().len(), 2);
        assert!(client.write_calls.borrow()[0].0);
        assert!(!client.write_calls.borrow()[1].0);
    }

    #[test]
    fn write_pipeline_text_fails_but_verified_success() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"").unwrap();
        let client = MockMetadataWriteClient {
            read_results: std::cell::RefCell::new(vec![
                Ok(metadata_map(&[(
                    "XMP-dc:Title",
                    MetadataValue::Text("old".to_string()),
                )])), // before
                Ok(metadata_map(&[(
                    "XMP-dc:Title",
                    MetadataValue::Text("new".to_string()),
                )])), // after
            ]),
            write_results: std::cell::RefCell::new(vec![Err("minor error".to_string())]),
            write_calls: std::cell::RefCell::new(vec![]),
        };
        let title_id = SchemaDefinitionId {
            table: "XMP::dc".to_string(),
            tag_id: "title".to_string(),
            index: None,
        };
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: title_id.clone(),
            edit: metadata_edit(MetadataValue::Text("new".to_string())),
        }];

        let outcome = apply_single_file_metadata_with_client(folder, "photo.jpg", &edits, &client);
        assert_eq!(outcome.tags_to_clear, vec![title_id]);
        assert!(outcome.error.is_none());
        let warning = outcome.warning.unwrap();
        assert!(warning.contains("minor error"));
        assert!(warning.contains("all intended tags verified successfully"));
    }

    #[test]
    fn write_pipeline_both_write_and_readback_fail() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"").unwrap();
        let client = MockMetadataWriteClient {
            read_results: std::cell::RefCell::new(vec![
                Ok(BTreeMap::new()),                       // before
                Err("read permission denied".to_string()), // after
            ]),
            write_results: std::cell::RefCell::new(vec![Err("write write error".to_string())]),
            write_calls: std::cell::RefCell::new(vec![]),
        };
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: SchemaDefinitionId {
                table: "XMP::dc".to_string(),
                tag_id: "title".to_string(),
                index: None,
            },
            edit: metadata_edit(MetadataValue::Text("new".to_string())),
        }];

        let outcome = apply_single_file_metadata_with_client(folder, "photo.jpg", &edits, &client);
        assert!(outcome.fresh_metadata.is_none());
        assert!(outcome.tags_to_clear.is_empty());
        assert!(outcome.warning.is_none());
        let err = outcome.error.unwrap();
        assert!(err.contains("write write error"));
        assert!(err.contains("read permission denied"));
        assert_eq!(outcome.outcomes.len(), 1);
        assert_eq!(outcome.outcomes[0].kind, "ReadbackFailed");
    }

    #[test]
    fn write_pipeline_appends_log_on_partial_success() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"").unwrap();
        let client = MockMetadataWriteClient {
            read_results: std::cell::RefCell::new(vec![
                Ok(metadata_map(&[(
                    "XMP-xmp:Rating",
                    MetadataValue::Integer(1),
                )])), // before
                Ok(metadata_map(&[(
                    "XMP-xmp:Rating",
                    MetadataValue::Integer(5),
                )])), // after
            ]),
            write_results: std::cell::RefCell::new(vec![Err("partial fail".to_string())]),
            write_calls: std::cell::RefCell::new(vec![]),
        };
        let rating_id = SchemaDefinitionId {
            table: "XMP::xmp".to_string(),
            tag_id: "Rating".to_string(),
            index: None,
        };
        let edits = vec![crate::draft_edits::MetadataDraftEntry {
            id: rating_id.clone(),
            edit: metadata_edit(MetadataValue::Integer(5)),
        }];

        let outcome = apply_single_file_metadata_with_client(folder, "photo.jpg", &edits, &client);
        assert_eq!(outcome.tags_to_clear, vec![rating_id]);
        assert!(outcome.error.is_none());
        assert!(outcome.warning.is_some());

        let log_path = dir.path().join("MediaLibraryApplyLog.jsonl");
        assert!(log_path.exists());
        let log_contents = std::fs::read_to_string(log_path).unwrap();
        assert!(log_contents.contains("\"tag_id\":\"Rating\""));
        assert!(log_contents.contains("Match"));
        assert!(log_contents.contains("partial fail"));
    }
}
