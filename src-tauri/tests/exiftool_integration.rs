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

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use medialibrary_tauri_lib::{
    apply_edits,
    draft_edits::{EditIntent, MetadataDraftEdit, MetadataTargetDraftEntry, SchemaMetadataEdit},
    metadata_draft_target::MetadataDraftTarget,
    metadata_occurrence::{
        family7_group_from_schema_id, validate_family1_group, MetadataWriteTarget,
    },
    metadata_value::{
        DateTimeValue, DateValue, ListKind, MetadataValue, OffsetSign, TimeValue, UtcOffsetValue,
    },
    scanner,
    tag_schema::{get_registry, SchemaDefinitionId},
};

#[test]
fn writable_registry_groups_and_schema_family7_ids_fit_the_selector_grammar() {
    let registry = get_registry().expect("load the real ExifTool schema registry");
    let failures = registry
        .iter()
        .map(|(_, info)| info)
        .filter(|info| info.writable && info.kind.supports_metadata_write())
        .filter_map(|info| {
            let group7 = family7_group_from_schema_id(&info.id);
            let valid_group7 = group7.starts_with("ID-")
                && group7.len() > 3
                && group7.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                });
            (validate_family1_group(&info.group).is_err() || !valid_group7)
                .then(|| format!("{:?} -> group1={:?} group7={group7:?}", info.id, info.group))
        })
        .collect::<Vec<_>>();

    assert!(
        failures.is_empty(),
        "writable registry entries outside the selector grammar:\n{}",
        failures.join("\n")
    );
}
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

fn read_one(folder: &Path, abs: &Path) -> scanner::FileMetadata {
    let rel = rel_of(folder, abs);
    let outcome = scanner::read_file_metadata_batch(&[rel], &[abs.to_path_buf()])
        .expect("read_file_metadata_batch ok");
    if !outcome.failures.is_empty() {
        panic!("read_one failed: {}", outcome.failures[0].error_message);
    }
    outcome.results.into_iter().next().expect("one result")
}

fn schema_value(image: &scanner::FileMetadata, id: &SchemaDefinitionId) -> Option<MetadataValue> {
    let values = image
        .occurrences
        .for_schema(id)
        .map(|occurrence| &occurrence.value)
        .collect::<Vec<_>>();
    let first = values.first().copied()?;

    values
        .iter()
        .all(|value| *value == first)
        .then(|| first.clone())
}
fn metadata_set(value: MetadataValue) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(value),
        intent: EditIntent::Set,
    }
}

fn metadata_delete() -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: None,
        intent: EditIntent::Delete,
    }
}

fn metadata_edit(value: MetadataValue, intent: EditIntent) -> MetadataDraftEdit {
    MetadataDraftEdit {
        value: Some(value),
        intent,
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

fn target_entries(
    folder: &Path,
    rel: &str,
    edits: Vec<SchemaMetadataEdit>,
) -> Vec<MetadataTargetDraftEntry> {
    let image = read_one(folder, &folder.join(rel));
    edits
        .into_iter()
        .map(|entry| {
            let matches: Vec<_> = image
                .occurrences
                .iter()
                .filter(|occurrence| {
                    occurrence
                        .tag_info
                        .as_ref()
                        .is_some_and(|info| info.id == entry.schema_id)
                })
                .collect();
            let target = if matches.is_empty() {
                let info = medialibrary_tauri_lib::tag_schema::get_registry()
                    .expect("registry")
                    .lookup(&entry.schema_id)
                    .expect("exact integration schema");
                MetadataDraftTarget::from_new_property(info).expect("writable integration schema")
            } else {
                let writable: Vec<_> = matches
                    .iter()
                    .copied()
                    .filter(|occurrence| occurrence.write_target.is_some())
                    .collect();
                let candidates = writable;
                let [occurrence] = candidates.as_slice() else {
                    panic!(
                        "exact schema {:?} has {} occurrences but {} suitable writable targets",
                        entry.schema_id,
                        matches.len(),
                        candidates.len()
                    )
                };
                MetadataDraftTarget::ExistingOccurrence {
                    occurrence_id: occurrence.id.clone(),
                    schema_id: entry.schema_id,
                    write_target: occurrence.write_target.clone().unwrap(),
                }
            };
            MetadataTargetDraftEntry {
                target,
                edit: entry.edit,
            }
        })
        .collect()
}

fn apply_target_file(
    folder: &str,
    rel: &str,
    edits: Vec<SchemaMetadataEdit>,
) -> apply_edits::MetadataSingleFileOutcome {
    let entries = target_entries(Path::new(folder), rel, edits);
    apply_edits::apply_single_file_metadata(folder, rel, &entries)
}

#[derive(Debug)]
struct TargetBatchResult {
    applied: Vec<String>,
    failed: Vec<String>,
}

fn apply_target_batch(
    folder: &str,
    rel: &str,
    edits: Vec<SchemaMetadataEdit>,
) -> TargetBatchResult {
    let outcome = apply_target_file(folder, rel, edits);
    match outcome.error {
        Some(error) => TargetBatchResult {
            applied: Vec::new(),
            failed: vec![error],
        },
        None => TargetBatchResult {
            applied: vec![rel.to_string()],
            failed: Vec::new(),
        },
    }
}

// ── Scanner two-pass smoke test ──────────────────────────────────────────────

#[test]
fn scanner_two_pass_returns_authoritative_occurrences() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (_dir, dst) = copy_to_temp(&src);
    let metadata = read_one(_dir.path(), &dst);
    assert!(
        !metadata.occurrences.is_empty(),
        "authoritative occurrences should be non-empty"
    );
    let wire = serde_json::to_value(&metadata).expect("serialise FileMetadata");
    assert_eq!(wire.as_object().unwrap().len(), 2);
    assert!(wire.get("metadata").is_none());
}

#[test]
fn iptc_utf8_marker_apply_rewrites_and_verifies_existing_non_ascii_values() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);

    let clear = Command::new("exiftool")
        .args(["-overwrite_original", "-IPTC:all="])
        .arg(&dst)
        .output()
        .expect("run ExifTool to clear IPTC");
    assert!(
        clear.status.success(),
        "clear ExifTool failed: {}",
        String::from_utf8_lossy(&clear.stderr)
    );
    let rel = rel_of(dir.path(), &dst);
    let seed = apply_target_file(
        dir.path().to_str().unwrap(),
        &rel,
        vec![
            SchemaMetadataEdit {
                schema_id: medialibrary_tauri_lib::known_ids::iptc_coded_character_set(),
                edit: metadata_set(MetadataValue::Text("UTF8".to_string())),
            },
            SchemaMetadataEdit {
                schema_id: medialibrary_tauri_lib::known_ids::iptc_sub_location(),
                edit: metadata_set(MetadataValue::Text(
                    "Chūō Plazza, Momochihama 2".to_string(),
                )),
            },
        ],
    );
    assert!(seed.error.is_none(), "{:?}", seed.error);

    // Construct the troublesome state by removing only the declaration. The
    // scanner still has the semantic value in memory, while a later
    // marker-only write would not itself cause ExifTool to transcode that
    // untouched dataset.
    let remove_marker = Command::new("exiftool")
        .args(["-overwrite_original", "-IPTC:CodedCharacterSet="])
        .arg(&dst)
        .output()
        .expect("run ExifTool to remove IPTC marker");
    assert!(
        remove_marker.status.success(),
        "marker removal failed: {}",
        String::from_utf8_lossy(&remove_marker.stderr)
    );

    let before = read_one(dir.path(), &dst);
    let before_location = schema_value(
        &before,
        &medialibrary_tauri_lib::known_ids::iptc_sub_location(),
    )
    .expect("seeded IPTC location remains readable");
    assert!(
        matches!(&before_location, MetadataValue::Text(text) if !text.is_ascii()),
        "fixture state must exercise a non-ASCII derived rewrite: {before_location:?}"
    );
    assert_eq!(
        schema_value(
            &before,
            &medialibrary_tauri_lib::known_ids::iptc_coded_character_set()
        ),
        None
    );

    let outcome = apply_target_file(
        dir.path().to_str().unwrap(),
        &rel,
        vec![SchemaMetadataEdit {
            schema_id: medialibrary_tauri_lib::known_ids::iptc_coded_character_set(),
            edit: metadata_set(MetadataValue::Text("UTF8".to_string())),
        }],
    );
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.outcomes.len(), 1, "only the user draft reconciles");

    let after = read_one(dir.path(), &dst);
    assert!(
        matches!(
            schema_value(
                &after,
                &medialibrary_tauri_lib::known_ids::iptc_coded_character_set()
            ),
            Some(MetadataValue::Text(marker)) if marker == "UTF8" || marker == "\u{1b}%G"
        ),
        "UTF-8 marker must survive authoritative readback"
    );
    assert_eq!(
        schema_value(
            &after,
            &medialibrary_tauri_lib::known_ids::iptc_sub_location()
        ),
        Some(before_location),
        "the exact semantic value loaded before apply must be preserved"
    );
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

    let value = format!("integration-test-{}", std::process::id());
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: medialibrary_tauri_lib::known_ids::iptc_city(),
        edit: metadata_set(MetadataValue::Text(value.clone())),
    }];

    let result = apply_target_batch(folder, &rel, edits);
    assert!(
        result.failed.is_empty(),
        "expected no failures, got {:?}",
        result.failed
    );
    assert_eq!(result.applied, vec![rel.clone()]);

    let m = read_one(dir.path(), &dst);
    let got = schema_value(&m, &medialibrary_tauri_lib::known_ids::iptc_city());
    match got {
        Some(MetadataValue::Text(s)) => assert_eq!(s, value),
        other => panic!("expected IPTC City set, got {:?}", other),
    }
}

#[test]
fn apply_xmp_mlib_ai_description_preserves_utf8() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: medialibrary_tauri_lib::known_ids::mlib_ai_description(),
        edit: metadata_set(MetadataValue::Text("A café scene".to_string())),
    }];

    let outcome = apply_target_file(folder, &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let m = read_one(dir.path(), &dst);
    match schema_value(
        &m,
        &medialibrary_tauri_lib::known_ids::mlib_ai_description(),
    ) {
        Some(MetadataValue::Text(s)) => assert!(
            s.contains('é'),
            "expected semantic readback to preserve é, got {:?}",
            s
        ),
        other => panic!("expected XMP-mlib:AIDescription text, got {:?}", other),
    }
}

#[test]
fn apply_raw_reverse_geocode_evidence_roundtrips_verbatim() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);
    let geocode_json = r#"{"features":[{"properties":{"geocoding":{"name":"Student Recruitment, Marketing, and Admissions"}}}]}"#;
    let json_v2 = r#"{"display_name":"Minato, Tokyo","note":"backslash: \\ and café"}"#;
    let edits = vec![
        medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
            schema_id: medialibrary_tauri_lib::known_ids::mlib_reverse_geocode_geocode_json(),
            edit: metadata_set(MetadataValue::Text(geocode_json.into())),
        },
        medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
            schema_id: medialibrary_tauri_lib::known_ids::mlib_reverse_geocode_json_v2(),
            edit: metadata_set(MetadataValue::Text(json_v2.into())),
        },
    ];

    let outcome = apply_target_file(folder, &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let metadata = read_one(dir.path(), &dst);
    assert_eq!(
        schema_value(
            &metadata,
            &medialibrary_tauri_lib::known_ids::mlib_reverse_geocode_geocode_json(),
        ),
        Some(MetadataValue::Text(geocode_json.into()))
    );
    assert_eq!(
        schema_value(
            &metadata,
            &medialibrary_tauri_lib::known_ids::mlib_reverse_geocode_json_v2(),
        ),
        Some(MetadataValue::Text(json_v2.into()))
    );
}

#[test]
fn new_property_default_destination_roundtrip_is_family7_qualified() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let id = medialibrary_tauri_lib::known_ids::mlib_ai_description();
    let before = read_one(dir.path(), &dst);
    assert_eq!(
        before.occurrences.for_schema(&id).count(),
        0,
        "fixture must exercise NewProperty rather than an existing occurrence"
    );

    let registry = get_registry().expect("registry");
    let info = registry.lookup(&id).expect("exact writable schema");
    let target = MetadataDraftTarget::from_new_property(info).expect("NewProperty target");
    let MetadataDraftTarget::NewProperty { write_target, .. } = &target else {
        unreachable!("from_new_property returned an existing target")
    };
    assert_eq!(
        write_target.selector(),
        format!(
            "1{}:7{}:{}",
            info.group,
            family7_group_from_schema_id(&id),
            info.name
        )
    );

    let expected = MetadataValue::Text("family-7-qualified integration write".into());
    let entries = vec![MetadataTargetDraftEntry {
        target: target.clone(),
        edit: metadata_set(expected.clone()),
    }];
    let outcome =
        apply_edits::apply_single_file_metadata(dir.path().to_str().unwrap(), &rel, &entries);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);
    assert_eq!(outcome.outcomes.len(), 1);
    assert_eq!(outcome.outcomes[0].target, target);
    assert!(matches!(
        outcome.outcomes[0].kind.as_str(),
        "Match" | "Coerced"
    ));

    let reread = read_one(dir.path(), &dst);
    let matches = reread.occurrences.for_schema(&id).collect::<Vec<_>>();
    let [created] = matches.as_slice() else {
        panic!(
            "expected one exact-schema occurrence, got {}",
            matches.len()
        )
    };
    assert_eq!(created.value, expected);
    assert_eq!(created.write_target.as_ref(), Some(write_target));
}

#[test]
fn empty_xmp_bag_set_accepts_exiftool_absence_for_new_and_existing_targets() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);
    let id = medialibrary_tauri_lib::known_ids::mlib_ai_ocr_text();
    let empty_bag = metadata_bag(&[]);

    let before = read_one(dir.path(), &dst);
    assert_eq!(
        before.occurrences.for_schema(&id).count(),
        0,
        "fixture must begin without AIOcrText"
    );

    let new_empty = apply_target_file(
        folder,
        &rel,
        vec![SchemaMetadataEdit {
            schema_id: id.clone(),
            edit: metadata_set(empty_bag.clone()),
        }],
    );
    assert!(new_empty.error.is_none(), "{:?}", new_empty.error);
    assert_eq!(new_empty.outcomes.len(), 1);
    assert_eq!(new_empty.outcomes[0].kind, "Match");
    assert_eq!(new_empty.outcomes[0].sent, Some(empty_bag.clone()));
    assert_eq!(new_empty.outcomes[0].observed, None);
    assert_eq!(new_empty.targets_to_clear.len(), 1);
    assert_eq!(
        read_one(dir.path(), &dst)
            .occurrences
            .for_schema(&id)
            .count(),
        0,
        "ExifTool represents the empty Bag as an absent property"
    );

    let populated = apply_target_file(
        folder,
        &rel,
        vec![SchemaMetadataEdit {
            schema_id: id.clone(),
            edit: metadata_set(metadata_bag(&["visible text"])),
        }],
    );
    assert!(populated.error.is_none(), "{:?}", populated.error);
    assert_eq!(populated.outcomes[0].kind, "Match");
    assert_eq!(
        read_one(dir.path(), &dst)
            .occurrences
            .for_schema(&id)
            .count(),
        1
    );

    let existing_empty = apply_target_file(
        folder,
        &rel,
        vec![SchemaMetadataEdit {
            schema_id: id.clone(),
            edit: metadata_set(empty_bag.clone()),
        }],
    );
    assert!(existing_empty.error.is_none(), "{:?}", existing_empty.error);
    assert_eq!(existing_empty.outcomes.len(), 1);
    assert_eq!(existing_empty.outcomes[0].kind, "Match");
    assert_eq!(existing_empty.outcomes[0].sent, Some(empty_bag));
    assert_eq!(existing_empty.outcomes[0].observed, None);
    assert_eq!(existing_empty.targets_to_clear.len(), 1);
    assert_eq!(
        read_one(dir.path(), &dst)
            .occurrences
            .for_schema(&id)
            .count(),
        0,
        "clearing an existing Bag must also accept ExifTool's absent readback"
    );
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
    let set_edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: medialibrary_tauri_lib::known_ids::iptc_city(),
        edit: metadata_set(MetadataValue::Text("to-be-deleted".to_string())),
    }];
    let r1 = apply_target_batch(folder, &rel, set_edits);
    assert!(r1.failed.is_empty());

    // Step 2: delete it.
    let del_edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: medialibrary_tauri_lib::known_ids::iptc_city(),
        edit: metadata_delete(),
    }];
    let r2 = apply_target_batch(folder, &rel, del_edits);
    assert!(r2.failed.is_empty(), "delete failed: {:?}", r2.failed);

    // Step 3: re-read; City should be absent or empty.
    let m = read_one(dir.path(), &dst);
    let got = schema_value(&m, &medialibrary_tauri_lib::known_ids::iptc_city());
    match got {
        None => {}
        Some(MetadataValue::Text(s)) => assert!(s.is_empty(), "expected empty, got {:?}", s),
        Some(MetadataValue::Null) => {}
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
    match schema_value(&m, &medialibrary_tauri_lib::known_ids::xmp_subject()) {
        Some(MetadataValue::List { items, .. }) => {
            assert_eq!(items.len(), 2, "expected two subjects, got {:?}", items);
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let MetadataValue::Text(s) = v {
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
    // Canonical: integer 6, primarily from the raw Pass B output.
    let orientation_id = medialibrary_tauri_lib::tag_schema::SchemaDefinitionId {
        table: "Exif::Main".to_string(),
        tag_id: "274".to_string(),
        index: None,
    };
    match schema_value(&m, &orientation_id) {
        Some(MetadataValue::Integer(n)) => assert_eq!(n, 6),
        Some(MetadataValue::Text(s)) if s == "6" => {} // some exiftool builds emit "6" as string under -n
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
    let id = medialibrary_tauri_lib::known_ids::xmp_description();
    let occurrences = m.occurrences.for_schema(&id).collect::<Vec<_>>();
    let [occurrence] = occurrences.as_slice() else {
        panic!(
            "expected one canonical LangAlt occurrence, got {}",
            occurrences.len()
        )
    };
    assert_eq!(occurrence.id.runtime_tag_id, "description");
    assert!(occurrence.write_target.is_some());
    let desc = occurrence.value.clone();
    let map = match desc {
        MetadataValue::LangAlt(m) => m,
        other => panic!("expected LangAlt, got {:?}", other),
    };
    assert_eq!(
        map.get("x-default").map(|s| s.as_str()),
        Some("default text")
    );
    assert_eq!(map.get("en").map(|s| s.as_str()), Some("english text"));
    assert_eq!(map.get("fr").map(|s| s.as_str()), Some("texte francais"));
}

#[test]
fn fixture_rating_5_pretty_and_raw_match_design() {
    let Some(src) = fixture_path("rating_5.jpg") else {
        return;
    };
    let (_dir, dst) = copy_to_temp(&src);
    let m = read_one(_dir.path(), &dst);
    let rating_id = medialibrary_tauri_lib::known_ids::xmp_rating();
    let rating = schema_value(&m, &rating_id);
    let display_ok = match rating.as_ref() {
        Some(MetadataValue::Integer(5)) => true,
        Some(MetadataValue::Real(f)) => (f - 5.0).abs() < 1e-9,
        Some(MetadataValue::Text(s)) if s == "5" || s == "5.0" => true,
        _ => false,
    };
    let raw_ok = matches!(rating.as_ref(), Some(MetadataValue::Integer(5)))
        || matches!(rating.as_ref(), Some(MetadataValue::Real(f)) if (f - 5.0).abs() < 1e-9)
        || matches!(rating.as_ref(), Some(MetadataValue::Text(s)) if s == "5");
    assert!(
        display_ok || raw_ok,
        "expected Rating=5 in some form; value={:?}",
        rating
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

    let rating_id = medialibrary_tauri_lib::known_ids::xmp_rating();

    // Confirm starting state.
    let before = read_one(dir.path(), &dst);
    let starting_rating = schema_value(&before, &rating_id);
    assert!(
        starting_rating.is_some(),
        "fixture should start with a Rating"
    );

    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: rating_id.clone(),
        edit: metadata_set(MetadataValue::Real(5.0)),
    }];

    let outcome = apply_target_file(folder, &rel, edits);
    assert_eq!(outcome.outcomes.len(), 1);
    assert!(matches!(
        outcome.outcomes[0].kind.as_str(),
        "Match" | "Coerced"
    ));

    let after = read_one(dir.path(), &dst);
    let rating = schema_value(&after, &rating_id);
    let ok = matches!(rating.as_ref(), Some(MetadataValue::Integer(5)))
        || matches!(rating.as_ref(), Some(MetadataValue::Real(f)) if (f - 5.0).abs() < 1e-6)
        || matches!(rating.as_ref(), Some(MetadataValue::Text(s)) if s == "5" || s == "5.0");
    assert!(ok, "Rating not updated; value={rating:?}");
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
    let orientation_id = medialibrary_tauri_lib::tag_schema::SchemaDefinitionId {
        table: "Exif::Main".to_string(),
        tag_id: "274".to_string(),
        index: None,
    };
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: orientation_id.clone(),
        edit: metadata_set(MetadataValue::Integer(3)),
    }];

    let result = apply_target_batch(folder, &rel, edits);
    assert!(result.failed.is_empty(), "failed: {:?}", result.failed);

    let after = read_one(dir.path(), &dst);
    match schema_value(&after, &orientation_id) {
        Some(MetadataValue::Integer(n)) => assert_eq!(n, 3),
        other => panic!("expected canonical Orientation 3, got {:?}", other),
    }
}

// ── Face regions (Bag<Struct>) ───────────────────────────────────────────────

#[test]
fn face_regions_round_trip_through_struct_variant() {
    // Confirms the Phase 1 MetadataValue::Struct support + Phase 6 -struct flag
    // round-trip a real nested-struct XMP value (XMP-mwg-rs:RegionInfo
    // containing AppliedToDimensions + a list of two Region structs).
    let Some(src) = fixture_path("face_regions_mwg.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let m = read_one(dir.path(), &dst);

    let region_info = schema_value(&m, &medialibrary_tauri_lib::known_ids::xmp_region_info());
    let region_info = match region_info {
        Some(MetadataValue::Struct(map)) => map,
        other => panic!("expected RegionInfo as Object, got {:?}", other),
    };

    // AppliedToDimensions sub-struct should be present.
    let dims = match region_info.get("AppliedToDimensions") {
        Some(MetadataValue::Struct(d)) => d,
        other => panic!("expected AppliedToDimensions as Object, got {:?}", other),
    };
    assert!(dims.contains_key("W"));
    assert!(dims.contains_key("H"));

    // RegionList should be a List of two struct entries.
    let list = match region_info.get("RegionList") {
        Some(MetadataValue::List { items, .. }) => items,
        other => panic!("expected RegionList as List, got {:?}", other),
    };
    assert_eq!(list.len(), 2, "expected 2 regions");

    let names: Vec<String> = list
        .iter()
        .filter_map(|item| {
            if let MetadataValue::Struct(region) = item {
                if let Some(MetadataValue::Text(name)) = region.get("Name") {
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
    let result = scanner::read_file_metadata_batch(&[rel], &[dst]);
    match result {
        Ok(outcome) => {
            // If exiftool found the file, sanity-check metadata; otherwise
            // accept the empty case (Windows path-encoding limitation).
            if let Some(r) = outcome.results.into_iter().next() {
                if !r.occurrences.is_empty() {
                    println!("[unicode test] exiftool read metadata: ok");
                }
            } else if let Some(fail) = outcome.failures.into_iter().next() {
                println!("[unicode test] failed per-file: {}", fail.error_message);
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

    let outcome = scanner::read_file_metadata_batch(&rel_paths, &abs_paths)
        .expect("batch read should not hard-fail");
    assert_eq!(outcome.results.len() + outcome.failures.len(), 2);

    // The good file's metadata should be intact.
    let good_result = outcome
        .results
        .iter()
        .find(|r| r.relative_path == "good.jpg");
    assert!(
        good_result
            .map(|r| !r.occurrences.is_empty())
            .unwrap_or(false),
        "good file must still have metadata"
    );

    // The bad file may have zero or partial metadata, or have failed, but it must be in either results or failures.
    let has_bad = outcome.results.iter().any(|r| r.relative_path == "bad.jpg")
        || outcome
            .failures
            .iter()
            .any(|f| f.relative_path == "bad.jpg");
    assert!(
        has_bad,
        "bad file must be present in either results or failures"
    );
}
#[test]
fn metadata_read_error_is_isolated_from_valid_batch_neighbours() {
    let Some(good) = fixture_path("keywords_basic.jpg") else {
        return;
    };
    let Some(bad) = fixture_path("metadata_read_error.jpg") else {
        return;
    };
    let (_good_dir, good_dst) = copy_to_temp(&good);
    let (_bad_dir, bad_dst) = copy_to_temp(&bad);

    let outcome = scanner::read_file_metadata_batch(
        &["good.jpg".to_string(), "bad.jpg".to_string()],
        &[good_dst, bad_dst],
    )
    .expect("a per-file ExifTool error must not fail the whole batch");

    assert!(
        outcome
            .results
            .iter()
            .any(|result| result.relative_path == "good.jpg" && !result.occurrences.is_empty()),
        "the valid neighbour must retain its metadata"
    );
    assert_eq!(outcome.failures.len(), 1);
    assert_eq!(outcome.failures[0].relative_path, "bad.jpg");
    assert!(
        outcome.failures[0].error_message.contains("File is empty"),
        "unexpected failure: {}",
        outcome.failures[0].error_message
    );
}
#[test]
fn metadata_read_error_fixture_fails_deterministically() {
    let Some(bad) = fixture_path("metadata_read_error.jpg") else {
        return;
    };
    let (_dir, bad_dst) = copy_to_temp(&bad);

    let outcome = scanner::read_file_metadata_batch(&["bad.jpg".to_string()], &[bad_dst])
        .expect("the process-level failure should be classified per file");

    assert!(outcome.results.is_empty());
    assert_eq!(outcome.failures.len(), 1);
    assert_eq!(outcome.failures[0].relative_path, "bad.jpg");
    assert!(
        outcome.failures[0].error_message.contains("File is empty"),
        "unexpected failure: {}",
        outcome.failures[0].error_message
    );
}

// ── Semantic apply path: MetadataDraftEdit with Bag<Text> ────────────────────

#[test]
fn semantic_apply_writes_bag_as_separate_items_end_to_end() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let subject_id = medialibrary_tauri_lib::known_ids::xmp_subject();
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: subject_id,
        edit: metadata_set(metadata_bag(&["alpha", "beta", "gamma"])),
    }];

    let outcome = apply_target_file(folder, &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let m = read_one(dir.path(), &dst);
    match schema_value(&m, &medialibrary_tauri_lib::known_ids::xmp_subject()) {
        Some(MetadataValue::List { items, .. }) => {
            assert_eq!(items.len(), 3, "expected 3 subjects, got {:?}", items);
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let MetadataValue::Text(s) = v {
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

// ── Coerced-write detection ──────────────────────────────────────────────────

#[test]
fn semantic_apply_rating_fractional_coerces_or_rejects_cleanly() {
    let Some(src) = fixture_path("rating_3.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let rating_id = medialibrary_tauri_lib::known_ids::xmp_rating();
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: rating_id,
        edit: metadata_set(MetadataValue::Real(3.5)),
    }];

    let outcome = apply_target_file(folder, &rel, edits);
    // Coercion either yields a matched float (3.5 → 3.5 in file) or a
    // clean verification-failure message naming the tag.  We just assert
    // it didn't hard-fail.
    assert!(
        outcome.fresh_file_metadata.is_some(),
        "expected authoritative metadata even on coerced write; error: {:?}",
        outcome.error
    );
    println!("[rating coerce] outcome.error = {:?}", outcome.error);

    // Re-read should still parse without panic.
    let m = read_one(dir.path(), &dst);
    let _ = schema_value(&m, &medialibrary_tauri_lib::known_ids::xmp_rating());
}

// ── ListAdd / ListRemove intents ─────────────────────────────────────────────

#[test]
fn semantic_apply_list_add_appends_items_to_bag() {
    let Some(src) = fixture_path("keywords_basic.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let subject_id = medialibrary_tauri_lib::known_ids::xmp_subject();
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: subject_id,
        edit: metadata_edit(metadata_bag(&["vacation"]), EditIntent::ListAdd),
    }];

    let outcome = apply_target_file(folder, &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let m = read_one(dir.path(), &dst);
    match schema_value(&m, &medialibrary_tauri_lib::known_ids::xmp_subject()) {
        Some(MetadataValue::List { items, .. }) => {
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let MetadataValue::Text(s) = v {
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
    let Some(src) = fixture_path("keywords_basic.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let subject_id = medialibrary_tauri_lib::known_ids::xmp_subject();
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: subject_id,
        edit: metadata_edit(metadata_bag(&["beach"]), EditIntent::ListRemove),
    }];

    let outcome = apply_target_file(folder, &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);

    let m = read_one(dir.path(), &dst);
    match schema_value(&m, &medialibrary_tauri_lib::known_ids::xmp_subject()) {
        Some(MetadataValue::List { items, .. }) => {
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let MetadataValue::Text(s) = v {
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
        Some(MetadataValue::Text(s)) => {
            // Single-element list may collapse to scalar.
            assert_eq!(s, "sunset");
        }
        other => panic!("expected Subject as List or single String, got {:?}", other),
    }
}

// ── Keywords list write-back (the regression-of-record) ──────────────────────

#[test]
fn apply_keywords_writes_back_as_separate_items_not_csv() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let subject_id = medialibrary_tauri_lib::known_ids::xmp_subject();
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: subject_id,
        edit: metadata_set(MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![
                MetadataValue::Text("alpha".into()),
                MetadataValue::Text("beta".into()),
            ],
        }),
    }];
    let result = apply_target_batch(folder, &rel, edits);
    assert!(result.failed.is_empty(), "{:?}", result.failed);

    let m = read_one(dir.path(), &dst);
    match schema_value(&m, &medialibrary_tauri_lib::known_ids::xmp_subject()) {
        Some(MetadataValue::Text(s)) => assert!(s == "alpha" || s == "beta"),
        Some(MetadataValue::List { items, .. }) => {
            assert_eq!(items.len(), 2);
            let strs: Vec<String> = items
                .iter()
                .filter_map(|v| {
                    if let MetadataValue::Text(s) = v {
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

#[test]
fn apply_xmp_mlib_ai_ocr_text_preserves_newlines() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let ocr_text = "cpp\nCertificate\nOf\nAchievement\nRobert Highet".to_string();

    let ocr_id = medialibrary_tauri_lib::known_ids::mlib_ai_ocr_text();
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: ocr_id,
        edit: metadata_set(MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Text(ocr_text.clone())],
        }),
    }];
    let result = apply_target_batch(folder, &rel, edits);
    assert!(result.failed.is_empty(), "{:?}", result.failed);

    let m = read_one(dir.path(), &dst);
    match schema_value(&m, &medialibrary_tauri_lib::known_ids::mlib_ai_ocr_text()) {
        Some(MetadataValue::Text(s)) => {
            assert_eq!(s.as_str(), ocr_text.as_str());
        }
        Some(MetadataValue::List { items, .. }) => {
            assert_eq!(items.len(), 1);
            if let MetadataValue::Text(s) = &items[0] {
                assert_eq!(s.as_str(), ocr_text.as_str());
            } else {
                panic!("expected Text inside list, got {:?}", items[0]);
            }
        }
        other => panic!("expected AIOcrText as list or text, got {:?}", other),
    }
}

#[test]
fn apply_xmp_mlib_ai_ocr_text_preserves_argfile_sensitive_text_and_filename() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, original) = copy_to_temp(&src);
    let dst = dir.path().join("VAT @ $ test.jpg");
    std::fs::rename(&original, &dst).unwrap();
    let folder = dir.path().to_str().unwrap();
    let rel = rel_of(dir.path(), &dst);

    let ocr_text = "  All Prices include VAT @ 20%.\r\nCost $5\tliteral \\n and \\  ".to_string();
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: medialibrary_tauri_lib::known_ids::mlib_ai_ocr_text(),
        edit: metadata_set(MetadataValue::List {
            list_kind: ListKind::Bag,
            items: vec![MetadataValue::Text(ocr_text.clone())],
        }),
    }];

    let result = apply_target_batch(folder, &rel, edits);
    assert!(result.failed.is_empty(), "{:?}", result.failed);

    let metadata = read_one(dir.path(), &dst);
    match schema_value(
        &metadata,
        &medialibrary_tauri_lib::known_ids::mlib_ai_ocr_text(),
    ) {
        Some(MetadataValue::Text(value)) => assert_eq!(value, ocr_text),
        Some(MetadataValue::List { items, .. }) => {
            assert_eq!(items, vec![MetadataValue::Text(ocr_text)]);
        }
        other => panic!("expected exact AIOcrText round trip, got {other:?}"),
    }
}

fn write_u16_le(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn minimal_windows_bmp(path: &Path) {
    let mut bytes = vec![0_u8; 58];
    bytes[0..2].copy_from_slice(b"BM");
    write_u32_le(&mut bytes, 2, 58);
    write_u32_le(&mut bytes, 10, 54);
    write_u32_le(&mut bytes, 14, 40);
    write_u32_le(&mut bytes, 18, 1);
    write_u32_le(&mut bytes, 22, 1);
    write_u16_le(&mut bytes, 26, 1);
    write_u16_le(&mut bytes, 28, 24);
    write_u32_le(&mut bytes, 34, 4);
    bytes[54..58].copy_from_slice(&[0, 0, 0, 0]);
    fs::write(path, bytes).expect("write Windows BMP");
}

fn minimal_os2_bmp(path: &Path) {
    let mut bytes = vec![0_u8; 30];
    bytes[0..2].copy_from_slice(b"BM");
    write_u32_le(&mut bytes, 2, 30);
    write_u32_le(&mut bytes, 10, 26);
    write_u32_le(&mut bytes, 14, 12);
    write_u16_le(&mut bytes, 18, 1);
    write_u16_le(&mut bytes, 20, 1);
    write_u16_le(&mut bytes, 22, 1);
    write_u16_le(&mut bytes, 24, 24);
    bytes[26..30].copy_from_slice(&[0, 0, 0, 0]);
    fs::write(path, bytes).expect("write OS/2 BMP");
}

#[test]
fn scanner_runtime_ids_resolve_exactly_or_remain_unknown() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let metadata = read_one(dir.path(), &dst);
    let registry = medialibrary_tauri_lib::tag_schema::get_registry().expect("schema registry");
    let mut resolved = 0;
    for occurrence in metadata.occurrences {
        match registry.lookup(&occurrence.schema_id) {
            Some(info) => {
                assert_eq!(info.id, occurrence.schema_id);
                resolved += 1;
            }
            None => assert!(
                matches!(occurrence.value, MetadataValue::Unknown { .. }),
                "missing exact schema must remain unknown/read-only: {:?}",
                occurrence.schema_id
            ),
        }
    }
    assert!(
        resolved > 10,
        "fixture should exercise ordinary schema entries"
    );
}

#[test]
fn bmp_collision_files_retain_distinct_exact_tables() {
    let dir = tempfile::tempdir().expect("tempdir");
    let windows = dir.path().join("windows.bmp");
    let os2 = dir.path().join("os2.bmp");
    minimal_windows_bmp(&windows);
    minimal_os2_bmp(&os2);

    let windows_metadata = read_one(dir.path(), &windows);
    let os2_metadata = read_one(dir.path(), &os2);
    let windows_id = medialibrary_tauri_lib::tag_schema::SchemaDefinitionId {
        table: "BMP::Main".into(),
        tag_id: "0".into(),
        index: None,
    };
    let os2_id = medialibrary_tauri_lib::tag_schema::SchemaDefinitionId {
        table: "BMP::OS2".into(),
        tag_id: "0".into(),
        index: None,
    };

    assert_eq!(
        windows_metadata.occurrences.for_schema(&windows_id).count(),
        1
    );
    assert_eq!(windows_metadata.occurrences.for_schema(&os2_id).count(), 0);
    assert_eq!(os2_metadata.occurrences.for_schema(&os2_id).count(), 1);
    assert_eq!(os2_metadata.occurrences.for_schema(&windows_id).count(), 0);

    let registry = medialibrary_tauri_lib::tag_schema::get_registry().expect("schema registry");
    let windows_info = registry.lookup(&windows_id).expect("Windows BMP schema");
    let os2_info = registry.lookup(&os2_id).expect("OS/2 BMP schema");
    assert_eq!(windows_info.display_name(), "File:BMPVersion");
    assert_eq!(os2_info.display_name(), "File:BMPVersion");
    assert_ne!(windows_info.id, os2_info.id);
}

#[test]
fn real_fixture_retains_repeated_definition_index_zero() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let metadata = read_one(dir.path(), &dst);
    let indexed = medialibrary_tauri_lib::tag_schema::SchemaDefinitionId {
        table: "Exif::Main".into(),
        tag_id: "513".into(),
        index: Some(0),
    };
    let unindexed = medialibrary_tauri_lib::tag_schema::SchemaDefinitionId {
        index: None,
        ..indexed.clone()
    };

    assert_eq!(metadata.occurrences.for_schema(&indexed).count(), 1);
    assert_eq!(metadata.occurrences.for_schema(&unindexed).count(), 0);
    assert_ne!(indexed, unindexed);
    let registry = medialibrary_tauri_lib::tag_schema::get_registry().expect("schema registry");
    assert_eq!(
        registry.lookup(&indexed).expect("indexed schema").id,
        indexed
    );
}

#[test]
fn roundtrip_langalt_preserves_exact_parent_id_and_languages() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let id = medialibrary_tauri_lib::known_ids::xmp_description();
    let mut languages = BTreeMap::new();
    languages.insert("x-default".to_string(), "Exact default".to_string());
    languages.insert("fr".to_string(), "Texte exact".to_string());
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: id.clone(),
        edit: metadata_set(MetadataValue::LangAlt(languages.clone())),
    }];

    let outcome = apply_target_file(dir.path().to_str().unwrap(), &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);
    assert_eq!(outcome.outcomes.len(), 1);
    assert_eq!(outcome.outcomes[0].target.schema_id(), &id);
    assert!(outcome
        .targets_to_clear
        .iter()
        .any(|target| target.schema_id() == &id));
    let reread = read_one(dir.path(), &dst);
    assert_eq!(reread.occurrences.for_schema(&id).count(), 1);
    assert_eq!(
        schema_value(&reread, &id),
        Some(MetadataValue::LangAlt(languages))
    );
}

#[test]
fn roundtrip_langalt_set_removes_omitted_language() {
    let Some(src) = fixture_path("langalt_description.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let id = medialibrary_tauri_lib::known_ids::xmp_description();
    let languages = BTreeMap::from([
        ("en".to_string(), "replacement english".to_string()),
        ("x-default".to_string(), "replacement default".to_string()),
    ]);
    let edits = vec![SchemaMetadataEdit {
        schema_id: id.clone(),
        edit: metadata_set(MetadataValue::LangAlt(languages.clone())),
    }];

    let outcome = apply_target_file(dir.path().to_str().unwrap(), &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);
    assert_eq!(outcome.outcomes[0].kind, "Match");

    let reread = read_one(dir.path(), &dst);
    let occurrences = reread.occurrences.for_schema(&id).collect::<Vec<_>>();
    let [occurrence] = occurrences.as_slice() else {
        panic!(
            "expected one canonical LangAlt occurrence, got {}",
            occurrences.len()
        )
    };
    assert_eq!(occurrence.value, MetadataValue::LangAlt(languages));
    assert!(occurrence.write_target.is_some());
}

#[test]
fn roundtrip_repeatable_struct_preserves_nested_lang_alt_languages() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let id = medialibrary_tauri_lib::known_ids::xmp_location_created();
    let value = MetadataValue::List {
        list_kind: ListKind::Bag,
        items: vec![
            MetadataValue::Struct(BTreeMap::from([
                ("City".into(), MetadataValue::Text("Cambridge".into())),
                (
                    "LocationName".into(),
                    MetadataValue::LangAlt(BTreeMap::from([
                        ("fr".into(), "Cambridge, français".into()),
                        ("x-default".into(), "Cambridge | default".into()),
                        // ExifTool canonicalises XMP language identifiers to
                        // lowercase on storage, so use that canonical form in
                        // the exact round-trip expectation.
                        ("zh-hant".into(), "劍橋".into()),
                    ])),
                ),
            ])),
            MetadataValue::Struct(BTreeMap::from([
                ("City".into(), MetadataValue::Text("York".into())),
                (
                    "LocationName".into(),
                    MetadataValue::LangAlt(BTreeMap::from([
                        ("fr".into(), "York français".into()),
                        ("x-default".into(), "York default".into()),
                    ])),
                ),
            ])),
        ],
    };
    let edits = vec![SchemaMetadataEdit {
        schema_id: id.clone(),
        edit: metadata_set(value.clone()),
    }];

    let outcome = apply_target_file(dir.path().to_str().unwrap(), &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);
    assert_eq!(outcome.outcomes.len(), 1);
    assert_eq!(outcome.outcomes[0].kind, "Match");

    let reread = read_one(dir.path(), &dst);
    assert_eq!(schema_value(&reread, &id), Some(value));
}

#[test]
fn roundtrip_gps_preserves_each_exact_id() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let values = [
        (
            medialibrary_tauri_lib::known_ids::gps_latitude(),
            MetadataValue::Real(51.5),
        ),
        (
            medialibrary_tauri_lib::known_ids::gps_latitude_ref(),
            MetadataValue::Text("N".into()),
        ),
        (
            medialibrary_tauri_lib::known_ids::gps_longitude(),
            MetadataValue::Real(0.125),
        ),
        (
            medialibrary_tauri_lib::known_ids::gps_longitude_ref(),
            MetadataValue::Text("W".into()),
        ),
    ];
    let edits = values
        .iter()
        .map(
            |(id, value)| medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
                schema_id: id.clone(),
                edit: metadata_set(value.clone()),
            },
        )
        .collect::<Vec<_>>();

    let outcome = apply_target_file(dir.path().to_str().unwrap(), &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);
    assert_eq!(
        outcome
            .outcomes
            .iter()
            .map(|item| item.target.schema_id().clone())
            .collect::<Vec<_>>(),
        values.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>()
    );
    let reread = read_one(dir.path(), &dst);
    for (id, expected) in values {
        let actual = schema_value(&reread, &id).unwrap_or_else(|| panic!("missing {id:?}"));
        match (&expected, &actual) {
            (MetadataValue::Real(expected), MetadataValue::Real(actual)) => {
                assert!((actual - expected).abs() < 1e-8, "{id:?}: {actual}");
            }
            _ => assert_eq!(actual, expected, "{id:?}"),
        }
    }
}

#[test]
fn roundtrip_datetime_preserves_explicit_utc_offset_and_exact_id() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let id = medialibrary_tauri_lib::known_ids::xmp_create_date();
    let value = MetadataValue::DateTime(DateTimeValue {
        date: DateValue {
            year: 2026,
            month: 7,
            day: 12,
        },
        time: TimeValue {
            hour: 10,
            minute: 11,
            second: 12,
            subsecond: Some("345".into()),
            offset: Some(UtcOffsetValue {
                sign: OffsetSign::Plus,
                hours: 1,
                minutes: 30,
            }),
        },
    });
    let edits = vec![medialibrary_tauri_lib::draft_edits::SchemaMetadataEdit {
        schema_id: id.clone(),
        edit: metadata_set(value.clone()),
    }];

    let outcome = apply_target_file(dir.path().to_str().unwrap(), &rel, edits);
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);
    assert_eq!(outcome.outcomes[0].target.schema_id(), &id);
    let reread = read_one(dir.path(), &dst);
    assert_eq!(schema_value(&reread, &id), Some(value));
}

#[test]
fn location_created_struct_round_trips_as_one_atomic_location() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let rel = rel_of(dir.path(), &dst);
    let id = medialibrary_tauri_lib::known_ids::xmp_location_created();
    let value = MetadataValue::List {
        list_kind: ListKind::Bag,
        items: vec![MetadataValue::Struct(BTreeMap::from([
            (
                "Sublocation".into(),
                MetadataValue::Text(
                    " Student Recruitment, Marketing, and Admissions | West } [Level=1]\\Wing"
                        .into(),
                ),
            ),
            ("City".into(), MetadataValue::Text("Tokyo".into())),
            ("ProvinceState".into(), MetadataValue::Text("Tokyo".into())),
            ("CountryName".into(), MetadataValue::Text("Japan".into())),
            ("CountryCode".into(), MetadataValue::Text("JP".into())),
            ("GPSLatitude".into(), MetadataValue::Real(35.62857)),
            ("GPSLongitude".into(), MetadataValue::Real(139.7367)),
            (
                "LocationId".into(),
                MetadataValue::List {
                    list_kind: ListKind::Bag,
                    items: vec![
                        MetadataValue::Text(
                            "https://www.openstreetmap.org/node/13954804901".into(),
                        ),
                        MetadataValue::Text("[urn:test,west|pipe]tail}brace".into()),
                    ],
                },
            ),
        ]))],
    };
    let outcome = apply_target_file(
        dir.path().to_str().unwrap(),
        &rel,
        vec![SchemaMetadataEdit {
            schema_id: id.clone(),
            edit: metadata_set(value.clone()),
        }],
    );
    assert!(outcome.error.is_none(), "apply failed: {:?}", outcome.error);
    let reread = read_one(dir.path(), &dst);
    assert_eq!(schema_value(&reread, &id), Some(value));

    // A later reverse geocode replaces the parent bag, rather than merging
    // members and leaving stale City/GPS/LocationId values behind.
    let replacement = MetadataValue::List {
        list_kind: ListKind::Bag,
        items: vec![MetadataValue::Struct(BTreeMap::from([
            ("CountryName".into(), MetadataValue::Text("France".into())),
            ("CountryCode".into(), MetadataValue::Text("FR".into())),
            ("GPSLatitude".into(), MetadataValue::Real(48.8566)),
            ("GPSLongitude".into(), MetadataValue::Real(2.3522)),
        ]))],
    };
    let outcome = apply_target_file(
        dir.path().to_str().unwrap(),
        &rel,
        vec![SchemaMetadataEdit {
            schema_id: id.clone(),
            edit: metadata_set(replacement.clone()),
        }],
    );
    assert!(
        outcome.error.is_none(),
        "replace failed: {:?}",
        outcome.error
    );
    let reread = read_one(dir.path(), &dst);
    assert_eq!(schema_value(&reread, &id), Some(replacement));
}

#[test]
fn missing_exact_schema_is_rejected_before_write() {
    let Some(src) = fixture_path("real_with_exif.jpg") else {
        return;
    };
    let (dir, dst) = copy_to_temp(&src);
    let before = fs::read(&dst).expect("read before");
    let rel = rel_of(dir.path(), &dst);
    let missing = medialibrary_tauri_lib::tag_schema::SchemaDefinitionId {
        table: "Missing::Table".into(),
        tag_id: "Title".into(),
        index: None,
    };
    let entries = vec![MetadataTargetDraftEntry {
        target: MetadataDraftTarget::NewProperty {
            schema_id: missing.clone(),
            write_target: MetadataWriteTarget {
                group1: "XMP-test".into(),
                group7: family7_group_from_schema_id(&missing),
                tag_name: "Title".into(),
            },
        },
        edit: metadata_set(MetadataValue::Text("must not write".into())),
    }];

    let outcome =
        apply_edits::apply_single_file_metadata(dir.path().to_str().unwrap(), &rel, &entries);
    let error = outcome.error.unwrap();
    assert!(error.to_ascii_lowercase().contains("schema"), "{error}");
    assert!(outcome.outcomes.is_empty());
    assert_eq!(fs::read(&dst).expect("read after"), before);
}
