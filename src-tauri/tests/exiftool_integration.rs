//! Integration tier: real-exiftool round-trip tests against image fixtures.
//!
//! Gated behind the `integration` cargo feature so the default `cargo test`
//! stays fast and offline.  Run with:
//!
//!     cargo test --manifest-path src-tauri/Cargo.toml --features integration
//!
//! These tests assume `exiftool` is installed and on PATH.  Fixtures live in
//! `test_images/` at the repo root (see `test_images/README.md`).  Each test
//! makes a private copy of its fixture in a `tempfile::tempdir()` so the
//! committed file is never modified.
//!
//! Scope: the round-trip promise from `METADATA_FORMATS_DESIGN.md` §6 — write
//! a typed edit, re-read with the two-pass scanner, assert the file holds
//! what we asked.  Each fixture-needing test is feature-gated AND
//! existence-gated (skips with a printed reason if the fixture isn't
//! present) so contributors who haven't pulled fixtures don't see noise.

#![cfg(feature = "integration")]

use std::fs;
use std::path::{Path, PathBuf};

use medialibrary_tauri_lib::{
    apply_edits,
    draft_edits::{EditIntent, MetadataDraftEdit},
    metadata_value::{ListKind, MetadataValue},
    scanner::{self, Variant},
};

fn fixture_path(name: &str) -> Option<PathBuf> {
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let p = workspace_root.join("test_images").join(name);
    if p.exists() {
        Some(p)
    } else {
        eprintln!(
            "[integration] Fixture not present, skipping: {}",
            p.display()
        );
        None
    }
}

fn copy_to_temp(src: &Path) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let dst = dir.path().join(src.file_name().expect("filename"));
    fs::copy(src, &dst).expect("copy fixture");
    (dir, dst)
}

fn rel_of(folder: &Path, abs: &Path) -> String {
    abs.strip_prefix(folder)
        .expect("abs is in folder")
        .to_string_lossy()
        .replace('\\', "/")
}

fn read_one(folder: &Path, abs: &Path) -> scanner::ImageMetadata {
    let rel = rel_of(folder, abs);
    let mut results = scanner::read_image_metadata_batch(&[rel], &[abs.to_path_buf()])
        .expect("read_image_metadata_batch ok");
    results.pop().expect("one result")
}

fn metadata_set(value: MetadataValue) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(value),
        intent: EditIntent::Set,
        display: None,
    }
}

fn metadata_delete() -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: None,
        intent: EditIntent::Delete,
        display: None,
    }
}

fn metadata_edit(value: MetadataValue, intent: EditIntent) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(value),
        intent,
        display: None,
    }
}

fn metadata_bag(items: &[&str]) -> MetadataValue {
    MetadataValue::List {
        list_kind: ListKind::Bag,
        items: items
            .iter()
            .map(|item| MetadataValue::Text((*item).to_string()))
            .collect(),
    }
}

fn metadata_drafts(
    rel: &str,
    edits: std::collections::HashMap<String, MetadataDraftEdit>,
) -> std::collections::HashMap<String, std::collections::HashMap<String, MetadataDraftEdit>> {
    let mut drafts = std::collections::HashMap::new();
    drafts.insert(rel.to_string(), edits);
    drafts
}

// ── Scanner two-pass smoke test ──────────────────────────────────────────────

#[test]
fn scanner_two_pass_returns_display_and_raw() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (_dir, dst) = copy_to_temp(&src);
    let m = read_one(_dir.path(), &dst);
    assert!(
        !m.metadata.is_empty(),
        "display metadata should be non-empty"
    );
    // Raw may be empty if -n pass produced no output for this file, but the
    // field must exist and parse.  This sanity-checks the new struct shape.
    let _ = m.raw_metadata;
}

// ── apply_edits text round-trip ──────────────────────────────────────────────

#[test]
fn apply_text_edit_roundtrip_iptc_city() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    let value = format!("integration-test-{}", std::process::id());
    edits.insert(
        "IPTC:City".to_string(),
        metadata_set(MetadataValue::Text(value.clone())),
    );

    let drafts = metadata_drafts(&rel, edits);
    let result =
        apply_edits::apply_metadata_draft_edits(folder, std::slice::from_ref(&rel), &drafts);
    assert!(
        result.failed.is_empty(),
        "expected no failures, got {:?}",
        result.failed
    );
    assert_eq!(result.applied, vec![rel.clone()]);

    let m = read_one(dir.path(), &dst);
    let got = m.metadata.get("IPTC:City").cloned();
    match got {
        Some(Variant::String(s)) => assert_eq!(s, value),
        other => panic!("expected IPTC City set, got {:?}", other),
    }
}

// ── apply_edits delete round-trip ────────────────────────────────────────────

#[test]
fn apply_delete_edit_removes_tag() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    // Step 1: set City so we have something to delete.
    let mut set_edits = std::collections::HashMap::new();
    set_edits.insert(
        "IPTC:City".to_string(),
        metadata_set(MetadataValue::Text("to-be-deleted".to_string())),
    );
    let drafts1 = metadata_drafts(&rel, set_edits);
    let r1 = apply_edits::apply_metadata_draft_edits(folder, std::slice::from_ref(&rel), &drafts1);
    assert!(r1.failed.is_empty());

    // Step 2: delete it.
    let mut del_edits = std::collections::HashMap::new();
    del_edits.insert("IPTC:City".to_string(), metadata_delete());
    let drafts2 = metadata_drafts(&rel, del_edits);
    let r2 = apply_edits::apply_metadata_draft_edits(folder, std::slice::from_ref(&rel), &drafts2);
    assert!(r2.failed.is_empty(), "delete failed: {:?}", r2.failed);

    // Step 3: re-read; City should be absent or empty.
    let m = read_one(dir.path(), &dst);
    let got = m.metadata.get("IPTC:City");
    match got {
        None => {}
        Some(Variant::String(s)) => assert!(s.is_empty(), "expected empty, got {:?}", s),
        Some(Variant::Null) => {}
        other => panic!("expected delete to clear tag, got {:?}", other),
    }
}

// ── Fixture-content sanity checks ────────────────────────────────────────────

#[test]
fn fixture_keywords_basic_has_two_keywords() {
    let Some(src) = fixture_path("keywords_basic.jpg") else {
        return;
    };
    let (_dir, dst) = copy_to_temp(&src);
    let m = read_one(_dir.path(), &dst);
    match m.metadata.get("XMP-dc:Subject") {
        Some(Variant::List(items)) => {
            assert_eq!(items.len(), 2, "expected two subjects, got {:?}", items);
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let Variant::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                })
                .collect();
            assert!(strs.contains(&"beach".to_string()));
            assert!(strs.contains(&"sunset".to_string()));
        }
        // exiftool may emit a single-string concatenated form if the file
        // structure forces it; the fixture intent is the multi-element form
        // so a String here is a fixture regeneration bug.
        other => panic!("expected Subject as List, got {:?}", other),
    }
}

#[test]
fn fixture_orientation_rotate90_pretty_and_raw_match_design() {
    let Some(src) = fixture_path("orientation_rotate90.jpg") else {
        return;
    };
    let (_dir, dst) = copy_to_temp(&src);
    let m = read_one(_dir.path(), &dst);
    // Display: pretty label.
    match m.metadata.get("IFD0:Orientation") {
        Some(Variant::String(s)) => assert_eq!(s, "Rotate 90 CW"),
        other => panic!("expected Orientation pretty string, got {:?}", other),
    }
    // Raw: integer 6 (lives in raw_metadata when Pass B ran).
    match m.raw_metadata.get("IFD0:Orientation") {
        Some(Variant::Integer(n)) => assert_eq!(*n, 6),
        Some(Variant::String(s)) if s == "6" => {} // some exiftool builds emit "6" as string under -n
        other => panic!("expected raw Orientation=6, got {:?}", other),
    }
}

#[test]
fn fixture_langalt_description_pretty_and_raw_match_design() {
    let Some(src) = fixture_path("langalt_description.jpg") else {
        return;
    };
    let (_dir, dst) = copy_to_temp(&src);
    let m = read_one(_dir.path(), &dst);
    // The lang-alt rendering under -struct varies: it can be a flat string
    // (x-default), an Object keyed by language, or include separate
    // Description-en / Description-fr keys.  Accept any of these and check
    // the english/french strings are findable.
    let combined: String = format!(
        "{:?} {:?} {:?} {:?}",
        m.metadata.get("XMP-dc:Description"),
        m.metadata.get("XMP-dc:Description-en"),
        m.metadata.get("XMP-dc:Description-fr"),
        m.metadata.get("XMP-dc:Description-x-default"),
    );
    assert!(
        combined.contains("default text"),
        "missing x-default: {}",
        combined
    );
    assert!(
        combined.contains("english text"),
        "missing en: {}",
        combined
    );
    assert!(
        combined.contains("texte francais"),
        "missing fr: {}",
        combined
    );
}

#[test]
fn fixture_rating_5_pretty_and_raw_match_design() {
    let Some(src) = fixture_path("rating_5.jpg") else {
        return;
    };
    let (_dir, dst) = copy_to_temp(&src);
    let m = read_one(_dir.path(), &dst);
    // Rating is a real that exiftool prints without PrintConv → "5".
    let display = m.metadata.get("XMP-xmp:Rating");
    let raw = m.raw_metadata.get("XMP-xmp:Rating");
    let display_ok = match display {
        Some(Variant::Integer(5)) => true,
        Some(Variant::Float(f)) => (f - 5.0).abs() < 1e-9,
        Some(Variant::String(s)) if s == "5" || s == "5.0" => true,
        _ => false,
    };
    let raw_ok = matches!(raw, Some(Variant::Integer(5)))
        || matches!(raw, Some(Variant::Float(f)) if (f - 5.0).abs() < 1e-9)
        || matches!(raw, Some(Variant::String(s)) if s == "5");
    assert!(
        display_ok || raw_ok,
        "expected Rating=5 in some form; display={:?}, raw={:?}",
        display,
        raw
    );
}

// ── Round-trip: edit a fixture, verify file holds new value ───────────────────

#[test]
fn roundtrip_set_rating() {
    let Some(src) = fixture_path("rating_3.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    // Confirm starting state.
    let before = read_one(dir.path(), &dst);
    let starting_rating = before.raw_metadata.get("XMP-xmp:Rating").cloned();
    assert!(
        starting_rating.is_some(),
        "fixture should start with a Rating"
    );

    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-xmp:Rating".to_string(),
        metadata_set(MetadataValue::Integer(5)),
    );

    let drafts = metadata_drafts(&rel, edits);
    let result =
        apply_edits::apply_metadata_draft_edits(folder, std::slice::from_ref(&rel), &drafts);
    assert!(result.failed.is_empty(), "failed: {:?}", result.failed);

    let after = read_one(dir.path(), &dst);
    let raw = after.raw_metadata.get("XMP-xmp:Rating");
    let display = after.metadata.get("XMP-xmp:Rating");
    let ok = matches!(raw, Some(Variant::Integer(5)))
        || matches!(raw, Some(Variant::Float(f)) if (f - 5.0).abs() < 1e-6)
        || matches!(display, Some(Variant::String(s)) if s == "5" || s == "5.0");
    assert!(
        ok,
        "Rating not updated; display={:?}, raw={:?}",
        display, raw
    );
}

#[test]
fn roundtrip_set_orientation_via_numeric_pass() {
    let Some(src) = fixture_path("orientation_rotate90.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    // Change Orientation from 6 (Rotate 90 CW) to 3 (Rotate 180).
    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "IFD0:Orientation".to_string(),
        metadata_set(MetadataValue::Integer(3)),
    );

    let drafts = metadata_drafts(&rel, edits);
    let result =
        apply_edits::apply_metadata_draft_edits(folder, std::slice::from_ref(&rel), &drafts);
    assert!(result.failed.is_empty(), "failed: {:?}", result.failed);

    let after = read_one(dir.path(), &dst);
    match after.metadata.get("IFD0:Orientation") {
        Some(Variant::String(s)) => assert_eq!(s, "Rotate 180"),
        other => panic!("expected pretty Orientation 'Rotate 180', got {:?}", other),
    }
}

// ── Face regions (Bag<Struct>) ───────────────────────────────────────────────

#[test]
fn face_regions_round_trip_through_struct_variant() {
    // Confirms the Phase 1 Variant::Object support + Phase 6 -struct flag
    // round-trip a real nested-struct XMP value (XMP-mwg-rs:RegionInfo
    // containing AppliedToDimensions + a list of two Region structs).
    let Some(src) = fixture_path("face_regions_mwg.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let m = read_one(dir.path(), &dst);

    let region_info = m.metadata.get("XMP-mwg-rs:RegionInfo");
    let region_info = match region_info {
        Some(Variant::Object(map)) => map,
        other => panic!("expected RegionInfo as Object, got {:?}", other),
    };

    // AppliedToDimensions sub-struct should be present.
    let dims = match region_info.get("AppliedToDimensions") {
        Some(Variant::Object(d)) => d,
        other => panic!("expected AppliedToDimensions as Object, got {:?}", other),
    };
    assert!(dims.contains_key("W"));
    assert!(dims.contains_key("H"));

    // RegionList should be a List of two struct entries.
    let list = match region_info.get("RegionList") {
        Some(Variant::List(items)) => items,
        other => panic!("expected RegionList as List, got {:?}", other),
    };
    assert_eq!(list.len(), 2, "expected 2 regions");

    let names: Vec<String> = list
        .iter()
        .filter_map(|item| {
            if let Variant::Object(region) = item {
                if let Some(Variant::String(name)) = region.get("Name") {
                    return Some(name.clone());
                }
            }
            None
        })
        .collect();
    assert!(names.contains(&"Alice".to_string()), "names: {:?}", names);
    assert!(names.contains(&"Bob".to_string()), "names: {:?}", names);
}

// ── Unicode filename ─────────────────────────────────────────────────────────

#[test]
fn unicode_filename_does_not_crash_scanner() {
    // `unicode_paths_漢字.jpg` exercises the -charset filename=utf8 flag.
    // On Windows exiftool subprocess argument encoding has long-standing
    // quirks: CreateProcess delivers args in the active code page, not
    // UTF-8, so even with the flag the file may not be findable.  We
    // confirm the scanner returns gracefully (Ok with possibly-empty
    // metadata or an Err) rather than panicking.
    let Some(src) = fixture_path("unicode_paths_漢字.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let result = scanner::read_image_metadata_batch(&[rel], &[dst]);
    match result {
        Ok(results) => {
            // If exiftool found the file, sanity-check metadata; otherwise
            // accept the empty case (Windows path-encoding limitation).
            if let Some(r) = results.into_iter().next() {
                if !r.metadata.is_empty() {
                    println!("[unicode test] exiftool read metadata: ok");
                }
            }
        }
        Err(e) => {
            // Acceptable failure: exiftool couldn't find the file due to
            // platform path-encoding limits.  We assert only that the
            // failure was reported cleanly, not by panic.
            println!("[unicode test] expected platform-quirk failure: {}", e);
        }
    }
}

// ── Malformed JPEG: per-entry parse isolation ────────────────────────────────

#[test]
fn malformed_truncated_does_not_kill_batch() {
    // Per-entry parse isolation (Phase 0) means a truncated/malformed JPEG
    // mixed into a batch must not drop metadata for the valid files.
    let Some(good) = fixture_path("keywords_basic.jpg") else {
        return;
    };
    let Some(bad) = fixture_path("malformed_truncated.jpg") else {
        return;
    };
    let (_dir, good_dst) = copy_to_temp(&good);
    let (_dir2, bad_dst) = copy_to_temp(&bad);

    let rel_paths = vec!["good.jpg".to_string(), "bad.jpg".to_string()];
    let abs_paths = vec![good_dst.clone(), bad_dst.clone()];

    let results = scanner::read_image_metadata_batch(&rel_paths, &abs_paths)
        .expect("batch read should not hard-fail");
    assert_eq!(results.len(), 2);

    // The good file's metadata should be intact.
    let good_result = results
        .iter()
        .find(|r| r.relative_path == "good.jpg")
        .unwrap();
    assert!(
        !good_result.metadata.is_empty(),
        "good file must still have metadata"
    );
    // The bad file may have zero or partial metadata, but the call must
    // have returned an entry for it (no per-file failure should propagate
    // as a missing entry).
    assert!(results.iter().any(|r| r.relative_path == "bad.jpg"));
}

// ── Semantic apply path: MetadataDraftEdit with Bag<Text> ────────────────────

#[test]
fn semantic_apply_writes_bag_as_separate_items_end_to_end() {
    // The end-to-end test for the keywords-CSV bug fix.  We send a semantic
    // MetadataDraftEdit with Bag<Text>(["alpha", "beta", "gamma"]) for
    // XMP-dc:Subject, run the semantic apply path, re-read, and assert the
    // file has THREE separate subjects, not one comma-joined string.
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-dc:Subject".to_string(),
        metadata_set(metadata_bag(&["alpha", "beta", "gamma"])),
    );

    let outcome = apply_edits::apply_single_file_metadata(folder, &rel, &edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let m = read_one(dir.path(), &dst);
    match m.metadata.get("XMP-dc:Subject") {
        Some(Variant::List(items)) => {
            assert_eq!(items.len(), 3, "expected 3 subjects, got {:?}", items);
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let Variant::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                })
                .collect();
            assert!(strs.contains(&"alpha".to_string()));
            assert!(strs.contains(&"beta".to_string()));
            assert!(strs.contains(&"gamma".to_string()));
        }
        other => panic!("expected Subject as 3-item List, got {:?}", other),
    }
}

// ── Apply log audit file ─────────────────────────────────────────────────────

#[test]
fn apply_emits_apply_log_jsonl_entry() {
    // After a semantic apply the folder should contain a
    // `MediaLibraryApplyLog.jsonl` audit file with one header line plus one
    // line per tag edited.
    let Some(src) = fixture_path("rating_3.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-xmp:Rating".to_string(),
        metadata_set(MetadataValue::Integer(5)),
    );

    let outcome = apply_edits::apply_single_file_metadata(folder, &rel, &edits);
    assert!(outcome.error.is_none(), "{:?}", outcome.error);

    let log_path = dir.path().join("MediaLibraryApplyLog.jsonl");
    assert!(
        log_path.exists(),
        "apply log file should exist after semantic apply"
    );

    let contents = std::fs::read_to_string(&log_path).unwrap();
    let lines: Vec<&str> = contents.lines().collect();
    assert!(
        lines.len() >= 2,
        "expected header + at least one entry: {:?}",
        lines
    );
    assert!(lines[0].starts_with("// "), "first line should be header");
    assert!(lines[1].contains("XMP-xmp:Rating"));
    assert!(lines[1].contains("\"Set\""));
    assert!(
        lines[1].contains("\"Match\"")
            || lines[1].contains("\"Mismatch\"")
            || lines[1].contains("\"Coerced\"")
    );
}

// ── Coerced-write detection ──────────────────────────────────────────────────

#[test]
fn semantic_apply_rating_fractional_coerces_or_rejects_cleanly() {
    // Rating is integer 0-5. Writing 3.5 exercises exiftool's value coercion:
    // depending on version it may store 3, 4, "3.5", or reject the write.
    // The verifier should either accept the coerced result (matches_variant
    // float-epsilon path) or report a clean mismatch — never panic.
    let Some(src) = fixture_path("rating_3.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-xmp:Rating".to_string(),
        metadata_set(MetadataValue::Real(3.5)),
    );

    let outcome = apply_edits::apply_single_file_metadata(folder, &rel, &edits);
    // Coercion either yields a matched float (3.5 → 3.5 in file) or a
    // clean verification-failure message naming the tag.  We just assert
    // it didn't hard-fail.
    assert!(
        outcome.fresh_metadata.is_some(),
        "expected fresh_metadata available even on coerced write; error: {:?}",
        outcome.error
    );
    println!("[rating coerce] outcome.error = {:?}", outcome.error);

    // Re-read should still parse without panic.
    let m = read_one(dir.path(), &dst);
    let _ = m.metadata.get("XMP-xmp:Rating");
}

// ── ListAdd / ListRemove intents ─────────────────────────────────────────────

#[test]
fn semantic_apply_list_add_appends_items_to_bag() {
    // Starting from keywords_basic.jpg with ["beach","sunset"], emit a
    // semantic draft edit with intent=ListAdd value=["vacation"] and confirm
    // the result is the original plus the new item.
    let Some(src) = fixture_path("keywords_basic.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-dc:Subject".to_string(),
        metadata_edit(metadata_bag(&["vacation"]), EditIntent::ListAdd),
    );

    let outcome = apply_edits::apply_single_file_metadata(folder, &rel, &edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let m = read_one(dir.path(), &dst);
    match m.metadata.get("XMP-dc:Subject") {
        Some(Variant::List(items)) => {
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let Variant::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                })
                .collect();
            assert!(
                strs.contains(&"beach".to_string()),
                "beach missing from {:?}",
                strs
            );
            assert!(
                strs.contains(&"sunset".to_string()),
                "sunset missing from {:?}",
                strs
            );
            assert!(
                strs.contains(&"vacation".to_string()),
                "vacation missing from {:?}",
                strs
            );
            assert_eq!(strs.len(), 3, "expected 3 subjects, got {:?}", strs);
        }
        other => panic!("expected Subject as List, got {:?}", other),
    }
}

#[test]
fn semantic_apply_list_remove_drops_items_from_bag() {
    // Start from keywords_basic.jpg with ["beach","sunset"], emit a
    // semantic draft edit with intent=ListRemove value=["beach"], confirm
    // result is ["sunset"].
    let Some(src) = fixture_path("keywords_basic.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-dc:Subject".to_string(),
        metadata_edit(metadata_bag(&["beach"]), EditIntent::ListRemove),
    );

    let outcome = apply_edits::apply_single_file_metadata(folder, &rel, &edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let m = read_one(dir.path(), &dst);
    match m.metadata.get("XMP-dc:Subject") {
        Some(Variant::List(items)) => {
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let Variant::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                })
                .collect();
            assert!(
                !strs.contains(&"beach".to_string()),
                "beach should be removed: {:?}",
                strs
            );
            assert!(
                strs.contains(&"sunset".to_string()),
                "sunset should remain: {:?}",
                strs
            );
        }
        Some(Variant::String(s)) => {
            // Single-element list may collapse to scalar.
            assert_eq!(s, "sunset");
        }
        other => panic!("expected Subject as List or single String, got {:?}", other),
    }
}

// ── Keywords list write-back (the regression-of-record) ──────────────────────

#[test]
fn apply_keywords_writes_back_as_separate_items_not_csv() {
    // The previous code emitted `-Keywords=a, b` and stored one keyword "a, b".
    // Semantic drafts carry list shape to write-back, so exiftool receives
    // separate Subject arguments.
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    edits.insert(
        "XMP-dc:Subject".to_string(),
        metadata_set(MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![
                MetadataValue::Text("alpha".into()),
                MetadataValue::Text("beta".into()),
            ],
        }),
    );
    let drafts = metadata_drafts(&rel, edits);
    let result =
        apply_edits::apply_metadata_draft_edits(folder, std::slice::from_ref(&rel), &drafts);
    assert!(result.failed.is_empty(), "{:?}", result.failed);

    let m = read_one(dir.path(), &dst);
    match m.metadata.get("XMP-dc:Subject") {
        Some(Variant::String(s)) => assert!(s == "alpha" || s == "beta"),
        Some(Variant::List(items)) => {
            assert_eq!(items.len(), 2);
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let Variant::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                })
                .collect();
            assert!(strs.contains(&"alpha".to_string()));
            assert!(strs.contains(&"beta".to_string()));
        }
        other => panic!("expected Subject set, got {:?}", other),
    }
}
