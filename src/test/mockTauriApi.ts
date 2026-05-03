import type { TauriApi } from "../useMediaLibrary";
import type {
  PhotoInfo,
  PhotoFoundPayload,
  MetadataReadyPayload,
  ThumbnailReadyPayload,
  ScanErrorPayload,
} from "../types";

type EventHandler = (payload: unknown) => void;

export interface MockTauriApi {
  api: TauriApi;
  pickFolderResolves: (path: string | null) => void;
  emitPhotoFound: (photo: PhotoInfo) => void;
  emitScanComplete: () => void;
  emitMetadataReady: (relativePath: string, dateTaken: string | null, cameraModel: string | null) => void;
  emitThumbnailReady: (relativePath: string, thumbnail: string) => void;
  emitScanError: (message: string) => void;
  lastPrioritizedPaths: string[];
  lastWindowTitle: string | null;
}

export function createMockTauriApi(): MockTauriApi {
  let nextFolder: string | null = null;
  const handlers: Record<string, EventHandler[]> = {};

  const mock: MockTauriApi = {
    api: null as unknown as TauriApi,
    pickFolderResolves: (path) => { nextFolder = path; },
    emitPhotoFound: (photo) =>
      emit("photo_found", { photo } satisfies PhotoFoundPayload),
    emitScanComplete: () =>
      emit("scan_complete", {}),
    emitMetadataReady: (relative_path, date_taken, camera_model) =>
      emit("metadata_ready", { relative_path, date_taken, camera_model } satisfies MetadataReadyPayload),
    emitThumbnailReady: (relative_path, thumbnail) =>
      emit("thumbnail_ready", { relative_path, thumbnail } satisfies ThumbnailReadyPayload),
    emitScanError: (message) =>
      emit("scan_error", { message } satisfies ScanErrorPayload),
    lastPrioritizedPaths: [],
    lastWindowTitle: null,
  };

  const api: TauriApi = {
    invoke: async (cmd, args) => {
      if (cmd === "pick_folder") return nextFolder;
      if (cmd === "start_scan") return;
      if (cmd === "prioritize_thumbnails") {
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
