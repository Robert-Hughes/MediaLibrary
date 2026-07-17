import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThumbnailStore,
  ImageMetadataOccurrencesStore,
  MetadataProgressStore,
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
  MetadataApplyEditsResultV5,
  MetadataDraftEdit,
  MetadataDraftEntry,
  MetadataOccurrenceId,
  SchemaDefinitionId,
  ImageMetadata,
  TargetDraftPersistenceStateV5,
  MetadataDraftEntryV5,
  TagInfo,
} from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";
import {
  MAX_WORKER_ERRORS,
  normalizeMetadataOccurrencesFromTauri,
  scheduleBatchedFlush,
} from "./utils/scanEvents";
import { useRecentFolders } from "./hooks/useRecentFolders";
import { TargetDraftEditsStore } from "./targetDraftEdits";
import { TargetDraftAutosaveGateV5 } from "./targetDraftAutosaveGate";
import { TargetApplyControllerV5 } from "./targetApplyController";
import {
  loadTargetDraftEditsV5,
  saveTargetDraftEditsV5,
} from "./targetDraftTauri";
import type { MetadataDraftTarget } from "./types";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./utils/schemaDefinitionId";
import { TargetVerifyOutcomesStoreV5 } from "./targetVerifyOutcomesStore";
import {
  currentValueForMetadataDraftTarget,
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
  newPropertyDraftTarget,
} from "./utils/metadataDraftTarget";
import { validateFamily1Group } from "./utils/metadataWriteTarget";
import { tagInfoSupportsMetadataWrite } from "./utils/metadataWriteSupport";
import { resolveExactMetadataOccurrence } from "./utils/metadataOccurrences";
import { planGpsTargetDraftBatchV5 } from "./gpsTargetDrafts";
import { planMetadataRemovalTargetsV5 } from "./metadataRemovalTargets";
import {
  planGeneratedTargetDraftBatchV5,
  type GeneratedDraftStageResultV5,
  type GeneratedMetadataProducerV5,
} from "./generatedTargetDrafts";

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
  canStageGeneratedMetadataV5: (relativePaths: string[]) => boolean;
  applyGeneratedMetadataDraftBatchV5: (
    relativePath: string,
    producer: GeneratedMetadataProducerV5,
    edits: MetadataDraftEntry[],
  ) => GeneratedDraftStageResultV5;
  removeMetadataFieldsV5: (
    relativePath: string,
    schemaIds: SchemaDefinitionId[],
  ) => boolean;
  removeMetadataFieldFromFilesV5: (
    schemaId: SchemaDefinitionId,
    relativePaths: string[],
  ) => boolean;
  setGpsTargetDraftBatch: (
    relativePath: string,
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) => boolean;
  setExistingOccurrenceDraft: (
    fileRelativePath: string,
    occurrenceId: MetadataOccurrenceId,
    edit: MetadataDraftEdit,
  ) => void;
  setNewPropertyDraft: (
    fileRelativePath: string,
    target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    edit: MetadataDraftEdit,
  ) => Promise<void>;
  discardTargetPropertyDraft: (
    fileRelativePath: string,
    target: MetadataDraftTarget,
  ) => void;
  discardTargetDraftValues: (
    fileRelativePath: string,
    targets: MetadataDraftTarget[],
  ) => boolean;
  discardAllDraftEdits: (fileRelativePath?: string | string[]) => void;
  applyDraftEdits: (
    fileRelativePath?: string | string[],
  ) => Promise<MetadataApplyEditsResultV5>;
  cancelApplyEdits: () => void;
  acceptTargetVerifyOutcome: (
    relativePath: string,
    currentTarget: MetadataDraftTarget,
  ) => void;
  keepTargetDraftAndDismissOutcome: (
    relativePath: string,
    currentTarget: MetadataDraftTarget,
  ) => void;
  discardTargetDraftAndOutcome: (
    relativePath: string,
    currentTarget: MetadataDraftTarget,
  ) => void;
  dismissAllTargetVerifyOutcomes: () => void;
}

export function useMediaLibrary(
  api: TauriApi,
): [AppState & { recentFolders: string[] }, MediaLibraryActions] {
  const [appState, setAppState] = useState<AppState>({ kind: "idle" });
  const [recentFolders, pushRecentFolder] = useRecentFolders();

  const thumbnailStoreRef = useRef<ThumbnailStore>(new ThumbnailStore());
  const imageMetadataOccurrencesStoreRef =
    useRef<ImageMetadataOccurrencesStore>(new ImageMetadataOccurrencesStore());
  const metadataProgressStoreRef = useRef<MetadataProgressStore>(
    new MetadataProgressStore(),
  );
  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);
  // Monotonic frontend lifecycle identity. Unlike scan_id, this also changes
  // immediately when replacing or closing a scan and cannot collide when the
  // same folder is reopened within one clock tick.
  const scanLifecycleGenerationRef = useRef(0);
  const targetDraftEditsStoreRef = useRef<TargetDraftEditsStore>(
    new TargetDraftEditsStore(),
  );
  const targetVerifyOutcomesStoreRef = useRef<TargetVerifyOutcomesStoreV5>(
    new TargetVerifyOutcomesStoreV5(),
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
  const applyActiveRef = useRef(false);
  const activeApplyPromiseRef =
    useRef<Promise<MetadataApplyEditsResultV5> | null>(null);

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

  useEffect(() => {
    targetDraftEditsStoreRef.current.setCurrentValueResolver((path, target) =>
      currentValueForMetadataDraftTarget(
        imageMetadataOccurrencesStoreRef.current.get(path),
        target,
      ),
    );
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
            verification: targetVerifyOutcomesStoreRef.current,
          },
          autosaveGate: targetDraftAutosaveGateRef.current,
        },
        {
          onProgress: (_payload, application) => {
            if (!application.occurrencesChanged) return;
            setAppState((prev) =>
              prev.kind === "loaded"
                ? { ...prev, metadataVersion: prev.metadataVersion + 1 }
                : prev,
            );
          },
          onFinalApplied: (_result, application) => {
            if (!application.files.some((file) => file.occurrencesChanged)) {
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
          onFileError: (relativePath, error) =>
            pushApplicationError("metadata-v5-file", error, [relativePath]),
          onFileWarning: (relativePath, warning) =>
            pushApplicationError("metadata-v5-warning", warning, [
              relativePath,
            ]),
        },
      );
      targetApplyControllerRef.current = controller;
    }
    const unsubscribe = controller.subscribe((targetApplying) => {
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        let applying = prev.applying;
        if (applyActiveRef.current && targetApplying.status === "running") {
          applying = {
            total: targetApplying.total ?? 0,
            current: targetApplying.current,
            currentFile: targetApplying.currentFile,
            failureCount:
              targetApplying.protocolErrorCount +
              targetApplying.progressApplicationErrorCount +
              targetApplying.fileFailureCount,
            cancelling: targetApplying.cancelling,
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
    if (!applyActiveRef.current) return;
    await targetApplyControllerRef.current?.cancel().catch(() => {});
    await activeApplyPromiseRef.current?.catch(() => {});
  }, []);

  const startScan = useCallback(
    async (folder: string) => {
      // Invalidate work from the previous folder/scan before any asynchronous
      // shutdown or setup step can yield.
      scanLifecycleGenerationRef.current += 1;
      // Wait for event listeners to be registered before starting the scan so
      // photo_found / scan_complete events are never missed.  The latch is a
      // plain Promise (no setTimeout) so it works correctly with vi.useFakeTimers().
      await listenersReadyRef.current;

      // Finish cancellation before
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
      imageMetadataOccurrencesStoreRef.current.clear();
      metadataProgressStoreRef.current = new MetadataProgressStore();
      activeFolderRef.current = folder;
      targetLoadErrorRef.current = null;
      targetDraftPersistenceRef.current = TARGET_DRAFT_NOT_LOADED_STATE;
      targetVerifyOutcomesStoreRef.current.clear();
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
            targetDraftEdits: targetDraftEditsStoreRef.current.getAllMetadata(),
            targetDraftEditsStore: targetDraftEditsStoreRef.current,
            targetDraftPersistence: targetDraftPersistenceRef.current,
            targetApplying: targetApplyControllerRef.current?.getState() ?? {
              status: "idle",
            },
            applying: null,
            targetVerifyOutcomes: targetVerifyOutcomesStoreRef.current.getAll(),
            targetVerifyOutcomesStore: targetVerifyOutcomesStoreRef.current,
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

    // Flush authoritative occurrences.
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
              targetDraftEdits:
                targetDraftEditsStoreRef.current.getAllMetadata(),
              targetDraftEditsStore: targetDraftEditsStoreRef.current,
              targetDraftPersistence: targetDraftPersistenceRef.current,
              targetApplying: targetApplyControllerRef.current?.getState() ?? {
                status: "idle",
              },
              applying: null,
              targetVerifyOutcomes:
                targetVerifyOutcomesStoreRef.current.getAll(),
              targetVerifyOutcomesStore: targetVerifyOutcomesStoreRef.current,
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

      unlisteners.push(
        unlistenFound,
        unlistenComplete,
        unlistenMetadata,
        unlistenThumbnail,
        unlistenError,
        unlistenWorkerError,
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
    scanLifecycleGenerationRef.current += 1;
    activeScanIdRef.current = -1;
    activeFolderRef.current = null;
    targetDraftPersistenceRef.current = TARGET_DRAFT_NOT_LOADED_STATE;
    targetVerifyOutcomesStoreRef.current.clear();
    void cancelActiveApplyAndWait().finally(() => {
      // A final authoritative event may race with the initial clear; repeat it
      // after cancellation settles so closed-folder state remains empty.
      targetDraftEditsStoreRef.current.resetMetadata({});
      targetVerifyOutcomesStoreRef.current.clear();
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
    targetVerifyOutcomesStoreRef.current.clear();
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

  // One production subscription owns both the React snapshot and schema-v5
  // autosave. Controller-applied backend snapshots notify this same path while
  // the gate is suppressed, so they update UI without a duplicate save.
  useEffect(() => {
    const store = targetDraftEditsStoreRef.current;
    return store.subscribe(() => {
      const next = store.getAllMetadata();
      targetVerifyOutcomesStoreRef.current.pruneAgainstDrafts(next);
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

  useEffect(() => {
    const store = targetVerifyOutcomesStoreRef.current;
    return store.subscribe((next) => {
      setAppState((prev) => {
        if (prev.kind !== "loaded" || prev.targetVerifyOutcomes === next) {
          return prev;
        }
        return { ...prev, targetVerifyOutcomes: next };
      });
    });
  }, []);

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

  const targetOutcomeExists = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget): boolean => {
      const file = targetVerifyOutcomesStoreRef.current.getFile(relativePath);
      const slot = metadataDraftTargetSlotToken(currentTarget);
      const outcome = file?.[slot];
      return (
        outcome !== undefined &&
        metadataDraftTargetEquals(outcome.currentTarget, currentTarget)
      );
    },
    [],
  );

  const removeTargetDraftAndOutcome = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget) => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return;
      if (!targetOutcomeExists(relativePath, currentTarget)) return;
      const slot = metadataDraftTargetSlotToken(currentTarget);
      const persisted =
        targetDraftEditsStoreRef.current.getMetadataFile(relativePath)?.[slot];
      if (
        persisted === undefined ||
        !metadataDraftTargetEquals(persisted.target, currentTarget)
      ) {
        return;
      }
      targetDraftEditsStoreRef.current.deleteTarget(
        relativePath,
        currentTarget,
      );
      targetVerifyOutcomesStoreRef.current.deleteOutcome(
        relativePath,
        currentTarget,
      );
    },
    [requireTargetDraftPersistenceReady, targetOutcomeExists],
  );

  const acceptTargetVerifyOutcome = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget) => {
      removeTargetDraftAndOutcome(relativePath, currentTarget);
    },
    [removeTargetDraftAndOutcome],
  );

  const keepTargetDraftAndDismissOutcome = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget) => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return;
      targetVerifyOutcomesStoreRef.current.deleteOutcome(
        relativePath,
        currentTarget,
      );
    },
    [requireTargetDraftPersistenceReady],
  );

  const discardTargetDraftAndOutcome = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget) => {
      removeTargetDraftAndOutcome(relativePath, currentTarget);
    },
    [removeTargetDraftAndOutcome],
  );

  const dismissAllTargetVerifyOutcomes = useCallback(() => {
    targetVerifyOutcomesStoreRef.current.clear();
  }, []);

  const dismissError = useCallback((index: number) => {
    setAppState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const newErrors = [...prev.workerErrors];
      newErrors.splice(index, 1);
      return { ...prev, workerErrors: newErrors };
    });
  }, []);

  const canStageGeneratedMetadataV5 = useCallback(
    (relativePaths: string[]): boolean => {
      const paths = [...new Set(relativePaths)];
      if (!requireTargetDraftPersistenceReady(paths)) return false;
      const unavailable = paths.find(
        (relativePath) =>
          imageMetadataOccurrencesStoreRef.current.get(relativePath) ===
          "loading",
      );
      if (unavailable !== undefined) {
        pushApplicationError(
          "metadata-v5-generated-readiness",
          `Authoritative metadata occurrences are still loading for '${unavailable}'. Generated metadata was not started.`,
          [unavailable],
        );
        return false;
      }
      return true;
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const applyGeneratedMetadataDraftBatchV5 = useCallback(
    (
      relativePath: string,
      producer: GeneratedMetadataProducerV5,
      edits: MetadataDraftEntry[],
    ): GeneratedDraftStageResultV5 => {
      if (edits.length === 0) {
        return { kind: "success", changed: false };
      }

      if (!requireTargetDraftPersistenceReady([relativePath])) {
        const persistence = targetDraftPersistenceRef.current;
        return {
          kind: "failure",
          reason:
            persistence.status === "load-failed"
              ? `${TARGET_DRAFT_LOAD_BLOCKED_MESSAGE} Load error: ${persistence.error}`
              : TARGET_DRAFT_LOAD_BLOCKED_MESSAGE,
        };
      }

      try {
        const plan = planGeneratedTargetDraftBatchV5({
          producer,
          edits,
          occurrences:
            imageMetadataOccurrencesStoreRef.current.get(relativePath),
          targetDrafts:
            targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
        });
        const changed =
          targetDraftEditsStoreRef.current.applyExactMutationBatch([
            {
              path: relativePath,
              upserts: plan.upserts,
              deletes: plan.deletes,
            },
          ]);
        return { kind: "success", changed };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        pushApplicationError("metadata-v5-generated-stage", reason, [
          relativePath,
        ]);
        return { kind: "failure", reason };
      }
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const setGpsTargetDraftBatch = useCallback(
    (
      relativePath: string,
      edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
    ): boolean => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const planned = planGpsTargetDraftBatchV5(
          edits,
          imageMetadataOccurrencesStoreRef.current.get(relativePath),
          targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
        );
        targetDraftEditsStoreRef.current.setMetadataBatch(
          relativePath,
          planned.map(({ target, edit }) => ({ target, edit })),
        );
        return true;
      } catch (error) {
        pushApplicationError("metadata-v5-gps-plan", error, [relativePath]);
        return false;
      }
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const removalMutation = useCallback(
    (relativePath: string, schemaIds: readonly SchemaDefinitionId[]) => {
      const uniqueIds = Array.from(
        new Map(
          schemaIds.map((id) => [
            schemaDefinitionIdToken(id),
            structuredClone(id),
          ]),
        ).values(),
      );
      const plan = planMetadataRemovalTargetsV5({
        schemaIds: uniqueIds,
        occurrences: imageMetadataOccurrencesStoreRef.current.get(relativePath),
        targetDrafts:
          targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
      });
      const upserts: MetadataDraftEntryV5[] = plan.upserts.map(
        ({ target, edit }) => ({
          target: structuredClone(target),
          edit: structuredClone(edit),
        }),
      );
      return {
        path: relativePath,
        upserts,
        deletes: plan.deletes.map((target) => structuredClone(target)),
      };
    },
    [],
  );

  const removeMetadataFieldsV5 = useCallback(
    (relativePath: string, schemaIds: SchemaDefinitionId[]): boolean => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const mutation = removalMutation(relativePath, schemaIds);
        targetDraftEditsStoreRef.current.applyExactMutationBatch([mutation]);
        return true;
      } catch (error) {
        pushApplicationError("metadata-v5-remove", error, [relativePath]);
        return false;
      }
    },
    [pushApplicationError, removalMutation, requireTargetDraftPersistenceReady],
  );

  const removeMetadataFieldFromFilesV5 = useCallback(
    (schemaId: SchemaDefinitionId, relativePaths: string[]): boolean => {
      const paths = [...new Set(relativePaths)];
      if (!requireTargetDraftPersistenceReady(paths)) return false;
      try {
        const mutations = paths.map((path) => {
          try {
            return removalMutation(path, [schemaId]);
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            const contextualError = new Error(
              `Cannot remove metadata from '${path}': ${reason}`,
            );
            (contextualError as Error & { cause: unknown }).cause = error;
            throw contextualError;
          }
        });
        targetDraftEditsStoreRef.current.applyExactMutationBatch(mutations);
        return true;
      } catch (error) {
        pushApplicationError("metadata-v5-remove-files", error, paths);
        return false;
      }
    },
    [pushApplicationError, removalMutation, requireTargetDraftPersistenceReady],
  );

  const setExistingOccurrenceDraft = useCallback(
    (
      fileRelativePath: string,
      occurrenceId: MetadataOccurrenceId,
      edit: MetadataDraftEdit,
    ) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;

      const occurrenceState =
        imageMetadataOccurrencesStoreRef.current.get(fileRelativePath);
      if (occurrenceState === "loading") {
        pushApplicationError(
          "metadata-v5-occurrence-unavailable",
          "Authoritative metadata occurrences are still loading. Wait for the file to be scanned before editing this row.",
          [fileRelativePath],
        );
        return;
      }

      const exact = resolveExactMetadataOccurrence(
        occurrenceState,
        occurrenceId,
      );
      if (exact.kind !== "unique") {
        pushApplicationError(
          "metadata-v5-occurrence-unavailable",
          exact.kind === "duplicate"
            ? "The exact metadata occurrence ID is duplicated, so no occurrence was selected."
            : "The exact metadata occurrence no longer exists, so no draft was created.",
          [fileRelativePath],
        );
        return;
      }

      const targetResolution = existingOccurrenceTargetFromOccurrence(
        exact.occurrence,
      );
      if (targetResolution.kind === "read-only") {
        pushApplicationError(
          "metadata-v5-occurrence-read-only",
          targetResolution.reason,
          [fileRelativePath],
        );
        return;
      }
      const target = targetResolution.target;
      targetDraftEditsStoreRef.current.setMetadataTarget(
        fileRelativePath,
        target,
        edit,
      );
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const setNewPropertyDraft = useCallback(
    async (
      fileRelativePath: string,
      target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
      edit: MetadataDraftEdit,
    ) => {
      const id = target.schema_id;
      const openedFolder = activeFolderRef.current;
      const openedLifecycleGeneration = scanLifecycleGenerationRef.current;
      const lifecycleIsCurrent = () =>
        activeFolderRef.current === openedFolder &&
        scanLifecycleGenerationRef.current === openedLifecycleGeneration;

      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;

      const validateAuthoritativeStateAndOwnership = (): boolean => {
        const occurrenceState =
          imageMetadataOccurrencesStoreRef.current.get(fileRelativePath);
        if (occurrenceState === "loading") {
          pushApplicationError(
            "metadata-v5-new-property-occurrences-loading",
            "Authoritative metadata occurrences are still loading. No new-property draft was staged.",
            [fileRelativePath],
          );
          return false;
        }
        const occupied = occurrenceState.find((occurrence) => {
          const observed = occurrence.write_target;
          if (observed !== null) {
            return (
              observed.group1.toLowerCase() ===
                target.write_target.group1.toLowerCase() &&
              observed.group7.toLowerCase() ===
                target.write_target.group7.toLowerCase() &&
              observed.tag_name.toLowerCase() ===
                target.write_target.tag_name.toLowerCase()
            );
          }
          return schemaDefinitionIdEquals(occurrence.schema_id, id);
        });
        if (occupied) {
          pushApplicationError(
            "metadata-v5-new-property-already-exists",
            "The intended destination is already occupied, or a same-schema occurrence has no proven selector. No new-property draft was staged.",
            [fileRelativePath],
          );
          return false;
        }

        const pendingCollision = Object.values(
          targetDraftEditsStoreRef.current.getMetadataFile(fileRelativePath) ??
            {},
        ).find((entry) => {
          if (metadataDraftTargetEquals(entry.target, target)) return false;
          const pending = entry.target.write_target;
          return (
            pending.group1.toLowerCase() ===
              target.write_target.group1.toLowerCase() &&
            pending.group7.toLowerCase() ===
              target.write_target.group7.toLowerCase() &&
            pending.tag_name.toLowerCase() ===
              target.write_target.tag_name.toLowerCase()
          );
        });
        if (pendingCollision) {
          pushApplicationError(
            "metadata-v5-new-property-selector-collision",
            "Another pending draft already uses the intended complete selector. No new-property draft was staged.",
            [fileRelativePath],
          );
          return false;
        }

        return true;
      };

      if (!validateAuthoritativeStateAndOwnership()) return;

      let info: TagInfo | null;
      try {
        info = (await apiRef.current.invoke("get_tag_info", {
          id,
        })) as TagInfo | null;
      } catch (error) {
        if (!lifecycleIsCurrent()) return;
        const detail = error instanceof Error ? error.message : String(error);
        pushApplicationError(
          "metadata-v5-new-property-schema-lookup",
          `The exact schema definition could not be resolved: ${detail}. No new-property draft was staged.`,
          [fileRelativePath],
        );
        return;
      }

      if (!lifecycleIsCurrent()) return;

      // The async schema lookup may race with mutable same-scan eligibility.
      // Recheck every independent condition immediately before staging.
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;
      if (!validateAuthoritativeStateAndOwnership()) return;

      if (!info || !schemaDefinitionIdEquals(info.id, id)) {
        pushApplicationError(
          "metadata-v5-new-property-schema-missing",
          "The exact schema definition could not be resolved. No new-property draft was staged.",
          [fileRelativePath],
        );
        return;
      }
      if (!info.writable) {
        pushApplicationError(
          "metadata-v5-new-property-read-only",
          "This exact schema is read-only. No new-property draft was staged.",
          [fileRelativePath],
        );
        return;
      }
      if (!tagInfoSupportsMetadataWrite(info)) {
        pushApplicationError(
          "metadata-v5-new-property-unsupported-kind",
          "Binary and Unknown schema kinds are not supported by the metadata write pipeline. No new-property draft was staged.",
          [fileRelativePath],
        );
        return;
      }

      const targetResolution = newPropertyDraftTarget(info);
      if (targetResolution.kind !== "available") {
        pushApplicationError(
          "metadata-v5-new-property-ineligible",
          "This exact schema is not eligible for a NewProperty target. No draft was staged.",
          [fileRelativePath],
        );
        return;
      }
      if (
        target.write_target.group7 !==
          targetResolution.target.write_target.group7 ||
        target.write_target.tag_name !==
          targetResolution.target.write_target.tag_name
      ) {
        pushApplicationError(
          "metadata-v5-new-property-target-tampered",
          "The schema-controlled family-7 group or tag name changed. No draft was staged.",
          [fileRelativePath],
        );
        return;
      }
      const family1Error = validateFamily1Group(target.write_target.group1);
      if (family1Error) {
        pushApplicationError(
          "metadata-v5-new-property-invalid-destination",
          `${family1Error} No draft was staged.`,
          [fileRelativePath],
        );
        return;
      }
      targetDraftEditsStoreRef.current.setMetadataTarget(
        fileRelativePath,
        structuredClone(target),
        edit,
      );
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const discardTargetPropertyDraft = useCallback(
    (fileRelativePath: string, target: MetadataDraftTarget) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;
      const slot = metadataDraftTargetSlotToken(target);
      const persisted =
        targetDraftEditsStoreRef.current.getMetadataFile(fileRelativePath)?.[
          slot
        ];
      if (
        persisted === undefined ||
        !metadataDraftTargetEquals(persisted.target, target)
      ) {
        return;
      }
      targetDraftEditsStoreRef.current.deleteTarget(fileRelativePath, target);
    },
    [requireTargetDraftPersistenceReady],
  );

  const discardTargetDraftValues = useCallback(
    (fileRelativePath: string, targets: MetadataDraftTarget[]): boolean => {
      if (targets.length === 0) return true;
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return false;
      try {
        targetDraftEditsStoreRef.current.applyExactMutationBatch([
          {
            path: fileRelativePath,
            upserts: [],
            deletes: targets,
          },
        ]);
        return true;
      } catch (error) {
        pushApplicationError("metadata-v5-discard-targets", error, [
          fileRelativePath,
        ]);
        return false;
      }
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
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
        if (requireTargetDraftPersistenceReady()) {
          targetDraftEditsStoreRef.current.clear();
        }
      } else {
        if (requireTargetDraftPersistenceReady(paths)) {
          targetDraftEditsStoreRef.current.deletePaths(paths);
        }
      }
    },
    [requireTargetDraftPersistenceReady],
  );

  const applyDraftEdits = useCallback(
    (
      fileRelativePath?: string | string[],
    ): Promise<MetadataApplyEditsResultV5> => {
      const run = async (): Promise<MetadataApplyEditsResultV5> => {
        const current = stateRef.current;
        if (current.kind !== "loaded") {
          return {
            files: [],
            cancelled: false,
            aborted: false,
            abort_reason: null,
          };
        }
        if (applyActiveRef.current) {
          throw new Error("A metadata apply operation is already running");
        }

        const requestedPaths = [
          ...new Set(
            fileRelativePath === undefined
              ? Object.keys(current.targetDraftEdits)
              : Array.isArray(fileRelativePath)
                ? fileRelativePath
                : [fileRelativePath],
          ),
        ];
        if (!requireTargetDraftPersistenceReady(requestedPaths)) {
          throw new Error(TARGET_DRAFT_LOAD_BLOCKED_MESSAGE);
        }
        const targetPaths = requestedPaths.filter(
          (path) => current.targetDraftEdits[path] !== undefined,
        );
        if (targetPaths.length === 0) {
          return {
            files: [],
            cancelled: false,
            aborted: false,
            abort_reason: null,
          };
        }

        const controller = targetApplyControllerRef.current;
        if (!controller) throw new Error("Target-aware apply is not ready");
        applyActiveRef.current = true;

        try {
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
                  },
                }
              : prev,
          );
          const result = await controller.run(current.folder, targetPaths);
          return result.commandResult;
        } catch (error) {
          pushApplicationError("metadata-apply", error, requestedPaths);
          throw error;
        } finally {
          applyActiveRef.current = false;
          setAppState((prev) =>
            prev.kind === "loaded" ? { ...prev, applying: null } : prev,
          );
        }
      };
      const promise = run();
      activeApplyPromiseRef.current = promise;
      return promise;
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const cancelApplyEdits = useCallback(() => {
    void targetApplyControllerRef.current
      ?.cancel()
      .catch((error) => pushApplicationError("metadata-v5-cancel", error));
    setAppState((prev) => {
      if (prev.kind !== "loaded" || !prev.applying) return prev;
      return { ...prev, applying: { ...prev.applying, cancelling: true } };
    });
  }, [pushApplicationError]);

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
      canStageGeneratedMetadataV5,
      applyGeneratedMetadataDraftBatchV5,
      removeMetadataFieldsV5,
      removeMetadataFieldFromFilesV5,
      setGpsTargetDraftBatch,
      setExistingOccurrenceDraft,
      setNewPropertyDraft,
      discardTargetPropertyDraft,
      discardTargetDraftValues,
      discardAllDraftEdits,
      applyDraftEdits,
      cancelApplyEdits,
      acceptTargetVerifyOutcome,
      keepTargetDraftAndDismissOutcome,
      discardTargetDraftAndOutcome,
      dismissAllTargetVerifyOutcomes,
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
      canStageGeneratedMetadataV5,
      applyGeneratedMetadataDraftBatchV5,
      removeMetadataFieldsV5,
      removeMetadataFieldFromFilesV5,
      setGpsTargetDraftBatch,
      setExistingOccurrenceDraft,
      setNewPropertyDraft,
      discardTargetPropertyDraft,
      discardTargetDraftValues,
      discardAllDraftEdits,
      applyDraftEdits,
      cancelApplyEdits,
      acceptTargetVerifyOutcome,
      keepTargetDraftAndDismissOutcome,
      discardTargetDraftAndOutcome,
      dismissAllTargetVerifyOutcomes,
    ],
  );

  return [{ ...appState, recentFolders }, mediaLibraryActions];
}
