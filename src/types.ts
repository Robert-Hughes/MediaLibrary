// ── Domain types shared across the frontend ───────────────────────────────────

export interface PhotoInfo {
  /** Path relative to the scanned root folder, forward-slash separated. */
  relative_path: string;
  /** Base64-encoded JPEG thumbnail, populated lazily via thumbnail_ready events. */
  thumbnail: string | null;
}

// ── App state (discriminated union) ──────────────────────────────────────────

export type AppState =
  | { kind: "idle" }
  | { kind: "loading"; folder: string; foundSoFar: number }
  | { kind: "loaded"; folder: string; photos: PhotoInfo[] };

// ── Event payloads from Rust ──────────────────────────────────────────────────

export interface ScanProgressPayload {
  found_so_far: number;
}

export interface ScanCompletePayload {
  /** Photos with thumbnail: null — thumbnails arrive separately. */
  photos: Array<{ relative_path: string }>;
}

export interface ThumbnailReadyPayload {
  relative_path: string;
  thumbnail: string;
}

export interface ScanErrorPayload {
  message: string;
}
