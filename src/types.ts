// ── Domain types shared across the frontend ───────────────────────────────────

export interface PhotoInfo {
  /** Path relative to the scanned root folder, forward-slash separated. */
  relative_path: string;
  /** Filename only (last path component). */
  filename: string;
  /** Last-modified Unix timestamp (seconds), or null. */
  date_modified: number | null;
  /** Created Unix timestamp (seconds), or null. */
  date_created: number | null;
  /** DateTimeOriginal from EXIF (string), or null. */
  date_taken: string | null;
  /** Camera make + model from EXIF, or null. */
  camera_model: string | null;
}

// ── Thumbnail store ───────────────────────────────────────────────────────────

/**
 * Thumbnail state for a single photo:
 *  - "loading"  — generation in progress (show spinner)
 *  - "failed"   — could not be generated (show placeholder)
 *  - string     — base64-encoded JPEG data (show image)
 */
export type ThumbnailState = "loading" | "failed" | string;

/**
 * Observable store for thumbnail data, keyed by relative_path.
 * Lives outside React state so thumbnail_ready events update only the
 * individual row that changed, not the entire photo list.
 */
export class ThumbnailStore {
  private data = new Map<string, ThumbnailState>();
  private subscribers = new Map<string, Set<() => void>>();

  /** Initialise all paths as "loading". */
  reset(paths: string[]) {
    this.data.clear();
    this.subscribers.clear();
    for (const p of paths) this.data.set(p, "loading");
  }

  /** Update a single thumbnail and notify its subscribers. */
  set(path: string, value: ThumbnailState) {
    this.data.set(path, value);
    this.subscribers.get(path)?.forEach((cb) => cb());
  }

  /** Get the current thumbnail state for a path. */
  get(path: string): ThumbnailState {
    return this.data.get(path) ?? "loading";
  }

  /** Subscribe to changes for a specific path. Returns an unsubscribe fn. */
  subscribe(path: string, callback: () => void): () => void {
    if (!this.subscribers.has(path)) this.subscribers.set(path, new Set());
    this.subscribers.get(path)!.add(callback);
    return () => this.subscribers.get(path)?.delete(callback);
  }

  /** Return a snapshot function for useSyncExternalStore. */
  getSnapshot(path: string): () => ThumbnailState {
    return () => this.get(path);
  }
}

// ── App state (discriminated union) ──────────────────────────────────────────

export type AppState =
  | { kind: "idle" }
  | { kind: "loading"; folder: string; foundSoFar: number }
  | { kind: "loaded"; folder: string; photos: PhotoInfo[]; thumbnails: ThumbnailStore; galleryIndex: number | null };

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface ScanProgressPayload {
  found_so_far: number;
}

export interface ScanCompletePayload {
  photos: PhotoInfo[];
}

export interface ThumbnailReadyPayload {
  relative_path: string;
  thumbnail: string;
}

export interface ScanErrorPayload {
  message: string;
}
