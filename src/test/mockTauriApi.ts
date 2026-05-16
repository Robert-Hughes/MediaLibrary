import type { TauriApi } from "../useMediaLibrary";
import type {
  PhotoInfo,
  PhotoFoundPayload,
  ImageMetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
  WorkerErrorPayload,
  Variant,
  ApplyEditsResult,
} from "../types";

type EventHandler = (payload: unknown) => void;

export interface MockTauriApi {
  api: TauriApi;
  pickFolderResolves: (path: string | null) => void;
  draftEditsByFolder: Record<string, Record<string, Record<string, string | null>>>;
  emitPhotoFound: (photo: PhotoInfo, scanId?: number) => void;
  emitScanComplete: (scanId?: number) => void;
  emitImageMetadataReady: (relativePath: string, metadata: Record<string, Variant>, scanId?: number) => void;
  emitThumbnailReady: (relativePath: string, thumbnail: string | null, scanId?: number) => void;
  emitScanError: (message: string, scanId?: number) => void;
  emitWorkerError: (workerType: string, errorMessage: string, affectedFiles?: string[], scanId?: number) => void;
  lastPrioritizedPaths: string[];
  lastWindowTitle: string | null;
  /** All invoke calls recorded in order. */
  invocations: Array<{ cmd: string; args?: Record<string, unknown> }>;
  /** The scan_id returned by the most recent start_scan call. */
  currentScanId: number;
  /** Override apply_draft_edits_cmd result. Default: success with no applied/failed. */
  applyEditsResult: ApplyEditsResult;
  cancelApplyEditsCalled: boolean;
  /** Stored settings; defaults to empty API key + gpt-4o. */
  settings: { openai_api_key: string; openai_model: string };
  /** Recommended-models list returned by list_recommended_models. */
  recommendedModels: string[];
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
  describeSchedule: Array<{ relativePath: string; status: string; error?: string | null }>;
  /** Override the usage summary emitted by describe_complete. */
  describeUsageSummary: {
    totalInputTokens: number; totalCachedTokens: number;
    totalOutputTokens: number; predictedCostUsd: number; actualCostUsd: number;
  };
  /** Override the estimate-complete payload. */
  describeEstimateComplete: {
    totalInputTokens: number; predictedCostUsd: number;
    upperBoundCostUsd: number; model: string;
  };
}

export function createMockTauriApi(): MockTauriApi {
  let nextFolder: string | null = null;
  const handlers: Record<string, EventHandler[]> = {};

  const mock: MockTauriApi = {
    api: null as unknown as TauriApi,
    pickFolderResolves: (path) => { nextFolder = path; },
    emitPhotoFound: (photo, scanId) =>
      emit("photo_found", { scan_id: scanId ?? mock.currentScanId, photos: [photo] } satisfies PhotoFoundPayload),
    emitScanComplete: (scanId) =>
      emit("scan_complete", { scan_id: scanId ?? mock.currentScanId }),
    emitImageMetadataReady: (relative_path, metadata, scanId) =>
      emit("image_metadata_ready", { scan_id: scanId ?? mock.currentScanId, results: [{ relative_path, metadata }] } satisfies ImageMetadataReadyPayload),
    emitThumbnailReady: (relative_path, thumbnail, scanId) =>
      emit("thumbnail_ready", { scan_id: scanId ?? mock.currentScanId, results: [{ relative_path, thumbnail }] } satisfies ThumbnailReadyPayload),
    emitScanError: (message, scanId) =>
      emit("scan_error", {
        scan_id: scanId ?? mock.currentScanId,
        message,
      } satisfies ScanErrorPayload),
    emitWorkerError: (worker_type, error_message, affected_files = [], scanId) =>
      emit("worker_error", {
        scan_id: scanId ?? mock.currentScanId,
        worker_type,
        error_message,
        affected_files,
      } satisfies WorkerErrorPayload),
    draftEditsByFolder: {},
    lastPrioritizedPaths: [],
    lastWindowTitle: null,
    invocations: [],
    currentScanId: 1,
    applyEditsResult: { applied: [], failed: [], fresh_metadata: {} },
    cancelApplyEditsCalled: false,
    settings: { openai_api_key: "", openai_model: "gpt-4o" },
    recommendedModels: ["gpt-4o", "gpt-5.4-nano", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
    lastEstimateArgs: null,
    lastDescribeArgs: null,
    cancelDescribeCalled: false,
    estimateTokenSchedule: [],
    describeSchedule: [],
    describeUsageSummary: {
      totalInputTokens: 0, totalCachedTokens: 0, totalOutputTokens: 0,
      predictedCostUsd: 0, actualCostUsd: 0,
    },
    describeEstimateComplete: {
      totalInputTokens: 0, predictedCostUsd: 0, upperBoundCostUsd: 0, model: "gpt-4o",
    },
  };

  const api: TauriApi = {
    invoke: async (cmd, args) => {
      mock.invocations.push({ cmd, args });
      if (cmd === "pick_folder") return nextFolder;
      if (cmd === "get_cli_folder") return null;
      if (cmd === "start_scan") {
        // The frontend now generates the scanId and passes it in args
        mock.currentScanId = (args?.scanId as number) ?? (mock.currentScanId + 1);
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
      if (cmd === "load_draft_edits" || cmd === "load_draft_edits_typed") {
        const folder = args?.folderPath as string;
        return mock.draftEditsByFolder[folder] || {};
      }
      if (cmd === "save_draft_edits" || cmd === "save_draft_edits_typed") {
        const folder = args?.folderPath as string;
        mock.draftEditsByFolder[folder] = args?.data as any;
        return;
      }
      if (cmd === "get_tag_info") {
        // Tests don't exercise schema-driven editors; return null so
        // TypedValueEditor falls through to the legacy text input.
        return null;
      }
      if (cmd === "apply_draft_edits_cmd") {
        const result = mock.applyEditsResult;
        const relPaths = (args?.relPaths as string[]) ?? [];
        const total = result.applied.length + result.failed.length;

        // Mirror the backend: emit started, then one progress event per file
        emit("apply_edits_started", { total });

        let current = 0;
        for (const path of relPaths) {
          const isApplied = result.applied.includes(path);
          const failedEntry = result.failed.find((f) => f.relative_path === path);
          if (!isApplied && !failedEntry) continue;

          current += 1;
          emit("apply_edits_progress", {
            current,
            total,
            relative_path: path,
            applied: isApplied,
            error: failedEntry ? failedEntry.reason : null,
            fresh_metadata: result.fresh_metadata[path] ?? null,
          });
        }

        return result;
      }
      if (cmd === "cancel_apply_edits") {
        mock.cancelApplyEditsCalled = true;
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
      if (cmd === "estimate_describe_cost_cmd") {
        const folderPath = args?.folderPath as string;
        const relPaths = (args?.relPaths as string[]) ?? [];
        mock.lastEstimateArgs = { folderPath, relPaths };
        // Yield to the event loop before emitting events so the hook's
        // useEffect has a chance to subscribe to them. Without this, the
        // synchronous emit can happen before listen() resolves and the
        // dialog never advances.
        const total = relPaths.length;
        await new Promise((r) => setTimeout(r, 0));
        emit("describe_estimate_started", { total });
        for (let i = 0; i < total; i++) {
          const tokens = mock.estimateTokenSchedule[i] ?? 1000;
          emit("describe_estimate_progress", {
            current: i + 1, total, relativePath: relPaths[i],
            inputTokens: tokens, expectedCostUsd: 0.001,
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
        await new Promise((r) => setTimeout(r, 0));
        emit("describe_started", { total });
        const succeeded: string[] = [];
        const failed: Array<{ relativePath: string; kind: string; detail: string }> = [];
        for (let i = 0; i < total; i++) {
          const rp = relPaths[i];
          const sched = mock.describeSchedule[i] ?? { relativePath: rp, status: "ok" };
          emit("describe_progress", {
            current: i + 1, total, relativePath: rp,
            status: sched.status, error: sched.error ?? null,
          });
          if (sched.status === "ok") succeeded.push(rp);
          else failed.push({ relativePath: rp, kind: sched.status, detail: sched.error ?? "" });
        }
        emit("describe_complete", {
          succeeded, failed, usageSummary: mock.describeUsageSummary,
        });
        return;
      }
      if (cmd === "cancel_describe_cmd") {
        mock.cancelDescribeCalled = true;
        return;
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    },
    listen: async (event, handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return () => { handlers[event] = handlers[event].filter((h) => h !== handler); };
    },
  };

  const emit = (event: string, payload: unknown) => {
    (handlers[event] ?? []).forEach((h) => h(payload));
  };

  mock.api = api;
  return mock;
}
