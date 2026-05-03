// ── Domain types shared across the frontend ───────────────────────────────────

export interface PhotoInfo {
  /** Path relative to the scanned root folder, forward-slash separated. */
  relative_path: string;
  /** Base64-encoded JPEG thumbnail data URI, or null if unavailable. */
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
  photos: PhotoInfo[];
}

export interface ScanErrorPayload {
  message: string;
}
