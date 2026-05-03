/**
 * Tests for the useMediaLibrary hook.
 *
 * These tests exercise all state transitions without a real Tauri backend
 * or a real window — the mock API drives everything.
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";

const SAMPLE_PHOTOS = [
  { relative_path: "beach/sunset.jpg" },
  { relative_path: "portrait.png" },
];

describe("useMediaLibrary", () => {
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

  // ── scan_complete transitions to loaded with null thumbnails ───────────────

  it("transitions to loaded when scan_complete fires, thumbnails start null", async () => {
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
      // Thumbnails are null until thumbnail_ready events arrive.
      expect(state.photos[0].thumbnail).toBeNull();
      expect(state.photos[1].thumbnail).toBeNull();
    }
  });

  // ── thumbnail_ready fills in individual photos ─────────────────────────────

  it("updates a single photo's thumbnail when thumbnail_ready fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });

    act(() => { mock.emitThumbnailReady("beach/sunset.jpg", "base64abc"); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.photos[0].thumbnail).toBe("base64abc");
      // Other photo still null.
      expect(state.photos[1].thumbnail).toBeNull();
    }
  });

  it("updates multiple photos independently as thumbnails arrive", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });

    act(() => { mock.emitThumbnailReady("portrait.png", "thumb2"); });
    act(() => { mock.emitThumbnailReady("beach/sunset.jpg", "thumb1"); });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.photos[0].thumbnail).toBe("thumb1");
      expect(state.photos[1].thumbnail).toBe("thumb2");
    }
  });

  it("ignores thumbnail_ready events when not in loaded state", () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    // Still idle — thumbnail event should be a no-op.
    act(() => { mock.emitThumbnailReady("a.jpg", "data"); });

    expect(result.current[0].kind).toBe("idle");
  });

  it("ignores thumbnail_ready for unknown relative paths", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete([{ relative_path: "a.jpg" }]); });

    // Path doesn't match any photo — should not throw or corrupt state.
    act(() => { mock.emitThumbnailReady("nonexistent.jpg", "data"); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.photos[0].thumbnail).toBeNull();
    }
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

  it("thumbnails arriving after closeFolder are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });
    act(() => { result.current[1].closeFolder(); });

    // Thumbnail arrives after close — should not resurrect loaded state.
    act(() => { mock.emitThumbnailReady("beach/sunset.jpg", "data"); });
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
});
