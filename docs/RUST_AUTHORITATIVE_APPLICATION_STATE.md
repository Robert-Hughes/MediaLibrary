# Rust-Authoritative Application State

## Status

The migration described here is complete. Rust is authoritative for the media-library session and domain state; the frontend retains only ephemeral UI state and disposable rendering projections. The phase plan remains below as an implementation history and as a checklist for preserving the boundary.

The production boundary is enforced by Rust session tests, frontend remount/recovery tests, generated wire types, and source-level architectural regression tests. Future changes must continue to follow the vertical-slice and atomic-commit principles in this document.

## Historical Motivation

Before this migration, authority was divided across Rust and TypeScript:

- Rust owned scanning, worker queues, metadata writes, draft persistence, verification during apply, and long-running backend jobs.
- The frontend assembled and owned the effective application session: files, thumbnail and metadata status, scan progress, drafts, dirty persistence state, operation projections, verification outcomes, errors, and stale-result reconciliation.

This creates two interacting state machines. Significant frontend code exists to keep them aligned across folder changes, cancellation, late events, autosave, apply readback, and frontend lifecycle changes.

The target architecture should have one authoritative domain model. A frontend projection may cache backend state for efficient rendering, but it must be disposable and reconstructible from Rust at any time.

## Architectural Goal

Rust owns all durable, operational, and domain state. The frontend owns only ephemeral interaction and presentation state plus a disposable projection of Rust state.

A useful test of the boundary is:

> After a webview reload, the frontend can reconstruct the open session from Rust without losing or inferring folder contents, metadata state, drafts, persistence status, operation progress, verification outcomes, or application issues.

This does not mean that every transient UI value belongs in Rust, nor that the frontend must synchronously request every value during rendering.

## Intended Final Design

### Rust-owned session

Rust exposes a single logical media-library session. Its internal implementation may be split into focused components rather than one large lock, but together they are the authoritative aggregate.

The session includes:

- A stable session identity and monotonic revision.
- Session lifecycle: idle, opening, loaded, closing, or failed.
- The active folder.
- The authoritative file collection.
- Per-file thumbnail status and thumbnail cache identity.
- Per-file metadata occurrence status and authoritative occurrences.
- Scan progress and scan failures.
- Target-aware metadata drafts and draft persistence status.
- Target verification outcomes.
- Application issues with stable identities.
- Active operation state for apply, describe, reverse geocode, and normalise.

The exact Rust structures should preserve existing domain identities. In particular, metadata runtime identity remains occurrence-based, while schema identity is used only for schema semantics.

### Frontend projection

The frontend subscribes to the Rust session and maintains only a rendering projection. That projection may use observable per-row stores to avoid broad React rerenders, but it is not authoritative.

The projection must be replaceable from a backend snapshot. It must not contain domain facts that cannot be recovered from Rust.

Frontend-side projection code may:

- Apply backend deltas.
- Maintain efficient indexes and selectors.
- Cache formatted or derived display values.
- Batch React notifications for rendering efficiency.
- Detect a missed revision and request a fresh snapshot.

It must not independently accept domain mutations, decide persistence success, reconcile stale backend work, or create a competing operation lifecycle.

### Commands express intent

The frontend sends domain commands rather than generic state mutations. Examples include:

- Open or close a folder.
- Prioritise visible files.
- Set or discard an exact-target draft.
- Preview or stage a bulk metadata change.
- Stage generated metadata.
- Remove metadata targets.
- Apply drafts or cancel apply.
- Resolve a verification outcome.
- Dismiss an application issue.

Rust validates each command against current authoritative state, performs the atomic state transition, and returns a structured accepted or rejected result.

Do not expose a generic `set_state(path, value)` interface. The command boundary should preserve domain invariants and allow internal state structures to evolve.

### Snapshots, revisions, and deltas

The frontend obtains an initial session snapshot and then consumes revisioned deltas.

Every accepted authoritative transition increments the session revision. A delta identifies:

- The session identity.
- The previous and resulting revision, or enough information to detect a gap.
- The changed entities or operation state.

When the frontend sees a different session identity, an unexpected revision, or an event it cannot safely apply, it requests a fresh snapshot instead of attempting to repair state heuristically.

Events describe changes to backend-retained state. They are not the sole surviving copy of scan or operation results.

The protocol should support bounded batches so streaming scans and progress updates remain responsive without excessive IPC traffic.

### Concurrency and locking

Do not hold a global session lock during directory traversal, ExifTool execution, thumbnail generation, network calls, or disk persistence.

Long-running work follows this pattern:

1. Under a short lock, capture the session and operation identity plus the inputs required for work.
2. Release the lock.
3. Perform expensive work.
4. Reacquire the relevant state lock.
5. Commit the result only if the session and operation identity are still current.
6. Record the authoritative state transition and emit its delta.

The backend may use separate stores or locks for files, drafts, operations, and caches where useful. "Single authoritative session" describes ownership and consistency, not a requirement for one monolithic mutex.

### Thumbnail transport

Rust owns thumbnail status and cache identity, not necessarily thumbnail bytes inside the main session snapshot.

A file's authoritative thumbnail state may be equivalent to:

- not requested;
- queued;
- ready with a cache key or version;
- failed with a reason.

The frontend can load actual thumbnail data through an asset protocol, cache URL, or focused command. Existing per-row subscription techniques can remain as presentation optimisations.

### Domain planning

Planning rules that determine whether and how metadata state may change belong in Rust because Rust already owns the schema registry, occurrence identity, write-target validation, draft persistence, and apply boundary.

This includes the authoritative planning for:

- Exact existing-occurrence edits.
- New-property edits.
- Field and group removal.
- GPS composite edits.
- Generated metadata from describe, geocode, and normalise.
- Bulk metadata changes.

The frontend may render a backend-produced preview and collect user choices, but it must not independently construct the authoritative mutation plan.

### Draft persistence

An accepted draft command updates the authoritative Rust draft repository and its visible session state as one logical operation.

The frontend must not maintain its own authoritative dirty-row ledger, save revision map, autosave gate, or persistence queue. Rust may still coalesce disk writes internally, provided it exposes truthful persistence status and guarantees recovery semantics.

The exact durability contract should be explicit for each command. The UI must be able to distinguish accepted-and-durable, accepted-but-pending-persistence, and rejected states if asynchronous persistence is retained.

### Operations and issues

Long-running operations are backend-owned records with stable operation identities. Their phase, progress, cancellation state, failures, warnings, and completion summary are authoritative Rust state.

The frontend renders these records and sends commands against their identities. It should not combine command promises and event streams into a second inferred operation state machine.

Application issues and verification outcomes also have stable backend identities. The frontend dismisses or resolves them by identity.

## Frontend-Owned State

The following remains frontend-owned unless a later requirement provides a specific reason to move it:

- Selected row or rows.
- Current gallery item and gallery visibility.
- Open dialogs, menus, and tabs.
- In-progress text or form input not yet submitted as a domain command.
- Scroll position and viewport information.
- Column visibility, widths, and sorting preferences.
- Local confirmation-dialog state.
- Formatting and presentation-only grouping.
- Clearly marked optimistic presentation state while awaiting command acceptance.

Sorting may remain frontend-side while the complete file collection is practical to hold in the webview. Backend sorting and paging can be introduced later if library size requires it; they are not prerequisites for authoritative ownership.

## Migration Principles

### Vertical slices, not parallel replacement

Each migration commit must move one coherent behaviour across the boundary end to end:

- Rust state and command or query support.
- Protocol types.
- Frontend consumption.
- Relevant tests.
- Removal of the replaced frontend authority in the same slice, or in an immediately adjacent cleanup commit that leaves no alternative active path.

Do not first implement the complete target architecture in Rust while leaving the current frontend model active. Avoid long-lived duplicate implementations and feature flags that allow both sides to remain authoritative.

A slice may introduce a small reusable protocol or store abstraction needed by later slices, but it must be exercised by the behaviour migrated in that same commit.

### Atomic commits

Each commit should:

- Have one architectural purpose.
- Leave the application working.
- Keep tests passing.
- Remove superseded production code where the slice makes it obsolete.
- Avoid unrelated refactoring.
- Be reviewable independently from later planned work.

Tests may be reorganised as part of the slice they validate, but do not perform broad speculative test rewrites in advance.

### Preserve behaviour before simplifying it

The initial goal of each slice is to preserve externally visible behaviour while changing ownership. Once Rust is authoritative and the old path is removed, a later focused commit may simplify the protocol or UI.

Do not combine ownership migration with product behaviour changes unless the old behaviour cannot be represented safely.

### Backend rejects stale commands

Commands that depend on current state carry the required session, operation, entity, or revision identity. Rust rejects stale commands explicitly. The frontend refreshes its projection rather than silently retargeting the user's action.

### Generated shared types

Wire types should be generated from Rust wherever practical. TypeScript must not maintain hand-written competing definitions for authoritative protocol entities.

Presentation-only types may remain local to TypeScript.

### Recovery is part of every slice

For each migrated area, tests must cover reconstruction from a snapshot or equivalent authoritative query, not only the happy-path delta stream. A frontend remount must not be able to lose accepted domain state.

## Updated Implementation Plan

The sequence below is deliberately ordered so that each step provides immediate architectural value without requiring a dormant parallel backend implementation.

Exact commit boundaries may be adjusted when inspection reveals a smaller safe slice, but every commit must follow the vertical-slice and atomicity principles above.

### Phase 1: Establish the session protocol through one small live slice

#### Slice 1: Session identity and lifecycle

Move active-folder lifecycle authority to a minimal Rust session:

- Rust owns idle, opening, loaded, and closing state, the active folder, session identity, and revision.
- Add a snapshot query and lifecycle delta event.
- `openFolder`, `openRecent`, and `closeFolder` become commands against the Rust session.
- The frontend renders folder lifecycle from the snapshot and deltas.
- Remove frontend authority for active folder and scan lifecycle generation where superseded.

This slice proves the snapshot/revision/delta path in production. Do not create a larger unused session model in advance.

#### Slice 2: Scan progress and file discovery

Extend the live session to retain discovered files and directory-walk progress:

- Rust inserts file records into session state before emitting deltas.
- Snapshot reconstruction includes all files discovered so far and whether discovery is still running.
- Frontend file buffers become projection batching only.
- Remove frontend file-list and scan-completion authority that is now recoverable from Rust.

Retain streaming behaviour and visible-file queue prioritisation.

#### Slice 3: Scan issues

Move scanner and worker issues into Rust session state with stable issue IDs:

- Snapshot and deltas expose issues.
- Dismissal is a backend command.
- Remove the frontend-owned capped application-error list and current-scan filtering rules that Rust can perform authoritatively.

Keep UI rendering and message formatting in TypeScript.

### Phase 2: Move per-file scan products

#### Slice 4: Metadata occurrence status and values

Rust retains per-file metadata states: queued/loading, ready occurrences, or failed.

- Metadata worker results commit to the session before deltas are emitted.
- Snapshot reconstruction includes current metadata state.
- Existing frontend occurrence stores become disposable projections.
- Remove frontend completion membership and failure authority replaced by Rust.

Preserve exact occurrence identity and current per-row subscriptions.

#### Slice 5: Thumbnail status and cache identity

Rust retains thumbnail state and exposes a stable way to retrieve ready thumbnail data.

- Snapshot reconstruction includes status and cache key/version.
- Frontend `ThumbnailStore` becomes a projection/cache adapter.
- Remove any frontend-only thumbnail lifecycle authority.

Do not put large image payloads into the general session snapshot.

#### Slice 6: Post-write metadata supersession

Move the rule that apply readback supersedes older scan metadata into Rust:

- Both scan and apply results commit through the same per-file authoritative metadata state.
- Session and operation identities prevent late scan work from replacing fresher apply readback.
- Remove frontend `metadataCompletedPaths` and `scanMetadataSupersededPaths` reconciliation.

This slice should leave the frontend unaware of the relative ordering of scan and apply metadata sources.

### Phase 3: Make draft state authoritative

#### Slice 7: Draft snapshot and exact single-target mutations

Use the existing Rust draft repository as authoritative session state for the simplest complete edit path:

- Snapshot includes drafts and persistence status.
- Add commands for setting and discarding one exact existing-occurrence or new-property draft.
- Rust validates, mutates, and persists the command atomically according to an explicit durability contract.
- Convert the ordinary single-field editor to the new commands.
- Remove the corresponding frontend store mutation and autosave path.

Do not migrate all planners before this slice is used by a real editor.

#### Slice 8: Draft persistence lifecycle

Migrate remaining generic persistence ownership:

- Rust owns pending writes, coalescing if retained, load failure, save failure, and flush-on-close behaviour.
- Frontend displays backend persistence state.
- Remove `TargetDraftAutosaveGate`, the frontend dirty-row revision map, coalescing save queue, and direct row-save orchestration once no active path needs them.

This may be split by draft path if some editors still use the old mechanism; no commit should leave one logical draft mutation owned by both sides.

#### Slice 9: Draft discard and replacement workflows

Move multi-target discard and new-property replacement commands to Rust, converting the corresponding UI workflows and deleting their frontend mutation logic.

### Phase 4: Move metadata planners one workflow at a time

Each planner slice includes backend preview/stage commands, frontend adoption, tests, and removal of the superseded TypeScript production planner.

#### Slice 10: Metadata removal

Move exact-target, selected-photo field, and group removal planning to Rust. Preserve blocking reasons and atomic preview/replan semantics.

Split this into smaller commits if one removal workflow can migrate independently without duplicating shared authority.

#### Slice 11: GPS composite editing

Move composite GPS validation and authoritative draft planning to Rust. The frontend continues to own map interaction and unsent editor input.

#### Slice 12: Generated describe staging

Move generated-edit allowlisting and planning for image description to Rust. Convert the describe completion path to send backend results into a Rust staging command.

#### Slice 13: Generated reverse-geocode staging

Apply the same authoritative staging boundary to reverse geocoding, removing its frontend planner path.

#### Slice 14: Generated normalise staging

Apply the same boundary to normalise, preserving the immutable confirmed group snapshot and effective-metadata semantics.

#### Slice 15: Bulk metadata editing

Move bulk preview and stage planning to Rust. The frontend renders the returned preview and submits the confirmed plan identity or command.

Avoid one large commit that migrates every planner simultaneously. Shared Rust planner primitives should emerge from the first migrated workflow and be extended by later slices.

### Phase 5: Make apply and verification session-owned

#### Slice 16: Apply operation state

Represent apply as a Rust-owned operation record:

- Stable operation ID.
- Requested scope.
- Phase and progress.
- Cancellation state.
- Failure and warning counts.
- Completion summary.

The frontend subscribes to operation state and sends apply/cancel commands. Remove inferred duplicate apply state from `TargetApplyController` as each responsibility becomes redundant.

#### Slice 17: Apply result projection

Move progress-result application fully behind the Rust session transition:

- Draft reconciliation, occurrence replacement, and issue creation update authoritative state before the delta.
- Frontend no longer interprets apply protocol chunks as domain mutations.
- Protocol messages become operation/session deltas or an internal backend implementation detail.

#### Slice 18: Verification outcomes

Store verification outcomes in Rust with stable identities and commands for accept, keep draft, discard draft, and dismiss.

Remove `TargetVerifyOutcomesStore` as an authoritative frontend store; retain only a projection if it remains useful for rendering.

### Phase 6: Other backend jobs

#### Slice 19: Describe operation state

Move describe estimate, confirmation-ready state, progress, cancellation, issues, and result summary into a Rust-owned operation projection. Keep dialog visibility and unsent user choices in React.

#### Slice 20: Reverse-geocode operation state

Do the same for reverse geocoding.

#### Slice 21: Normalise operation state

Do the same for normalise, including group and per-image progress.

These slices concern operation ownership. Their metadata staging planners should already have moved in earlier workflow-specific slices.

### Phase 7: Consolidation

#### Slice 22: Thin `useMediaLibrary`

Once the preceding authorities have moved, reduce `useMediaLibrary` to:

- Subscribe to session snapshots and deltas.
- Maintain the disposable frontend projection.
- Dispatch typed backend commands.
- Own UI-only state and selectors.

Delete obsolete controllers, refs, buffers, and stores. Do not retain compatibility layers without an active caller.

#### Slice 23: Frontend remount recovery

Add an end-to-end recovery test that remounts or reloads the frontend during representative states:

- Active scan.
- Loaded metadata and thumbnails.
- Pending drafts.
- Active apply or another operation where technically supported.
- Verification outcomes and issues.

The reconstructed UI must match the Rust snapshot without relying on old frontend memory.

#### Slice 24: Architectural enforcement

Add focused boundary tests or source-level regression checks only where they protect a real production boundary, for example:

- Domain mutation commands are implemented in Rust.
- Frontend production code does not call removed draft-persistence commands directly.
- Authoritative wire types remain Rust-generated.

Avoid tests that merely assert wording in this document.

## Completion Record

All seven migration phases and all 24 slices are implemented in production.

- The Rust session snapshot retains lifecycle, files, discovery state, issues, metadata occurrences, thumbnail cache identities, exact-target drafts, persistence state, apply state and diagnostics, verification outcomes, and generated batch operations.
- Revisioned events update disposable frontend projections; session changes or revision gaps trigger snapshot recovery rather than heuristic repair.
- Metadata planning, draft mutation and persistence, apply reconciliation, verification resolution, and generated-workflow staging are Rust commands.
- Scan-start failures are committed as a Rust-owned `failed` lifecycle with stable issue identities, so reload cannot reconstruct a false loaded session.
- Generated batch jobs retain their session ID, operation ID, requested paths, and confirmation request in Rust. Describe, geocode, and normalise resume only that exact operation, and Rust stages generated drafts before committing final success and failure summaries.
- Application issues are recorded in the Rust session with stable IDs; the frontend does not create unrecoverable anonymous issue rows.
- `useMediaLibrary` subscribes, projects, dispatches commands, and owns UI-only state; obsolete autosave, scan-buffer and apply-controller state machines have been removed.
- Mount/recovery tests reconstruct representative scan, metadata, thumbnail, draft, apply, verification, issue, and batch-operation state from Rust alone.
- Architectural tests prevent removed frontend authorities and legacy mutation paths from returning, while authoritative wire types remain generated from Rust.

## Per-Slice Review Checklist

Before accepting each migration slice, verify:

- Rust is authoritative for the migrated behaviour.
- The frontend projection can be rebuilt from Rust.
- The old production authority has been removed for that behaviour.
- No command can silently act on stale session or entity state.
- Expensive work occurs outside long-held state locks.
- State commits and emitted deltas have a clear ordering.
- IPC remains batched where high-frequency updates are possible.
- Focused Rust domain tests cover accepted, rejected, stale, and cancellation cases as relevant.
- Frontend tests cover rendering and command dispatch rather than reimplementing backend invariants.
- Existing user-visible behaviour is preserved unless the commit explicitly documents a necessary change.
- The commit is self-contained, test-passing, and free of unrelated edits.

## Non-Goals

This migration does not require:

- Rewriting all frontend components in one pass.
- Moving presentation formatting into Rust.
- Moving unsent form input into Rust.
- Eliminating efficient frontend caches or observable stores.
- Waiting for a complete scan before displaying files.
- Sending thumbnail bytes in every session snapshot.
- Introducing backend paging or sorting before scale requires it.
- Replacing Tauri's event mechanism solely for architectural purity.

## Decision Summary

The application will migrate towards a Rust-authoritative session through small vertical slices. Each slice must put a real production behaviour on the new boundary and remove the replaced frontend authority at the same time. The repository must never spend a prolonged period with a complete unused Rust replacement alongside the active frontend implementation.

This document should be updated when an implementation slice reveals that the final design or sequence must change. Such updates should explain the architectural decision and remain separate from unrelated production changes where practical.
