import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import App from "../App";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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
        return new Promise<void>((res) => { resolvePreload = res; });
      }
      return Promise.resolve(null);
    });

    render(<App />);

    expect(screen.getByTestId("schema-loading-dialog")).toBeInTheDocument();

    resolvePreload();
    await waitFor(() => {
      expect(screen.queryByTestId("schema-loading-dialog")).not.toBeInTheDocument();
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
      expect(screen.queryByTestId("schema-loading-dialog")).not.toBeInTheDocument();
    });
  });

  it("dismisses schema loading dialog even when preload_schema fails", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "preload_schema") return Promise.reject(new Error("schema build failed"));
      if (cmd === "get_cli_folder") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("schema-loading-dialog")).not.toBeInTheDocument();
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[App] preload_schema failed:",
      expect.any(Error),
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
        })
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
      expect.anything()
    );
  });

  it("handles CLI folder error gracefully", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    
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
        expect.any(Error)
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
      call => call[0] === "get_cli_folder"
    ).length;

    // Force a re-render
    rerender(<App />);

    // Wait a bit to ensure no additional calls
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should not call get_cli_folder again
    const finalCallCount = mockInvoke.mock.calls.filter(
      call => call[0] === "get_cli_folder"
    ).length;

    expect(finalCallCount).toBe(initialCallCount);
  });
});
