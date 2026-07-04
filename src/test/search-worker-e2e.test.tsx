/**
 * End-to-end-ish test for the off-thread search pipeline.  Renders the
 * real App, drives it through the mock Tauri boundary, and verifies the
 * full chain: user types → debounce → worker → matched set → row filter,
 * including mid-search updates when metadata or new photos stream in
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
import { makePhoto } from "./factories";

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

async function openFolderWithThreePhotos() {
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/photos");
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await user.click(screen.getByTestId("open-folder-btn"));

  const photos = [
    makePhoto({ relative_path: "alpha.jpg" }),
    makePhoto({ relative_path: "beta.jpg" }),
    makePhoto({ relative_path: "gamma.jpg" }),
  ];
  await act(async () => {
    for (const p of photos) mockApiInstance.emitPhotoFound(p);
  });
  await act(async () => {
    mockApiInstance.emitImageMetadataReady("alpha.jpg", {
      "IFD0:Make": "Canon",
    });
    mockApiInstance.emitImageMetadataReady("beta.jpg", { "IFD0:Make": "Sony" });
    mockApiInstance.emitImageMetadataReady("gamma.jpg", {
      "IFD0:Make": "Nikon",
      "Hidden:Tag": "ultraspecific-tag-value",
    });
  });
  // Let the photo_found and image_metadata_ready batches flush.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });

  return { user, photos };
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
    const { user } = await openFolderWithThreePhotos();
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    await user.type(screen.getByTestId("list-search-input"), "beta");
    await waitFor(() => {
      const rows = screen.getAllByTestId("photo-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "beta.jpg");
    });
  });

  it("matches on a hidden metadata key not shown in any column", async () => {
    const { user } = await openFolderWithThreePhotos();
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    await user.type(
      screen.getByTestId("list-search-input"),
      "ultraspecific-tag-value",
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("photo-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "gamma.jpg");
    });
  });

  it("shows the empty-search banner when no rows match", async () => {
    const { user } = await openFolderWithThreePhotos();
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    await user.type(
      screen.getByTestId("list-search-input"),
      "definitely-no-such-thing",
    );
    await waitFor(() => {
      expect(screen.getByTestId("photo-list-search-empty")).toBeInTheDocument();
    });
  });

  it("re-runs the active search when a new photo arrives mid-search", async () => {
    const { user } = await openFolderWithThreePhotos();
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    // Active filter that excludes everything currently visible.
    await user.type(screen.getByTestId("list-search-input"), "delta");
    await waitFor(() => {
      expect(screen.queryAllByTestId("photo-row")).toHaveLength(0);
    });

    // A new photo whose filename matches the active query streams in.
    await act(async () => {
      mockApiInstance.emitPhotoFound(makePhoto({ relative_path: "delta.jpg" }));
      mockApiInstance.emitImageMetadataReady("delta.jpg", {
        "IFD0:Make": "Fuji",
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId("photo-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "delta.jpg");
    });
  });

  it("re-runs the active search when streamed metadata changes what matches", async () => {
    const { user } = await openFolderWithThreePhotos();
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    // Filter on a token only present in metadata that hasn't arrived yet.
    await user.type(
      screen.getByTestId("list-search-input"),
      "uniquemetatoken-late-arrival",
    );
    await waitFor(() => {
      expect(screen.queryAllByTestId("photo-row")).toHaveLength(0);
    });

    // The matching metadata streams in for one photo.
    await act(async () => {
      mockApiInstance.emitImageMetadataReady("alpha.jpg", {
        "IFD0:Make": "Canon",
        "Hidden:Tag": "uniquemetatoken-late-arrival",
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId("photo-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-path", "alpha.jpg");
    });
  });

  it("clearing the search restores the full row set", async () => {
    const { user } = await openFolderWithThreePhotos();
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    const input = screen.getByTestId("list-search-input");
    await user.type(input, "beta");
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(1);
    });
    await user.clear(input);
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });
  });

  it("shows the searching spinner during the worker round-trip and hides it once results land", async () => {
    const { user } = await openFolderWithThreePhotos();
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    // Spinner is absent at rest.
    expect(screen.queryByTestId("list-search-spinner")).toBeNull();

    await user.type(screen.getByTestId("list-search-input"), "beta");

    // Results land asynchronously, then the spinner clears.
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("list-search-spinner")).toBeNull();
    });
  });
});
