// ── Generated wire-shape types ────────────────────────────────────────────────
//
// These are re-exports of types generated from Rust by ts-rs (see
// docs/GENERATED_TYPES.md). Do not hand-edit the originals in
// `src/types/generated/`; regenerate with:
// cargo test --manifest-path src-tauri/Cargo.toml

import type { PhotoInfo } from "./types/generated/PhotoInfo";
import type { Variant } from "./types/generated/Variant";
import type { DraftEdit } from "./types/generated/DraftEdit";
import type { MetadataValue } from "./types/generated/MetadataValue";

export type { PhotoInfo, Variant, DraftEdit };
export type { MetadataValue } from "./types/generated/MetadataValue";
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
export type { ApplyEditsResult } from "./types/generated/ApplyEditsResult";
export type { MetadataApplyEditsResult } from "./types/generated/MetadataApplyEditsResult";
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
 *  - Record<string, Variant>   — metadata has arrived
 */
export type ImageMetadataEntry = Variant | MetadataValue;
export type ImageMetadataState = "loading" | Record<string, ImageMetadataEntry>;

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

  // Tracks how many images have a value for each metadata key.
  private keyFrequency = new Map<string, number>();

  add(path: string) {
    if (!this.data.has(path)) {
      this.data.set(path, "loading");
      this.globalSubscribers.forEach((cb) => cb(path, "loading"));
    }
  }

  set(path: string, value: ImageMetadataState) {
    const old = this.data.get(path);

    // Only update frequency if we're transitioning from 'loading' to actual metadata.
    // (In our current app, metadata for a file is only set once per scan).
    if (value && value !== "loading" && (!old || old === "loading")) {
      for (const key of Object.keys(value)) {
        this.keyFrequency.set(key, (this.keyFrequency.get(key) ?? 0) + 1);
      }
    }

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

  getKeyFrequency(): Map<string, number> {
    return this.keyFrequency;
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

export type ColumnKind = "os" | "image";

export interface VisibleColumn {
  key: string;
  kind: ColumnKind;
}

// ── Sorting ───────────────────────────────────────────────────────────────────

export type SortColumnType = "path" | "os" | "image";
export type SortDirection = "asc" | "desc";

export interface SortKey {
  column: string; // Column identifier (e.g. "relative_path", "date_modified", "ExifIFD:DateTimeOriginal")
  columnType: SortColumnType;
  direction: SortDirection;
}

export interface SortConfig {
  primary: SortKey | null;
  secondary: SortKey | null;
}

// ── Draft Edits ───────────────────────────────────────────────────────────────

/**
 * Internal storage shape: typed DraftEdit carrying value + intent (see
 * docs/METADATA_FORMATS_DESIGN.md §7). Components and tests still consume the
 * legacy `string | null` view; conversion happens in `src/draft.ts`.
 */
export type DraftEditsByFile = Record<string, Record<string, DraftEdit>>;

/** Legacy display value for components and the Tauri boundary. */
export type DraftEditsValue = string | null;
export type LegacyDraftEditsByFile = Record<
  string,
  Record<string, DraftEditsValue>
>;

/**
 * Per-mutation change record passed to DraftEditsStore subscribers.
 * `edits` is the new per-tag map after the mutation, or `undefined` if the
 * entire file's drafts were removed.
 */
export interface DraftEditsChange {
  path: string;
  edits: Record<string, DraftEdit> | undefined;
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
 * Deep structural equality for `Variant` values. Used by the
 * redundant-draft guard to compare a proposed Set value against the
 * tag's current effective value. Object keys are compared
 * order-independently.
 */
export function variantEqual(
  a: ImageMetadataEntry | undefined,
  b: ImageMetadataEntry | undefined,
): boolean {
  a = metadataEntryToComparableVariant(a);
  b = metadataEntryToComparableVariant(b);
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!variantEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  if (typeof a === "object") {
    const ao = a as { [k: string]: Variant | undefined };
    const bo = b as { [k: string]: Variant | undefined };
    const ka = Object.keys(ao);
    const kb = Object.keys(bo);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in bo)) return false;
      if (!variantEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

function metadataEntryToComparableVariant(
  value: ImageMetadataEntry | undefined,
): Variant | undefined {
  if (!isMetadataValue(value)) return value;
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
        (item) => metadataEntryToComparableVariant(item) ?? null,
      );
    case "Struct":
      return Object.fromEntries(
        Object.entries(value.value).map(([k, v]) => [
          k,
          metadataEntryToComparableVariant(v),
        ]),
      );
    default:
      return JSON.stringify(value);
  }
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/**
 * Single source of truth for draft edits.  All user-initiated mutations funnel
 * through methods on this class so subscribers (React-state sync, persistence,
 * future search-worker index) stay in sync without per-call-site discipline.
 *
 * `reset()` is silent — used during scan initialization to seed the store from
 * disk.  Every other mutator notifies subscribers exactly once with the list of
 * changed paths (undefined-valued edits = path deleted).
 *
 * Redundant-draft guard: when a `currentValueResolver` is registered
 * (via `setCurrentValueResolver`), `setTag` / `setBatch` compare each
 * Set-intent value against the tag's current metadata. Same value → no
 * draft is written (and any existing draft for that tag is removed).
 * Callers receive a per-key outcome so they can log or aggregate
 * what was dropped (see `SetDraftOutcome`).
 */
export class DraftEditsStore {
  private snapshot: DraftEditsByFile = {};
  private listeners = new Set<DraftEditsListener>();
  private currentValueResolver?: (
    path: string,
    tag: string,
  ) => ImageMetadataEntry | undefined;

  /**
   * Wire up the redundant-draft guard. Pass a function that returns
   * the tag's current effective metadata value for the given file, or
   * `undefined` when the file has no value for that tag. Without a
   * resolver the store behaves as it always did (writes always land).
   */
  setCurrentValueResolver(
    fn: (path: string, tag: string) => ImageMetadataEntry | undefined,
  ) {
    this.currentValueResolver = fn;
  }

  /** Bulk replace.  Silent — does not fire subscribers. */
  reset(initial: DraftEditsByFile) {
    this.snapshot = initial;
  }

  /** Returns the current immutable snapshot.  Reference changes on every mutation. */
  getAll(): DraftEditsByFile {
    return this.snapshot;
  }

  getFile(path: string): Record<string, DraftEdit> | undefined {
    return this.snapshot[path];
  }

  /**
   * Apply one write to the snapshot in-place and return its outcome.
   * Caller is responsible for notifying subscribers exactly once after
   * a logical mutation (single setTag, or one setBatch).
   */
  private applyOne(
    path: string,
    tag: string,
    edit: DraftEdit,
  ): SetDraftOutcome {
    const existingDraft = this.snapshot[path]?.[tag];
    // Only the Set intent can produce a "value identical to current
    // metadata" situation worth guarding against. List add / list
    // remove operate on the current list; Delete is the user
    // explicitly asking to clear a tag (and we trust them).
    if (edit.intent === "Set" && this.currentValueResolver) {
      const current = this.currentValueResolver(path, tag);
      if (variantEqual(current, edit.value ?? undefined)) {
        if (existingDraft) {
          // Existing draft becomes redundant — remove it so the user
          // doesn't see a "pending change" that wouldn't actually
          // change anything.
          const fileEdits = { ...(this.snapshot[path] ?? {}) };
          delete fileEdits[tag];
          const next = { ...this.snapshot };
          if (Object.keys(fileEdits).length === 0) delete next[path];
          else next[path] = fileEdits;
          this.snapshot = next;
          return "cleared";
        }
        return "redundant";
      }
    }
    const fileEdits = { ...(this.snapshot[path] ?? {}), [tag]: edit };
    this.snapshot = { ...this.snapshot, [path]: fileEdits };
    return "written";
  }

  setTag(path: string, tag: string, edit: DraftEdit): SetDraftOutcome {
    const outcome = this.applyOne(path, tag, edit);
    if (outcome !== "redundant") {
      this.notify([{ path, edits: this.snapshot[path] }]);
    }
    return outcome;
  }

  setBatch(
    path: string,
    edits: Array<{ key: string; edit: DraftEdit }>,
  ): Array<{ key: string; outcome: SetDraftOutcome }> {
    if (edits.length === 0) return [];
    const results: Array<{ key: string; outcome: SetDraftOutcome }> = [];
    for (const { key, edit } of edits) {
      results.push({ key, outcome: this.applyOne(path, key, edit) });
    }
    if (results.some((r) => r.outcome !== "redundant")) {
      this.notify([{ path, edits: this.snapshot[path] }]);
    }
    return results;
  }

  deleteTag(path: string, tag: string) {
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
  pruneTags(path: string, tagsToDelete: string[]) {
    const fileEdits = this.snapshot[path];
    if (!fileEdits) return;
    const updated = { ...fileEdits };
    let touched = false;
    for (const t of tagsToDelete) {
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
      draftEdits: DraftEditsByFile;
      /** Observable store backing `draftEdits`; consumers like the search-
       *  worker hook subscribe directly so they hear about every mutation. */
      draftEditsStore: DraftEditsStore;

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
}

// ── AI image-description (see docs/IMAGE_ANALYSIS.md) ──────────────────────────

export type DescribePhase =
  "estimating" | "awaiting-confirm" | "running" | "done";

export interface DescribeEstimate {
  totalInputTokens: number;
  predictedCostUsd: number;
  upperBoundCostUsd: number;
  model: string;
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
  readonly string[]
> = {
  keywords: ["XMP-lr:HierarchicalSubject", "XMP-dc:Subject", "IPTC:Keywords"],
  description: [
    "XMP-dc:Description",
    "IFD0:ImageDescription",
    "IPTC:Caption-Abstract",
  ],
  title: ["XMP-dc:Title", "IPTC:ObjectName"],
  headline: ["XMP-photoshop:Headline", "IPTC:Headline"],
  creator: ["XMP-dc:Creator", "IFD0:Artist", "IPTC:By-line"],
  copyright: ["XMP-dc:Rights", "IFD0:Copyright", "IPTC:CopyrightNotice"],
  location: [
    "XMP-iptcCore:Location",
    "IPTC:Sub-location",
    "XMP-photoshop:City",
    "IPTC:City",
    "XMP-photoshop:State",
    "IPTC:Province-State",
    "XMP-photoshop:Country",
    "IPTC:Country-PrimaryLocationName",
    "XMP-iptcCore:CountryCode",
    "IPTC:Country-PrimaryLocationCode",
  ],
  dates: [
    "ExifIFD:DateTimeOriginal",
    "XMP-photoshop:DateCreated",
    "IPTC:DateCreated",
    "IPTC:TimeCreated",
    "ExifIFD:CreateDate",
    "XMP-xmp:CreateDate",
    "IPTC:DigitalCreationDate",
    "IPTC:DigitalCreationTime",
  ],
};

/** Flat union of every group's target tags. */
export const NORMALISE_ALL_TARGET_TAGS: readonly string[] = Object.values(
  NORMALISE_TARGET_TAGS_BY_GROUP,
).flat();

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

export const GEOCODE_TARGET_TAGS: readonly string[] = [
  "XMP-iptcCore:Location",
  "XMP-photoshop:City",
  "XMP-photoshop:State",
  "XMP-photoshop:Country",
  "XMP-iptcCore:CountryCode",
  "IPTC:Sub-location",
  "IPTC:City",
  "IPTC:Province-State",
  "IPTC:Country-PrimaryLocationName",
  "IPTC:Country-PrimaryLocationCode",
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
  tag: string;
  kind: string;
  sent: MetadataValue | null;
  beforeDisplay: MetadataValue | null;
  observedDisplay: MetadataValue | null;
  observedRaw: MetadataValue | null;
  message: string | null;
}

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface PhotoFoundPayload {
  scan_id: number;
  photos: PhotoInfo[];
}

export interface ImageMetadataReadyPayload {
  scan_id: number;
  results: {
    relative_path: string;
    metadata: Record<string, ImageMetadataEntry>;
  }[];
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
  fresh_metadata: Record<string, MetadataValue> | null;
  /**
   * Per-tag verification outcomes (Phase 8.1).  The Rust side prunes
   * Match/DeleteOk drafts on its own; the frontend mirrors those drops
   * locally and accumulates the rest into pendingOutcomes for triage.
   */
  tag_outcomes: import("./types/generated/MetadataTagOutcome").MetadataTagOutcome[];
}
