/**
 * Core application logic hook.
 *
 * Encapsulates all state transitions and Tauri IPC calls so that:
 *  - Components stay purely presentational
 *  - Tests can exercise all behaviour without a real Tauri backend
 *    by injecting mock implementations of `invoke` and `listen`
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppState,
  ScanCompletePayload,
  ScanErrorPayload,
  ScanProgressPayload,
  ThumbnailReadyPayload,
} from "./types";

// ── Tauri IPC interface (injectable for testing) ──────────────────────────────

export interface TauriApi {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (
    event: string,
    handler: (payload: unknown) => void
  ) => Promise<() => void>;
}
// ── Hook ──────────────────────────────────────────────────────────────────────

export interface MediaLibraryActions {
  openFolder: () => Promise<void>;
  closeFolder: () => void;
  prioritizeThumbnails: (visiblePaths: string[]) => void;
}

export function useMediaLibrary(api: TauriApi): [AppState, MediaLibraryActions] {
  const [appState, setAppState] = useState<AppState>({ kind: "idle" });

  // Keep a ref to the current folder so event handlers always see the latest value.
  const currentFolderRef = useRef<string | null>(null);

  // Register Tauri event listeners once on mount.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      const unlistenProgress = await api.listen(
        "scan_progress",
        (raw) => {
          const payload = raw as ScanProgressPayload;
          setAppState((prev) =>
            prev.kind === "loading"
              ? { ...prev, foundSoFar: payload.found_so_far }
              : prev
          );
        }
      );

      const unlistenComplete = await api.listen(
        "scan_complete",
        (raw) => {
          const payload = raw as ScanCompletePayload;
          const folder = currentFolderRef.current ?? "";
          // Photos arrive with no thumbnails; they fill in via thumbnail_ready.
          const photos = payload.photos.map((p) => ({
            relative_path: p.relative_path,
            thumbnail: null,
          }));
          setAppState({ kind: "loaded", folder, photos });
        }
      );

      const unlistenThumbnail = await api.listen(
        "thumbnail_ready",
        (raw) => {
          const { relative_path, thumbnail } = raw as ThumbnailReadyPayload;
          setAppState((prev) => {
            if (prev.kind !== "loaded") return prev;
            // Immutably update just the matching photo entry.
            const photos = prev.photos.map((p) =>
              p.relative_path === relative_path ? { ...p, thumbnail } : p
            );
            return { ...prev, photos };
          });
        }
      );

      const unlistenError = await api.listen(
        "scan_error",
        (raw) => {
          const payload = raw as ScanErrorPayload;
          console.error("Scan error:", payload.message);
          setAppState({ kind: "idle" });
        }
      );

      unlisteners.push(
        unlistenProgress,
        unlistenComplete,
        unlistenThumbnail,
        unlistenError
      );
    };

    setup();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [api]);

  const openFolder = useCallback(async () => {
    const folder = (await api.invoke("pick_folder")) as string | null;
    if (!folder) return;

    currentFolderRef.current = folder;
    setAppState({ kind: "loading", folder, foundSoFar: 0 });

    await api.invoke("start_scan", { folderPath: folder });
  }, [api]);

  const closeFolder = useCallback(() => {
    currentFolderRef.current = null;
    setAppState({ kind: "idle" });
  }, []);

  // Debounced — coalesce rapid scroll events before hitting the backend.
  const prioritizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prioritizeThumbnails = useCallback((visiblePaths: string[]) => {
    if (prioritizeTimerRef.current) clearTimeout(prioritizeTimerRef.current);
    prioritizeTimerRef.current = setTimeout(() => {
      api.invoke("prioritize_thumbnails", { visiblePaths }).catch(() => {
        // Best-effort — ignore errors (e.g. scan already finished).
      });
    }, 100);
  }, [api]);

  return [appState, { openFolder, closeFolder, prioritizeThumbnails }];
}
