import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThumbnailStore, ImageMetadataStore, MetadataProgressStore, DraftEditsStore } from "./types";
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
  VisibleColumn,
  ApplyEditsResult,
  ApplyEditsStartedPayload,
  ApplyEditsProgressPayload,
} from "./types";
import type { DraftEdit, DraftEditsByFile } from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";

/**
 * Convert whatever shape the Tauri boundary returned into the canonical
 * typed `DraftEditsByFile`.  Live backend returns typed; tests / older
 * builds may still return the legacy `string | null` shape.  Per-edit
 * detection handles mixed shapes gracefully.
 */
function normalizeDraftsFromTauri(raw: unknown): DraftEditsByFile {
  if (!raw || typeof raw !== "object") return {};
  const out: DraftEditsByFile = {};
  for (const [file, fileEdits] of Object.entries(raw as Record<string, unknown>)) {
    if (!fileEdits || typeof fileEdits !== "object") continue;
    const typed: Record<string, DraftEdit> = {};
    for (const [key, value] of Object.entries(fileEdits as Record<string, unknown>)) {
      if (value && typeof value === "object" && "intent" in value && "value" in value) {
        typed[key] = value as DraftEdit;
      } else if (value === null) {
        typed[key] = { value: null, intent: "Delete" };
      } else if (typeof value === "string") {
        typed[key] = { value, intent: "Set" };
      } else {
        typed[key] = { value: value as DraftEdit["value"], intent: "Set" };
      }
    }
    out[file] = typed;
  }
  return out;
}

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
  navigateGallery: (delta: -1 | 1, options?: { listLength?: number }) => void;
  setVisibleColumns: (columns: VisibleColumn[]) => void;
  setSortConfig: (config: SortConfig) => void;
  updateColumnWidth: (col: string, width: number) => void;
  resetColumnWidths: () => void;
  dismissError: (index: number) => void;
  setDraftTyped: (fileRelativePath: string, propertyKey: string, edit: DraftEdit) => void;
  setDraftBatch: (fileRelativePath: string, edits: Array<{ key: string; edit: DraftEdit }>) => void;
  discardDraftValue: (fileRelativePath: string, propertyKey: string) => void;
  discardAllDraftEdits: (fileRelativePath?: string | string[]) => void;
  applyDraftEdits: (fileRelativePath?: string | string[]) => Promise<ApplyEditsResult>;
  cancelApplyEdits: () => void;
  /** Phase 8.1: clear a Coerced/Mismatch outcome and drop its draft. */
  acceptVerifyOutcome: (fileRelativePath: string, tag: string) => void;
  /** Phase 8.1: re-stage the draft with the value exiftool actually wrote. */
  revertVerifyOutcome: (fileRelativePath: string, tag: string, observedRaw: Variant | null) => void;
  /** Phase 8.1: dismiss a single pending verify outcome without touching the draft. */
  dismissVerifyOutcome: (fileRelativePath: string, tag: string) => void;
  /** Phase 8.1: dismiss every pending verify outcome without acting on them. */
  dismissAllVerifyOutcomes: () => void;
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
  const draftEditsStoreRef          = useRef<DraftEditsStore>(new DraftEditsStore());

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
  const thumbnailBufferRef = useRef<{ relative_path: string; thumbnail: string | null }[]>([]);
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

    try {
      const raw = await api.invoke("load_draft_edits_typed", { folderPath: folder });
      // Backwards-compat: a mock or legacy backend may still return the
      // string-shape map.  Detect and convert per-edit if we see a value
      // that isn't `{ value, intent }`.
      draftEditsStoreRef.current.reset(normalizeDraftsFromTauri(raw));
    } catch (e) {
      console.error("Failed to load draft edits", e);
      draftEditsStoreRef.current.reset({});
    }
    
    const { visibleColumns, sortConfig, columnWidths } = loadColumnConfig();
    setAppState({ kind: "loading", folder, visibleColumns, columnWidths, sortConfig });
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
            visibleColumns: prev.visibleColumns,
            columnWidths: prev.columnWidths,
            sortConfig: prev.sortConfig,
            metadataVersion: 0,
            workerErrors: [],
            draftEdits: draftEditsStoreRef.current.getAll(),
            draftEditsStore: draftEditsStoreRef.current,
            applying: null,
            verifyOutcomes: {},
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
        thumbnailStoreRef.current.set(res.relative_path, res.thumbnail === null ? "failed" : res.thumbnail);
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
              visibleColumns: prev.visibleColumns,
              columnWidths: prev.columnWidths,
              sortConfig: prev.sortConfig,
              metadataVersion: 0,
              workerErrors: [],
              draftEdits: draftEditsStoreRef.current.getAll(),
            draftEditsStore: draftEditsStoreRef.current,
              applying: null,
              verifyOutcomes: {},
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

      const unlistenApplyStarted = await api.listen("apply_edits_started", (raw) => {
        if (cancelled) return;
        const payload = raw as ApplyEditsStartedPayload;
        setAppState((prev) => {
          if (prev.kind !== "loaded") return prev;
          return {
            ...prev,
            applying: {
              total: payload.total,
              current: 0,
              currentFile: null,
              failureCount: 0,
              cancelling: false,
            },
          };
        });
      });

      const unlistenApplyProgress = await api.listen("apply_edits_progress", (raw) => {
        if (cancelled) return;
        const payload = raw as ApplyEditsProgressPayload;

        // Apply per-file changes incrementally so the UI reflects file/disk state
        // in real time and a crash mid-operation leaves coherent state.
        if (payload.fresh_metadata) {
          imageMetadataStoreRef.current.set(payload.relative_path, payload.fresh_metadata);
        }

        // Phase 8.1: prune drafts per-tag based on the backend's verification
        // outcomes.  Match and DeleteOk are conclusively safe to drop; the
        // rest stay so the user can act on them via VerifyOutcomeDialog.
        //
        // Backwards compatibility: when the payload omits `tag_outcomes`
        // (older backend builds, mocked tests), fall back to the previous
        // semantic of "drop the entire file's drafts on success".  Live
        // backend always emits the array so production gets the
        // per-tag-clearing behaviour.
        const fileOutcomes = payload.tag_outcomes ?? [];
        if (fileOutcomes.length === 0 && payload.applied) {
          draftEditsStoreRef.current.deletePath(payload.relative_path);
        } else if (fileOutcomes.length > 0) {
          const tagsToPrune = fileOutcomes
            .filter((o) => o.kind === "Match" || o.kind === "DeleteOk")
            .map((o) => o.tag);
          if (tagsToPrune.length > 0) {
            draftEditsStoreRef.current.pruneTags(payload.relative_path, tagsToPrune);
          }
        }

        setAppState((prev) => {
          if (prev.kind !== "loaded") return prev;

          let newVerifyOutcomes = prev.verifyOutcomes;
          if (fileOutcomes.length > 0) {
            const interesting = fileOutcomes.filter((o) =>
              o.kind === "Coerced"
              || o.kind === "Mismatch"
              || o.kind === "MissingPostWrite"
              || o.kind === "DeleteLingering"
            );
            if (interesting.length > 0) {
              newVerifyOutcomes = { ...prev.verifyOutcomes };
              const existing = newVerifyOutcomes[payload.relative_path] ?? [];
              const merged = [...existing];
              for (const o of interesting) {
                // Replace any prior entry for the same tag so the latest
                // attempt's verdict wins (re-applies are idempotent here).
                const idx = merged.findIndex((m) => m.tag === o.tag);
                const entry = {
                  tag: o.tag,
                  kind: o.kind,
                  sent: o.sent,
                  beforeDisplay: o.before_display,
                  observedDisplay: o.observed_display,
                  observedRaw: o.observed_raw,
                  message: o.message,
                };
                if (idx >= 0) merged[idx] = entry; else merged.push(entry);
              }
              newVerifyOutcomes[payload.relative_path] = merged;
            }
          }

          let newErrors = prev.workerErrors;
          if (payload.error) {
            newErrors = [
              ...prev.workerErrors,
              {
                scan_id: -1,
                worker_type: "apply",
                error_message: payload.error,
                affected_files: [payload.relative_path],
              },
            ];
            if (newErrors.length > MAX_WORKER_ERRORS) {
              newErrors = newErrors.slice(newErrors.length - MAX_WORKER_ERRORS);
            }
          }

          const applying = prev.applying ? {
            ...prev.applying,
            current: payload.current,
            currentFile: payload.relative_path,
            failureCount: prev.applying.failureCount + (payload.error ? 1 : 0),
          } : null;

          return {
            ...prev,
            verifyOutcomes: newVerifyOutcomes,
            workerErrors: newErrors,
            applying,
            metadataVersion: payload.fresh_metadata
              ? prev.metadataVersion + 1
              : prev.metadataVersion,
          };
        });
      });

      unlisteners.push(
        unlistenFound, unlistenComplete, unlistenMetadata,
        unlistenThumbnail, unlistenError, unlistenWorkerError,
        unlistenApplyStarted, unlistenApplyProgress,
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

  // Single hook into every user-initiated draft-edit mutation: keep React
  // state in sync with the store snapshot and persist to disk.  Future
  // subscribers (e.g. search-worker index) attach the same way.
  useEffect(() => {
    const store = draftEditsStoreRef.current;
    const unsub = store.subscribe(() => {
      const next = store.getAll();
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        if (prev.draftEdits === next) return prev;
        return { ...prev, draftEdits: next };
      });
      const cur = stateRef.current;
      if (cur.kind === "loaded") {
        api.invoke("save_draft_edits_typed", {
          folderPath: cur.folder,
          data: next,
        }).catch(console.error);
      }
    });
    return unsub;
  }, [api]);

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

  const navigateGallery = useCallback((delta: number, options?: { listLength?: number }) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded" || prev.galleryIndex === null) return prev;
      const len = options?.listLength ?? prev.photos.length;
      const nextIndex = Math.max(0, Math.min(len - 1, prev.galleryIndex + delta));
      return { ...prev, galleryIndex: nextIndex, selectedIndex: nextIndex };
    });
  }, []);

  const setVisibleColumns = useCallback((columns: VisibleColumn[]) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({ visibleColumns: columns, sortConfig: prev.sortConfig, columnWidths: prev.columnWidths });
      return { ...prev, visibleColumns: columns };
    });
  }, []);

  const setSortConfig = useCallback((config: SortConfig) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({ visibleColumns: prev.visibleColumns, sortConfig: config, columnWidths: prev.columnWidths });
      return { ...prev, sortConfig: config };
    });
  }, []);

  const updateColumnWidth = useCallback((col: string, width: number) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const newWidths = width > 0
        ? { ...prev.columnWidths, [col]: width }
        : Object.fromEntries(Object.entries(prev.columnWidths).filter(([k]) => k !== col));
      saveColumnConfig({ visibleColumns: prev.visibleColumns, sortConfig: prev.sortConfig, columnWidths: newWidths });
      return { ...prev, columnWidths: newWidths };
    });
  }, []);

  const resetColumnWidths = useCallback(() => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({ visibleColumns: prev.visibleColumns, sortConfig: prev.sortConfig, columnWidths: {} });
      return { ...prev, columnWidths: {} };
    });
  }, []);

  /**
   * Phase 8.1 — Accept a Coerced (or otherwise pending) verification outcome:
   * remove the entry from `verifyOutcomes` AND drop the corresponding draft so
   * the file's "saved" state matches what exiftool actually wrote.
   */
  const acceptVerifyOutcome = useCallback((fileRelativePath: string, tag: string) => {
    // Drop the per-tag draft so the next save call mirrors disk.  Store fires
    // the persistence + state-sync subscribers; we still need a setAppState
    // here for the verifyOutcomes side of the change.
    draftEditsStoreRef.current.deleteTag(fileRelativePath, tag);
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const list = prev.verifyOutcomes[fileRelativePath];
      if (!list) return prev;
      const remaining = list.filter((o) => o.tag !== tag);
      const newOutcomes = { ...prev.verifyOutcomes };
      if (remaining.length === 0) {
        delete newOutcomes[fileRelativePath];
      } else {
        newOutcomes[fileRelativePath] = remaining;
      }
      return { ...prev, verifyOutcomes: newOutcomes };
    });
  }, []);

  /**
   * Phase 8.1 — Revert a Coerced outcome: re-stage the draft with the value
   * exiftool actually wrote (raw view), so the user's next save attempt acts
   * on the file as it now is rather than on the original sent value.
   */
  const revertVerifyOutcome = useCallback((fileRelativePath: string, tag: string, observedRaw: Variant | null) => {
    const newEdit: DraftEdit = observedRaw === null
      ? { value: null, intent: "Delete" }
      : { value: observedRaw, intent: "Set" };
    draftEditsStoreRef.current.setTag(fileRelativePath, tag, newEdit);
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const list = prev.verifyOutcomes[fileRelativePath];
      if (!list) return prev;
      const remaining = list.filter((o) => o.tag !== tag);
      const newOutcomes = { ...prev.verifyOutcomes };
      if (remaining.length === 0) {
        delete newOutcomes[fileRelativePath];
      } else {
        newOutcomes[fileRelativePath] = remaining;
      }
      return { ...prev, verifyOutcomes: newOutcomes };
    });
  }, []);

  /**
   * Dismiss one pending verify outcome without acting on it.  Draft is
   * untouched — used for Mismatch / MissingPostWrite / DeleteLingering rows
   * where the user has acknowledged the failure and will fix it manually.
   */
  const dismissVerifyOutcome = useCallback((fileRelativePath: string, tag: string) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const list = prev.verifyOutcomes[fileRelativePath];
      if (!list) return prev;
      const remaining = list.filter((o) => o.tag !== tag);
      const newOutcomes = { ...prev.verifyOutcomes };
      if (remaining.length === 0) {
        delete newOutcomes[fileRelativePath];
      } else {
        newOutcomes[fileRelativePath] = remaining;
      }
      return { ...prev, verifyOutcomes: newOutcomes };
    });
  }, []);

  /**
   * Dismiss every pending verify outcome without acting on them.  Drafts are
   * untouched — the user can still see and triage them later from the draft
   * pane if they reopen the file.
   */
  const dismissAllVerifyOutcomes = useCallback(() => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      if (Object.keys(prev.verifyOutcomes).length === 0) return prev;
      return { ...prev, verifyOutcomes: {} };
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

  /**
   * Set many draft entries for one file in a single state update.  Used by
   * paired-tag editors like GpsEditor that must update Latitude / Ref /
   * Longitude / Ref atomically so the on-disk file never has half-updated
   * coords if the user navigates away mid-edit.
   */
  const setDraftBatch = useCallback((fileRelativePath: string, edits: Array<{ key: string; edit: DraftEdit }>) => {
    draftEditsStoreRef.current.setBatch(fileRelativePath, edits);
  }, []);

  const setDraftTyped = useCallback((fileRelativePath: string, propertyKey: string, edit: DraftEdit) => {
    draftEditsStoreRef.current.setTag(fileRelativePath, propertyKey, edit);
  }, []);

  const discardDraftValue = useCallback((fileRelativePath: string, propertyKey: string) => {
    draftEditsStoreRef.current.deleteTag(fileRelativePath, propertyKey);
  }, []);

  const discardAllDraftEdits = useCallback((fileRelativePath?: string | string[]) => {
    if (fileRelativePath === undefined) {
      draftEditsStoreRef.current.clear();
    } else {
      const paths = Array.isArray(fileRelativePath) ? fileRelativePath : [fileRelativePath];
      draftEditsStoreRef.current.deletePaths(paths);
    }
  }, []);

  /**
   * Apply draft edits. The backend processes files one at a time, emitting
   * `apply_edits_started` once and `apply_edits_progress` after each file.
   * Those events drive incremental state updates (see setup()), so this
   * function does not need to apply any state changes from the final result.
   *
   * The promise resolves once all files are done (or cancellation took effect).
   * Callers can use the result for a final summary; state is already current.
   */
  const applyDraftEdits = useCallback(async (fileRelativePath?: string | string[]): Promise<ApplyEditsResult> => {
    const current = stateRef.current;
    if (current.kind !== "loaded") {
      return { applied: [], failed: [], fresh_metadata: {} };
    }

    let relPaths: string[];
    if (fileRelativePath === undefined) {
      relPaths = Object.keys(current.draftEdits ?? {});
    } else {
      const requested = Array.isArray(fileRelativePath) ? fileRelativePath : [fileRelativePath];
      relPaths = requested.filter((p) => current.draftEdits?.[p]);
    }

    if (relPaths.length === 0) {
      return { applied: [], failed: [], fresh_metadata: {} };
    }

    try {
      const result = (await api.invoke("apply_draft_edits_cmd", {
        folderPath: current.folder,
        relPaths,
      })) as ApplyEditsResult;
      return result;
    } finally {
      // Always clear the in-flight modal regardless of resolution path
      setAppState((prev) => prev.kind === "loaded" ? { ...prev, applying: null } : prev);
    }
  }, [api]);

  const cancelApplyEdits = useCallback(() => {
    api.invoke("cancel_apply_edits").catch(() => {});
    setAppState((prev) => {
      if (prev.kind !== "loaded" || !prev.applying) return prev;
      return { ...prev, applying: { ...prev.applying, cancelling: true } };
    });
  }, [api]);

  const mediaLibraryActions = useMemo(
    () => ({
      openFolder,
      openRecent,
      closeFolder,
      prioritizeQueues,
      selectPhoto,
      showInExplorer,
      openGallery,
      closeGallery,
      navigateGallery,
      setVisibleColumns,
      setSortConfig,
      updateColumnWidth,
      resetColumnWidths,
      dismissError,
      setDraftTyped,
      setDraftBatch,
      discardDraftValue,
      discardAllDraftEdits,
      applyDraftEdits,
      cancelApplyEdits,
      acceptVerifyOutcome,
      revertVerifyOutcome,
      dismissVerifyOutcome,
      dismissAllVerifyOutcomes,
    }),
    [
      openFolder,
      openRecent,
      closeFolder,
      prioritizeQueues,
      selectPhoto,
      showInExplorer,
      openGallery,
      closeGallery,
      navigateGallery,
      setVisibleColumns,
      setSortConfig,
      updateColumnWidth,
      resetColumnWidths,
      dismissError,
      setDraftTyped,
      setDraftBatch,
      discardDraftValue,
      discardAllDraftEdits,
      applyDraftEdits,
      cancelApplyEdits,
      acceptVerifyOutcome,
      revertVerifyOutcome,
      dismissVerifyOutcome,
      dismissAllVerifyOutcomes,
    ],
  );

  return [{ ...appState, recentFolders }, mediaLibraryActions];
}
