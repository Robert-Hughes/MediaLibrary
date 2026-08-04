import { useCallback, useMemo, useRef, type RefObject } from "react";
import type {
  AppState,
  FileMetadataOccurrencesStore,
  MetadataApplyResult,
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataRemovalPreview,
  MetadataTargetDraftEntry,
  SchemaDefinitionId,
  SchemaMetadataEdit,
  TagInfo,
  TargetDraftPersistenceState,
} from "../types";
import type { TauriApi } from "../useMediaLibrary";
import type { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  BulkMetadataDraftPlan,
  BulkMetadataDraftRequest,
} from "../bulkMetadataDrafts";
import { emptyMetadataApplyResult } from "../applyProjection";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
} from "../utils/metadataDraftTarget";
import { resolveExactMetadataOccurrence } from "../utils/metadataOccurrences";

const TARGET_DRAFT_LOAD_BLOCKED_MESSAGE =
  "Target-aware drafts could not be loaded safely. Fix the folder's target-aware draft persistence file, then reopen the folder.";

interface UseMetadataSessionActionsOptions {
  api: TauriApi;
  appState: AppState;
  appStateRef: RefObject<AppState>;
  stateRef: RefObject<AppState>;
  activeScanIdRef: RefObject<number>;
  targetDraftPersistenceRef: RefObject<TargetDraftPersistenceState>;
  fileMetadataOccurrencesStoreRef: RefObject<FileMetadataOccurrencesStore>;
  targetDraftEditsStoreRef: RefObject<TargetDraftEditsStore>;
  writableSchemaDefinitions: "loading" | TagInfo[];
  pushApplicationError: (
    errorType: string,
    error: unknown,
    affectedFiles?: string[],
  ) => void;
}

export function useMetadataSessionActions({
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
}: UseMetadataSessionActionsOptions) {
  // Caller-owned refs are stable for this hook's lifetime; keeping them behind
  // one local ref also lets callbacks observe the latest supplied stores.
  const contextRef = useRef({
    appStateRef,
    stateRef,
    activeScanIdRef,
    targetDraftPersistenceRef,
    fileMetadataOccurrencesStoreRef,
    targetDraftEditsStoreRef,
  });
  contextRef.current = {
    appStateRef,
    stateRef,
    activeScanIdRef,
    targetDraftPersistenceRef,
    fileMetadataOccurrencesStoreRef,
    targetDraftEditsStoreRef,
  };

  const requireTargetDraftPersistenceReady = useCallback(
    (affectedFiles: string[] = []): boolean => {
      const persistence = contextRef.current.targetDraftPersistenceRef.current;
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
  const resolveTargetVerifyOutcome = useCallback(
    async (
      relativePath: string,
      currentTarget: MetadataDraftTarget,
      discardDraft: boolean,
    ): Promise<void> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return;
      try {
        await api.invoke("resolve_media_library_session_verification_outcome", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath,
          currentTarget: structuredClone(currentTarget),
          discardDraft,
        });
      } catch (error) {
        pushApplicationError("metadata-target-verification-resolve", error, [
          relativePath,
        ]);
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
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
        sessionId: contextRef.current.activeScanIdRef.current,
      })
      .catch((error) =>
        pushApplicationError("metadata-target-verification-dismiss", error),
      );
  }, [api, pushApplicationError]);

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
            contextRef.current.fileMetadataOccurrencesStoreRef.current.get(
              relativePath,
            ),
          ),
      );
      if (unavailable !== undefined) {
        const state =
          contextRef.current.fileMetadataOccurrencesStoreRef.current.get(
            unavailable,
          );
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
      const persistence = contextRef.current.targetDraftPersistenceRef.current;
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
            sessionId: contextRef.current.activeScanIdRef.current,
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
        await api.invoke("stage_media_library_session_bulk_drafts", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePaths: paths,
          request,
        });
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-bulk-stage", error, paths);
        return false;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const previewGpsTargetDraftBatch = useCallback(
    async (
      relativePath: string,
      edits: SchemaMetadataEdit[],
    ): Promise<MetadataTargetDraftEntry[] | null> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return null;
      try {
        return (await api.invoke("preview_media_library_session_gps_drafts", {
          sessionId: contextRef.current.activeScanIdRef.current,
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
        await api.invoke("stage_media_library_session_gps_drafts", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath,
          edits,
        });
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-gps-validate", error, [
          relativePath,
        ]);
        return false;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const removeMetadataTargets = useCallback(
    async (
      relativePath: string,
      targets: MetadataDraftTarget[],
    ): Promise<boolean> => {
      if (!requireTargetDraftPersistenceReady([relativePath])) return false;
      try {
        await api.invoke("remove_media_library_session_metadata_targets", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath,
          targets,
        });
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove-exact", error, [
          relativePath,
        ]);
        return false;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
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
            sessionId: contextRef.current.activeScanIdRef.current,
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
        await api.invoke("remove_media_library_session_metadata_fields", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath,
          schemaIds,
        });
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove", error, [relativePath]);
        return false;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );
  const removeMetadataFieldFromFiles = useCallback(
    async (
      schemaId: SchemaDefinitionId,
      relativePaths: string[],
    ): Promise<boolean> => {
      const paths = [...new Set(relativePaths)];
      if (!requireTargetDraftPersistenceReady(paths)) return false;
      try {
        await api.invoke(
          "remove_media_library_session_metadata_field_from_files",
          {
            sessionId: contextRef.current.activeScanIdRef.current,
            schemaId,
            relativePaths: paths,
          },
        );
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-remove-files", error, paths);
        return false;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );
  const setExistingOccurrenceDraft = useCallback(
    (
      fileRelativePath: string,
      target: Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }>,
      edit: MetadataDraftEdit,
    ) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;

      const occurrenceState =
        contextRef.current.fileMetadataOccurrencesStoreRef.current.get(
          fileRelativePath,
        );
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
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath: fileRelativePath,
          target,
          edit,
        })
        .catch((error) =>
          pushApplicationError("metadata-target-save", error, [
            fileRelativePath,
          ]),
        );
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );

  const setNewPropertyDraft = useCallback(
    async (
      fileRelativePath: string,
      target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
      edit: MetadataDraftEdit,
    ): Promise<boolean> => {
      try {
        await api.invoke("set_media_library_session_draft", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath: fileRelativePath,
          target,
          edit,
        });
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-new-property-save", error, [
          fileRelativePath,
        ]);
        return false;
      }
    },
    [api, pushApplicationError],
  );

  const replaceNewPropertyDraftTarget = useCallback(
    async (
      fileRelativePath: string,
      originalTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
      replacementTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
      originalEdit: MetadataDraftEdit,
    ): Promise<boolean> => {
      try {
        await api.invoke("replace_media_library_session_new_property_draft", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath: fileRelativePath,
          originalTarget,
          replacementTarget,
          originalEdit,
        });
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
    [api, pushApplicationError],
  );

  const discardTargetPropertyDraft = useCallback(
    (fileRelativePath: string, target: MetadataDraftTarget) => {
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return;
      const slot = metadataDraftTargetSlotToken(target);
      const persisted =
        contextRef.current.targetDraftEditsStoreRef.current.getMetadataFile(
          fileRelativePath,
        )?.[slot];
      if (
        persisted === undefined ||
        !metadataDraftTargetEquals(persisted.target, target)
      ) {
        return;
      }
      void api
        .invoke("discard_media_library_session_draft", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath: fileRelativePath,
          target,
        })
        .catch((error) =>
          pushApplicationError("metadata-target-discard", error, [
            fileRelativePath,
          ]),
        );
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );
  const discardTargetDraftValues = useCallback(
    async (
      fileRelativePath: string,
      targets: MetadataDraftTarget[],
    ): Promise<boolean> => {
      if (targets.length === 0) return true;
      if (!requireTargetDraftPersistenceReady([fileRelativePath])) return false;
      try {
        await api.invoke("discard_media_library_session_drafts", {
          sessionId: contextRef.current.activeScanIdRef.current,
          relativePath: fileRelativePath,
          targets,
        });
        return true;
      } catch (error) {
        pushApplicationError("metadata-target-discard-targets", error, [
          fileRelativePath,
        ]);
        return false;
      }
    },
    [api, pushApplicationError, requireTargetDraftPersistenceReady],
  );
  const discardAllDraftEdits = useCallback(
    (fileRelativePath?: string | string[]) => {
      const paths =
        fileRelativePath === undefined
          ? Object.keys(
              contextRef.current.targetDraftEditsStoreRef.current.getAllMetadata(),
            )
          : Array.isArray(fileRelativePath)
            ? fileRelativePath
            : [fileRelativePath];
      const sessionId = contextRef.current.activeScanIdRef.current;
      if (sessionId < 0 || paths.length === 0) return;
      void (async () => {
        try {
          for (const relativePath of paths) {
            const targets = Object.values(
              contextRef.current.targetDraftEditsStoreRef.current.getMetadataFile(
                relativePath,
              ) ?? {},
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
      const current = contextRef.current.stateRef.current;
      if (current.kind !== "loaded") return emptyMetadataApplyResult();

      const requestedPaths: string[] | undefined =
        fileRelativePath === undefined
          ? undefined
          : Array.isArray(fileRelativePath)
            ? fileRelativePath
            : [fileRelativePath];
      try {
        return (await api.invoke("apply_metadata_draft_edits_cmd", {
          sessionId: current.sessionId,
          relPaths: requestedPaths ?? null,
        })) as MetadataApplyResult;
      } catch (error) {
        pushApplicationError("metadata-apply", error, requestedPaths ?? []);
        throw error;
      }
    },
    [api, pushApplicationError],
  );
  const dismissApplyCompletion = useCallback(() => {
    const current = contextRef.current.appStateRef.current;
    if (current.kind !== "loaded" || !current.applyCompletion) return;
    void api
      .invoke("dismiss_media_library_session_apply_operation", {
        sessionId: current.sessionId,
        operationId: current.applyCompletion.operationId,
      })
      .catch((error) =>
        pushApplicationError("metadata-target-dismiss-apply", error),
      );
  }, [api, pushApplicationError]);

  const cancelApplyEdits = useCallback(() => {
    const current = contextRef.current.appStateRef.current;
    if (current.kind !== "loaded" || !current.applying) return;
    void api
      .invoke("cancel_apply_edits", {
        sessionId: current.sessionId,
        operationId: current.applying.operationId,
      })
      .catch((error) => pushApplicationError("metadata-target-cancel", error));
  }, [api, pushApplicationError]);

  return useMemo(
    () => ({
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
}
