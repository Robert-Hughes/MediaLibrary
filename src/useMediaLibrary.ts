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
  prioritizeQueues: (visiblePaths: string[]) => void;
  openGallery: (index: number) => void;
  closeGallery: () => void;
  navigateGallery: (delta: -1 | 1) => void;
}

export function useMediaLibrary(api: TauriApi): [AppState, MediaLibraryActions] {
  const [appState, setAppState] = useState<AppState>({ kind: "idle" });

  const thumbnailStoreRef   = useRef<ThumbnailStore>(new ThumbnailStore());
  const metadataStoreRef    = useRef<MetadataStore>(new MetadataStore());
  const metadataReceivedRef = useRef<number>(0);

  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    const setup = async () => {
      const unlistenFound = await api.listen("photo_found", (raw) => {
        if (cancelled) return;
        const { scan_id, photo } = raw as PhotoFoundPayload;
        if (scan_id !== activeScanIdRef.current) return;

        thumbnailStoreRef.current.add(photo.relative_path);
        metadataStoreRef.current.add(photo.relative_path);

        setAppState((prev) => {
          if (prev.kind === "idle") return prev;
          if (prev.kind === "loading") {
            return {
              kind: "loaded",
              folder: prev.folder,
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

      const unlistenComplete = await api.listen("scan_complete", (raw) => {
        if (cancelled) return;
        const { scan_id } = raw as { scan_id: number };
        if (scan_id !== activeScanIdRef.current) return;
        setAppState((prev) => {
          if (prev.kind === "loaded") return { ...prev, scanning: false };
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
        const { scan_id, relative_path, date_taken, camera_model } = raw as MetadataReadyPayload;
        if (scan_id !== activeScanIdRef.current) return;
        metadataStoreRef.current.set(relative_path, { date_taken, camera_model });
        metadataReceivedRef.current += 1;
        setAppState((prev) =>
          prev.kind === "loaded"
            ? { ...prev, metadataRemaining: Math.max(0, prev.photos.length - metadataReceivedRef.current) }
            : prev
        );
      });

      const unlistenThumbnail = await api.listen("thumbnail_ready", (raw) => {
        if (cancelled) return;
        const { scan_id, relative_path, thumbnail } = raw as ThumbnailReadyPayload;
        if (scan_id !== activeScanIdRef.current) return;
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

    // Stop any existing scan before starting a new one.
    await api.invoke("stop_scan").catch(() => {});

    // Invalidate events from any previous scan before starting the new one.
    activeScanIdRef.current = -1;

    thumbnailStoreRef.current = new ThumbnailStore();
    metadataStoreRef.current  = new MetadataStore();
    metadataReceivedRef.current = 0;

    setAppState({ kind: "loading", folder });
    api.invoke("set_window_title", { title: `Media Library — ${folder}` }).catch(() => {});

    // start_scan returns the scan_id assigned by the backend.
    const scanId = (await api.invoke("start_scan", { folderPath: folder })) as number;
    activeScanIdRef.current = scanId;
  }, [api]);

  const closeFolder = useCallback(() => {
    activeScanIdRef.current = -1;
    setAppState({ kind: "idle" });
    api.invoke("stop_scan").catch(() => {});
    api.invoke("set_window_title", { title: "Media Library" }).catch(() => {});
  }, [api]);

  const prioritizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prioritizeQueues = useCallback((visiblePaths: string[]) => {
    if (prioritizeTimerRef.current) clearTimeout(prioritizeTimerRef.current);
    prioritizeTimerRef.current = setTimeout(() => {
      api.invoke("prioritize_queues", { visiblePaths }).catch(() => {});
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

  const navigateGallery = useCallback((delta: number) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded" || prev.galleryIndex === null) return prev;
      const nextIndex = Math.max(0, Math.min(prev.photos.length - 1, prev.galleryIndex + delta));
      return { ...prev, galleryIndex: nextIndex };
    });
  }, []);

  return [appState, { openFolder, closeFolder, prioritizeQueues, openGallery, closeGallery, navigateGallery }];
}
