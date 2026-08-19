import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import App from "../App";
import { makeFile, mockOccurrences } from "./factories";
import type { MetadataOccurrence, MetadataTargetDraftEntry } from "../types";

type SessionSnapshot = {
  session_id: number | null;
  revision: number;
  lifecycle: "idle" | "opening" | "loaded" | "closing";
  folder: string | null;
  files: ReturnType<typeof makeFile>[];
  discovery_running: boolean;
  issues: Array<{
    issue_id: number;
    severity: string;
    error_type: string;
    error_message: string;
    affected_files: string[];
  }>;
  metadata: Array<{ relative_path: string; state: unknown }>;
  thumbnails: Array<{ relative_path: string; state: unknown }>;
  drafts: Record<string, MetadataTargetDraftEntry[]>;
  draft_persistence:
    | { status: "loading" }
    | { status: "ready" }
    | { status: "load-failed"; error: string }
    | { status: "save-failed"; error: string };
};
let nextSessionId = 1;
let sessionDraftsOnOpen: SessionSnapshot["drafts"] = {};
let sessionDraftPersistenceOnOpen: SessionSnapshot["draft_persistence"] = {
  status: "ready",
};
let sessionSnapshot: SessionSnapshot = {
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
function resetSessionMock(): void {
  nextSessionId = 1;
  sessionDraftsOnOpen = {};
  sessionDraftPersistenceOnOpen = { status: "ready" };
  sessionSnapshot = {
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
}

function emitSessionFiles(
  emit: (event: string, payload: unknown) => void,
  sessionId: number,
  files: ReturnType<typeof makeFile>[],
): void {
  if (sessionId !== sessionSnapshot.session_id) return;
  sessionSnapshot = {
    ...sessionSnapshot,
    revision: sessionSnapshot.revision + 1,
    files: [...sessionSnapshot.files, ...files],
    metadata: [
      ...sessionSnapshot.metadata,
      ...files.map((file) => ({
        relative_path: file.relative_path,
        state: { status: "loading" as const },
      })),
    ],
  };
  emit("media_library_session_files_added", {
    session_id: sessionId,
    revision: sessionSnapshot.revision,
    files,
  });
}

function emitSessionMetadata(
  emit: (event: string, payload: unknown) => void,
  payload: {
    scan_id: number;
    results: Array<{
      relative_path: string;
      occurrences: unknown[];
      metadata?: unknown;
    }>;
  },
): void {
  if (payload.scan_id !== sessionSnapshot.session_id) return;
  const entries = payload.results.map((result) => ({
    relative_path: result.relative_path,
    state: { status: "ready" as const, occurrences: result.occurrences },
  }));
  sessionSnapshot = {
    ...sessionSnapshot,
    revision: sessionSnapshot.revision + 1,
    metadata: [
      ...sessionSnapshot.metadata.filter(
        (existing) =>
          !entries.some(
            (entry) => entry.relative_path === existing.relative_path,
          ),
      ),
      ...entries,
    ],
  };
  emit("media_library_session_metadata_changed", {
    session_id: payload.scan_id,
    revision: sessionSnapshot.revision,
    entries,
  });
}

function handleSessionCommand(
  cmd: string,
  args?: unknown,
): Promise<SessionSnapshot> | undefined {
  if (cmd === "get_media_library_session_snapshot") {
    return Promise.resolve({ ...sessionSnapshot });
  }
  if (cmd === "open_media_library_session") {
    sessionSnapshot = {
      session_id: nextSessionId++,
      revision: sessionSnapshot.revision + 1,
      lifecycle: "opening",
      folder: (args as { folderPath: string }).folderPath,
      files: [],
      discovery_running: false,
      issues: [],
      metadata: [],
      thumbnails: [],
      drafts: sessionDraftsOnOpen,
      draft_persistence: sessionDraftPersistenceOnOpen,
    };
    return Promise.resolve({ ...sessionSnapshot });
  }
  if (cmd === "close_media_library_session") {
    sessionSnapshot = {
      session_id: null,
      revision: sessionSnapshot.revision + 2,
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
    return Promise.resolve({ ...sessionSnapshot });
  }
  return undefined;
}

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe("App schema preloading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMock();
  });

  it("shows schema loading dialog before preload_schema resolves", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    let resolvePreload!: () => void;
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") {
        return new Promise<void>((res) => {
          resolvePreload = res;
        });
      }
      return Promise.resolve(null);
    });

    render(<App />);

    expect(screen.getByTestId("schema-loading-dialog")).toBeInTheDocument();
    expect(screen.getByText("Loading schema…")).toBeInTheDocument();

    resolvePreload();
    await waitFor(() => {
      expect(
        screen.queryByTestId("schema-loading-dialog"),
      ).not.toBeInTheDocument();
    });
  });

  it("dismisses schema loading dialog after preload_schema resolves", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") return Promise.resolve();
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(<App />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("schema-loading-dialog"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows schema error dialog with Settings recovery when preload_schema fails", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const backendError = {
      kind: "exiftool_failed",
      command: "exiftool -config /tmp/mlib.ExifTool_config -ver",
      stdout: "",
      stderr: "No such file or directory (os error 2)",
    };
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") return Promise.reject(backendError);
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(<App />);

    // Loading dialog goes away, error dialog appears.
    await waitFor(() => {
      expect(
        screen.queryByTestId("schema-loading-dialog"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("schema-error-dialog")).toBeInTheDocument();
    });

    // Keeps the command and process output visually separate.
    expect(screen.getByTestId("schema-error-command")).toHaveTextContent(
      "exiftool -config /tmp/mlib.ExifTool_config -ver",
    );
    expect(screen.getByTestId("schema-error-stdout")).toHaveTextContent(
      "(no output)",
    );
    expect(screen.getByTestId("schema-error-stderr")).toHaveTextContent(
      "No such file or directory (os error 2)",
    );

    // Offers an in-app recovery route rather than requiring a restart.
    const dialog = screen.getByTestId("schema-error-dialog");
    expect(dialog).toHaveTextContent(/exiftool/i);
    expect(dialog).toHaveTextContent(/Open Settings/i);
    expect(dialog).toHaveTextContent(/retry schema loading/i);
    expect(dialog.textContent ?? "").not.toMatch(/restart/i);
    expect(screen.getByTestId("schema-error-settings-btn")).toBeInTheDocument();

    expect(consoleError).toHaveBeenCalledWith(
      "[App] preload_schema failed:",
      backendError,
    );

    consoleError.mockRestore();
  });

  it("updates the attempted command when a corrected ExifTool path also fails", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let preloadCalls = 0;

    const settings = {
      exiftool_command: "exiftool",
      openai_api_key: "",
      openai_model: "gpt-5.4",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 4,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 32,
      metadata_apply_concurrency: 8,
      thumbnail_concurrency: 8,
    };
    const firstError = {
      kind: "exiftool_failed",
      command: "exiftool -config /tmp/mlib.ExifTool_config -ver",
      stdout: "",
      stderr: "missing executable",
    };
    const retryError = {
      kind: "exiftool_failed",
      command:
        "/opt/homebrew/bin/exiftool -config /tmp/mlib.ExifTool_config -ver",
      stdout: "partial output",
      stderr: "permission denied",
    };

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") {
        preloadCalls += 1;
        return Promise.reject(preloadCalls === 1 ? firstError : retryError);
      }
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      if (cmd === "load_settings_cmd") return Promise.resolve({ ...settings });
      if (cmd === "list_recommended_models") return Promise.resolve([]);
      if (cmd === "save_settings_cmd") return Promise.resolve();
      return Promise.resolve(null);
    });

    render(<App />);

    let commandBlock = await screen.findByTestId("schema-error-command");
    expect(commandBlock).toHaveTextContent(
      "exiftool -config /tmp/mlib.ExifTool_config -ver",
    );

    fireEvent.click(screen.getByTestId("schema-error-settings-btn"));
    const input = await screen.findByTestId("settings-exiftool-command-input");
    fireEvent.change(input, {
      target: { value: "/opt/homebrew/bin/exiftool" },
    });
    fireEvent.blur(input);

    await waitFor(() => expect(preloadCalls).toBe(2));
    commandBlock = await screen.findByTestId("schema-error-command");
    expect(commandBlock).toHaveTextContent(
      "/opt/homebrew/bin/exiftool -config /tmp/mlib.ExifTool_config -ver",
    );
    expect(screen.getByTestId("schema-error-stdout")).toHaveTextContent(
      "partial output",
    );
    expect(screen.getByTestId("schema-error-stderr")).toHaveTextContent(
      "permission denied",
    );

    consoleError.mockRestore();
  });

  it("opens Settings from schema failure and retries after saving ExifTool path", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let preloadCalls = 0;

    const settings = {
      exiftool_command: "exiftool",
      openai_api_key: "",
      openai_model: "gpt-5.4",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 4,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 32,
      metadata_apply_concurrency: 8,
      thumbnail_concurrency: 8,
    };

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") {
        preloadCalls += 1;
        return preloadCalls === 1
          ? Promise.reject({
              kind: "exiftool_failed",
              command: "exiftool -ver",
              stdout: "",
              stderr: "missing executable",
            })
          : Promise.resolve();
      }
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      if (cmd === "load_settings_cmd") return Promise.resolve({ ...settings });
      if (cmd === "list_recommended_models") return Promise.resolve([]);
      if (cmd === "save_settings_cmd") return Promise.resolve();
      return Promise.resolve(null);
    });

    render(<App />);

    await screen.findByTestId("schema-error-dialog");
    fireEvent.click(screen.getByTestId("schema-error-settings-btn"));

    const input = await screen.findByTestId("settings-exiftool-command-input");
    fireEvent.change(input, {
      target: { value: "/opt/homebrew/bin/exiftool" },
    });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(preloadCalls).toBe(2);
      expect(
        screen.queryByTestId("schema-error-dialog"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("schema-loading-dialog"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("settings-dialog")).not.toBeInTheDocument();
    });

    expect(mockInvoke).toHaveBeenCalledWith("save_settings_cmd", {
      settingsData: expect.objectContaining({
        exiftool_command: "/opt/homebrew/bin/exiftool",
      }),
    });

    consoleError.mockRestore();
  });
});

describe("App CLI folder argument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMock();
  });

  it("opens folder from CLI argument on mount", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    // Mock get_cli_folder to return a folder path
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "get_cli_folder") {
        return Promise.resolve("D:\\Files\\2024");
      }
      if (cmd === "start_scan") {
        return Promise.resolve();
      }
      if (cmd === "get_tag_infos") return Promise.resolve([]);
      if (cmd === "load_metadata_draft_edits") return Promise.resolve({});
      return Promise.resolve(null);
    });

    render(<App />);

    // Wait for the CLI folder to be processed
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_cli_folder");
    });

    // Verify start_scan was called with the CLI folder
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_scan",
        expect.objectContaining({
          folderPath: "D:\\Files\\2024",
        }),
      );
    });

    // Should show loading state, not welcome screen
    await waitFor(() => {
      expect(screen.queryByText("Media Library")).not.toBeInTheDocument();
      expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    });
  });

  it("shows welcome screen when no CLI argument provided", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    // Mock get_cli_folder to return null (no CLI argument)
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "get_cli_folder") {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    render(<App />);

    // Wait for the CLI check to complete
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_cli_folder");
    });

    // Should show welcome screen
    await waitFor(() => {
      expect(screen.getByText("Media Library")).toBeInTheDocument();
      expect(screen.getByTestId("open-folder-btn")).toBeInTheDocument();
    });

    // Should NOT call start_scan
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "start_scan",
      expect.anything(),
    );
  });

  it("handles CLI folder error gracefully", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Mock get_cli_folder to throw an error
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "get_cli_folder") {
        return Promise.reject(new Error("Failed to get CLI folder"));
      }
      return Promise.resolve(null);
    });

    render(<App />);

    // Wait for error to be logged
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "[App] Failed to get CLI folder:",
        expect.any(Error),
      );
    });

    // Should still show welcome screen
    await waitFor(() => {
      expect(screen.getByText("Media Library")).toBeInTheDocument();
    });

    consoleError.mockRestore();
  });

  it("only processes CLI argument once", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "get_cli_folder") {
        return Promise.resolve("D:\\Files\\2024");
      }
      if (cmd === "start_scan") {
        return Promise.resolve();
      }
      if (cmd === "load_metadata_draft_edits") return Promise.resolve({});
      return Promise.resolve(null);
    });

    const { rerender } = render(<App />);

    // Wait for initial CLI processing
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_cli_folder");
    });

    const initialCallCount = mockInvoke.mock.calls.filter(
      (call) => call[0] === "get_cli_folder",
    ).length;

    // Force a re-render and allow all resulting updates to settle.
    await act(async () => {
      rerender(<App />);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Should not call get_cli_folder again
    const finalCallCount = mockInvoke.mock.calls.filter(
      (call) => call[0] === "get_cli_folder",
    ).length;

    expect(finalCallCount).toBe(initialCallCount);
  });
});

describe("App Select Columns metadata counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMock();
    localStorage.clear();
  });

  it("shows a draft-aware effective metadata key count", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    const mockInvoke = vi.mocked(invoke);
    const mockListen = vi.mocked(listen);
    const handlers: Record<
      string,
      Array<(event: { payload: unknown }) => void>
    > = {};

    mockListen.mockImplementation((event, handler) => {
      const callback = handler as (event: { payload: unknown }) => void;
      handlers[event] ??= [];
      handlers[event].push(callback);
      return Promise.resolve(() => {
        handlers[event] = handlers[event].filter((h) => h !== callback);
      });
    });

    const emit = (event: string, payload: unknown) => {
      for (const handler of handlers[event] ?? []) handler({ payload });
    };
    sessionDraftsOnOpen = {
      "b.jpg": [
        {
          target: {
            kind: "NewProperty",
            schema_id: { table: "XMP::dc", tag_id: "title" },
            write_target: {
              group1: "XMP-test",
              group7: "ID-Test",
              tag_name: "TestTag",
            },
          },
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "Draft title" },
          },
        },
      ],
    };

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") return Promise.resolve();
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      if (cmd === "pick_folder") return Promise.resolve("/files");
      if (cmd === "load_metadata_draft_edits") {
        return Promise.resolve({
          "b.jpg": [
            {
              target: {
                kind: "NewProperty",
                schema_id: { table: "XMP::dc", tag_id: "title" },
                write_target: {
                  group1: "XMP-test",
                  group7: "ID-Test",
                  tag_name: "TestTag",
                },
              },
              edit: {
                intent: "Set",
                value: { kind: "Text", value: "Draft title" },
              },
            },
          ],
        });
      }
      if (cmd === "get_tag_info") {
        const id = (args as { id: { table: string; tag_id: string } }).id;
        return Promise.resolve({
          id,
          group: id.table === "XMP::dc" ? "XMP-dc" : id.table,
          name: id.tag_id === "title" ? "Title" : id.tag_id,
          writable: true,
          kind: { kind: "Text" },
          description: null,
        });
      }
      if (cmd === "get_tag_infos") {
        const ids = (args as { ids: Array<{ table: string; tag_id: string }> })
          .ids;
        return Promise.resolve(
          ids.map((id) => ({
            id,
            group: id.table === "XMP::dc" ? "XMP-dc" : id.table,
            name: id.tag_id === "title" ? "Title" : id.tag_id,
            writable: true,
            kind: { kind: "Text" },
            description: null,
          })),
        );
      }
      if (cmd === "stop_scan") return Promise.resolve();
      if (cmd === "start_scan") return Promise.resolve();
      if (cmd === "prioritize_queues") return Promise.resolve();
      if (cmd === "set_window_title") return Promise.resolve();
      if (cmd === "list_writable_schema_definitions")
        return Promise.resolve([]);
      throw new Error(`Unexpected invoke: ${cmd} ${JSON.stringify(args)}`);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("open-folder-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("open-folder-btn"));
    });

    let scanId = 0;
    await waitFor(() => {
      const startCall = mockInvoke.mock.calls.find(
        ([cmd]) => cmd === "start_scan",
      );
      expect(startCall).toBeTruthy();
      scanId = (startCall?.[1] as { scanId: number }).scanId;
    });

    act(() => {
      emitSessionFiles(emit, scanId, [
        makeFile({ relative_path: "a.jpg" }),
        makeFile({ relative_path: "b.jpg" }),
      ]);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(2);
      expect(screen.getByTestId("status-bar-draft-summary")).toHaveTextContent(
        "1 file",
      );
    });

    act(() => {
      emitSessionMetadata(emit, {
        scan_id: scanId,
        results: [
          {
            relative_path: "a.jpg",
            occurrences: mockOccurrences({
              "XMP-dc:Title": "Committed title",
            }),
          },
          { relative_path: "b.jpg", occurrences: [] },
        ],
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("menu-bar-columns-btn"));
    });

    await waitFor(() => {
      expect(
        screen.getByText("XMP-dc:Title").closest("label"),
      ).toHaveTextContent("(2 files)");
    });
  });

  it("updates Select Columns counts while the dialog is open and streaming metadata arrives", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    const mockInvoke = vi.mocked(invoke);
    const mockListen = vi.mocked(listen);
    const handlers: Record<
      string,
      Array<(event: { payload: unknown }) => void>
    > = {};

    mockListen.mockImplementation((event, handler) => {
      const callback = handler as (event: { payload: unknown }) => void;
      handlers[event] ??= [];
      handlers[event].push(callback);
      return Promise.resolve(() => {
        handlers[event] = handlers[event].filter((h) => h !== callback);
      });
    });

    const emit = (event: string, payload: unknown) => {
      for (const handler of handlers[event] ?? []) handler({ payload });
    };

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") return Promise.resolve();
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      if (cmd === "pick_folder") return Promise.resolve("/files");
      if (cmd === "load_metadata_draft_edits") return Promise.resolve({});
      if (cmd === "get_tag_info") {
        const id = (args as { id: { table: string; tag_id: string } }).id;
        return Promise.resolve({
          id,
          group: id.table === "XMP::dc" ? "XMP-dc" : id.table,
          name: id.tag_id === "title" ? "Title" : id.tag_id,
          writable: true,
          kind: { kind: "Text" },
          description: null,
        });
      }
      if (cmd === "get_tag_infos") {
        const ids = (args as { ids: Array<{ table: string; tag_id: string }> })
          .ids;
        return Promise.resolve(
          ids.map((id) => ({
            id,
            group: id.table === "XMP::dc" ? "XMP-dc" : id.table,
            name: id.tag_id === "title" ? "Title" : id.tag_id,
            writable: true,
            kind: { kind: "Text" },
            description: null,
          })),
        );
      }
      if (cmd === "stop_scan") return Promise.resolve();
      if (cmd === "start_scan") return Promise.resolve();
      if (cmd === "prioritize_queues") return Promise.resolve();
      if (cmd === "set_window_title") return Promise.resolve();
      if (cmd === "list_writable_schema_definitions")
        return Promise.resolve([]);
      throw new Error(`Unexpected invoke: ${cmd} ${JSON.stringify(args)}`);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("open-folder-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("open-folder-btn"));
    });

    let scanId = 0;
    await waitFor(() => {
      const startCall = mockInvoke.mock.calls.find(
        ([cmd]) => cmd === "start_scan",
      );
      expect(startCall).toBeTruthy();
      scanId = (startCall?.[1] as { scanId: number }).scanId;
    });

    // 1. Load/open a folder with two files.
    act(() => {
      emitSessionFiles(emit, scanId, [
        makeFile({ relative_path: "a.jpg" }),
        makeFile({ relative_path: "b.jpg" }),
      ]);
    });

    await waitFor(
      () => {
        expect(screen.getAllByTestId("file-row")).toHaveLength(2);
      },
      { timeout: 10000 },
    );

    // 2. Open Select Columns before emitting any `file_metadata_ready` event.
    await act(async () => {
      fireEvent.click(screen.getByTestId("menu-bar-columns-btn"));
    });

    // 3. Confirm `XMP-dc:Title` is not shown or has no count yet.
    await waitFor(
      () => {
        expect(screen.getByText("Select Columns")).toBeInTheDocument();
      },
      { timeout: 10000 },
    );
    expect(screen.queryByText("XMP-dc:Title")).not.toBeInTheDocument();

    // 4. Emit an `file_metadata_ready` event for one file containing `XMP-dc:Title`.
    act(() => {
      emitSessionMetadata(emit, {
        scan_id: scanId,
        results: [
          {
            relative_path: "a.jpg",
            occurrences: mockOccurrences({ "XMP-dc:Title": "Title A" }),
          },
        ],
      });
    });

    // 5. Wait for the UI to update.
    // 6. Assert `XMP-dc:Title` appears with `(1 files)`.
    await waitFor(
      () => {
        expect(
          screen.getByText("XMP-dc:Title").closest("label"),
        ).toHaveTextContent("(1 files)");
      },
      { timeout: 10000 },
    );

    // 7. Emit another `file_metadata_ready` event or batch for the second file also containing `XMP-dc:Title`.
    act(() => {
      emitSessionMetadata(emit, {
        scan_id: scanId,
        results: [
          {
            relative_path: "b.jpg",
            occurrences: mockOccurrences({ "XMP-dc:Title": "Title B" }),
          },
        ],
      });
    });

    // Wait for the 200ms debounce of file_metadata_ready to fire inside act
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    // 8. Wait for the UI to update.
    // 9. Assert the count changes to `(2 files)` while the dialog is still open.
    await waitFor(
      () => {
        expect(
          screen.getByText("XMP-dc:Title").closest("label"),
        ).toHaveTextContent("(2 files)");
      },
      { timeout: 10000 },
    );
  });
});

describe("App occurrence wiring regression", () => {
  it("carries unique and identical-duplicate payloads through scan stores into Gallery details", async () => {
    vi.clearAllMocks();
    resetSessionMock();
    localStorage.clear();
    localStorage.setItem("media_library_gallery_details_visible", "1");
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    const mockInvoke = vi.mocked(invoke);
    const handlers: Record<
      string,
      Array<(event: { payload: unknown }) => void>
    > = {};
    vi.mocked(listen).mockImplementation((event, handler) => {
      const callback = handler as (event: { payload: unknown }) => void;
      handlers[event] ??= [];
      handlers[event].push(callback);
      return Promise.resolve(() => {});
    });
    const emit = (event: string, payload: unknown) => {
      for (const handler of handlers[event] ?? []) handler({ payload });
    };
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      const sessionResult = handleSessionCommand(cmd, args);
      if (sessionResult) return sessionResult;
      if (cmd === "preload_schema") return Promise.resolve();
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      if (cmd === "pick_folder") return Promise.resolve("/files");
      if (cmd === "load_metadata_draft_edits") return Promise.resolve({});
      if (cmd === "get_tag_infos") return Promise.resolve([]);
      if (cmd === "get_tag_info") return Promise.resolve(null);
      if (
        [
          "stop_scan",
          "start_scan",
          "prioritize_queues",
          "set_window_title",
        ].includes(cmd)
      ) {
        return Promise.resolve();
      }
      return Promise.resolve(null);
    });

    render(<App />);
    await waitFor(() => screen.getByTestId("open-folder-btn"));
    fireEvent.click(screen.getByTestId("open-folder-btn"));
    let scanId = 0;
    await waitFor(() => {
      const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "start_scan");
      expect(call).toBeTruthy();
      scanId = (call?.[1] as { scanId: number }).scanId;
    });
    act(() => {
      emitSessionFiles(emit, scanId, [
        makeFile({ relative_path: "unique.jpg" }),
        makeFile({ relative_path: "duplicate.jpg" }),
      ]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(2);
    });

    const info = {
      id: { table: "Exif::Main", tag_id: "282" },
      group: "IFD0",
      name: "XResolution",
      writable: true,
      kind: {
        kind: "Integer" as const,
        data: { min: null, max: null },
      },
      description: null,
    };
    const uniqueOccurrence: MetadataOccurrence = {
      id: {
        document: null,
        path: "JPEG-APP1-IFD0",
        runtime_tag_id: "282",
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: "282",
          index: null,
        },
        copy: 0,
      },
      schema_id: info.id,
      value: { kind: "Integer", value: 301 },
      tag_info: info,
      observed_selector: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "XResolution",
      },
      write_target: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "XResolution",
      },
    };
    const duplicateOccurrences: MetadataOccurrence[] = [
      {
        id: {
          document: null,
          path: "JPEG-APP1-IFD0",
          runtime_tag_id: "282",
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: "282",
            index: null,
          },
          copy: 0,
        },
        schema_id: info.id,
        value: { kind: "Integer", value: 300 },
        tag_info: info,
        observed_selector: {
          group1: "IFD0",
          group7: "ID-Test",
          tag_name: "XResolution",
        },
        write_target: {
          group1: "IFD0",
          group7: "ID-Test",
          tag_name: "XResolution",
        },
      },
      {
        id: {
          document: null,
          path: "JPEG-APP1-IFD1",
          runtime_tag_id: "282",
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: "282",
            index: null,
          },
          copy: 2,
        },
        schema_id: info.id,
        value: { kind: "Integer", value: 300 },
        tag_info: info,
        observed_selector: {
          group1: "IFD1",
          group7: "ID-Test",
          tag_name: "XResolution",
        },
        write_target: {
          group1: "IFD1",
          group7: "ID-Test",
          tag_name: "XResolution",
        },
      },
    ];
    act(() => {
      emitSessionMetadata(emit, {
        scan_id: scanId,
        results: [
          {
            relative_path: "unique.jpg",
            occurrences: [uniqueOccurrence],
            metadata: [{ id: info.id, value: { kind: "Integer", value: 300 } }],
          },
          {
            relative_path: "duplicate.jpg",
            occurrences: duplicateOccurrences,
            metadata: [{ id: info.id, value: { kind: "Integer", value: 300 } }],
          },
        ],
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    fireEvent.doubleClick(screen.getAllByTestId("file-row")[0]);

    await waitFor(() => {
      expect(screen.getByText("301")).toBeInTheDocument();
    });
    const uniqueRows = screen
      .getAllByTestId("details-row")
      .filter((row) => row.dataset.rowKind === "ExistingOccurrenceRow");
    expect(uniqueRows).toHaveLength(1);
    fireEvent.contextMenu(uniqueRows[0]);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);

    fireEvent.click(screen.getByTestId("gallery-next-btn"));
    await screen.findByTestId("details-section-IFD1");
    expect(
      screen.queryByText("Additional Metadata Occurrences"),
    ).not.toBeInTheDocument();
    const duplicateRows = screen
      .getAllByTestId("details-row")
      .filter((row) => row.dataset.rowKind === "ExistingOccurrenceRow");
    expect(duplicateRows).toHaveLength(2);
    expect(screen.getByTestId("details-section-IFD0")).toHaveTextContent("300");
    expect(screen.getByTestId("details-section-IFD1")).toHaveTextContent("300");
    expect(screen.queryByTestId("error-banner")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("status-bar-metadata-spinner"),
    ).not.toBeInTheDocument();
    for (const row of duplicateRows) {
      fireEvent.contextMenu(row);
      expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
    }
  });
});
