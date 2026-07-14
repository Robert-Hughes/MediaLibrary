import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThumbnailStore,
  ImageMetadataStore,
  ImageMetadataOccurrencesStore,
  MetadataProgressStore,
  DraftEditsStore,
  metadataDraftsFromWire,
  metadataDraftsToWire,
} from "./types";
import type {
  AppState,
  PhotoFoundPayload,
  ImageMetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
  WorkerErrorPayload,
  PhotoInfo,
  SortConfig,
  VisibleColumn,
  MetadataApplyEditsResult,
  ApplyEditsStartedPayload,
  ApplyEditsProgressPayload,
  MetadataDraftEdit,
  MetadataValue,
  SchemaDefinitionId,
  ImageMetadata,
  TargetDraftPersistenceStateV5,
} from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";
import {
  MAX_WORKER_ERRORS,
  normalizeMetadataFromTauri,
  normalizeMetadataOccurrencesFromTauri,
  scheduleBatchedFlush,
} from "./utils/scanEvents";
import { metadataGet } from "./utils/metadataCollection";
import {
  mergeVerifyOutcomes,
  removeVerifyOutcome,
} from "./utils/verifyOutcomes";
import { useRecentFolders } from "./hooks/useRecentFolders";
import {
  TargetDraftEditsStore,
  type TargetDraftEditsByFile,
} from "./targetDraftEdits";
import { TargetDraftAutosaveGateV5 } from "./targetDraftAutosaveGate";
import { TargetApplyControllerV5 } from "./targetApplyController";
import {
  loadTargetDraftEditsV5,
  saveTargetDraftEditsV5,
} from "./targetDraftTauri";
import type { MetadataDraftTarget } from "./types";
import { schemaDefinitionIdToken } from "./utils/schemaDefinitionId";
import { resolveTargetDraftByExactSchema } from "./targetDraftView";

const TARGET_DRAFT_LOAD_BLOCKED_MESSAGE =
  "Target-aware drafts could not be loaded safely. Fix the folder's schema-v5 draft persistence file, then reopen the folder.";

const TARGET_DRAFT_NOT_LOADED_STATE: TargetDraftPersistenceStateV5 = {
  status: "load-failed",
  error: "Target-aware drafts have not finished loading for this folder.",
};

export interface TauriApi {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (
    event: string,
    handler: (payload: unknown) => void,
  ) => Promise<() => void>;
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
  setMetadataDraftBatch: (
    fileRelativePath: string,
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) => void;
  setMetadataDraft: (
    fileRelativePath: string,
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ) => void;
  setNewPropertyDraft: (
    fileRelativePath: string,
    id: SchemaDefinitionId,
    edit: MetadataDraftEdit,
  ) => void;
  setTargetPropertyDraft: (
    fileRelativePath: string,
    target: MetadataDraftTarget,
    edit: MetadataDraftEdit,
  ) => void;
  discardTargetPropertyDraft: (
    fileRelativePath: string,
    target: MetadataDraftTarget,
  ) => void;
  discardDraftValue: (fileRelativePath: string, id: SchemaDefinitionId) => void;
  discardDraftValues: (
    fileRelativePath: string,
    ids: SchemaDefinitionId[],
  ) => void;
  discardAllDraftEdits: (fileRelativePath?: string | string[]) => void;
  applyDraftEdits: (
    fileRelativePath?: string | string[],
  ) => Promise<MetadataApplyEditsResult>;
  cancelApplyEdits: () => void;
  /** Phase 8.1: clear a Coerced/Mismatch outcome and drop its draft. */
  acceptVerifyOutcome: (
    fileRelativePath: string,
    id: SchemaDefinitionId,
  ) => void;
  /** Phase 8.1: re-stage the draft with the value exiftool actually wrote. */
  revertVerifyOutcome: (
    fileRelativePath: string,
    id: SchemaDefinitionId,
    observed: MetadataValue | null,
  ) => void;
  /** Phase 8.1: dismiss a single pending verify outcome without touching the draft. */
  dismissVerifyOutcome: (
    fileRelativePath: string,
    id: SchemaDefinitionId,
  ) => void;
  /** Phase 8.1: dismiss every pending verify outcome without acting on them. */
  dismissAllVerifyOutcomes: () => void;
}

export function useMediaLibrary(
  api: TauriApi,
): [AppState & { recentFolders: string[] }, MediaLibraryActions] {
  const [appState, setAppState] = useState<AppState>({ kind: "idle" });
  const [recentFolders, pushRecentFolder] = useRecentFolders();

  const thumbnailStoreRef = useRef<ThumbnailStore>(new ThumbnailStore());
  const imageMetadataStoreRef = useRef<ImageMetadataStore>(
    new ImageMetadataStore(),
  );
  const imageMetadataOccurrencesStoreRef =
    useRef<ImageMetadataOccurrencesStore>(new ImageMetadataOccurrencesStore());
  const metadataProgressStoreRef = useRef<MetadataProgressStore>(
    new MetadataProgressStore(),
  );
  const draftEditsStoreRef = useRef<DraftEditsStore>(new DraftEditsStore());
  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);
  const targetDraftEditsStoreRef = useRef<TargetDraftEditsStore>(
    new TargetDraftEditsStore(),
  );
  const targetDraftAutosaveGateRef = useRef<TargetDraftAutosaveGateV5>(
    new TargetDraftAutosaveGateV5(),
  );
  const targetApplyControllerRef = useRef<TargetApplyControllerV5 | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const activeFolderRef = useRef<string | null>(null);
  const targetLoadErrorRef = useRef<WorkerErrorPayload | null>(null);
  const targetDraftPersistenceRef = useRef<TargetDraftPersistenceStateV5>(
    TARGET_DRAFT_NOT_LOADED_STATE,
  );
  const combinedApplyRef = useRef<{
    active: boolean;
    phase: "target-v5" | "legacy-v4" | null;
  }>({ active: false, phase: null });
  const activeApplyPromiseRef =
    useRef<Promise<MetadataApplyEditsResult> | null>(null);

  const pushApplicationError = useCallback(
    (workerType: string, error: unknown, affectedFiles: string[] = []) => {
      const payload: WorkerErrorPayload = {
        scan_id: activeScanIdRef.current,
        worker_type: workerType,
        error_message: error instanceof Error ? error.message : String(error),
        affected_files: affectedFiles,
      };
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const workerErrors = [...prev.workerErrors, payload].slice(
          -MAX_WORKER_ERRORS,
        );
        return { ...prev, workerErrors };
      });
    },
    [],
  );

  // Redundant-draft guard: let DraftEditsStore peek at current
  // metadata so writes that match the existing value drop silently
  // (and clear any stale draft for the same tag). One-time wiring;
  // the store keeps the function as a permanent reference. We re-read
  // `imageMetadataStoreRef.current` on every call so re-scans that
  // swap the metadata store don't leave the resolver pointing at the
  // old instance.
  useEffect(() => {
    draftEditsStoreRef.current.setCurrentValueResolver((path, id) => {
      const meta = imageMetadataStoreRef.current.get(path);
      if (meta === "loading") return undefined;
      return metadataGet(meta, id);
    });
  }, []);

  // Promise-based latch: resolves once the current useEffect cycle has finished
  // registering all event listeners.  startScan awaits this so it never races
  // with the async listener setup.  Re-created at the start of each setup().
  const listenersReadyRef = useRef<Promise<void>>(Promise.resolve());

  // Per-stream buffer trio: events arrive faster than React state updates
  // are useful, so each stream coalesces into batched flushes (see
  // scheduleBatchedFlush). Refs (not state) because the buffers are
  // imperative scratch space, not part of the render cycle.
  const photoBufferRef = useRef<PhotoInfo[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstFlushRef = useRef<boolean>(true);

  const metadataBufferRef = useRef<ImageMetadata[]>([]);
  const metadataBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const isFirstMetadataFlushRef = useRef<boolean>(true);

  const thumbnailBufferRef = useRef<
    { relative_path: string; thumbnail: string | null }[]
  >([]);
  const thumbnailBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const isFirstThumbnailFlushRef = useRef<boolean>(true);

  // Construct the sole production v5 controller after mount. Its dependency
  // stores keep stable identity for the complete hook lifetime.
  useEffect(() => {
    let controller = targetApplyControllerRef.current;
    if (controller === null) {
      controller = new TargetApplyControllerV5(
        {
          api: {
            invoke: (command, args) => apiRef.current.invoke(command, args),
            listen: (event, handler) => apiRef.current.listen(event, handler),
          },
          stores: {
            drafts: targetDraftEditsStoreRef.current,
            occurrences: imageMetadataOccurrencesStoreRef.current,
            compatibility: imageMetadataStoreRef.current,
          },
          autosaveGate: targetDraftAutosaveGateRef.current,
        },
        {
          onProgress: (_payload, application) => {
            if (!application.compatibilityChanged) return;
            setAppState((prev) =>
              prev.kind === "loaded"
                ? { ...prev, metadataVersion: prev.metadataVersion + 1 }
                : prev,
            );
          },
          onFinalApplied: (_result, application) => {
            if (!application.files.some((file) => file.compatibilityChanged)) {
              return;
            }
            setAppState((prev) =>
              prev.kind === "loaded"
                ? { ...prev, metadataVersion: prev.metadataVersion + 1 }
                : prev,
            );
          },
          onProtocolError: ({ error }) =>
            pushApplicationError("metadata-v5-protocol", error),
          onProgressApplicationError: ({ error }) =>
            pushApplicationError("metadata-v5-progress", error),
        },
      );
      targetApplyControllerRef.current = controller;
    }
    const unsubscribe = controller.subscribe((targetApplying) => {
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        let applying = prev.applying;
        if (
          combinedApplyRef.current.active &&
          combinedApplyRef.current.phase === "target-v5" &&
          targetApplying.status === "running"
        ) {
          applying = {
            total: targetApplying.total ?? 0,
            current: targetApplying.current,
            currentFile: targetApplying.currentFile,
            failureCount:
              targetApplying.protocolErrorCount +
              targetApplying.progressApplicationErrorCount,
            cancelling: targetApplying.cancelling,
            phase: "target-v5",
          };
        }
        if (
          prev.targetApplying === targetApplying &&
          prev.applying === applying
        ) {
          return prev;
        }
        return { ...prev, targetApplying, applying };
      });
    });
    return () => {
      unsubscribe();
    };
  }, [pushApplicationError]);

  const cancelActiveApplyAndWait = useCallback(async () => {
    if (!combinedApplyRef.current.active) return;
    if (combinedApplyRef.current.phase === "target-v5") {
      await targetApplyControllerRef.current?.cancel().catch(() => {});
    } else if (combinedApplyRef.current.phase === "legacy-v4") {
      await apiRef.current.invoke("cancel_apply_edits").catch(() => {});
    }
    await activeApplyPromiseRef.current?.catch(() => {});
  }, []);

  const startScan = useCallback(
    async (folder: string) => {
      // Wait for event listeners to be registered before starting the scan so
      // photo_found / scan_complete events are never missed.  The latch is a
      // plain Promise (no setTimeout) so it works correctly with vi.useFakeTimers().
      await listenersReadyRef.current;

      // A folder owns both persistence systems. Finish cancellation before
      // clearing stable stores so late controller events cannot cross folders.
      await cancelActiveApplyAndWait();

      // Generate scan_id FIRST, before any cleanup, so we can accept events immediately
      const scanId = Date.now();
      console.debug(`[startScan] folder=${folder} scanId=${scanId}`);

      // Stop any existing scan before starting a new one.
      await api.invoke("stop_scan").catch(() => {});

      // Switch to new scan_id immediately — no gap where it's -1
      activeScanIdRef.current = scanId;

      // Clear all buffers + timers from any previous scan
      photoBufferRef.current = [];
      metadataBufferRef.current = [];
      thumbnailBufferRef.current = [];
      isFirstFlushRef.current = true;
      isFirstMetadataFlushRef.current = true;
      isFirstThumbnailFlushRef.current = true;
      for (const t of [
        batchTimerRef,
        metadataBatchTimerRef,
        thumbnailBatchTimerRef,
      ]) {
        if (t.current) {
          clearTimeout(t.current);
          t.current = null;
        }
      }

      thumbnailStoreRef.current = new ThumbnailStore();
      imageMetadataStoreRef.current.clear();
      imageMetadataOccurrencesStoreRef.current.clear();
      metadataProgressStoreRef.current = new MetadataProgressStore();
      activeFolderRef.current = folder;
      targetLoadErrorRef.current = null;
      targetDraftPersistenceRef.current = TARGET_DRAFT_NOT_LOADED_STATE;
      const { visibleColumns, sortConfig, columnWidths } = loadColumnConfig();
      setAppState({
        kind: "loading",
        folder,
        visibleColumns,
        columnWidths,
        sortConfig,
      });
      api
        .invoke("set_window_title", { title: `Media Library — ${folder}` })
        .catch(() => {});

      // The temporary bridge loads v4 and strict v5 independently. A bad v5
      // file is reported and held intact; it is never treated as an empty file
      // to be overwritten during initialisation.
      await Promise.all([
        (async () => {
          try {
            const raw = await api.invoke("load_metadata_draft_edits", {
              folderPath: folder,
            });
            draftEditsStoreRef.current.resetMetadata(
              metadataDraftsFromWire(
                raw as Record<string, import("./types").MetadataDraftEntry[]>,
              ),
            );
          } catch (e) {
            console.error("Failed to load draft edits", e);
            draftEditsStoreRef.current.resetMetadata({});
          }
        })(),
        (async () => {
          try {
            const loaded = await loadTargetDraftEditsV5(api, folder);
            targetDraftEditsStoreRef.current.resetMetadata(loaded);
            targetDraftPersistenceRef.current = { status: "ready" };
          } catch (error) {
            console.error("Failed to load schema-v5 target drafts", error);
            targetDraftEditsStoreRef.current.resetMetadata({});
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            targetDraftPersistenceRef.current = {
              status: "load-failed",
              error: errorMessage,
            };
            targetLoadErrorRef.current = {
              scan_id: scanId,
              worker_type: "metadata-v5-load",
              error_message: errorMessage,
              affected_files: [],
            };
          }
        })(),
      ]);

      await api.invoke("start_scan", { scanId, folderPath: folder });
      pushRecentFolder(folder);
    },
    [api, cancelActiveApplyAndWait, pushRecentFolder],
  );

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    const flushBatch = () => {
      const batch = [...photoBufferRef.current];
      photoBufferRef.current = [];
      console.debug(
        `[photo_found] flushing ${batch.length} photos (total buffer was ${batch.length})`,
      );

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
            imageMetadataOccurrences: imageMetadataOccurrencesStoreRef.current,
            metadataProgress: metadataProgressStoreRef.current,
            scanning: true,
            galleryIndex: null,
            selectedIndex: null,
            visibleColumns: prev.visibleColumns,
            columnWidths: prev.columnWidths,
            sortConfig: prev.sortConfig,
            metadataVersion: 0,
            workerErrors: targetLoadErrorRef.current
              ? [targetLoadErrorRef.current]
              : [],
            draftEdits: draftEditsStoreRef.current.getAllMetadata(),
            draftEditsStore: draftEditsStoreRef.current,
            targetDraftEdits: targetDraftEditsStoreRef.current.getAllMetadata(),
            targetDraftEditsStore: targetDraftEditsStoreRef.current,
            targetDraftPersistence: targetDraftPersistenceRef.current,
            targetApplying: targetApplyControllerRef.current?.getState() ?? {
              status: "idle",
            },
            applying: null,
            verifyOutcomes: {},
          };
        }

        if (prev.kind === "loaded") {
          if (batch.length === 0) return prev;
          const newPhotos = [...prev.photos, ...batch];
          metadataProgressStoreRef.current.setTotal(newPhotos.length);
          return { ...prev, photos: newPhotos };
        }
        return prev;
      });
    };

    // Flush both authoritative occurrences and the legacy compatibility view.
    const flushMetadataBatch = () => {
      const batch = [...metadataBufferRef.current];
      metadataBufferRef.current = [];

      if (batch.length === 0) return;
      console.debug(`[metadata] flushing ${batch.length} results`);

      for (const res of batch) {
        imageMetadataOccurrencesStoreRef.current.set(
          res.relative_path,
          normalizeMetadataOccurrencesFromTauri(res.occurrences),
        );
        imageMetadataStoreRef.current.set(
          res.relative_path,
          normalizeMetadataFromTauri(res.metadata),
        );
      }

      // Update progress store - this triggers updates only in components that subscribe to it
      metadataProgressStoreRef.current.incrementReceived(batch.length);

      // Increment metadataVersion so that any active sort on image metadata fields
      // causes the sortedPhotos useMemo to recompute.
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        if (
          !prev.sortConfig.primary ||
          prev.sortConfig.primary.kind !== "image"
        )
          return prev;
        return { ...prev, metadataVersion: prev.metadataVersion + 1 };
      });
    };

    // Flush thumbnail batch - updates ThumbnailStore without triggering
    // unnecessary React state updates (the store handles per-row reactivity)
    const flushThumbnailBatch = () => {
      const batch = [...thumbnailBufferRef.current];
      thumbnailBufferRef.current = [];
      if (batch.length > 0)
        console.debug(`[thumbnail] flushing ${batch.length} results`);

      for (const res of batch) {
        thumbnailStoreRef.current.set(
          res.relative_path,
          res.thumbnail === null ? "failed" : res.thumbnail,
        );
      }
      // No React state update needed - useSyncExternalStore handles per-row updates
    };

    const setup = async () => {
      // Create a new pending latch for this setup cycle; startScan awaits it.
      let resolve!: () => void;
      listenersReadyRef.current = new Promise<void>((r) => {
        resolve = r;
      });

      const unlistenFound = await api.listen("photo_found", (raw) => {
        if (cancelled) return;
        const { scan_id, photos } = raw as PhotoFoundPayload;
        if (scan_id !== activeScanIdRef.current) return;
        console.debug(`[photo_found] received ${photos.length} photos`);

        for (const photo of photos) {
          thumbnailStoreRef.current.add(photo.relative_path);
          imageMetadataStoreRef.current.add(photo.relative_path);
          imageMetadataOccurrencesStoreRef.current.add(photo.relative_path);
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
        console.debug(`[scan_complete] scan_id=${scan_id}`);

        // Clear all batch timers and flush remaining batches
        for (const t of [
          batchTimerRef,
          metadataBatchTimerRef,
          thumbnailBatchTimerRef,
        ]) {
          if (t.current) {
            clearTimeout(t.current);
            t.current = null;
          }
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
              imageMetadataOccurrences:
                imageMetadataOccurrencesStoreRef.current,
              metadataProgress: metadataProgressStoreRef.current,
              scanning: false,
              galleryIndex: null,
              selectedIndex: null,
              visibleColumns: prev.visibleColumns,
              columnWidths: prev.columnWidths,
              sortConfig: prev.sortConfig,
              metadataVersion: 0,
              workerErrors: targetLoadErrorRef.current
                ? [targetLoadErrorRef.current]
                : [],
              draftEdits: draftEditsStoreRef.current.getAllMetadata(),
              draftEditsStore: draftEditsStoreRef.current,
              targetDraftEdits:
                targetDraftEditsStoreRef.current.getAllMetadata(),
              targetDraftEditsStore: targetDraftEditsStoreRef.current,
              targetDraftPersistence: targetDraftPersistenceRef.current,
              targetApplying: targetApplyControllerRef.current?.getState() ?? {
                status: "idle",
              },
              applying: null,
              verifyOutcomes: {},
            };
          }
          return prev;
        });
      });

      const unlistenMetadata = await api.listen(
        "image_metadata_ready",
        (raw) => {
          if (cancelled) return;
          const { scan_id, results } = raw as ImageMetadataReadyPayload;
          if (scan_id !== activeScanIdRef.current) return;
          console.debug(`[metadata] received ${results.length} results`);

          metadataBufferRef.current.push(...results);
          scheduleBatchedFlush(
            metadataBufferRef.current.length,
            metadataBatchTimerRef,
            isFirstMetadataFlushRef,
            flushMetadataBatch,
            200,
          );
        },
      );

      const unlistenThumbnail = await api.listen("thumbnail_ready", (raw) => {
        if (cancelled) return;
        const { scan_id, results } = raw as ThumbnailReadyPayload;
        if (scan_id !== activeScanIdRef.current) return;
        console.debug(`[thumbnail] received ${results.length} results`);

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
        console.error(
          `Worker error (${payload.worker_type}):`,
          payload.error_message,
        );

        // Add error to the state so UI can display it (capped — see MAX_WORKER_ERRORS)
        setAppState((prev) => {
          if (prev.kind !== "loaded") return prev;
          const next = [...prev.workerErrors, payload];
          if (next.length > MAX_WORKER_ERRORS) {
            next.splice(0, next.length - MAX_WORKER_ERRORS);
          }
          return { ...prev, workerErrors: next };
        });
      });

      const unlistenApplyStarted = await api.listen(
        "apply_edits_started",
        (raw) => {
          if (cancelled) return;
          const payload = raw as ApplyEditsStartedPayload;
          if (
            !combinedApplyRef.current.active ||
            combinedApplyRef.current.phase !== "legacy-v4"
          ) {
            return;
          }
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
                phase: "legacy-v4",
              },
            };
          });
        },
      );

      const unlistenMetadataApplyProgress = await api.listen(
        "apply_metadata_edits_progress",
        (raw) => {
          if (cancelled) return;
          const payload = raw as ApplyEditsProgressPayload;
          handleApplyEditsProgress(
            payload,
            draftEditsStoreRef.current,
            imageMetadataStoreRef.current,
            imageMetadataOccurrencesStoreRef.current,
            setAppState,
          );
        },
      );

      unlisteners.push(
        unlistenFound,
        unlistenComplete,
        unlistenMetadata,
        unlistenThumbnail,
        unlistenError,
        unlistenWorkerError,
        unlistenApplyStarted,
        unlistenMetadataApplyProgress,
      );

      // All listeners registered — unblock any startScan that was awaiting.
      console.debug("[setup] all listeners registered");
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

  const openRecent = useCallback(
    async (folder: string) => {
      await startScan(folder);
    },
    [startScan],
  );

  const closeFolder = useCallback(() => {
    activeScanIdRef.current = -1;
    activeFolderRef.current = null;
    targetDraftPersistenceRef.current = TARGET_DRAFT_NOT_LOADED_STATE;
    void cancelActiveApplyAndWait().finally(() => {
      // A final authoritative event may race with the initial clear; repeat it
      // after cancellation settles so closed-folder state remains empty.
      targetDraftEditsStoreRef.current.resetMetadata({});
    });

    // Cancel any pending batch flushes — they would still safely no-op against
    // the idle state, but leaving timers running keeps closures alive past
    // the scan they belong to and adds noise on next render.
    for (const t of [
      batchTimerRef,
      metadataBatchTimerRef,
      thumbnailBatchTimerRef,
    ]) {
      if (t.current) {
        clearTimeout(t.current);
        t.current = null;
      }
    }

    // Drop any buffered events that haven't been flushed yet.
    photoBufferRef.current = [];
    metadataBufferRef.current = [];
    thumbnailBufferRef.current = [];
    targetDraftEditsStoreRef.current.resetMetadata({});
    imageMetadataStoreRef.current.clear();
    imageMetadataOccurrencesStoreRef.current.clear();

    setAppState({ kind: "idle" });
    api.invoke("stop_scan").catch(() => {});
    api.invoke("set_window_title", { title: "Media Library" }).catch(() => {});
  }, [api, cancelActiveApplyAndWait]);

  const prioritizeQueues = useCallback(
    (visiblePaths: string[]) => {
      console.debug(`[prioritizeQueues] ${visiblePaths.length} paths`);
      api.invoke("prioritize_queues", { visiblePaths }).catch(() => {});
    },
    [api],
  );

  const selectPhoto = useCallback((index: number | null) => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, selectedIndex: index } : prev,
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
      const next = store.getAllMetadata();
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        if (prev.draftEdits === next) return prev;
        return { ...prev, draftEdits: next };
      });
      const cur = stateRef.current;
      if (cur.kind === "loaded") {
        api
          .invoke("save_metadata_draft_edits", {
            folderPath: cur.folder,
            data: metadataDraftsToWire(store.getAllMetadata()),
          })
          .catch(console.error);
      }
    });
    return unsub;
  }, [api]);

  // One production subscription owns both the React snapshot and schema-v5
  // autosave. Controller-applied backend snapshots notify this same path while
  // the gate is suppressed, so they update UI without a duplicate save.
  useEffect(() => {
    const store = targetDraftEditsStoreRef.current;
    return store.subscribe(() => {
      const next = store.getAllMetadata();
      setAppState((prev) => {
        if (prev.kind !== "loaded" || prev.targetDraftEdits === next) {
          return prev;
        }
        return { ...prev, targetDraftEdits: next };
      });
      const folder = activeFolderRef.current;
      if (
        !folder ||
        targetDraftPersistenceRef.current.status !== "ready" ||
        targetDraftAutosaveGateRef.current.isSuppressed()
      ) {
        return;
      }
      void saveTargetDraftEditsV5(apiRef.current, folder, next).catch((error) =>
        pushApplicationError("metadata-v5-save", error),
      );
    });
  }, [pushApplicationError]);

  const showInExplorer = useCallback(
    async (index: number) => {
      const current = stateRef.current;
      if (current.kind !== "loaded") return;
      const photo = current.photos[index];
      if (!photo) return;

      api
        .invoke("show_in_explorer", {
          folder: current.folder,
          relativePath: photo.relative_path,
        })
        .catch(() => {});
    },
    [api],
  );

  const openGallery = useCallback((index: number) => {
    setAppState((prev) =>
      prev.kind === "loaded"
        ? { ...prev, galleryIndex: index, selectedIndex: index }
        : prev,
    );
  }, []);

  const closeGallery = useCallback(() => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, galleryIndex: null } : prev,
    );
  }, []);

  const navigateGallery = useCallback(
    (delta: number, options?: { listLength?: number }) => {
      setAppState((prev) => {
        if (prev.kind !== "loaded" || prev.galleryIndex === null) return prev;
        const len = options?.listLength ?? prev.photos.length;
        const nextIndex = Math.max(
          0,
          Math.min(len - 1, prev.galleryIndex + delta),
        );
        return { ...prev, galleryIndex: nextIndex, selectedIndex: nextIndex };
      });
    },
    [],
  );

  const setVisibleColumns = useCallback((columns: VisibleColumn[]) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({
        visibleColumns: columns,
        sortConfig: prev.sortConfig,
        columnWidths: prev.columnWidths,
      });
      return { ...prev, visibleColumns: columns };
    });
  }, []);

  const setSortConfig = useCallback((config: SortConfig) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({
        visibleColumns: prev.visibleColumns,
        sortConfig: config,
        columnWidths: prev.columnWidths,
      });
      return { ...prev, sortConfig: config };
    });
  }, []);

  const updateColumnWidth = useCallback((col: string, width: number) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const newWidths =
        width > 0
          ? { ...prev.columnWidths, [col]: width }
          : Object.fromEntries(
              Object.entries(prev.columnWidths).filter(([k]) => k !== col),
            );
      saveColumnConfig({
        visibleColumns: prev.visibleColumns,
        sortConfig: prev.sortConfig,
        columnWidths: newWidths,
      });
      return { ...prev, columnWidths: newWidths };
    });
  }, []);

  const resetColumnWidths = useCallback(() => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      saveColumnConfig({
        visibleColumns: prev.visibleColumns,
        sortConfig: prev.sortConfig,
        columnWidths: {},
      });
      return { ...prev, columnWidths: {} };
    });
  }, []);

  /**
   * Phase 8.1 — Accept a Coerced (or otherwise pending) verification outcome:
   * remove the entry from `verifyOutcomes` AND drop the corresponding draft so
   * the file's "saved" state matches what exiftool actually wrote.
   */
  const acceptVerifyOutcome = useCallback(
    (fileRelativePath: string, id: SchemaDefinitionId) => {
      draftEditsStoreRef.current.deleteTag(fileRelativePath, id);
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const next = removeVerifyOutcome(
          prev.verifyOutcomes,
          fileRelativePath,
          id,
        );
        return next === prev.verifyOutcomes
          ? prev
          : { ...prev, verifyOutcomes: next };
      });
    },
    [],
  );

  /**
   * Phase 8.1 — Revert a Coerced outcome: re-stage the draft with the value
   * exiftool actually wrote, so the user's next save attempt acts
   * on the file as it now is rather than on the original sent value.
   */
  const revertVerifyOutcome = useCallback(
    (
      fileRelativePath: string,
      id: SchemaDefinitionId,
      observed: MetadataValue | null,
    ) => {
      draftEditsStoreRef.current.setMetadataTag(fileRelativePath, id, {
        value: observed,
        intent: observed === null ? "Delete" : "Set",
      });
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const next = removeVerifyOutcome(
          prev.verifyOutcomes,
          fileRelativePath,
          id,
        );
        return next === prev.verifyOutcomes
          ? prev
          : { ...prev, verifyOutcomes: next };
      });
    },
    [],
  );

  /**
   * Dismiss one pending verify outcome without acting on it.  Draft is
   * untouched — used for Mismatch / MissingPostWrite / DeleteLingering rows
   * where the user has acknowledged the failure and will fix it manually.
   */
  const dismissVerifyOutcome = useCallback(
    (fileRelativePath: string, id: SchemaDefinitionId) => {
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const next = removeVerifyOutcome(
          prev.verifyOutcomes,
          fileRelativePath,
          id,
        );
        return next === prev.verifyOutcomes
          ? prev
          : { ...prev, verifyOutcomes: next };
      });
    },
    [],
  );

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

  const requireTargetDraftPersistenceReady = useCallback(
    (affectedFiles: string[] = []): boolean => {
      const persistence = targetDraftPersistenceRef.current;
      if (persistence.status === "ready") return true;
      pushApplicationError(
        "metadata-v5-unavailable",
        `${TARGET_DRAFT_LOAD_BLOCKED_MESSAGE} Load error: ${persistence.error}`,
        affectedFiles,
      );
      return false;
    },
    [pushApplicationError],
  );

  const setMetadataDraftBatch = useCallback(
    (
      fileRelativePath: string,
      edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
    ) => {
      // Temporary bridge: GPS and every batch-generated producer remain v4.
      draftEditsStoreRef.current.setMetadataBatch(fileRelativePath, edits);
    },
    [],
  );

  const setMetadataDraft = useCallback(
    (
      fileRelativePath: string,
      id: SchemaDefinitionId,
      edit: MetadataDraftEdit,
    ) => {
      // Temporary bridge: ordinary existing-row edits remain schema-v4.
      draftEditsStoreRef.current.setMetadataTag(fileRelativePath, id, edit);
    },
    [],
  );

  const setNewPropertyDraft = useCallback(
    (
      fileRelativePath: string,
      id: SchemaDefinitionId,
      edit: MetadataDraftEdit,
    ) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;
      const token = schemaDefinitionIdToken(id);
      if (
        draftEditsStoreRef.current.getMetadataFile(fileRelativePath)?.[token]
      ) {
        pushApplicationError(
          "metadata-v5-conflict",
          "This property already has a legacy draft. Apply or discard that draft before adding the property again.",
          [fileRelativePath],
        );
        return;
      }

      const ownership = resolveTargetDraftByExactSchema(
        targetDraftEditsStoreRef.current.getMetadataFile(fileRelativePath),
        id,
      );
      if (
        ownership.kind === "ambiguous" ||
        (ownership.kind === "unique" &&
          ownership.entry.target.kind === "ExistingOccurrence")
      ) {
        pushApplicationError(
          "metadata-v5-conflict",
          "This exact schema already has target-aware ownership. Apply or discard the owning target-aware draft before adding the property again.",
          [fileRelativePath],
        );
        return;
      }
      targetDraftEditsStoreRef.current.setMetadataTarget(
        fileRelativePath,
        { kind: "NewProperty", schema_id: structuredClone(id) },
        edit,
      );
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const setTargetPropertyDraft = useCallback(
    (
      fileRelativePath: string,
      target: MetadataDraftTarget,
      edit: MetadataDraftEdit,
    ) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;
      targetDraftEditsStoreRef.current.setMetadataTarget(
        fileRelativePath,
        target,
        edit,
      );
    },
    [requireTargetDraftPersistenceReady],
  );

  const discardTargetPropertyDraft = useCallback(
    (fileRelativePath: string, target: MetadataDraftTarget) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;
      targetDraftEditsStoreRef.current.deleteTarget(fileRelativePath, target);
    },
    [requireTargetDraftPersistenceReady],
  );

  const discardDraftValue = useCallback(
    (fileRelativePath: string, id: SchemaDefinitionId) => {
      draftEditsStoreRef.current.deleteTag(fileRelativePath, id);
    },
    [],
  );

  const discardDraftValues = useCallback(
    (fileRelativePath: string, ids: SchemaDefinitionId[]) => {
      draftEditsStoreRef.current.deleteTags(fileRelativePath, ids);
    },
    [],
  );

  const discardAllDraftEdits = useCallback(
    (fileRelativePath?: string | string[]) => {
      const paths =
        fileRelativePath === undefined
          ? []
          : Array.isArray(fileRelativePath)
            ? fileRelativePath
            : [fileRelativePath];
      if (fileRelativePath === undefined) {
        draftEditsStoreRef.current.clear();
        if (requireTargetDraftPersistenceReady()) {
          targetDraftEditsStoreRef.current.clear();
        }
      } else {
        draftEditsStoreRef.current.deletePaths(paths);
        if (requireTargetDraftPersistenceReady(paths)) {
          targetDraftEditsStoreRef.current.deletePaths(paths);
        }
      }
    },
    [requireTargetDraftPersistenceReady],
  );

  /**
   * Apply draft edits. The backend processes files one at a time, emitting
   * `apply_edits_started` once and `apply_metadata_edits_progress` after each
   * file. Those events drive incremental state updates (see setup()), so this
   * function does not need to apply any state changes from the final result.
   *
   * The promise resolves once all files are done (or cancellation took effect).
   * Callers can use the result for a final summary; state is already current.
   */
  const applyDraftEdits = useCallback(
    (
      fileRelativePath?: string | string[],
    ): Promise<MetadataApplyEditsResult> => {
      const run = async (): Promise<MetadataApplyEditsResult> => {
        const current = stateRef.current;
        if (current.kind !== "loaded") {
          return { applied: [], failed: [], fresh_metadata: {} };
        }
        if (combinedApplyRef.current.active) {
          throw new Error("A metadata apply operation is already running");
        }

        let requestedPaths: string[];
        if (fileRelativePath === undefined) {
          requestedPaths = [
            ...Object.keys(current.targetDraftEdits),
            ...Object.keys(current.draftEdits).filter(
              (path) => current.targetDraftEdits[path] === undefined,
            ),
          ];
        } else {
          requestedPaths = Array.isArray(fileRelativePath)
            ? fileRelativePath
            : [fileRelativePath];
        }
        requestedPaths = [...new Set(requestedPaths)];
        const targetPaths = requestedPaths.filter(
          (path) => current.targetDraftEdits[path] !== undefined,
        );
        const legacyPaths = requestedPaths.filter(
          (path) => current.draftEdits[path] !== undefined,
        );

        if (targetPaths.length === 0 && legacyPaths.length === 0) {
          return { applied: [], failed: [], fresh_metadata: {} };
        }

        const collision = findCrossSystemDraftCollision(
          requestedPaths,
          current.draftEdits,
          current.targetDraftEdits,
        );
        if (collision) {
          const error = new Error(
            `Cannot apply '${collision.path}': exact schema ${JSON.stringify(collision.id)} is owned by both v4 and v5 drafts`,
          );
          pushApplicationError("metadata-apply-conflict", error, [
            collision.path,
          ]);
          throw error;
        }

        combinedApplyRef.current = {
          active: true,
          phase: targetPaths.length > 0 ? "target-v5" : "legacy-v4",
        };
        const aggregate: MetadataApplyEditsResult = {
          applied: [],
          failed: [],
          fresh_metadata: {},
        };

        try {
          // Deterministic bridge ordering: exact target-aware v5 first, then the
          // remaining legacy v4 paths. The phases are never concurrent.
          if (targetPaths.length > 0) {
            if (!requireTargetDraftPersistenceReady(targetPaths)) {
              throw new Error(TARGET_DRAFT_LOAD_BLOCKED_MESSAGE);
            }
            const controller = targetApplyControllerRef.current;
            if (!controller) throw new Error("Schema-v5 apply is not ready");
            setAppState((prev) =>
              prev.kind === "loaded"
                ? {
                    ...prev,
                    applying: {
                      total: targetPaths.length,
                      current: 0,
                      currentFile: null,
                      failureCount: 0,
                      cancelling: false,
                      phase: "target-v5",
                    },
                  }
                : prev,
            );
            const targetResult = await controller.run(
              current.folder,
              targetPaths,
            );
            for (const file of targetResult.commandResult.files) {
              if (file.applied) aggregate.applied.push(file.relative_path);
              else {
                aggregate.failed.push({
                  relative_path: file.relative_path,
                  reason: file.error ?? "Schema-v5 apply failed",
                });
              }
            }
            if (
              targetResult.commandResult.cancelled ||
              targetResult.commandResult.aborted ||
              targetResult.protocolErrors.length > 0 ||
              targetResult.progressApplicationErrors.length > 0
            ) {
              return aggregate;
            }
          }

          if (legacyPaths.length > 0) {
            combinedApplyRef.current.phase = "legacy-v4";
            setAppState((prev) =>
              prev.kind === "loaded"
                ? {
                    ...prev,
                    applying: {
                      total: legacyPaths.length,
                      current: 0,
                      currentFile: null,
                      failureCount: 0,
                      cancelling: false,
                      phase: "legacy-v4",
                    },
                  }
                : prev,
            );
            const legacyResult = (await api.invoke(
              "apply_metadata_draft_edits_cmd",
              { folderPath: current.folder, relPaths: legacyPaths },
            )) as MetadataApplyEditsResult;
            aggregate.applied.push(...legacyResult.applied);
            aggregate.failed.push(...legacyResult.failed);
            Object.assign(
              aggregate.fresh_metadata,
              legacyResult.fresh_metadata,
            );
          }
          return aggregate;
        } catch (error) {
          pushApplicationError("metadata-apply", error, requestedPaths);
          throw error;
        } finally {
          combinedApplyRef.current = { active: false, phase: null };
          setAppState((prev) =>
            prev.kind === "loaded" ? { ...prev, applying: null } : prev,
          );
        }
      };
      const promise = run();
      activeApplyPromiseRef.current = promise;
      return promise;
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const cancelApplyEdits = useCallback(() => {
    if (combinedApplyRef.current.phase === "target-v5") {
      void targetApplyControllerRef.current
        ?.cancel()
        .catch((error) => pushApplicationError("metadata-v5-cancel", error));
    } else if (combinedApplyRef.current.phase === "legacy-v4") {
      void api
        .invoke("cancel_apply_edits")
        .catch((error) => pushApplicationError("metadata-v4-cancel", error));
    }
    setAppState((prev) => {
      if (prev.kind !== "loaded" || !prev.applying) return prev;
      return { ...prev, applying: { ...prev.applying, cancelling: true } };
    });
  }, [api, pushApplicationError]);

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
      setMetadataDraftBatch,
      setMetadataDraft,
      setNewPropertyDraft,
      setTargetPropertyDraft,
      discardTargetPropertyDraft,
      discardDraftValue,
      discardDraftValues,
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
      setMetadataDraftBatch,
      setMetadataDraft,
      setNewPropertyDraft,
      setTargetPropertyDraft,
      discardTargetPropertyDraft,
      discardDraftValue,
      discardDraftValues,
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

function findCrossSystemDraftCollision(
  paths: string[],
  legacy: import("./types").MetadataDraftEditsByFile,
  target: TargetDraftEditsByFile,
): { path: string; id: SchemaDefinitionId } | null {
  for (const path of paths) {
    const legacyDrafts = legacy[path];
    const targetDrafts = target[path];
    if (!legacyDrafts || !targetDrafts) continue;
    for (const entry of Object.values(targetDrafts)) {
      const id = entry.target.schema_id;
      if (legacyDrafts[schemaDefinitionIdToken(id)]) return { path, id };
    }
  }
  return null;
}

/**
 * Process one `apply_metadata_edits_progress` event: prune drafts per the
 * backend's per-tag verdict, merge interesting outcomes into the
 * verifyOutcomes map, accumulate any per-file error, and bump
 * metadataVersion if fresh metadata landed.
 *
 * Hoisted out of the setup() effect so the hook body stays focused on
 * orchestration and the per-event logic stays testable.
 */
function handleApplyEditsProgress(
  payload: ApplyEditsProgressPayload,
  draftStore: DraftEditsStore,
  imageMetadataStore: ImageMetadataStore,
  imageMetadataOccurrencesStore: ImageMetadataOccurrencesStore,
  setAppState: React.Dispatch<React.SetStateAction<AppState>>,
) {
  // Apply fresh canonical metadata incrementally so the UI reflects file/disk
  // state in real time and a crash mid-operation leaves coherent state.
  if (payload.fresh_metadata) {
    imageMetadataStore.set(
      payload.relative_path,
      normalizeMetadataFromTauri(payload.fresh_metadata),
    );
    // Schema-v4 cannot transport the complete occurrence collection. Once it
    // writes the file, any previously authoritative occurrences are stale.
    imageMetadataOccurrencesStore.invalidate(payload.relative_path);
  }

  // Phase 8.1: prune drafts per-tag based on the backend's verification
  // outcomes.  Match and DeleteOk are conclusively safe to drop; the
  // rest stay so the user can act on them via VerifyOutcomeDialog.
  //
  const fileOutcomes = payload.tag_outcomes;
  const tagsToPrune = fileOutcomes
    .filter((o) => o.kind === "Match" || o.kind === "DeleteOk")
    .map((o) => o.id);
  if (tagsToPrune.length > 0) {
    draftStore.pruneTags(payload.relative_path, tagsToPrune);
  }

  setAppState((prev) => {
    if (prev.kind !== "loaded") return prev;

    const newVerifyOutcomes = mergeVerifyOutcomes(
      prev.verifyOutcomes,
      payload.relative_path,
      fileOutcomes,
    );

    let newErrors = prev.workerErrors;
    if (payload.error) {
      newErrors = [
        ...newErrors,
        {
          scan_id: -1,
          worker_type: "apply",
          error_message: payload.error,
          affected_files: [payload.relative_path],
        },
      ];
    }
    if (payload.warning) {
      newErrors = [
        ...newErrors,
        {
          scan_id: -1,
          worker_type: "apply-warning",
          error_message: payload.warning,
          affected_files: [payload.relative_path],
        },
      ];
    }
    if (newErrors.length > MAX_WORKER_ERRORS) {
      newErrors = newErrors.slice(newErrors.length - MAX_WORKER_ERRORS);
    }

    const applying = prev.applying
      ? {
          ...prev.applying,
          current: payload.current,
          currentFile: payload.relative_path,
          failureCount: prev.applying.failureCount + (payload.error ? 1 : 0),
        }
      : null;

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
}
