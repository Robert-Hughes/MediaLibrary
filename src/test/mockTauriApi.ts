import type { TauriApi } from "../useMediaLibrary";
import type {
  PhotoInfo,
  PhotoFoundPayload,
  ImageMetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
} from "../types";

type EventHandler = (payload: unknown) => void;

export interface MockTauriApi {
  api: TauriApi;
  pickFolderResolves: (path: string | null) => void;
  emitPhotoFound: (photo: PhotoInfo, scanId?: number) => void;
  emitScanComplete: (scanId?: number) => void;
  emitImageMetadataReady: (relativePath: string, dateTaken: string | null, cameraModel: string | null, scanId?: number) => void;
  emitThumbnailReady: (relativePath: string, thumbnail: string, scanId?: number) => void;
  emitScanError: (message: string) => void;
  lastPrioritizedPaths: string[];
  lastWindowTitle: string | null;
  /** The scan_id returned by the most recent start_scan call. */
  currentScanId: number;
}

export function createMockTauriApi(): MockTauriApi {
  let nextFolder: string | null = null;
  const handlers: Record<string, EventHandler[]> = {};

  const mock: MockTauriApi = {
    api: null as unknown as TauriApi,
    pickFolderResolves: (path) => { nextFolder = path; },
    emitPhotoFound: (photo, scanId) =>
      emit("photo_found", { scan_id: scanId ?? mock.currentScanId, photo } satisfies PhotoFoundPayload),
    emitScanComplete: (scanId) =>
      emit("scan_complete", { scan_id: scanId ?? mock.currentScanId }),
    emitImageMetadataReady: (relative_path, date_taken, camera_model, scanId) =>
      emit("image_metadata_ready", { scan_id: scanId ?? mock.currentScanId, relative_path, date_taken, camera_model } satisfies ImageMetadataReadyPayload),
    emitThumbnailReady: (relative_path, thumbnail, scanId) =>
      emit("thumbnail_ready", { scan_id: scanId ?? mock.currentScanId, relative_path, thumbnail } satisfies ThumbnailReadyPayload),
    emitScanError: (message) =>
      emit("scan_error", { message } satisfies ScanErrorPayload),
    lastPrioritizedPaths: [],
    lastWindowTitle: null,
    currentScanId: 1,
  };

  const api: TauriApi = {
    invoke: async (cmd, args) => {
      if (cmd === "pick_folder") return nextFolder;
      if (cmd === "start_scan") {
        // Increment scan ID and return it, matching the Rust backend behaviour.
        mock.currentScanId += 1;
        return mock.currentScanId;
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
