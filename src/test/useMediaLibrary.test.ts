/**
 * Tests for the useMediaLibrary hook.
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhotos } from "./factories";

const SAMPLE_PHOTOS = makePhotos(["beach/sunset.jpg", "portrait.png"]);

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

    const state = result.current[0];
    expect(state.kind).toBe("loading");
    if (state.kind === "loading") {
      expect(state.folder).toBe("/photos/vacation");
      expect(state.foundSoFar).toBe(0);
    }
  });

  // ── scan_progress events update the counter ────────────────────────────────

  it("updates foundSoFar when scan_progress events arrive", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });

    act(() => { mock.emitScanProgress(12); });
    expect(result.current[0]).toMatchObject({ kind: "loading", foundSoFar: 12 });

    act(() => { mock.emitScanProgress(47); });
    expect(result.current[0]).toMatchObject({ kind: "loading", foundSoFar: 47 });
  });

  // ── scan_complete transitions to loaded ───────────────────────────────────

  it("transitions to loaded when scan_complete fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/vacation");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.folder).toBe("/photos/vacation");
      expect(state.photos).toHaveLength(2);
      expect(state.photos[0].relative_path).toBe("beach/sunset.jpg");
    }
  });

  it("thumbnails start as loading in the store after scan_complete", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.thumbnails.get("beach/sunset.jpg")).toBe("loading");
      expect(state.thumbnails.get("portrait.png")).toBe("loading");
    }
  });

  // ── thumbnail_ready updates the store ─────────────────────────────────────

  it("updates the thumbnail store when thumbnail_ready fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });

    const state = result.current[0];
    if (state.kind !== "loaded") return;

    act(() => { mock.emitThumbnailReady("beach/sunset.jpg", "base64abc"); });

    expect(state.thumbnails.get("beach/sunset.jpg")).toBe("base64abc");
    // Other photo still loading — and AppState itself did not change.
    expect(state.thumbnails.get("portrait.png")).toBe("loading");
    // The loaded state object is the same reference (no re-render of the list).
    expect(result.current[0]).toBe(state);
  });

  it("updates multiple thumbnails independently", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });

    const state = result.current[0];
    if (state.kind !== "loaded") return;

    act(() => { mock.emitThumbnailReady("portrait.png", "thumb2"); });
    act(() => { mock.emitThumbnailReady("beach/sunset.jpg", "thumb1"); });

    expect(state.thumbnails.get("beach/sunset.jpg")).toBe("thumb1");
    expect(state.thumbnails.get("portrait.png")).toBe("thumb2");
  });

  it("thumbnail_ready for unknown path is a no-op", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(makePhotos(["a.jpg"])); });

    const state = result.current[0];
    if (state.kind !== "loaded") return;

    act(() => { mock.emitThumbnailReady("nonexistent.jpg", "data"); });

    // Known path unaffected.
    expect(state.thumbnails.get("a.jpg")).toBe("loading");
  });

  it("thumbnail_ready when not loaded is ignored", () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    act(() => { mock.emitThumbnailReady("a.jpg", "data"); });

    expect(result.current[0].kind).toBe("idle");
  });

  // ── scan_complete with empty folder ───────────────────────────────────────

  it("transitions to loaded with empty photos array when no photos found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/empty-folder");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete([]); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.photos).toHaveLength(0);
    }
  });

  // ── scan_error reverts to idle ─────────────────────────────────────────────

  it("reverts to idle on scan_error", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/bad-path");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanError("Not a directory"); });

    expect(result.current[0].kind).toBe("idle");
  });

  // ── closeFolder ────────────────────────────────────────────────────────────

  it("returns to idle when closeFolder is called from loaded state", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });
    expect(result.current[0].kind).toBe("loaded");

    act(() => { result.current[1].closeFolder(); });
    expect(result.current[0].kind).toBe("idle");
  });

  // ── Opening a new folder replaces the previous one ────────────────────────

  it("replaces the loaded state when a new folder is opened", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });
    expect(result.current[0]).toMatchObject({ kind: "loaded", folder: "/photos/first" });

    mock.pickFolderResolves("/photos/second");
    await act(async () => { await result.current[1].openFolder(); });
    expect(result.current[0]).toMatchObject({ kind: "loading", folder: "/photos/second" });

    act(() => { mock.emitScanComplete([]); });
    expect(result.current[0]).toMatchObject({ kind: "loaded", folder: "/photos/second" });
  });

  // ── progress events ignored when not loading ──────────────────────────────

  it("ignores scan_progress events when not in loading state", () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    act(() => { mock.emitScanProgress(99); });
    expect(result.current[0].kind).toBe("idle");
  });

  // ── window title ──────────────────────────────────────────────────────────

  it("sets window title to folder path when folder is opened", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/vacation");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });

    expect(mock.lastWindowTitle).toContain("/photos/vacation");
  });

  it("resets window title when folder is closed", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/vacation");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete([]); });
    act(() => { result.current[1].closeFolder(); });

    expect(mock.lastWindowTitle).toBe("Media Library");
  });

  // ── prioritizeThumbnails ──────────────────────────────────────────────────

  it("calls prioritize_thumbnails with the provided paths after debounce", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });

    act(() => { result.current[1].prioritizeThumbnails(["a.jpg", "b.jpg"]); });

    expect(mock.lastPrioritizedPaths).toEqual([]);

    await act(async () => { await vi.advanceTimersByTimeAsync(150); });

    expect(mock.lastPrioritizedPaths).toEqual(["a.jpg", "b.jpg"]);
  });

  it("debounces rapid calls — only the last set of paths is sent", async () => {
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
});
