// ── Generated wire-shape types ────────────────────────────────────────────────
//
// These are re-exports of types generated from Rust by ts-rs (see
// docs/GENERATED_TYPES.md). Do not hand-edit the originals in
// `src/types/generated/`; regenerate with:
// cargo test --manifest-path src-tauri/Cargo.toml

import type { PhotoInfo } from "./types/generated/PhotoInfo";
import { schemaDefinitionIdToken } from "./utils/schemaDefinitionId";
import type { MetadataValue } from "./types/generated/MetadataValue";
import type { MetadataDraftEdit } from "./types/generated/MetadataDraftEdit";
import type { SchemaDefinitionId } from "./types/generated/SchemaDefinitionId";
import type { MetadataOccurrences } from "./types/generated/MetadataOccurrences";
import type { ImageMetadata } from "./types/generated/ImageMetadata";
import { KNOWN_METADATA_IDS as ID } from "./metadata/knownIds";
import type {
  TargetDraftEditsByFile,
  TargetDraftEditsStore,
} from "./targetDraftEdits";
import type { TargetApplyControllerStateV5 } from "./targetApplyController";

export type { PhotoInfo };
export type { MetadataValue } from "./types/generated/MetadataValue";
export type { SchemaDefinitionId } from "./types/generated/SchemaDefinitionId";
export type { MetadataOccurrenceId } from "./types/generated/MetadataOccurrenceId";
export type { MetadataWriteTarget } from "./types/generated/MetadataWriteTarget";
export type { MetadataOccurrence } from "./types/generated/MetadataOccurrence";
export type { MetadataOccurrences } from "./types/generated/MetadataOccurrences";
export type { MetadataDraftTarget } from "./types/generated/MetadataDraftTarget";
export type { MetadataDraftReconciliation } from "./types/generated/MetadataDraftReconciliation";
export type { MetadataTargetOutcome } from "./types/generated/MetadataTargetOutcome";
export type { MetadataEntry } from "./types/generated/MetadataEntry";
export type { MetadataDraftEntry } from "./types/generated/MetadataDraftEntry";
export type { MetadataDraftEntryV5 } from "./types/generated/MetadataDraftEntryV5";
export type { MetadataDraftEdit } from "./types/generated/MetadataDraftEdit";
export type { MetadataTagOutcome } from "./types/generated/MetadataTagOutcome";
export type { DateValue } from "./types/generated/DateValue";
export type { TimeValue } from "./types/generated/TimeValue";
export type { DateTimeValue } from "./types/generated/DateTimeValue";
export type { UtcOffsetValue } from "./types/generated/UtcOffsetValue";
export type { OffsetSign } from "./types/generated/OffsetSign";
export type { ListKind } from "./types/generated/ListKind";
export type { RationalValue } from "./types/generated/RationalValue";
export type { TagInfo } from "./types/generated/TagInfo";
export type { TagKind } from "./types/generated/TagKind";
export type { EnumOption } from "./types/generated/EnumOption";
export type { EnumRepr } from "./types/generated/EnumRepr";
export type { EditIntent } from "./types/generated/EditIntent";
export type { ImageMetadata } from "./types/generated/ImageMetadata";
export type { MetadataApplyEditsResult } from "./types/generated/MetadataApplyEditsResult";
export type { MetadataApplyFileResultV5 } from "./types/generated/MetadataApplyFileResultV5";
export type { MetadataApplyEditsResultV5 } from "./types/generated/MetadataApplyEditsResultV5";
export type { ApplyEditsV5StartedPayload } from "./types/generated/ApplyEditsV5StartedPayload";
export type { MetadataApplyEditsProgressPayloadV5 } from "./types/generated/MetadataApplyEditsProgressPayloadV5";
export type { FailedFile as ApplyEditsFailedFile } from "./types/generated/FailedFile";
export type { BatchFailureKind } from "./types/generated/BatchFailureKind";
import type { BatchFailureKind } from "./types/generated/BatchFailureKind";

// ── Metadata normalisation (see docs/NORMALISE_METADATA_PLAN.md) ─────────────
export type { NormaliseGroup } from "./types/generated/NormaliseGroup";
import type { NormaliseGroup } from "./types/generated/NormaliseGroup";
export type { NormaliseRequestItem } from "./types/generated/NormaliseRequestItem";
export type { GroupInputs as NormaliseGroupInputs } from "./types/generated/GroupInputs";
export type { KeywordsInput } from "./types/generated/KeywordsInput";
export type { CreatorInput } from "./types/generated/CreatorInput";
export type { CopyrightInput } from "./types/generated/CopyrightInput";
export type { HeadlineInput } from "./types/generated/HeadlineInput";
export type { TitleInput } from "./types/generated/TitleInput";
export type { LocationInput } from "./types/generated/LocationInput";
export type { DatesInput } from "./types/generated/DatesInput";
export type { DescriptionInput } from "./types/generated/DescriptionInput";
export type { LocationContext } from "./types/generated/LocationContext";
export type { PerImageStats as NormalisePerImageStats } from "./types/generated/PerImageStats";
export type { PerGroupStats as NormalisePerGroupStats } from "./types/generated/PerGroupStats";
export type { NormaliseSummary } from "./types/generated/NormaliseSummary";

// ── Thumbnail store ───────────────────────────────────────────────────────────

export type ThumbnailState = "loading" | "failed" | string;

/**
 * Observable store for thumbnail data, keyed by relative_path.
 * Lives outside React state so thumbnail_ready events update only the
 * individual row that changed, not the entire photo list.
 */
export class ThumbnailStore {
  private data = new Map<string, ThumbnailState>();
  private subscribers = new Map<string, Set<() => void>>();

  reset(paths: string[]) {
    this.data.clear();
    this.subscribers.clear();
    for (const p of paths) this.data.set(p, "loading");
  }

  add(path: string) {
    if (!this.data.has(path)) this.data.set(path, "loading");
  }

  set(path: string, value: ThumbnailState) {
    this.data.set(path, value);
    this.subscribers.get(path)?.forEach((cb) => cb());
  }

  get(path: string): ThumbnailState {
    return this.data.get(path) ?? "loading";
  }

  subscribe(path: string, callback: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(callback);
    return () => {
      const set = this.subscribers.get(path);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) this.subscribers.delete(path);
    };
  }

  getSnapshot(path: string): () => ThumbnailState {
    return () => this.get(path);
  }
}

// ── Image Metadata store ──────────────────────────────────────────────────────

/**
 * Image metadata state for a single photo (EXIF, etc):
 *  - "loading"                 — metadata read is in progress (show spinner in cells)
 *  - MetadataCollection — exact-ID metadata has arrived
 */
export type ImageMetadataEntry = MetadataValue & {
  readonly id: import("./types/generated/SchemaDefinitionId").SchemaDefinitionId;
};
export type ImageMetadataState =
  "loading" | import("./utils/metadataCollection").MetadataCollection;

/**
 * Observable store for image-level metadata, keyed by relative_path.
 * Updates only re-render the affected row.
 */
export type ImageMetadataListener = (
  path: string,
  value: ImageMetadataState,
) => void;

export class ImageMetadataStore {
  private data = new Map<string, ImageMetadataState>();
  private subscribers = new Map<string, Set<() => void>>();
  private globalSubscribers = new Set<ImageMetadataListener>();

  add(path: string) {
    if (!this.data.has(path)) {
      this.data.set(path, "loading");
      this.globalSubscribers.forEach((cb) => cb(path, "loading"));
    }
  }

  set(path: string, value: ImageMetadataState) {
    this.data.set(path, value);
    this.subscribers.get(path)?.forEach((cb) => cb());
    this.globalSubscribers.forEach((cb) => cb(path, value));
  }

  /** Iterate every (path, value) pair currently in the store. */
  entries(): IterableIterator<[string, ImageMetadataState]> {
    return this.data.entries();
  }

  get(path: string): ImageMetadataState {
    return this.data.get(path) ?? "loading";
  }

  /** Clear folder-owned data while preserving this production store instance. */
  clear(): void {
    const paths = Array.from(this.data.keys());
    this.data.clear();
    for (const path of paths) {
      this.subscribers.get(path)?.forEach((cb) => cb());
      this.globalSubscribers.forEach((cb) => cb(path, "loading"));
    }
  }

  subscribe(path: string, callback: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(callback);
    return () => {
      const set = this.subscribers.get(path);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) this.subscribers.delete(path);
    };
  }

  /**
   * Subscribe to every mutation in the store.  Used by cross-cutting consumers
   * (e.g. the search-worker index) that need to track all paths without
   * per-row subscription bookkeeping.  Fires from both `add()` (with
   * "loading") and `set()`.
   */
  subscribeAll(callback: ImageMetadataListener): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  getSnapshot(path: string): () => ImageMetadataState {
    return () => this.get(path);
  }
}

// ── Authoritative metadata occurrence store ──────────────────────────────────

export type ImageMetadataOccurrencesState = "loading" | MetadataOccurrences;

/** Observable occurrence collection keyed by file-relative path. */
export class ImageMetadataOccurrencesStore {
  private data = new Map<string, ImageMetadataOccurrencesState>();
  private subscribers = new Map<string, Set<() => void>>();

  add(path: string): void {
    if (!this.data.has(path)) this.data.set(path, "loading");
  }

  set(path: string, value: ImageMetadataOccurrencesState): void {
    this.data.set(path, value);
    this.subscribers.get(path)?.forEach((callback) => callback());
  }

  get(path: string): ImageMetadataOccurrencesState {
    return this.data.get(path) ?? "loading";
  }

  /** Clear folder-owned data while preserving controller/store identity. */
  clear(): void {
    const paths = Array.from(this.data.keys());
    this.data.clear();
    for (const path of paths) {
      this.subscribers.get(path)?.forEach((callback) => callback());
    }
  }

  entries(): IterableIterator<[string, ImageMetadataOccurrencesState]> {
    return this.data.entries();
  }

  subscribe(path: string, callback: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(callback);
    return () => {
      const callbacks = this.subscribers.get(path);
      if (!callbacks) return;
      callbacks.delete(callback);
      if (callbacks.size === 0) this.subscribers.delete(path);
    };
  }

  getSnapshot(path: string): () => ImageMetadataOccurrencesState {
    return () => this.get(path);
  }
}

// ── Metadata Progress store ───────────────────────────────────────────────────

/**
 * Observable store for tracking metadata loading progress.
 * Separate from React state to avoid triggering re-renders of the entire component tree.
 */
export class MetadataProgressStore {
  private totalPhotos = 0;
  private receivedCount = 0;
  private subscribers = new Set<() => void>();

  reset() {
    this.totalPhotos = 0;
    this.receivedCount = 0;
    this.notifySubscribers();
  }

  setTotal(total: number) {
    this.totalPhotos = total;
    this.notifySubscribers();
  }

  incrementReceived(count: number = 1) {
    this.receivedCount += count;
    this.notifySubscribers();
  }

  getRemaining(): number {
    return Math.max(0, this.totalPhotos - this.receivedCount);
  }

  getTotal(): number {
    return this.totalPhotos;
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getSnapshot(): () => number {
    return () => this.getRemaining();
  }

  getTotalSnapshot(): () => number {
    return () => this.totalPhotos;
  }

  private notifySubscribers() {
    // Use queueMicrotask to defer notifications until after the current render
    queueMicrotask(() => {
      this.subscribers.forEach((cb) => cb());
    });
  }
}

// ── Columns ───────────────────────────────────────────────────────────────────

export type OsColumnKey = "date_modified" | "date_created";
export type VisibleColumn =
  { kind: "os"; key: OsColumnKey } | { kind: "image"; id: SchemaDefinitionId };

// ── Sorting ───────────────────────────────────────────────────────────────────

export type SortDirection = "asc" | "desc";
export type SortKey =
  | { kind: "path"; direction: SortDirection }
  | { kind: "os"; key: OsColumnKey; direction: SortDirection }
  | { kind: "image"; id: SchemaDefinitionId; direction: SortDirection };

export interface SortConfig {
  primary: SortKey | null;
  secondary: SortKey | null;
}

// ── Draft Edits ───────────────────────────────────────────────────────────────

export interface MetadataDraftCollectionEntry {
  id: SchemaDefinitionId;
  edit: MetadataDraftEdit;
}

/** Token-keyed only for JS collection mechanics; every value retains its domain ID. */
export type MetadataDraftCollection = Record<
  string,
  MetadataDraftCollectionEntry
>;
export type MetadataDraftEditsByFile = Record<string, MetadataDraftCollection>;

export function metadataDraftsFromWire(
  wire: Record<
    string,
    import("./types/generated/MetadataDraftEntry").MetadataDraftEntry[]
  >,
): MetadataDraftEditsByFile {
  return Object.fromEntries(
    Object.entries(wire).map(([path, entries]) => [
      path,
      Object.fromEntries(
        (entries ?? []).map(({ id, edit }) => [
          schemaDefinitionIdToken(id),
          { id, edit },
        ]),
      ),
    ]),
  );
}

export function metadataDraftsToWire(
  drafts: MetadataDraftEditsByFile,
): Record<
  string,
  import("./types/generated/MetadataDraftEntry").MetadataDraftEntry[]
> {
  return Object.fromEntries(
    Object.entries(drafts).map(([path, edits]) => [
      path,
      Object.values(edits).map(({ id, edit }) => ({ id, edit })),
    ]),
  );
}

/**
 * Per-mutation change record passed to DraftEditsStore subscribers.
 * `edits` is the new per-tag map after the mutation, or `undefined` if the
 * entire file's drafts were removed.
 */
export interface DraftEditsChange {
  path: string;
  edits: MetadataDraftCollection | undefined;
}

export type DraftEditsListener = (changes: DraftEditsChange[]) => void;

/**
 * Outcome of a single `setTag` / `setBatch` write.
 *
 * - "written" — value differs from current metadata, draft was added
 *   or replaced an existing draft.
 * - "redundant" — Set intent whose value equals current metadata and
 *   no existing draft was present; nothing changed.
 * - "cleared" — Set intent whose value equals current metadata, but an
 *   existing draft was present for this tag; the existing draft was
 *   removed so the UI no longer shows a confusing same-as-current
 *   draft.
 *
 * Non-Set intents (Delete / ListAdd / ListRemove) always return
 * "written"; the store can't cheaply compare list-mutation semantics
 * against current metadata, so those go through unchanged.
 */
export type SetDraftOutcome = "written" | "redundant" | "cleared";

/**
 * Deep structural equality for semantic `MetadataValue` entries.  Used by
 * the redundant-draft guard to compare a proposed Set value against the
 * tag's current effective value. Object keys are compared
 * order-independently.
 */
export function metadataValueEqual(
  a: MetadataValue | undefined,
  b: MetadataValue | undefined,
): boolean {
  const av = metadataEntryToComparableValue(a);
  const bv = metadataEntryToComparableValue(b);
  return deepEqual(av, bv);
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in b)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function metadataEntryToComparableValue(value: MetadataValue | undefined): any {
  if (!value) return undefined;
  switch (value.kind) {
    case "Null":
      return null;
    case "Text":
    case "Bool":
    case "Integer":
    case "Real":
      return value.value;
    case "Rational":
      return value.value.denominator === 0
        ? null
        : value.value.numerator / value.value.denominator;
    case "List":
      return value.value.items.map(
        (item) => metadataEntryToComparableValue(item) ?? null,
      );
    case "Struct":
      return Object.fromEntries(
        Object.entries(value.value).map(([k, v]) => [
          k,
          metadataEntryToComparableValue(v),
        ]),
      );
    default:
      return JSON.stringify(value);
  }
}

/**
 * Single source of truth for draft edits.  All user-initiated mutations funnel
 * through methods on this class so subscribers (React-state sync, persistence,
 * future search-worker index) stay in sync without per-call-site discipline.
 *
 * `resetMetadata()` is silent — used during scan initialization to seed the
 * store from disk. Every other mutator notifies subscribers exactly once with
 * the list of changed paths (undefined-valued edits = path deleted).
 *
 * Redundant-draft guard: when a `currentValueResolver` is registered
 * (via `setCurrentValueResolver`), `setMetadataTag` / `setMetadataBatch`
 * compare each Set-intent value against the tag's current metadata. Same
 * value → no draft is written (and any existing draft for that tag is
 * removed). Callers receive a per-key outcome so they can log or aggregate
 * what was dropped (see `SetDraftOutcome`).
 */
export class DraftEditsStore {
  private snapshot: MetadataDraftEditsByFile = {};
  private listeners = new Set<DraftEditsListener>();
  private currentValueResolver?: (
    path: string,
    id: SchemaDefinitionId,
  ) => MetadataValue | undefined;

  /**
   * Wire up the redundant-draft guard. Pass a function that returns
   * the tag's current effective metadata value for the given file, or
   * `undefined` when the file has no value for that tag. Without a
   * resolver the store behaves as it always did (writes always land).
   */
  setCurrentValueResolver(
    fn: (path: string, id: SchemaDefinitionId) => MetadataValue | undefined,
  ) {
    this.currentValueResolver = fn;
  }

  /** Bulk replace with semantic drafts. Silent — does not fire subscribers. */
  resetMetadata(initial: MetadataDraftEditsByFile) {
    this.snapshot = initial;
  }

  /** Returns the current immutable snapshot.  Reference changes on every mutation. */
  getAllMetadata(): MetadataDraftEditsByFile {
    return this.snapshot;
  }

  getMetadataFile(path: string): MetadataDraftCollection | undefined {
    return this.snapshot[path];
  }

  /**
   * Apply one write to the snapshot in-place and return its outcome.
   * Caller is responsible for notifying subscribers exactly once after
   * a logical mutation (single setTag, or one setBatch).
   */
  private applyOne(
    path: string,
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ): SetDraftOutcome {
    const token = schemaDefinitionIdToken(id);
    const existingDraft = this.snapshot[path]?.[token];
    // Only the Set intent can produce a "value identical to current
    // metadata" situation worth guarding against. List add / list
    // remove operate on the current list; Delete is the user
    // explicitly asking to clear a tag (and we trust them).
    if (edit.intent === "Set" && this.currentValueResolver) {
      const current = this.currentValueResolver(path, id);
      if (metadataValueEqual(current, edit.value ?? undefined)) {
        if (existingDraft) {
          // Existing draft becomes redundant — remove it so the user
          // doesn't see a "pending change" that wouldn't actually
          // change anything.
          const fileEdits = { ...(this.snapshot[path] ?? {}) };
          delete fileEdits[token];
          const next = { ...this.snapshot };
          if (Object.keys(fileEdits).length === 0) delete next[path];
          else next[path] = fileEdits;
          this.snapshot = next;
          return "cleared";
        }
        return "redundant";
      }
    }
    const fileEdits = {
      ...(this.snapshot[path] ?? {}),
      [token]: { id, edit },
    };
    this.snapshot = { ...this.snapshot, [path]: fileEdits };
    return "written";
  }

  setMetadataTag(
    path: string,
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ): SetDraftOutcome {
    const outcome = this.applyOne(path, id, edit);
    if (outcome !== "redundant") {
      this.notify([{ path, edits: this.snapshot[path] }]);
    }
    return outcome;
  }

  setMetadataBatch(
    path: string,
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ): Array<{ id: SchemaDefinitionId; outcome: SetDraftOutcome }> {
    if (edits.length === 0) return [];
    const results: Array<{ id: SchemaDefinitionId; outcome: SetDraftOutcome }> =
      [];
    for (const { id, edit } of edits) {
      results.push({ id, outcome: this.applyOne(path, id, edit) });
    }
    if (results.some((r) => r.outcome !== "redundant")) {
      this.notify([{ path, edits: this.snapshot[path] }]);
    }
    return results;
  }

  deleteTag(path: string, id: SchemaDefinitionId) {
    const tag = schemaDefinitionIdToken(id);
    const fileEdits = this.snapshot[path];
    if (!fileEdits || !(tag in fileEdits)) return;
    const updated = { ...fileEdits };
    delete updated[tag];
    const next = { ...this.snapshot };
    if (Object.keys(updated).length === 0) {
      delete next[path];
      this.snapshot = next;
      this.notify([{ path, edits: undefined }]);
    } else {
      next[path] = updated;
      this.snapshot = next;
      this.notify([{ path, edits: updated }]);
    }
  }

  /**
   * User-initiated bulk draft discard (unlike pruneTags which handles backend verify updates).
   * Drops the listed tags and notifies subscribers once.
   */
  deleteTags(path: string, ids: SchemaDefinitionId[]) {
    const fileEdits = this.snapshot[path];
    if (!fileEdits || ids.length === 0) return;

    const updated = { ...fileEdits };
    let touched = false;

    for (const tag of ids.map(schemaDefinitionIdToken)) {
      if (tag in updated) {
        delete updated[tag];
        touched = true;
      }
    }

    if (!touched) return;

    const next = { ...this.snapshot };
    if (Object.keys(updated).length === 0) {
      delete next[path];
      this.snapshot = next;
      this.notify([{ path, edits: undefined }]);
    } else {
      next[path] = updated;
      this.snapshot = next;
      this.notify([{ path, edits: updated }]);
    }
  }

  deletePath(path: string) {
    if (!this.snapshot[path]) return;
    const next = { ...this.snapshot };
    delete next[path];
    this.snapshot = next;
    this.notify([{ path, edits: undefined }]);
  }

  deletePaths(paths: string[]) {
    const existing = paths.filter((p) => this.snapshot[p]);
    if (existing.length === 0) return;
    const next = { ...this.snapshot };
    for (const p of existing) delete next[p];
    this.snapshot = next;
    this.notify(existing.map((p) => ({ path: p, edits: undefined })));
  }

  clear() {
    const paths = Object.keys(this.snapshot);
    if (paths.length === 0) return;
    this.snapshot = {};
    this.notify(paths.map((p) => ({ path: p, edits: undefined })));
  }

  /**
   * Phase 8.1 apply path: drop the listed tags after backend verification said
   * they landed cleanly.  No-op if the file or tags are missing.
   */
  pruneTags(path: string, idsToDelete: SchemaDefinitionId[]) {
    const fileEdits = this.snapshot[path];
    if (!fileEdits) return;
    const updated = { ...fileEdits };
    let touched = false;
    for (const t of idsToDelete.map(schemaDefinitionIdToken)) {
      if (t in updated) {
        delete updated[t];
        touched = true;
      }
    }
    if (!touched) return;
    const next = { ...this.snapshot };
    if (Object.keys(updated).length === 0) {
      delete next[path];
      this.snapshot = next;
      this.notify([{ path, edits: undefined }]);
    } else {
      next[path] = updated;
      this.snapshot = next;
      this.notify([{ path, edits: updated }]);
    }
  }

  subscribe(fn: DraftEditsListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(changes: DraftEditsChange[]) {
    this.listeners.forEach((cb) => cb(changes));
  }
}

// ── App state ─────────────────────────────────────────────────────────────────

export type AppState =
  | { kind: "idle" }
  | {
      kind: "loading";
      folder: string;
      visibleColumns: VisibleColumn[];
      columnWidths: Record<string, number>;
      sortConfig: SortConfig;
    }
  | {
      kind: "loaded";
      folder: string;
      photos: PhotoInfo[];
      thumbnails: ThumbnailStore;
      imageMetadata: ImageMetadataStore;
      imageMetadataOccurrences: ImageMetadataOccurrencesStore;
      metadataProgress: MetadataProgressStore;
      scanning: boolean; // true while the directory walk is still running
      galleryIndex: number | null;
      selectedIndex: number | null;

      // Unified, ordered list of metadata columns (mix of OS and image kinds)
      visibleColumns: VisibleColumn[];

      // Column widths (pixels); absent key means use CSS default
      columnWidths: Record<string, number>;

      // Sorting
      sortConfig: SortConfig;
      metadataVersion: number; // Incremented when a metadata batch lands; invalidates sort useMemo

      // Worker errors
      workerErrors: WorkerErrorPayload[];

      // Draft Edits
      draftEdits: MetadataDraftEditsByFile;
      /** Observable store backing `draftEdits`; consumers like the search-
       *  worker hook subscribe directly so they hear about every mutation. */
      draftEditsStore: DraftEditsStore;

      // Target-aware schema-v5 drafts. Kept separate from the temporary
      // schema-v4 bridge above so occurrence identity is never collapsed.
      targetDraftEdits: TargetDraftEditsByFile;
      targetDraftEditsStore: TargetDraftEditsStore;
      targetApplying: TargetApplyControllerStateV5;

      // Apply-edits in-flight state (non-null while metadata apply is running)
      applying: ApplyEditsInFlight | null;

      /**
       * Per-file verification outcomes left over from the most recent apply
       * that need user attention (Coerced / Mismatch / MissingPostWrite /
       * DeleteLingering).  Empty record when nothing pends.  The
       * VerifyOutcomeDialog renders while this is non-empty.
       */
      verifyOutcomes: Record<string, TagOutcomeEntry[]>;
    };

export interface ApplyEditsInFlight {
  total: number;
  current: number;
  /** File currently being processed (most recent progress event), if any. */
  currentFile: string | null;
  failureCount: number;
  cancelling: boolean;
  /** Active phase of the deliberately sequential v5 -> v4 bridge. */
  phase: "target-v5" | "legacy-v4";
}

// ── AI image-description (see docs/IMAGE_ANALYSIS.md) ──────────────────────────

export type DescribePhase =
  "estimating" | "awaiting-confirm" | "running" | "done";

export interface DescribeEstimate {
  totalInputTokens: number;
  predictedCostUsd: number;
  upperBoundCostUsd: number;
  model: string;
  estimateMode?: "heuristic" | "exact";
}

/**
 * Per-group outcome counts collected during the estimate walk. The
 * estimate now walks every group regardless of user selection so the
 * confirm-phase dialog can show a per-group outcome table; the user's
 * selection is honoured client-side (cost recomputed from
 * `aiTokenBreakdown` + `pricing`, drafts produced by the run command).
 */
export interface NormaliseGroupOutcomeCounts {
  nNoop: number;
  nNormalisedDeterministic: number;
  nNormalisedAi: number;
  nConflict: number;
  /**
   * Sum across all images of the count of target fields that have a
   * non-empty current effective value and would be replaced by a
   * different value (or removed). For AI-fired groups the eventual
   * value isn't known up-front, so the count assumes "always
   * different".
   */
  nOverwrites: number;
}

export interface NormaliseEstimateAiTokenBreakdown {
  descriptionInputTokens: number;
  titleInputTokens: number;
  descriptionCallCount: number;
  titleCallCount: number;
}

export interface NormaliseEstimatePricing {
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Cost-estimate summary for the metadata-normaliser.
 *
 * `model` is the empty string and `pricing` / `aiTokenBreakdown` are
 * `null` when no preflight ran (missing API key, or no pricing entry
 * for the configured model). `perGroupOutcomes` is always populated
 * because the outcome walk never needs the API.
 */
export interface NormaliseEstimate {
  nImagesWithAiB: number;
  nImagesWithAiC: number;
  nImagesNoAi: number;
  totalInputTokens: number;
  predictedCostUsd: number;
  upperBoundCostUsd: number;
  model: string;
  perGroupOutcomes: Partial<
    Record<NormaliseGroup, NormaliseGroupOutcomeCounts>
  >;
  aiTokenBreakdown: NormaliseEstimateAiTokenBreakdown | null;
  pricing: NormaliseEstimatePricing | null;
  expectedOutPerCallB: number;
  maxOutPerCallB: number;
  expectedOutPerCallC: number;
  maxOutPerCallC: number;
}

export interface DescribeFailure {
  relativePath: string;
  kind: BatchFailureKind;
  detail: string;
}

export interface DescribeUsageSummary {
  totalInputTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  predictedCostUsd: number;
  actualCostUsd: number;
}

/**
 * UI state machine for the AI-description flow. Single object covers all
 * four phases; the dialog reads `phase` and renders the matching panel.
 * Mirrors `ApplyEditsInFlight` in spirit but adds estimate + result fields.
 */
export interface DescribeProgressState {
  phase: DescribePhase;
  total: number;
  current: number;
  currentFile: string | null;
  cancelling: boolean;
  failures: DescribeFailure[];
  succeeded: string[];
  estimate: DescribeEstimate | null;
  estimateError: string | null;
  usageSummary: DescribeUsageSummary | null;
  /** Original rel-paths the dialog was opened for — needed for confirm step. */
  relPaths: string[];
}

// ── Reverse-geocoding (see docs/REVERSE_GEOCODE_PLAN.md) ──────────────────────

/**
 * Industry-standard location tag keys written by the reverse-geocode
 * flow. Each XMP key has a paired IPTC IIM mirror; both are written
 * together so the legacy mirror stays in lockstep with the XMP source
 * of truth. See plan §1 for rationale on the choice of these specific
 * keys (Lightroom / Bridge / Photo Mechanic / digiKam all use them).
 *
 * Used by:
 *  - the "already has location data" overwrite-warning check in
 *    DetailsPane and PhotoList (any of these keys present in metadata
 *    or drafts triggers the warning),
 *  - tests that verify all ten keys land as drafts on success.
 */
/**
 * Per-group target tags written by the metadata normaliser (plan §1).
 * Used by the "already has data" overwrite-warning check in DetailsPane
 * and PhotoList: any of the enabled groups' tags present in metadata or
 * drafts triggers the warning. Keep in sync with the `*_TARGET_TAGS`
 * constants in `src-tauri/src/normalise.rs`.
 */
export const NORMALISE_TARGET_TAGS_BY_GROUP: Record<
  NormaliseGroup,
  readonly SchemaDefinitionId[]
> = {
  keywords: [ID.xmpHierarchicalSubject, ID.xmpSubject, ID.iptcKeywords],
  description: [ID.xmpDescription, ID.imageDescription, ID.iptcCaption],
  title: [ID.xmpTitle, ID.iptcObjectName],
  headline: [ID.xmpHeadline, ID.iptcHeadline],
  creator: [ID.xmpCreator, ID.artist, ID.iptcByLine],
  copyright: [ID.xmpRights, ID.copyright, ID.iptcCopyright],
  location: [
    ID.xmpLocation,
    ID.iptcSubLocation,
    ID.xmpCity,
    ID.iptcCity,
    ID.xmpState,
    ID.iptcProvinceState,
    ID.xmpCountry,
    ID.iptcCountryName,
    ID.xmpCountryCode,
    ID.iptcCountryCode,
  ],
  dates: [
    ID.dateTimeOriginal,
    ID.xmpDateCreated,
    ID.iptcDateCreated,
    ID.iptcTimeCreated,
    ID.createDate,
    ID.xmpCreateDate,
    ID.iptcDigitalCreationDate,
    ID.iptcDigitalCreationTime,
  ],
};

/** Flat union of every group's target tags. */
export const NORMALISE_ALL_TARGET_TAGS: readonly SchemaDefinitionId[] =
  Object.values(NORMALISE_TARGET_TAGS_BY_GROUP).flat();

/**
 * Every NormaliseGroup the v1 dialog exposes, in the pass order
 * documented in docs/NORMALISE_METADATA_PLAN.md §2. Used as the default
 * "all enabled" set when a normalise flow is kicked off, and as the
 * canonical ordering for the dialog's per-group toggles.
 */
export const ALL_NORMALISE_GROUPS: readonly NormaliseGroup[] = [
  // Mirrors NormaliseGroup::ALL in the backend (plan §2 pass order).
  // Order matters in the UI too — earlier groups can feed later ones
  // (e.g. Description's canonical feeds Title's AI prompt), so the
  // confirm-table and post-run summary read top-to-bottom in the same
  // order the engine actually walks.
  "keywords",
  "creator",
  "copyright",
  "location",
  "dates",
  "description",
  "title",
  "headline",
];

export const GEOCODE_TARGET_TAGS: readonly SchemaDefinitionId[] = [
  ID.xmpLocation,
  ID.xmpCity,
  ID.xmpState,
  ID.xmpCountry,
  ID.xmpCountryCode,
  ID.iptcSubLocation,
  ID.iptcCity,
  ID.iptcProvinceState,
  ID.iptcCountryName,
  ID.iptcCountryCode,
] as const;

export type GeocodePhase = "awaiting-confirm" | "running" | "done";

/** One item in the geocode_images_cmd invocation. */
export interface GeocodeRequestItem {
  relPath: string;
  /** Decimal degrees; null when the image has no GPS. */
  lat: number | null;
  lon: number | null;
}

export interface GeocodeFailure {
  relativePath: string;
  kind: BatchFailureKind;
  detail: string;
}

/**
 * Per-source counters returned in the geocode_complete payload. Each
 * field is the count of images that reached that final outcome — they
 * sum to the batch total (no_gps is mutually exclusive with failed in
 * the sense that no_gps images are counted only in n_no_gps).
 */
export interface GeocodeSummary {
  nSucceededFromNominatim: number;
  nSucceededFromCache: number;
  nSucceededFromOverpass: number;
  nNoGps: number;
  nFailed: number;
}

export interface GeocodeProgressState {
  phase: GeocodePhase;
  total: number;
  current: number;
  currentFile: string | null;
  cancelling: boolean;
  failures: GeocodeFailure[];
  succeeded: string[];
  summary: GeocodeSummary | null;
  /** Original items the dialog was opened for. */
  items: GeocodeRequestItem[];
}

export interface TagOutcomeEntry {
  id: SchemaDefinitionId;
  kind: string;
  sent: MetadataValue | null;
  before: MetadataValue | null;
  observed: MetadataValue | null;
  message: string | null;
}

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface PhotoFoundPayload {
  scan_id: number;
  photos: PhotoInfo[];
}

export interface ImageMetadataReadyPayload {
  scan_id: number;
  results: ImageMetadata[];
}

export interface ThumbnailReadyPayload {
  scan_id: number;
  results: { relative_path: string; thumbnail: string | null }[];
}

export interface ScanErrorPayload {
  scan_id: number;
  message: string;
}

export interface WorkerErrorPayload {
  scan_id: number;
  worker_type: string;
  error_message: string;
  affected_files: string[];
}

export interface ApplyEditsStartedPayload {
  total: number;
}

export interface ApplyEditsProgressPayload {
  current: number;
  total: number;
  relative_path: string;
  applied: boolean;
  error: string | null;
  warning?: string | null;
  fresh_metadata:
    import("./types/generated/MetadataEntry").MetadataEntry[] | null;
  /**
   * Per-tag verification outcomes (Phase 8.1).  The Rust side prunes
   * Match/DeleteOk drafts on its own; the frontend mirrors those drops
   * locally and accumulates the rest into pendingOutcomes for triage.
   */
  tag_outcomes: import("./types/generated/MetadataTagOutcome").MetadataTagOutcome[];
}
