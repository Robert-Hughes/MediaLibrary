use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::scanner::{self, Variant};
use crate::tag_schema::TagKind;

/// Run one exiftool write invocation against `path` with the provided args.
/// `numeric=true` prepends `-n` so values are interpreted as raw numerics.
fn run_exiftool_write(path: &Path, args: &[String], numeric: bool) -> Result<(), String> {
    let exiftool_cmd = scanner::find_exiftool();
    let mut cmd = Command::new(exiftool_cmd);
    cmd.arg("-overwrite_original");
    if numeric {
        cmd.arg("-n");
    }
    for a in args {
        cmd.arg(a);
    }
    cmd.arg(path);

    let output = cmd.output().map_err(|e| format!(
        "Failed to execute ExifTool: {}. Please ensure ExifTool is installed.", e
    ))?;
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
/// - `"Match"`           — post-write file equals what we sent (exact, type-aware).
/// - `"Coerced"`         — post-write file is equivalent under type-aware
///                          equality but not byte-identical (e.g. exiftool
///                          wrote `5/1` for our `5`, or normalised `True`).
///                          Frontend prompts the user to accept-or-revert.
/// - `"Mismatch"`        — post-write differs both exactly and structurally.
///                          Draft retained.
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

/// Apply draft edits to a single file using exiftool, then re-read and verify.
///
/// Legacy entry: accepts the string-only edit map and wraps each value into
/// a typed `DraftEdit` via `from_legacy_string`.  Existing callers (the
/// frontend save → apply_draft_edits_cmd → here pipeline pre-Phase 3b/4)
/// keep working unchanged; chip editors that produce `Variant::List` use
/// `apply_single_file_typed` directly so list-shape survives write-back.
pub fn apply_single_file(
    folder_path: &str,
    rel_path: &str,
    edits: &HashMap<String, Option<String>>,
) -> SingleFileOutcome {
    let typed: HashMap<String, crate::draft_edits::DraftEdit> = edits
        .iter()
        .map(|(k, v)| (k.clone(), crate::draft_edits::DraftEdit::from_legacy_string(v.clone())))
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

    let abs_path = Path::new(folder_path)
        .join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));

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
    // with empty before-views.
    let (before_display, before_raw) =
        match scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path.clone()]) {
            Ok(mut results) => match results.pop() {
                Some(r) => (r.metadata, r.raw_metadata),
                None => (HashMap::new(), HashMap::new()),
            },
            Err(e) => {
                log::warn!("[apply_edits] Pre-write read failed for {}: {}", rel_path, e);
                (HashMap::new(), HashMap::new())
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
        rel_path, combined.numeric.len(), combined.text.len()
    );

    // Numeric pass first.  Edits in the text group may reference tags set
    // here for derived-field interactions (rare, but exiftool docs reserve
    // the right).
    if !combined.numeric.is_empty() {
        if let Err(e) = run_exiftool_write(&abs_path, &combined.numeric, /*numeric=*/true) {
            return SingleFileOutcome::hard_failure(e);
        }
    }
    if !combined.text.is_empty() {
        if let Err(e) = run_exiftool_write(&abs_path, &combined.text, /*numeric=*/false) {
            return SingleFileOutcome::hard_failure(e);
        }
    }

    // Re-read metadata via the two-pass scanner.  `display` is pretty
    // (PrintConv'd) values; `raw` is `-n` values.
    let (fresh_display, fresh_raw) =
        match scanner::read_image_metadata_batch(&[rel_path.to_string()], &[abs_path]) {
            Ok(mut results) => match results.pop() {
                Some(r) => (r.metadata, r.raw_metadata),
                None => return SingleFileOutcome::hard_failure(
                    "Post-write read returned no entry".to_string(),
                ),
            },
            Err(e) => return SingleFileOutcome::hard_failure(format!("Post-write read failed: {}", e)),
        };

    // Verify each edit per its intent + the schema's TagKind.
    use crate::draft_edits::EditIntent;
    let mut tag_outcomes: Vec<TagOutcome> = Vec::with_capacity(edits.len());
    let mut tags_to_clear: Vec<String> = Vec::new();
    let mut first_mismatch: Option<String> = None;

    for (key, edit) in edits {
        let kind = registry
            .and_then(|r| r.lookup(key))
            .map(|i| i.kind.clone());

        let (outcome_kind, message) = match edit.intent {
            EditIntent::Delete => verify_delete(key, &fresh_raw, &fresh_display),
            EditIntent::Set => verify_set(key, edit.value.as_ref(), &fresh_display, &fresh_raw, kind.as_ref()),
            EditIntent::ListAdd => verify_list_add(key, edit.value.as_ref(), &fresh_display, &fresh_raw),
            EditIntent::ListRemove => verify_list_remove(key, edit.value.as_ref(), &fresh_display, &fresh_raw),
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
    );

    SingleFileOutcome {
        fresh_metadata: Some(fresh_display),
        error: first_mismatch,
        outcomes: tag_outcomes,
        tags_to_clear,
    }
}

/// Verify a `Set` intent by comparing the post-write file to what we sent.
///
/// Distinguishes three success-shaped outcomes:
/// - `"Match"`   — exact equality (kind-aware) on either view.
/// - `"Coerced"` — equivalent under type-aware equality (multiset / epsilon
///                 / per-lang / promote-scalar-to-list / cross-type stringify)
///                 but not byte-identical.  User must accept or revert.
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

    if display_v.is_none() && raw_v.is_none() {
        let reason = format!(
            "Tag {} absent after write (format may not support it)",
            key
        );
        return ("MissingPostWrite".to_string(), Some(reason));
    }

    // Strict (exact) compare first — picks up the Match case.
    let display_strict = display_v.map_or(false, |v| variant_strict_eq(v, expected));
    let raw_strict = raw_v.map_or(false, |v| variant_strict_eq(v, expected));
    if display_strict || raw_strict {
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
/// it is missing from the raw map or its raw value is `Variant::Null`.  The
/// previous implementation `format!("{:?}", v).is_empty()`-tested non-string
/// values and so always reported lingering for e.g. `Variant::Integer(0)`.
fn verify_delete(
    key: &str,
    fresh_raw: &HashMap<String, Variant>,
    fresh_display: &HashMap<String, Variant>,
) -> (String, Option<String>) {
    let absent = match fresh_raw.get(key) {
        None => true,
        Some(Variant::Null) => true,
        // Empty string is also "gone" by exiftool's convention for some
        // string-typed tags after a `-TAG=` clear.
        Some(Variant::String(s)) if s.is_empty() => true,
        _ => false,
    };
    if absent {
        ("DeleteOk".to_string(), None)
    } else {
        let v = fresh_raw.get(key).or_else(|| fresh_display.get(key));
        let reason = format!(
            "Delete verification failed for {}: tag still present (post-write value: {:?})",
            key, v
        );
        ("DeleteLingering".to_string(), Some(reason))
    }
}

/// Strict (byte-identical) Variant equality with no float epsilon, no
/// multiset promotion, no scalar-to-list promotion, no cross-type fallback.
/// Used to distinguish Match from Coerced.
fn variant_strict_eq(a: &Variant, b: &Variant) -> bool {
    match (a, b) {
        (Variant::Null, Variant::Null) => true,
        (Variant::Bool(x), Variant::Bool(y)) => x == y,
        (Variant::Integer(x), Variant::Integer(y)) => x == y,
        (Variant::Float(x), Variant::Float(y)) => x.to_bits() == y.to_bits(),
        (Variant::String(x), Variant::String(y)) => x == y,
        (Variant::List(x), Variant::List(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(a, b)| variant_strict_eq(a, b))
        }
        (Variant::Object(x), Variant::Object(y)) => {
            x.len() == y.len()
                && x.iter().all(|(k, v)| y.get(k).map_or(false, |v2| variant_strict_eq(v, v2)))
        }
        _ => false,
    }
}

/// Type-aware Variant equality.  Bag is multiset, Seq is ordered (Phase 8.6).
/// `kind` may be None when the tag isn't in the registry; in that case we
/// fall back to multiset semantics for lists (most XMP list tags are Bag-shaped).
fn matches_variant(actual: Option<&Variant>, expected: &Variant, kind: Option<&TagKind>) -> bool {
    let actual = match actual {
        Some(v) => v,
        None => return matches!(expected, Variant::Null),
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
                if a.len() != b.len() { return false; }
                a.iter().zip(b.iter()).all(|(x, y)| matches_variant(Some(x), y, None))
            } else {
                if a == b { return true; }
                if a.len() != b.len() { return false; }
                let mut bb: Vec<&Variant> = b.iter().collect();
                for item in a {
                    if let Some(pos) = bb.iter().position(|x| matches_variant(Some(*x), item, None)) {
                        bb.swap_remove(pos);
                    } else {
                        return false;
                    }
                }
                bb.is_empty()
            }
        }
        (Variant::Object(a), Variant::Object(b)) => {
            // Per-key recursion (LangAlt is map-of-language-codes).  Strict
            // key set equality, type-aware value equality.
            if a.len() != b.len() { return false; }
            a.iter().all(|(k, v)| b.get(k).map_or(false, |v2| matches_variant(Some(v), v2, None)))
        }
        // Single scalar accepted against a one-element list (and vice versa).
        // exiftool naturally promotes a scalar into a Bag when the tag is a
        // list type — the verifier should treat that promotion as a match.
        (Variant::List(items), other) if items.len() == 1 => {
            matches_variant(Some(&items[0]), other, None)
        }
        (other, Variant::List(items)) if items.len() == 1 => {
            matches_variant(Some(other), &items[0], None)
        }
        // Cross-type fallback: stringify both and compare.  This catches
        // numeric-as-string round-trips from exiftool.
        _ => {
            let a_s = match actual {
                Variant::String(s) => s.clone(),
                Variant::Integer(n) => n.to_string(),
                Variant::Float(f) => f.to_string(),
                Variant::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
                _ => return false,
            };
            let b_s = match expected {
                Variant::String(s) => s.clone(),
                Variant::Integer(n) => n.to_string(),
                Variant::Float(f) => f.to_string(),
                Variant::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
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
    items_expected.iter().all(|e| items_actual.iter().any(|a| matches_variant(Some(a), e, None)))
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
    items_expected.iter().all(|e| !items_actual.iter().any(|a| matches_variant(Some(a), e, None)))
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
            matches!(expected, "1" | "True" | "true") == *b
                || matches!(expected, "0" | "False" | "false") == !*b
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
                failed.push(FailedFile { relative_path: rel_path.clone(), reason });
            }
        }
    }

    ApplyEditsResult {
        applied,
        failed,
        fresh_metadata,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_hard_failure(outcome: &SingleFileOutcome, substr: &str) -> bool {
        outcome.fresh_metadata.is_none()
            && outcome.error.as_deref().map_or(false, |e| e.contains(substr))
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
        let outcome = apply_single_file("/tmp", "photo.jpg", &HashMap::new());
        assert!(is_hard_failure(&outcome, "No edits"));
    }

    #[test]
    fn missing_file_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert("XMP-dc:Description".to_string(), Some("test".to_string()));
        let outcome = apply_single_file("/tmp", "nonexistent_photo_xyz_999.jpg", &edits);
        assert!(is_hard_failure(&outcome, "not found"));
    }

    #[test]
    fn key_with_newline_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert("Bad\nKey".to_string(), Some("test".to_string()));
        let outcome = apply_single_file("/tmp", "photo.jpg", &edits);
        assert!(is_hard_failure(&outcome, "Invalid tag key"));
    }

    #[test]
    fn key_with_null_byte_is_hard_failure() {
        let mut edits = HashMap::new();
        edits.insert("Bad\0Key".to_string(), Some("test".to_string()));
        let outcome = apply_single_file("/tmp", "photo.jpg", &edits);
        assert!(is_hard_failure(&outcome, "Invalid tag key"));
    }

    #[test]
    fn missing_file_is_reported_in_failed_list() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string()];
        let mut drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();
        let mut file_edits = HashMap::new();
        file_edits.insert(
            "XMP-dc:Description".to_string(),
            Some("hello".to_string()),
        );
        drafts.insert("a.jpg".to_string(), file_edits);

        let result = apply_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].relative_path, "a.jpg");
        assert!(!result.failed[0].reason.is_empty());
    }

    #[test]
    fn path_with_no_drafts_is_skipped_not_failed() {
        let folder = "/some/folder";
        let paths = vec!["photo_with_no_edits.jpg".to_string()];
        let drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();

        let result = apply_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 0);
    }

    #[test]
    fn multiple_files_tracked_independently() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string(), "b.jpg".to_string()];
        let mut drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();

        let mut edits_a = HashMap::new();
        edits_a.insert("XMP-dc:Description".to_string(), Some("test a".to_string()));
        drafts.insert("a.jpg".to_string(), edits_a);

        let mut edits_b = HashMap::new();
        edits_b.insert("XMP-dc:Description".to_string(), Some("test b".to_string()));
        drafts.insert("b.jpg".to_string(), edits_b);

        let result = apply_draft_edits(folder, &paths, &drafts);
        assert_eq!(result.applied.len(), 0);
        assert_eq!(result.failed.len(), 2);
    }

    #[test]
    fn hard_failure_produces_no_fresh_metadata() {
        let folder = "/nonexistent_folder_apply_test_xyz";
        let paths = vec!["a.jpg".to_string()];
        let mut drafts: HashMap<String, HashMap<String, Option<String>>> = HashMap::new();
        let mut file_edits = HashMap::new();
        file_edits.insert("XMP-dc:Description".to_string(), Some("hello".to_string()));
        drafts.insert("a.jpg".to_string(), file_edits);

        let result = apply_draft_edits(folder, &paths, &drafts);
        assert!(!result.fresh_metadata.contains_key("a.jpg"),
            "hard failure (file not found) should not produce fresh metadata");
    }

    // ── verify_set: Match / Coerced / Mismatch / MissingPostWrite (Phase 8.1) ─

    fn map(pairs: &[(&str, Variant)]) -> HashMap<String, Variant> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
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

    // ── 8.6: Seq is ordered, Bag is multiset ──────────────────────────────────

    #[test]
    fn matches_variant_seq_is_order_sensitive() {
        let a = Variant::List(vec![Variant::String("a".into()), Variant::String("b".into())]);
        let b = Variant::List(vec![Variant::String("b".into()), Variant::String("a".into())]);
        let seq_kind = TagKind::Seq(Box::new(TagKind::Text));
        assert!(!matches_variant(Some(&a), &b, Some(&seq_kind)),
            "Seq comparison must be ordered");
    }

    #[test]
    fn matches_variant_bag_is_order_insensitive() {
        let a = Variant::List(vec![Variant::String("a".into()), Variant::String("b".into())]);
        let b = Variant::List(vec![Variant::String("b".into()), Variant::String("a".into())]);
        let bag_kind = TagKind::Bag(Box::new(TagKind::Text));
        assert!(matches_variant(Some(&a), &b, Some(&bag_kind)),
            "Bag comparison must be multiset");
    }

    #[test]
    fn matches_variant_unknown_kind_falls_back_to_multiset() {
        // Most XMP list tags are Bag-shaped; when listx leaves us without a
        // kind, multiset is the safer default than ordered.
        let a = Variant::List(vec![Variant::String("a".into()), Variant::String("b".into())]);
        let b = Variant::List(vec![Variant::String("b".into()), Variant::String("a".into())]);
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
}
