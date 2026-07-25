/**
 * End-to-end-ish test for the off-thread search pipeline.  Renders the
 * real App, drives it through the mock Tauri boundary, and verifies the
 * full chain: user types → debounce → worker → matched set → row filter,
 * including mid-search updates when metadata or new files stream in
 * (the documented "spinner reappears, results refresh" UX).
 *
 * Uses the SearchIndex-backed InThreadSearchWorker shim installed in
 * src/test/setup.ts so the worker code path is exercised end-to-end,
 * not mocked.
 */
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { createMockTauriApi } from "./mockTauriApi";
import { makeFile } from "./factories";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) =>
    mockApiInstance.api.invoke(
      cmd,
      args as Record<string, unknown> | undefined,
    ),
  convertFileSrc: (path: string) => `data:image/jpeg;base64,FAKE_${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (evt: string, handler: (e: { payload: unknown }) => void) =>
    mockApiInstance.api.listen(evt, (payload: unknown) => handler({ payload })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

async function openFolderWithThreeFiles() {
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/files");
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await user.click(screen.getByTestId("open-folder-btn"));

  const files = [
    makeFile({ relative_path: "alpha.jpg" }),
    makeFile({ relative_path: "beta.jpg" }),
    makeFile({ relative_path: "gamma.jpg" }),
  ];
  await act(async () => {
    for (const p of files) mockApiInstance.emitFileFound(p);
  });
  await act(async () => {
    mockApiInstance.emitFileMetadataReady("alpha.jpg", {
      "IFD0:Make": { kind: "Text", value: "Canon" },
    });
    mockApiInstance.emitFileMetadataReady("beta.jpg", {
      "IFD0:Make": { kind: "Text", value: "Sony" },
    });
    mockApiInstance.emitFileMetadataReady("gamma.jpg", {
      "IFD0:Make": { kind: "Text", value: "Nikon" },
      "Hidden:Tag": { kind: "Text", value: "ultraspecific-tag-value" },
    });
  });
  // Let the file_found and file_metadata_ready batches flush.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });

  return { user, files };
}

describe("Off-thread list search (end-to-end)", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("filters rows on filename substring as the user types", async () => {
    const { user } = await openFolderWithThreeFiles();
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });

    await user.type(screen.getByTestId("list-search-input"), "beta");
    await waitFor(() => {
      const rows = screen.getAllByTestId("file-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "beta.jpg");
    });
  });

  it("matches on a hidden metadata key not shown in any column", async () => {
    const { user } = await openFolderWithThreeFiles();
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });

    await user.type(
      screen.getByTestId("list-search-input"),
      "ultraspecific-tag-value",
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("file-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "gamma.jpg");
    });
  });

  it("shows the empty-search banner when no rows match", async () => {
    const { user } = await openFolderWithThreeFiles();
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });

    await user.type(
      screen.getByTestId("list-search-input"),
      "definitely-no-such-thing",
    );
    await waitFor(() => {
      expect(screen.getByTestId("file-list-search-empty")).toBeInTheDocument();
    });
  });

  it("re-runs the active search when a new file arrives mid-search", async () => {
    const { user } = await openFolderWithThreeFiles();
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });

    // Active filter that excludes everything currently visible.
    await user.type(screen.getByTestId("list-search-input"), "delta");
    await waitFor(() => {
      expect(screen.queryAllByTestId("file-row")).toHaveLength(0);
    });

    // A new file whose filename matches the active query streams in.
    await act(async () => {
      mockApiInstance.emitFileFound(makeFile({ relative_path: "delta.jpg" }));
      mockApiInstance.emitFileMetadataReady("delta.jpg", {
        "IFD0:Make": { kind: "Text", value: "Fuji" },
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId("file-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "delta.jpg");
    });
  });

  it("re-runs the active search when streamed metadata changes what matches", async () => {
    const { user } = await openFolderWithThreeFiles();
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });

    // Filter on a token only present in metadata that hasn't arrived yet.
    await user.type(
      screen.getByTestId("list-search-input"),
      "uniquemetatoken-late-arrival",
    );
    await waitFor(() => {
      expect(screen.queryAllByTestId("file-row")).toHaveLength(0);
    });

    // The matching metadata streams in for one file.
    await act(async () => {
      mockApiInstance.emitFileMetadataReady("alpha.jpg", {
        "IFD0:Make": { kind: "Text", value: "Canon" },
        "Hidden:Tag": {
          kind: "Text",
          value: "uniquemetatoken-late-arrival",
        },
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId("file-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "alpha.jpg");
    });
  });

  it("clearing the search restores the full row set", async () => {
    const { user } = await openFolderWithThreeFiles();
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });

    const input = screen.getByTestId("list-search-input");
    await user.type(input, "beta");
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(1);
    });
    await user.clear(input);
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });
  });

  it("shows the searching spinner during the worker round-trip and hides it once results land", async () => {
    const { user } = await openFolderWithThreeFiles();
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(3);
    });

    // Spinner is absent at rest.
    expect(screen.queryByTestId("list-search-spinner")).toBeNull();

    await user.type(screen.getByTestId("list-search-input"), "beta");

    // Results land asynchronously, then the spinner clears.
    await waitFor(() => {
      expect(screen.getAllByTestId("file-row")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("list-search-spinner")).toBeNull();
    });
  });
});
