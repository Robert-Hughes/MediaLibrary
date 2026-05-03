import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto, makePhotos } from "./factories";

describe("useMediaLibrary", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // ── Initial state ──────────────────────────────────────────────────────────

  it("starts in idle state", () => {
    const { api } = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(api));
    expect(result.current[0].kind).toBe("idle");
  });

  // ── openFolder — user cancels ──────────────────────────────────────────────

  it("stays idle when the folder picker is cancelled", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves(null);
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    expect(result.current[0].kind).toBe("idle");
  });

  // ── openFolder — transitions to loading ───────────────────────────────────

  it("transitions to loading after a folder is picked", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/vacation");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    expect(result.current[0].kind).toBe("loading");
  });

  // ── photo_found: streaming into loaded state ───────────────────────────────

  it("transitions to loaded on first photo_found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });

    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.photos).toHaveLength(1);
      expect(state.photos[0].relative_path).toBe("a.jpg");
      expect(state.scanning).toBe(true);
    }
  });

  it("appends photos as photo_found events arrive", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });

    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" })); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "c.jpg" })); });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.photos).toHaveLength(3);
      expect(state.scanning).toBe(true);
    }
  });

  // ── scan_complete clears scanning flag ────────────────────────────────────

  it("clears scanning flag when scan_complete fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });

    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { mock.emitScanComplete(); });

    const state = result.current[0];
    if (state.kind === "loaded") expect(state.scanning).toBe(false);
  });

  it("shows empty list (not loading) after scan_complete with no photos", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/empty");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });

    act(() => { mock.emitScanComplete(); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.photos).toHaveLength(0);
      expect(state.scanning).toBe(false);
    }
  });

  // ── metadata_ready updates the MetadataStore ──────────────────────────────

  it("updates metadata store when metadata_ready fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });

    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });

    const state = result.current[0];
    if (state.kind !== "loaded") return;

    act(() => { mock.emitMetadataReady("a.jpg", "2023:06:15 14:30:00", "Canon EOS R5"); });

    expect(state.metadata.get("a.jpg")).toEqual({
      date_taken: "2023:06:15 14:30:00",
      camera_model: "Canon EOS R5",
    });
    // AppState reference unchanged — no list re-render.
    expect(result.current[0]).toBe(state);
  });

  it("metadata starts as null before metadata_ready", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.metadata.get("a.jpg")).toEqual({ date_taken: null, camera_model: null });
    }
  });

  // ── thumbnail_ready updates the ThumbnailStore ────────────────────────────

  it("updates thumbnail store when thumbnail_ready fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });

    const state = result.current[0];
    if (state.kind !== "loaded") return;

    act(() => { mock.emitThumbnailReady("a.jpg", "base64data"); });

    expect(state.thumbnails.get("a.jpg")).toBe("base64data");
    expect(result.current[0]).toBe(state); // no list re-render
  });

  // ── scan_error ────────────────────────────────────────────────────────────

  it("reverts to idle on scan_error", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/bad");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanError("Not a directory"); });
    expect(result.current[0].kind).toBe("idle");
  });

  // ── closeFolder ────────────────────────────────────────────────────────────

  it("returns to idle when closeFolder is called", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { result.current[1].closeFolder(); });
    expect(result.current[0].kind).toBe("idle");
  });

  // ── window title ──────────────────────────────────────────────────────────

  it("sets window title when folder is opened", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/vacation");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    expect(mock.lastWindowTitle).toContain("/photos/vacation");
  });

  it("resets window title when folder is closed", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { result.current[1].closeFolder(); });
    expect(mock.lastWindowTitle).toBe("Media Library");
  });

  // ── gallery ───────────────────────────────────────────────────────────────

  it("galleryIndex starts as null", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBeNull();
  });

  it("openGallery sets the index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    makePhotos(["a.jpg", "b.jpg", "c.jpg"]).forEach((p) =>
      act(() => { mock.emitPhotoFound(p); })
    );
    act(() => { result.current[1].openGallery(2); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(2);
  });

  it("navigateGallery increments and decrements", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    makePhotos(["a.jpg", "b.jpg", "c.jpg"]).forEach((p) =>
      act(() => { mock.emitPhotoFound(p); })
    );
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
    makePhotos(["a.jpg", "b.jpg"]).forEach((p) =>
      act(() => { mock.emitPhotoFound(p); })
    );
    act(() => { result.current[1].openGallery(0); });
    act(() => { result.current[1].navigateGallery(-1); });
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(0);

    act(() => { result.current[1].openGallery(1); });
    act(() => { result.current[1].navigateGallery(1); });
    state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  // ── prioritizeThumbnails ──────────────────────────────────────────────────

  it("calls prioritize_thumbnails after debounce", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { result.current[1].prioritizeThumbnails(["a.jpg", "b.jpg"]); });
    expect(mock.lastPrioritizedPaths).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(mock.lastPrioritizedPaths).toEqual(["a.jpg", "b.jpg"]);
  });

  it("debounces rapid calls", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => {
      result.current[1].prioritizeThumbnails(["a.jpg"]);
      result.current[1].prioritizeThumbnails(["b.jpg"]);
      result.current[1].prioritizeThumbnails(["c.jpg", "d.jpg"]);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(mock.lastPrioritizedPaths).toEqual(["c.jpg", "d.jpg"]);
  });

  // ── double-registration guard (StrictMode / cleanup race) ─────────────────

  it("events fired after cleanup are ignored — no double-counting", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result, unmount } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });

    // Simulate what StrictMode does: unmount (cleanup) then remount.
    // After unmount the cancelled flag is set, so any events that arrive
    // before the new listeners are registered should be dropped.
    unmount();

    // These events arrive after cleanup — they must not affect state.
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "ghost.jpg" }));
      mock.emitPhotoFound(makePhoto({ relative_path: "ghost2.jpg" }));
    });

    // Remount with a fresh hook instance.
    const { result: result2 } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result2.current[1].openFolder(); });

    // Now emit the real photos on the new instance.
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "real.jpg" })); });
    act(() => { mock.emitScanComplete(); });

    const state = result2.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      // Only the real photo — no ghosts from the torn-down instance.
      expect(state.photos).toHaveLength(1);
      expect(state.photos[0].relative_path).toBe("real.jpg");
    }
  });

  // ── opening a new folder resets the photo list ────────────────────────────

  it("opening a second folder replaces the photo list", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    // First scan.
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" })); });
    act(() => { mock.emitScanComplete(); });
    expect(result.current[0]).toMatchObject({ kind: "loaded", folder: "/photos/first" });
    if (result.current[0].kind === "loaded") {
      expect(result.current[0].photos).toHaveLength(2);
    }

    // Open a second folder — list must reset.
    mock.pickFolderResolves("/photos/second");
    await act(async () => { await result.current[1].openFolder(); });
    expect(result.current[0].kind).toBe("loading");

    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "c.jpg" })); });
    act(() => { mock.emitScanComplete(); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.folder).toBe("/photos/second");
      // Only the new photo — no leftovers from the first scan.
      expect(state.photos).toHaveLength(1);
      expect(state.photos[0].relative_path).toBe("c.jpg");
    }
  });

  // ── late events after closeFolder are ignored ─────────────────────────────

  it("thumbnail_ready after closeFolder does not resurrect loaded state", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { result.current[1].closeFolder(); });
    expect(result.current[0].kind).toBe("idle");

    // Late thumbnail — must not change state.
    act(() => { mock.emitThumbnailReady("a.jpg", "data"); });
    expect(result.current[0].kind).toBe("idle");
  });

  it("metadata_ready after closeFolder does not resurrect loaded state", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })); });
    act(() => { result.current[1].closeFolder(); });

    act(() => { mock.emitMetadataReady("a.jpg", "2023:01:01", "Canon"); });
    expect(result.current[0].kind).toBe("idle");
  });
});
