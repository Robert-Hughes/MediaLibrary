import { useCallback, useEffect, useRef, useState } from "react";
import { ThumbnailStore, MetadataStore } from "./types";
import type {
  AppState,
  PhotoFoundPayload,
  MetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
} from "./types";

export interface TauriApi {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
}

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
  const thumbnailStoreRef = useRef<ThumbnailStore>(new ThumbnailStore());
  const metadataStoreRef  = useRef<MetadataStore>(new MetadataStore());

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      // ── photo_found: add one photo to the list immediately ────────────────
      const unlistenFound = await api.listen("photo_found", (raw) => {
        const { photo } = raw as PhotoFoundPayload;

        // Register in stores before updating React state.
        thumbnailStoreRef.current.add(photo.relative_path);
        metadataStoreRef.current.add(photo.relative_path);

        setAppState((prev) => {
          if (prev.kind === "idle" || prev.kind === "loading") {
            // First photo — transition to loaded (scanning still in progress).
            const folder = currentFolderRef.current ?? "";
            return {
              kind: "loaded",
              folder,
              photos: [photo],
              thumbnails: thumbnailStoreRef.current,
              metadata: metadataStoreRef.current,
              scanning: true,
              galleryIndex: null,
            };
          }
          if (prev.kind === "loaded") {
            return { ...prev, photos: [...prev.photos, photo] };
          }
          return prev;
        });
      });

      // ── scan_complete: walk finished, clear scanning flag ─────────────────
      const unlistenComplete = await api.listen("scan_complete", () => {
        setAppState((prev) =>
          prev.kind === "loaded" ? { ...prev, scanning: false } : prev
        );
      });

      // ── metadata_ready: EXIF arrived for one photo ────────────────────────
      const unlistenMetadata = await api.listen("metadata_ready", (raw) => {
        const { relative_path, date_taken, camera_model } = raw as MetadataReadyPayload;
        metadataStoreRef.current.set(relative_path, { date_taken, camera_model });
      });

      // ── thumbnail_ready: thumbnail arrived for one photo ──────────────────
      const unlistenThumbnail = await api.listen("thumbnail_ready", (raw) => {
        const { relative_path, thumbnail } = raw as ThumbnailReadyPayload;
        thumbnailStoreRef.current.set(relative_path, thumbnail);
      });

      // ── scan_error ────────────────────────────────────────────────────────
      const unlistenError = await api.listen("scan_error", (raw) => {
        const payload = raw as ScanErrorPayload;
        console.error("Scan error:", payload.message);
        setAppState({ kind: "idle" });
      });

      unlisteners.push(
        unlistenFound, unlistenComplete, unlistenMetadata,
        unlistenThumbnail, unlistenError,
      );
    };

    setup();
    return () => { unlisteners.forEach((fn) => fn()); };
  }, [api]);

  const openFolder = useCallback(async () => {
    const folder = (await api.invoke("pick_folder")) as string | null;
    if (!folder) return;

    currentFolderRef.current = folder;

    // Reset stores for the new scan.
    thumbnailStoreRef.current = new ThumbnailStore();
    metadataStoreRef.current  = new MetadataStore();

    setAppState({ kind: "loading", folder });
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
