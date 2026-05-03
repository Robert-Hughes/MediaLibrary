/**
 * A controllable mock of the Tauri IPC layer for use in tests.
 *
 * Usage:
 *   const mock = createMockTauriApi();
 *   // render component with mock.api
 *   mock.pickFolderResolves("/photos/vacation");
 *   mock.emitScanProgress(5);
 *   mock.emitScanComplete([...]);
 */
import type { TauriApi } from "../useMediaLibrary";
import type { PhotoInfo, ScanCompletePayload, ScanProgressPayload, ScanErrorPayload } from "../types";

type EventHandler = (payload: unknown) => void;

export interface MockTauriApi {
  api: TauriApi;
  /** Set the folder path that the next pick_folder call will resolve with (null = cancelled). */
  pickFolderResolves: (path: string | null) => void;
  /** Simulate a scan_progress event from Rust. */
  emitScanProgress: (foundSoFar: number) => void;
  /** Simulate a scan_complete event from Rust. */
  emitScanComplete: (photos: PhotoInfo[]) => void;
  /** Simulate a scan_error event from Rust. */
  emitScanError: (message: string) => void;
}

export function createMockTauriApi(): MockTauriApi {
  let nextFolder: string | null = null;
  const handlers: Record<string, EventHandler[]> = {};

  const api: TauriApi = {
    invoke: async (cmd) => {
      if (cmd === "pick_folder") {
        return nextFolder;
      }
      if (cmd === "start_scan") {
        // Intentionally does nothing — tests drive scan events manually.
        return;
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    },

    listen: async (event, handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      // Return an unlisten function.
      return () => {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      };
    },
  };

  const emit = (event: string, payload: unknown) => {
    (handlers[event] ?? []).forEach((h) => h(payload));
  };

  return {
    api,
    pickFolderResolves: (path) => { nextFolder = path; },
    emitScanProgress: (foundSoFar) =>
      emit("scan_progress", { found_so_far: foundSoFar } satisfies ScanProgressPayload),
    emitScanComplete: (photos) =>
      emit("scan_complete", { photos } satisfies ScanCompletePayload),
    emitScanError: (message) =>
      emit("scan_error", { message } satisfies ScanErrorPayload),
  };
}
