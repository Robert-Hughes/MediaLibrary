# AGENTS.md

Operational guidance for coding agents and contributors working on MediaLibrary.

## Working Rules

- Run commands from the repo root unless a command says otherwise.
- Keep changes focused. Do not mix feature work into repo hygiene, docs, or tooling changes.
- Do not edit `TODO.md` unless the user explicitly asks; treat it as human-edits-only.
- Do not hand-edit generated TypeScript under `src/types/generated/`.
- Do not hand-edit generated Tauri icon outputs under `src-tauri/icons/`.

## Required Checks

Frontend quick check:

```sh
npm run check
```

`npm run check` runs formatting, warning-free ESLint, TypeScript checking,
the full Vitest suite, and a warning-free Vite production build. Unexpected
test stderr fails the suite; tests that intentionally exercise diagnostics
must capture and assert them. The current Vite chunk warning budget is 1024 kB
(1 MB) and should be lowered once the main bundle is split.

Frontend full local checks from a clean dependency install:

```sh
npm ci
npm run check
```

Use `npm run build` when only a standalone type-checked production build is
needed.

Rust checks:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features integration
```

The integration tier requires `exiftool` on `PATH` and write access to a temp directory.

## Test Tiers

- Tier 1, unit/default: `cargo test --manifest-path src-tauri/Cargo.toml` and `npm test`. Fast, offline, and expected on normal commits.
- Tier 2, integration: `cargo test --manifest-path src-tauri/Cargo.toml --features integration`. Runs real `exiftool` against fixtures in `test_images/` and verifies write/read round trips.

Any change touching `scanner.rs`, `apply_edits.rs`, `draft_edits.rs`, `tag_schema.rs`, `src/metadata/`, or `src/components/editors/` should run the Rust integration tier before review. There is no separate frontend integration project configured.

## Logs And Diagnostics

Two log locations exist, both keyed off the Tauri bundle identifier
`com.xman2.medialibrary` from `src-tauri/tauri.conf.json`:

- Runtime logs (the `log` crate, wired via `tauri-plugin-log` in
  `src-tauri/src/lib.rs::run`): mirrored to stdout and to
  `medialibrary.log` in the platform log directory:
  - Windows: `%LOCALAPPDATA%\com.xman2.medialibrary\logs\medialibrary.log`
  - macOS: `~/Library/Logs/com.xman2.medialibrary/medialibrary.log`
  - Linux: `$XDG_DATA_HOME/com.xman2.medialibrary/logs/medialibrary.log`
    (`$XDG_DATA_HOME` defaults to `~/.local/share`.)
  Files rotate at 10 MB with `RotationStrategy::KeepAll`; rotated files are
  kept beside the active one as `medialibrary_<timestamp>.log`.
- JSONL audit logs under the app-data directory, resolved by
  `crate::commands::shared::app_data_dir`:
  - Windows: `%APPDATA%\com.xman2.medialibrary\`
  - macOS: `~/Library/Application Support/com.xman2.medialibrary/`
  - Linux: `$XDG_DATA_HOME/com.xman2.medialibrary/`
  Append-only per-batch audit trails live here:
  - `MediaLibraryTargetApplyLog.jsonl` - target apply audit (schema v3); rotates
    at 10 MB per apply command (KeepAll, `_<UTC timestamp>.jsonl` suffix), see
    `src-tauri/src/apply_log.rs`.
  - `MediaLibraryApplyLog.jsonl` - legacy apply log; preserved if present, no longer written.
  - `describe_log.jsonl` - describe cost/usage audit, see `src-tauri/src/describe_log.rs`.
  - `normalise_audit.jsonl` - normalise AI-call audit and conflict counters, see `src-tauri/src/commands/normalise.rs`.

Non-log state in the app-data directory: `settings.json`,
`MediaLibraryTargetDraftEdits.sqlite3` (draft repository), and the geocode
cache (`geocache.json`).

## Generated Code

Rust types annotated for `ts-rs` export regenerate TypeScript bindings as a side effect of:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

Commit regenerated files in `src/types/generated/` with the Rust type change, but never edit them by hand. See `docs/GENERATED_TYPES.md`.

Generated Tauri icon rasters under `src-tauri/icons/` come from SVG sources in `public/`; regenerate them with `node scripts/build-icons.mjs` after SVG changes. See `docs/ASSETS.md`.

## Reference Docs

- `docs/GENERATED_TYPES.md` - Rust-to-TypeScript binding workflow and pitfalls.
- `docs/METADATA_IDENTITY_MODEL.md` - canonical guide to friendly labels, schema definitions, runtime occurrences, selectors and draft targets.
- `docs/METADATA_PIPELINE.md` - tag-schema overrides, draft semantics, and metadata read patterns.
- `docs/METADATA_FORMATS_DESIGN.md` - metadata type-flow design.
- `docs/DATATYPE_MISMATCHES.md` - schema-vs-runtime datatype mismatch analysis.
- `docs/ASSETS.md` - logo and icon source-of-truth workflow.
- `test_images/README.md` - fixture corpus, provenance, and expected tag contents.

## Commits And PRs

- Use Conventional Commit subjects, for example `feat(scanner): ...`, `fix(apply_edits): ...`, or `test(roundtrip): ...`.
- For metadata-pipeline changes, explicitly state whether Tier 1 and Tier 2 passed locally.
