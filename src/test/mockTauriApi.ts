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
      if (cmd === "load_draft_edits") {
        const folder = args?.folderPath as string;
        return mock.draftEditsByFolder[folder] || {};
      }
      if (cmd === "save_draft_edits") {
        const folder = args?.folderPath as string;
        mock.draftEditsByFolder[folder] = args?.data as any;
        return;
      }
      if (cmd === "apply_draft_edits_cmd") {
        return mock.applyEditsResult;
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
