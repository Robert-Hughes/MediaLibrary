import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto, makePhotos, mockDrafts, testId } from "./factories";
import { metadataGet } from "../utils/metadataCollection";
import { TargetDraftEditsStore } from "../targetDraftEdits";

describe("useMediaLibrary", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle state with empty recent folders", () => {
    const { api } = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(api));
    expect(result.current[0].kind).toBe("idle");
    expect(result.current[0].recentFolders).toEqual([]);
  });

  it("loads recent folders from localStorage on mount", async () => {
    localStorage.setItem(
      "media_library_recent_folders",
      JSON.stringify(["/a", "/b"]),
    );
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    expect(result.current[0].recentFolders).toEqual(["/a", "/b"]);
  });

  it("adds folder to recent list when opened", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/new");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    expect(result.current[0].recentFolders).toEqual(["/photos/new"]);
  });

  it("transitions to loaded on first photo_found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
  });

  it("appends photos as photo_found events arrive (batched)", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "c.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.photos).toHaveLength(3);
  });

  it("imageMetadataRemaining decrements when image_metadata_ready fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitImageMetadataReady("a.jpg", {});
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.metadataProgress.getRemaining()).toBe(1);
    }
  });

  it("stores canonical metadata from image_metadata_ready", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitImageMetadataReady("a.jpg", {
        "IFD0:Orientation": { kind: "Integer", value: 6 },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      const metadata = state.imageMetadata.get("a.jpg");
      expect(metadata).not.toBe("loading");
      if (metadata !== "loading") {
        expect(metadataGet(metadata, testId("IFD0:Orientation"))).toEqual({
          id: testId("IFD0:Orientation"),
          kind: "Integer",
          value: 6,
        });
      }
    }
  });

  it("navigateGallery increments and decrements", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    makePhotos(["a.jpg", "b.jpg", "c.jpg"]).forEach((p) =>
      act(() => {
        mock.emitPhotoFound(p);
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      result.current[1].openGallery(1);
    });
    act(() => {
      result.current[1].navigateGallery(1);
    });
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(2);
    act(() => {
      result.current[1].navigateGallery(-1);
    });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  it("navigateGallery respects listLength when clamping", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    makePhotos(["a.jpg", "b.jpg", "c.jpg"]).forEach((p) =>
      act(() => {
        mock.emitPhotoFound(p);
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      result.current[1].openGallery(0);
    });
    act(() => {
      result.current[1].navigateGallery(1, { listLength: 2 });
    });
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
    act(() => {
      result.current[1].navigateGallery(1, { listLength: 2 });
    });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  it("navigateGallery clamps at boundaries", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    makePhotos(["a.jpg", "b.jpg"]).forEach((p) =>
      act(() => {
        mock.emitPhotoFound(p);
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      result.current[1].openGallery(0);
    });
    act(() => {
      result.current[1].navigateGallery(-1);
    });
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(0);
    act(() => {
      result.current[1].openGallery(1);
    });
    act(() => {
      result.current[1].navigateGallery(1);
    });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  it("selectPhoto updates selectedIndex", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });

    act(() => {
      result.current[1].selectPhoto(0);
    });
    expect(result.current[0].kind).toBe("loaded");
    if (result.current[0].kind === "loaded") {
      expect(result.current[0].selectedIndex).toBe(0);
    }
  });

  it("openGallery also sets selectedIndex", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });

    act(() => {
      result.current[1].openGallery(0);
    });
    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.galleryIndex).toBe(0);
      expect(state.selectedIndex).toBe(0);
    }
  });

  it("navigateGallery syncs selectedIndex", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    makePhotos(["a.jpg", "b.jpg"]).forEach((p) =>
      act(() => {
        mock.emitPhotoFound(p);
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      result.current[1].openGallery(0);
    });
    act(() => {
      result.current[1].navigateGallery(1);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.galleryIndex).toBe(1);
      expect(state.selectedIndex).toBe(1);
    }
  });

  it("showInExplorer passes folder and relativePath separately to the backend and is called once", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("C:/MyPhotos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "nature/sunset.jpg" }));
    });

    await act(async () => {
      await result.current[1].showInExplorer(0);
    });

    const explorerCalls = mock.invocations.filter(
      (c) => c.cmd === "show_in_explorer",
    );
    expect(explorerCalls).toHaveLength(1);
    expect(explorerCalls[0].args).toEqual({
      folder: "C:/MyPhotos",
      relativePath: "nature/sunset.jpg",
    });
  });

  it("scan_error during loading resets state to idle", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    expect(result.current[0].kind).toBe("loading");

    act(() => {
      mock.emitScanError("not a directory");
    });
    expect(result.current[0].kind).toBe("idle");
  });

  it("scan_error after photos have loaded resets state to idle", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current[0].kind).toBe("loaded");

    act(() => {
      mock.emitScanError("disk read failed");
    });
    expect(result.current[0].kind).toBe("idle");
  });

  it("scan_error with a stale scan_id does not reset an in-progress scan", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current[0].kind).toBe("loaded");

    // A late scan_error from a previous scan must not nuke the active scan.
    act(() => {
      mock.emitScanError("late error from old scan", mock.currentScanId - 1);
    });
    expect(result.current[0].kind).toBe("loaded");
  });

  it("thumbnail failures (null) set thumbnail store to 'failed'", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitThumbnailReady("a.jpg", null);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.thumbnails.get("a.jpg")).toBe("failed");
    }
  });

  it("worker_error events append to workerErrors when in loaded state", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitWorkerError("metadata", "ExifTool failed", ["a.jpg"]);
    });
    act(() => {
      mock.emitWorkerError("thumbnail", "decode failed", ["b.jpg"]);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.workerErrors).toHaveLength(2);
      expect(state.workerErrors[0].worker_type).toBe("metadata");
      expect(state.workerErrors[0].error_message).toBe("ExifTool failed");
      expect(state.workerErrors[0].affected_files).toEqual(["a.jpg"]);
      expect(state.workerErrors[1].worker_type).toBe("thumbnail");
    }
  });

  it("dismissError removes the error at the given index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitWorkerError("metadata", "first error");
    });
    act(() => {
      mock.emitWorkerError("metadata", "second error");
    });

    act(() => {
      result.current[1].dismissError(0);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.workerErrors).toHaveLength(1);
      expect(state.workerErrors[0].error_message).toBe("second error");
    }
  });

  it("workerErrors is capped — keeps the most recent N and drops older ones", async () => {
    // Without a cap, a folder with thousands of metadata failures grows the
    // array (and React state) without bound.  Cap at 20 and keep the most
    // recent ones since they're the ones the user can act on.
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    for (let i = 0; i < 30; i++) {
      act(() => {
        mock.emitWorkerError("metadata", `error ${i}`);
      });
    }

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.workerErrors.length).toBeLessThanOrEqual(20);
      // The most recent error must be retained.
      expect(
        state.workerErrors[state.workerErrors.length - 1].error_message,
      ).toBe("error 29");
      // The oldest one must have been dropped.
      expect(
        state.workerErrors.find((e) => e.error_message === "error 0"),
      ).toBeUndefined();
    }
  });

  it("worker_error events while idle are ignored", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    expect(result.current[0].kind).toBe("idle");

    act(() => {
      mock.emitWorkerError("metadata", "stale error");
    });
    expect(result.current[0].kind).toBe("idle");
  });

  it("photo_found events with a stale scan_id are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    const currentScanId = mock.currentScanId;

    // Emit a photo_found with a different (stale) scan_id
    act(() => {
      mock.emitPhotoFound(
        makePhoto({ relative_path: "stale.jpg" }),
        currentScanId - 1,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // Stale photo should not have been added; state should still be loading
    expect(result.current[0].kind).toBe("loading");

    // A current-scan photo should be accepted
    act(() => {
      mock.emitPhotoFound(
        makePhoto({ relative_path: "fresh.jpg" }),
        currentScanId,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.photos).toHaveLength(1);
      expect(state.photos[0].relative_path).toBe("fresh.jpg");
    }
  });

  it("image_metadata_ready and thumbnail_ready with a stale scan_id are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const stale = mock.currentScanId - 1;
    act(() => {
      mock.emitImageMetadataReady(
        "a.jpg",
        { "IFD0:Model": { kind: "Text", value: "Stale" } },
        stale,
      );
    });
    act(() => {
      mock.emitThumbnailReady("a.jpg", "stale-data", stale);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      // Stale events should not have written to the stores
      expect(state.imageMetadata.get("a.jpg")).toBe("loading");
      expect(state.thumbnails.get("a.jpg")).toBe("loading");
      expect(state.metadataProgress.getRemaining()).toBe(1);
    }
  });

  it("worker_error events with a stale scan_id are still appended", async () => {
    // Worker_error currently doesn't filter by scan_id; this documents that.
    // If that behaviour changes, this test will need updating.
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitWorkerError(
        "metadata",
        "stale",
        ["x.jpg"],
        mock.currentScanId - 1,
      );
    });
    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.workerErrors).toHaveLength(1);
    }
  });

  it("photo_found events after closeFolder are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    act(() => {
      result.current[1].closeFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current[0].kind).toBe("idle");
  });

  it("scan_complete with zero photos transitions from loading to loaded", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/empty");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    expect(result.current[0].kind).toBe("loading");

    act(() => {
      mock.emitScanComplete();
    });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.photos).toEqual([]);
      expect(state.scanning).toBe(false);
      expect(state.folder).toBe("/empty");
    }
  });

  it("scan_complete after photos arrive sets scanning to false", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    let state = result.current[0];
    if (state.kind === "loaded") expect(state.scanning).toBe(true);

    act(() => {
      mock.emitScanComplete();
    });

    state = result.current[0];
    if (state.kind === "loaded") expect(state.scanning).toBe(false);
  });

  it("sortConfig persists across scan_complete (App applies sort once scanning ends)", async () => {
    // We assert at the hook level that scanning flips false on scan_complete
    // and sortConfig is preserved.  App.tsx skips sortPhotos while scanning
    // is true and runs it once when scanning becomes false — the test in
    // column-sorting verifies the PhotoList side of that contract.
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      result.current[1].setSortConfig({
        primary: { kind: "path", direction: "asc" },
        secondary: null,
      });
    });

    let state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.scanning).toBe(true);
      expect(state.sortConfig.primary?.kind).toBe("path");
    }

    act(() => {
      mock.emitScanComplete();
    });

    state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.scanning).toBe(false);
      // Sort config preserved so App can apply it now that scanning has ended.
      expect(state.sortConfig.primary?.kind).toBe("path");
    }
  });

  it("resetColumnWidths clears all stored widths", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      result.current[1].updateColumnWidth("IFD0:Model", 200);
    });
    act(() => {
      result.current[1].updateColumnWidth("ExifIFD:DateTimeOriginal", 300);
    });

    let state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.columnWidths["IFD0:Model"]).toBe(200);
      expect(state.columnWidths["ExifIFD:DateTimeOriginal"]).toBe(300);
    }

    act(() => {
      result.current[1].resetColumnWidths();
    });

    state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.columnWidths).toEqual({});
    }
  });

  it("metadataVersion increments only when sorted by an image metadata column", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // No primary sort: metadataVersion stays at 0 when metadata arrives
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);
    act(() => {
      mock.emitImageMetadataReady("a.jpg", {
        "IFD0:Model": { kind: "Text", value: "Canon" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);

    // Sort by an OS column: metadataVersion still does not increment
    act(() => {
      result.current[1].setSortConfig({
        primary: { kind: "os", key: "date_modified", direction: "asc" },
        secondary: null,
      });
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      mock.emitImageMetadataReady("b.jpg", {
        "IFD0:Model": { kind: "Text", value: "Nikon" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);

    // Sort by an image metadata column: metadataVersion increments on the next batch
    act(() => {
      result.current[1].setSortConfig({
        primary: { kind: "image", id: testId("IFD0:Model"), direction: "asc" },
        secondary: null,
      });
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "c.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      mock.emitImageMetadataReady("c.jpg", {
        "IFD0:Model": { kind: "Text", value: "Sony" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    state = result.current[0];
    if (state.kind === "loaded")
      expect(state.metadataVersion).toBeGreaterThan(0);
  });

  it("closeFolder cancels pending batch timers and drops buffered events", async () => {
    // Buffer photos that are sitting in photoBufferRef waiting for the 100ms
    // batch flush.  closeFolder should drop them so a stale flush doesn't
    // try to apply them after the user has left the folder.
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });

    // Get past the loading→loaded transition so we're in a state with timers.
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // Queue more photos that are sitting in the buffer behind the timer.
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "c.jpg" }));
    });

    // Close before the timer fires.
    act(() => {
      result.current[1].closeFolder();
    });
    expect(result.current[0].kind).toBe("idle");

    // Advance well past any timer interval — nothing should happen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current[0].kind).toBe("idle");
  });

  it("closeFolder invokes stop_scan on the backend", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    mock.invocations.length = 0;

    act(() => {
      result.current[1].closeFolder();
    });

    const stopCalls = mock.invocations.filter((c) => c.cmd === "stop_scan");
    expect(stopCalls).toHaveLength(1);
  });

  it("starting a new scan stops the old one and discards old events", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "old1.jpg" }));
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "old2.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const oldScanId = mock.currentScanId;

    // Start a new scan via openRecent — clears photo list and gets a new scan_id
    mock.invocations.length = 0;
    await act(async () => {
      await result.current[1].openRecent("/photos/second");
    });
    expect(mock.currentScanId).not.toBe(oldScanId);

    // stop_scan must have been invoked before start_scan
    const cmds = mock.invocations.map((c) => c.cmd);
    const stopIdx = cmds.indexOf("stop_scan");
    const startIdx = cmds.indexOf("start_scan");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);

    // Late events from the previous scan must be ignored
    act(() => {
      mock.emitPhotoFound(
        makePhoto({ relative_path: "leftover.jpg" }),
        oldScanId,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // New scan: emit a photo to confirm it lands
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "new1.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.folder).toBe("/photos/second");
      expect(state.photos.map((p) => p.relative_path)).toEqual(["new1.jpg"]);
    }
  });

  it("retains colliding occurrences while the omitted legacy schema stays blank and progress increments once", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));

    const schemaId = testId("IFD0:XResolution");
    const occurrence = {
      id: { document: null, path: "JPEG-APP1-IFD0", tag_id: "282", copy: 0 },
      value: { kind: "Integer" as const, value: 300 },
      tag_info: {
        id: schemaId,
        group: "IFD0",
        name: "XResolution",
        writable: true,
        kind: { kind: "Rational" as const },
        description: "X resolution",
      },
      write_target: { group1: "IFD0", tag_name: "XResolution" },
    };
    const secondOccurrence = {
      ...occurrence,
      id: { document: null, path: "JPEG-APP1-IFD1", tag_id: "282", copy: 1 },
      value: { kind: "Integer" as const, value: 72 },
      write_target: { group1: "IFD1", tag_name: "XResolution" },
    };
    act(() => {
      mock.emitImageMetadataReady("a.jpg", {}, undefined, [
        occurrence,
        secondOccurrence,
      ]);
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.imageMetadataOccurrences.get("a.jpg")).toEqual([
        occurrence,
        secondOccurrence,
      ]);
      const legacy = state.imageMetadata.get("a.jpg");
      expect(legacy).not.toBe("loading");
      if (legacy !== "loading") {
        expect(metadataGet(legacy, schemaId)).toBeUndefined();
      }
      expect(state.metadataProgress.getRemaining()).toBe(0);
      expect(state.workerErrors).toEqual([]);
    }
  });

  it("empty failed-file payloads clear loading in both stores", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitPhotoFound(makePhoto({ relative_path: "failed.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    act(() => mock.emitImageMetadataReady("failed.jpg", {}));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.imageMetadataOccurrences.get("failed.jpg")).toEqual([]);
      expect(state.imageMetadata.get("failed.jpg")).toEqual({});
    }
  });

  it("stale metadata updates neither store and a replacement scan discards occurrences", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const oldScanId = mock.currentScanId;
    const firstState = result.current[0];
    expect(firstState.kind).toBe("loaded");
    if (firstState.kind !== "loaded") return;
    const oldStore = firstState.imageMetadataOccurrences;

    act(() =>
      mock.emitImageMetadataReady(
        "a.jpg",
        { "IFD0:Model": { kind: "Text", value: "stale" } },
        oldScanId - 1,
        [
          {
            id: { document: null, path: "IFD0", tag_id: "272", copy: 0 },
            value: { kind: "Text", value: "stale" },
            tag_info: null,
            write_target: null,
          },
        ],
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(oldStore.get("a.jpg")).toBe("loading");
    expect(firstState.imageMetadata.get("a.jpg")).toBe("loading");

    await act(async () => result.current[1].openRecent("/second"));
    act(() => mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const replacement = result.current[0];
    if (replacement.kind === "loaded") {
      expect(replacement.imageMetadataOccurrences).toBe(oldStore);
      expect([...replacement.imageMetadataOccurrences.entries()]).toEqual([
        ["b.jpg", "loading"],
      ]);
    }
  });

  it("loads both persistence versions and creates Add Property only in v5", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    expect(mock.invocations.map(({ cmd }) => cmd)).toEqual(
      expect.arrayContaining([
        "load_metadata_draft_edits",
        "load_metadata_draft_edits_v5",
      ]),
    );

    const id = { table: "XMP::dc", tag_id: "subject" };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "landscape" },
    };
    act(() => result.current[1].setNewPropertyDraft("reserved", id, edit));

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(state.draftEdits.reserved).toBeUndefined();
    const targetEntries = Object.values(state.targetDraftEdits.reserved);
    expect(targetEntries).toHaveLength(1);
    expect(targetEntries[0].target).toEqual({
      kind: "NewProperty",
      schema_id: id,
    });
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(1);

    // Exact replacement is a no-op: no notification and no duplicate save.
    act(() => result.current[1].setNewPropertyDraft("reserved", id, edit));
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(1);
  });

  it("preserves absent index versus zero and blocks cross-system ownership", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const absent = { table: "Exif::Main", tag_id: "400" };
    const zero = { table: "Exif::Main", tag_id: "400", index: 0 };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "value" },
    };
    act(() => {
      result.current[1].setNewPropertyDraft("a.jpg", absent, edit);
      result.current[1].setNewPropertyDraft("a.jpg", zero, edit);
    });
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(Object.values(state.targetDraftEdits["a.jpg"])).toHaveLength(2);

    act(() => {
      result.current[1].setMetadataDraft("b.jpg", zero, edit);
      result.current[1].setNewPropertyDraft("b.jpg", zero, edit);
    });
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["b.jpg"]).toBeUndefined();
    expect(state.workerErrors[state.workerErrors.length - 1]?.worker_type).toBe(
      "metadata-v5-conflict",
    );
  });

  it("runs mixed apply v5 then v4 and suppresses controller snapshot autosave", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "value" },
    };
    act(() => {
      result.current[1].setMetadataDraft(
        "legacy.jpg",
        testId("XMP-dc:Title"),
        edit,
      );
      result.current[1].setNewPropertyDraft(
        "target.jpg",
        testId("XMP-dc:Subject"),
        edit,
      );
    });
    const savesBeforeApply = mock.invocations.filter(
      ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
    ).length;

    await act(async () => {
      await result.current[1].applyDraftEdits(["legacy.jpg", "target.jpg"]);
    });

    const applyCommands = mock.invocations
      .filter(({ cmd }) =>
        [
          "apply_metadata_draft_edits_v5_cmd",
          "apply_metadata_draft_edits_cmd",
        ].includes(cmd),
      )
      .map(({ cmd }) => cmd);
    expect(applyCommands).toEqual([
      "apply_metadata_draft_edits_v5_cmd",
      "apply_metadata_draft_edits_cmd",
    ]);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(savesBeforeApply);
    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.targetDraftEdits["target.jpg"]).toBeUndefined();
      expect(state.applying).toBeNull();
    }
  });

  it("rejects a cross-system file/schema collision before either apply phase", async () => {
    const mock = createMockTauriApi();
    const id = testId("XMP-dc:Title");
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "value" },
    };
    mock.draftEditsByFolder["/photos"] = {
      "same.jpg": mockDrafts({ "XMP-dc:Title": edit }),
    };
    const targetStore = new TargetDraftEditsStore();
    targetStore.setMetadataTarget(
      "same.jpg",
      { kind: "NewProperty", schema_id: id },
      edit,
    );
    mock.targetDraftEditsByFolder["/photos"] = targetStore.getAllMetadata();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    await act(async () => {
      await expect(result.current[1].applyDraftEdits()).rejects.toThrow(
        /owned by both v4 and v5/,
      );
    });
    expect(
      mock.invocations.filter(({ cmd }) =>
        [
          "apply_metadata_draft_edits_v5_cmd",
          "apply_metadata_draft_edits_cmd",
        ].includes(cmd),
      ),
    ).toHaveLength(0);
  });

  it("reports strict v5 load failure, preserves it, then switches safely", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const api = {
      ...mock.api,
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        cmd === "load_metadata_draft_edits_v5" && args?.folderPath === "/photos"
          ? Promise.reject(new Error("invalid schema version"))
          : mock.api.invoke(cmd, args),
    };
    const { result } = renderHook(() => useMediaLibrary(api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits).toEqual({});
    expect(state.workerErrors[0].worker_type).toBe("metadata-v5-load");
    expect(
      mock.invocations.some(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toBe(false);

    await act(async () => result.current[1].openRecent("/second"));
    act(() => mock.emitScanComplete());
    act(() =>
      result.current[1].setNewPropertyDraft("new.jpg", testId("XMP-dc:Title"), {
        intent: "Set",
        value: { kind: "Text", value: "new folder" },
      }),
    );
    expect(
      mock.invocations.find(({ cmd }) => cmd === "save_metadata_draft_edits_v5")
        ?.args?.folderPath,
    ).toBe("/second");
  });

  it("uses the switched folder for target autosave and clears on close", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const id = testId("XMP-dc:Title");
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "value" },
    };
    act(() => result.current[1].setNewPropertyDraft("a.jpg", id, edit));
    await act(async () => result.current[1].applyDraftEdits("a.jpg"));
    await act(async () => result.current[1].openRecent("/second"));
    act(() => mock.emitScanComplete());
    act(() => result.current[1].setNewPropertyDraft("b.jpg", id, edit));
    const saveFolders = mock.invocations
      .filter(({ cmd }) => cmd === "save_metadata_draft_edits_v5")
      .map(({ args }) => args?.folderPath);
    expect(saveFolders).toEqual(["/first", "/second"]);
    const loaded = result.current[0];
    if (loaded.kind !== "loaded") return;
    const store = loaded.targetDraftEditsStore;
    act(() => result.current[1].closeFolder());
    expect(store.getAllMetadata()).toEqual({});
    expect(result.current[0].kind).toBe("idle");
  });
});
