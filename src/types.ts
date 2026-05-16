// ── Generated wire-shape types ────────────────────────────────────────────────
//
// These are re-exports of types generated from Rust by ts-rs (see AGENTS.md
// "Generated types").  Do not hand-edit the originals in
// `src/types/generated/`; regenerate by running `cargo test` in src-tauri.

import type { PhotoInfo } from "./types/generated/PhotoInfo";
import type { Variant } from "./types/generated/Variant";
import type { DraftEdit } from "./types/generated/DraftEdit";

export type { PhotoInfo, Variant, DraftEdit };
export type { TagInfo } from "./types/generated/TagInfo";
export type { TagKind } from "./types/generated/TagKind";
export type { EnumOption } from "./types/generated/EnumOption";
export type { EnumRepr } from "./types/generated/EnumRepr";
export type { EditIntent } from "./types/generated/EditIntent";
export type { ImageMetadata } from "./types/generated/ImageMetadata";
export type { ApplyEditsResult } from "./types/generated/ApplyEditsResult";
export type { FailedFile as ApplyEditsFailedFile } from "./types/generated/FailedFile";
export type { TagOutcome } from "./types/generated/TagOutcome";

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
export type ImageMetadataState = "loading" | Record<string, Variant>;

/**
 * Observable store for image-level metadata, keyed by relative_path.
 * Updates only re-render the affected row.
 */
export class ImageMetadataStore {
  private data = new Map<string, ImageMetadataState>();
  private subscribers = new Map<string, Set<() => void>>();
  
  // Tracks how many images have a value for each metadata key.
  private keyFrequency = new Map<string, number>();

  add(path: string) {
    if (!this.data.has(path)) {
      this.data.set(path, "loading");
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
  column: string;       // Column identifier (e.g. "relative_path", "date_modified", "ExifIFD:DateTimeOriginal")
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
 * METADATA_FORMATS_DESIGN.md §7).  Components and tests still consume the
 * legacy `string | null` view; conversion happens in `src/draft.ts`.
 */
export type DraftEditsByFile = Record<string, Record<string, DraftEdit>>;

/** Legacy display value for components and the Tauri boundary. */
export type DraftEditsValue = string | null;
export type LegacyDraftEditsByFile = Record<string, Record<string, DraftEditsValue>>;

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
      scanning: boolean;                // true while the directory walk is still running
      galleryIndex: number | null;
      selectedIndex: number | null;

      // Unified, ordered list of metadata columns (mix of OS and image kinds)
      visibleColumns: VisibleColumn[];

      // Column widths (pixels); absent key means use CSS default
      columnWidths: Record<string, number>;

      // Sorting
      sortConfig: SortConfig;
      metadataVersion: number;          // Incremented when a metadata batch lands; invalidates sort useMemo

      // Worker errors
      workerErrors: WorkerErrorPayload[];

      // Draft Edits
      draftEdits: DraftEditsByFile;

      // Apply-edits in-flight state (non-null while apply_draft_edits_cmd is running)
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

export type DescribePhase = "estimating" | "awaiting-confirm" | "running" | "done";

export interface DescribeEstimate {
  totalInputTokens: number;
  predictedCostUsd: number;
  upperBoundCostUsd: number;
  model: string;
}

export interface DescribeFailure {
  relativePath: string;
  kind: string;
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

export interface TagOutcomeEntry {
  tag: string;
  kind: string;
  sent: Variant | null;
  beforeDisplay: Variant | null;
  observedDisplay: Variant | null;
  observedRaw: Variant | null;
  message: string | null;
}

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface PhotoFoundPayload {
  scan_id: number;
  photos: PhotoInfo[];
}

export interface ImageMetadataReadyPayload {
  scan_id: number;
  results: { relative_path: string; metadata: Record<string, Variant> }[];
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
  fresh_metadata: Record<string, Variant> | null;
  /**
   * Per-tag verification outcomes (Phase 8.1).  The Rust side prunes
   * Match/DeleteOk drafts on its own; the frontend mirrors those drops
   * locally and accumulates the rest into pendingOutcomes for triage.
   */
  tag_outcomes: import("./types/generated/TagOutcome").TagOutcome[];
}
