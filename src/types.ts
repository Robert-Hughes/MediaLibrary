// ── Domain types ──────────────────────────────────────────────────────────────

/** A photo as discovered by the directory walk (path + OS metadata only). */
export interface PhotoInfo {
  relative_path: string;
  filename: string;
  date_modified: number | null;
  date_created: number | null;
}

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

// ── Metadata store ────────────────────────────────────────────────────────────

/**
 * EXIF state for a single photo:
 *  - "loading"  — metadata read is in progress (show spinner in cells)
 *  - ExifData   — metadata has arrived (show values or "—")
 */
export type ExifState = "loading" | ExifData;

export interface ExifData {
  date_taken: string | null;
  camera_model: string | null;
}

/**
 * Observable store for EXIF metadata, keyed by relative_path.
 * Same pattern as ThumbnailStore — updates only re-render the affected row.
 */
export class MetadataStore {
  private data = new Map<string, ExifState>();
  private subscribers = new Map<string, Set<() => void>>();

  add(path: string) {
    if (!this.data.has(path)) {
      this.data.set(path, "loading");
    }
  }

  set(path: string, value: ExifState) {
    this.data.set(path, value);
    this.subscribers.get(path)?.forEach((cb) => cb());
  }

  get(path: string): ExifState {
    return this.data.get(path) ?? "loading";
  }

  subscribe(path: string, callback: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(callback);
    return () => this.subscribers.get(path)?.delete(callback);
  }

  getSnapshot(path: string): () => ExifState {
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
      metadata: MetadataStore;
      scanning: boolean;       // true while the directory walk is still running
      galleryIndex: number | null;
    };

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface PhotoFoundPayload {
  photo: PhotoInfo;
}

export interface MetadataReadyPayload {
  relative_path: string;
  date_taken: string | null;
  camera_model: string | null;
}

export interface ThumbnailReadyPayload {
  relative_path: string;
  thumbnail: string;
}

export interface ScanErrorPayload {
  message: string;
}
