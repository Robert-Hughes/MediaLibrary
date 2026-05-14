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

Cross-boundary types (`Variant`, `TagInfo`, `TagKind`, `DraftEdit`, `EditIntent`, `ImageMetadata`) are generated from Rust into `src/types.generated.ts` via `ts-rs`.

- Do not hand-edit `types.generated.ts`.
- After changing any Rust type with `#[derive(TS)]`, run `cargo test` once locally — that regenerates the file. Commit the regenerated file with the Rust change.
- CI regenerates and `diff`s; out-of-date generated files fail the build.

`src/types.ts` re-exports from `types.generated.ts` plus hand-written frontend-only types.

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
