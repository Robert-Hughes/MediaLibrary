import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThumbnailStore,
  ImageMetadataStore,
  MetadataProgressStore,
  DraftEditsStore,
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
  ImageMetadataEntry,
  MetadataDraftEdit,
  MetadataValue,
} from "./types";
import type { DraftEdit } from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";
import {
  MAX_WORKER_ERRORS,
  normalizeMetadataFromTauri,
  scheduleBatchedFlush,
} from "./utils/scanEvents";
import {
  mergeVerifyOutcomes,
  removeVerifyOutcome,
} from "./utils/verifyOutcomes";
import {
  legacyDraftsToMetadataDrafts,
  metadataDraftToLegacyDraft,
  metadataDraftsToLegacyDrafts,
  metadataEntryToVariant,
  type MetadataDraftEditsByFile,
} from "./utils/semanticDrafts";
import { useRecentFolders } from "./hooks/useRecentFolders";

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
  setDraftTyped: (
    fileRelativePath: string,
    propertyKey: string,
    edit: DraftEdit,
  ) => void;
  setDraftBatch: (
    fileRelativePath: string,
    edits: Array<{ key: string; edit: DraftEdit }>,
  ) => void;
  setMetadataDraftBatch: (
    fileRelativePath: string,
    edits: Array<{ key: string; edit: MetadataDraftEdit }>,
  ) => void;
  discardDraftValue: (fileRelativePath: string, propertyKey: string) => void;
  discardAllDraftEdits: (fileRelativePath?: string | string[]) => void;
  applyDraftEdits: (
    fileRelativePath?: string | string[],
  ) => Promise<MetadataApplyEditsResult>;
  cancelApplyEdits: () => void;
  /** Phase 8.1: clear a Coerced/Mismatch outcome and drop its draft. */
  acceptVerifyOutcome: (fileRelativePath: string, tag: string) => void;
  /** Phase 8.1: re-stage the draft with the value exiftool actually wrote. */
  revertVerifyOutcome: (
    fileRelativePath: string,
    tag: string,
    observedRaw: MetadataValue | null,
  ) => void;
  /** Phase 8.1: dismiss a single pending verify outcome without touching the draft. */
  dismissVerifyOutcome: (fileRelativePath: string, tag: string) => void;
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
  const metadataProgressStoreRef = useRef<MetadataProgressStore>(
    new MetadataProgressStore(),
  );
  const draftEditsStoreRef = useRef<DraftEditsStore>(new DraftEditsStore());

  // Redundant-draft guard: let DraftEditsStore peek at current
  // metadata so writes that match the existing value drop silently
  // (and clear any stale draft for the same tag). One-time wiring;
  // the store keeps the function as a permanent reference. We re-read
  // `imageMetadataStoreRef.current` on every call so re-scans that
  // swap the metadata store don't leave the resolver pointing at the
  // old instance.
  useEffect(() => {
    draftEditsStoreRef.current.setCurrentValueResolver((path, tag) => {
      const meta = imageMetadataStoreRef.current.get(path);
      if (meta === "loading") return undefined;
      return meta[tag];
    });
  }, []);

  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);

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

  const metadataBufferRef = useRef<
    { relative_path: string; metadata: Record<string, ImageMetadataEntry> }[]
  >([]);
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

  const startScan = useCallback(
    async (folder: string) => {
      // Wait for event listeners to be registered before starting the scan so
      // photo_found / scan_complete events are never missed.  The latch is a
      // plain Promise (no setTimeout) so it works correctly with vi.useFakeTimers().
      await listenersReadyRef.current;

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
      imageMetadataStoreRef.current = new ImageMetadataStore();
      metadataProgressStoreRef.current = new MetadataProgressStore();

      try {
        const raw = await api.invoke("load_metadata_draft_edits", {
          folderPath: folder,
        });
        draftEditsStoreRef.current.reset(
          metadataDraftsToLegacyDrafts(raw as MetadataDraftEditsByFile),
        );
      } catch (e) {
        console.error("Failed to load draft edits", e);
        draftEditsStoreRef.current.reset({});
      }

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

      await api.invoke("start_scan", { scanId, folderPath: folder });
      pushRecentFolder(folder);
    },
    [api, pushRecentFolder],
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
          if (batch.length === 0) return prev;
          const newPhotos = [...prev.photos, ...batch];
          metadataProgressStoreRef.current.setTotal(newPhotos.length);
          return { ...prev, photos: newPhotos };
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
      console.debug(`[metadata] flushing ${batch.length} results`);

      for (const res of batch) {
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
          prev.sortConfig.primary.columnType !== "image"
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
        },
      );

      const unlistenApplyProgress = await api.listen(
        "apply_edits_progress",
        (raw) => {
          if (cancelled) return;
          const payload = raw as ApplyEditsProgressPayload;
          handleApplyEditsProgress(
            payload,
            draftEditsStoreRef.current,
            imageMetadataStoreRef.current,
            setAppState,
          );
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
        unlistenApplyProgress,
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

    setAppState({ kind: "idle" });
    api.invoke("stop_scan").catch(() => {});
    api.invoke("set_window_title", { title: "Media Library" }).catch(() => {});
  }, [api]);

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
      const next = store.getAll();
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
            data: legacyDraftsToMetadataDrafts(next),
          })
          .catch(console.error);
      }
    });
    return unsub;
  }, [api]);

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
    (fileRelativePath: string, tag: string) => {
      draftEditsStoreRef.current.deleteTag(fileRelativePath, tag);
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const next = removeVerifyOutcome(
          prev.verifyOutcomes,
          fileRelativePath,
          tag,
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
   * exiftool actually wrote (raw view), so the user's next save attempt acts
   * on the file as it now is rather than on the original sent value.
   */
  const revertVerifyOutcome = useCallback(
    (
      fileRelativePath: string,
      tag: string,
      observedRaw: MetadataValue | null,
    ) => {
      const observedVariant = metadataEntryToVariant(observedRaw);
      const newEdit: DraftEdit =
        observedVariant === null
          ? { value: null, intent: "Delete" }
          : { value: observedVariant, intent: "Set" };
      draftEditsStoreRef.current.setTag(fileRelativePath, tag, newEdit);
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const next = removeVerifyOutcome(
          prev.verifyOutcomes,
          fileRelativePath,
          tag,
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
    (fileRelativePath: string, tag: string) => {
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const next = removeVerifyOutcome(
          prev.verifyOutcomes,
          fileRelativePath,
          tag,
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

  /**
   * Set many draft entries for one file in a single state update.  Used by
   * paired-tag editors like GpsEditor that must update Latitude / Ref /
   * Longitude / Ref atomically so the on-disk file never has half-updated
   * coords if the user navigates away mid-edit.
   */
  const setDraftBatch = useCallback(
    (
      fileRelativePath: string,
      edits: Array<{ key: string; edit: DraftEdit }>,
    ) => {
      draftEditsStoreRef.current.setBatch(fileRelativePath, edits);
    },
    [],
  );

  const setMetadataDraftBatch = useCallback(
    (
      fileRelativePath: string,
      edits: Array<{ key: string; edit: MetadataDraftEdit }>,
    ) => {
      draftEditsStoreRef.current.setBatch(
        fileRelativePath,
        edits.map(({ key, edit }) => ({
          key,
          edit: metadataDraftToLegacyDraft(edit),
        })),
      );
    },
    [],
  );

  const setDraftTyped = useCallback(
    (fileRelativePath: string, propertyKey: string, edit: DraftEdit) => {
      draftEditsStoreRef.current.setTag(fileRelativePath, propertyKey, edit);
    },
    [],
  );

  const discardDraftValue = useCallback(
    (fileRelativePath: string, propertyKey: string) => {
      draftEditsStoreRef.current.deleteTag(fileRelativePath, propertyKey);
    },
    [],
  );

  const discardAllDraftEdits = useCallback(
    (fileRelativePath?: string | string[]) => {
      if (fileRelativePath === undefined) {
        draftEditsStoreRef.current.clear();
      } else {
        const paths = Array.isArray(fileRelativePath)
          ? fileRelativePath
          : [fileRelativePath];
        draftEditsStoreRef.current.deletePaths(paths);
      }
    },
    [],
  );

  /**
   * Apply draft edits. The backend processes files one at a time, emitting
   * `apply_edits_started` once and `apply_edits_progress` after each file.
   * Those events drive incremental state updates (see setup()), so this
   * function does not need to apply any state changes from the final result.
   *
   * The promise resolves once all files are done (or cancellation took effect).
   * Callers can use the result for a final summary; state is already current.
   */
  const applyDraftEdits = useCallback(
    async (
      fileRelativePath?: string | string[],
    ): Promise<MetadataApplyEditsResult> => {
      const current = stateRef.current;
      if (current.kind !== "loaded") {
        return { applied: [], failed: [], fresh_metadata: {} };
      }

      let relPaths: string[];
      if (fileRelativePath === undefined) {
        relPaths = Object.keys(current.draftEdits ?? {});
      } else {
        const requested = Array.isArray(fileRelativePath)
          ? fileRelativePath
          : [fileRelativePath];
        relPaths = requested.filter((p) => current.draftEdits?.[p]);
      }

      if (relPaths.length === 0) {
        return { applied: [], failed: [], fresh_metadata: {} };
      }

      try {
        const result = (await api.invoke("apply_metadata_draft_edits_cmd", {
          folderPath: current.folder,
          relPaths,
        })) as MetadataApplyEditsResult;
        return result;
      } finally {
        // Always clear the in-flight modal regardless of resolution path
        setAppState((prev) =>
          prev.kind === "loaded" ? { ...prev, applying: null } : prev,
        );
      }
    },
    [api],
  );

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
      setMetadataDraftBatch,
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
      setMetadataDraftBatch,
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

/**
 * Process one `apply_edits_progress` event: prune drafts per the
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
  setAppState: React.Dispatch<React.SetStateAction<AppState>>,
) {
  // Apply per-file changes incrementally so the UI reflects file/disk
  // state in real time and a crash mid-operation leaves coherent state.
  if (payload.fresh_metadata) {
    imageMetadataStore.set(
      payload.relative_path,
      normalizeMetadataFromTauri(payload.fresh_metadata),
    );
  }

  // Phase 8.1: prune drafts per-tag based on the backend's verification
  // outcomes.  Match and DeleteOk are conclusively safe to drop; the
  // rest stay so the user can act on them via VerifyOutcomeDialog.
  //
  const fileOutcomes = payload.tag_outcomes;
  const tagsToPrune = fileOutcomes
    .filter((o) => o.kind === "Match" || o.kind === "DeleteOk")
    .map((o) => o.tag);
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
