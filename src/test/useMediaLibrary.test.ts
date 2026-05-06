import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto, makePhotos } from "./factories";

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
    localStorage.setItem("media_library_recent_folders", JSON.stringify(["/a", "/b"]));
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    expect(result.current[0].recentFolders).toEqual(["/a", "/b"]);
  });

  it("adds folder to recent list when opened", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/new");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    expect(result.current[0].recentFolders).toEqual(["/photos/new"]);
  });

  it("transitions to loaded on first photo_found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
  });

  it("appends photos as photo_found events arrive (batched)", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" })); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "c.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.photos).toHaveLength(3);
  });

  it("imageMetadataRemaining decrements when image_metadata_ready fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    
    act(() => { mock.emitImageMetadataReady("a.jpg", {}); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.metadataProgress.getRemaining()).toBe(1);
    }
  });

  it("navigateGallery increments and decrements", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    makePhotos(["a.jpg", "b.jpg", "c.jpg"]).forEach((p) => act(() => { mock.emitPhotoFound(p); }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    act(() => { result.current[1].openGallery(1); });
    act(() => { result.current[1].navigateGallery(1); });
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(2);
    act(() => { result.current[1].navigateGallery(-1); });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  it("navigateGallery clamps at boundaries", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    makePhotos(["a.jpg", "b.jpg"]).forEach((p) => act(() => { mock.emitPhotoFound(p); }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    act(() => { result.current[1].openGallery(0); });
    act(() => { result.current[1].navigateGallery(-1); });
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(0);
    act(() => { result.current[1].openGallery(1); });
    act(() => { result.current[1].navigateGallery(1); });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  it("selectPhoto updates selectedIndex", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    
    act(() => { result.current[1].selectPhoto(0); });
    expect(result.current[0].kind).toBe("loaded");
    if (result.current[0].kind === "loaded") {
      expect(result.current[0].selectedIndex).toBe(0);
    }
  });

  it("openGallery also sets selectedIndex", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    
    act(() => { result.current[1].openGallery(0); });
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
    await act(async () => { await result.current[1].openFolder(); });
    makePhotos(["a.jpg", "b.jpg"]).forEach((p) => act(() => { mock.emitPhotoFound(p); }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    act(() => { result.current[1].openGallery(0); });
    act(() => { result.current[1].navigateGallery(1); });
    
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
    
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "nature/sunset.jpg" })); });

    await act(async () => { await result.current[1].showInExplorer(0); });

    const explorerCalls = mock.invocations.filter(c => c.cmd === "show_in_explorer");
    expect(explorerCalls).toHaveLength(1);
    expect(explorerCalls[0].args).toEqual({
      folder: "C:/MyPhotos",
      relativePath: "nature/sunset.jpg"
    });
  });

  it("scan_error during loading resets state to idle", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    expect(result.current[0].kind).toBe("loading");

    act(() => { mock.emitScanError("not a directory"); });
    expect(result.current[0].kind).toBe("idle");
  });

  it("scan_error after photos have loaded resets state to idle", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(result.current[0].kind).toBe("loaded");

    act(() => { mock.emitScanError("disk read failed"); });
    expect(result.current[0].kind).toBe("idle");
  });

  it("worker_error events append to workerErrors when in loaded state", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    act(() => { mock.emitWorkerError("metadata", "ExifTool failed", ["a.jpg"]); });
    act(() => { mock.emitWorkerError("thumbnail", "decode failed", ["b.jpg"]); });

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
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    act(() => { mock.emitWorkerError("metadata", "first error"); });
    act(() => { mock.emitWorkerError("metadata", "second error"); });

    act(() => { result.current[1].dismissError(0); });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.workerErrors).toHaveLength(1);
      expect(state.workerErrors[0].error_message).toBe("second error");
    }
  });

  it("worker_error events while idle are ignored", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    expect(result.current[0].kind).toBe("idle");

    act(() => { mock.emitWorkerError("metadata", "stale error"); });
    expect(result.current[0].kind).toBe("idle");
  });

  it("photo_found events with a stale scan_id are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    const currentScanId = mock.currentScanId;

    // Emit a photo_found with a different (stale) scan_id
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "stale.jpg" }), currentScanId - 1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    // Stale photo should not have been added; state should still be loading
    expect(result.current[0].kind).toBe("loading");

    // A current-scan photo should be accepted
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "fresh.jpg" }), currentScanId); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

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
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    const stale = mock.currentScanId - 1;
    act(() => { mock.emitImageMetadataReady("a.jpg", { "IFD0:Model": "Stale" }, stale); });
    act(() => { mock.emitThumbnailReady("a.jpg", "stale-data", stale); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

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
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    act(() => { mock.emitWorkerError("metadata", "stale", ["x.jpg"], mock.currentScanId - 1); });
    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.workerErrors).toHaveLength(1);
    }
  });

  it("photo_found events after closeFolder are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { result.current[1].closeFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(result.current[0].kind).toBe("idle");
  });

  it("scan_complete with zero photos transitions from loading to loaded", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/empty");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    expect(result.current[0].kind).toBe("loading");

    act(() => { mock.emitScanComplete(); });

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
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    let state = result.current[0];
    if (state.kind === "loaded") expect(state.scanning).toBe(true);

    act(() => { mock.emitScanComplete(); });

    state = result.current[0];
    if (state.kind === "loaded") expect(state.scanning).toBe(false);
  });

  it("metadataVersion increments only when sorted by an image metadata column", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    // No primary sort: metadataVersion stays at 0 when metadata arrives
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);
    act(() => { mock.emitImageMetadataReady("a.jpg", { "IFD0:Model": "Canon" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);

    // Sort by an OS column: metadataVersion still does not increment
    act(() => {
      result.current[1].setSortConfig({
        primary: { column: "date_modified", columnType: "os", direction: "asc" },
        secondary: null,
      });
    });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    act(() => { mock.emitImageMetadataReady("b.jpg", { "IFD0:Model": "Nikon" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);

    // Sort by an image metadata column: metadataVersion increments on the next batch
    act(() => {
      result.current[1].setSortConfig({
        primary: { column: "IFD0:Model", columnType: "image", direction: "asc" },
        secondary: null,
      });
    });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "c.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    act(() => { mock.emitImageMetadataReady("c.jpg", { "IFD0:Model": "Sony" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBeGreaterThan(0);
  });

  it("closeFolder invokes stop_scan on the backend", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    mock.invocations.length = 0;

    act(() => { result.current[1].closeFolder(); });

    const stopCalls = mock.invocations.filter(c => c.cmd === "stop_scan");
    expect(stopCalls).toHaveLength(1);
  });

  it("starting a new scan stops the old one and discards old events", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "old1.jpg" })); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "old2.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    const oldScanId = mock.currentScanId;

    // Start a new scan via openRecent — clears photo list and gets a new scan_id
    mock.invocations.length = 0;
    await act(async () => { await result.current[1].openRecent("/photos/second"); });
    expect(mock.currentScanId).not.toBe(oldScanId);

    // stop_scan must have been invoked before start_scan
    const cmds = mock.invocations.map(c => c.cmd);
    const stopIdx = cmds.indexOf("stop_scan");
    const startIdx = cmds.indexOf("start_scan");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);

    // Late events from the previous scan must be ignored
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "leftover.jpg" }), oldScanId); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    // New scan: emit a photo to confirm it lands
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "new1.jpg" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.folder).toBe("/photos/second");
      expect(state.photos.map(p => p.relative_path)).toEqual(["new1.jpg"]);
    }
  });
});
