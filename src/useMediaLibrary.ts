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
  SortConfig,
} from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";

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
  setVisibleOSColumns: (columns: string[]) => void;
  setSortConfig: (config: SortConfig) => void;
  updateColumnWidth: (col: string, width: number) => void;
  dismissError: (index: number) => void;
}

const RECENT_FOLDERS_KEY = "media_library_recent_folders";
const MAX_RECENT_FOLDERS = 5;

/**
 * Decide whether to flush the buffer now or schedule a deferred flush.
 *
 * The first flush of a stream goes immediately (so the UI shows results as
 * soon as the first event lands), and any flush where the buffer has
 * accumulated `flushAtCount` items also goes immediately (to keep memory
 * bounded under heavy load).  Otherwise we defer for `debounceMs` so a
 * burst of small events coalesces into one React update.
 *
 * Used by three near-identical handlers (photo_found, image_metadata_ready,
 * thumbnail_ready); extracted so they share the same coalescing semantics.
 */
function scheduleBatchedFlush(
  bufferLength: number,
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  isFirstFlushRef: { current: boolean },
  flush: () => void,
  debounceMs: number,
  flushAtCount = 50,
) {
  const shouldFlushNow = isFirstFlushRef.current || bufferLength >= flushAtCount;
  if (shouldFlushNow) {
    isFirstFlushRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    flush();
  } else if (!timerRef.current) {
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, debounceMs);
  }
}
/** Cap on retained worker errors. A misconfigured ExifTool or a bad folder
 *  can produce thousands of failures; without a cap the array grows unbounded
 *  and bloats React state.  Most-recent-N is what the user can act on. */
const MAX_WORKER_ERRORS = 20;

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
  const metadataProgressStoreRef    = useRef<MetadataProgressStore>(new MetadataProgressStore());

  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);

  // Promise-based latch: resolves once the current useEffect cycle has finished
  // registering all event listeners.  startScan awaits this so it never races
  // with the async listener setup.  Re-created at the start of each setup().
  const listenersReadyRef = useRef<Promise<void>>(Promise.resolve());

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
    // Wait for event listeners to be registered before starting the scan so
    // photo_found / scan_complete events are never missed.  The latch is a
    // plain Promise (no setTimeout) so it works correctly with vi.useFakeTimers().
    await listenersReadyRef.current;

    // Generate scan_id FIRST, before any cleanup, so we can accept events immediately
    const scanId = Date.now();
    console.log(`[startScan] folder=${folder} scanId=${scanId}`);

    // Stop any existing scan before starting a new one.
    await api.invoke("stop_scan").catch(() => {});

    // Switch to new scan_id immediately — no gap where it's -1
    activeScanIdRef.current = scanId;
    
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
    
    setAppState({ kind: "loading", folder });
    api.invoke("set_window_title", { title: `Media Library — ${folder}` }).catch(() => {});

    await api.invoke("start_scan", { scanId, folderPath: folder });

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
      console.log(`[photo_found] flushing ${batch.length} photos (total buffer was ${batch.length})`);

      setAppState((prev) => {
        if (prev.kind === "idle") return prev;
        
        if (prev.kind === "loading") {
          if (batch.length === 0) return prev;

          // Update metadata progress store with new total
          metadataProgressStoreRef.current.setTotal(batch.length);

          const { visibleColumns, visibleOSColumns, sortConfig, columnWidths } = loadColumnConfig();
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
            visibleColumns,
            visibleOSColumns,
            columnWidths,
            sortConfig,
            metadataVersion: 0,
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
      console.log(`[metadata] flushing ${batch.length} results`);

      for (const res of batch) {
        imageMetadataStoreRef.current.set(res.relative_path, res.metadata);
      }

      // Update progress store - this triggers updates only in components that subscribe to it
      metadataProgressStoreRef.current.incrementReceived(batch.length);

      // Increment metadataVersion so that any active sort on image metadata fields
      // causes the sortedPhotos useMemo to recompute.
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        if (!prev.sortConfig.primary || prev.sortConfig.primary.columnType !== "image") return prev;
        return { ...prev, metadataVersion: prev.metadataVersion + 1 };
      });
    };

    // Flush thumbnail batch - updates ThumbnailStore without triggering
    // unnecessary React state updates (the store handles per-row reactivity)
    const flushThumbnailBatch = () => {
      const batch = [...thumbnailBufferRef.current];
      thumbnailBufferRef.current = [];
      if (batch.length > 0) console.log(`[thumbnail] flushing ${batch.length} results`);

      for (const res of batch) {
        thumbnailStoreRef.current.set(res.relative_path, res.thumbnail);
      }
      // No React state update needed - useSyncExternalStore handles per-row updates
    };

    const setup = async () => {
      // Create a new pending latch for this setup cycle; startScan awaits it.
      let resolve!: () => void;
      listenersReadyRef.current = new Promise<void>(r => { resolve = r; });

      const unlistenFound = await api.listen("photo_found", (raw) => {
        if (cancelled) return;
        const { scan_id, photos } = raw as PhotoFoundPayload;
        if (scan_id !== activeScanIdRef.current) return;
        console.log(`[photo_found] received ${photos.length} photos`);

        for (const photo of photos) {
          thumbnailStoreRef.current.add(photo.relative_path);
          imageMetadataStoreRef.current.add(photo.relative_path);
          photoBufferRef.current.push(photo);
        }

        scheduleBatchedFlush(
          photoBufferRef.current.length,
          batchTimerRef,
          isFirstFlushRef,
          flushBatch,
          100,
        );
      });

      const unlistenComplete = await api.listen("scan_complete", (raw) => {
        if (cancelled) return;
        const { scan_id } = raw as { scan_id: number };
        if (scan_id !== activeScanIdRef.current) return;
        console.log(`[scan_complete] scan_id=${scan_id}`);

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
          if (prev.kind === "loaded") return { ...prev, scanning: false };
          if (prev.kind === "loading") {
            const { visibleColumns, visibleOSColumns, sortConfig, columnWidths } = loadColumnConfig();
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
              visibleColumns,
              visibleOSColumns,
              columnWidths,
              sortConfig,
              metadataVersion: 0,
              workerErrors: [],
            };
          }
          return prev;
        });
      });

      const unlistenMetadata = await api.listen("image_metadata_ready", (raw) => {
        if (cancelled) return;
        const { scan_id, results } = raw as ImageMetadataReadyPayload;
        if (scan_id !== activeScanIdRef.current) return;
        console.log(`[metadata] received ${results.length} results`);

        metadataBufferRef.current.push(...results);
        scheduleBatchedFlush(
          metadataBufferRef.current.length,
          metadataBatchTimerRef,
          isFirstMetadataFlushRef,
          flushMetadataBatch,
          200,
        );
      });

      const unlistenThumbnail = await api.listen("thumbnail_ready", (raw) => {
        if (cancelled) return;
        const { scan_id, results } = raw as ThumbnailReadyPayload;
        if (scan_id !== activeScanIdRef.current) return;
        console.log(`[thumbnail] received ${results.length} results`);

        thumbnailBufferRef.current.push(...results);
        scheduleBatchedFlush(
          thumbnailBufferRef.current.length,
          thumbnailBatchTimerRef,
          isFirstThumbnailFlushRef,
          flushThumbnailBatch,
          200,
        );
      });

      const unlistenError = await api.listen("scan_error", (raw) => {
        if (cancelled) return;
        const payload = raw as ScanErrorPayload;
        if (payload.scan_id !== activeScanIdRef.current) return;
        console.error("Scan error:", payload.message);
        setAppState({ kind: "idle" });
      });

      const unlistenWorkerError = await api.listen("worker_error", (raw) => {
        if (cancelled) return;
        const payload = raw as WorkerErrorPayload;
        console.error(`Worker error (${payload.worker_type}):`, payload.error_message);
        
        // Add error to the state so UI can display it (capped — see MAX_WORKER_ERRORS)
        setAppState((prev) => {
          if (prev.kind === "loaded") {
            const next = [...prev.workerErrors, payload];
            if (next.length > MAX_WORKER_ERRORS) {
              next.splice(0, next.length - MAX_WORKER_ERRORS);
            }
            return { ...prev, workerErrors: next };
          }
          return prev;
        });
      });

      unlisteners.push(
        unlistenFound, unlistenComplete, unlistenMetadata,
        unlistenThumbnail, unlistenError, unlistenWorkerError,
      );

      // All listeners registered — unblock any startScan that was awaiting.
      console.log("[setup] all listeners registered");
      resolve();
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

    // Cancel any pending batch flushes — they would still safely no-op against
    // the idle state, but leaving timers running keeps closures alive past
    // the scan they belong to and adds noise on next render.
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

    // Drop any buffered events that haven't been flushed yet.
    photoBufferRef.current = [];
    metadataBufferRef.current = [];
    thumbnailBufferRef.current = [];

    setAppState({ kind: "idle" });
    api.invoke("stop_scan").catch(() => {});
    api.invoke("set_window_title", { title: "Media Library" }).catch(() => {});
  }, [api]);

  const prioritizeQueues = useCallback((visiblePaths: string[]) => {
    console.log(`[prioritizeQueues] ${visiblePaths.length} paths`);
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
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({ visibleColumns: columns, visibleOSColumns: prev.visibleOSColumns, sortConfig: prev.sortConfig, columnWidths: prev.columnWidths });
      return { ...prev, visibleColumns: columns };
    });
  }, []);

  const setVisibleOSColumns = useCallback((columns: string[]) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({ visibleColumns: prev.visibleColumns, visibleOSColumns: columns, sortConfig: prev.sortConfig, columnWidths: prev.columnWidths });
      return { ...prev, visibleOSColumns: columns };
    });
  }, []);

  const setSortConfig = useCallback((config: SortConfig) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({ visibleColumns: prev.visibleColumns, visibleOSColumns: prev.visibleOSColumns, sortConfig: config, columnWidths: prev.columnWidths });
      return { ...prev, sortConfig: config };
    });
  }, []);

  const updateColumnWidth = useCallback((col: string, width: number) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const newWidths = width > 0
        ? { ...prev.columnWidths, [col]: width }
        : Object.fromEntries(Object.entries(prev.columnWidths).filter(([k]) => k !== col));
      saveColumnConfig({ visibleColumns: prev.visibleColumns, visibleOSColumns: prev.visibleOSColumns, sortConfig: prev.sortConfig, columnWidths: newWidths });
      return { ...prev, columnWidths: newWidths };
    });
  }, []);

  const dismissError = useCallback((index: number) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const newErrors = [...prev.workerErrors];
      newErrors.splice(index, 1);
      return { ...prev, workerErrors: newErrors };
    });
  }, []);

  return [{ ...appState, recentFolders }, { openFolder, openRecent, closeFolder, prioritizeQueues, selectPhoto, showInExplorer, openGallery, closeGallery, navigateGallery, setVisibleColumns, setVisibleOSColumns, setSortConfig, updateColumnWidth, dismissError }];
}
