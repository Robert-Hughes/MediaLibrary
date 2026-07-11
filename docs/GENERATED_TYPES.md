# Generated TypeScript Bindings

Cross-boundary types are generated from Rust into `src/types/generated/*.ts` by `ts-rs`.

The frontend re-exports generated wire-shape types from `src/types.ts` alongside hand-written frontend-only types such as stores, app state, event payloads, sorting, and column types.

Metadata-bearing wire types use `SchemaDefinitionId` explicitly. Repeated
metadata and draft values cross the boundary as arrays of `{ id, value }` or
`{ id, edit }`; do not replace them with `Record<string, ...>` keyed by a
friendly tag name. Frontend maps may use a serialized ID token internally for
JavaScript collection mechanics, but each value must retain the domain ID.

## Generated Types

See `src/types.ts` for the currently re-exported generated bindings.

## Regeneration Workflow

After changing the shape of any Rust type with `#[derive(TS)]` gated behind `#[cfg_attr(test, derive(ts_rs::TS))]`:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm test
```

The `#[ts(export, export_to = "../../src/types/generated/")]` attribute writes regenerated `.ts` files as a side effect of the Rust test run.

Commit the regenerated files in the same commit as the Rust change. Do not edit files under `src/types/generated/` by hand.

## Adding A Shared Type

1. Add `cfg_attr(test, derive(ts_rs::TS))` next to the Rust type's `Serialize` derive.
2. Add `cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))`.
3. For `i64` or `u64` fields that cross the Tauri JSON boundary as numbers, add `#[cfg_attr(test, ts(type = "number"))]`. For nullable fields, use `#[cfg_attr(test, ts(type = "number | null"))]`.
4. Run `cargo test --manifest-path src-tauri/Cargo.toml`.
5. Re-export the generated type from `src/types.ts` if frontend code needs it.

## Pitfalls

- `export_to` is relative to the Rust crate root, `src-tauri/`. Use `../../src/types/generated/`; `../src/...` lands inside `src-tauri/src/`.
- `cfg_attr(test, ...)` means exports run under `cargo test`, not `cargo build`.
- `ts-rs` maps `HashMap<String, T>` to `{ [key in string]?: T }`, so frontend consumers must handle `T | undefined`.
- `BTreeMap<SchemaDefinitionId, T>` is not a JSON object wire shape. Expose it
  as an entry vector and reconstruct an internal token-keyed collection on the
  frontend.
- Generated files are ignored by linting and formatting to avoid noisy churn. Regenerate them from Rust instead of formatting them manually.
