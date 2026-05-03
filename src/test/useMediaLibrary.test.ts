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
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    const state = result.current[0];
    if (state.kind === "loaded") expect(state.imageMetadataRemaining).toBe(1);
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
});
