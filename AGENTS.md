# AGENTS.md

Conventions for AI coding agents (and humans) working on MediaLibrary. Read this before submitting changes.

---

## Test tiers

MediaLibrary has two test tiers. **Running `cargo test` and `npm test` alone is not sufficient to claim a passing build.** The integration tier must also pass.

### Tier 1: unit (default, fast, offline)

Run on every commit. Operates on canned JSON, XML, and pre-baked image fixtures. No `exiftool` execution.

```
cargo test
npm test
```

Expected runtime: under 30 seconds total. CI runs this tier on every PR push.

### Tier 2: integration (disabled by default, required for sign-off)

Runs real `exiftool` against real image fixtures in `test_images/`. Performs write-then-re-read round-trips. This is the tier that verifies the design's central promise: type-faithful round-trip through exiftool.

```
cargo test --features integration
npm test -- --project integration
```

Prerequisites:

- `exiftool` on PATH. Minimum version: pinned in `src-tauri/tests/integration/MIN_EXIFTOOL_VERSION`.
- Write access to a temp directory.

Expected runtime: 60–120 seconds. CI runs this tier on every PR push in a separate job with `exiftool` pre-installed.

**Any PR that touches `scanner.rs`, `apply_edits.rs`, `draft_edits.rs`, `tag_schema.rs`, or any file under `src/metadata/` or `src/components/editors/` must run the integration tier locally before being marked ready for review.**

---

## Image fixtures

Live at `test_images/` at the repo root. Provenance:

- Sourced from real photographs in `D:\OneDrive\Pictures` covering varied camera manufacturers and formats.
- Image content stripped to 4×4 pixels (smallest legal for the format) to keep repo size low.
- Specific metadata tags re-applied to a known state, then committed.
- No Git LFS. Each fixture is <2 KB; the corpus fits comfortably in the repo.

Each fixture's purpose, source, and expected tag contents are documented in `test_images/README.md`. **The README is the source of truth** for what each fixture contains. Tests assert against the README's claims, not against re-running exiftool.

### Adding a new fixture

1. Pick a source file from `D:\OneDrive\Pictures` (or any image with the metadata shape you want to test).
2. Run the documented recipe in `tools/build-fixture.sh` to shrink the image and apply the target tags.
3. Place under `test_images/<descriptive_name>.<ext>`.
4. Add an entry to `test_images/README.md` describing what it contains and what it tests.
5. Commit the fixture and README update together.

`tools/build-fixture.sh` is committed for reproducibility but **never run in CI or during test setup**. Tests open the committed file directly. This keeps test behaviour reasoning-friendly: the file on disk is what the test sees.

`tools/check-fixtures.sh` runs in CI and verifies each fixture still contains the tags the README claims. If you regenerate a fixture and the tags differ, the check fails until the README is updated to match.

---

## Generated types

Cross-boundary types (`Variant`, `PhotoInfo`, `ImageMetadata`, `TagInfo`, `TagKind`, `EnumOption`, `EnumRepr`, `DraftEdit`, `EditIntent`, `ApplyEditsResult`, `FailedFile`) are generated from Rust into `src/types/generated/*.ts` by [ts-rs](https://github.com/Aleph-Alpha/ts-rs).

`src/types.ts` re-exports from `src/types/generated/` plus hand-written frontend-only types (the observable stores, `AppState`, event payloads, sorting and column types).

### Workflow

There is **no CI** for this project — all builds and tests are run manually and locally. That means the generated bindings can drift if you don't keep them in sync by hand.

After changing the shape of any Rust type with `#[derive(TS)]` (gated behind `#[cfg_attr(test, derive(ts_rs::TS))]` so it costs nothing in production builds):

1. From repo root, run `cargo test --manifest-path src-tauri/Cargo.toml`. The export attribute (`#[ts(export, export_to = "../../src/types/generated/")]`) writes the regenerated `.ts` files as a side effect of the test run.
2. Run `npx tsc --noEmit` to make sure the rest of the frontend still compiles against the new shapes.
3. Run `npm test -- --run` to catch any runtime-shape mismatches the type check missed.
4. Commit the regenerated `.ts` files in the same commit as the Rust change. Do not edit them by hand — the header comment says so and reviewers will flag it.

### Adding a new shared type

1. In the appropriate Rust file (`scanner.rs`, `tag_schema.rs`, `draft_edits.rs`, `apply_edits.rs`), add the `cfg_attr(test, derive(ts_rs::TS))` and `cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))` lines next to `#[derive(Serialize, …)]`.
2. For `i64` / `u64` fields that should appear as TS `number` (not `bigint`), add `#[cfg_attr(test, ts(type = "number"))]` (or `"number | null"` for `Option<i64>`) on the field. Default `i64`→`bigint` does not match Tauri's JSON wire shape.
3. `cargo test`, verify a new file appeared under `src/types/generated/`, re-export it from `src/types.ts`.

### Pitfalls

- The `export_to` path is **relative to the Rust file's crate root** (`src-tauri/`). `../../src/types/generated/` lands at the repo-root `src/`. Not `../src/...` — that lands inside `src-tauri/src/`.
- `cfg_attr(test, ...)` means the derive only fires under `cargo test`, not `cargo build`. If you change a Rust type and only build, the bindings won't regenerate. Always run `cargo test` after touching annotated types.
- ts-rs maps `HashMap<String, T>` to `{ [key in string]?: T }` — note the `?`, values are optional. Frontend code consuming these must handle `T | undefined`.

---

## Tag-schema overrides

The tag registry is built from `exiftool -listx -lang en` (see
`src-tauri/src/tag_schema.rs`), but listx is silent or wrong on several
things that the rest of the app needs to know. Those gaps are patched
in a hand-curated table (`apply_overrides`) at the bottom of that file.

There are three classes of override; add to whichever fits:

- **XMP list/seq/alt shape** — listx reports XMP bags/seqs/alts as plain
  `string`. We upgrade them to `Bag<Text>` / `Seq<Text>` / etc. Source:
  the XMP specification. Examples: `XMP-dc:Subject`, `XMP-dc:Creator`,
  `XMP-lr:HierarchicalSubject`.
- **DateTime promotion** — XMP doesn't constrain datetime strings at
  the schema level, so listx says `string`. We promote the well-known
  XMP datetime tags to `DateTime` so the editor, verifier, and
  `write_args` numeric-group routing all kick in.
- **`type='undef'` cleanups** — listx reports a long tail of EXIF tags
  as `type='undef'`, which falls through to `TagKind::Unknown`. In
  practice these split into two camps:
    - ASCII version strings (`ExifVersion`, `FlashpixVersion`,
      `InteropVersion`) that ExifTool accepts via `-Tag=value`.
      Promote to `Text`.
    - Opaque binary blobs (MakerNotes, PreviewImage, ThumbnailImage,
      XMP-as-undef, DustRemovalData, DNGPrivateData…) that are
      writable per listx but only via `-Tag<=file.bin`. Demote to
      `Binary`. The override mechanism also forces `writable=false`
      for any kind it sets to `Binary`, so the UI marks them
      read-only and the autocomplete drops them. The override never
      *grants* write permission listx denied.

If you find another tag that needs help (the schema badge is wrong, the
wrong editor opens, writes silently fail), add it to `apply_overrides`
with a comment explaining which camp it falls into. There are tests in
the same file (`undef_version_strings_promoted_to_text`,
`undef_binary_blobs_demoted_to_binary_and_readonly`,
`binary_override_does_not_grant_write_when_listx_said_no`) that you
can extend.

See also `DATATYPE_MISMATCHES.md` for the deferred work on
`Bag(Unknown)` schema-vs-value-badge mismatches (ComponentsConfiguration,
LensSerialNumber, etc.).

---

## Logging

Use the `log` crate (already migrated from custom macros). Set `RUST_LOG=mediabrary=debug` for verbose output during dev. Tests should not depend on log output unless explicitly asserting.

---

## Commits and PRs

- Conventional commit subject lines (e.g. `feat(scanner): ...`, `fix(apply_edits): ...`, `test(roundtrip): ...`).
- One logical change per commit; small commits per phase as documented in `METADATA_FORMATS_PLAN.md`.
- PR descriptions reference the phase and design section being implemented.
- For changes touching the metadata pipeline: confirm in the PR description that **both Tier 1 and Tier 2 passed locally**.

---

## Reference documents

- `METADATA_FORMATS_DESIGN.md` — how metadata types flow through the app and why.
- `METADATA_FORMATS_PLAN.md` — phased implementation plan.
- `TODO.md` — short-form running task list.
- `test_images/README.md` — fixture corpus index.
- `DATATYPE_MISMATCHES.md` — analysis of schema-vs-runtime datatype-badge mismatches and the options for fixing them.
