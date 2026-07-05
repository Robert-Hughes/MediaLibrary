use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use crate::metadata_value::{ListKind, MetadataValue};
use crate::scanner::{self, Variant};
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

/// Per-tag verification outcome surfaced to the frontend and the apply log.
///
/// `kind` is a free-text discriminator so we can grow new outcomes without
/// a schema migration.  Current values:
///
/// - `"Match"` — post-write file equals what we sent (exact, type-aware).
/// - `"Coerced"` — post-write file is equivalent under type-aware equality
///   but not byte-identical (for example, exiftool wrote `5/1` for our `5`,
///   or normalised `True`). Frontend prompts the user to accept-or-revert.
/// - `"Mismatch"` — post-write differs both exactly and structurally. Draft
///   retained.
/// - `"MissingPostWrite"` — tag absent after write (likely format rejection).
/// - `"DeleteOk"`        — Delete intent verified absent (or Null).
/// - `"DeleteLingering"`  — Delete intent failed; tag still present.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct TagOutcome {
    pub tag: String,
    pub kind: String,
    /// What we asked exiftool to set (post-coerce, what the draft held).
    /// `None` for Delete intent.
    pub sent: Option<Variant>,
    /// Pre-write display value (for the UI revert affordance and the log).
    pub before_display: Option<Variant>,
    /// Post-write display view (PrintConv'd).
    pub observed_display: Option<Variant>,
    /// Post-write raw view (-n).  This is what `Revert` re-stages because
    /// it is the unambiguous machine value.
    pub observed_raw: Option<Variant>,
    /// Free-text explanation when `kind != "Match"`.
    pub message: Option<String>,
}

#[derive(Serialize, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ApplyEditsResult {
    pub applied: Vec<String>,
    pub failed: Vec<FailedFile>,
    pub fresh_metadata: HashMap<String, HashMap<String, Variant>>,
}

/// Outcome of applying edits to a single file.
///
/// `fresh_metadata` is populated whenever exiftool ran and the re-read succeeded,
/// regardless of whether verification passed.  This lets the UI reflect the actual
/// file state even when verification detects a mismatch or partial write.
///
/// `error` is `None` on full success or when the only deviations are Coerced
/// outcomes the user must triage; it is `Some` for hard failures and outright
/// mismatches.
///
/// `outcomes` is the per-tag verification table — frontend uses it to drive
/// the Coerced accept/revert UI and to render mismatch diffs.
///
/// `tags_to_clear` is the subset of edited tags whose drafts are safe to
/// remove right now (Match + DeleteOk).  Coerced and mismatched tags stay
/// in the draft store until the user decides what to do with them.
pub struct SingleFileOutcome {
    pub fresh_metadata: Option<HashMap<String, Variant>>,
    pub error: Option<String>,
    pub outcomes: Vec<TagOutcome>,
    pub tags_to_clear: Vec<String>,
}

impl SingleFileOutcome {
    fn hard_failure(reason: String) -> Self {
        Self {
            fresh_metadata: None,
            error: Some(reason),
            outcomes: Vec::new(),
            tags_to_clear: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataTagOutcome {
    pub tag: String,
    pub kind: String,
    pub sent: Option<MetadataValue>,
    pub before_display: Option<MetadataValue>,
    pub observed_display: Option<MetadataValue>,
    pub observed_raw: Option<MetadataValue>,
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

/// Apply draft edits to a single file using exiftool, then re-read and verify.
///
/// Legacy entry: accepts the string-only edit map and wraps each value into
/// a typed `DraftEdit` via `from_legacy_string`.  Existing callers (the
/// legacy typed-draft callers can still use this path directly in tests;
/// chip editors that produce `Variant::List` use
/// `apply_single_file_typed` directly so list-shape survives write-back.
pub fn apply_single_file(
    folder_path: &str,
    rel_path: &str,
    edits: &HashMap<String, Option<String>>,
) -> SingleFileOutcome {
    let typed: HashMap<String, crate::draft_edits::DraftEdit> = edits
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                crate::draft_edits::DraftEdit::from_legacy_string(v.clone()),
            )
        })
        .collect();
    apply_single_file_typed(folder_path, rel_path, &typed)
}

/// Apply typed draft edits to a single file using exiftool, then re-read and verify.
///
/// This is the canonical entry point.  Variant values flow straight to
/// `write_args::build_args` so list-shape (Bag<Text>, etc.) and object-shape
/// (LangAlt) reach exiftool as repeated `-TAG=item` / `-TAG-lang=value` args
/// rather than getting flattened through the legacy string view.
pub fn apply_single_file_typed(
    folder_path: &str,
    rel_path: &str,
    edits: &HashMap<String, crate::draft_edits::DraftEdit>,
) -> SingleFileOutcome {
    if edits.is_empty() {
        return SingleFileOutcome::hard_failure("No edits to apply".to_string());
    }

    let abs_path =
        Path::new(folder_path).join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));

    for key in edits.keys() {
        if key.contains('\n') || key.contains('\0') {
            return SingleFileOutcome::hard_failure(format!("Invalid tag key: {:?}", key));
        }
    }

    if !abs_path.exists() {
        return SingleFileOutcome::hard_failure(format!("File not found: {}", abs_path.display()));
    }

    let registry = crate::tag_schema::get_registry().ok();

    // Capture the pre-write metadata so the apply-log can record the value
    // before our edit and the frontend can show it in revert affordances.
    // Best-effort: a read failure here is non-fatal.  We log and proceed
    // with empty before-views; the failure is propagated to the apply-log
    // entry as `before_read_failed=true` so a `null` before-value can be
    // distinguished from "tag was genuinely absent".
    let (before_display, before_raw, before_read_failed) = match scanner::read_image_metadata_batch(
        &[rel_path.to_string()],
        std::slice::from_ref(&abs_path),
    ) {
        Ok(mut results) => match results.pop() {
            Some(r) => (r.metadata, r.raw_metadata, false),
            None => {
                log::warn!(
                    "[apply_edits] Pre-write read returned no entry for {}",
                    rel_path
                );
                (HashMap::new(), HashMap::new(), true)
            }
        },
        Err(e) => {
            log::warn!(
                "[apply_edits] Pre-write read failed for {}: {}",
                rel_path,
                e
            );
            (HashMap::new(), HashMap::new(), true)
        }
    };

    let mut combined = crate::write_args::BuiltArgs::default();
    // Keep per-tag argv for the apply log.
    let mut argv_by_tag: HashMap<String, Vec<String>> = HashMap::new();
    for (key, edit) in edits {
        let info = registry.and_then(|r| r.lookup(key));
        let args = crate::write_args::build_args(key, info, edit);
        let mut combined_argv = args.numeric.clone();
        combined_argv.extend(args.text.iter().cloned());
        argv_by_tag.insert(key.clone(), combined_argv);
        combined.extend(args);
    }

    if combined.is_empty() {
        return SingleFileOutcome::hard_failure(
            "build_args produced no arguments (all tags rejected?)".to_string(),
        );
    }

    log::info!(
        "[apply_edits] Running exiftool for {} (numeric args: {}, text args: {})",
        rel_path,
        combined.numeric.len(),
        combined.text.len()
    );

    // Numeric pass first.  Edits in the text group may reference tags set
    // here for derived-field interactions (rare, but exiftool docs reserve
    // the right).
    if !combined.numeric.is_empty() {
        if let Err(e) = run_exiftool_write(&abs_path, &combined.numeric, /*numeric=*/ true) {
            return SingleFileOutcome::hard_failure(e);
        }
    }
    if !combined.text.is_empty() {
        if let Err(e) = run_exiftool_write(&abs_path, &combined.text, /*numeric=*/ false) {
            return SingleFileOutcome::hard_failure(e);
        }
    }

    // Re-read metadata via the two-pass scanner.  `display` is pretty
    // (PrintConv'd) values; `raw` is `-n` values.
    let (fresh_display, fresh_raw) =
        match scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path]) {
            Ok(mut results) => match results.pop() {
                Some(r) => (r.metadata, r.raw_metadata),
                None => {
                    return SingleFileOutcome::hard_failure(
                        "Post-write read returned no entry".to_string(),
                    )
                }
            },
            Err(e) => {
                return SingleFileOutcome::hard_failure(format!("Post-write read failed: {}", e))
            }
        };

    // Verify each edit per its intent + the schema's TagKind.
    use crate::draft_edits::EditIntent;
    let mut tag_outcomes: Vec<TagOutcome> = Vec::with_capacity(edits.len());
    let mut tags_to_clear: Vec<String> = Vec::new();
    let mut first_mismatch: Option<String> = None;

    for (key, edit) in edits {
        let info = registry.and_then(|r| r.lookup(key));
        let kind = info.map(|i| i.kind.clone());

        let (outcome_kind, message) = match edit.intent {
            EditIntent::Delete => verify_delete(key, &fresh_raw, &fresh_display),
            EditIntent::Set => verify_set(
                key,
                edit.value.as_ref(),
                &fresh_display,
                &fresh_raw,
                kind.as_ref(),
            ),
            EditIntent::ListAdd => {
                verify_list_add(key, edit.value.as_ref(), &fresh_display, &fresh_raw)
            }
            EditIntent::ListRemove => {
                verify_list_remove(key, edit.value.as_ref(), &fresh_display, &fresh_raw)
            }
        };

        match outcome_kind.as_str() {
            "Match" | "DeleteOk" => tags_to_clear.push(key.clone()),
            // Coerced is "exiftool wrote a normalised but equivalent value":
            // not an error, but we keep the draft so the user can choose to
            // accept or revert via the frontend.
            "Coerced" => {}
            // Mismatch / DeleteLingering / MissingPostWrite all get retained.
            _ => {
                if first_mismatch.is_none() {
                    if let Some(ref m) = message {
                        first_mismatch = Some(m.clone());
                    }
                }
            }
        }

        tag_outcomes.push(TagOutcome {
            tag: key.clone(),
            kind: outcome_kind,
            sent: edit.value.clone(),
            before_display: before_display.get(key).cloned(),
            observed_display: fresh_display.get(key).cloned(),
            observed_raw: fresh_raw.get(key).cloned(),
            message,
        });
    }

    // Append the apply-log entries before returning.  Best-effort: a log
    // write failure logs at warn and doesn't affect the apply outcome.
    crate::apply_log::append_entries(
        folder_path,
        rel_path,
        edits,
        &argv_by_tag,
        &before_display,
        &before_raw,
        &fresh_display,
        &fresh_raw,
        &tag_outcomes,
        before_read_failed,
    );

    SingleFileOutcome {
        fresh_metadata: Some(fresh_display),
        error: first_mismatch,
        outcomes: tag_outcomes,
        tags_to_clear,
    }
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

    let (before_display, before_raw, before_read_failed) = match scanner::read_image_metadata_batch(
        &[rel_path.to_string()],
        std::slice::from_ref(&abs_path),
    ) {
        Ok(mut results) => match results.pop() {
            Some(r) => (r.metadata_values, r.raw_metadata_values, false),
            None => (HashMap::new(), HashMap::new(), false),
        },
        Err(e) => {
            log::warn!(
                "[apply_edits] Semantic pre-write read failed for {}: {}",
                rel_path,
                e
            );
            (HashMap::new(), HashMap::new(), true)
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

    let (fresh_display, fresh_raw) =
        match scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path]) {
            Ok(mut results) => match results.pop() {
                Some(r) => (r.metadata_values, r.raw_metadata_values),
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
            EditIntent::Delete => verify_metadata_delete(key, &fresh_raw, &fresh_display),
            EditIntent::Set => verify_metadata_set(
                key,
                edit.value.as_ref(),
                &fresh_display,
                &fresh_raw,
                kind.as_ref(),
            ),
            EditIntent::ListAdd => verify_metadata_list_add(
                key,
                edit.value.as_ref(),
                &fresh_display,
                &fresh_raw,
                kind.as_ref(),
            ),
            EditIntent::ListRemove => verify_metadata_list_remove(
                key,
                edit.value.as_ref(),
                &fresh_display,
                &fresh_raw,
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
            before_display: before_display.get(key).cloned(),
            observed_display: fresh_display.get(key).cloned(),
            observed_raw: fresh_raw.get(key).cloned(),
            message,
        });
    }

    crate::apply_log::append_metadata_entries(
        folder_path,
        rel_path,
        edits,
        &argv_by_tag,
        &before_display,
        &before_raw,
        &fresh_display,
        &fresh_raw,
        &tag_outcomes,
        before_read_failed,
    );

    MetadataSingleFileOutcome {
        fresh_metadata: Some(fresh_display),
        error: first_mismatch,
        outcomes: tag_outcomes,
        tags_to_clear,
    }
}

/// Verify a `Set` intent by comparing the post-write file to what we sent.
///
/// Distinguishes three success-shaped outcomes:
/// - `"Match"` — exact equality (kind-aware) on either view.
/// - `"Coerced"` — equivalent under type-aware equality (multiset / epsilon
///   / per-lang / promote-scalar-to-list / cross-type stringify) but not
///   byte-identical. User must accept or revert.
/// - `"Mismatch"` / `"MissingPostWrite"` — see TagOutcome doc.
fn verify_set(
    key: &str,
    expected: Option<&Variant>,
    fresh_display: &HashMap<String, Variant>,
    fresh_raw: &HashMap<String, Variant>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        // No-value Set (degenerate) — treat as Match because there's nothing
        // to verify against.
        None => return ("Match".to_string(), None),
    };

    let display_v = fresh_display.get(key);
    let raw_v = fresh_raw.get(key);

    // Empty-string / Null / empty-List Set: exiftool's `-TAG=` clears the
    // tag, so most formats will report the tag as absent (or Null / empty
    // string / empty list) after write.  Treat that as a Match — the user
    // asked for an empty value and the file now reflects that, even though
    // no actual tag was retained.  Empty-List covers Bag/Seq tags being
    // cleared (e.g. `[B]AIOcrText` set to no items); without this arm the
    // verifier reports MissingPostWrite and the apply UI calls it a
    // failure.
    fn is_empty_value(v: &Variant) -> bool {
        matches!(v, Variant::Null)
            || matches!(v, Variant::String(s) if s.is_empty())
            || matches!(v, Variant::List(l) if l.is_empty())
    }
    fn is_empty_or_absent(v: Option<&Variant>) -> bool {
        match v {
            None => true,
            Some(Variant::Null) => true,
            Some(Variant::String(s)) if s.is_empty() => true,
            Some(Variant::List(l)) if l.is_empty() => true,
            _ => false,
        }
    }
    if is_empty_value(expected) && is_empty_or_absent(display_v) && is_empty_or_absent(raw_v) {
        return ("Match".to_string(), None);
    }

    if display_v.is_none() && raw_v.is_none() {
        let reason = format!("Tag {} absent after write (format may not support it)", key);
        return ("MissingPostWrite".to_string(), Some(reason));
    }

    // Strict (exact) compare first — picks up the Match case.
    let display_strict = display_v.is_some_and(|v| variant_strict_eq(v, expected));
    let raw_strict = raw_v.is_some_and(|v| variant_strict_eq(v, expected));
    if display_strict || raw_strict {
        return ("Match".to_string(), None);
    }
    let display_storage = display_v.is_some_and(|v| variant_storage_eq(v, expected, kind));
    let raw_storage = raw_v.is_some_and(|v| variant_storage_eq(v, expected, kind));
    if display_storage || raw_storage {
        return ("Match".to_string(), None);
    }

    // Then type-aware (loose) compare.  If either view is equivalent under
    // the kind-driven rules (multiset Bag, ordered Seq, float epsilon, …)
    // but not strict, exiftool coerced the value.
    let display_loose = matches_variant(display_v, expected, kind);
    let raw_loose = matches_variant(raw_v, expected, kind);
    if display_loose || raw_loose {
        let observed = describe(display_v, raw_v);
        let reason = format!(
            "exiftool normalised {}: sent {:?}, file holds {}",
            key, expected, observed
        );
        return ("Coerced".to_string(), Some(reason));
    }

    let actual = describe(display_v, raw_v);
    let reason = format!(
        "Verification failed for {}: expected {:?}, got {}",
        key, expected, actual
    );
    ("Mismatch".to_string(), Some(reason))
}

fn verify_list_add(
    key: &str,
    expected: Option<&Variant>,
    fresh_display: &HashMap<String, Variant>,
    fresh_raw: &HashMap<String, Variant>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };
    if list_contains_all(fresh_display.get(key), expected)
        || list_contains_all(fresh_raw.get(key), expected)
    {
        return ("Match".to_string(), None);
    }
    let actual = describe(fresh_display.get(key), fresh_raw.get(key));
    let reason = format!(
        "ListAdd verification failed for {}: items {:?} not all present in {}",
        key, expected, actual
    );
    ("Mismatch".to_string(), Some(reason))
}

fn verify_list_remove(
    key: &str,
    expected: Option<&Variant>,
    fresh_display: &HashMap<String, Variant>,
    fresh_raw: &HashMap<String, Variant>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };
    if list_contains_none(fresh_display.get(key), expected)
        || list_contains_none(fresh_raw.get(key), expected)
    {
        return ("Match".to_string(), None);
    }
    let actual = describe(fresh_display.get(key), fresh_raw.get(key));
    let reason = format!(
        "ListRemove verification failed for {}: items {:?} still present in {}",
        key, expected, actual
    );
    ("Mismatch".to_string(), Some(reason))
}

/// Verify a `Delete` intent.  Phase 8.9: typed absence — tag is "gone" iff
/// it is missing (or `Variant::Null` / empty string) in *both* the display
/// and raw views.  Earlier versions checked only `fresh_raw`, which let a
/// silent Pass B failure (`scanner.rs` logs "raw_metadata will be empty for
/// this batch") report DeleteOk while the display map still held the tag.
fn verify_delete(
    key: &str,
    fresh_raw: &HashMap<String, Variant>,
    fresh_display: &HashMap<String, Variant>,
) -> (String, Option<String>) {
    fn looks_absent(v: Option<&Variant>) -> bool {
        match v {
            None => true,
            Some(Variant::Null) => true,
            // Empty string is also "gone" by exiftool's convention for some
            // string-typed tags after a `-TAG=` clear.
            Some(Variant::String(s)) if s.is_empty() => true,
            _ => false,
        }
    }
    if looks_absent(fresh_raw.get(key)) && looks_absent(fresh_display.get(key)) {
        ("DeleteOk".to_string(), None)
    } else {
        let v = fresh_display.get(key).or_else(|| fresh_raw.get(key));
        let reason = format!(
            "Delete verification failed for {}: tag still present (post-write value: {:?})",
            key, v
        );
        ("DeleteLingering".to_string(), Some(reason))
    }
}

/// Strict Variant equality used to distinguish Match from Coerced.  No
/// multiset promotion, no scalar↔list promotion, no cross-type fallback —
/// the post-write value's shape must mirror what we sent.
///
/// Floats use a tight epsilon (`STRICT_FLOAT_EPS`) rather than bit-identity:
/// exiftool round-trips through Perl's NV → rational → string → NV pipeline
/// for many tags, so the bit pattern often differs by a ULP from what we
/// sent even when the user's intent was preserved.  Bit-strict equality
/// would falsely report Coerced for every such write.  The epsilon is
/// chosen to be tighter than `matches_variant`'s loose 1e-6 so the
/// Match/Coerced split still surfaces real normalisations (5 → 5/1 stored
/// as 5.0 stays Match; 0.004 → 1/250 → 0.004000000000000001 stays Match;
/// 0.5 → 0.6 trips Coerced via the loose check, then Mismatch).
const STRICT_FLOAT_EPS: f64 = 1e-9;
fn variant_strict_eq(a: &Variant, b: &Variant) -> bool {
    match (a, b) {
        (Variant::Null, Variant::Null) => true,
        (Variant::Bool(x), Variant::Bool(y)) => x == y,
        (Variant::Integer(x), Variant::Integer(y)) => x == y,
        (Variant::Float(x), Variant::Float(y)) => (x - y).abs() < STRICT_FLOAT_EPS,
        (Variant::String(x), Variant::String(y)) => x == y,
        (Variant::List(x), Variant::List(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(a, b)| variant_strict_eq(a, b))
        }
        (Variant::Object(x), Variant::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|v2| variant_strict_eq(v, v2)))
        }
        _ => false,
    }
}

fn variant_storage_eq(actual: &Variant, expected: &Variant, kind: Option<&TagKind>) -> bool {
    matches!(
        kind,
        Some(TagKind::Date | TagKind::Time | TagKind::DateTime)
    ) && crate::write_args::normalise_storage_variant_for_kind(actual, kind)
        == crate::write_args::normalise_storage_variant_for_kind(expected, kind)
}

/// Type-aware Variant equality.  Bag is multiset, Seq is ordered (Phase 8.6).
/// `kind` may be None when the tag isn't in the registry; in that case we
/// fall back to multiset semantics for lists (most XMP list tags are Bag-shaped).
///
/// Recursive calls thread the appropriate inner kind so a `Seq<Bag<Text>>`
/// keeps Seq-ordered at the outer level and Bag-multiset at each element,
/// and a `Bag<Struct>` recurses into the struct's field map for per-field
/// kind awareness.
fn matches_variant(actual: Option<&Variant>, expected: &Variant, kind: Option<&TagKind>) -> bool {
    let actual = match actual {
        Some(v) => v,
        None => return matches!(expected, Variant::Null),
    };
    // Resolve the inner kind for one level of List recursion.
    let list_inner: Option<&TagKind> = match kind {
        Some(TagKind::Bag(inner)) | Some(TagKind::Seq(inner)) | Some(TagKind::Alt(inner)) => {
            Some(inner.as_ref())
        }
        _ => None,
    };
    match (actual, expected) {
        (Variant::Null, Variant::Null) => true,
        (Variant::Bool(a), Variant::Bool(b)) => a == b,
        (Variant::Integer(a), Variant::Integer(b)) => a == b,
        (Variant::Integer(a), Variant::Float(b)) | (Variant::Float(b), Variant::Integer(a)) => {
            ((*a as f64) - b).abs() < 1e-6
        }
        (Variant::Float(a), Variant::Float(b)) => (a - b).abs() < 1e-6,
        (Variant::String(a), Variant::String(b)) => a == b,
        (Variant::List(a), Variant::List(b)) => {
            // Phase 8.6: Seq comparison is element-wise ordered; Bag and Alt
            // (and unknown-kind list tags) are multiset.
            let ordered = matches!(kind, Some(TagKind::Seq(_)));
            if ordered {
                if a.len() != b.len() {
                    return false;
                }
                a.iter()
                    .zip(b.iter())
                    .all(|(x, y)| matches_variant(Some(x), y, list_inner))
            } else {
                if a == b {
                    return true;
                }
                if a.len() != b.len() {
                    return false;
                }
                let mut bb: Vec<&Variant> = b.iter().collect();
                for item in a {
                    if let Some(pos) = bb
                        .iter()
                        .position(|x| matches_variant(Some(*x), item, list_inner))
                    {
                        bb.swap_remove(pos);
                    } else {
                        return false;
                    }
                }
                bb.is_empty()
            }
        }
        (Variant::Object(a), Variant::Object(b)) => {
            // Per-key recursion.  When the kind is Struct, look up each
            // field's own kind so nested lists keep ordered/multiset
            // semantics; LangAlt is map-of-lang-code → text so per-value
            // kind is None and falls back to scalar equality.
            if a.len() != b.len() {
                return false;
            }
            let field_kinds: Option<&BTreeMap<String, TagKind>> = match kind {
                Some(TagKind::Struct(fields)) => Some(fields),
                _ => None,
            };
            a.iter().all(|(k, v)| {
                b.get(k).is_some_and(|v2| {
                    let inner = field_kinds.and_then(|f| f.get(k));
                    matches_variant(Some(v), v2, inner)
                })
            })
        }
        // Single scalar accepted against a one-element list (and vice versa).
        // exiftool naturally promotes a scalar into a Bag when the tag is a
        // list type — the verifier should treat that promotion as a match.
        (Variant::List(items), other) if items.len() == 1 => {
            matches_variant(Some(&items[0]), other, list_inner)
        }
        (other, Variant::List(items)) if items.len() == 1 => {
            matches_variant(Some(other), &items[0], list_inner)
        }
        // Cross-type fallback: stringify both and compare.  This catches
        // numeric-as-string round-trips from exiftool.
        _ => {
            let a_s = match actual {
                Variant::String(s) => s.clone(),
                Variant::Integer(n) => n.to_string(),
                Variant::Float(f) => f.to_string(),
                Variant::Bool(b) => {
                    if *b {
                        "1".to_string()
                    } else {
                        "0".to_string()
                    }
                }
                _ => return false,
            };
            let b_s = match expected {
                Variant::String(s) => s.clone(),
                Variant::Integer(n) => n.to_string(),
                Variant::Float(f) => f.to_string(),
                Variant::Bool(b) => {
                    if *b {
                        "1".to_string()
                    } else {
                        "0".to_string()
                    }
                }
                _ => return false,
            };
            a_s == b_s
        }
    }
}

fn list_contains_all(actual: Option<&Variant>, expected: &Variant) -> bool {
    let items_expected: &[Variant] = match expected {
        Variant::List(items) => items,
        _ => return false,
    };
    let items_actual: &[Variant] = match actual {
        Some(Variant::List(items)) => items,
        _ => return false,
    };
    items_expected.iter().all(|e| {
        items_actual
            .iter()
            .any(|a| matches_variant(Some(a), e, None))
    })
}

fn list_contains_none(actual: Option<&Variant>, expected: &Variant) -> bool {
    let items_expected: &[Variant] = match expected {
        Variant::List(items) => items,
        _ => return false,
    };
    let items_actual: &[Variant] = match actual {
        Some(Variant::List(items)) => items,
        _ => return true, // tag absent → nothing to remove from → ok
    };
    items_expected.iter().all(|e| {
        !items_actual
            .iter()
            .any(|a| matches_variant(Some(a), e, None))
    })
}

/// Is `actual` (a Variant from a fresh re-read) string-equal to the legacy
/// `expected` from the draft store?  String values compare directly; numeric
/// variants render to their decimal form so `"5"` matches `Variant::Integer(5)`.
///
/// Used by the existing unit tests; the live apply path now uses
/// `matches_variant` for typed comparison.
#[cfg_attr(not(test), allow(dead_code))]
fn matches_string(actual: Option<&Variant>, expected: &str) -> bool {
    match actual {
        None => false,
        Some(Variant::String(s)) => s == expected,
        Some(Variant::Integer(n)) => n.to_string() == expected,
        Some(Variant::Float(f)) => {
            if let Ok(parsed) = expected.parse::<f64>() {
                (f - parsed).abs() < 1e-6
            } else {
                f.to_string() == expected
            }
        }
        Some(Variant::Bool(b)) => {
            (matches!(expected, "1" | "True" | "true") && *b)
                || (matches!(expected, "0" | "False" | "false") && !*b)
        }
        Some(Variant::Null) => expected.is_empty(),
        Some(Variant::List(items)) => {
            let joined = items
                .iter()
                .map(|v| match v {
                    Variant::String(s) => s.clone(),
                    other => format!("{:?}", other),
                })
                .collect::<Vec<_>>()
                .join(", ");
            joined == expected
        }
        Some(Variant::Object(_)) => false,
    }
}

fn describe(display: Option<&Variant>, raw: Option<&Variant>) -> String {
    match (display, raw) {
        (None, None) => "<tag absent in both views>".to_string(),
        (Some(d), None) => format!("display={:?}", d),
        (None, Some(r)) => format!("raw={:?}", r),
        (Some(d), Some(r)) if d == r => format!("{:?}", d),
        (Some(d), Some(r)) => format!("display={:?}, raw={:?}", d, r),
    }
}

fn verify_metadata_set(
    key: &str,
    expected: Option<&MetadataValue>,
    fresh_display: &HashMap<String, MetadataValue>,
    fresh_raw: &HashMap<String, MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };

    let display_v = fresh_display.get(key);
    let raw_v = fresh_raw.get(key);

    if metadata_empty_value(expected)
        && metadata_empty_or_absent(display_v)
        && metadata_empty_or_absent(raw_v)
    {
        return ("Match".to_string(), None);
    }

    if display_v.is_none() && raw_v.is_none() {
        return (
            "MissingPostWrite".to_string(),
            Some(format!(
                "Tag {} absent after write (format may not support it)",
                key
            )),
        );
    }

    if display_v.is_some_and(|v| metadata_strict_eq(v, expected))
        || raw_v.is_some_and(|v| metadata_strict_eq(v, expected))
    {
        return ("Match".to_string(), None);
    }

    if display_v.is_some_and(metadata_unparsed) || raw_v.is_some_and(metadata_unparsed) {
        return (
            "UnparsedPostWrite".to_string(),
            Some(format!(
                "Post-write value for {} could not be parsed semantically",
                key
            )),
        );
    }

    if matches_metadata_value(display_v, expected, kind)
        || matches_metadata_value(raw_v, expected, kind)
    {
        return (
            "Coerced".to_string(),
            Some(format!(
                "exiftool normalised {}: sent {:?}, file holds display={:?}, raw={:?}",
                key, expected, display_v, raw_v
            )),
        );
    }

    (
        "Mismatch".to_string(),
        Some(format!(
            "Verification failed for {}: expected {:?}, got display={:?}, raw={:?}",
            key, expected, display_v, raw_v
        )),
    )
}

fn verify_metadata_delete(
    key: &str,
    fresh_raw: &HashMap<String, MetadataValue>,
    fresh_display: &HashMap<String, MetadataValue>,
) -> (String, Option<String>) {
    if metadata_empty_or_absent(fresh_raw.get(key))
        && metadata_empty_or_absent(fresh_display.get(key))
    {
        ("DeleteOk".to_string(), None)
    } else {
        (
            "DeleteLingering".to_string(),
            Some(format!(
                "Delete verification failed for {}: tag still present (display={:?}, raw={:?})",
                key,
                fresh_display.get(key),
                fresh_raw.get(key)
            )),
        )
    }
}

fn verify_metadata_list_add(
    key: &str,
    expected: Option<&MetadataValue>,
    fresh_display: &HashMap<String, MetadataValue>,
    fresh_raw: &HashMap<String, MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };
    if metadata_list_contains_all(fresh_display.get(key), expected, kind)
        || metadata_list_contains_all(fresh_raw.get(key), expected, kind)
    {
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
    fresh_display: &HashMap<String, MetadataValue>,
    fresh_raw: &HashMap<String, MetadataValue>,
    kind: Option<&TagKind>,
) -> (String, Option<String>) {
    let expected = match expected {
        Some(v) => v,
        None => return ("Match".to_string(), None),
    };
    if metadata_list_contains_none(fresh_display.get(key), expected, kind)
        || metadata_list_contains_none(fresh_raw.get(key), expected, kind)
    {
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

/// Apply draft edits for the given relative paths, using the provided drafts map.
/// Per-file: each file is processed independently so one failure does not block others.
pub fn apply_draft_edits(
    folder_path: &str,
    rel_paths: &[String],
    all_drafts: &HashMap<String, HashMap<String, Option<String>>>,
) -> ApplyEditsResult {
    let mut applied = Vec::new();
    let mut failed = Vec::new();
    let mut fresh_metadata = HashMap::new();

    for rel_path in rel_paths {
        let edits = match all_drafts.get(rel_path.as_str()) {
            Some(e) if !e.is_empty() => e,
            _ => {
                log::debug!("[apply_edits] No drafts for {}, skipping", rel_path);
                continue;
            }
        };

        let outcome = apply_single_file(folder_path, rel_path, edits);

        // Always store fresh metadata if available so the UI reflects actual file state,
        // even when verification failed (partial write / corruption case).
        if let Some(meta) = outcome.fresh_metadata {
            fresh_metadata.insert(rel_path.clone(), meta);
        }

        match outcome.error {
            None => {
                log::info!("[apply_edits] Successfully applied edits to {}", rel_path);
                applied.push(rel_path.clone());
            }
            Some(reason) => {
                log::error!("[apply_edits] Failed for {}: {}", rel_path, reason);
                failed.push(FailedFile {
                    relative_path: rel_path.clone(),
                    reason,
                });
            }
        }
    }

    ApplyEditsResult {
        applied,
        failed,
        fresh_metadata,
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

    type TestDrafts = HashMap<String, HashMap<String, crate::draft_edits::MetadataDraftEdit>>;

    fn is_hard_failure(outcome: &MetadataSingleFileOutcome, substr: &str) -> bool {
        outcome.fresh_metadata.is_none()
            && outcome.error.as_deref().is_some_and(|e| e.contains(substr))
    }

    // ── matches_string ────────────────────────────────────────────────

    #[test]
    fn matches_string_handles_variant_string() {
        assert!(matches_string(Some(&Variant::String("hi".into())), "hi"));
        assert!(!matches_string(Some(&Variant::String("hi".into())), "bye"));
    }

    #[test]
    fn matches_string_handles_integer() {
        assert!(matches_string(Some(&Variant::Integer(5)), "5"));
        assert!(!matches_string(Some(&Variant::Integer(5)), "6"));
        assert!(matches_string(Some(&Variant::Integer(6)), "6"));
    }

    #[test]
    fn matches_string_handles_float_with_epsilon() {
        assert!(matches_string(Some(&Variant::Float(0.0040001)), "0.004"));
        assert!(!matches_string(Some(&Variant::Float(0.5)), "0.6"));
    }

    #[test]
    fn matches_string_handles_bool() {
        assert!(matches_string(Some(&Variant::Bool(true)), "1"));
        assert!(matches_string(Some(&Variant::Bool(true)), "True"));
        assert!(matches_string(Some(&Variant::Bool(false)), "0"));
        assert!(matches_string(Some(&Variant::Bool(false)), "False"));
    }

    #[test]
    fn matches_string_handles_null_and_empty() {
        assert!(matches_string(Some(&Variant::Null), ""));
        assert!(!matches_string(Some(&Variant::Null), "x"));
    }

    #[test]
    fn matches_string_handles_list_comma_join() {
        let list = Variant::List(vec![
            Variant::String("a".into()),
            Variant::String("b".into()),
        ]);
        assert!(matches_string(Some(&list), "a, b"));
        assert!(!matches_string(Some(&list), "a"));
    }

    #[test]
    fn matches_string_returns_false_for_absent_tag() {
        assert!(!matches_string(None, "anything"));
    }

    #[test]
    fn empty_edits_is_hard_failure() {
        let outcome = apply_single_file_metadata("/tmp", "photo.jpg", &HashMap::new());
        assert!(is_hard_failure(&outcome, "No edits"));
    }

    #[test]
    fn missing_file_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert(
            "XMP-dc:Description".to_string(),
            metadata_edit(MetadataValue::Text("test".to_string())),
        );
        let outcome = apply_single_file_metadata("/tmp", "nonexistent_photo_xyz_999.jpg", &edits);
        assert!(is_hard_failure(&outcome, "not found"));
    }

    #[test]
    fn key_with_newline_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert(
            "Bad\nKey".to_string(),
            metadata_edit(MetadataValue::Text("test".to_string())),
        );
        let outcome = apply_single_file_metadata("/tmp", "photo.jpg", &edits);
        assert!(is_hard_failure(&outcome, "Invalid tag key"));
    }

    #[test]
    fn key_with_null_byte_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert(
            "Bad\0Key".to_string(),
            metadata_edit(MetadataValue::Text("test".to_string())),
        );
        let outcome = apply_single_file_metadata("/tmp", "photo.jpg", &edits);
        assert!(is_hard_failure(&outcome, "Invalid tag key"));
    }

    #[test]
    fn missing_file_is_reported_in_failed_list() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string()];
        let mut drafts: TestDrafts = HashMap::new();
        let mut file_edits = HashMap::new();
        file_edits.insert(
            "XMP-dc:Description".to_string(),
            metadata_edit(MetadataValue::Text("hello".to_string())),
        );
        drafts.insert("a.jpg".to_string(), file_edits);

        let result = apply_metadata_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].relative_path, "a.jpg");
        assert!(!result.failed[0].reason.is_empty());
    }

    #[test]
    fn path_with_no_drafts_is_skipped_not_failed() {
        let folder = "/some/folder";
        let paths = vec!["photo_with_no_edits.jpg".to_string()];
        let drafts: TestDrafts = HashMap::new();

        let result = apply_metadata_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 0);
    }

    #[test]
    fn multiple_files_tracked_independently() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string(), "b.jpg".to_string()];
        let mut drafts: TestDrafts = HashMap::new();

        let mut edits_a = HashMap::new();
        edits_a.insert(
            "XMP-dc:Description".to_string(),
            metadata_edit(MetadataValue::Text("test a".to_string())),
        );
        drafts.insert("a.jpg".to_string(), edits_a);

        let mut edits_b = HashMap::new();
        edits_b.insert(
            "XMP-dc:Description".to_string(),
            metadata_edit(MetadataValue::Text("test b".to_string())),
        );
        drafts.insert("b.jpg".to_string(), edits_b);

        let result = apply_metadata_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 2);
    }

    #[test]
    fn hard_failure_produces_no_fresh_metadata() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string()];
        let mut drafts: TestDrafts = HashMap::new();
        let mut file_edits = HashMap::new();
        file_edits.insert(
            "XMP-dc:Description".to_string(),
            metadata_edit(MetadataValue::Text("hello".to_string())),
        );
        drafts.insert("a.jpg".to_string(), file_edits);

        let result = apply_metadata_draft_edits(folder, &paths, &drafts);
        assert!(
            !result.fresh_metadata.contains_key("a.jpg"),
            "hard failure (file not found) should not produce fresh metadata"
        );
    }

    // ── verify_set: Match / Coerced / Mismatch / MissingPostWrite (Phase 8.1) ─

    fn map(pairs: &[(&str, Variant)]) -> HashMap<String, Variant> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn verify_set_match_when_strict_equal() {
        let display = map(&[("X", Variant::Integer(5))]);
        let raw = map(&[("X", Variant::Integer(5))]);
        let (kind, _) = verify_set("X", Some(&Variant::Integer(5)), &display, &raw, None);
        assert_eq!(kind, "Match");
    }

    #[test]
    fn verify_set_coerced_when_loose_equal_only() {
        // Sent Integer(5); file holds Float(5.0) — loose match, not strict.
        let display = map(&[("X", Variant::Float(5.0))]);
        let raw = map(&[("X", Variant::Float(5.0))]);
        let (kind, msg) = verify_set("X", Some(&Variant::Integer(5)), &display, &raw, None);
        assert_eq!(kind, "Coerced");
        assert!(msg.unwrap().contains("normalised"));
    }

    #[test]
    fn verify_set_coerced_when_bool_normalised_to_string() {
        // Sent Bool(true); file holds String("True") — loose match via cross-type.
        let display = map(&[("X", Variant::String("True".into()))]);
        let raw = map(&[("X", Variant::Integer(1))]);
        let (kind, _) = verify_set("X", Some(&Variant::Bool(true)), &display, &raw, None);
        // Raw side strictly matches Bool→Int via cross-type; the Bool/Integer
        // pairing is loose-only, so this is Coerced.
        assert_eq!(kind, "Coerced");
    }

    #[test]
    fn verify_set_mismatch_when_neither_loose_nor_strict() {
        let display = map(&[("X", Variant::String("totally other".into()))]);
        let raw = map(&[("X", Variant::String("totally other".into()))]);
        let (kind, _) = verify_set("X", Some(&Variant::Integer(5)), &display, &raw, None);
        assert_eq!(kind, "Mismatch");
    }

    #[test]
    fn verify_set_missing_post_write_when_tag_absent() {
        let display = HashMap::new();
        let raw = HashMap::new();
        let (kind, msg) = verify_set("X", Some(&Variant::Integer(5)), &display, &raw, None);
        assert_eq!(kind, "MissingPostWrite");
        assert!(msg.unwrap().contains("absent after write"));
    }

    #[test]
    fn verify_set_matches_schema_date_storage_format() {
        let display = HashMap::new();
        let raw = map(&[(
            "ExifIFD:DateTimeOriginal",
            Variant::String("2026:05:15 10:30:00".into()),
        )]);
        let (kind, msg) = verify_set(
            "ExifIFD:DateTimeOriginal",
            Some(&Variant::String("2026-05-15T10:30:00".into())),
            &display,
            &raw,
            Some(&TagKind::DateTime),
        );
        assert_eq!(kind, "Match");
        assert!(msg.is_none());
    }

    // ── Empty-string Set on a new or existing tag is a Match, not MissingPostWrite.
    // exiftool's `-TAG=` clears the tag, so the post-write file typically has
    // the tag absent.  The user asked for an empty value and got it — report
    // success.  Regression: previously surfaced as MissingPostWrite/Mismatch
    // and the apply UI reported the operation as failed.

    #[test]
    fn verify_set_empty_string_matches_when_tag_absent_post_write() {
        let display = HashMap::new();
        let raw = HashMap::new();
        let (kind, msg) = verify_set(
            "X",
            Some(&Variant::String(String::new())),
            &display,
            &raw,
            None,
        );
        assert_eq!(
            kind, "Match",
            "empty-string Set + absent post-write must be Match"
        );
        assert!(msg.is_none());
    }

    #[test]
    fn verify_set_empty_string_matches_when_tag_null_post_write() {
        let display = map(&[("X", Variant::Null)]);
        let raw = map(&[("X", Variant::Null)]);
        let (kind, _) = verify_set(
            "X",
            Some(&Variant::String(String::new())),
            &display,
            &raw,
            None,
        );
        assert_eq!(kind, "Match");
    }

    #[test]
    fn verify_set_empty_string_matches_when_tag_empty_string_post_write() {
        // Some formats retain the tag with an empty value rather than dropping it.
        let display = map(&[("X", Variant::String(String::new()))]);
        let raw = map(&[("X", Variant::String(String::new()))]);
        let (kind, _) = verify_set(
            "X",
            Some(&Variant::String(String::new())),
            &display,
            &raw,
            None,
        );
        assert_eq!(kind, "Match");
    }

    #[test]
    fn verify_set_null_value_matches_when_tag_absent_post_write() {
        // Variant::Null Set is the typed equivalent of an empty edit.
        let display = HashMap::new();
        let raw = HashMap::new();
        let (kind, _) = verify_set("X", Some(&Variant::Null), &display, &raw, None);
        assert_eq!(kind, "Match");
    }

    #[test]
    fn verify_set_empty_list_matches_when_tag_absent_post_write() {
        // Regression: Bag/Seq cleared (Variant::List vec![]) used to report
        // MissingPostWrite because the empty-value short-circuit only
        // covered Null/empty-String.  exiftool's `-TAG=` clear drops the
        // tag entirely, so absent + we sent empty must be a Match.
        let display = HashMap::new();
        let raw = HashMap::new();
        let kind_bag = TagKind::Bag(Box::new(TagKind::Text));
        let (outcome, msg) = verify_set(
            "AIOcrText",
            Some(&Variant::List(vec![])),
            &display,
            &raw,
            Some(&kind_bag),
        );
        assert_eq!(outcome, "Match");
        assert!(msg.is_none());
    }

    #[test]
    fn verify_set_empty_list_matches_when_tag_empty_list_post_write() {
        // Some formats retain the list shell with no items rather than
        // dropping the tag.  Empty == empty is still a Match.
        let display = map(&[("X", Variant::List(vec![]))]);
        let raw = map(&[("X", Variant::List(vec![]))]);
        let (outcome, _) = verify_set("X", Some(&Variant::List(vec![])), &display, &raw, None);
        assert_eq!(outcome, "Match");
    }

    #[test]
    fn verify_set_empty_list_mismatch_when_post_write_has_items() {
        // Empty-list Set must NOT short-circuit to Match when the file
        // still holds items — that's a real write failure.
        let display = map(&[("X", Variant::List(vec![Variant::String("kept".into())]))]);
        let raw = map(&[("X", Variant::List(vec![Variant::String("kept".into())]))]);
        let (outcome, _) = verify_set("X", Some(&Variant::List(vec![])), &display, &raw, None);
        assert_eq!(outcome, "Mismatch");
    }

    #[test]
    fn verify_set_empty_string_mismatch_when_post_write_has_real_value() {
        // Empty-string Set should NOT short-circuit to Match if the file
        // still carries a non-empty value — that's a real write failure.
        let display = map(&[("X", Variant::String("leftover".into()))]);
        let raw = map(&[("X", Variant::String("leftover".into()))]);
        let (kind, _) = verify_set(
            "X",
            Some(&Variant::String(String::new())),
            &display,
            &raw,
            None,
        );
        assert_eq!(kind, "Mismatch");
    }

    // ── 8.6: Seq is ordered, Bag is multiset ──────────────────────────────────

    #[test]
    fn matches_variant_seq_is_order_sensitive() {
        let a = Variant::List(vec![
            Variant::String("a".into()),
            Variant::String("b".into()),
        ]);
        let b = Variant::List(vec![
            Variant::String("b".into()),
            Variant::String("a".into()),
        ]);
        let seq_kind = TagKind::Seq(Box::new(TagKind::Text));
        assert!(
            !matches_variant(Some(&a), &b, Some(&seq_kind)),
            "Seq comparison must be ordered"
        );
    }

    #[test]
    fn matches_variant_bag_is_order_insensitive() {
        let a = Variant::List(vec![
            Variant::String("a".into()),
            Variant::String("b".into()),
        ]);
        let b = Variant::List(vec![
            Variant::String("b".into()),
            Variant::String("a".into()),
        ]);
        let bag_kind = TagKind::Bag(Box::new(TagKind::Text));
        assert!(
            matches_variant(Some(&a), &b, Some(&bag_kind)),
            "Bag comparison must be multiset"
        );
    }

    #[test]
    fn matches_variant_unknown_kind_falls_back_to_multiset() {
        // Most XMP list tags are Bag-shaped; when listx leaves us without a
        // kind, multiset is the safer default than ordered.
        let a = Variant::List(vec![
            Variant::String("a".into()),
            Variant::String("b".into()),
        ]);
        let b = Variant::List(vec![
            Variant::String("b".into()),
            Variant::String("a".into()),
        ]);
        assert!(matches_variant(Some(&a), &b, None));
    }

    // ── 8.9: Delete verification uses typed absence ───────────────────────────

    #[test]
    fn verify_delete_absent_when_tag_missing() {
        let display = HashMap::new();
        let raw = HashMap::new();
        let (kind, _) = verify_delete("X", &raw, &display);
        assert_eq!(kind, "DeleteOk");
    }

    #[test]
    fn verify_delete_absent_when_tag_null() {
        let display = HashMap::new();
        let raw = map(&[("X", Variant::Null)]);
        let (kind, _) = verify_delete("X", &raw, &display);
        assert_eq!(kind, "DeleteOk");
    }

    #[test]
    fn verify_delete_lingering_when_integer_present() {
        // Phase 8.9 regression: previous code formatted Variant::Integer(0)
        // via {:?} ("Integer(0)") and is_empty()-tested it (false), so it
        // would report lingering — but for the wrong reason.  This test pins
        // the new typed-absence behaviour: the integer is genuinely present,
        // so DeleteLingering is the correct outcome and the message reflects it.
        let display = HashMap::new();
        let raw = map(&[("X", Variant::Integer(0))]);
        let (kind, msg) = verify_delete("X", &raw, &display);
        assert_eq!(kind, "DeleteLingering");
        assert!(msg.unwrap().contains("still present"));
    }

    #[test]
    fn verify_delete_absent_when_string_empty() {
        let display = HashMap::new();
        let raw = map(&[("X", Variant::String(String::new()))]);
        let (kind, _) = verify_delete("X", &raw, &display);
        assert_eq!(kind, "DeleteOk");
    }

    // ── verify_delete needs absence in BOTH display and raw maps ─────────────

    #[test]
    fn verify_delete_lingering_when_only_raw_is_absent() {
        // Pass B (raw) silently failed for this batch, so raw map is empty,
        // but the display map still holds the tag — design wants the
        // disagreement surfaced as DeleteLingering, not DeleteOk.
        let display = map(&[("X", Variant::String("still here".into()))]);
        let raw = HashMap::new();
        let (kind, msg) = verify_delete("X", &raw, &display);
        assert_eq!(kind, "DeleteLingering");
        assert!(msg.unwrap().contains("still present"));
    }

    #[test]
    fn verify_delete_ok_when_both_views_absent() {
        let display = HashMap::new();
        let raw = HashMap::new();
        let (kind, _) = verify_delete("X", &raw, &display);
        assert_eq!(kind, "DeleteOk");
    }

    // ── variant_strict_eq float epsilon (Phase 8 fix-up) ─────────────────────

    #[test]
    fn variant_strict_eq_floats_within_strict_eps_are_equal() {
        // exiftool round-trips 0.004 (= 1/250) through a rational form and may
        // re-emit a value differing by a ULP.  Strict equality must allow this
        // so the apply path reports Match, not Coerced.
        assert!(variant_strict_eq(
            &Variant::Float(0.004),
            &Variant::Float(0.004 + 1e-12)
        ));
    }

    #[test]
    fn variant_strict_eq_floats_outside_strict_eps_are_not_equal() {
        // A meaningful divergence still trips Coerced (and the loose check
        // then decides whether it's Coerced or Mismatch).
        assert!(!variant_strict_eq(
            &Variant::Float(0.004),
            &Variant::Float(0.005)
        ));
    }

    // ── matches_variant kind threading (Phase 8 fix-up) ──────────────────────

    #[test]
    fn matches_variant_threads_inner_kind_for_seq_of_seq() {
        // Outer Seq is ordered; inner Seq is ordered too.  Reversing the
        // inner element order must not match.
        let a = Variant::List(vec![Variant::List(vec![
            Variant::String("a".into()),
            Variant::String("b".into()),
        ])]);
        let b = Variant::List(vec![Variant::List(vec![
            Variant::String("b".into()),
            Variant::String("a".into()),
        ])]);
        let outer = TagKind::Seq(Box::new(TagKind::Seq(Box::new(TagKind::Text))));
        assert!(
            !matches_variant(Some(&a), &b, Some(&outer)),
            "Seq<Seq<Text>> must stay ordered through recursion"
        );
    }

    #[test]
    fn matches_variant_threads_struct_field_kinds() {
        // Struct field `tags` is Seq — so reversing inside that field must
        // not match even though the outer struct compares per-key.
        let mut a_obj: BTreeMap<String, Variant> = BTreeMap::new();
        a_obj.insert(
            "tags".to_string(),
            Variant::List(vec![
                Variant::String("x".into()),
                Variant::String("y".into()),
            ]),
        );
        let mut b_obj: BTreeMap<String, Variant> = BTreeMap::new();
        b_obj.insert(
            "tags".to_string(),
            Variant::List(vec![
                Variant::String("y".into()),
                Variant::String("x".into()),
            ]),
        );
        let mut fields: BTreeMap<String, TagKind> = BTreeMap::new();
        fields.insert("tags".to_string(), TagKind::Seq(Box::new(TagKind::Text)));
        let kind = TagKind::Struct(fields);
        assert!(!matches_variant(
            Some(&Variant::Object(a_obj)),
            &Variant::Object(b_obj),
            Some(&kind),
        ));
    }

    // ── 8.1: Match retains tags_to_clear; Coerced does not ───────────────────

    #[test]
    fn outcome_invariants_are_documented() {
        // Documents the Phase-8 contract for the apply loop in lib.rs:
        // - Match / DeleteOk → safe to remove that tag from the draft store.
        // - Coerced → leave the draft so the user can decide.
        // - Mismatch / DeleteLingering / MissingPostWrite → leave the draft.
        // The integration tests on the frontend exercise the real path; this
        // unit test exists so a future refactor that changes the semantics
        // forces a deliberate edit here.
        assert_eq!("Match", "Match");
        assert_eq!("DeleteOk", "DeleteOk");
        assert_eq!("Coerced", "Coerced");
        assert_eq!("Mismatch", "Mismatch");
        assert_eq!("DeleteLingering", "DeleteLingering");
        assert_eq!("MissingPostWrite", "MissingPostWrite");
    }

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
        let display = metadata_map(&[("X", MetadataValue::Integer(5))]);
        let raw = metadata_map(&[("X", MetadataValue::Integer(5))]);
        let (kind, _) =
            verify_metadata_set("X", Some(&MetadataValue::Integer(5)), &display, &raw, None);
        assert_eq!(kind, "Match");

        let raw = metadata_map(&[("X", MetadataValue::Real(5.0))]);
        let (kind, _) = verify_metadata_set(
            "X",
            Some(&MetadataValue::Integer(5)),
            &HashMap::new(),
            &raw,
            None,
        );
        assert_eq!(kind, "Coerced");

        let raw = metadata_map(&[("X", MetadataValue::Text("other".into()))]);
        let (kind, _) = verify_metadata_set(
            "X",
            Some(&MetadataValue::Integer(5)),
            &HashMap::new(),
            &raw,
            None,
        );
        assert_eq!(kind, "Mismatch");

        let (kind, _) = verify_metadata_set(
            "X",
            Some(&MetadataValue::Integer(5)),
            &HashMap::new(),
            &HashMap::new(),
            None,
        );
        assert_eq!(kind, "MissingPostWrite");

        let raw = metadata_map(&[(
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
            "X",
            Some(&MetadataValue::Integer(5)),
            &HashMap::new(),
            &raw,
            None,
        );
        assert_eq!(kind, "UnparsedPostWrite");
    }

    #[test]
    fn verify_metadata_rational_equivalence_uses_cross_multiply() {
        let raw = metadata_map(&[(
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
            &HashMap::new(),
            &raw,
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
        let raw = metadata_map(&[(
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
            &HashMap::new(),
            &raw,
            Some(&TagKind::Date),
        );
        assert_eq!(kind, "Match");
    }
}
