// ── Domain types ──────────────────────────────────────────────────────────────

/** A photo as discovered by the directory walk (path + OS metadata only). */
export interface PhotoInfo {
  relative_path: string;
  filename: string;
  date_modified: number | null;
  date_created: number | null;
}

// ── Variant type ──────────────────────────────────────────────────────────────

export type Variant = string | number | Variant[];

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
    return () => this.subscribers.get(path)?.delete(callback);
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
    return () => this.subscribers.get(path)?.delete(callback);
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

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getSnapshot(): () => number {
    return () => this.getRemaining();
  }

  private notifySubscribers() {
    // Use queueMicrotask to defer notifications until after the current render
    queueMicrotask(() => {
      this.subscribers.forEach((cb) => cb());
    });
  }
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

// ── App state ─────────────────────────────────────────────────────────────────

export type AppState =
  | { kind: "idle" }
  | { kind: "loading"; folder: string }
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

      // Dynamic columns configuration
      visibleColumns: string[];         // Keys of image metadata to show in columns
      visibleOSColumns: string[];       // OS metadata columns to show (date_modified, date_created)

      // Column widths (pixels); absent key means use CSS default
      columnWidths: Record<string, number>;

      // Sorting
      sortConfig: SortConfig;
      metadataVersion: number;          // Incremented when a metadata batch lands; invalidates sort useMemo

      // Worker errors
      workerErrors: WorkerErrorPayload[];
    };

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
  results: { relative_path: string; thumbnail: string }[];
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
