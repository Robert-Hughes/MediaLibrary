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

Frontend full local checks:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

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
