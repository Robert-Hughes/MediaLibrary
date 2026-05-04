import { useCallback, useEffect, useRef, useState } from "react";
import { ThumbnailStore, ImageMetadataStore, MetadataProgressStore } from "./types";
import type {
  AppState,
  PhotoFoundPayload,
  ImageMetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
  WorkerErrorPayload,
  PhotoInfo,
  Variant,
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
  setVisibleColumns: (columns: string[]) => void;
  dismissError: (index: number) => void;
}

const RECENT_FOLDERS_KEY = "media_library_recent_folders";
const MAX_RECENT_FOLDERS = 5;

const DEFAULT_COLUMNS = [
  "ExifIFD:DateTimeOriginal",
  "XMP-dc:Description",
  "XMP-dc:Subject",
  "GPS:GPSLatitude",
  "GPS:GPSLongitude",
  "XMP-iptcCore:Location",
  "XMP-photoshop:City",
  "XMP-photoshop:State",
  "XMP-photoshop:Country",
];

export function useMediaLibrary(api: TauriApi): [AppState & { recentFolders: string[] }, MediaLibraryActions] {
  const [appState, setAppState] = useState<AppState>({ kind: "idle" });
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const listenersReadyRef = useRef(false);

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
  const metadataProgressStoreRef    = useRef<MetadataProgressStore>(new MetadataProgressStore());

  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);

  // Buffer for photo_found events to avoid flooding React with state updates.
  const photoBufferRef = useRef<PhotoInfo[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstFlushRef = useRef<boolean>(true);

  // Buffer for image_metadata_ready events to avoid excessive state updates.
  const metadataBufferRef = useRef<{ relative_path: string; metadata: Record<string, Variant> }[]>([]);
  const metadataBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstMetadataFlushRef = useRef<boolean>(true);

  // Buffer for thumbnail_ready events to avoid excessive state updates.
  const thumbnailBufferRef = useRef<{ relative_path: string; thumbnail: string }[]>([]);
  const thumbnailBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstThumbnailFlushRef = useRef<boolean>(true);

  const startScan = useCallback(async (folder: string) => {
    // Wait for event listeners to be ready before starting scan
    if (!listenersReadyRef.current) {
      console.log('[startScan] Waiting for event listeners to be ready...');
      // Wait up to 5 seconds for listeners to be ready
      const startTime = Date.now();
      while (!listenersReadyRef.current && Date.now() - startTime < 5000) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!listenersReadyRef.current) {
        console.error('[startScan] Timeout waiting for event listeners!');
        return;
      }
      console.log('[startScan] Event listeners ready, proceeding with scan');
    }
    
    console.log(`[startScan] Starting scan for folder: ${folder}`);
    
    // Generate scan_id FIRST, before any cleanup, so we can accept events immediately
    const scanId = Date.now();
    
    // Stop any existing scan before starting a new one.
    await api.invoke("stop_scan").catch(() => {});

    // Switch to new scan_id immediately - no gap where it's -1
    const oldScanId = activeScanIdRef.current;
    activeScanIdRef.current = scanId;
    console.log(`[startScan] Switched from scan_id ${oldScanId} to ${scanId}`);
    
    // Clear buffers from any previous scan
    photoBufferRef.current = [];
    isFirstFlushRef.current = true;
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    // Clear metadata buffers
    metadataBufferRef.current = [];
    isFirstMetadataFlushRef.current = true;
    if (metadataBatchTimerRef.current) {
      clearTimeout(metadataBatchTimerRef.current);
      metadataBatchTimerRef.current = null;
    }

    // Clear thumbnail buffers
    thumbnailBufferRef.current = [];
    isFirstThumbnailFlushRef.current = true;
    if (thumbnailBatchTimerRef.current) {
      clearTimeout(thumbnailBatchTimerRef.current);
      thumbnailBatchTimerRef.current = null;
    }

    thumbnailStoreRef.current          = new ThumbnailStore();
    imageMetadataStoreRef.current      = new ImageMetadataStore();
    metadataProgressStoreRef.current   = new MetadataProgressStore();
    
    console.log(`[startScan] Created new stores`);

    setAppState({ kind: "loading", folder });
    api.invoke("set_window_title", { title: `Media Library — ${folder}` }).catch(() => {});

    await api.invoke("start_scan", { scanId, folderPath: folder });
    console.log(`[startScan] Backend scan started`);

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
          
          // Update metadata progress store with new total
          metadataProgressStoreRef.current.setTotal(batch.length);
          
          return {
            kind: "loaded",
            folder: prev.folder,
            photos: batch,
            thumbnails: thumbnailStoreRef.current,
            imageMetadata: imageMetadataStoreRef.current,
            metadataProgress: metadataProgressStoreRef.current,
            scanning: true,
            galleryIndex: null,
            selectedIndex: null,
            visibleColumns: DEFAULT_COLUMNS,
            workerErrors: [],
          };
        }
        
        if (prev.kind === "loaded") {
          const newPhotos = batch.length > 0 ? [...prev.photos, ...batch] : prev.photos;
          
          // Update metadata progress store with new total
          if (batch.length > 0) {
            metadataProgressStoreRef.current.setTotal(newPhotos.length);
          }
          
          if (batch.length === 0) {
            return prev;
          }
          
          return {
            ...prev,
            photos: newPhotos,
          };
        }
        return prev;
      });
    };

    // Flush metadata batch - updates ImageMetadataStore and MetadataProgressStore
    // without rebuilding the entire photos array
    const flushMetadataBatch = () => {
      const batch = [...metadataBufferRef.current];
      metadataBufferRef.current = [];

      if (batch.length === 0) return;

      for (const res of batch) {
        imageMetadataStoreRef.current.set(res.relative_path, res.metadata);
      }

      // Update progress store - this triggers updates only in components that subscribe to it
      metadataProgressStoreRef.current.incrementReceived(batch.length);
    };

    // Flush thumbnail batch - updates ThumbnailStore without triggering
    // unnecessary React state updates (the store handles per-row reactivity)
    const flushThumbnailBatch = () => {
      const batch = [...thumbnailBufferRef.current];
      thumbnailBufferRef.current = [];

      for (const res of batch) {
        thumbnailStoreRef.current.set(res.relative_path, res.thumbnail);
      }
      // No React state update needed - useSyncExternalStore handles per-row updates
    };

    const setup = async () => {
      console.log('[setup] Setting up event listeners');
      
      const unlistenFound = await api.listen("photo_found", (raw) => {
        if (cancelled) return;
        const { scan_id, photos } = raw as PhotoFoundPayload;
        if (scan_id !== activeScanIdRef.current) {
          console.log(`[photo_found] Ignoring stale event from scan_id ${scan_id}, current is ${activeScanIdRef.current}`);
          return;
        }

        for (const photo of photos) {
          thumbnailStoreRef.current.add(photo.relative_path);
          imageMetadataStoreRef.current.add(photo.relative_path);
          photoBufferRef.current.push(photo);
        }

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
        console.log(`[scan_complete] Received for scan_id ${scan_id}, current is ${activeScanIdRef.current}`);
        if (scan_id !== activeScanIdRef.current) {
          console.log(`[scan_complete] Ignoring stale event from scan_id ${scan_id}`);
          return;
        }

        console.log(`[scan_complete] Processing scan completion`);

        // Clear all batch timers and flush remaining batches
        if (batchTimerRef.current) {
          clearTimeout(batchTimerRef.current);
          batchTimerRef.current = null;
        }
        if (metadataBatchTimerRef.current) {
          clearTimeout(metadataBatchTimerRef.current);
          metadataBatchTimerRef.current = null;
        }
        if (thumbnailBatchTimerRef.current) {
          clearTimeout(thumbnailBatchTimerRef.current);
          thumbnailBatchTimerRef.current = null;
        }

        flushBatch();
        flushMetadataBatch();
        flushThumbnailBatch();

        setAppState((prev) => {
          console.log(`[scan_complete] Current state: ${prev.kind}`);
          if (prev.kind === "loaded") return { ...prev, scanning: false };
          if (prev.kind === "loading") {
            console.log(`[scan_complete] Transitioning from loading to loaded with 0 photos`);
            return {
              kind: "loaded",
              folder: prev.folder,
              photos: [],
              thumbnails: thumbnailStoreRef.current,
              imageMetadata: imageMetadataStoreRef.current,
              metadataProgress: metadataProgressStoreRef.current,
              scanning: false,
              galleryIndex: null,
              selectedIndex: null,
              visibleColumns: DEFAULT_COLUMNS,
              workerErrors: [],
            };
          }
          return prev;
        });
      });

      const unlistenMetadata = await api.listen("image_metadata_ready", (raw) => {
        if (cancelled) return;
        const { scan_id, results } = raw as ImageMetadataReadyPayload;
        if (scan_id !== activeScanIdRef.current) {
          console.log(`[metadata] Ignoring stale event from scan_id ${scan_id}, current is ${activeScanIdRef.current}`);
          return;
        }

        console.log(`[metadata] Received ${results.length} metadata results for scan_id ${scan_id}`);

        // Buffer metadata events instead of processing individually
        metadataBufferRef.current.push(...results);

        const shouldFlushNow = isFirstMetadataFlushRef.current ||
                             metadataBufferRef.current.length >= 50;

        if (shouldFlushNow) {
          isFirstMetadataFlushRef.current = false;
          if (metadataBatchTimerRef.current) {
            clearTimeout(metadataBatchTimerRef.current);
            metadataBatchTimerRef.current = null;
          }
          flushMetadataBatch();
        } else if (!metadataBatchTimerRef.current) {
          // Use longer interval (200ms) to reduce update frequency
          metadataBatchTimerRef.current = setTimeout(() => {
            metadataBatchTimerRef.current = null;
            flushMetadataBatch();
          }, 200);
        }
      });

      const unlistenThumbnail = await api.listen("thumbnail_ready", (raw) => {
        if (cancelled) return;
        const { scan_id, results } = raw as ThumbnailReadyPayload;
        if (scan_id !== activeScanIdRef.current) {
          console.log(`[thumbnail] Ignoring stale event from scan_id ${scan_id}, current is ${activeScanIdRef.current}`);
          return;
        }

        console.log(`[thumbnail] Received ${results.length} thumbnail results for scan_id ${scan_id}`);

        // Buffer thumbnail events instead of processing individually
        thumbnailBufferRef.current.push(...results);

        const shouldFlushNow = isFirstThumbnailFlushRef.current ||
                             thumbnailBufferRef.current.length >= 50;

        if (shouldFlushNow) {
          isFirstThumbnailFlushRef.current = false;
          if (thumbnailBatchTimerRef.current) {
            clearTimeout(thumbnailBatchTimerRef.current);
            thumbnailBatchTimerRef.current = null;
          }
          flushThumbnailBatch();
        } else if (!thumbnailBatchTimerRef.current) {
          // Use longer interval (200ms) to reduce update frequency
          thumbnailBatchTimerRef.current = setTimeout(() => {
            thumbnailBatchTimerRef.current = null;
            flushThumbnailBatch();
          }, 200);
        }
      });

      const unlistenError = await api.listen("scan_error", (raw) => {
        if (cancelled) return;
        const payload = raw as ScanErrorPayload;
        console.error("Scan error:", payload.message);
        setAppState({ kind: "idle" });
      });

      const unlistenWorkerError = await api.listen("worker_error", (raw) => {
        if (cancelled) return;
        const payload = raw as WorkerErrorPayload;
        console.error(`Worker error (${payload.worker_type}):`, payload.error_message);
        
        // Add error to the state so UI can display it
        setAppState((prev) => {
          if (prev.kind === "loaded") {
            return {
              ...prev,
              workerErrors: [...prev.workerErrors, payload],
            };
          }
          return prev;
        });
      });

      unlisteners.push(
        unlistenFound, unlistenComplete, unlistenMetadata,
        unlistenThumbnail, unlistenError, unlistenWorkerError,
      );
      
      console.log('[setup] All event listeners registered');
      listenersReadyRef.current = true;
    };

    setup();
    return () => {
      cancelled = true;
      listenersReadyRef.current = false;
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

  const prioritizeQueues = useCallback((visiblePaths: string[]) => {
    console.log(`[prioritizeQueues] Prioritizing ${visiblePaths.length} visible paths:`, visiblePaths.slice(0, 5));
    api.invoke("prioritize_queues", { visiblePaths }).catch(() => {});
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

  const setVisibleColumns = useCallback((columns: string[]) => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, visibleColumns: columns } : prev
    );
  }, []);

  const dismissError = useCallback((index: number) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const newErrors = [...prev.workerErrors];
      newErrors.splice(index, 1);
      return { ...prev, workerErrors: newErrors };
    });
  }, []);

  return [{ ...appState, recentFolders }, { openFolder, openRecent, closeFolder, prioritizeQueues, selectPhoto, showInExplorer, openGallery, closeGallery, navigateGallery, setVisibleColumns, dismissError }];
}
