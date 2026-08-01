import type { TauriApi } from "../useMediaLibrary";
import type {
  FileInfo,
  ScanErrorPayload,
  MetadataOccurrences,
  MetadataValue,
  MetadataTargetDraftEntry,
  MetadataDraftTarget,
  MetadataDraftEdit,
  SchemaMetadataEdit,
  MetadataApplyFileResult,
  MetadataApplySummary,
  TagInfo,
  MediaLibrarySessionSnapshot,
} from "../types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  targetDraftsToWire,
  type TargetDraftEditsByFile,
} from "../targetDraftEdits";
import { testId } from "./testIds";
type EventHandler = (payload: unknown) => void;

type MockTargetDraftEditsByFolder = Record<string, TargetDraftEditsByFile>;

export interface MockApplyEditsProgressGate {
  advance: () => void;
  waitForNextStep: () => Promise<void>;
}

export function createApplyEditsProgressGate(): MockApplyEditsProgressGate {
  let permits = 0;
  const waiters: Array<() => void> = [];

  return {
    advance: () => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter();
      } else {
        permits += 1;
      }
    },
    waitForNextStep: async () => {
      if (permits > 0) {
        permits -= 1;
        return;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

export interface MockTauriApi {
  api: TauriApi;
  pickFolderResolves: (path: string | null) => void;
  setSessionSnapshot: (snapshot: MediaLibrarySessionSnapshot) => void;
  setThumbnailPayload: (cacheKey: string, thumbnail: string) => void;
  // Models the sole target-aware draft persistence file.
  targetDraftEditsByFolder: MockTargetDraftEditsByFolder;
  draftLoadFailuresByFolder: Record<string, string>;
  emitFileFound: (file: FileInfo, scanId?: number) => void;
  foundPaths: Set<string>;
  emitScanComplete: (scanId?: number) => void;
  emitFileMetadataReady: (
    relativePath: string,
    metadata: Record<string, MetadataValue>,
    scanId?: number,
    occurrences?: MetadataOccurrences,
  ) => void;
  emitFileMetadataBatch: (
    items: Array<{
      relativePath: string;
      metadata: Record<string, MetadataValue>;
      occurrences?: MetadataOccurrences;
    }>,
    scanId?: number,
  ) => void;
  emitThumbnailReady: (
    relativePath: string,
    thumbnail: string | null,
    scanId?: number,
  ) => void;
  emitScanError: (message: string, scanId?: number) => void;
  emitWorkerError: (
    workerType: string,
    errorMessage: string,
    affectedFiles?: string[],
    scanId?: number,
  ) => void;
  invalidateMetadataOccurrences: (relativePath: string) => void;
  lastPrioritizedPaths: string[];
  lastWindowTitle: string | null;
  lastRecycleArgs: { folder: string; relativePaths: string[] } | null;
  recycleFailuresByPath: Record<string, string>;
  /** All invoke calls recorded in order. */
  invocations: Array<{ cmd: string; args?: Record<string, unknown> }>;
  /** The scan_id returned by the most recent start_scan call. */
  currentScanId: number;
  /** Optional manual gate: after each progress event, apply waits for advance(). */
  applyEditsProgressGate: MockApplyEditsProgressGate | null;
  /** Progress events emitted by the apply-edits mock. */
  applyProgressEvents: Array<{
    current: number;
    total: number;
    relative_path: string;
  }>;
  cancelTargetApplyCalled: boolean;
  /** Optional per-file target-aware progress result overrides. */
  targetApplyProgressResultsByPath: Record<string, MetadataApplyFileResult>;
  /** Optional per-file target-aware authoritative final result overrides. */
  targetApplyFinalResultsByPath: Record<string, MetadataApplyFileResult>;
  tagInfos: TagInfo[];
  /** Stored settings; defaults to empty API key + gpt-4o + heuristic estimates. */
  settings: {
    openai_api_key: string;
    openai_model: string;
    normalise_metadata_model: string;
    normalise_location_model: string;
    ai_cost_estimate_mode: "heuristic" | "exact";
    describe_concurrency: number;
    normalise_concurrency: number;
    metadata_scan_concurrency: number;
    metadata_scan_batch_size: number;
    metadata_apply_batch_size: number;
    metadata_apply_concurrency: number;
    thumbnail_concurrency: number;
  };
  /** Recommended-models list returned by list_recommended_models. */
  recommendedModels: string[];
  /** Per-model ballpark cost returned by estimate_per_image_cost_cmd. */
  perImageCosts: Record<string, number>;
  /** Records the most recent estimate_describe_cost_cmd arguments. */
  lastEstimateArgs: { folderPath: string; relPaths: string[] } | null;
  /** Records the most recent describe_images_cmd arguments. */
  lastDescribeArgs: { folderPath: string; relPaths: string[] } | null;
  cancelDescribeCalled: boolean;
  /**
   * Drives the events emitted by estimate_describe_cost_cmd. Tests can mutate
   * this to simulate per-image token counts.
   */
  estimateTokenSchedule: number[];
  /** Override describe progress / completion. Each entry is one rel_path's result. */
  describeSchedule: Array<{
    relativePath: string;
    status: string;
    error?: string | null;
    /** Typed draft edits the mock backend should emit alongside an "ok" status. */
    edits?: SchemaMetadataEdit[];
  }>;
  beforeDescribeProgress: (() => void) | null;
  /** Override the usage summary emitted by describe_complete. */
  describeUsageSummary: {
    totalInputTokens: number;
    totalCachedTokens: number;
    totalCacheWriteTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    totalNonReasoningOutputTokens: number;
    serviceTier: string;
    reasoningEffort: string;
    predictedCostUsd: number;
    actualCostUsd: number;
  };
  /** Override the estimate-complete payload. */
  describeEstimateComplete: {
    totalInputTokens: number;
    predictedCostUsd: number;
    upperBoundCostUsd: number;
    model: string;
    estimateMode?: "heuristic" | "exact";
  };

  // ── Reverse-geocoding mock state ─────────────────────────────────────
  /** Records the most recent geocode_images_cmd arguments. */
  lastGeocodeArgs: {
    folderPath: string;
    items: Array<{ relPath: string; lat: number | null; lon: number | null }>;
  } | null;
  cancelGeocodeCalled: boolean;
  /** Per-rel-path geocode outcome. Order corresponds to items[i]. */
  geocodeSchedule: Array<{
    relativePath: string;
    status: string;
    error?: string | null;
    /** Typed draft edits emitted on `status === "ok"`. */
    edits?: SchemaMetadataEdit[];
  }>;
  /** Summary emitted by geocode_complete. */
  geocodeSummary: {
    nSucceededFromNominatim: number;
    nSucceededFromCache: number;
    nNoGps: number;
    nFailed: number;
  };

  // ── Metadata-normalisation mock state ────────────────────────────────
  /** Most recent normalise_metadata_cmd args. */
  lastNormaliseArgs: {
    folderPath: string;
    items: Array<{ relPath: string; groupInputs: Record<string, unknown> }>;
    enabledGroups: string[];
  } | null;
  cancelNormaliseCalled: boolean;
  /** Per-rel-path normalise outcome. Order corresponds to items[i]. */
  normaliseSchedule: Array<{
    relativePath: string;
    status: string;
    error?: string | null;
    /** Typed draft edits emitted on `status === "ok"`. */
    edits?: SchemaMetadataEdit[];
  }>;
  /** Optional gate invoked after run confirmation but before result events. */
  beforeNormaliseProgress: (() => void | Promise<void>) | null;
  normaliseSummary: {
    nSucceeded: number;
    nFailed: number;
    nSkippedAllNormalised: number;
    perGroup: Record<
      string,
      {
        nNoop: number;
        nNormalisedDeterministic: number;
        nNormalisedAi: number;
        nConflictPrimaryWon: number;
        nLocationXmpIimConflict: number;
        nDateConflict: number;
        nDtoFromFilename: number;
        nDtoFromFilenameDateOnly: number;
        nUnparseableDateInputs: number;
        nAiErrors: number;
      }
    >;
    aiCostTotalUsd: number;
    aiCallsTotal: number;
  };
}

export function createMockTauriApi(): MockTauriApi {
  let nextFolder: string | null = null;
  const handlers: Record<string, EventHandler[]> = {};
  let nextSessionId = 1;
  let sessionSnapshot: MediaLibrarySessionSnapshot = {
    session_id: null,
    revision: 0,
    lifecycle: "idle",
    folder: null,
    files: [],
    discovery_running: false,
    issues: [],
    metadata: [],
    thumbnails: [],
    drafts: {},
    draft_persistence: { status: "ready" },
  };
  let recoverySnapshot = { ...sessionSnapshot };
  let nextThumbnailKey = 1;
  const thumbnailPayloads = new Map<string, string>();
  let initialSnapshotServed = false;
  const supersededScanMetadata = new Set<string>();

  const mock: MockTauriApi = {
    api: null as unknown as TauriApi,
    pickFolderResolves: (path) => {
      nextFolder = path;
    },
    setSessionSnapshot: (snapshot) => {
      sessionSnapshot = { ...snapshot };
      recoverySnapshot = { ...snapshot };
      if (snapshot.session_id !== null) {
        nextSessionId = Math.max(nextSessionId, snapshot.session_id + 1);
        mock.currentScanId = snapshot.session_id;
      }
    },
    setThumbnailPayload: (cacheKey, thumbnail) => {
      thumbnailPayloads.set(cacheKey, thumbnail);
    },
    foundPaths: new Set(),
    emitFileFound: (file, scanId) => {
      const sessionId = scanId ?? mock.currentScanId;
      if (sessionId === mock.currentScanId) {
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          files: [...sessionSnapshot.files, file],
          metadata: [
            ...sessionSnapshot.metadata,
            { relative_path: file.relative_path, state: { status: "loading" } },
          ],
          thumbnails: [
            ...sessionSnapshot.thumbnails,
            { relative_path: file.relative_path, state: { status: "loading" } },
          ],
        };
      }
      emit("media_library_session_files_added", {
        session_id: sessionId,
        revision:
          sessionId === mock.currentScanId
            ? sessionSnapshot.revision
            : sessionSnapshot.revision + 1,
        files: [file],
      });
    },
    emitScanComplete: (scanId) => {
      const sessionId = scanId ?? mock.currentScanId;
      if (sessionId === mock.currentScanId) {
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          discovery_running: false,
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
      }
      emit("scan_complete", { scan_id: sessionId });
    },
    emitFileMetadataReady: (relativePath, metadata, scanId, occurrences) => {
      mock.emitFileMetadataBatch(
        [{ relativePath, metadata, occurrences }],
        scanId,
      );
    },
    emitFileMetadataBatch: (items, scanId) => {
      const sessionId = scanId ?? mock.currentScanId;
      const entries = items
        .filter((item) => !supersededScanMetadata.has(item.relativePath))
        .filter(
          (item) =>
            sessionId !== mock.currentScanId ||
            sessionSnapshot.metadata.some(
              (existing) => existing.relative_path === item.relativePath,
            ),
        )
        .map((item) => {
          const readyOccurrences =
            item.occurrences ??
            Object.entries(item.metadata).map(([name, value], index) => ({
              id: {
                document: null,
                path: `TestFixture-${index}`,
                runtime_tag_id: testId(name).tag_id,
                tag_id_scope: {
                  table: "TestFixture::Runtime",
                  tag_id: testId(name).tag_id,
                  index: null,
                },
                copy: 0,
              },
              schema_id: testId(name),
              value,
              tag_info: null,
              observed_selector: null,
              write_target: null,
            }));
          return {
            relative_path: item.relativePath,
            state: { status: "ready" as const, occurrences: readyOccurrences },
          };
        });
      if (entries.length === 0) return;
      if (sessionId !== mock.currentScanId) {
        emit("media_library_session_metadata_changed", {
          session_id: sessionId,
          revision: sessionSnapshot.revision + 1,
          entries,
        });
        return;
      }
      const changedPaths = new Set(entries.map((entry) => entry.relative_path));
      sessionSnapshot = {
        ...sessionSnapshot,
        revision: sessionSnapshot.revision + 1,
        metadata: [
          ...sessionSnapshot.metadata.filter(
            (item) => !changedPaths.has(item.relative_path),
          ),
          ...entries,
        ],
      };
      emit("media_library_session_metadata_changed", {
        session_id: sessionId,
        revision: sessionSnapshot.revision,
        entries,
      });
    },
    emitThumbnailReady: (relative_path, thumbnail, scanId) => {
      const sessionId = scanId ?? mock.currentScanId;
      if (sessionId !== mock.currentScanId) {
        emit("media_library_session_thumbnails_changed", {
          session_id: sessionId,
          revision: sessionSnapshot.revision + 1,
          entries: [],
        });
        return;
      }
      const existing = sessionSnapshot.thumbnails.find(
        (entry) => entry.relative_path === relative_path,
      );
      if (!existing) return;
      const state =
        thumbnail === null
          ? ({ status: "failed" } as const)
          : (() => {
              const cacheKey = `test-thumbnail-${nextThumbnailKey++}`;
              thumbnailPayloads.set(cacheKey, thumbnail);
              return { status: "ready" as const, cache_key: cacheKey };
            })();
      const entry = { relative_path, state };
      sessionSnapshot = {
        ...sessionSnapshot,
        revision: sessionSnapshot.revision + 1,
        thumbnails: [
          ...sessionSnapshot.thumbnails.filter(
            (item) => item.relative_path !== relative_path,
          ),
          entry,
        ],
      };
      emit("media_library_session_thumbnails_changed", {
        session_id: sessionId,
        revision: sessionSnapshot.revision,
        entries: [entry],
      });
    },
    emitScanError: (message, scanId) =>
      emit("scan_error", {
        scan_id: scanId ?? mock.currentScanId,
        message,
      } satisfies ScanErrorPayload),
    emitWorkerError: (
      error_type,
      error_message,
      affected_files = [],
      scanId,
    ) => {
      const sessionId = scanId ?? mock.currentScanId;
      if (sessionId !== mock.currentScanId) return;
      const failedPaths = new Set(affected_files);
      sessionSnapshot = {
        ...sessionSnapshot,
        revision: sessionSnapshot.revision + 1,
        metadata:
          error_type === "metadata"
            ? sessionSnapshot.metadata.map((entry) =>
                failedPaths.has(entry.relative_path)
                  ? {
                      relative_path: entry.relative_path,
                      state: {
                        status: "failed" as const,
                        error: error_message,
                      },
                    }
                  : entry,
              )
            : sessionSnapshot.metadata,
        issues: [
          ...sessionSnapshot.issues,
          {
            issue_id: sessionSnapshot.issues.length + 1,
            severity: "error",
            error_type,
            error_message,
            affected_files,
          },
        ],
      };
      emit("media_library_session_changed", { ...sessionSnapshot });
    },
    invalidateMetadataOccurrences: (relativePath) =>
      emit("apply_metadata_edits_progress", {
        current: 1,
        total: 1,
        result: {
          relative_path: relativePath,
          applied: true,
          error: null,
          warning: null,
          fresh_file_metadata: null,
          target_outcomes: [],
          persisted_draft_entries: null,
        },
      }),
    targetDraftEditsByFolder: {},
    draftLoadFailuresByFolder: {},
    lastPrioritizedPaths: [],
    lastWindowTitle: null,
    lastRecycleArgs: null,
    recycleFailuresByPath: {},
    invocations: [],
    currentScanId: 1,
    applyEditsProgressGate: null,
    applyProgressEvents: [],
    cancelTargetApplyCalled: false,
    targetApplyProgressResultsByPath: {},
    targetApplyFinalResultsByPath: {},
    tagInfos: [],
    settings: {
      openai_api_key: "",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 12,
      normalise_concurrency: 12,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 32,
      metadata_apply_concurrency: 8,
      thumbnail_concurrency: 8,
    },
    recommendedModels: [
      "gpt-4o",
      "gpt-5.4-nano",
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.5",
    ],
    perImageCosts: {
      "gpt-4o": 0.00525,
      "gpt-5.4-nano": 0.00053,
      "gpt-5.4-mini": 0.00195,
      "gpt-5.4": 0.0065,
      "gpt-5.5": 0.013,
    },
    lastEstimateArgs: null,
    lastDescribeArgs: null,
    cancelDescribeCalled: false,
    estimateTokenSchedule: [],
    describeSchedule: [],
    beforeDescribeProgress: null,
    describeUsageSummary: {
      totalInputTokens: 0,
      totalCachedTokens: 0,
      totalCacheWriteTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalNonReasoningOutputTokens: 0,
      serviceTier: "default",
      reasoningEffort: "",
      predictedCostUsd: 0,
      actualCostUsd: 0,
    },
    describeEstimateComplete: {
      totalInputTokens: 0,
      predictedCostUsd: 0,
      upperBoundCostUsd: 0,
      model: "gpt-4o",
      estimateMode: "heuristic",
    },
    lastGeocodeArgs: null,
    cancelGeocodeCalled: false,
    geocodeSchedule: [],
    geocodeSummary: {
      nSucceededFromNominatim: 0,
      nSucceededFromCache: 0,
      nNoGps: 0,
      nFailed: 0,
    },
    lastNormaliseArgs: null,
    cancelNormaliseCalled: false,
    normaliseSchedule: [],
    beforeNormaliseProgress: null,
    normaliseSummary: {
      nSucceeded: 0,
      nFailed: 0,
      nSkippedAllNormalised: 0,
      perGroup: {},
      aiCostTotalUsd: 0,
      aiCallsTotal: 0,
    },
  };

  const api: TauriApi = {
    createChannel: (handler) => ({ onmessage: handler }),
    invoke: async (cmd, args) => {
      mock.invocations.push({ cmd, args });
      if (cmd === "pick_folder") return nextFolder;
      if (cmd === "get_cli_folder") return null;
      if (cmd === "get_media_library_session_snapshot") {
        if (!initialSnapshotServed) {
          initialSnapshotServed = true;
          return { ...recoverySnapshot };
        }
        return { ...sessionSnapshot };
      }
      if (cmd === "get_media_library_thumbnails") {
        const sessionId = args?.sessionId as number;
        if (sessionId !== mock.currentScanId) return [];
        return ((args?.cacheKeys as string[]) ?? []).flatMap((cache_key) => {
          const thumbnail = thumbnailPayloads.get(cache_key);
          return thumbnail === undefined ? [] : [{ cache_key, thumbnail }];
        });
      }
      if (cmd === "open_media_library_session") {
        sessionSnapshot = {
          session_id: nextSessionId++,
          revision: sessionSnapshot.revision + 1,
          lifecycle: "opening",
          folder: args?.folderPath as string,
          files: [],
          discovery_running: false,
          issues: [],
          metadata: [],
          thumbnails: [],
          drafts: targetDraftsToWire(
            mock.targetDraftEditsByFolder[args?.folderPath as string] ?? {},
          ),
          draft_persistence: mock.draftLoadFailuresByFolder[
            args?.folderPath as string
          ]
            ? {
                status: "load-failed",
                error:
                  mock.draftLoadFailuresByFolder[args?.folderPath as string],
              }
            : { status: "ready" },
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "start_scan") {
        mock.currentScanId = args?.scanId as number;
        mock.foundPaths.clear();
        supersededScanMetadata.clear();
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          lifecycle: "loaded",
          discovery_running: true,
          issues: [],
          metadata: [],
          thumbnails: [],
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return;
      }
      if (cmd === "dismiss_media_library_session_issue") {
        const issueId = args?.issueId as number;
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          issues: sessionSnapshot.issues.filter(
            (issue) => issue.issue_id !== issueId,
          ),
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "close_media_library_session") {
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          lifecycle: "closing",
        };
        sessionSnapshot = {
          session_id: null,
          revision: sessionSnapshot.revision + 1,
          lifecycle: "idle",
          folder: null,
          files: [],
          discovery_running: false,
          issues: [],
          metadata: [],
          thumbnails: [],
          drafts: {},
          draft_persistence: { status: "ready" },
        };
        return { ...sessionSnapshot };
      }
      if (cmd === "stop_scan") {
        return;
      }
      if (cmd === "show_in_explorer") {
        return;
      }
      if (cmd === "recycle_media_files") {
        const folder = args?.folder as string;
        const relativePaths = (args?.relativePaths as string[]) ?? [];
        mock.lastRecycleArgs = { folder, relativePaths };
        const results = relativePaths.map((relative_path) => {
          const error = mock.recycleFailuresByPath[relative_path] ?? null;
          return {
            relative_path,
            recycled: error === null,
            error,
          };
        });
        const recycled = new Set(
          results
            .filter((item) => item.recycled)
            .map((item) => item.relative_path),
        );
        if (recycled.size > 0) {
          const drafts = targetDraftsFromWire(
            sessionSnapshot.drafts as Record<
              string,
              MetadataTargetDraftEntry[]
            >,
          );
          for (const relativePath of recycled) delete drafts[relativePath];
          mock.targetDraftEditsByFolder[folder] = drafts;
          sessionSnapshot = {
            ...sessionSnapshot,
            revision: sessionSnapshot.revision + 1,
            files: sessionSnapshot.files.filter(
              (file) => !recycled.has(file.relative_path),
            ),
            metadata: sessionSnapshot.metadata.filter(
              (entry) => !recycled.has(entry.relative_path),
            ),
            thumbnails: sessionSnapshot.thumbnails.filter(
              (entry) => !recycled.has(entry.relative_path),
            ),
            drafts: targetDraftsToWire(drafts),
          };
          emit("media_library_session_changed", { ...sessionSnapshot });
        }
        return { results };
      }
      if (cmd === "prioritize_queues") {
        mock.lastPrioritizedPaths = (args?.visiblePaths as string[]) ?? [];
        return;
      }
      if (cmd === "set_window_title") {
        mock.lastWindowTitle = (args?.title as string) ?? null;
        return;
      }
      if (cmd === "set_media_library_session_draft") {
        const sessionId = args?.sessionId as number;
        if (sessionId !== mock.currentScanId) throw new Error("stale session");
        const relativePath = args?.relativePath as string;
        const target = args?.target as MetadataDraftTarget;
        const edit = args?.edit as MetadataDraftEdit;
        const store = new TargetDraftEditsStore();
        store.resetMetadata(
          targetDraftsFromWire(
            sessionSnapshot.drafts as Record<
              string,
              MetadataTargetDraftEntry[]
            >,
          ),
        );
        store.setMetadataTarget(relativePath, target, edit);
        mock.targetDraftEditsByFolder[sessionSnapshot.folder ?? ""] =
          store.getAllMetadata();
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          drafts: targetDraftsToWire(store.getAllMetadata()),
          draft_persistence: { status: "ready" },
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "discard_media_library_session_draft") {
        const sessionId = args?.sessionId as number;
        if (sessionId !== mock.currentScanId) throw new Error("stale session");
        const relativePath = args?.relativePath as string;
        const target = args?.target as MetadataDraftTarget;
        const store = new TargetDraftEditsStore();
        store.resetMetadata(
          targetDraftsFromWire(
            sessionSnapshot.drafts as Record<
              string,
              MetadataTargetDraftEntry[]
            >,
          ),
        );
        store.deleteTarget(relativePath, target);
        mock.targetDraftEditsByFolder[sessionSnapshot.folder ?? ""] =
          store.getAllMetadata();
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          drafts: targetDraftsToWire(store.getAllMetadata()),
          draft_persistence: { status: "ready" },
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "discard_media_library_session_drafts") {
        const sessionId = args?.sessionId as number;
        if (sessionId !== mock.currentScanId) throw new Error("stale session");
        const relativePath = args?.relativePath as string;
        const targets = args?.targets as MetadataDraftTarget[];
        const store = new TargetDraftEditsStore();
        store.resetMetadata(
          targetDraftsFromWire(
            sessionSnapshot.drafts as Record<
              string,
              MetadataTargetDraftEntry[]
            >,
          ),
        );
        for (const target of targets) {
          store.deleteTarget(relativePath, target);
        }
        mock.targetDraftEditsByFolder[sessionSnapshot.folder ?? ""] =
          store.getAllMetadata();
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          drafts: targetDraftsToWire(store.getAllMetadata()),
          draft_persistence: { status: "ready" },
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "replace_media_library_session_new_property_draft") {
        const sessionId = args?.sessionId as number;
        if (sessionId !== mock.currentScanId) throw new Error("stale session");
        const relativePath = args?.relativePath as string;
        const originalTarget = args?.originalTarget as MetadataDraftTarget;
        const replacementTarget =
          args?.replacementTarget as MetadataDraftTarget;
        const originalEdit = args?.originalEdit as MetadataDraftEdit;
        const store = new TargetDraftEditsStore();
        store.resetMetadata(
          targetDraftsFromWire(
            sessionSnapshot.drafts as Record<
              string,
              MetadataTargetDraftEntry[]
            >,
          ),
        );
        const original = Object.values(
          store.getMetadataFile(relativePath) ?? {},
        ).find(
          (entry) =>
            JSON.stringify(entry.target) === JSON.stringify(originalTarget),
        );
        if (
          original === undefined ||
          JSON.stringify(original.edit) !== JSON.stringify(originalEdit)
        ) {
          throw new Error("The original draft changed or disappeared");
        }
        store.deleteTarget(relativePath, originalTarget);
        store.setMetadataTarget(relativePath, replacementTarget, originalEdit);
        mock.targetDraftEditsByFolder[sessionSnapshot.folder ?? ""] =
          store.getAllMetadata();
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          drafts: targetDraftsToWire(store.getAllMetadata()),
          draft_persistence: { status: "ready" },
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "remove_media_library_session_metadata_targets") {
        const sessionId = args?.sessionId as number;
        if (sessionId !== mock.currentScanId) throw new Error("stale session");
        const relativePath = args?.relativePath as string;
        const targets = args?.targets as MetadataDraftTarget[];
        const store = new TargetDraftEditsStore();
        store.resetMetadata(
          targetDraftsFromWire(
            sessionSnapshot.drafts as Record<
              string,
              MetadataTargetDraftEntry[]
            >,
          ),
        );
        for (const target of targets) {
          if (target.kind === "NewProperty") {
            store.deleteTarget(relativePath, target);
          } else {
            store.setMetadataTarget(relativePath, target, {
              intent: "Delete",
              value: null,
            });
          }
        }
        mock.targetDraftEditsByFolder[sessionSnapshot.folder ?? ""] =
          store.getAllMetadata();
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          drafts: targetDraftsToWire(store.getAllMetadata()),
          draft_persistence: { status: "ready" },
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "mutate_media_library_session_draft_rows") {
        const sessionId = args?.sessionId as number;
        if (sessionId !== mock.currentScanId) throw new Error("stale session");
        const drafts = targetDraftsFromWire(
          sessionSnapshot.drafts as Record<string, MetadataTargetDraftEntry[]>,
        );
        for (const mutation of args?.mutations as Array<{
          relative_path: string;
          entries: MetadataTargetDraftEntry[];
        }>) {
          if (mutation.entries.length === 0) {
            delete drafts[mutation.relative_path];
          } else {
            drafts[mutation.relative_path] = targetDraftsFromWire({
              [mutation.relative_path]: mutation.entries,
            })[mutation.relative_path];
          }
        }
        mock.targetDraftEditsByFolder[sessionSnapshot.folder ?? ""] = drafts;
        sessionSnapshot = {
          ...sessionSnapshot,
          revision: sessionSnapshot.revision + 1,
          drafts: targetDraftsToWire(drafts),
          draft_persistence: { status: "ready" },
        };
        emit("media_library_session_changed", { ...sessionSnapshot });
        return { ...sessionSnapshot };
      }
      if (cmd === "load_metadata_draft_edits") {
        const folder = args?.folderPath as string;
        return targetDraftsToWire(mock.targetDraftEditsByFolder[folder] || {});
      }
      if (cmd === "save_metadata_draft_rows") {
        const folder = args?.folderPath as string;
        const current = mock.targetDraftEditsByFolder[folder] || {};
        for (const mutation of args?.mutations as Array<{
          relative_path: string;
          entries: MetadataTargetDraftEntry[];
        }>) {
          if (mutation.entries.length === 0) {
            delete current[mutation.relative_path];
          } else {
            current[mutation.relative_path] = targetDraftsFromWire({
              [mutation.relative_path]: mutation.entries,
            })[mutation.relative_path];
          }
        }
        mock.targetDraftEditsByFolder[folder] = current;
        return;
      }
      if (cmd === "get_tag_info") {
        const id = args?.id;
        return (
          mock.tagInfos.find(
            (info) => JSON.stringify(info.id) === JSON.stringify(id),
          ) ?? null
        );
      }
      if (cmd === "get_tag_infos") {
        const ids = (args?.ids as unknown[]) ?? [];
        return mock.tagInfos.filter((info) =>
          ids.some((id) => JSON.stringify(info.id) === JSON.stringify(id)),
        );
      }
      if (cmd === "list_writable_schema_definitions") {
        return mock.tagInfos;
      }
      if (cmd === "apply_metadata_draft_edits_cmd") {
        const folder = args?.folderPath as string;
        const explicitPaths = args?.relPaths as string[] | null;
        const relPaths =
          explicitPaths ??
          Object.keys(mock.targetDraftEditsByFolder[folder] ?? {});
        const operationId = args?.operationId as string;
        const channel = args?.progressChannel as {
          onmessage: (payload: unknown) => void;
        };
        await Promise.resolve();
        channel.onmessage({
          kind: "started",
          operation_id: operationId,
          total: relPaths.length,
        });
        const completedFiles: MetadataApplyFileResult[] = [];
        const undeliveredFiles: MetadataApplyFileResult[] = [];
        let sequence = 0;
        for (const [index, relative_path] of relPaths.entries()) {
          if (mock.cancelTargetApplyCalled) break;
          const fallback: MetadataApplyFileResult = {
            relative_path,
            applied: true,
            error: null,
            warning: null,
            fresh_file_metadata: null,
            target_outcomes: [],
            persisted_draft_entries: [],
          };
          const progressResult =
            mock.targetApplyProgressResultsByPath[relative_path] ?? fallback;
          const terminalFallback =
            mock.targetApplyFinalResultsByPath[relative_path];
          const effectiveResult = terminalFallback ?? progressResult;
          if (effectiveResult.fresh_file_metadata !== null) {
            mock.emitFileMetadataReady(
              relative_path,
              {},
              mock.currentScanId,
              effectiveResult.fresh_file_metadata.occurrences,
            );
            supersededScanMetadata.add(relative_path);
          }
          completedFiles.push(effectiveResult);
          if (terminalFallback) {
            undeliveredFiles.push(terminalFallback);
          } else {
            channel.onmessage({
              kind: "progress_batch",
              operation_id: operationId,
              sequence: ++sequence,
              current: index + 1,
              total: relPaths.length,
              results: [progressResult],
            });
          }
          mock.applyProgressEvents.push({
            current: index + 1,
            total: relPaths.length,
            relative_path,
          });
          if (mock.applyEditsProgressGate) {
            await mock.applyEditsProgressGate.waitForNextStep();
          }
        }
        const existing = mock.targetDraftEditsByFolder[folder] ?? {};
        mock.targetDraftEditsByFolder[folder] = Object.fromEntries(
          Object.entries(existing).filter(([path]) =>
            completedFiles.every(
              (result) =>
                result.relative_path !== path ||
                result.persisted_draft_entries === null ||
                result.persisted_draft_entries.length > 0,
            ),
          ),
        );
        const summary: MetadataApplySummary = {
          requested: relPaths.length,
          selected: relPaths.length,
          completed: completedFiles.length,
          applied: completedFiles.filter((result) => result.applied).length,
          failed: completedFiles.filter((result) => !result.applied).length,
          warning_count: completedFiles.filter(
            (result) => result.warning !== null,
          ).length,
          cancelled: mock.cancelTargetApplyCalled,
          aborted: false,
          abort_reason: null,
          delivery_failure_count: undeliveredFiles.length,
        };
        channel.onmessage({
          kind: "complete",
          operation_id: operationId,
          summary,
        });
        return {
          summary,
          undelivered_files: undeliveredFiles,
          complete_delivery_failed: false,
        };
      }
      if (cmd === "cancel_apply_edits") {
        mock.cancelTargetApplyCalled = true;
        return;
      }
      if (cmd === "preload_schema") {
        return;
      }
      if (cmd === "load_settings_cmd") {
        return mock.settings;
      }
      if (cmd === "save_settings_cmd") {
        mock.settings = args?.settingsData as typeof mock.settings;
        return;
      }
      if (cmd === "list_recommended_models") {
        return mock.recommendedModels;
      }
      if (cmd === "estimate_per_image_cost_cmd") {
        const model = args?.model as string;
        return mock.perImageCosts[model] ?? 0.005;
      }
      if (cmd === "estimate_describe_cost_cmd") {
        const folderPath = args?.folderPath as string;
        const relPaths = (args?.relPaths as string[]) ?? [];
        mock.lastEstimateArgs = { folderPath, relPaths };
        // Yield to the event loop before emitting events so the hook's
        // useEffect has a chance to subscribe to them. Without this, the
        // synchronous emit can happen before listen() resolves and the
        // dialog never advances.
        const total = relPaths.length;
        await Promise.resolve();
        emit("describe_estimate_started", { total });
        for (let i = 0; i < total; i++) {
          const tokens = mock.estimateTokenSchedule[i] ?? 1000;
          emit("describe_estimate_progress", {
            current: i + 1,
            total,
            relativePath: relPaths[i],
            inputTokens: tokens,
            expectedCostUsd: 0.001,
          });
        }
        emit("describe_estimate_complete", mock.describeEstimateComplete);
        return;
      }
      if (cmd === "describe_images_cmd") {
        const folderPath = args?.folderPath as string;
        const relPaths = (args?.relPaths as string[]) ?? [];
        mock.lastDescribeArgs = { folderPath, relPaths };
        const total = relPaths.length;
        await Promise.resolve();
        emit("describe_started", { total });
        mock.beforeDescribeProgress?.();
        const succeeded: string[] = [];
        const failed: Array<{
          relativePath: string;
          kind: string;
          detail: string;
        }> = [];
        for (let i = 0; i < total; i++) {
          const rp = relPaths[i];
          const sched = mock.describeSchedule[i] ?? {
            relativePath: rp,
            status: "ok",
          };
          const completedPath = sched.relativePath;
          emit("describe_progress", {
            current: i + 1,
            total,
            relativePath: completedPath,
            status: sched.status,
            error: sched.error ?? null,
            edits: sched.status === "ok" ? (sched.edits ?? []) : undefined,
          });
          if (sched.status === "ok") succeeded.push(completedPath);
          else
            failed.push({
              relativePath: completedPath,
              kind: sched.status,
              detail: sched.error ?? "",
            });
        }
        emit("describe_complete", {
          succeeded,
          failed,
          usageSummary: mock.describeUsageSummary,
        });
        return;
      }
      if (cmd === "cancel_describe_cmd") {
        mock.cancelDescribeCalled = true;
        return;
      }
      if (cmd === "geocode_images_cmd") {
        const folderPath = args?.folderPath as string;
        const items =
          (args?.items as Array<{
            relPath: string;
            lat: number | null;
            lon: number | null;
          }>) ?? [];
        mock.lastGeocodeArgs = { folderPath, items };
        const total = items.length;
        await Promise.resolve();
        emit("geocode_started", { total });
        const succeeded: string[] = [];
        const failed: Array<{
          relativePath: string;
          kind: string;
          detail: string;
        }> = [];
        for (let i = 0; i < total; i++) {
          const rp = items[i].relPath;
          const sched = mock.geocodeSchedule[i] ?? {
            relativePath: rp,
            status: "ok",
          };
          emit("geocode_progress", {
            current: i + 1,
            total,
            relativePath: rp,
            status: sched.status,
            error: sched.error ?? null,
            edits: sched.status === "ok" ? (sched.edits ?? []) : undefined,
          });
          if (sched.status === "ok") succeeded.push(rp);
          else
            failed.push({
              relativePath: rp,
              kind: sched.status,
              detail: sched.error ?? "",
            });
        }
        emit("geocode_complete", {
          succeeded,
          failed,
          usageSummary: mock.geocodeSummary,
        });
        return;
      }
      if (cmd === "cancel_geocode_cmd") {
        mock.cancelGeocodeCalled = true;
        return;
      }
      if (cmd === "estimate_normalise_cost_cmd") {
        // Skip-AI happy path: emit started + immediate complete so the
        // dialog transitions to awaiting-confirm without any preflight
        // round-trip in tests. Tests that exercise AI flows can stub
        // this command explicitly.
        const items = (args?.items as Array<{ relPath: string }>) ?? [];
        const enabledGroups = (args?.enabledGroups as string[]) ?? [];
        const total = items.length;
        await Promise.resolve();
        emit("normalise_estimate_started", { total });
        const wantsAi =
          enabledGroups.includes("description") ||
          enabledGroups.includes("title") ||
          enabledGroups.includes("location");
        // Default outcome map: every group has at least one
        // "deterministic" outcome so the table rows render enabled and
        // the auto-prune in `useNormaliseMetadata` doesn't drop them.
        // Tests that need a specific outcome distribution should stub
        // `estimate_normalise_cost_cmd` explicitly.
        const detOutcome = {
          nNoop: 0,
          nNormalisedDeterministic: total,
          nNormalisedAi: 0,
          nConflict: 0,
          nOverwrites: 0,
        };
        emit("normalise_estimate_complete", {
          nImagesWithAiB: 0,
          nImagesWithAiC: 0,
          nImagesWithAiG: 0,
          nImagesNoAi: total,
          totalInputTokens: 0,
          predictedCostUsd: 0,
          upperBoundCostUsd: 0,
          model: wantsAi ? "gpt-5.4-nano" : "",
          locationModel: wantsAi ? "gpt-5.4-nano" : "",
          perGroupOutcomes: {
            keywords: { ...detOutcome },
            creator: { ...detOutcome },
            copyright: { ...detOutcome },
            location: { ...detOutcome },
            dates: { ...detOutcome },
            description: { ...detOutcome },
            title: { ...detOutcome },
            headline: { ...detOutcome },
          },
          iptcUtf8BaseApplicablePaths: [],
          iptcUtf8OutputPathsByGroup: {},
          aiTokenBreakdown: null,
          pricing: null,
          locationPricing: null,
          expectedOutPerCallB: 250,
          maxOutPerCallB: 400,
          expectedOutPerCallC: 15,
          maxOutPerCallC: 30,
          expectedOutPerCallG: 100,
          maxOutPerCallG: 250,
          locationCachePrefixTokens: 1306,
          locationCachePartitions: 8,
        });
        return;
      }
      if (cmd === "normalise_metadata_cmd") {
        const folderPath = args?.folderPath as string;
        const items =
          (args?.items as Array<{
            relPath: string;
            groupInputs: Record<string, unknown>;
          }>) ?? [];
        const enabledGroups = (args?.enabledGroups as string[]) ?? [];
        mock.lastNormaliseArgs = { folderPath, items, enabledGroups };
        const total = items.length;
        await Promise.resolve();
        emit("normalise_started", { total });
        await mock.beforeNormaliseProgress?.();
        const succeeded: string[] = [];
        const failed: Array<{
          relativePath: string;
          kind: string;
          detail: string;
        }> = [];
        const results: Array<{
          current: number;
          total: number;
          relativePath: string;
          status: string;
          error: string | null;
          edits?: SchemaMetadataEdit[];
        }> = [];
        for (let i = 0; i < total; i++) {
          const rp = items[i].relPath;
          const sched = mock.normaliseSchedule[i] ?? {
            relativePath: rp,
            status: "ok",
          };
          results.push({
            current: i + 1,
            total,
            relativePath: rp,
            status: sched.status,
            error: sched.error ?? null,
            edits: sched.status === "ok" ? (sched.edits ?? []) : undefined,
          });
          if (sched.status === "ok") succeeded.push(rp);
          else
            failed.push({
              relativePath: rp,
              kind: sched.status,
              detail: sched.error ?? "",
            });
        }
        if (results.length > 0) {
          emit("normalise_progress_batch", { results });
        }
        emit("normalise_complete", {
          succeeded,
          failed,
          usageSummary: mock.normaliseSummary,
        });
        return;
      }
      if (cmd === "cancel_normalise_cmd") {
        mock.cancelNormaliseCalled = true;
        return;
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    },
    listen: async (event, handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return () => {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      };
    },
  };

  const emit = (event: string, payload: unknown) => {
    (handlers[event] ?? []).forEach((h) => h(payload));
  };

  mock.api = api;
  return mock;
}
