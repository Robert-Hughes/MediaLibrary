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
import type { PhotoInfo } from "../types";

const SAMPLE_PHOTOS: PhotoInfo[] = [
  { relative_path: "beach/sunset.jpg", thumbnail: null },
  { relative_path: "portrait.png", thumbnail: null },
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

    await act(async () => {
      await result.current[1].openFolder();
    });

    expect(result.current[0].kind).toBe("idle");
  });

  // ── openFolder — transitions to loading ───────────────────────────────────

  it("transitions to loading after a folder is picked", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/vacation");

    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });

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

    await act(async () => {
      await result.current[1].openFolder();
    });

    act(() => { mock.emitScanProgress(12); });
    expect(result.current[0]).toMatchObject({ kind: "loading", foundSoFar: 12 });

    act(() => { mock.emitScanProgress(47); });
    expect(result.current[0]).toMatchObject({ kind: "loading", foundSoFar: 47 });
  });

  // ── scan_complete transitions to loaded ────────────────────────────────────

  it("transitions to loaded when scan_complete fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos/vacation");

    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });

    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.folder).toBe("/photos/vacation");
      expect(state.photos).toHaveLength(2);
      expect(state.photos[0].relative_path).toBe("beach/sunset.jpg");
    }
  });

  // ── scan_complete with empty folder ───────────────────────────────────────

  it("transitions to loaded with empty photos array when no photos found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/empty-folder");

    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });

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

    await act(async () => {
      await result.current[1].openFolder();
    });

    act(() => { mock.emitScanError("Not a directory"); });

    expect(result.current[0].kind).toBe("idle");
  });

  // ── closeFolder ────────────────────────────────────────────────────────────

  it("returns to idle when closeFolder is called from loaded state", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");

    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });
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

    // First scan
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { mock.emitScanComplete(SAMPLE_PHOTOS); });
    expect(result.current[0]).toMatchObject({ kind: "loaded", folder: "/photos/first" });

    // Open a second folder
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
