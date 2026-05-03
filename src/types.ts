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
    if (old && old !== "loading") {
      for (const key of Object.keys(old)) {
        const count = this.keyFrequency.get(key) ?? 0;
        this.keyFrequency.set(key, Math.max(0, count - 1));
      }
    }

    if (value && value !== "loading") {
      for (const key of Object.keys(value)) {
        const count = this.keyFrequency.get(key) ?? 0;
        this.keyFrequency.set(key, count + 1);
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
      scanning: boolean;                // true while the directory walk is still running
      imageMetadataRemaining: number;   // count of photos still awaiting metadata_ready
      galleryIndex: number | null;
      selectedIndex: number | null;
      
      // Dynamic columns configuration
      visibleColumns: string[];         // Keys of image metadata to show in columns
    };

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface PhotoFoundPayload {
  scan_id: number;
  photo: PhotoInfo;
}

export interface ImageMetadataReadyPayload {
  scan_id: number;
  relative_path: string;
  metadata: Record<string, Variant>;
}

export interface ThumbnailReadyPayload {
  scan_id: number;
  relative_path: string;
  thumbnail: string;
}

export interface ScanErrorPayload {
  message: string;
}
