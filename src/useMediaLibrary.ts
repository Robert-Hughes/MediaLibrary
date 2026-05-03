/**
 * Core application logic hook.
 *
 * Encapsulates all state transitions and Tauri IPC calls so that:
 *  - Components stay purely presentational
 *  - Tests can exercise all behaviour without a real Tauri backend
 *    by injecting mock implementations of `invoke` and `listen`
 *
 * Thumbnail updates are routed through a ThumbnailStore rather than React
 * state, so each thumbnail_ready event re-renders only the one affected row.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ThumbnailStore } from "./types";
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
  openGallery: (index: number) => void;
  closeGallery: () => void;
  navigateGallery: (delta: -1 | 1) => void;
}

export function useMediaLibrary(api: TauriApi): [AppState, MediaLibraryActions] {
  const [appState, setAppState] = useState<AppState>({ kind: "idle" });

  const currentFolderRef = useRef<string | null>(null);
  // Stable store reference — replaced on each new scan, never mutated in place.
  const thumbnailStoreRef = useRef<ThumbnailStore>(new ThumbnailStore());

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
          const photos = payload.photos.map((p) => ({
            relative_path: p.relative_path,
          }));

          // Reset the store with all paths as "loading".
          const store = new ThumbnailStore();
          store.reset(photos.map((p) => p.relative_path));
          thumbnailStoreRef.current = store;

          setAppState({ kind: "loaded", folder, photos, thumbnails: store, galleryIndex: null });
        }
      );

      const unlistenThumbnail = await api.listen(
        "thumbnail_ready",
        (raw) => {
          const { relative_path, thumbnail } = raw as ThumbnailReadyPayload;
          // Update the store directly — no React state change on the list.
          // Only the subscribing PhotoRow for this path will re-render.
          thumbnailStoreRef.current.set(relative_path, thumbnail);
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
    api.invoke("set_window_title", { title: `Media Library — ${folder}` }).catch(() => {});

    await api.invoke("start_scan", { folderPath: folder });
  }, [api]);

  const closeFolder = useCallback(() => {
    currentFolderRef.current = null;
    setAppState({ kind: "idle" });
    api.invoke("set_window_title", { title: "Media Library" }).catch(() => {});
  }, [api]);

  const prioritizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prioritizeThumbnails = useCallback((visiblePaths: string[]) => {
    if (prioritizeTimerRef.current) clearTimeout(prioritizeTimerRef.current);
    prioritizeTimerRef.current = setTimeout(() => {
      api.invoke("prioritize_thumbnails", { visiblePaths }).catch(() => {});
    }, 100);
  }, [api]);

  const openGallery = useCallback((index: number) => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, galleryIndex: index } : prev
    );
  }, []);

  const closeGallery = useCallback(() => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, galleryIndex: null } : prev
    );
  }, []);

  const navigateGallery = useCallback((delta: -1 | 1) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded" || prev.galleryIndex === null) return prev;
      const next = prev.galleryIndex + delta;
      if (next < 0 || next >= prev.photos.length) return prev;
      return { ...prev, galleryIndex: next };
    });
  }, []);

  return [appState, { openFolder, closeFolder, prioritizeThumbnails, openGallery, closeGallery, navigateGallery }];
}
