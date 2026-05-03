import { useCallback, useEffect, useRef, useState } from "react";
import { ThumbnailStore, ImageMetadataStore } from "./types";
import type {
  AppState,
  PhotoFoundPayload,
  ImageMetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
  PhotoInfo,
} from "./types";

export interface TauriApi {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
}

export interface MediaLibraryActions {
  openFolder: () => Promise<void>;
  openRecent: (folder: string) => Promise<void>;
  closeFolder: () => void;
  prioritizeQueues: (visiblePaths: string[]) => void;
  selectPhoto: (index: number | null) => void;
  showInExplorer: (index: number) => Promise<void>;
  openGallery: (index: number) => void;
  closeGallery: () => void;
  navigateGallery: (delta: -1 | 1) => void;
}

const RECENT_FOLDERS_KEY = "media_library_recent_folders";
const MAX_RECENT_FOLDERS = 5;

const DEFAULT_COLUMNS = ["IFD0:DateTimeOriginal", "IFD0:Model"];

export function useMediaLibrary(api: TauriApi): [AppState & { recentFolders: string[] }, MediaLibraryActions] {
  const [appState, setAppState] = useState<AppState>({ kind: "idle" });
  const [recentFolders, setRecentFolders] = useState<string[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (saved) {
      try {
        setRecentFolders(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load recent folders:", e);
      }
    }
  }, []);

  const thumbnailStoreRef           = useRef<ThumbnailStore>(new ThumbnailStore());
  const imageMetadataStoreRef       = useRef<ImageMetadataStore>(new ImageMetadataStore());
  const imageMetadataReceivedRef    = useRef<number>(0);

  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);

  // Buffer for photo_found events to avoid flooding React with state updates.
  const photoBufferRef = useRef<PhotoInfo[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstFlushRef = useRef<boolean>(true);

  const startScan = useCallback(async (folder: string) => {
    // Stop any existing scan before starting a new one.
    await api.invoke("stop_scan").catch(() => {});

    // Invalidate events and clear buffer from any previous scan.
    activeScanIdRef.current = -1;
    photoBufferRef.current = [];
    isFirstFlushRef.current = true;
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    thumbnailStoreRef.current          = new ThumbnailStore();
    imageMetadataStoreRef.current      = new ImageMetadataStore();
    imageMetadataReceivedRef.current   = 0;

    setAppState({ kind: "loading", folder });
    api.invoke("set_window_title", { title: `Media Library — ${folder}` }).catch(() => {});

    // start_scan returns the scan_id assigned by the backend.
    const scanId = (await api.invoke("start_scan", { folderPath: folder })) as number;
    activeScanIdRef.current = scanId;

    // Update recent folders
    setRecentFolders((prev) => {
      const filtered = prev.filter((f) => f !== folder);
      const updated = [folder, ...filtered].slice(0, MAX_RECENT_FOLDERS);
      localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [api]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    const flushBatch = () => {
      const batch = [...photoBufferRef.current];
      photoBufferRef.current = [];

      setAppState((prev) => {
        if (prev.kind === "idle") return prev;
        
        if (prev.kind === "loading") {
          if (batch.length === 0) return prev;
          
          return {
            kind: "loaded",
            folder: prev.folder,
            photos: batch,
            thumbnails: thumbnailStoreRef.current,
            imageMetadata: imageMetadataStoreRef.current,
            scanning: true,
            imageMetadataRemaining: Math.max(0, batch.length - imageMetadataReceivedRef.current),
            galleryIndex: null,
            selectedIndex: null,
            visibleColumns: DEFAULT_COLUMNS,
          };
        }
        
        if (prev.kind === "loaded") {
          const newPhotos = batch.length > 0 ? [...prev.photos, ...batch] : prev.photos;
          const newRemaining = Math.max(0, newPhotos.length - imageMetadataReceivedRef.current);
          
          if (batch.length === 0 && prev.imageMetadataRemaining === newRemaining) {
            return prev;
          }
          
          return {
            ...prev,
            photos: newPhotos,
            imageMetadataRemaining: newRemaining,
          };
        }
        return prev;
      });
    };

    const setup = async () => {
      const unlistenFound = await api.listen("photo_found", (raw) => {
        if (cancelled) return;
        const { scan_id, photo } = raw as PhotoFoundPayload;
        if (scan_id !== activeScanIdRef.current) return;

        thumbnailStoreRef.current.add(photo.relative_path);
        imageMetadataStoreRef.current.add(photo.relative_path);

        photoBufferRef.current.push(photo);

        const shouldFlushNow = isFirstFlushRef.current || 
                             photoBufferRef.current.length >= 50;

        if (shouldFlushNow) {
          isFirstFlushRef.current = false;
          if (batchTimerRef.current) {
            clearTimeout(batchTimerRef.current);
            batchTimerRef.current = null;
          }
          flushBatch();
        } else if (!batchTimerRef.current) {
          batchTimerRef.current = setTimeout(() => {
            batchTimerRef.current = null;
            flushBatch();
          }, 100);
        }
      });

      const unlistenComplete = await api.listen("scan_complete", (raw) => {
        if (cancelled) return;
        const { scan_id } = raw as { scan_id: number };
        if (scan_id !== activeScanIdRef.current) return;

        if (batchTimerRef.current) {
          clearTimeout(batchTimerRef.current);
          batchTimerRef.current = null;
        }
        flushBatch();

        setAppState((prev) => {
          if (prev.kind === "loaded") return { ...prev, scanning: false };
          if (prev.kind === "loading") {
            return {
              kind: "loaded",
              folder: prev.folder,
              photos: [],
              thumbnails: thumbnailStoreRef.current,
              imageMetadata: imageMetadataStoreRef.current,
              scanning: false,
              imageMetadataRemaining: 0,
              galleryIndex: null,
              selectedIndex: null,
              visibleColumns: DEFAULT_COLUMNS,
            };
          }
          return prev;
        });
      });

      const unlistenMetadata = await api.listen("image_metadata_ready", (raw) => {
        if (cancelled) return;
        const { scan_id, relative_path, metadata } = raw as ImageMetadataReadyPayload;
        if (scan_id !== activeScanIdRef.current) return;
        
        imageMetadataStoreRef.current.set(relative_path, metadata);
        imageMetadataReceivedRef.current += 1;
        
        if (!batchTimerRef.current) {
          batchTimerRef.current = setTimeout(() => {
            batchTimerRef.current = null;
            flushBatch(); 
          }, 100);
        }
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
    await startScan(folder);
  }, [api, startScan]);

  const openRecent = useCallback(async (folder: string) => {
    await startScan(folder);
  }, [startScan]);

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

  const selectPhoto = useCallback((index: number | null) => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, selectedIndex: index } : prev
    );
  }, []);

  const stateRef = useRef(appState);
  stateRef.current = appState;

  const showInExplorer = useCallback(async (index: number) => {
    const current = stateRef.current;
    if (current.kind !== "loaded") return;
    const photo = current.photos[index];
    if (!photo) return;
    
    api.invoke("show_in_explorer", { 
      folder: current.folder, 
      relativePath: photo.relative_path 
    }).catch(() => {});
  }, [api]);

  const openGallery = useCallback((index: number) => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, galleryIndex: index, selectedIndex: index } : prev
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
      return { ...prev, galleryIndex: nextIndex, selectedIndex: nextIndex };
    });
  }, []);

  return [{ ...appState, recentFolders }, { openFolder, openRecent, closeFolder, prioritizeQueues, selectPhoto, showInExplorer, openGallery, closeGallery, navigateGallery }];
}
