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
  // Count of metadata_ready events received for the current scan.
  // Compared against photos.length to determine when all metadata is done.
  const metadataReceivedRef = useRef<number>(0);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    const setup = async () => {
      const unlistenFound = await api.listen("photo_found", (raw) => {
        if (cancelled) return;
        const { photo } = raw as PhotoFoundPayload;

        // Register in stores before updating React state.
        thumbnailStoreRef.current.add(photo.relative_path);
        metadataStoreRef.current.add(photo.relative_path);

        setAppState((prev) => {
          if (prev.kind === "idle" || prev.kind === "loading") {
            const folder = currentFolderRef.current ?? "";
            return {
              kind: "loaded",
              folder,
              photos: [photo],
              thumbnails: thumbnailStoreRef.current,
              metadata: metadataStoreRef.current,
              scanning: true,
              metadataRemaining: Math.max(0, 1 - metadataReceivedRef.current),
              galleryIndex: null,
            };
          }
          if (prev.kind === "loaded") {
            const newCount = prev.photos.length + 1;
            return {
              ...prev,
              photos: [...prev.photos, photo],
              metadataRemaining: Math.max(0, newCount - metadataReceivedRef.current),
            };
          }
          return prev;
        });
      });

      const unlistenComplete = await api.listen("scan_complete", () => {
        if (cancelled) return;
        setAppState((prev) => {
          if (prev.kind === "loaded") return { ...prev, scanning: false };
          // Empty folder: walk finished before any photo_found — go to loaded with empty list.
          if (prev.kind === "loading") {
            return {
              kind: "loaded",
              folder: prev.folder,
              photos: [],
              thumbnails: thumbnailStoreRef.current,
              metadata: metadataStoreRef.current,
              scanning: false,
              metadataRemaining: 0,
              galleryIndex: null,
            };
          }
          return prev;
        });
      });

      const unlistenMetadata = await api.listen("metadata_ready", (raw) => {
        if (cancelled) return;
        const { relative_path, date_taken, camera_model } = raw as MetadataReadyPayload;
        metadataStoreRef.current.set(relative_path, { date_taken, camera_model });
        metadataReceivedRef.current += 1;
        // Recalculate remaining based on how many photos we know about vs received.
        setAppState((prev) =>
          prev.kind === "loaded"
            ? { ...prev, metadataRemaining: Math.max(0, prev.photos.length - metadataReceivedRef.current) }
            : prev
        );
      });
      const unlistenThumbnail = await api.listen("thumbnail_ready", (raw) => {
        if (cancelled) return;
        const { relative_path, thumbnail } = raw as ThumbnailReadyPayload;
        thumbnailStoreRef.current.set(relative_path, thumbnail);
      });

      const unlistenError = await api.listen("scan_error", (raw) => {
        if (cancelled) return;
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
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [api]);

  const openFolder = useCallback(async () => {
    const folder = (await api.invoke("pick_folder")) as string | null;
    if (!folder) return;

    currentFolderRef.current = folder;

    // Reset stores for the new scan.
    thumbnailStoreRef.current = new ThumbnailStore();
    metadataStoreRef.current  = new MetadataStore();
    metadataReceivedRef.current = 0;

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
