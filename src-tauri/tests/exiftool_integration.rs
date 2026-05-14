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
    scanner::{self, Variant},
};

fn fixture_path(name: &str) -> Option<PathBuf> {
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let p = workspace_root.join("test_images").join(name);
    if p.exists() {
        Some(p)
    } else {
        eprintln!("[integration] Fixture not present, skipping: {}", p.display());
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
    let mut results = scanner::read_image_metadata_batch(
        &[rel],
        &[abs.to_path_buf()],
    )
    .expect("read_image_metadata_batch ok");
    results.pop().expect("one result")
}

// ── Scanner two-pass smoke test ──────────────────────────────────────────────

#[test]
fn scanner_two_pass_returns_display_and_raw() {
    let Some(src) = fixture_path("real_with_exif.jpg") else { return };
    let (_dir, dst) = copy_to_temp(&src);
    let m = read_one(_dir.path(), &dst);
    assert!(!m.metadata.is_empty(), "display metadata should be non-empty");
    // Raw may be empty if -n pass produced no output for this file, but the
    // field must exist and parse.  This sanity-checks the new struct shape.
    let _ = m.raw_metadata;
}

// ── apply_edits text round-trip ──────────────────────────────────────────────

#[test]
fn apply_text_edit_roundtrip_xmp_description() {
    let Some(src) = fixture_path("real_with_exif.jpg") else { return };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    let value = format!("integration-test-{}", std::process::id());
    edits.insert("XMP-dc:Description".to_string(), Some(value.clone()));

    let mut drafts = std::collections::HashMap::new();
    drafts.insert(rel.clone(), edits);

    let result = apply_edits::apply_draft_edits(folder, &[rel.clone()], &drafts);
    assert!(result.failed.is_empty(), "expected no failures, got {:?}", result.failed);
    assert_eq!(result.applied, vec![rel.clone()]);

    let m = read_one(dir.path(), &dst);
    // Description is lang-alt; pretty form is the x-default string.
    let got = m.metadata.get("XMP-dc:Description").cloned();
    match got {
        Some(Variant::String(s)) => assert_eq!(s, value),
        Some(Variant::Object(langs)) => {
            // exiftool's `-struct` plus lang-alt can deliver an object map.
            let xdefault = langs
                .get("x-default")
                .or_else(|| langs.values().next())
                .cloned();
            match xdefault {
                Some(Variant::String(s)) => assert_eq!(s, value),
                other => panic!("expected lang-alt x-default string, got {:?}", other),
            }
        }
        other => panic!("expected Description set, got {:?}", other),
    }
}

// ── apply_edits delete round-trip ────────────────────────────────────────────

#[test]
fn apply_delete_edit_removes_tag() {
    let Some(src) = fixture_path("real_with_exif.jpg") else { return };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    // Step 1: set Description so we have something to delete.
    let mut set_edits = std::collections::HashMap::new();
    set_edits.insert("XMP-dc:Description".to_string(), Some("to-be-deleted".to_string()));
    let mut drafts1 = std::collections::HashMap::new();
    drafts1.insert(rel.clone(), set_edits);
    let r1 = apply_edits::apply_draft_edits(folder, &[rel.clone()], &drafts1);
    assert!(r1.failed.is_empty());

    // Step 2: delete it.
    let mut del_edits = std::collections::HashMap::new();
    del_edits.insert("XMP-dc:Description".to_string(), None);
    let mut drafts2 = std::collections::HashMap::new();
    drafts2.insert(rel.clone(), del_edits);
    let r2 = apply_edits::apply_draft_edits(folder, &[rel.clone()], &drafts2);
    assert!(r2.failed.is_empty(), "delete failed: {:?}", r2.failed);

    // Step 3: re-read; Description should be absent or empty.
    let m = read_one(dir.path(), &dst);
    let got = m.metadata.get("XMP-dc:Description");
    match got {
        None => {}
        Some(Variant::String(s)) => assert!(s.is_empty(), "expected empty, got {:?}", s),
        Some(Variant::Null) => {}
        other => panic!("expected delete to clear tag, got {:?}", other),
    }
}

// ── Keywords list write-back (the regression-of-record) ──────────────────────

#[test]
fn apply_keywords_writes_back_as_separate_items_not_csv() {
    // The previous code emitted `-Keywords=a, b` and stored one keyword "a, b".
    // After Phase 5, drafts come in as legacy CSV strings but write_args
    // handles plain XMP-dc:Subject as text (since legacy carries no list
    // shape).  This test will gain teeth in Phase 3b when the frontend
    // carries Variant::List values through to write-back.
    let Some(src) = fixture_path("real_with_exif.jpg") else { return };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let mut edits = std::collections::HashMap::new();
    // Legacy string draft — at this layer we can only express a single value.
    edits.insert("XMP-dc:Subject".to_string(), Some("just-one".to_string()));
    let mut drafts = std::collections::HashMap::new();
    drafts.insert(rel.clone(), edits);
    let result = apply_edits::apply_draft_edits(folder, &[rel.clone()], &drafts);
    assert!(result.failed.is_empty(), "{:?}", result.failed);

    let m = read_one(dir.path(), &dst);
    match m.metadata.get("XMP-dc:Subject") {
        Some(Variant::String(s)) => assert_eq!(s, "just-one"),
        Some(Variant::List(items)) => {
            assert_eq!(items.len(), 1);
            assert!(matches!(&items[0], Variant::String(s) if s == "just-one"));
        }
        other => panic!("expected Subject set, got {:?}", other),
    }
}
