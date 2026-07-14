import type { TauriApi } from "../useMediaLibrary";
import type {
  PhotoInfo,
  PhotoFoundPayload,
  ImageMetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
  WorkerErrorPayload,
  MetadataApplyEditsResult,
  MetadataTagOutcome,
  MetadataDraftEditsByFile,
  MetadataDraftEntry,
  MetadataEntry,
  MetadataOccurrences,
  MetadataValue,
  MetadataDraftEntryV5,
  MetadataApplyFileResultV5,
} from "../types";
import { metadataDraftsFromWire, metadataDraftsToWire } from "../types";
import {
  targetDraftsFromWire,
  targetDraftsToWire,
  type TargetDraftEditsByFile,
} from "../targetDraftEdits";
import { testFriendlyName, testId } from "./testIds";
type EventHandler = (payload: unknown) => void;

type MockDraftEditsByFolder = Record<string, MetadataDraftEditsByFile>;
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
  draftEditsByFolder: MockDraftEditsByFolder;
  targetDraftEditsByFolder: MockTargetDraftEditsByFolder;
  emitPhotoFound: (photo: PhotoInfo, scanId?: number) => void;
  emitScanComplete: (scanId?: number) => void;
  emitImageMetadataReady: (
    relativePath: string,
    metadata: Record<string, MetadataValue>,
    scanId?: number,
    occurrences?: MetadataOccurrences,
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
  lastPrioritizedPaths: string[];
  lastWindowTitle: string | null;
  /** All invoke calls recorded in order. */
  invocations: Array<{ cmd: string; args?: Record<string, unknown> }>;
  /** The scan_id returned by the most recent start_scan call. */
  currentScanId: number;
  /** Override apply_metadata_draft_edits_cmd result. Default: success with no applied/failed. */
  applyEditsResult: MetadataApplyEditsResult;
  /** Optional manual gate: after each progress event, apply waits for advance(). */
  applyEditsProgressGate: MockApplyEditsProgressGate | null;
  /** Progress events emitted by the apply-edits mock. */
  applyProgressEvents: Array<{
    current: number;
    total: number;
    relative_path: string;
  }>;
  warningsByPath: Record<string, string>;
  cancelApplyEditsCalled: boolean;
  cancelTargetApplyCalled: boolean;
  /** Optional per-file v5 progress result overrides. */
  targetApplyProgressResultsByPath: Record<string, MetadataApplyFileResultV5>;
  /** Optional per-file v5 authoritative final result overrides. */
  targetApplyFinalResultsByPath: Record<string, MetadataApplyFileResultV5>;
  /** Stored settings; defaults to empty API key + gpt-4o + heuristic estimates. */
  settings: {
    openai_api_key: string;
    openai_model: string;
    normalise_metadata_model: string;
    ai_cost_estimate_mode: "heuristic" | "exact";
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
    edits?: MetadataDraftEntry[];
  }>;
  /** Override the usage summary emitted by describe_complete. */
  describeUsageSummary: {
    totalInputTokens: number;
    totalCachedTokens: number;
    totalOutputTokens: number;
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
    edits?: MetadataDraftEntry[];
  }>;
  /** Summary emitted by geocode_complete. */
  geocodeSummary: {
    nSucceededFromNominatim: number;
    nSucceededFromCache: number;
    nSucceededFromOverpass: number;
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
    edits?: Record<string, unknown>;
  }>;
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

  const mock: MockTauriApi = {
    api: null as unknown as TauriApi,
    pickFolderResolves: (path) => {
      nextFolder = path;
    },
    emitPhotoFound: (photo, scanId) =>
      emit("photo_found", {
        scan_id: scanId ?? mock.currentScanId,
        photos: [photo],
      } satisfies PhotoFoundPayload),
    emitScanComplete: (scanId) =>
      emit("scan_complete", { scan_id: scanId ?? mock.currentScanId }),
    emitImageMetadataReady: (
      relative_path,
      metadata,
      scanId,
      occurrences = [],
    ) =>
      emit("image_metadata_ready", {
        scan_id: scanId ?? mock.currentScanId,
        results: [
          {
            relative_path,
            occurrences,
            metadata: Object.entries(metadata).map(
              ([name, value]): MetadataEntry => ({ id: testId(name), value }),
            ),
          },
        ],
      } satisfies ImageMetadataReadyPayload),
    emitThumbnailReady: (relative_path, thumbnail, scanId) =>
      emit("thumbnail_ready", {
        scan_id: scanId ?? mock.currentScanId,
        results: [{ relative_path, thumbnail }],
      } satisfies ThumbnailReadyPayload),
    emitScanError: (message, scanId) =>
      emit("scan_error", {
        scan_id: scanId ?? mock.currentScanId,
        message,
      } satisfies ScanErrorPayload),
    emitWorkerError: (
      worker_type,
      error_message,
      affected_files = [],
      scanId,
    ) =>
      emit("worker_error", {
        scan_id: scanId ?? mock.currentScanId,
        worker_type,
        error_message,
        affected_files,
      } satisfies WorkerErrorPayload),
    draftEditsByFolder: {},
    targetDraftEditsByFolder: {},
    lastPrioritizedPaths: [],
    lastWindowTitle: null,
    invocations: [],
    currentScanId: 1,
    applyEditsResult: { applied: [], failed: [], fresh_metadata: {} },
    applyEditsProgressGate: null,
    applyProgressEvents: [],
    warningsByPath: {},
    cancelApplyEditsCalled: false,
    cancelTargetApplyCalled: false,
    targetApplyProgressResultsByPath: {},
    targetApplyFinalResultsByPath: {},
    settings: {
      openai_api_key: "",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
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
    describeUsageSummary: {
      totalInputTokens: 0,
      totalCachedTokens: 0,
      totalOutputTokens: 0,
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
      nSucceededFromOverpass: 0,
      nNoGps: 0,
      nFailed: 0,
    },
    lastNormaliseArgs: null,
    cancelNormaliseCalled: false,
    normaliseSchedule: [],
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
    invoke: async (cmd, args) => {
      mock.invocations.push({ cmd, args });
      if (cmd === "pick_folder") return nextFolder;
      if (cmd === "get_cli_folder") return null;
      if (cmd === "start_scan") {
        // The frontend now generates the scanId and passes it in args
        mock.currentScanId = (args?.scanId as number) ?? mock.currentScanId + 1;
        return;
      }
      if (cmd === "stop_scan") {
        return;
      }
      if (cmd === "show_in_explorer") {
        return;
      }
      if (cmd === "prioritize_queues") {
        mock.lastPrioritizedPaths = (args?.visiblePaths as string[]) ?? [];
        return;
      }
      if (cmd === "set_window_title") {
        mock.lastWindowTitle = (args?.title as string) ?? null;
        return;
      }
      if (cmd === "load_metadata_draft_edits") {
        const folder = args?.folderPath as string;
        return metadataDraftsToWire(mock.draftEditsByFolder[folder] || {});
      }
      if (cmd === "save_metadata_draft_edits") {
        const folder = args?.folderPath as string;
        mock.draftEditsByFolder[folder] = metadataDraftsFromWire(
          args?.data as Record<string, import("../types").MetadataDraftEntry[]>,
        );
        return;
      }
      if (cmd === "load_metadata_draft_edits_v5") {
        const folder = args?.folderPath as string;
        return targetDraftsToWire(mock.targetDraftEditsByFolder[folder] || {});
      }
      if (cmd === "save_metadata_draft_edits_v5") {
        const folder = args?.folderPath as string;
        mock.targetDraftEditsByFolder[folder] = targetDraftsFromWire(
          args?.data as Record<string, MetadataDraftEntryV5[]>,
        );
        return;
      }
      if (cmd === "get_tag_info") {
        // Tests don't exercise schema-driven editors; return null so
        // TypedValueEditor falls through to the plain text editor.
        return null;
      }
      if (cmd === "get_tag_infos") {
        return [];
      }
      if (cmd === "apply_metadata_draft_edits_cmd") {
        const result = mock.applyEditsResult;
        const relPaths = (args?.relPaths as string[]) ?? [];
        const folder = args?.folderPath as string;
        const total = result.applied.length + result.failed.length;
        const progressEvent = "apply_metadata_edits_progress";

        // Mirror the backend: emit started, then one progress event per file
        emit("apply_edits_started", { total });

        let current = 0;
        const applied: string[] = [];
        const failed: MetadataApplyEditsResult["failed"] = [];
        const fresh_metadata: MetadataApplyEditsResult["fresh_metadata"] = {};

        for (const path of relPaths) {
          if (mock.cancelApplyEditsCalled) {
            break;
          }

          const isApplied = result.applied.includes(path);
          const failedEntry = result.failed.find(
            (f) => f.relative_path === path,
          );
          if (!isApplied && !failedEntry) continue;

          current += 1;
          const progressPayload = {
            current,
            total,
            relative_path: path,
            applied: isApplied,
            error: failedEntry ? failedEntry.reason : null,
            warning: mock.warningsByPath[path] ?? null,
            fresh_metadata: result.fresh_metadata[path] ?? null,
            tag_outcomes: isApplied
              ? mockTagOutcomesForPath(mock, folder, path)
              : [],
          };
          mock.applyProgressEvents.push({
            current,
            total,
            relative_path: path,
          });
          emit(progressEvent, progressPayload);

          if (isApplied) {
            applied.push(path);
            const fresh = result.fresh_metadata[path];
            if (fresh) {
              fresh_metadata[path] = fresh;
            }
          } else if (failedEntry) {
            failed.push(failedEntry);
          }

          if (mock.applyEditsProgressGate) {
            await mock.applyEditsProgressGate.waitForNextStep();
          }
        }

        return { applied, failed, fresh_metadata };
      }
      if (cmd === "cancel_apply_edits") {
        mock.cancelApplyEditsCalled = true;
        return;
      }
      if (cmd === "apply_metadata_draft_edits_v5_cmd") {
        const relPaths = (args?.relPaths as string[]) ?? [];
        const folder = args?.folderPath as string;
        await Promise.resolve();
        emit("apply_edits_v5_started", { total: relPaths.length });
        const files = relPaths.map((relative_path, index) => {
          const fallback: MetadataApplyFileResultV5 = {
            relative_path,
            applied: true,
            error: null,
            warning: null,
            fresh_image_metadata: null,
            target_outcomes: [],
            persisted_draft_entries: [],
          };
          const progressResult =
            mock.targetApplyProgressResultsByPath[relative_path] ?? fallback;
          emit("apply_metadata_edits_v5_progress", {
            current: index + 1,
            total: relPaths.length,
            result: progressResult,
          });
          return (
            mock.targetApplyFinalResultsByPath[relative_path] ?? progressResult
          );
        });
        const existing = mock.targetDraftEditsByFolder[folder] ?? {};
        mock.targetDraftEditsByFolder[folder] = Object.fromEntries(
          Object.entries(existing).filter(([path]) => !relPaths.includes(path)),
        );
        return {
          files,
          cancelled: mock.cancelTargetApplyCalled,
          aborted: false,
          abort_reason: null,
        };
      }
      if (cmd === "cancel_apply_edits_v5") {
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
          emit("describe_progress", {
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
          enabledGroups.includes("title");
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
          nImagesNoAi: total,
          totalInputTokens: 0,
          predictedCostUsd: 0,
          upperBoundCostUsd: 0,
          model: wantsAi ? "gpt-5.4-nano" : "",
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
          aiTokenBreakdown: null,
          pricing: null,
          expectedOutPerCallB: 250,
          maxOutPerCallB: 400,
          expectedOutPerCallC: 15,
          maxOutPerCallC: 30,
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
        const succeeded: string[] = [];
        const failed: Array<{
          relativePath: string;
          kind: string;
          detail: string;
        }> = [];
        for (let i = 0; i < total; i++) {
          const rp = items[i].relPath;
          const sched = mock.normaliseSchedule[i] ?? {
            relativePath: rp,
            status: "ok",
          };
          emit("normalise_progress", {
            current: i + 1,
            total,
            relativePath: rp,
            status: sched.status,
            error: sched.error ?? null,
            edits: sched.status === "ok" ? (sched.edits ?? {}) : undefined,
          });
          if (sched.status === "ok") succeeded.push(rp);
          else
            failed.push({
              relativePath: rp,
              kind: sched.status,
              detail: sched.error ?? "",
            });
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

function mockTagOutcomesForPath(
  mock: MockTauriApi,
  folder: string,
  path: string,
): MetadataTagOutcome[] {
  const stored = mock.draftEditsByFolder[folder];
  if (!stored) return [];
  return Object.values(stored[path] ?? {}).map(({ id }) => ({
    id,
    display_name: testFriendlyName(id),
    kind: "Match",
    sent: null,
    before: null,
    observed: null,
    message: null,
  }));
}
