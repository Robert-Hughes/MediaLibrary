import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThumbnailStore,
  FileMetadataOccurrencesStore,
  MetadataProgressStore,
} from "./types";
import type {
  AppState,
  FileMetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
  ApplicationErrorPayload,
  ApplyEditsFileIssue,
  FileInfo,
  SortConfig,
  VisibleColumn,
  MetadataApplyResult,
  MetadataDraftEdit,
  SchemaMetadataEdit,
  SchemaDefinitionId,
  FileMetadata,
  TargetDraftPersistenceState,
  MetadataTargetDraftEntry,
  TagInfo,
  RecycleFilesResult,
  MediaLibrarySessionSnapshot,
  MediaLibrarySessionFilesAdded,
} from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";
import {
  MAX_APPLICATION_ERRORS,
  normalizeMetadataOccurrencesFromTauri,
  scheduleBatchedFlush,
} from "./utils/scanEvents";
import { useRecentFolders } from "./hooks/useRecentFolders";
import { useWritableSchemaDefinitions } from "./hooks/useWritableSchemaDefinitions";
import {
  metadataTargetDraftEntryEqualsExact,
  TargetDraftEditsStore,
} from "./targetDraftEdits";
import { TargetDraftAutosaveGate } from "./targetDraftAutosaveGate";
import { TargetApplyController } from "./targetApplyController";
import {
  loadTargetDraftEdits,
  saveTargetDraftRows,
  targetDraftChangesToMutations,
  type MetadataDraftRowMutation,
} from "./targetDraftTauri";
import { CoalescingAsyncQueue } from "./coalescingAsyncQueue";
import { frontendNow, logSlowFrontendOperation } from "./frontendPerformance";
import type { MetadataDraftTarget } from "./types";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./utils/schemaDefinitionId";
import { TargetVerifyOutcomesStore } from "./targetVerifyOutcomesStore";
import {
  currentValueForMetadataDraftTarget,
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
  newPropertyDraftTarget,
} from "./utils/metadataDraftTarget";
import { validateFamily1Group } from "./utils/metadataWriteTarget";
import { classifyNewPropertyDestination } from "./utils/newPropertyDestinationSafety";
import { tagInfoSupportsMetadataWrite } from "./utils/metadataWriteSupport";
import { resolveExactMetadataOccurrence } from "./utils/metadataOccurrences";
import { validateGpsTargetDraftEntries } from "./gpsTargetDrafts";
import {
  planMetadataRemovalTargets,
  planMetadataTargetRemovals,
} from "./metadataRemovalTargets";
import {
  planGeneratedTargetDraftBatch,
  type GeneratedDraftStageResult,
  type GeneratedMetadataProducer,
} from "./generatedTargetDrafts";
import {
  BulkMetadataDraftPlanError,
  planBulkMetadataDraftBatch,
  type BulkMetadataDraftPlan,
  type BulkMetadataDraftRequest,
} from "./bulkMetadataDrafts";

const TARGET_DRAFT_AUTOSAVE_MIN_INTERVAL_MS = 3_000;

function logApplicationIssue(
  severity: ApplicationErrorPayload["severity"],
  errorType: string,
  error: unknown,
  affectedFiles: string[],
): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const context = { affectedFiles, error };
  const message = `[application-${severity}:${errorType}] ${errorMessage}`;
  if (severity === "warning") console.warn(message, context);
  else console.error(message, context);
  return errorMessage;
}

const TARGET_DRAFT_LOAD_BLOCKED_MESSAGE =
  "Target-aware drafts could not be loaded safely. Fix the folder's target-aware draft persistence file, then reopen the folder.";

const TARGET_DRAFT_NOT_LOADED_STATE: TargetDraftPersistenceState = {
  status: "load-failed",
  error: "Target-aware drafts have not finished loading for this folder.",
};

function emptyMetadataApplyResult(): MetadataApplyResult {
  return {
    summary: {
      requested: 0,
      selected: 0,
      completed: 0,
      applied: 0,
      failed: 0,
      warning_count: 0,
      cancelled: false,
      aborted: false,
      abort_reason: null,
      delivery_failure_count: 0,
    },
    undelivered_files: [],
    complete_delivery_failed: false,
  };
}

export interface TauriApi {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (
    event: string,
    handler: (payload: unknown) => void,
  ) => Promise<() => void>;
  createChannel: (handler: (payload: unknown) => void) => {
    onmessage: (payload: unknown) => void;
  };
}

export interface MediaLibraryActions {
  openFolder: () => Promise<void>;
  openRecent: (folder: string) => Promise<void>;
  closeFolder: () => void;
  prioritizeQueues: (visiblePaths: string[]) => void;
  selectFile: (relativePath: string | null) => void;
  showInExplorer: (index: number) => Promise<void>;
  recycleFiles: (relativePaths: string[]) => Promise<RecycleFilesResult>;
  openGallery: (relativePath: string) => void;
  closeGallery: () => void;
  setVisibleColumns: (columns: VisibleColumn[]) => void;
  setSortConfig: (config: SortConfig) => void;
  updateColumnWidth: (col: string, width: number) => void;
  resetColumnWidths: () => void;
  dismissError: (index: number) => void;
  canOpenBulkMetadataEditor: (relativePaths: string[]) => boolean;
  canStageGeneratedMetadata: (relativePaths: string[]) => boolean;
  applyGeneratedMetadataDraftBatch: (
    relativePath: string,
    producer: GeneratedMetadataProducer,
    edits: SchemaMetadataEdit[],
  ) => GeneratedDraftStageResult;
  applyGeneratedMetadataDraftBatches: (
    items: readonly {
      relativePath: string;
      producer: GeneratedMetadataProducer;
      edits: SchemaMetadataEdit[];
    }[],
  ) => GeneratedDraftStageResult[];
  previewBulkMetadataDraftBatch: (
    relativePaths: string[],
    request: BulkMetadataDraftRequest,
  ) =>
    | { kind: "ready"; plan: BulkMetadataDraftPlan }
    | { kind: "blocked"; reason: string; relativePath?: string };
  stageBulkMetadataDraftBatch: (
    relativePaths: string[],
    request: BulkMetadataDraftRequest,
  ) => boolean;
  removeMetadataTargets: (
    relativePath: string,
    targets: MetadataDraftTarget[],
  ) => boolean;
  removeMetadataFields: (
    relativePath: string,
    schemaIds: SchemaDefinitionId[],
  ) => boolean;
  removeMetadataFieldFromFiles: (
    schemaId: SchemaDefinitionId,
    relativePaths: string[],
  ) => boolean;
  applyGpsTargetDraftBatch: (
    relativePath: string,
    entries: MetadataTargetDraftEntry[],
  ) => boolean;
  setExistingOccurrenceDraft: (
    fileRelativePath: string,
    target: Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }>,
    edit: MetadataDraftEdit,
  ) => void;
  setNewPropertyDraft: (
    fileRelativePath: string,
    target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    edit: MetadataDraftEdit,
  ) => Promise<boolean>;
  replaceNewPropertyDraftTarget: (
    fileRelativePath: string,
    originalTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    replacementTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    originalEdit: MetadataDraftEdit,
  ) => Promise<boolean>;
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
  ) => Promise<MetadataApplyResult>;
  cancelApplyEdits: () => void;
  dismissApplyCompletion: () => void;
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
  const writableSchemaDefinitions = useWritableSchemaDefinitions(api.invoke);

  const thumbnailStoreRef = useRef<ThumbnailStore>(new ThumbnailStore());
  const fileMetadataOccurrencesStoreRef = useRef<FileMetadataOccurrencesStore>(
    new FileMetadataOccurrencesStore(),
  );
  const metadataProgressStoreRef = useRef<MetadataProgressStore>(
    new MetadataProgressStore(),
  );
  // The scan_id of the most recently started scan. Events with a different
  // scan_id are stale (from a previous scan) and are discarded.
  const activeScanIdRef = useRef<number>(-1);
  const sessionRevisionRef = useRef<number>(-1);
  const seenSessionIssueIdsRef = useRef<Set<number>>(new Set());
  // Monotonic frontend lifecycle identity. Unlike scan_id, this also changes
  // immediately when replacing or closing a scan and cannot collide when the
  // same folder is reopened within one clock tick.
  const scanLifecycleGenerationRef = useRef(0);
  const targetDraftEditsStoreRef = useRef<TargetDraftEditsStore>(
    new TargetDraftEditsStore(),
  );
  const targetVerifyOutcomesStoreRef = useRef<TargetVerifyOutcomesStore>(
    new TargetVerifyOutcomesStore(),
  );
  const targetDraftAutosaveGateRef = useRef<TargetDraftAutosaveGate>(
    new TargetDraftAutosaveGate(),
  );
  const targetDraftSaveQueueRef = useRef<CoalescingAsyncQueue<{
    folder: string;
    mutations: MetadataDraftRowMutation[];
    revisions: Map<string, number>;
  }> | null>(null);
  const targetDraftDirtyRowsRef = useRef(
    new Map<string, { revision: number; mutation: MetadataDraftRowMutation }>(),
  );
  const targetDraftMutationRevisionRef = useRef(0);
  const targetApplyControllerRef = useRef<TargetApplyController | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const activeFolderRef = useRef<string | null>(null);
  const targetLoadErrorRef = useRef<ApplicationErrorPayload | null>(null);
  const targetDraftPersistenceRef = useRef<TargetDraftPersistenceState>(
    TARGET_DRAFT_NOT_LOADED_STATE,
  );
  const applyActiveRef = useRef(false);
  const applyIssuesRef = useRef<ApplyEditsFileIssue[]>([]);
  const activeApplyPromiseRef = useRef<Promise<MetadataApplyResult> | null>(
    null,
  );

  const loadedStateFromProjection = useCallback(
    (
      folder: string,
      files: FileInfo[],
      scanning: boolean,
      presentation?: {
        visibleColumns: VisibleColumn[];
        columnWidths: Record<string, number>;
        sortConfig: SortConfig;
      },
    ): Extract<AppState, { kind: "loaded" }> => {
      for (const file of files) {
        thumbnailStoreRef.current.add(file.relative_path);
        fileMetadataOccurrencesStoreRef.current.add(file.relative_path);
      }
      metadataProgressStoreRef.current.setTotal(files.length);
      const columns = presentation ?? loadColumnConfig();
      return {
        kind: "loaded",
        folder,
        files,
        thumbnails: thumbnailStoreRef.current,
        fileMetadataOccurrences: fileMetadataOccurrencesStoreRef.current,
        metadataProgress: metadataProgressStoreRef.current,
        scanning,
        galleryPath: null,
        selectedPath: null,
        visibleColumns: columns.visibleColumns,
        columnWidths: columns.columnWidths,
        sortConfig: columns.sortConfig,
        metadataVersion: 0,
        applicationErrors: targetLoadErrorRef.current
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
    },
    [],
  );

  const applySessionSnapshot = useCallback(
    (snapshot: MediaLibrarySessionSnapshot) => {
      if (snapshot.lifecycle === "idle" && snapshot.revision === 0) return;
      if (snapshot.revision <= sessionRevisionRef.current) return;
      const previousRevision = sessionRevisionRef.current;
      sessionRevisionRef.current = snapshot.revision;

      if (snapshot.lifecycle === "idle") {
        const hadActiveSession =
          activeScanIdRef.current !== -1 || activeFolderRef.current !== null;
        activeScanIdRef.current = -1;
        activeFolderRef.current = null;
        if (hadActiveSession) setAppState({ kind: "idle" });
        return;
      }
      if (snapshot.session_id === null || snapshot.folder === null) return;

      const previousSessionId = activeScanIdRef.current;
      const isRecovery = previousSessionId === -1;
      if (previousSessionId !== snapshot.session_id) {
        seenSessionIssueIdsRef.current.clear();
      }
      activeScanIdRef.current = snapshot.session_id;
      activeFolderRef.current = snapshot.folder;
      if (snapshot.lifecycle === "opening") {
        if (isRecovery) {
          const { visibleColumns, sortConfig, columnWidths } =
            loadColumnConfig();
          setAppState({
            kind: "loading",
            folder: snapshot.folder,
            visibleColumns,
            columnWidths,
            sortConfig,
          });
        }
        return;
      }
      if (snapshot.lifecycle === "loaded") {
        for (const file of snapshot.files) {
          fileMetadataOccurrencesStoreRef.current.add(file.relative_path);
        }
        for (const issue of snapshot.issues) {
          if (seenSessionIssueIdsRef.current.has(issue.issue_id)) continue;
          seenSessionIssueIdsRef.current.add(issue.issue_id);
          console.error(
            `Worker error (${issue.error_type}):`,
            issue.error_message,
          );
          if (issue.error_type !== "metadata") continue;
          let newlyFailed = 0;
          for (const path of issue.affected_files) {
            if (!fileMetadataOccurrencesStoreRef.current.has(path)) continue;
            if (
              fileMetadataOccurrencesStoreRef.current.get(path) === "loading"
            ) {
              newlyFailed += 1;
            }
            fileMetadataOccurrencesStoreRef.current.setFailed(
              path,
              issue.error_message,
            );
            metadataCompletedPathsRef.current.add(path);
          }
          if (newlyFailed > 0) {
            metadataProgressStoreRef.current.incrementReceived(newlyFailed);
          }
        }
        setAppState((previous) => {
          const canApplyStatusOnly =
            previous.kind === "loaded" &&
            !isRecovery &&
            snapshot.revision === previousRevision + 1;
          if (canApplyStatusOnly && previous.kind === "loaded") {
            const localErrors = previous.applicationErrors.filter(
              (error) => error.issue_id == null,
            );
            const backendErrors: ApplicationErrorPayload[] =
              snapshot.issues.map((issue) => ({
                ...issue,
                severity: (issue.severity === "warning"
                  ? "warning"
                  : "error") as ApplicationErrorPayload["severity"],
                scan_id: snapshot.session_id!,
              }));
            return {
              ...previous,
              scanning: snapshot.discovery_running,
              applicationErrors: [...localErrors, ...backendErrors].slice(
                -MAX_APPLICATION_ERRORS,
              ),
            };
          }

          const presentation =
            previous.kind === "loading" || previous.kind === "loaded"
              ? {
                  visibleColumns: previous.visibleColumns,
                  columnWidths: previous.columnWidths,
                  sortConfig: previous.sortConfig,
                }
              : undefined;
          const next = loadedStateFromProjection(
            snapshot.folder!,
            snapshot.files,
            snapshot.discovery_running,
            presentation,
          );
          if (previous.kind === "loaded") {
            next.galleryPath = previous.galleryPath;
            next.selectedPath = previous.selectedPath;
            next.metadataVersion = previous.metadataVersion;
            const localErrors = previous.applicationErrors.filter(
              (error) => error.issue_id == null,
            );
            const backendErrors: ApplicationErrorPayload[] =
              snapshot.issues.map((issue) => ({
                ...issue,
                severity: (issue.severity === "warning"
                  ? "warning"
                  : "error") as ApplicationErrorPayload["severity"],
                scan_id: snapshot.session_id!,
              }));
            next.applicationErrors = [...localErrors, ...backendErrors].slice(
              -MAX_APPLICATION_ERRORS,
            );
            next.applying = previous.applying;
            next.applyCompletion = previous.applyCompletion;
          } else {
            const backendErrors: ApplicationErrorPayload[] =
              snapshot.issues.map((issue) => ({
                ...issue,
                severity: (issue.severity === "warning"
                  ? "warning"
                  : "error") as ApplicationErrorPayload["severity"],
                scan_id: snapshot.session_id!,
              }));
            next.applicationErrors = [
              ...next.applicationErrors.filter(
                (error) => error.issue_id == null,
              ),
              ...backendErrors,
            ].slice(-MAX_APPLICATION_ERRORS);
          }
          return next;
        });
      }
    },
    [loadedStateFromProjection],
  );

  const pushApplicationIssue = useCallback(
    (
      severity: ApplicationErrorPayload["severity"],
      errorType: string,
      error: unknown,
      affectedFiles: string[] = [],
    ) => {
      const errorMessage = logApplicationIssue(
        severity,
        errorType,
        error,
        affectedFiles,
      );
      const payload: ApplicationErrorPayload = {
        issue_id: null,
        scan_id: activeScanIdRef.current,
        severity,
        error_type: errorType,
        error_message: errorMessage,
        affected_files: affectedFiles,
      };
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const applicationErrors = [...prev.applicationErrors, payload].slice(
          -MAX_APPLICATION_ERRORS,
        );
        return { ...prev, applicationErrors };
      });
    },
    [],
  );

  const pushApplicationError = useCallback(
    (errorType: string, error: unknown, affectedFiles: string[] = []) =>
      pushApplicationIssue("error", errorType, error, affectedFiles),
    [pushApplicationIssue],
  );

  const pushApplicationWarning = useCallback(
    (errorType: string, warning: unknown, affectedFiles: string[] = []) =>
      pushApplicationIssue("warning", errorType, warning, affectedFiles),
    [pushApplicationIssue],
  );

  if (targetDraftSaveQueueRef.current === null) {
    targetDraftSaveQueueRef.current = new CoalescingAsyncQueue(
      async ({ folder, mutations, revisions }) => {
        const startedAt = frontendNow();
        await saveTargetDraftRows(apiRef.current, folder, mutations);
        for (const [path, revision] of revisions) {
          if (
            targetDraftDirtyRowsRef.current.get(path)?.revision === revision
          ) {
            targetDraftDirtyRowsRef.current.delete(path);
          }
        }
        logSlowFrontendOperation("draft-autosave", startedAt, {
          files: mutations.length,
        });
      },
      (error) => pushApplicationError("metadata-target-save", error),
      { minIntervalMs: TARGET_DRAFT_AUTOSAVE_MIN_INTERVAL_MS },
    );
  }

  useEffect(() => {
    targetDraftEditsStoreRef.current.setCurrentValueResolver((path, target) =>
      currentValueForMetadataDraftTarget(
        fileMetadataOccurrencesStoreRef.current.get(path),
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
  const fileBufferRef = useRef<FileInfo[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstFlushRef = useRef<boolean>(true);
  const metadataBufferRef = useRef<FileMetadata[]>([]);
  // Exact scan-progress membership. Occurrence state can become authoritative
  // through an apply result before the scan's own progress slot completes.
  const metadataCompletedPathsRef = useRef<Set<string>>(new Set());
  // Once apply returns an authoritative post-write read for a file, any
  // outstanding metadata result from the current folder scan is older by
  // construction and must not replace it.
  const scanMetadataSupersededPathsRef = useRef<Set<string>>(new Set());
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

  // Construct the sole production target-aware controller after mount. Its dependency
  // stores keep stable identity for the complete hook lifetime.
  useEffect(() => {
    let controller = targetApplyControllerRef.current;
    if (controller === null) {
      controller = new TargetApplyController(
        {
          api: {
            invoke: (command, args) => apiRef.current.invoke(command, args),
            createChannel: (handler) => apiRef.current.createChannel(handler),
          },
          stores: {
            drafts: targetDraftEditsStoreRef.current,
            occurrences: fileMetadataOccurrencesStoreRef.current,
            verification: targetVerifyOutcomesStoreRef.current,
          },
          autosaveGate: targetDraftAutosaveGateRef.current,
        },
        {
          onProgressBatch: (payload, applications) => {
            for (const result of payload.results) {
              if (
                result.fresh_file_metadata !== null &&
                !metadataCompletedPathsRef.current.has(result.relative_path)
              ) {
                scanMetadataSupersededPathsRef.current.add(
                  result.relative_path,
                );
              }
            }
            if (!applications.some((item) => item.occurrencesChanged)) return;
            setAppState((prev) =>
              prev.kind === "loaded"
                ? { ...prev, metadataVersion: prev.metadataVersion + 1 }
                : prev,
            );
          },
          onProtocolError: ({ error }) =>
            pushApplicationError("metadata-target-protocol", error),
          onProgressApplicationError: ({ error }) =>
            pushApplicationError("metadata-target-progress", error),
          onFileError: (relativePath, error) => {
            applyIssuesRef.current.push({
              relativePath,
              severity: "error",
              message: error,
            });
            pushApplicationError("metadata-target-file", error, [relativePath]);
          },
          onFileWarning: (relativePath, warning) => {
            applyIssuesRef.current.push({
              relativePath,
              severity: "warning",
              message: warning,
            });
            pushApplicationWarning("metadata-target-warning", warning, [
              relativePath,
            ]);
          },
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
  }, [pushApplicationError, pushApplicationWarning]);

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
      // file_found / scan_complete events are never missed.  The latch is a
      // plain Promise (no setTimeout) so it works correctly with vi.useFakeTimers().
      await listenersReadyRef.current;
      await targetDraftSaveQueueRef.current?.flush();
      targetDraftDirtyRowsRef.current.clear();

      // Finish cancellation before
      // clearing stable stores so late controller events cannot cross folders.
      await cancelActiveApplyAndWait();

      const session = (await api.invoke("open_media_library_session", {
        folderPath: folder,
      })) as MediaLibrarySessionSnapshot;
      if (session.session_id === null || session.folder !== folder) {
        throw new Error("Rust opened an invalid media-library session");
      }
      const scanId = session.session_id;
      console.debug(`[startScan] folder=${folder} sessionId=${scanId}`);

      // The Rust session identity is also the scan identity used by streamed work.
      activeScanIdRef.current = scanId;

      // Clear all buffers + timers from any previous scan.
      fileBufferRef.current = [];
      metadataBufferRef.current = [];
      metadataCompletedPathsRef.current.clear();
      scanMetadataSupersededPathsRef.current.clear();
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
      fileMetadataOccurrencesStoreRef.current.clear();
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
        const loaded = await loadTargetDraftEdits(api, folder);
        targetDraftEditsStoreRef.current.resetMetadata(loaded);
        targetDraftPersistenceRef.current = { status: "ready" };
      } catch (error) {
        console.error("Failed to load target-aware target drafts", error);
        targetDraftEditsStoreRef.current.resetMetadata({});
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        targetDraftPersistenceRef.current = {
          status: "load-failed",
          error: errorMessage,
        };
        targetLoadErrorRef.current = {
          scan_id: scanId,
          severity: "error",
          error_type: "metadata-target-load",
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
      const startedAt = frontendNow();
      const batch = [...fileBufferRef.current];
      fileBufferRef.current = [];
      console.debug(
        `[file_found] flushing ${batch.length} files (total buffer was ${batch.length})`,
      );

      setAppState((prev) => {
        if (prev.kind === "idle") return prev;

        if (prev.kind === "loading") {
          if (batch.length === 0) return prev;
          return loadedStateFromProjection(prev.folder, batch, true, {
            visibleColumns: prev.visibleColumns,
            columnWidths: prev.columnWidths,
            sortConfig: prev.sortConfig,
          });
        }

        if (prev.kind === "loaded") {
          if (batch.length === 0) return prev;
          const newFiles = [...prev.files, ...batch];
          metadataProgressStoreRef.current.setTotal(newFiles.length);
          return { ...prev, files: newFiles };
        }
        return prev;
      });
      logSlowFrontendOperation("scan-file-flush", startedAt, {
        items: batch.length,
      });
    };

    // Flush authoritative occurrences.
    const flushMetadataBatch = () => {
      const startedAt = frontendNow();
      const batch = [...metadataBufferRef.current];
      metadataBufferRef.current = [];

      if (batch.length === 0) return;
      console.debug(`[metadata] flushing ${batch.length} results`);

      let acceptedCount = 0;
      let completedCount = 0;
      for (const res of batch) {
        if (!fileMetadataOccurrencesStoreRef.current.has(res.relative_path)) {
          continue;
        }
        completedCount += 1;
        metadataCompletedPathsRef.current.add(res.relative_path);
        if (scanMetadataSupersededPathsRef.current.has(res.relative_path)) {
          scanMetadataSupersededPathsRef.current.delete(res.relative_path);
          continue;
        }
        fileMetadataOccurrencesStoreRef.current.set(
          res.relative_path,
          normalizeMetadataOccurrencesFromTauri(res.occurrences),
        );
        acceptedCount += 1;
      }

      // Superseded scan results still complete their scan-progress slot even
      // though their older values are deliberately not installed.
      metadataProgressStoreRef.current.incrementReceived(completedCount);

      // Increment metadataVersion so that any active sort on image metadata fields
      // causes the sortedFiles useMemo to recompute.
      if (acceptedCount > 0) {
        setAppState((prev) => {
          if (prev.kind !== "loaded") return prev;
          if (
            !prev.sortConfig.primary ||
            prev.sortConfig.primary.kind !== "image"
          )
            return prev;
          return { ...prev, metadataVersion: prev.metadataVersion + 1 };
        });
      }
      logSlowFrontendOperation("scan-metadata-flush", startedAt, {
        items: batch.length,
      });
    };

    // Flush thumbnail batch - updates ThumbnailStore without triggering
    // unnecessary React state updates (the store handles per-row reactivity)
    const flushThumbnailBatch = () => {
      const startedAt = frontendNow();
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
      logSlowFrontendOperation("scan-thumbnail-flush", startedAt, {
        items: batch.length,
      });
    };

    const setup = async () => {
      // Create a new pending latch for this setup cycle; startScan awaits it.
      let resolve!: () => void;
      listenersReadyRef.current = new Promise<void>((r) => {
        resolve = r;
      });

      const unlistenSession = await api.listen(
        "media_library_session_changed",
        (raw) => applySessionSnapshot(raw as MediaLibrarySessionSnapshot),
      );

      const unlistenFound = await api.listen(
        "media_library_session_files_added",
        (raw) => {
          if (cancelled) return;
          const { session_id, revision, files } =
            raw as MediaLibrarySessionFilesAdded;
          if (session_id !== activeScanIdRef.current) return;
          if (revision <= sessionRevisionRef.current) return;
          sessionRevisionRef.current = revision;
          console.debug(`[session-files] received ${files.length} files`);

          for (const file of files) {
            thumbnailStoreRef.current.add(file.relative_path);
            fileMetadataOccurrencesStoreRef.current.add(file.relative_path);
            fileBufferRef.current.push(file);
          }

          scheduleBatchedFlush(
            fileBufferRef.current.length,
            batchTimerRef,
            isFirstFlushRef,
            flushBatch,
            100,
          );
        },
      );

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
      });

      const unlistenMetadata = await api.listen(
        "file_metadata_ready",
        (raw) => {
          if (cancelled) return;
          const { scan_id, results } = raw as FileMetadataReadyPayload;
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

      unlisteners.push(
        unlistenSession,
        unlistenFound,
        unlistenComplete,
        unlistenMetadata,
        unlistenThumbnail,
        unlistenError,
      );

      // All listeners registered — unblock any startScan that was awaiting.
      const initialSession = (await api.invoke(
        "get_media_library_session_snapshot",
      )) as MediaLibrarySessionSnapshot;
      if (
        !cancelled &&
        initialSession.folder &&
        initialSession.lifecycle !== "idle"
      ) {
        try {
          const loaded = await loadTargetDraftEdits(api, initialSession.folder);
          targetDraftEditsStoreRef.current.resetMetadata(loaded);
          targetDraftPersistenceRef.current = { status: "ready" };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          targetDraftEditsStoreRef.current.resetMetadata({});
          targetDraftPersistenceRef.current = {
            status: "load-failed",
            error: errorMessage,
          };
          targetLoadErrorRef.current = {
            scan_id: initialSession.session_id ?? -1,
            severity: "error",
            error_type: "metadata-target-load",
            error_message: errorMessage,
            affected_files: [],
          };
        }
      }
      if (!cancelled) applySessionSnapshot(initialSession);

      console.debug("[setup] all listeners registered");
      resolve();
    };

    setup();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [api, applySessionSnapshot, loadedStateFromProjection]);

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
    fileBufferRef.current = [];
    metadataBufferRef.current = [];
    metadataCompletedPathsRef.current.clear();
    thumbnailBufferRef.current = [];
    targetDraftEditsStoreRef.current.resetMetadata({});
    targetVerifyOutcomesStoreRef.current.clear();
    fileMetadataOccurrencesStoreRef.current.clear();

    setAppState({ kind: "idle" });
    api
      .invoke("close_media_library_session")
      .catch((error) =>
        console.error("Failed to close media-library session", error),
      );
    api.invoke("set_window_title", { title: "Media Library" }).catch(() => {});
  }, [api, cancelActiveApplyAndWait]);

  const prioritizeQueues = useCallback(
    (visiblePaths: string[]) => {
      console.debug(`[prioritizeQueues] ${visiblePaths.length} paths`);
      api.invoke("prioritize_queues", { visiblePaths }).catch(() => {});
    },
    [api],
  );

  const selectFile = useCallback((relativePath: string | null) => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, selectedPath: relativePath } : prev,
    );
  }, []);

  const stateRef = useRef(appState);
  stateRef.current = appState;

  const recycleFiles = useCallback(
    async (relativePaths: string[]): Promise<RecycleFilesResult> => {
      const current = stateRef.current;
      if (current.kind !== "loaded") return { results: [] };
      const activePaths = new Set(
        current.files.map((file) => file.relative_path),
      );
      const requested = [...new Set(relativePaths)].filter((path) =>
        activePaths.has(path),
      );
      if (requested.length === 0) return { results: [] };

      let result: RecycleFilesResult;
      try {
        result = (await api.invoke("recycle_media_files", {
          folder: current.folder,
          relativePaths: requested,
        })) as RecycleFilesResult;
      } catch (error) {
        pushApplicationError("recycle-files", error, requested);
        return {
          results: requested.map((relative_path) => ({
            relative_path,
            recycled: false,
            error: error instanceof Error ? error.message : String(error),
          })),
        };
      }

      const successful = result.results
        .filter((item) => item.recycled)
        .map((item) => item.relative_path);
      const successfulSet = new Set(successful);
      if (successful.length > 0) {
        metadataBufferRef.current = metadataBufferRef.current.filter(
          (item) => !successfulSet.has(item.relative_path),
        );
        thumbnailBufferRef.current = thumbnailBufferRef.current.filter(
          (item) => !successfulSet.has(item.relative_path),
        );

        for (const path of successful) {
          metadataProgressStoreRef.current.removeFile(
            metadataCompletedPathsRef.current.has(path),
          );
          metadataCompletedPathsRef.current.delete(path);
          scanMetadataSupersededPathsRef.current.delete(path);
        }
        thumbnailStoreRef.current.deletePaths(successful);
        fileMetadataOccurrencesStoreRef.current.deletePaths(successful);
        targetDraftEditsStoreRef.current.deletePaths(successful);

        setAppState((prev) => {
          if (prev.kind !== "loaded" || prev.folder !== current.folder) {
            return prev;
          }
          return {
            ...prev,
            files: prev.files.filter(
              (file) => !successfulSet.has(file.relative_path),
            ),
            selectedPath:
              prev.selectedPath !== null && successfulSet.has(prev.selectedPath)
                ? null
                : prev.selectedPath,
            galleryPath:
              prev.galleryPath !== null && successfulSet.has(prev.galleryPath)
                ? null
                : prev.galleryPath,
          };
        });
        await targetDraftSaveQueueRef.current?.flush();
      }

      const failures = result.results.filter((item) => !item.recycled);
      if (failures.length > 0) {
        pushApplicationError(
          "recycle-files",
          `${failures.length} ${failures.length === 1 ? "file" : "files"} could not be moved to the Recycle Bin:\n${failures
            .map(
              (item) =>
                `${item.relative_path}: ${item.error ?? "Unknown error"}`,
            )
            .join("\n")}`,
          failures.map((item) => item.relative_path),
        );
      }
      return result;
    },
    [api, pushApplicationError],
  );

  // One production subscription owns both the React snapshot and target-aware
  // autosave. Controller-applied backend snapshots notify this same path while
  // the gate is suppressed, so they update UI without a duplicate save.
  useEffect(() => {
    const store = targetDraftEditsStoreRef.current;
    return store.subscribe((changes) => {
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
      const mutations = targetDraftChangesToMutations(changes);
      for (const mutation of mutations) {
        const revision = ++targetDraftMutationRevisionRef.current;
        targetDraftDirtyRowsRef.current.set(mutation.relative_path, {
          revision,
          mutation,
        });
      }
      targetDraftSaveQueueRef.current?.schedule({
        folder,
        mutations: Array.from(
          targetDraftDirtyRowsRef.current.values(),
          ({ mutation }) => mutation,
        ),
        revisions: new Map(
          Array.from(
            targetDraftDirtyRowsRef.current,
            ([path, { revision }]) => [path, revision] as const,
          ),
        ),
      });
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
      const file = current.files[index];
      if (!file) return;

      api
        .invoke("show_in_explorer", {
          folder: current.folder,
          relativePath: file.relative_path,
        })
        .catch(() => {});
    },
    [api],
  );

  const openGallery = useCallback((relativePath: string) => {
    setAppState((prev) =>
      prev.kind === "loaded"
        ? { ...prev, galleryPath: relativePath, selectedPath: relativePath }
        : prev,
    );
  }, []);

  const closeGallery = useCallback(() => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, galleryPath: null } : prev,
    );
  }, []);

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
        "metadata-target-unavailable",
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

  const dismissError = useCallback(
    (index: number) => {
      const current =
        appState.kind === "loaded" ? appState.applicationErrors[index] : null;
      if (current?.issue_id != null) {
        void api.invoke("dismiss_media_library_session_issue", {
          issueId: current.issue_id,
        });
        return;
      }
      setAppState((prev) => {
        if (prev.kind !== "loaded") return prev;
        const newErrors = [...prev.applicationErrors];
        newErrors.splice(index, 1);
        return { ...prev, applicationErrors: newErrors };
      });
    },
    [api, appState],
  );

  const requireAuthoritativeMetadataReady = useCallback(
    (
      relativePaths: string[],
      errorType: string,
      blockedAction: string,
    ): boolean => {
      const paths = [...new Set(relativePaths)];
      if (!requireTargetDraftPersistenceReady(paths)) return false;
      const unavailable = paths.find(
        (relativePath) =>
          !Array.isArray(
            fileMetadataOccurrencesStoreRef.current.get(relativePath),
          ),
      );
      if (unavailable !== undefined) {
        const state = fileMetadataOccurrencesStoreRef.current.get(unavailable);
        const reason =
          state === "failed"
            ? `Metadata could not be loaded for '${unavailable}'.`
            : `Authoritative metadata occurrences are still loading for '${unavailable}'.`;
        pushApplicationError(errorType, `${reason} ${blockedAction}`, [
          unavailable,
        ]);
        return false;
      }
      return true;
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const canOpenBulkMetadataEditor = useCallback(
    (relativePaths: string[]): boolean =>
      requireAuthoritativeMetadataReady(
        relativePaths,
        "metadata-target-bulk-readiness",
        "The bulk metadata editor was not opened.",
      ),
    [requireAuthoritativeMetadataReady],
  );

  const canStageGeneratedMetadata = useCallback(
    (relativePaths: string[]): boolean => {
      if (writableSchemaDefinitions === "loading") {
        pushApplicationError(
          "metadata-target-generated-readiness",
          "Generated metadata was not started. Writable metadata schema definitions are still loading.",
          relativePaths,
        );
        return false;
      }
      return requireAuthoritativeMetadataReady(
        relativePaths,
        "metadata-target-generated-readiness",
        "Generated metadata was not started.",
      );
    },
    [
      pushApplicationError,
      requireAuthoritativeMetadataReady,
      writableSchemaDefinitions,
    ],
  );

  const applyGeneratedMetadataDraftBatches = useCallback(
    (
      items: readonly {
        relativePath: string;
        producer: GeneratedMetadataProducer;
        edits: SchemaMetadataEdit[];
      }[],
    ): GeneratedDraftStageResult[] => {
      if (items.length === 0) return [];
      const results: GeneratedDraftStageResult[] = items.map(() => ({
        kind: "success",
        changed: false,
      }));
      const activeItems = items
        .map((item, resultIndex) => ({ item, resultIndex }))
        .filter(({ item }) => item.edits.length > 0);
      if (activeItems.length === 0) return results;
      if (writableSchemaDefinitions === "loading") {
        const failure: GeneratedDraftStageResult = {
          kind: "failure",
          reason: "Writable metadata schema definitions are still loading.",
        };
        for (const { resultIndex } of activeItems) {
          results[resultIndex] = failure;
        }
        return results;
      }
      const startedAt = frontendNow();
      const paths = activeItems.map(({ item }) => item.relativePath);
      if (!requireTargetDraftPersistenceReady(paths)) {
        const persistence = targetDraftPersistenceRef.current;
        const failure: GeneratedDraftStageResult = {
          kind: "failure",
          reason:
            persistence.status === "load-failed"
              ? `${TARGET_DRAFT_LOAD_BLOCKED_MESSAGE} Load error: ${persistence.error}`
              : TARGET_DRAFT_LOAD_BLOCKED_MESSAGE,
        };
        for (const { resultIndex } of activeItems) {
          results[resultIndex] = failure;
        }
        return results;
      }

      const planned: Array<{
        resultIndex: number;
        mutation: {
          path: string;
          upserts: ReturnType<typeof planGeneratedTargetDraftBatch>["upserts"];
          deletes: ReturnType<typeof planGeneratedTargetDraftBatch>["deletes"];
        };
      }> = [];
      activeItems.forEach(
        ({ item: { relativePath, producer, edits }, resultIndex }) => {
          try {
            const plan = planGeneratedTargetDraftBatch({
              producer,
              fileName: relativePath,
              edits,
              occurrences:
                fileMetadataOccurrencesStoreRef.current.get(relativePath),
              targetDrafts:
                targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
              writableSchemaDefinitions,
            });
            planned.push({
              resultIndex,
              mutation: {
                path: relativePath,
                upserts: plan.upserts,
                deletes: plan.deletes,
              },
            });
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            logApplicationIssue(
              "error",
              "metadata-target-generated-stage",
              error,
              [relativePath],
            );
            results[resultIndex] = { kind: "failure", reason };
          }
        },
      );

      if (planned.length === 0) return results;
      try {
        const changed =
          targetDraftEditsStoreRef.current.applyExactMutationBatch(
            planned.map(({ mutation }) => mutation),
          );
        for (const { resultIndex } of planned) {
          results[resultIndex] = { kind: "success", changed };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logApplicationIssue(
          "error",
          "metadata-target-generated-stage",
          error,
          planned.map(({ mutation }) => mutation.path),
        );
        for (const { resultIndex } of planned) {
          results[resultIndex] = { kind: "failure", reason };
        }
      }
      logSlowFrontendOperation("draft-store-batch", startedAt, {
        files: planned.length,
      });
      return results;
    },
    [requireTargetDraftPersistenceReady, writableSchemaDefinitions],
  );

  const applyGeneratedMetadataDraftBatch = useCallback(
    (
      relativePath: string,
      producer: GeneratedMetadataProducer,
      edits: SchemaMetadataEdit[],
    ): GeneratedDraftStageResult =>
      applyGeneratedMetadataDraftBatches([
        { relativePath, producer, edits },
      ])[0] ?? { kind: "success", changed: false },
    [applyGeneratedMetadataDraftBatches],
  );

  const buildBulkMetadataDraftPlan = useCallback(
    (relativePaths: string[], request: BulkMetadataDraftRequest) => {
      const paths = [...new Set(relativePaths)];
      return planBulkMetadataDraftBatch({
        files: paths.map((relativePath) => ({
          relativePath,
          occurrences:
            fileMetadataOccurrencesStoreRef.current.get(relativePath),
          targetDrafts:
            targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
        })),
        request,
      });
    },
    [],
  );

  const previewBulkMetadataDraftBatch = useCallback(
    (
      relativePaths: string[],
      request: BulkMetadataDraftRequest,
    ):
      | { kind: "ready"; plan: BulkMetadataDraftPlan }
      | { kind: "blocked"; reason: string; relativePath?: string } => {
      const persistence = targetDraftPersistenceRef.current;
      if (persistence.status !== "ready") {
        return {
          kind: "blocked",
          reason:
            persistence.status === "load-failed"
              ? `${TARGET_DRAFT_LOAD_BLOCKED_MESSAGE} Load error: ${persistence.error}`
              : TARGET_DRAFT_LOAD_BLOCKED_MESSAGE,
          relativePath: relativePaths[0],
        };
      }
      try {
        return {
          kind: "ready",
          plan: buildBulkMetadataDraftPlan(relativePaths, request),
        };
      } catch (error) {
        return {
          kind: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          relativePath:
            error instanceof BulkMetadataDraftPlanError
              ? error.relativePath
              : relativePaths[0],
        };
      }
    },
    [buildBulkMetadataDraftPlan],
  );

  const stageBulkMetadataDraftBatch = useCallback(
    (relativePaths: string[], request: BulkMetadataDraftRequest): boolean => {
      const paths = [...new Set(relativePaths)];
      if (!requireTargetDraftPersistenceReady(paths)) return false;
      try {
        const plan = buildBulkMetadataDraftPlan(paths, request);
        targetDraftEditsStoreRef.current.applyExactMutationBatch(
          plan.mutations,
        );
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-bulk-stage", error, paths);
        return false;
      }
    },
    [
      buildBulkMetadataDraftPlan,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );

  const applyGpsTargetDraftBatch = useCallback(
    (relativePath: string, entries: MetadataTargetDraftEntry[]): boolean => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const validated = validateGpsTargetDraftEntries(
          entries,
          fileMetadataOccurrencesStoreRef.current.get(relativePath),
          targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
        );
        targetDraftEditsStoreRef.current.setMetadataBatch(
          relativePath,
          validated,
        );
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-gps-validate", error, [
          relativePath,
        ]);
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
      const plan = planMetadataRemovalTargets({
        schemaIds: uniqueIds,
        occurrences: fileMetadataOccurrencesStoreRef.current.get(relativePath),
        targetDrafts:
          targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
      });
      const upserts: MetadataTargetDraftEntry[] = plan.upserts.map(
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

  const removeMetadataTargets = useCallback(
    (relativePath: string, targets: MetadataDraftTarget[]): boolean => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const plan = planMetadataTargetRemovals({
          targets,
          occurrences:
            fileMetadataOccurrencesStoreRef.current.get(relativePath),
          targetDrafts:
            targetDraftEditsStoreRef.current.getMetadataFile(relativePath),
        });
        targetDraftEditsStoreRef.current.applyExactMutationBatch([
          {
            path: relativePath,
            upserts: plan.upserts.map(({ target, edit }) => ({
              target: structuredClone(target),
              edit: structuredClone(edit),
            })),
            deletes: plan.deletes.map((target) => structuredClone(target)),
          },
        ]);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove-exact", error, [
          relativePath,
        ]);
        return false;
      }
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const removeMetadataFields = useCallback(
    (relativePath: string, schemaIds: SchemaDefinitionId[]): boolean => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const mutation = removalMutation(relativePath, schemaIds);
        targetDraftEditsStoreRef.current.applyExactMutationBatch([mutation]);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove", error, [relativePath]);
        return false;
      }
    },
    [pushApplicationError, removalMutation, requireTargetDraftPersistenceReady],
  );

  const removeMetadataFieldFromFiles = useCallback(
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
        pushApplicationError("metadata-target-remove-files", error, paths);
        return false;
      }
    },
    [pushApplicationError, removalMutation, requireTargetDraftPersistenceReady],
  );

  const setExistingOccurrenceDraft = useCallback(
    (
      fileRelativePath: string,
      target: Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }>,
      edit: MetadataDraftEdit,
    ) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;

      const occurrenceState =
        fileMetadataOccurrencesStoreRef.current.get(fileRelativePath);
      if (!Array.isArray(occurrenceState)) {
        pushApplicationError(
          "metadata-target-occurrence-unavailable",
          "Authoritative metadata occurrences are still loading. Wait for the file to be scanned before editing this row.",
          [fileRelativePath],
        );
        return;
      }

      const exact = resolveExactMetadataOccurrence(
        occurrenceState,
        target.occurrence_id,
      );
      if (exact.kind !== "unique") {
        pushApplicationError(
          "metadata-target-occurrence-unavailable",
          exact.kind === "duplicate"
            ? "The exact metadata occurrence ID is duplicated, so no occurrence was selected."
            : "The exact metadata occurrence no longer exists, so no draft was created.",
          [fileRelativePath],
        );
        return;
      }

      const currentTarget = existingOccurrenceTargetFromOccurrence(
        exact.occurrence,
      );
      if (currentTarget.kind === "read-only") {
        pushApplicationError(
          "metadata-target-occurrence-read-only",
          currentTarget.reason,
          [fileRelativePath],
        );
        return;
      }
      if (!metadataDraftTargetEquals(currentTarget.target, target)) {
        pushApplicationError(
          "metadata-target-occurrence-unavailable",
          "The complete occurrence target changed after the editor opened, so no draft was created.",
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

  const setNewPropertyDraft = useCallback(
    async (
      fileRelativePath: string,
      target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
      edit: MetadataDraftEdit,
    ): Promise<boolean> => {
      const id = target.schema_id;
      const openedFolder = activeFolderRef.current;
      const openedLifecycleGeneration = scanLifecycleGenerationRef.current;
      const lifecycleIsCurrent = () =>
        activeFolderRef.current === openedFolder &&
        scanLifecycleGenerationRef.current === openedLifecycleGeneration;
      const targetSlot = metadataDraftTargetSlotToken(target);
      const openedEntry = structuredClone(
        targetDraftEditsStoreRef.current.getMetadataFile(fileRelativePath)?.[
          targetSlot
        ],
      );

      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return false;
      if (targetOutcomeExists(fileRelativePath, target)) {
        pushApplicationError(
          "metadata-target-new-property-edit-verification-pending",
          "Resolve the verification outcome for this destination before editing it. Nothing was saved.",
          [fileRelativePath],
        );
        return false;
      }

      const validateAuthoritativeStateAndOwnership = (): boolean => {
        if (openedEntry !== undefined) {
          const currentEntry =
            targetDraftEditsStoreRef.current.getMetadataFile(
              fileRelativePath,
            )?.[targetSlot];
          if (
            currentEntry === undefined ||
            !metadataTargetDraftEntryEqualsExact(currentEntry, openedEntry)
          ) {
            pushApplicationError(
              "metadata-target-new-property-edit-stale-target",
              "This New Property draft changed or disappeared while the editor was open. Nothing was saved.",
              [fileRelativePath],
            );
            return false;
          }
        }
        const occurrenceState =
          fileMetadataOccurrencesStoreRef.current.get(fileRelativePath);
        if (!Array.isArray(occurrenceState)) {
          pushApplicationError(
            "metadata-target-new-property-occurrences-loading",
            "Authoritative metadata occurrences are still loading. No new-property draft was staged.",
            [fileRelativePath],
          );
          return false;
        }
        const destinationSafety = classifyNewPropertyDestination({
          schemaId: id,
          writeTarget: target.write_target,
          occurrences: occurrenceState,
          pendingTargets: Object.values(
            targetDraftEditsStoreRef.current.getMetadataFile(
              fileRelativePath,
            ) ?? {},
          ).map((entry) => entry.target),
          ignoredPendingTarget: target,
        });
        if (destinationSafety.kind === "occupied") {
          pushApplicationError(
            "metadata-target-new-property-destination-occupied",
            "The complete ExifTool destination is already present in the file. No new-property draft was staged.",
            [fileRelativePath],
          );
          return false;
        }
        if (destinationSafety.kind === "unknown-same-schema") {
          pushApplicationError(
            "metadata-target-new-property-destination-unknown",
            "A same-schema occurrence has no safely identifiable destination, so another destination cannot be created safely.",
            [fileRelativePath],
          );
          return false;
        }

        if (destinationSafety.kind === "pending-collision") {
          pushApplicationError(
            "metadata-target-new-property-selector-collision",
            "Another pending draft already uses the intended complete selector. No new-property draft was staged.",
            [fileRelativePath],
          );
          return false;
        }

        return true;
      };

      if (!validateAuthoritativeStateAndOwnership()) return false;

      let info: TagInfo | null;
      try {
        info = (await apiRef.current.invoke("get_tag_info", {
          id,
        })) as TagInfo | null;
      } catch (error) {
        if (!lifecycleIsCurrent()) return false;
        const detail = error instanceof Error ? error.message : String(error);
        pushApplicationError(
          "metadata-target-new-property-schema-lookup",
          `The exact schema definition could not be resolved: ${detail}. No new-property draft was staged.`,
          [fileRelativePath],
        );
        return false;
      }

      if (!lifecycleIsCurrent()) return false;

      // The async schema lookup may race with mutable same-scan eligibility.
      // Recheck every independent condition immediately before staging.
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return false;
      if (targetOutcomeExists(fileRelativePath, target)) {
        pushApplicationError(
          "metadata-target-new-property-edit-verification-pending",
          "Resolve the verification outcome for this destination before editing it. Nothing was saved.",
          [fileRelativePath],
        );
        return false;
      }
      if (!validateAuthoritativeStateAndOwnership()) return false;

      if (!info || !schemaDefinitionIdEquals(info.id, id)) {
        pushApplicationError(
          "metadata-target-new-property-schema-missing",
          "The exact schema definition could not be resolved. No new-property draft was staged.",
          [fileRelativePath],
        );
        return false;
      }
      if (!info.writable) {
        pushApplicationError(
          "metadata-target-new-property-read-only",
          "This exact schema is read-only. No new-property draft was staged.",
          [fileRelativePath],
        );
        return false;
      }
      if (!tagInfoSupportsMetadataWrite(info, fileRelativePath, "Set")) {
        pushApplicationError(
          "metadata-target-new-property-unsupported-kind",
          "Binary and Unknown schema kinds are not supported by the metadata write pipeline. No new-property draft was staged.",
          [fileRelativePath],
        );
        return false;
      }

      const targetResolution = newPropertyDraftTarget(info);
      if (targetResolution.kind !== "available") {
        pushApplicationError(
          "metadata-target-new-property-ineligible",
          "This exact schema is not eligible for a NewProperty target. No draft was staged.",
          [fileRelativePath],
        );
        return false;
      }
      if (
        target.write_target.group7 !==
          targetResolution.target.write_target.group7 ||
        target.write_target.tag_name !==
          targetResolution.target.write_target.tag_name
      ) {
        pushApplicationError(
          "metadata-target-new-property-target-tampered",
          "The schema-controlled family-7 group or tag name changed. No draft was staged.",
          [fileRelativePath],
        );
        return false;
      }
      const family1Error = validateFamily1Group(target.write_target.group1);
      if (family1Error) {
        pushApplicationError(
          "metadata-target-new-property-invalid-destination",
          `${family1Error} No draft was staged.`,
          [fileRelativePath],
        );
        return false;
      }
      targetDraftEditsStoreRef.current.setMetadataTarget(
        fileRelativePath,
        structuredClone(target),
        edit,
      );
      return true;
    },
    [
      pushApplicationError,
      requireTargetDraftPersistenceReady,
      targetOutcomeExists,
    ],
  );

  const replaceNewPropertyDraftTarget = useCallback(
    async (
      fileRelativePath: string,
      originalTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
      replacementTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
      originalEdit: MetadataDraftEdit,
    ): Promise<boolean> => {
      const openedFolder = activeFolderRef.current;
      const openedLifecycleGeneration = scanLifecycleGenerationRef.current;
      const lifecycleIsCurrent = () =>
        activeFolderRef.current === openedFolder &&
        scanLifecycleGenerationRef.current === openedLifecycleGeneration;

      const validateCurrentState = (): boolean => {
        if (!requireTargetDraftPersistenceReady([fileRelativePath]))
          return false;
        if (
          !schemaDefinitionIdEquals(
            originalTarget.schema_id,
            replacementTarget.schema_id,
          )
        ) {
          logApplicationIssue(
            "error",
            "metadata-target-new-property-move-schema-changed",
            "Destination editing cannot change the draft's exact schema. Nothing was moved.",
            [fileRelativePath],
          );
          return false;
        }
        const originalSlot = metadataDraftTargetSlotToken(originalTarget);
        const persisted =
          targetDraftEditsStoreRef.current.getMetadataFile(fileRelativePath)?.[
            originalSlot
          ];
        if (
          persisted === undefined ||
          !metadataTargetDraftEntryEqualsExact(persisted, {
            target: originalTarget,
            edit: originalEdit,
          })
        ) {
          pushApplicationError(
            "metadata-target-new-property-move-stale-original",
            "The original destination draft changed or disappeared while it was being edited. Nothing was moved.",
            [fileRelativePath],
          );
          return false;
        }
        if (targetOutcomeExists(fileRelativePath, originalTarget)) {
          pushApplicationError(
            "metadata-target-new-property-move-verification-pending",
            "Resolve the verification outcome for this destination before editing it. Nothing was moved.",
            [fileRelativePath],
          );
          return false;
        }

        const occurrenceState =
          fileMetadataOccurrencesStoreRef.current.get(fileRelativePath);
        if (!Array.isArray(occurrenceState)) {
          pushApplicationError(
            "metadata-target-new-property-move-occurrences-loading",
            "Authoritative metadata occurrences are still loading. Nothing was moved.",
            [fileRelativePath],
          );
          return false;
        }
        const destinationSafety = classifyNewPropertyDestination({
          schemaId: replacementTarget.schema_id,
          writeTarget: replacementTarget.write_target,
          occurrences: occurrenceState,
          pendingTargets: Object.values(
            targetDraftEditsStoreRef.current.getMetadataFile(
              fileRelativePath,
            ) ?? {},
          ).map((entry) => entry.target),
          ignoredPendingTarget: originalTarget,
        });
        if (destinationSafety.kind === "occupied") {
          pushApplicationError(
            "metadata-target-new-property-move-destination-occupied",
            "The replacement ExifTool destination is already present in the file. Nothing was moved.",
            [fileRelativePath],
          );
          return false;
        }
        if (destinationSafety.kind === "unknown-same-schema") {
          pushApplicationError(
            "metadata-target-new-property-move-destination-unknown",
            "A same-schema occurrence has no safely identifiable destination, so the draft cannot be moved safely.",
            [fileRelativePath],
          );
          return false;
        }
        if (destinationSafety.kind === "pending-collision") {
          pushApplicationError(
            "metadata-target-new-property-move-selector-collision",
            "Another pending draft already uses the replacement selector. Nothing was moved.",
            [fileRelativePath],
          );
          return false;
        }
        return true;
      };

      if (!validateCurrentState()) return false;
      if (metadataDraftTargetEquals(originalTarget, replacementTarget)) {
        return true;
      }

      let info: TagInfo | null;
      try {
        info = (await apiRef.current.invoke("get_tag_info", {
          id: replacementTarget.schema_id,
        })) as TagInfo | null;
      } catch (error) {
        if (lifecycleIsCurrent()) {
          pushApplicationError(
            "metadata-target-new-property-move-schema-lookup",
            error,
            [fileRelativePath],
          );
        }
        return false;
      }
      if (!lifecycleIsCurrent() || !validateCurrentState()) return false;
      if (
        !info ||
        !schemaDefinitionIdEquals(info.id, replacementTarget.schema_id) ||
        !tagInfoSupportsMetadataWrite(info, fileRelativePath, "Set")
      ) {
        pushApplicationError(
          "metadata-target-new-property-move-schema-invalid",
          "The replacement schema is unavailable or not writable. Nothing was moved.",
          [fileRelativePath],
        );
        return false;
      }
      const expected = newPropertyDraftTarget(info);
      if (
        expected.kind !== "available" ||
        replacementTarget.write_target.group7 !==
          expected.target.write_target.group7 ||
        replacementTarget.write_target.tag_name !==
          expected.target.write_target.tag_name
      ) {
        pushApplicationError(
          "metadata-target-new-property-move-target-tampered",
          "The schema-controlled family-7 group or tag name changed. Nothing was moved.",
          [fileRelativePath],
        );
        return false;
      }
      const groupError = validateFamily1Group(
        replacementTarget.write_target.group1,
      );
      if (groupError) {
        pushApplicationError(
          "metadata-target-new-property-move-invalid-destination",
          `${groupError} Nothing was moved.`,
          [fileRelativePath],
        );
        return false;
      }

      try {
        targetDraftEditsStoreRef.current.applyExactMutationBatch([
          {
            path: fileRelativePath,
            deletes: [structuredClone(originalTarget)],
            upserts: [
              {
                target: structuredClone(replacementTarget),
                edit: structuredClone(originalEdit),
              },
            ],
          },
        ]);
        return true;
      } catch (error) {
        pushApplicationError(
          "metadata-target-new-property-move-failed",
          error,
          [fileRelativePath],
        );
        return false;
      }
    },
    [
      pushApplicationError,
      requireTargetDraftPersistenceReady,
      targetOutcomeExists,
    ],
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
        pushApplicationError("metadata-target-discard-targets", error, [
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
    (fileRelativePath?: string | string[]): Promise<MetadataApplyResult> => {
      const run = async (): Promise<MetadataApplyResult> => {
        const current = stateRef.current;
        if (current.kind !== "loaded") {
          return emptyMetadataApplyResult();
        }
        if (applyActiveRef.current) {
          throw new Error("A metadata apply operation is already running");
        }

        const applyAll = fileRelativePath === undefined;
        const requestedPaths = applyAll
          ? undefined
          : [
              ...new Set(
                Array.isArray(fileRelativePath)
                  ? fileRelativePath
                  : [fileRelativePath],
              ),
            ];
        if (!requireTargetDraftPersistenceReady(requestedPaths ?? [])) {
          throw new Error(TARGET_DRAFT_LOAD_BLOCKED_MESSAGE);
        }
        const targetPaths = requestedPaths?.filter(
          (path) => current.targetDraftEdits[path] !== undefined,
        );
        const targetCount = applyAll
          ? Object.keys(current.targetDraftEdits).length
          : (targetPaths?.length ?? 0);
        if (targetCount === 0) {
          return emptyMetadataApplyResult();
        }

        await targetDraftSaveQueueRef.current?.flush();
        const controller = targetApplyControllerRef.current;
        if (!controller) throw new Error("Target-aware apply is not ready");
        applyActiveRef.current = true;
        applyIssuesRef.current = [];
        setAppState((prev) =>
          prev.kind === "loaded" ? { ...prev, applyCompletion: null } : prev,
        );

        try {
          setAppState((prev) =>
            prev.kind === "loaded"
              ? {
                  ...prev,
                  applying: {
                    total: targetCount,
                    current: 0,
                    currentFile: null,
                    failureCount: 0,
                    cancelling: false,
                  },
                }
              : prev,
          );
          const result = await controller.run(current.folder, targetPaths);
          setAppState((prev) =>
            prev.kind === "loaded"
              ? {
                  ...prev,
                  applyCompletion: {
                    summary: result.commandResult.summary,
                    issues: [...applyIssuesRef.current],
                  },
                }
              : prev,
          );
          return result.commandResult;
        } catch (error) {
          pushApplicationError("metadata-apply", error, requestedPaths ?? []);
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
      void promise.then(
        () => {
          if (activeApplyPromiseRef.current === promise) {
            activeApplyPromiseRef.current = null;
          }
        },
        () => {
          if (activeApplyPromiseRef.current === promise) {
            activeApplyPromiseRef.current = null;
          }
        },
      );
      return promise;
    },
    [pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const dismissApplyCompletion = useCallback(() => {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, applyCompletion: null } : prev,
    );
  }, []);

  const cancelApplyEdits = useCallback(() => {
    void targetApplyControllerRef.current
      ?.cancel()
      .catch((error) => pushApplicationError("metadata-target-cancel", error));
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
      selectFile,
      showInExplorer,
      recycleFiles,
      openGallery,
      closeGallery,
      setVisibleColumns,
      setSortConfig,
      updateColumnWidth,
      resetColumnWidths,
      dismissError,
      canOpenBulkMetadataEditor,
      canStageGeneratedMetadata,
      applyGeneratedMetadataDraftBatch,
      applyGeneratedMetadataDraftBatches,
      previewBulkMetadataDraftBatch,
      stageBulkMetadataDraftBatch,
      removeMetadataTargets,
      removeMetadataFields,
      removeMetadataFieldFromFiles,
      applyGpsTargetDraftBatch,
      setExistingOccurrenceDraft,
      setNewPropertyDraft,
      replaceNewPropertyDraftTarget,
      discardTargetPropertyDraft,
      discardTargetDraftValues,
      discardAllDraftEdits,
      applyDraftEdits,
      cancelApplyEdits,
      dismissApplyCompletion,
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
      selectFile,
      showInExplorer,
      recycleFiles,
      openGallery,
      closeGallery,
      setVisibleColumns,
      setSortConfig,
      updateColumnWidth,
      resetColumnWidths,
      dismissError,
      canOpenBulkMetadataEditor,
      canStageGeneratedMetadata,
      applyGeneratedMetadataDraftBatch,
      applyGeneratedMetadataDraftBatches,
      previewBulkMetadataDraftBatch,
      stageBulkMetadataDraftBatch,
      removeMetadataTargets,
      removeMetadataFields,
      removeMetadataFieldFromFiles,
      applyGpsTargetDraftBatch,
      setExistingOccurrenceDraft,
      setNewPropertyDraft,
      replaceNewPropertyDraftTarget,
      discardTargetPropertyDraft,
      discardTargetDraftValues,
      discardAllDraftEdits,
      applyDraftEdits,
      cancelApplyEdits,
      dismissApplyCompletion,
      acceptTargetVerifyOutcome,
      keepTargetDraftAndDismissOutcome,
      discardTargetDraftAndOutcome,
      dismissAllTargetVerifyOutcomes,
    ],
  );

  return [{ ...appState, recentFolders }, mediaLibraryActions];
}
