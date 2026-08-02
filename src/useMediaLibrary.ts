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
  TagInfo,
  RecycleFilesResult,
  MediaLibrarySessionSnapshot,
  MediaLibrarySessionFilesAdded,
  MediaLibrarySessionThumbnailsChanged,
  MediaLibrarySessionMetadataChanged,
} from "./types";
import { loadColumnConfig, saveColumnConfig } from "./utils/columnConfig";
import { useRecentFolders } from "./hooks/useRecentFolders";
import { useWritableSchemaDefinitions } from "./hooks/useWritableSchemaDefinitions";
import {
  metadataTargetDraftEntryEqualsExact,
  targetDraftsFromWire,
  TargetDraftEditsStore,
} from "./targetDraftEdits";
import { runTargetApplyCommand } from "./targetApplyCommand";
import { cancelTargetApply } from "./targetApplyTauri";
import type { MetadataDraftTarget } from "./types";
import { schemaDefinitionIdEquals } from "./utils/schemaDefinitionId";
import { TargetVerifyOutcomesStore } from "./targetVerifyOutcomesStore";
import { targetVerifyOutcomesFromBackend } from "./targetVerifyOutcomes";
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
import type {
  BulkMetadataDraftPlan,
  BulkMetadataDraftRequest,
} from "./bulkMetadataDrafts";
import {
  emptyMetadataApplyResult,
  projectApplyOperation,
} from "./applyProjection";
import { mergeSessionIssues } from "./sessionIssueProjection";
import { projectSessionMetadata } from "./sessionMetadataProjection";
import { projectSessionThumbnails } from "./sessionThumbnailProjection";

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
  const sessionFilePathsRef = useRef<Set<string>>(new Set());
  const seenSessionIssueIdsRef = useRef<Set<number>>(new Set());
  const locallyLoggedIssueKeysRef = useRef<Set<string>>(new Set());
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
    (snapshot: MediaLibrarySessionSnapshot) => {
      if (snapshot.lifecycle === "idle" && snapshot.revision === 0) return;
      if (snapshot.revision <= sessionRevisionRef.current) return;
      const previousRevision = sessionRevisionRef.current;
      sessionRevisionRef.current = snapshot.revision;
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
        locallyLoggedIssueKeysRef.current.clear();
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
      const projectedDrafts = targetDraftsFromWire(
        snapshot.drafts as Record<string, MetadataTargetDraftEntry[]>,
      );
      if (isRecovery || previousSessionId !== snapshot.session_id) {
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
            folder: snapshot.folder,
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
        projectSessionMetadata(snapshot.metadata, rebuildMetadataProjection, {
          occurrences: fileMetadataOccurrencesStoreRef.current,
          progress: metadataProgressStoreRef.current,
        });
        metadataProgressStoreRef.current.setTotal(snapshot.files.length);
        if (rebuildMetadataProjection) {
          void projectSessionThumbnails(
            snapshot.session_id,
            snapshot.thumbnails,
            {
              store: thumbnailStoreRef.current,
              invoke: api.invoke,
              isCurrentSession: (sessionId) =>
                activeScanIdRef.current === sessionId,
            },
          );
        }
        for (const issue of snapshot.issues) {
          if (seenSessionIssueIdsRef.current.has(issue.issue_id)) continue;
          seenSessionIssueIdsRef.current.add(issue.issue_id);
          const issueKey = JSON.stringify([
            issue.error_type,
            issue.error_message,
            issue.affected_files,
          ]);
          if (locallyLoggedIssueKeysRef.current.delete(issueKey)) continue;
          console.error(
            `Worker error (${issue.error_type}):`,
            issue.error_message,
          );
        }
        setAppState((previous) => {
          const canApplyStatusOnly =
            previous.kind === "loaded" &&
            previous.sessionId === snapshot.session_id &&
            !isRecovery &&
            snapshot.revision === previousRevision + 1;
          if (canApplyStatusOnly && previous.kind === "loaded") {
            return {
              ...previous,
              scanning: snapshot.discovery_running,
              targetDraftPersistence: targetDraftPersistenceRef.current,
              batchOperations: snapshot.batch_operations ?? {},
              applying: projectApplyOperation(snapshot.apply_operation)
                .applying,
              applyCompletion: projectApplyOperation(snapshot.apply_operation)
                .completion,
              applicationErrors: mergeSessionIssues(
                previous.applicationErrors,
                snapshot.session_id!,
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
            snapshot.session_id!,
            snapshot.folder!,
            snapshot.files,
            snapshot.discovery_running,
            presentation,
          );
          next.batchOperations = snapshot.batch_operations ?? {};
          if (previous.kind === "loaded") {
            next.selectedPath = previous.selectedPath;
            next.metadataVersion = previous.metadataVersion;
            next.selectedPath = previous.selectedPath;
            next.applicationErrors = mergeSessionIssues(
              previous.applicationErrors,
              snapshot.session_id!,
              snapshot.issues,
            );
            const projectedApply = projectApplyOperation(
              snapshot.apply_operation,
            );
            next.applying = projectedApply.applying;
            next.applyCompletion = projectedApply.completion;
          } else {
            next.applicationErrors = mergeSessionIssues(
              next.applicationErrors,
              snapshot.session_id!,
              snapshot.issues,
            );
            const projectedApply = projectApplyOperation(
              snapshot.apply_operation,
            );
            next.applying = projectedApply.applying;
            next.applyCompletion = projectedApply.completion;
          }
          return next;
        });
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
      const errorMessage = logApplicationIssue(
        severity,
        errorType,
        error,
        affectedFiles,
      );
      const sessionId = activeScanIdRef.current;
      if (sessionId < 0) return;
      locallyLoggedIssueKeysRef.current.add(
        JSON.stringify([errorType, errorMessage, affectedFiles]),
      );
      void apiRef.current
        .invoke("record_media_library_session_issue", {
          sessionId,
          severity,
          errorType,
          errorMessage,
          affectedFiles,
        })
        .catch((invokeError) =>
          console.error("Failed to record application issue", invokeError),
        );
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
      applySessionSnapshot(session);
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
        async (raw) => {
          if (cancelled) return;
          const { session_id, revision, files } =
            raw as MediaLibrarySessionFilesAdded;
          if (session_id !== activeScanIdRef.current) return;
          if (revision <= sessionRevisionRef.current) return;
          if (revision !== sessionRevisionRef.current + 1) {
            const snapshot = (await api.invoke(
              "get_media_library_session_snapshot",
            )) as MediaLibrarySessionSnapshot;
            if (!cancelled) applySessionSnapshot(snapshot);
            return;
          }
          sessionRevisionRef.current = revision;
          console.debug(`[session-files] received ${files.length} files`);

          for (const file of files) {
            sessionFilePathsRef.current.add(file.relative_path);
            thumbnailStoreRef.current.add(file.relative_path);
            fileMetadataOccurrencesStoreRef.current.add(file.relative_path);
          }

          setAppState((previous) => {
            if (previous.kind === "idle" || files.length === 0) return previous;
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
      );

      const unlistenMetadata = await api.listen(
        "media_library_session_metadata_changed",
        async (raw) => {
          const delta = raw as MediaLibrarySessionMetadataChanged;
          if (delta.session_id !== activeScanIdRef.current) return;
          if (delta.revision <= sessionRevisionRef.current) return;
          if (delta.revision !== sessionRevisionRef.current + 1) {
            const snapshot = (await api.invoke(
              "get_media_library_session_snapshot",
            )) as MediaLibrarySessionSnapshot;
            if (!cancelled) applySessionSnapshot(snapshot);
            return;
          }
          sessionRevisionRef.current = delta.revision;
          const acceptedReady = projectSessionMetadata(delta.entries, false, {
            occurrences: fileMetadataOccurrencesStoreRef.current,
            progress: metadataProgressStoreRef.current,
          });
          if (acceptedReady > 0) {
            setAppState((previous) => {
              if (
                previous.kind !== "loaded" ||
                !previous.sortConfig.primary ||
                previous.sortConfig.primary.kind !== "image"
              ) {
                return previous;
              }
              return {
                ...previous,
                metadataVersion: previous.metadataVersion + 1,
              };
            });
          }
        },
      );

      const unlistenThumbnail = await api.listen(
        "media_library_session_thumbnails_changed",
        async (raw) => {
          if (cancelled) return;
          const delta = raw as MediaLibrarySessionThumbnailsChanged;
          if (delta.session_id !== activeScanIdRef.current) return;
          if (delta.revision <= sessionRevisionRef.current) return;
          if (delta.revision !== sessionRevisionRef.current + 1) {
            const snapshot = (await api.invoke(
              "get_media_library_session_snapshot",
            )) as MediaLibrarySessionSnapshot;
            if (!cancelled) applySessionSnapshot(snapshot);
            return;
          }
          sessionRevisionRef.current = delta.revision;
          await projectSessionThumbnails(delta.session_id, delta.entries, {
            store: thumbnailStoreRef.current,
            invoke: api.invoke,
            isCurrentSession: (sessionId) =>
              activeScanIdRef.current === sessionId,
          });
        },
      );

      unlisteners.push(
        unlistenSession,
        unlistenFound,
        unlistenMetadata,
        unlistenThumbnail,
      );

      // All listeners registered — unblock any startScan that was awaiting.
      const initialSession = (await api.invoke(
        "get_media_library_session_snapshot",
      )) as MediaLibrarySessionSnapshot;
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
    const sessionId = activeScanIdRef.current;
    if (sessionId < 0) return;
    api
      .invoke("close_media_library_session", { sessionId })
      .then((snapshot) => {
        applySessionSnapshot(snapshot as MediaLibrarySessionSnapshot);
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

  const requireTargetDraftPersistenceReady = useCallback(
    (affectedFiles: string[] = []): boolean => {
      const persistence = targetDraftPersistenceRef.current;
      if (persistence.status === "ready") return true;
      pushApplicationError(
        "metadata-target-unavailable",
        `${TARGET_DRAFT_LOAD_BLOCKED_MESSAGE}${"error" in persistence ? ` Load error: ${persistence.error}` : ""}`,
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

  const resolveTargetVerifyOutcome = useCallback(
    async (
      relativePath: string,
      currentTarget: MetadataDraftTarget,
      discardDraft: boolean,
    ): Promise<void> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return;
      try {
        const snapshot = (await api.invoke(
          "resolve_media_library_session_verification_outcome",
          {
            sessionId: activeScanIdRef.current,
            relativePath,
            currentTarget: structuredClone(currentTarget),
            discardDraft,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
      } catch (error) {
        pushApplicationError("metadata-target-verification-resolve", error, [
          relativePath,
        ]);
      }
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );

  const acceptTargetVerifyOutcome = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget) => {
      void resolveTargetVerifyOutcome(relativePath, currentTarget, true);
    },
    [resolveTargetVerifyOutcome],
  );

  const keepTargetDraftAndDismissOutcome = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget) => {
      void resolveTargetVerifyOutcome(relativePath, currentTarget, false);
    },
    [resolveTargetVerifyOutcome],
  );

  const discardTargetDraftAndOutcome = useCallback(
    (relativePath: string, currentTarget: MetadataDraftTarget) => {
      void resolveTargetVerifyOutcome(relativePath, currentTarget, true);
    },
    [resolveTargetVerifyOutcome],
  );

  const dismissAllTargetVerifyOutcomes = useCallback(() => {
    void api
      .invoke("dismiss_media_library_session_verification_outcomes", {
        sessionId: activeScanIdRef.current,
      })
      .then((snapshot) =>
        applySessionSnapshot(snapshot as MediaLibrarySessionSnapshot),
      )
      .catch((error) =>
        pushApplicationError("metadata-target-verification-dismiss", error),
      );
  }, [api, applySessionSnapshot, pushApplicationError]);

  const dismissError = useCallback(
    (index: number) => {
      const current =
        appState.kind === "loaded" ? appState.applicationErrors[index] : null;
      if (current?.issue_id != null) {
        void api.invoke("dismiss_media_library_session_issue", {
          issueId: current.issue_id,
        });
      }
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
  const previewBulkMetadataDraftBatch = useCallback(
    async (
      relativePaths: string[],
      request: BulkMetadataDraftRequest,
    ): Promise<
      | { kind: "ready"; plan: BulkMetadataDraftPlan }
      | { kind: "blocked"; reason: string; relativePath?: string }
    > => {
      const paths = [...new Set(relativePaths)];
      const persistence = targetDraftPersistenceRef.current;
      if (persistence.status !== "ready") {
        return {
          kind: "blocked",
          reason:
            persistence.status === "load-failed"
              ? `${TARGET_DRAFT_LOAD_BLOCKED_MESSAGE}${"error" in persistence ? ` Load error: ${persistence.error}` : ""}`
              : TARGET_DRAFT_LOAD_BLOCKED_MESSAGE,
          relativePath: paths[0],
        };
      }
      try {
        const plan = (await api.invoke(
          "preview_media_library_session_bulk_drafts",
          {
            sessionId: activeScanIdRef.current,
            relativePaths: paths,
            request,
          },
        )) as BulkMetadataDraftPlan;
        return { kind: "ready", plan };
      } catch (error) {
        return {
          kind: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          relativePath: paths[0],
        };
      }
    },
    [api],
  );

  const stageBulkMetadataDraftBatch = useCallback(
    async (
      relativePaths: string[],
      request: BulkMetadataDraftRequest,
    ): Promise<boolean> => {
      const paths = [...new Set(relativePaths)];
      if (!requireTargetDraftPersistenceReady(paths)) return false;
      try {
        const snapshot = (await api.invoke(
          "stage_media_library_session_bulk_drafts",
          {
            sessionId: activeScanIdRef.current,
            relativePaths: paths,
            request,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-bulk-stage", error, paths);
        return false;
      }
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );

  const previewGpsTargetDraftBatch = useCallback(
    async (
      relativePath: string,
      edits: SchemaMetadataEdit[],
    ): Promise<MetadataTargetDraftEntry[] | null> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return null;
      try {
        return (await api.invoke("preview_media_library_session_gps_drafts", {
          sessionId: activeScanIdRef.current,
          relativePath,
          edits,
        })) as MetadataTargetDraftEntry[];
      } catch (error) {
        pushApplicationError("metadata-target-gps-preview", error, [
          relativePath,
        ]);
        return null;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const applyGpsTargetDraftBatch = useCallback(
    async (
      relativePath: string,
      edits: SchemaMetadataEdit[],
    ): Promise<boolean> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const snapshot = (await api.invoke(
          "stage_media_library_session_gps_drafts",
          {
            sessionId: activeScanIdRef.current,
            relativePath,
            edits,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-gps-validate", error, [
          relativePath,
        ]);
        return false;
      }
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );

  const removeMetadataTargets = useCallback(
    async (
      relativePath: string,
      targets: MetadataDraftTarget[],
    ): Promise<boolean> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const snapshot = (await api.invoke(
          "remove_media_library_session_metadata_targets",
          {
            sessionId: activeScanIdRef.current,
            relativePath,
            targets,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove-exact", error, [
          relativePath,
        ]);
        return false;
      }
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );

  const previewMetadataTargetRemovals = useCallback(
    async (
      relativePath: string,
      targets: MetadataDraftTarget[],
    ): Promise<MetadataRemovalPreview | null> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return null;
      try {
        return (await api.invoke(
          "preview_media_library_session_metadata_target_removals",
          {
            sessionId: activeScanIdRef.current,
            relativePath,
            targets,
          },
        )) as MetadataRemovalPreview;
      } catch (error) {
        pushApplicationError("metadata-target-remove-preview", error, [
          relativePath,
        ]);
        return null;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const removeMetadataFields = useCallback(
    async (
      relativePath: string,
      schemaIds: SchemaDefinitionId[],
    ): Promise<boolean> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        const snapshot = (await api.invoke(
          "remove_media_library_session_metadata_fields",
          {
            sessionId: activeScanIdRef.current,
            relativePath,
            schemaIds,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove", error, [relativePath]);
        return false;
      }
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );
  const removeMetadataFieldFromFiles = useCallback(
    async (
      schemaId: SchemaDefinitionId,
      relativePaths: string[],
    ): Promise<boolean> => {
      const paths = [...new Set(relativePaths)];
      if (!requireTargetDraftPersistenceReady(paths)) return false;
      try {
        const snapshot = (await api.invoke(
          "remove_media_library_session_metadata_field_from_files",
          {
            sessionId: activeScanIdRef.current,
            schemaId,
            relativePaths: paths,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove-files", error, paths);
        return false;
      }
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
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
      void api
        .invoke("set_media_library_session_draft", {
          sessionId: activeScanIdRef.current,
          relativePath: fileRelativePath,
          target,
          edit,
        })
        .then((snapshot) =>
          applySessionSnapshot(snapshot as MediaLibrarySessionSnapshot),
        )
        .catch((error) =>
          pushApplicationError("metadata-target-save", error, [
            fileRelativePath,
          ]),
        );
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
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
      try {
        await api.invoke("set_media_library_session_draft", {
          sessionId: activeScanIdRef.current,
          relativePath: fileRelativePath,
          target: structuredClone(target),
          edit: structuredClone(edit),
        });
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-new-property-save", error, [
          fileRelativePath,
        ]);
        return false;
      }
    },
    [
      api,
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
        const snapshot = (await api.invoke(
          "replace_media_library_session_new_property_draft",
          {
            sessionId: activeScanIdRef.current,
            relativePath: fileRelativePath,
            originalTarget,
            replacementTarget,
            originalEdit,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
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
      api,
      applySessionSnapshot,
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
      void api
        .invoke("discard_media_library_session_draft", {
          sessionId: activeScanIdRef.current,
          relativePath: fileRelativePath,
          target,
        })
        .then((snapshot) =>
          applySessionSnapshot(snapshot as MediaLibrarySessionSnapshot),
        )
        .catch((error) =>
          pushApplicationError("metadata-target-discard", error, [
            fileRelativePath,
          ]),
        );
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );
  const discardTargetDraftValues = useCallback(
    async (
      fileRelativePath: string,
      targets: MetadataDraftTarget[],
    ): Promise<boolean> => {
      if (targets.length === 0) return true;
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return false;
      try {
        const snapshot = (await api.invoke(
          "discard_media_library_session_drafts",
          {
            sessionId: activeScanIdRef.current,
            relativePath: fileRelativePath,
            targets,
          },
        )) as MediaLibrarySessionSnapshot;
        applySessionSnapshot(snapshot);
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-discard-targets", error, [
          fileRelativePath,
        ]);
        return false;
      }
    },
    [
      api,
      applySessionSnapshot,
      pushApplicationError,
      requireTargetDraftPersistenceReady,
    ],
  );
  const discardAllDraftEdits = useCallback(
    (fileRelativePath?: string | string[]) => {
      const paths =
        fileRelativePath === undefined
          ? Object.keys(targetDraftEditsStoreRef.current.getAllMetadata())
          : Array.isArray(fileRelativePath)
            ? fileRelativePath
            : [fileRelativePath];
      const sessionId = activeScanIdRef.current;
      if (sessionId < 0 || paths.length === 0) return;
      void (async () => {
        try {
          for (const relativePath of paths) {
            const targets = Object.values(
              targetDraftEditsStoreRef.current.getMetadataFile(relativePath) ??
                {},
            ).map((entry) => entry.target);
            if (targets.length === 0) continue;
            await api.invoke("discard_media_library_session_drafts", {
              sessionId,
              relativePath,
              targets,
            });
          }
        } catch (error) {
          pushApplicationError("metadata-target-discard-all", error, paths);
        }
      })();
    },
    [api, pushApplicationError],
  );
  const applyDraftEdits = useCallback(
    async (
      fileRelativePath?: string | string[],
    ): Promise<MetadataApplyResult> => {
      const current = stateRef.current;
      if (current.kind !== "loaded") return emptyMetadataApplyResult();

      const requestedPaths: string[] | undefined =
        fileRelativePath === undefined
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
      const targetCount =
        requestedPaths === undefined
          ? Object.keys(current.targetDraftEdits).length
          : (targetPaths?.length ?? 0);
      if (targetCount === 0) return emptyMetadataApplyResult();

      setAppState((previous) =>
        previous.kind === "loaded"
          ? { ...previous, applyCompletion: null }
          : previous,
      );
      try {
        return await runTargetApplyCommand(
          api,
          current.sessionId,
          current.folder,
          targetPaths,
          {
            onProtocolError: (error) =>
              pushApplicationError("metadata-target-protocol", error),
            onMessageError: (error) =>
              pushApplicationError("metadata-target-progress", error),
          },
        );
      } catch (error) {
        pushApplicationError("metadata-apply", error, requestedPaths ?? []);
        throw error;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );
  const dismissApplyCompletion = useCallback(() => {
    const current = appStateRef.current;
    if (current.kind !== "loaded" || !current.applyCompletion) return;
    void api
      .invoke("dismiss_media_library_session_apply_operation", {
        sessionId: current.sessionId,
        operationId: current.applyCompletion.operationId,
      })
      .then((snapshot) =>
        applySessionSnapshot(snapshot as MediaLibrarySessionSnapshot),
      )
      .catch((error) =>
        pushApplicationError("metadata-target-dismiss-apply", error),
      );
  }, [api, applySessionSnapshot, pushApplicationError]);

  const cancelApplyEdits = useCallback(() => {
    const current = appStateRef.current;
    if (current.kind !== "loaded" || !current.applying) return;
    void cancelTargetApply(
      api,
      current.sessionId,
      current.applying.operationId,
    ).catch((error) => pushApplicationError("metadata-target-cancel", error));
  }, [api, pushApplicationError]);

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
      previewBulkMetadataDraftBatch,
      stageBulkMetadataDraftBatch,
      removeMetadataTargets,
      previewMetadataTargetRemovals,
      removeMetadataFields,
      removeMetadataFieldFromFiles,
      applyGpsTargetDraftBatch,
      previewGpsTargetDraftBatch,
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
      previewBulkMetadataDraftBatch,
      stageBulkMetadataDraftBatch,
      removeMetadataTargets,
      previewMetadataTargetRemovals,
      removeMetadataFields,
      removeMetadataFieldFromFiles,
      applyGpsTargetDraftBatch,
      previewGpsTargetDraftBatch,
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
