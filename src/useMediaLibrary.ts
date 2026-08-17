import { recycleBinName } from "./utils/platform";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThumbnailStore,
  FileMetadataOccurrencesStore,
  MetadataProgressStore,
} from "./types";
import type {
  AppState,
  ApplicationErrorPayload,
  FileInfo,
  SortConfig,
  VisibleColumn,
  MetadataApplyResult,
  MetadataDraftEdit,
  SchemaDefinitionId,
  SchemaMetadataEdit,
  TargetDraftPersistenceState,
  MetadataTargetDraftEntry,
  MetadataRemovalPreview,
  RecycleFilesResult,
  MediaLibrarySessionSnapshot,
  MediaLibrarySessionFilesAdded,
  MediaLibrarySessionThumbnailsChanged,
  MediaLibrarySessionMetadataChanged,
  MediaLibrarySessionIssueAdded,
  MediaLibrarySessionRevisionAdvanced,
  MediaLibrarySessionBatchOperationChanged,
  MediaLibrarySessionApplyOperationChanged,
  MediaLibrarySessionVerificationOutcomesChanged,
  MediaLibrarySessionDraftsChanged,
  MediaLibrarySessionDraftPersistenceChanged,
  MediaLibrarySessionDiscoveryChanged,
  MediaLibrarySessionFilesRemoved,
  MediaLibrarySessionIssueRemoved,
} from "./types";
import type { MetadataApplyStreamMessage } from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";
import { useRecentFolders } from "./hooks/useRecentFolders";
import { useWritableSchemaDefinitions } from "./hooks/useWritableSchemaDefinitions";
import { useMetadataSessionActions } from "./hooks/useMetadataSessionActions";
import {
  targetDraftsFromWire,
  TargetDraftEditsStore,
} from "./targetDraftEdits";
import type { MetadataDraftTarget } from "./types";
import { TargetVerifyOutcomesStore } from "./targetVerifyOutcomesStore";
import { targetVerifyOutcomesFromBackend } from "./targetVerifyOutcomes";
import { currentValueForMetadataDraftTarget } from "./utils/metadataDraftTarget";
import type {
  BulkMetadataDraftPlan,
  BulkMetadataDraftRequest,
} from "./bulkMetadataDrafts";
import { projectApplyOperation } from "./applyProjection";
import { mergeSessionIssues } from "./sessionIssueProjection";
import { projectSessionMetadata } from "./sessionMetadataProjection";
import { projectSessionThumbnails } from "./sessionThumbnailProjection";
import { normalizeMetadataOccurrences } from "./utils/scanEvents";
import { createSessionDeltaCoordinator } from "./sessionDeltaCoordinator";

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

const TARGET_DRAFT_NOT_LOADED_STATE: TargetDraftPersistenceState = {
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
  previewBulkMetadataDraftBatch: (
    relativePaths: string[],
    request: BulkMetadataDraftRequest,
  ) => Promise<
    | { kind: "ready"; plan: BulkMetadataDraftPlan }
    | { kind: "blocked"; reason: string; relativePath?: string }
  >;
  stageBulkMetadataDraftBatch: (
    relativePaths: string[],
    request: BulkMetadataDraftRequest,
  ) => Promise<boolean>;
  removeMetadataTargets: (
    relativePath: string,
    targets: MetadataDraftTarget[],
  ) => Promise<boolean>;
  previewMetadataTargetRemovals: (
    relativePath: string,
    targets: MetadataDraftTarget[],
  ) => Promise<MetadataRemovalPreview | null>;
  removeMetadataFields: (
    relativePath: string,
    schemaIds: SchemaDefinitionId[],
  ) => Promise<boolean>;
  removeMetadataFieldFromFiles: (
    schemaId: SchemaDefinitionId,
    relativePaths: string[],
  ) => Promise<boolean>;
  applyGpsTargetDraftBatch: (
    relativePath: string,
    edits: SchemaMetadataEdit[],
  ) => Promise<boolean>;
  previewGpsTargetDraftBatch: (
    relativePath: string,
    edits: SchemaMetadataEdit[],
  ) => Promise<MetadataTargetDraftEntry[] | null>;
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
  ) => Promise<boolean>;
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
  const appStateRef = useRef<AppState>(appState);
  appStateRef.current = appState;
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
  const activeApplyOperationIdRef = useRef<string | null>(null);
  const sessionFilePathsRef = useRef<Set<string>>(new Set());
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
  const apiRef = useRef(api);
  apiRef.current = api;
  const activeFolderRef = useRef<string | null>(null);
  const targetDraftPersistenceRef = useRef<TargetDraftPersistenceState>(
    TARGET_DRAFT_NOT_LOADED_STATE,
  );

  const loadedStateFromProjection = useCallback(
    (
      sessionId: number,
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
        sessionId,
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
        applicationErrors: [],
        targetDraftEdits: targetDraftEditsStoreRef.current.getAllMetadata(),
        targetDraftEditsStore: targetDraftEditsStoreRef.current,
        targetDraftPersistence: targetDraftPersistenceRef.current,
        applying: null,
        targetVerifyOutcomes: targetVerifyOutcomesStoreRef.current.getAll(),
        batchOperations: {},
      };
    },
    [],
  );
  const applySessionSnapshot = useCallback(
    (snapshot: MediaLibrarySessionSnapshot): void | Promise<void> => {
      if (snapshot.lifecycle === "idle" && snapshot.revision === 0) return;
      if (snapshot.revision <= sessionRevisionRef.current) return;
      if (
        snapshot.lifecycle !== "idle" &&
        (snapshot.session_id === null || snapshot.folder === null)
      ) {
        throw new Error(
          `Invalid ${snapshot.lifecycle} media-library snapshot: missing session identity`,
        );
      }
      const previousRevision = sessionRevisionRef.current;
      sessionRevisionRef.current = snapshot.revision;
      activeApplyOperationIdRef.current =
        snapshot.apply_operation?.operation_id ?? null;
      if (snapshot.lifecycle === "idle") {
        const hadActiveSession =
          activeScanIdRef.current !== -1 || activeFolderRef.current !== null;
        sessionFilePathsRef.current.clear();
        thumbnailStoreRef.current.reset([]);
        fileMetadataOccurrencesStoreRef.current.clear();
        metadataProgressStoreRef.current.reset();
        targetDraftEditsStoreRef.current.resetMetadata({});
        targetVerifyOutcomesStoreRef.current.clear();
        targetDraftPersistenceRef.current = TARGET_DRAFT_NOT_LOADED_STATE;
        seenSessionIssueIdsRef.current.clear();
        activeApplyOperationIdRef.current = null;
        activeScanIdRef.current = -1;
        activeFolderRef.current = null;
        if (hadActiveSession) setAppState({ kind: "idle" });
        return;
      }
      const sessionId = snapshot.session_id!;
      const folder = snapshot.folder!;
      const previousSessionId = activeScanIdRef.current;
      const isRecovery = previousSessionId === -1;
      if (previousSessionId !== sessionId) {
        seenSessionIssueIdsRef.current.clear();
      }
      activeScanIdRef.current = sessionId;
      activeFolderRef.current = folder;
      const projectedDrafts = targetDraftsFromWire(
        snapshot.drafts as Record<string, MetadataTargetDraftEntry[]>,
      );
      if (isRecovery || previousSessionId !== sessionId) {
        targetDraftEditsStoreRef.current.resetMetadata(projectedDrafts);
      } else {
        const paths = new Set([
          ...Object.keys(targetDraftEditsStoreRef.current.getAllMetadata()),
          ...Object.keys(projectedDrafts),
        ]);
        targetDraftEditsStoreRef.current.replaceMetadataFiles(
          [...paths].map((path) => ({
            path,
            persistedEntries: Object.values(projectedDrafts[path] ?? {}),
          })),
        );
      }
      const verificationOutcomes = snapshot.verification_outcomes ?? {};
      const verificationPaths = new Set([
        ...Object.keys(targetVerifyOutcomesStoreRef.current.getAll()),
        ...Object.keys(verificationOutcomes),
      ]);
      targetVerifyOutcomesStoreRef.current.replaceFiles(
        [...verificationPaths].map((path) => ({
          path,
          outcomes: targetVerifyOutcomesFromBackend(
            path,
            verificationOutcomes[path] ?? [],
          ),
        })),
      );
      targetDraftPersistenceRef.current = snapshot.draft_persistence;
      if (snapshot.lifecycle === "opening") {
        if (isRecovery) {
          const { visibleColumns, sortConfig, columnWidths } =
            loadColumnConfig();
          setAppState({
            kind: "loading",
            folder: folder,
            visibleColumns,
            columnWidths,
            sortConfig,
          });
        }
        return;
      }
      if (snapshot.lifecycle === "loaded" || snapshot.lifecycle === "failed") {
        const nextFilePaths = new Set(
          snapshot.files.map((file) => file.relative_path),
        );
        const removedPaths = [...sessionFilePathsRef.current].filter(
          (path) => !nextFilePaths.has(path),
        );
        if (removedPaths.length > 0) {
          for (const path of removedPaths) {
            const metadataState =
              fileMetadataOccurrencesStoreRef.current.get(path);
            metadataProgressStoreRef.current.removeFile(
              metadataState !== "loading",
            );
          }
          thumbnailStoreRef.current.deletePaths(removedPaths);
          fileMetadataOccurrencesStoreRef.current.deletePaths(removedPaths);
        }
        sessionFilePathsRef.current = nextFilePaths;
        const rebuildMetadataProjection =
          isRecovery || snapshot.revision > previousRevision + 1;
        if (rebuildMetadataProjection) {
          console.info(
            `[session-revision] kind=metadata-projection-rebuild reason=${isRecovery ? "session-recovery" : "snapshot-jump"} session_id=${sessionId} previous_revision=${previousRevision} snapshot_revision=${snapshot.revision} files=${snapshot.files.length} metadata_entries=${snapshot.metadata.length}`,
          );
        }
        projectSessionMetadata(snapshot.metadata, rebuildMetadataProjection, {
          occurrences: fileMetadataOccurrencesStoreRef.current,
          progress: metadataProgressStoreRef.current,
        });
        metadataProgressStoreRef.current.setTotal(snapshot.files.length);
        let thumbnailProjection: Promise<void> | undefined;
        if (rebuildMetadataProjection) {
          thumbnailProjection = projectSessionThumbnails(
            sessionId,
            snapshot.thumbnails,
            {
              store: thumbnailStoreRef.current,
              invoke: api.invoke,
              isCurrentSession: (sessionId) =>
                activeScanIdRef.current === sessionId &&
                sessionRevisionRef.current === snapshot.revision,
            },
          );
        }
        for (const issue of snapshot.issues) {
          if (seenSessionIssueIdsRef.current.has(issue.issue_id)) continue;
          seenSessionIssueIdsRef.current.add(issue.issue_id);
          console.error(
            `Worker error (${issue.error_type}):`,
            issue.error_message,
          );
        }
        setAppState((previous) => {
          const canApplyStatusOnly =
            previous.kind === "loaded" &&
            previous.sessionId === sessionId &&
            !isRecovery &&
            snapshot.revision === previousRevision + 1;
          if (canApplyStatusOnly && previous.kind === "loaded") {
            const projectedApply = projectApplyOperation(
              snapshot.apply_operation,
            );
            return {
              ...previous,
              scanning: snapshot.discovery_running,
              targetDraftPersistence: targetDraftPersistenceRef.current,
              batchOperations: snapshot.batch_operations ?? {},
              applying: projectedApply.applying,
              applyCompletion: projectedApply.completion,
              applicationErrors: mergeSessionIssues(
                previous.applicationErrors,
                sessionId!,
                snapshot.issues,
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
            sessionId!,
            folder!,
            snapshot.files,
            snapshot.discovery_running,
            presentation,
          );
          next.batchOperations = snapshot.batch_operations ?? {};
          if (previous.kind === "loaded") {
            next.selectedPath = previous.selectedPath;
            next.metadataVersion = previous.metadataVersion;
          }
          next.applicationErrors = mergeSessionIssues(
            previous.kind === "loaded"
              ? previous.applicationErrors
              : next.applicationErrors,
            sessionId,
            snapshot.issues,
          );
          const projectedApply = projectApplyOperation(
            snapshot.apply_operation,
          );
          next.applying = projectedApply.applying;
          next.applyCompletion = projectedApply.completion;
          return next;
        });
        return thumbnailProjection;
      }
    },
    [api, loadedStateFromProjection],
  );

  const pushApplicationIssue = useCallback(
    (
      severity: ApplicationErrorPayload["severity"],
      errorType: string,
      error: unknown,
      affectedFiles: string[] = [],
    ) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const sessionId = activeScanIdRef.current;
      if (sessionId < 0) {
        logApplicationIssue(severity, errorType, error, affectedFiles);
        return;
      }
      void apiRef.current
        .invoke("record_media_library_session_issue", {
          sessionId,
          severity,
          errorType,
          errorMessage,
          affectedFiles,
        })
        .then((raw) => {
          const delta = raw as MediaLibrarySessionIssueAdded;
          seenSessionIssueIdsRef.current.add(delta.issue.issue_id);
        })
        .catch((invokeError) => {
          logApplicationIssue(severity, errorType, error, affectedFiles);
          console.error("Failed to record application issue", invokeError);
        });
    },
    [],
  );

  const pushApplicationError = useCallback(
    (errorType: string, error: unknown, affectedFiles: string[] = []) =>
      pushApplicationIssue("error", errorType, error, affectedFiles),
    [pushApplicationIssue],
  );

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

  const startScan = useCallback(
    async (folder: string) => {
      // Invalidate work from the previous folder/scan before any asynchronous
      // shutdown or setup step can yield.
      scanLifecycleGenerationRef.current += 1;
      // Wait for event listeners to be registered before starting the scan so
      // Wait for session listeners before opening so no authoritative deltas
      // can arrive before the projection is ready.
      await listenersReadyRef.current;
      const session = (await api.invoke("open_media_library_session", {
        folderPath: folder,
      })) as MediaLibrarySessionSnapshot;
      if (session.session_id === null || session.folder !== folder) {
        throw new Error("Rust opened an invalid media-library session");
      }
      await applySessionSnapshot(session);
      if (session.lifecycle === "failed") return;
      if (session.lifecycle !== "opening") {
        throw new Error("Rust returned an invalid session lifecycle");
      }
      const scanId = session.session_id;
      console.debug(`[startScan] folder=${folder} sessionId=${scanId}`);
      api
        .invoke("set_window_title", { title: `Media Library — ${folder}` })
        .catch(() => {});

      await api.invoke("start_scan", { scanId, folderPath: folder });
      pushRecentFolder(folder);
    },
    [api, applySessionSnapshot, pushRecentFolder],
  );

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    const deltaCoordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => activeScanIdRef.current,
      getCurrentRevision: () => sessionRevisionRef.current,
      setCurrentRevision: (revision) => {
        sessionRevisionRef.current = revision;
      },
      refreshSnapshot: async () => {
        const snapshot = (await api.invoke(
          "get_media_library_session_snapshot",
        )) as MediaLibrarySessionSnapshot;
        if (!cancelled) await applySessionSnapshot(snapshot);
      },
      isCancelled: () => cancelled,
      onError: (error) => pushApplicationError("session-delta", error),
      onDiagnostic: (diagnostic) => {
        const recovered =
          diagnostic.recoveredRevision === undefined
            ? ""
            : ` recovered_revision=${diagnostic.recoveredRevision}`;
        console.info(
          `[session-revision] kind=${diagnostic.kind} source=${diagnostic.source} session_id=${diagnostic.sessionId} current_revision=${diagnostic.currentRevision} expected_revision=${diagnostic.expectedRevision} received_revision=${diagnostic.receivedRevision}${recovered} queued_items=${diagnostic.queuedItems}`,
        );
      },
    });

    let rejectListenersReady: (error: unknown) => void = () => {};
    const setup = async () => {
      // Create a new pending latch for this setup cycle; startScan awaits it.
      let resolve!: () => void;
      listenersReadyRef.current = new Promise<void>((r, j) => {
        resolve = r;
        rejectListenersReady = j;
      });

      const unlistenSession = await api.listen(
        "media_library_session_changed",
        (raw) => {
          void deltaCoordinator.enqueueSnapshot(
            (raw as MediaLibrarySessionSnapshot).revision,
            () => applySessionSnapshot(raw as MediaLibrarySessionSnapshot),
            "media_library_session_changed",
          );
        },
      );

      const unlistenApplyProgress = await api.listen(
        "media_library_session_apply_progress",
        (raw) => {
          const message = raw as MetadataApplyStreamMessage;
          if (message.kind === "complete") return;
          let metadataChanged = false;
          if (message.kind === "progress_batch") {
            metadataChanged =
              fileMetadataOccurrencesStoreRef.current.setMany(
                message.results.flatMap((result) =>
                  result.fresh_file_metadata === null
                    ? []
                    : [
                        {
                          path: result.relative_path,
                          value: normalizeMetadataOccurrences(
                            result.fresh_file_metadata.occurrences,
                          ),
                        },
                      ],
                ),
              ).length > 0;
            targetDraftEditsStoreRef.current.replaceMetadataFiles(
              message.results.flatMap((result) =>
                result.persisted_draft_entries === null
                  ? []
                  : [
                      {
                        path: result.relative_path,
                        persistedEntries: result.persisted_draft_entries,
                      },
                    ],
              ),
            );
            targetVerifyOutcomesStoreRef.current.replaceFiles(
              message.results.map((result) => ({
                path: result.relative_path,
                outcomes: targetVerifyOutcomesFromBackend(
                  result.relative_path,
                  result.target_outcomes,
                ),
              })),
            );
          }
          setAppState((previous) => {
            if (previous.kind !== "loaded" || previous.applying === null) {
              return previous;
            }
            if (previous.applying.operationId !== message.operation_id) {
              return previous;
            }
            if (message.kind === "started") {
              return {
                ...previous,
                applying: {
                  ...previous.applying,
                  total: message.total,
                },
              };
            }
            const latest = message.results[message.results.length - 1];
            return {
              ...previous,
              metadataVersion:
                metadataChanged && previous.sortConfig.primary?.kind === "image"
                  ? previous.metadataVersion + 1
                  : previous.metadataVersion,
              applying: {
                ...previous.applying,
                current: message.current,
                total: message.total,
                currentFile:
                  latest?.relative_path ?? previous.applying.currentFile,
                failureCount:
                  previous.applying.failureCount +
                  message.results.filter((result) => result.error !== null)
                    .length,
              },
            };
          });
        },
      );

      const unlistenFound = await api.listen(
        "media_library_session_files_added",
        (raw) => {
          const { session_id, revision, files } =
            raw as MediaLibrarySessionFilesAdded;
          void deltaCoordinator.enqueue({
            sessionId: session_id,
            revision,
            source: "media_library_session_files_added",
            apply: () => {
              console.debug(`[session-files] received ${files.length} files`);
              for (const file of files) {
                sessionFilePathsRef.current.add(file.relative_path);
                thumbnailStoreRef.current.add(file.relative_path);
                fileMetadataOccurrencesStoreRef.current.add(file.relative_path);
              }
              setAppState((previous) => {
                if (previous.kind === "idle" || files.length === 0)
                  return previous;
                if (previous.kind === "loading") {
                  return loadedStateFromProjection(
                    session_id,
                    previous.folder,
                    files,
                    true,
                    {
                      visibleColumns: previous.visibleColumns,
                      columnWidths: previous.columnWidths,
                      sortConfig: previous.sortConfig,
                    },
                  );
                }
                const nextFiles = [...previous.files, ...files];
                metadataProgressStoreRef.current.setTotal(nextFiles.length);
                return { ...previous, files: nextFiles };
              });
            },
          });
        },
      );

      const unlistenMetadata = await api.listen(
        "media_library_session_metadata_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionMetadataChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_metadata_changed",
            apply: () => {
              const acceptedReady = projectSessionMetadata(
                delta.entries,
                false,
                {
                  occurrences: fileMetadataOccurrencesStoreRef.current,
                  progress: metadataProgressStoreRef.current,
                },
              );
              if (acceptedReady > 0) {
                setAppState((previous) => {
                  if (
                    previous.kind !== "loaded" ||
                    !previous.sortConfig.primary ||
                    previous.sortConfig.primary.kind !== "image"
                  )
                    return previous;
                  return {
                    ...previous,
                    metadataVersion: previous.metadataVersion + 1,
                  };
                });
              }
            },
          });
        },
      );

      const unlistenIssueAdded = await api.listen(
        "media_library_session_issue_added",
        (raw) => {
          const delta = raw as MediaLibrarySessionIssueAdded;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_issue_added",
            apply: () => {
              if (delta.metadata.length > 0) {
                projectSessionMetadata(delta.metadata, false, {
                  occurrences: fileMetadataOccurrencesStoreRef.current,
                  progress: metadataProgressStoreRef.current,
                });
              }
              setAppState((previous) => {
                if (previous.kind !== "loaded") return previous;
                return {
                  ...previous,
                  applicationErrors: mergeSessionIssues(
                    previous.applicationErrors,
                    delta.session_id,
                    [delta.issue],
                  ),
                };
              });
            },
          });
        },
      );

      const unlistenThumbnail = await api.listen(
        "media_library_session_thumbnails_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionThumbnailsChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_thumbnails_changed",
            apply: () =>
              projectSessionThumbnails(delta.session_id, delta.entries, {
                store: thumbnailStoreRef.current,
                invoke: api.invoke,
                isCurrentSession: (sessionId) =>
                  activeScanIdRef.current === sessionId,
              }),
          });
        },
      );

      const unlistenRevisionAdvanced = await api.listen(
        "media_library_session_revision_advanced",
        (raw) => {
          const { session_id, revision } =
            raw as MediaLibrarySessionRevisionAdvanced;
          void deltaCoordinator.enqueue({
            sessionId: session_id,
            revision,
            source: "media_library_session_revision_advanced",
            apply: () => {},
          });
        },
      );

      const unlistenBatchOperation = await api.listen(
        "media_library_session_batch_operation_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionBatchOperationChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_batch_operation_changed",
            apply: () => {
              setAppState((previous) => {
                if (previous.kind !== "loaded") return previous;
                const batchOperations = { ...previous.batchOperations };
                if (delta.operation === null) {
                  delete batchOperations[delta.kind];
                } else {
                  batchOperations[delta.kind] = delta.operation;
                }
                return { ...previous, batchOperations };
              });
            },
          });
        },
      );

      const unlistenApplyOperation = await api.listen(
        "media_library_session_apply_operation_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionApplyOperationChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_apply_operation_changed",
            apply: () => {
              activeApplyOperationIdRef.current =
                delta.operation?.operation_id ?? null;
              setAppState((previous) => {
                if (previous.kind !== "loaded") return previous;
                const projected = projectApplyOperation(delta.operation);
                return {
                  ...previous,
                  applying: projected.applying,
                  applyCompletion: projected.completion,
                };
              });
            },
          });
        },
      );

      const unlistenVerificationOutcomes = await api.listen(
        "media_library_session_verification_outcomes_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionVerificationOutcomesChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_verification_outcomes_changed",
            apply: () => {
              const paths = new Set([
                ...Object.keys(targetVerifyOutcomesStoreRef.current.getAll()),
                ...Object.keys(delta.outcomes),
              ]);
              targetVerifyOutcomesStoreRef.current.replaceFiles(
                [...paths].map((path) => ({
                  path,
                  outcomes: targetVerifyOutcomesFromBackend(
                    path,
                    delta.outcomes[path] ?? [],
                  ),
                })),
              );
              const draftRows = Object.entries(delta.draft_rows);
              if (draftRows.length > 0) {
                targetDraftEditsStoreRef.current.replaceMetadataFiles(
                  draftRows.map(([path, persistedEntries]) => ({
                    path,
                    persistedEntries: persistedEntries ?? [],
                  })),
                );
              }
              setAppState((previous) =>
                previous.kind === "loaded"
                  ? {
                      ...previous,
                      targetVerifyOutcomes:
                        targetVerifyOutcomesStoreRef.current.getAll(),
                      targetDraftEdits:
                        targetDraftEditsStoreRef.current.getAllMetadata(),
                    }
                  : previous,
              );
            },
          });
        },
      );

      const unlistenDrafts = await api.listen(
        "media_library_session_drafts_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionDraftsChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_drafts_changed",
            apply: () => {
              targetDraftEditsStoreRef.current.replaceMetadataFiles(
                Object.entries(delta.rows).map(([path, persistedEntries]) => ({
                  path,
                  persistedEntries: persistedEntries ?? [],
                })),
              );
              setAppState((previous) =>
                previous.kind === "loaded"
                  ? {
                      ...previous,
                      targetDraftEdits:
                        targetDraftEditsStoreRef.current.getAllMetadata(),
                    }
                  : previous,
              );
            },
          });
        },
      );

      const unlistenDraftPersistence = await api.listen(
        "media_library_session_draft_persistence_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionDraftPersistenceChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_draft_persistence_changed",
            apply: () => {
              targetDraftPersistenceRef.current = delta.state;
              setAppState((previous) =>
                previous.kind === "loaded"
                  ? { ...previous, targetDraftPersistence: delta.state }
                  : previous,
              );
            },
          });
        },
      );

      const unlistenDiscovery = await api.listen(
        "media_library_session_discovery_changed",
        (raw) => {
          const delta = raw as MediaLibrarySessionDiscoveryChanged;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_discovery_changed",
            apply: () => {
              setAppState((previous) =>
                previous.kind === "loaded"
                  ? { ...previous, scanning: delta.discovery_running }
                  : previous,
              );
            },
          });
        },
      );

      const unlistenFilesRemoved = await api.listen(
        "media_library_session_files_removed",
        (raw) => {
          const delta = raw as MediaLibrarySessionFilesRemoved;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_files_removed",
            apply: () => {
              for (const path of delta.paths) {
                const metadataState =
                  fileMetadataOccurrencesStoreRef.current.get(path);
                metadataProgressStoreRef.current.removeFile(
                  metadataState !== "loading",
                );
              }
              thumbnailStoreRef.current.deletePaths(delta.paths);
              fileMetadataOccurrencesStoreRef.current.deletePaths(delta.paths);
              targetDraftEditsStoreRef.current.replaceMetadataFiles(
                delta.paths.map((path) => ({ path, persistedEntries: [] })),
              );
              targetVerifyOutcomesStoreRef.current.replaceFiles(
                delta.paths.map((path) => ({ path, outcomes: [] })),
              );
              const removedSet = new Set(delta.paths);
              for (const path of delta.paths) {
                sessionFilePathsRef.current.delete(path);
              }
              setAppState((previous) =>
                previous.kind === "loaded"
                  ? {
                      ...previous,
                      files: previous.files.filter(
                        (file) => !removedSet.has(file.relative_path),
                      ),
                      targetDraftEdits:
                        targetDraftEditsStoreRef.current.getAllMetadata(),
                      targetVerifyOutcomes:
                        targetVerifyOutcomesStoreRef.current.getAll(),
                    }
                  : previous,
              );
            },
          });
        },
      );

      const unlistenIssueRemoved = await api.listen(
        "media_library_session_issue_removed",
        (raw) => {
          const delta = raw as MediaLibrarySessionIssueRemoved;
          void deltaCoordinator.enqueue({
            sessionId: delta.session_id,
            revision: delta.revision,
            source: "media_library_session_issue_removed",
            apply: () => {
              setAppState((previous) =>
                previous.kind === "loaded"
                  ? {
                      ...previous,
                      applicationErrors: previous.applicationErrors.filter(
                        (error) => error.issue_id !== delta.issue_id,
                      ),
                    }
                  : previous,
              );
            },
          });
        },
      );

      unlisteners.push(
        unlistenSession,
        unlistenApplyProgress,
        unlistenFound,
        unlistenMetadata,
        unlistenIssueAdded,
        unlistenThumbnail,
        unlistenRevisionAdvanced,
        unlistenBatchOperation,
        unlistenApplyOperation,
        unlistenVerificationOutcomes,
        unlistenDrafts,
        unlistenDraftPersistence,
        unlistenDiscovery,
        unlistenFilesRemoved,
        unlistenIssueRemoved,
      );

      // All listeners registered — unblock any startScan that was awaiting.
      const initialSession = (await api.invoke(
        "get_media_library_session_snapshot",
      )) as MediaLibrarySessionSnapshot;
      if (!cancelled) {
        await deltaCoordinator.enqueueSnapshot(
          initialSession.revision,
          () => applySessionSnapshot(initialSession),
          "initial_snapshot",
        );
      }

      console.debug("[setup] all listeners registered");
      resolve();
    };

    void setup().catch((error) => {
      for (const unlisten of unlisteners.splice(0)) unlisten();
      rejectListenersReady(error);
      pushApplicationError("session-listener-setup", error);
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [
    api,
    applySessionSnapshot,
    loadedStateFromProjection,
    pushApplicationError,
  ]);

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
    const sessionId = activeScanIdRef.current;
    if (sessionId < 0) return;
    api
      .invoke("close_media_library_session", { sessionId })
      .then((snapshot) => {
        void applySessionSnapshot(snapshot as MediaLibrarySessionSnapshot);
        api
          .invoke("set_window_title", { title: "Media Library" })
          .catch(() => {});
      })
      .catch((error) => {
        if (activeScanIdRef.current === sessionId) {
          pushApplicationError("session-close", error);
        } else {
          console.error("Discarded stale session-close failure", error);
        }
      });
  }, [api, applySessionSnapshot, pushApplicationError]);

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

      console.log(`[recycleFiles] requesting ${requested.length} file(s)`);
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
        setAppState((prev) => {
          if (prev.kind !== "loaded" || prev.folder !== current.folder) {
            return prev;
          }
          const filesChanged = prev.files.some((file) =>
            successfulSet.has(file.relative_path),
          );
          const selectionChanged =
            prev.selectedPath !== null && successfulSet.has(prev.selectedPath);
          const galleryChanged =
            prev.galleryPath !== null && successfulSet.has(prev.galleryPath);
          if (!filesChanged && !selectionChanged && !galleryChanged)
            return prev;
          return {
            ...prev,
            files: filesChanged
              ? prev.files.filter(
                  (file) => !successfulSet.has(file.relative_path),
                )
              : prev.files,
            selectedPath: selectionChanged ? null : prev.selectedPath,
            galleryPath: galleryChanged ? null : prev.galleryPath,
          };
        });
      }

      const failures = result.results.filter((item) => !item.recycled);
      if (successful.length > 0) {
        console.log(
          `[recycleFiles] removed ${successful.length} file(s) from UI state: ${successful.join(", ")}`,
        );
      }
      if (failures.length > 0) {
        console.warn(
          `[recycleFiles] ${failures.length} file(s) failed to recycle: ${failures
            .map(
              (item) =>
                `${item.relative_path}: ${item.error ?? "Unknown error"}`,
            )
            .join("; ")}`,
        );
        pushApplicationError(
          "recycle-files",
          `${failures.length} ${failures.length === 1 ? "file" : "files"} could not be moved to the ${recycleBinName()}:\n${failures
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

  // Rust session snapshots own persistence. The frontend store subscription
  // only projects authoritative draft changes into React and dependent stores.
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
    });
  }, []);
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

  const metadataActions = useMetadataSessionActions({
    api,
    appState,
    appStateRef,
    stateRef,
    activeScanIdRef,
    targetDraftPersistenceRef,
    fileMetadataOccurrencesStoreRef,
    targetDraftEditsStoreRef,
    writableSchemaDefinitions,
    pushApplicationError,
  });

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
      ...metadataActions,
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
      metadataActions,
    ],
  );

  return [{ ...appState, recentFolders }, mediaLibraryActions];
}
