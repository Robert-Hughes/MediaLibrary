import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import App from "../App";
import { makePhoto, mockDrafts, mockMetadataEntries } from "./factories";

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
  });

  it("shows schema loading dialog before preload_schema resolves", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    let resolvePreload!: () => void;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "preload_schema") {
        return new Promise<void>((res) => {
          resolvePreload = res;
        });
      }
      return Promise.resolve(null);
    });

    render(<App />);

    expect(screen.getByTestId("schema-loading-dialog")).toBeInTheDocument();

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

    mockInvoke.mockImplementation((cmd: string) => {
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

  it("shows schema error dialog with PATH guidance when preload_schema fails", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const backendError =
      "exiftool not found: No such file or directory (os error 2)";
    mockInvoke.mockImplementation((cmd: string) => {
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

    // Surfaces the actual backend error message to the user.
    expect(screen.getByTestId("schema-error-message")).toHaveTextContent(
      backendError,
    );

    // Tells the user to put exiftool on PATH (no mention of settings).
    const dialog = screen.getByTestId("schema-error-dialog");
    expect(dialog).toHaveTextContent(/exiftool/i);
    expect(dialog).toHaveTextContent(/PATH/);
    expect(dialog.textContent ?? "").not.toMatch(/settings/i);

    expect(consoleError).toHaveBeenCalledWith(
      "[App] preload_schema failed:",
      backendError,
    );

    consoleError.mockRestore();
  });
});

describe("App CLI folder argument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens folder from CLI argument on mount", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    // Mock get_cli_folder to return a folder path
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_cli_folder") {
        return Promise.resolve("D:\\Photos\\2024");
      }
      if (cmd === "start_scan") {
        return Promise.resolve();
      }
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
          folderPath: "D:\\Photos\\2024",
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
    mockInvoke.mockImplementation((cmd: string) => {
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
    mockInvoke.mockImplementation((cmd: string) => {
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

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_cli_folder") {
        return Promise.resolve("D:\\Photos\\2024");
      }
      if (cmd === "start_scan") {
        return Promise.resolve();
      }
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

    // Force a re-render
    rerender(<App />);

    // Wait a bit to ensure no additional calls
    await new Promise((resolve) => setTimeout(resolve, 100));

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

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "preload_schema") return Promise.resolve();
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      if (cmd === "pick_folder") return Promise.resolve("/photos");
      if (cmd === "load_metadata_draft_edits") {
        return Promise.resolve({
          "b.jpg": Object.values(
            mockDrafts({
              "XMP-dc:Title": {
                intent: "Set",
                value: { kind: "Text", value: "Draft title" },
              },
            }),
          ),
        });
      }
      if (cmd === "stop_scan") return Promise.resolve();
      if (cmd === "start_scan") return Promise.resolve();
      if (cmd === "prioritize_queues") return Promise.resolve();
      if (cmd === "set_window_title") return Promise.resolve();
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
      emit("photo_found", {
        scan_id: scanId,
        photos: [
          makePhoto({ relative_path: "a.jpg" }),
          makePhoto({ relative_path: "b.jpg" }),
        ],
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(2);
      expect(screen.getByTestId("status-bar-draft-summary")).toHaveTextContent(
        "1 file",
      );
    });

    act(() => {
      emit("image_metadata_ready", {
        scan_id: scanId,
        results: [
          {
            relative_path: "a.jpg",
            occurrences: [],
            metadata: mockMetadataEntries({
              "XMP-dc:Title": "Committed title",
            }),
          },
          { relative_path: "b.jpg", metadata: [] },
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
      if (cmd === "preload_schema") return Promise.resolve();
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      if (cmd === "pick_folder") return Promise.resolve("/photos");
      if (cmd === "load_metadata_draft_edits") {
        return Promise.resolve({});
      }
      if (cmd === "stop_scan") return Promise.resolve();
      if (cmd === "start_scan") return Promise.resolve();
      if (cmd === "prioritize_queues") return Promise.resolve();
      if (cmd === "set_window_title") return Promise.resolve();
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

    // 1. Load/open a folder with two photos.
    act(() => {
      emit("photo_found", {
        scan_id: scanId,
        photos: [
          makePhoto({ relative_path: "a.jpg" }),
          makePhoto({ relative_path: "b.jpg" }),
        ],
      });
    });

    await waitFor(
      () => {
        expect(screen.getAllByTestId("photo-row")).toHaveLength(2);
      },
      { timeout: 10000 },
    );

    // 2. Open Select Columns before emitting any `image_metadata_ready` event.
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

    // 4. Emit an `image_metadata_ready` event for one photo containing `XMP-dc:Title`.
    act(() => {
      emit("image_metadata_ready", {
        scan_id: scanId,
        results: [
          {
            relative_path: "a.jpg",
            occurrences: [],
            metadata: mockMetadataEntries({ "XMP-dc:Title": "Title A" }),
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

    // 7. Emit another `image_metadata_ready` event or batch for the second photo also containing `XMP-dc:Title`.
    act(() => {
      emit("image_metadata_ready", {
        scan_id: scanId,
        results: [
          {
            relative_path: "b.jpg",
            occurrences: [],
            metadata: mockMetadataEntries({ "XMP-dc:Title": "Title B" }),
          },
        ],
      });
    });

    // Wait for the 200ms debounce of image_metadata_ready to fire inside act
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
