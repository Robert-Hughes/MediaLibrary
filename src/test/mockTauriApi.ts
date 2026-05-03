/**
 * A controllable mock of the Tauri IPC layer for use in tests.
 *
 * Usage:
 *   const mock = createMockTauriApi();
 *   mock.pickFolderResolves("/photos/vacation");
 *   // trigger openFolder(), then drive events manually:
 *   mock.emitScanProgress(5);
 *   mock.emitScanComplete([{ relative_path: "a.jpg" }]);
 *   mock.emitThumbnailReady("a.jpg", "base64data");
 */
import type { TauriApi } from "../useMediaLibrary";
import type {
  ScanCompletePayload,
  ScanProgressPayload,
  ScanErrorPayload,
  ThumbnailReadyPayload,
} from "../types";

type EventHandler = (payload: unknown) => void;

export interface MockTauriApi {
  api: TauriApi;
  /** Set the folder path that the next pick_folder call will resolve with (null = cancelled). */
  pickFolderResolves: (path: string | null) => void;
  /** Simulate a scan_progress event from Rust. */
  emitScanProgress: (foundSoFar: number) => void;
  /** Simulate a scan_complete event from Rust (photos have no thumbnails). */
  emitScanComplete: (photos: Array<{ relative_path: string }>) => void;
  /** Simulate a thumbnail_ready event from Rust for a single photo. */
  emitThumbnailReady: (relativePath: string, thumbnail: string) => void;
  /** Simulate a scan_error event from Rust. */
  emitScanError: (message: string) => void;
  /** The paths most recently passed to prioritize_thumbnails. */
  lastPrioritizedPaths: string[];
  /** The most recent title passed to set_window_title. */
  lastWindowTitle: string | null;
}

export function createMockTauriApi(): MockTauriApi {
  let nextFolder: string | null = null;
  const handlers: Record<string, EventHandler[]> = {};
  const mock: MockTauriApi = {
    api: null as unknown as TauriApi, // set below
    pickFolderResolves: (path) => { nextFolder = path; },
    emitScanProgress: (foundSoFar) =>
      emit("scan_progress", { found_so_far: foundSoFar } satisfies ScanProgressPayload),
    emitScanComplete: (photos) =>
      emit("scan_complete", { photos } satisfies ScanCompletePayload),
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
