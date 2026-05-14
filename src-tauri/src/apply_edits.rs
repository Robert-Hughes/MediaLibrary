use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::scanner::{self, Variant};

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
/// `error` is `None` on full success, `Some` for any failure (hard or verification).
pub struct SingleFileOutcome {
    pub fresh_metadata: Option<HashMap<String, Variant>>,
    pub error: Option<String>,
}

impl SingleFileOutcome {
    fn hard_failure(reason: String) -> Self {
        Self { fresh_metadata: None, error: Some(reason) }
    }

    fn success(meta: HashMap<String, Variant>) -> Self {
        Self { fresh_metadata: Some(meta), error: None }
    }

    fn verification_failure(meta: HashMap<String, Variant>, reason: String) -> Self {
        Self { fresh_metadata: Some(meta), error: Some(reason) }
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

    let mut combined = crate::write_args::BuiltArgs::default();
    for (key, edit) in edits {
        let info = registry.and_then(|r| r.lookup(key));
        let args = crate::write_args::build_args(key, info, edit);
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

    // Verify each edit is reflected in either the display or the raw view.
    // Display is what users see; raw is what we sent with -n.  A match in
    // either is acceptable — the two views are just different presentations
    // of the same underlying tag.  A mismatch is a soft failure: we return
    // the fresh metadata so the UI can show the actual file state.
    use crate::draft_edits::EditIntent;
    for (key, edit) in edits {
        match edit.intent {
            EditIntent::Delete => {
                if let Some(v) = fresh_display.get(key) {
                    let v_str = match v {
                        Variant::String(s) => s.clone(),
                        Variant::Null => String::new(),
                        _ => format!("{:?}", v),
                    };
                    if !v_str.is_empty() {
                        let reason = format!(
                            "Verification failed for {}: expected tag removed, got {:?}",
                            key, v_str
                        );
                        return SingleFileOutcome::verification_failure(fresh_display, reason);
                    }
                }
            }
            EditIntent::Set | EditIntent::ListAdd | EditIntent::ListRemove => {
                let expected = match &edit.value {
                    Some(v) => v,
                    None => continue, // Set with None — odd but treat as delete; skip verify
                };
                let display_match = matches_variant(fresh_display.get(key), expected);
                let raw_match = matches_variant(fresh_raw.get(key), expected);
                // For ListAdd / ListRemove, the post-write list contains
                // changes-applied-to-existing; equality with `expected` (the
                // items added/removed) is too strict.  Best-effort: at least
                // require the changed items to be present (Add) or absent
                // (Remove) in the fresh list.  Full diff semantics land with
                // the editor that emits these intents.
                let intent_ok = match edit.intent {
                    EditIntent::ListAdd => list_contains_all(fresh_display.get(key), expected),
                    EditIntent::ListRemove => list_contains_none(fresh_display.get(key), expected),
                    _ => false,
                };
                if !display_match && !raw_match && !intent_ok {
                    let actual = describe(fresh_display.get(key), fresh_raw.get(key));
                    let reason = format!(
                        "Verification failed for {}: expected {:?}, got {}",
                        key, expected, actual
                    );
                    return SingleFileOutcome::verification_failure(fresh_display, reason);
                }
            }
        }
    }

    SingleFileOutcome::success(fresh_display)
}

/// Type-aware Variant equality with `Bag`-style multiset comparison for lists.
fn matches_variant(actual: Option<&Variant>, expected: &Variant) -> bool {
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
            // Multiset equality: same items, ignore order.  Seq vs Bag is a
            // Phase 5 refinement; for now exact ordered comparison is
            // probably what users want for both kinds, so try that first.
            if a == b {
                return true;
            }
            if a.len() != b.len() {
                return false;
            }
            let mut bb: Vec<&Variant> = b.iter().collect();
            for item in a {
                if let Some(pos) = bb.iter().position(|x| matches_variant(Some(*x), item)) {
                    bb.swap_remove(pos);
                } else {
                    return false;
                }
            }
            bb.is_empty()
        }
        (Variant::Object(a), Variant::Object(b)) => a == b,
        // Single scalar accepted against a one-element list (and vice versa).
        // exiftool naturally promotes a scalar into a Bag when the tag is a
        // list type — the verifier should treat that promotion as a match.
        (Variant::List(items), other) if items.len() == 1 => matches_variant(Some(&items[0]), other),
        (other, Variant::List(items)) if items.len() == 1 => matches_variant(Some(other), &items[0]),
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
    items_expected.iter().all(|e| items_actual.iter().any(|a| matches_variant(Some(a), e)))
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
    items_expected.iter().all(|e| !items_actual.iter().any(|a| matches_variant(Some(a), e)))
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
            // Float compare with a small epsilon if expected parses as float.
            // ε of 1e-6 is conservative for the precision exiftool round-trips
            // through its rational forms (e.g. ExposureTime, GPS).
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
            // Pre-Phase-3b: drafts come in as legacy comma-joined strings.
            // Accept either join form for compatibility.
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
        // After exiftool round-trip, an editor sending "6" for Orientation
        // sees fresh raw=Integer(6); legacy draft layer carries strings.
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
        // Pre-Phase-3b: drafts are still legacy CSV strings.  A list result
        // should compare equal to its comma-joined form.
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
        // Both fail (folder doesn't exist) but independently
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
}
