import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto, makePhotos, mockDrafts, testId } from "./factories";
import { metadataGet } from "../utils/metadataCollection";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataApplyFileResultV5,
  MetadataOccurrence,
  SchemaDefinitionId,
} from "../types";
import { sortPhotos } from "../utils/sorting";
import { targetVerifyOutcomeFromBackend } from "../targetVerifyOutcomes";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import { GPS_IDS } from "../metadata/knownIds";
import { previewMetadataRemovalFilesV5 } from "../metadataRemovalTargets";

function targetV5Result(
  path: string,
  id: SchemaDefinitionId,
  value: string | null,
  options: { occurrenceCopy?: number; persistedDraftEntries?: [] | null } = {},
): MetadataApplyFileResultV5 {
  const occurrence: MetadataOccurrence = {
    id: {
      document: null,
      path: "JPEG-APP1-XMP",
      tag_id: id.tag_id,
      copy: options.occurrenceCopy ?? 0,
    },
    value: { kind: "Text", value: value ?? "" },
    tag_info: null,
    write_target: null,
  };
  return {
    relative_path: path,
    applied: true,
    error: null,
    warning: null,
    fresh_image_metadata:
      value === null
        ? null
        : {
            relative_path: path,
            occurrences: [occurrence],
            metadata: [{ id, value: { kind: "Text", value } }],
          },
    target_outcomes: [],
    persisted_draft_entries: options.persistedDraftEntries ?? [],
  };
}

function targetableOccurrence(
  id: SchemaDefinitionId,
  value = "current",
  options: { copy?: number; path?: string; tagName?: string } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: options.path ?? "JPEG-APP1-XMP",
      tag_id: id.tag_id,
      copy: options.copy ?? 0,
    },
    value: { kind: "Text", value },
    tag_info: {
      id,
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    },
    write_target: {
      group1: "XMP-dc",
      tag_name: options.tagName ?? "Title",
    },
  };
}

function gpsOccurrence(
  id: SchemaDefinitionId,
  value: number,
  name: string,
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: `JPEG-APP1-GPS-${id.tag_id}`,
      tag_id: id.tag_id,
      copy: 0,
    },
    value: { kind: "Real", value },
    tag_info: {
      id,
      group: "GPS",
      name,
      writable: true,
      kind: { kind: "Real" },
      description: null,
    },
    write_target: { group1: "GPS", tag_name: name },
  };
}

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

    const loadCommands = mock.invocations.map(({ cmd }) => cmd);
    expect(loadCommands).toEqual(
      expect.arrayContaining([
        "load_metadata_draft_edits",
        "load_metadata_draft_edits_v5",
      ]),
    );
    expect(loadCommands.indexOf("load_metadata_draft_edits_v5")).toBeLessThan(
      loadCommands.indexOf("load_metadata_draft_edits"),
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
      result.current[1].setMetadataDraftBatch("b.jpg", [{ id: zero, edit }]);
      result.current[1].setNewPropertyDraft("b.jpg", zero, edit);
    });
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["b.jpg"]).toBeUndefined();
    expect(state.workerErrors[state.workerErrors.length - 1]?.worker_type).toBe(
      "metadata-v5-conflict",
    );
  });

  it("creates, updates, and clears one exact ExistingOccurrence draft without v4 mutation", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const id = testId("XMP-dc:Title");
    const occurrence = targetableOccurrence(id);
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "exact.jpg" }));
      mock.emitImageMetadataReady(
        "exact.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "current" } },
        undefined,
        [occurrence],
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));

    act(() =>
      result.current[1].setExistingOccurrenceDraft("exact.jpg", occurrence.id, {
        intent: "Set",
        value: { kind: "Text", value: "current" },
      }),
    );
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["exact.jpg"]).toBeUndefined();

    act(() =>
      result.current[1].setExistingOccurrenceDraft("exact.jpg", occurrence.id, {
        intent: "Set",
        value: { kind: "Text", value: "edited" },
      }),
    );
    state = result.current[0];
    if (state.kind !== "loaded") return;
    const entries = Object.values(state.targetDraftEdits["exact.jpg"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      target: {
        kind: "ExistingOccurrence",
        occurrence_id: occurrence.id,
        schema_id: id,
        write_target: occurrence.write_target,
      },
      edit: { intent: "Set", value: { kind: "Text", value: "edited" } },
    });
    expect(state.draftEdits["exact.jpg"]).toBeUndefined();
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(0);

    act(() =>
      result.current[1].discardTargetPropertyDraft(
        "exact.jpg",
        entries[0].target,
      ),
    );
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["exact.jpg"]).toBeUndefined();
    expect(state.draftEdits["exact.jpg"]).toBeUndefined();

    act(() =>
      result.current[1].setExistingOccurrenceDraft("exact.jpg", occurrence.id, {
        intent: "Set",
        value: { kind: "Text", value: "edited again" },
      }),
    );

    act(() =>
      result.current[1].setExistingOccurrenceDraft("exact.jpg", occurrence.id, {
        intent: "Delete",
        value: null,
      }),
    );
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(Object.values(state.targetDraftEdits["exact.jpg"])).toHaveLength(1);
    expect(
      Object.values(state.targetDraftEdits["exact.jpg"])[0].edit.intent,
    ).toBe("Delete");

    act(() =>
      result.current[1].setExistingOccurrenceDraft("exact.jpg", occurrence.id, {
        intent: "Set",
        value: { kind: "Text", value: "current" },
      }),
    );
    state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.targetDraftEdits["exact.jpg"]).toBeUndefined();
    }
  });

  it("removes a group through one v5 save, discarding NewProperty and ignoring absence", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const existingId = testId("XMP-dc:Title");
    const createdId = testId("XMP-dc:Subject");
    const absentId = testId("XMP-dc:Description");
    const occurrence = targetableOccurrence(existingId);
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "group.jpg" }));
      mock.emitImageMetadataReady(
        "group.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "current" } },
        undefined,
        [occurrence],
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() =>
      result.current[1].setNewPropertyDraft("group.jpg", createdId, {
        intent: "Set",
        value: { kind: "Text", value: "created" },
      }),
    );
    mock.invocations.length = 0;

    let succeeded = false;
    act(() => {
      succeeded = result.current[1].removeMetadataFieldsV5("group.jpg", [
        existingId,
        createdId,
        absentId,
      ]);
    });
    expect(succeeded).toBe(true);
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    const entries = Object.values(state.targetDraftEdits["group.jpg"]);
    expect(entries).toEqual([
      {
        target: {
          kind: "ExistingOccurrence",
          occurrence_id: occurrence.id,
          schema_id: existingId,
          write_target: occurrence.write_target,
        },
        edit: { intent: "Delete", value: null },
      },
    ]);
    expect(state.draftEdits["group.jpg"]).toBeUndefined();
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(1);
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(0);
  });

  it("keeps an already staged exact Delete without notification or autosave", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const id = testId("XMP-dc:Title");
    const occurrence = targetableOccurrence(id);
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "deleted.jpg" }));
      mock.emitImageMetadataReady(
        "deleted.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "current" } },
        undefined,
        [occurrence],
      );
      result.current[1].setExistingOccurrenceDraft(
        "deleted.jpg",
        occurrence.id,
        { intent: "Delete", value: null },
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    const before = structuredClone(state.targetDraftEdits["deleted.jpg"]);
    let notifications = 0;
    const unsubscribe = state.targetDraftEditsStore.subscribe(() => {
      notifications += 1;
    });
    mock.invocations.length = 0;

    let succeeded = false;
    act(() => {
      succeeded = result.current[1].removeMetadataFieldFromFilesV5(id, [
        "deleted.jpg",
      ]);
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    unsubscribe();

    expect(succeeded).toBe(true);
    expect(notifications).toBe(0);
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["deleted.jpg"]).toEqual(before);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(0);
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(0);
  });

  it("plans every selected file before mutation and reports an ambiguous later path", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const id = testId("XMP-dc:Title");
    const first = targetableOccurrence(id, "a", { path: "a-target" });
    const second = targetableOccurrence(id, "b", { path: "b-target" });
    const duplicate = targetableOccurrence(id, "b2", {
      path: "b-target-2",
      copy: 1,
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
      mock.emitImageMetadataReady(
        "a.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "a" } },
        undefined,
        [first],
      );
      mock.emitImageMetadataReady(
        "b.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "b" } },
        undefined,
        [second, duplicate],
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    mock.invocations.length = 0;

    let succeeded = true;
    act(() => {
      succeeded = result.current[1].removeMetadataFieldFromFilesV5(id, [
        "a.jpg",
        "b.jpg",
      ]);
    });
    expect(succeeded).toBe(false);
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["a.jpg"]).toBeUndefined();
    expect(state.targetDraftEdits["b.jpg"]).toBeUndefined();
    expect(
      state.workerErrors[state.workerErrors.length - 1]?.error_message,
    ).toMatch(/'b\.jpg'.*Several/s);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(0);
  });

  it("re-plans execution after preview and mutates nothing when state becomes unsafe", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const id = testId("XMP-dc:Title");
    const first = targetableOccurrence(id, "first", { path: "first-target" });
    const duplicate = targetableOccurrence(id, "second", {
      path: "second-target",
      copy: 1,
    });
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "changed.jpg" }));
      mock.emitImageMetadataReady(
        "changed.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "first" } },
        undefined,
        [first],
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    const loadedState = state;
    expect(
      previewMetadataRemovalFilesV5({
        schemaId: id,
        relativePaths: ["changed.jpg"],
        targetDraftPersistence: loadedState.targetDraftPersistence,
        occurrencesForPath: (path) =>
          loadedState.imageMetadataOccurrences.get(path),
        legacyDraftsForPath: (path) => loadedState.draftEdits[path],
        targetDraftsForPath: (path) => loadedState.targetDraftEdits[path],
      }),
    ).toMatchObject({ kind: "ready", existingFieldsToDelete: 1 });

    act(() =>
      loadedState.imageMetadataOccurrences.set("changed.jpg", [
        first,
        duplicate,
      ]),
    );
    mock.invocations.length = 0;
    let succeeded = true;
    act(() => {
      succeeded = result.current[1].removeMetadataFieldFromFilesV5(id, [
        "changed.jpg",
      ]);
    });

    expect(succeeded).toBe(false);
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["changed.jpg"]).toBeUndefined();
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(0);
  });

  it("deduplicates selected paths and saves nothing for an all-file no-op", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "absent.jpg" }));
      mock.emitImageMetadataReady("absent.jpg", {}, undefined, []);
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    mock.invocations.length = 0;
    let succeeded = false;
    act(() => {
      succeeded = result.current[1].removeMetadataFieldFromFilesV5(
        testId("XMP-dc:Title"),
        ["absent.jpg", "absent.jpg"],
      );
    });
    expect(succeeded).toBe(true);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(0);
  });

  it("writes one atomic GPS target batch with exact existing and missing-field targets", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    const path = "gps.jpg";
    const latitude = gpsOccurrence(GPS_IDS.latitude, 51.5, "GPSLatitude");
    const longitude = gpsOccurrence(GPS_IDS.longitude, 0.12, "GPSLongitude");
    act(() => {
      state.imageMetadataOccurrences.set(path, [latitude, longitude]);
    });
    let notifications = 0;
    const unsubscribe = state.targetDraftEditsStore.subscribe(() => {
      notifications += 1;
    });
    const beforeV5 = mock.invocations.filter(
      ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
    ).length;
    const beforeV4 = mock.invocations.filter(
      ({ cmd }) => cmd === "save_metadata_draft_edits",
    ).length;
    let saved = false;
    act(() => {
      saved = result.current[1].setGpsTargetDraftBatch(path, [
        {
          id: GPS_IDS.latitude,
          edit: { intent: "Set", value: { kind: "Real", value: 52 } },
        },
        {
          id: GPS_IDS.latitudeRef,
          edit: { intent: "Set", value: { kind: "Text", value: "N" } },
        },
        {
          id: GPS_IDS.longitude,
          edit: { intent: "Set", value: { kind: "Real", value: 1 } },
        },
        {
          id: GPS_IDS.longitudeRef,
          edit: { intent: "Set", value: { kind: "Text", value: "E" } },
        },
      ]);
    });
    unsubscribe();
    expect(saved).toBe(true);
    const entries = Object.values(
      state.targetDraftEditsStore.getMetadataFile(path) ?? {},
    );
    expect(entries).toHaveLength(4);
    const targetFor = (id: SchemaDefinitionId) =>
      entries.find(
        (entry) =>
          entry.target.schema_id.table === id.table &&
          entry.target.schema_id.tag_id === id.tag_id,
      )!.target;
    expect(targetFor(GPS_IDS.latitude)).toMatchObject({
      kind: "ExistingOccurrence",
      occurrence_id: latitude.id,
      write_target: latitude.write_target,
    });
    expect(targetFor(GPS_IDS.longitude)).toMatchObject({
      kind: "ExistingOccurrence",
      occurrence_id: longitude.id,
      write_target: longitude.write_target,
    });
    expect(targetFor(GPS_IDS.latitudeRef)).toEqual({
      kind: "NewProperty",
      schema_id: GPS_IDS.latitudeRef,
    });
    expect(targetFor(GPS_IDS.longitudeRef)).toEqual({
      kind: "NewProperty",
      schema_id: GPS_IDS.longitudeRef,
    });
    expect(notifications).toBe(1);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(beforeV5 + 1);
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(beforeV4);

    let altitudeNotifications = 0;
    const unsubscribeAltitude = state.targetDraftEditsStore.subscribe(() => {
      altitudeNotifications += 1;
    });
    const beforeAltitudeSave = mock.invocations.filter(
      ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
    ).length;
    act(() => {
      saved = result.current[1].setGpsTargetDraftBatch(path, [
        {
          id: GPS_IDS.latitude,
          edit: { intent: "Set", value: { kind: "Real", value: 52 } },
        },
        {
          id: GPS_IDS.latitudeRef,
          edit: { intent: "Set", value: { kind: "Text", value: "N" } },
        },
        {
          id: GPS_IDS.longitude,
          edit: { intent: "Set", value: { kind: "Real", value: 1 } },
        },
        {
          id: GPS_IDS.longitudeRef,
          edit: { intent: "Set", value: { kind: "Text", value: "E" } },
        },
        {
          id: GPS_IDS.altitude,
          edit: { intent: "Set", value: { kind: "Real", value: 100 } },
        },
        {
          id: GPS_IDS.altitudeRef,
          edit: { intent: "Set", value: { kind: "Integer", value: 0 } },
        },
      ]);
    });
    unsubscribeAltitude();
    expect(saved).toBe(true);
    expect(
      Object.values(state.targetDraftEditsStore.getMetadataFile(path) ?? {}),
    ).toHaveLength(6);
    expect(altitudeNotifications).toBe(1);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(beforeAltitudeSave + 1);
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(beforeV4);

    act(() => {
      saved = result.current[1].setGpsTargetDraftBatch(path, [
        {
          id: GPS_IDS.latitude,
          edit: { intent: "Set", value: { kind: "Real", value: 51.5 } },
        },
      ]);
    });
    expect(saved).toBe(true);
    expect(
      Object.values(
        state.targetDraftEditsStore.getMetadataFile(path) ?? {},
      ).some(
        (entry) =>
          entry.target.schema_id.table === GPS_IDS.latitude.table &&
          entry.target.schema_id.tag_id === GPS_IDS.latitude.tag_id,
      ),
    ).toBe(false);
  });

  it("rejects a GPS planning failure before mutation, notification or save", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    const path = "gps-failure.jpg";
    state.imageMetadataOccurrences.set(path, []);
    let notifications = 0;
    const unsubscribe = state.targetDraftEditsStore.subscribe(() => {
      notifications += 1;
    });
    const saveCount = mock.invocations.filter(
      ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
    ).length;
    let saved = true;
    act(() => {
      saved = result.current[1].setGpsTargetDraftBatch(path, [
        {
          id: GPS_IDS.latitude,
          edit: { intent: "Set", value: { kind: "Text", value: "first" } },
        },
        {
          id: GPS_IDS.latitude,
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "duplicate" },
          },
        },
      ]);
    });
    unsubscribe();
    expect(saved).toBe(false);
    expect(state.targetDraftEditsStore.getMetadataFile(path)).toBeUndefined();
    expect(notifications).toBe(0);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(saveCount);
    expect(result.current[0].kind).toBe("loaded");
    if (result.current[0].kind === "loaded") {
      const errors = result.current[0].workerErrors;
      expect(errors[errors.length - 1]?.error_message).toMatch(
        /same exact schema/i,
      );
    }
  });

  it("blocks exact-row creation while loading or when legacy/NewProperty ownership exists", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const id = testId("XMP-dc:Title");
    const occurrence = targetableOccurrence(id);
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "edited" },
    };

    act(() =>
      result.current[1].setExistingOccurrenceDraft(
        "loading.jpg",
        occurrence.id,
        edit,
      ),
    );
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["loading.jpg"]).toBeUndefined();

    act(() => {
      mock.emitImageMetadataReady(
        "legacy.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "current" } },
        undefined,
        [occurrence],
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() => {
      result.current[1].setMetadataDraftBatch("legacy.jpg", [{ id, edit }]);
      result.current[1].setExistingOccurrenceDraft(
        "legacy.jpg",
        occurrence.id,
        edit,
      );
    });
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["legacy.jpg"]).toBeUndefined();
    expect(state.draftEdits["legacy.jpg"]).toBeDefined();

    act(() => {
      mock.emitImageMetadataReady(
        "owned.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "current" } },
        undefined,
        [occurrence],
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() => {
      result.current[1].setNewPropertyDraft("owned.jpg", id, edit);
      result.current[1].setExistingOccurrenceDraft(
        "owned.jpg",
        occurrence.id,
        edit,
      );
    });
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(Object.values(state.targetDraftEdits["owned.jpg"])).toHaveLength(1);
    expect(
      Object.values(state.targetDraftEdits["owned.jpg"])[0].target.kind,
    ).toBe("NewProperty");
  });

  it("rejects missing, duplicate, read-only, untargetable, and different same-schema ownership", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    const id = testId("XMP-dc:Title");
    const exact = targetableOccurrence(id);
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "edited" },
    };

    act(() => {
      state.imageMetadataOccurrences.set("missing.jpg", []);
      result.current[1].setExistingOccurrenceDraft(
        "missing.jpg",
        exact.id,
        edit,
      );

      state.imageMetadataOccurrences.set("duplicate.jpg", [
        exact,
        structuredClone(exact),
      ]);
      result.current[1].setExistingOccurrenceDraft(
        "duplicate.jpg",
        exact.id,
        edit,
      );

      state.imageMetadataOccurrences.set("readonly.jpg", [
        {
          ...exact,
          tag_info: { ...exact.tag_info!, writable: false },
        },
      ]);
      result.current[1].setExistingOccurrenceDraft(
        "readonly.jpg",
        exact.id,
        edit,
      );

      state.imageMetadataOccurrences.set("untargetable.jpg", [
        { ...exact, write_target: null },
      ]);
      result.current[1].setExistingOccurrenceDraft(
        "untargetable.jpg",
        exact.id,
        edit,
      );
    });

    let current = result.current[0];
    if (current.kind !== "loaded") return;
    for (const path of [
      "missing.jpg",
      "duplicate.jpg",
      "readonly.jpg",
      "untargetable.jpg",
    ]) {
      expect(current.targetDraftEdits[path]).toBeUndefined();
    }

    const gpsId: SchemaDefinitionId = { table: "GPS::Main", tag_id: "2" };
    const gpsOccurrence: MetadataOccurrence = {
      ...targetableOccurrence(gpsId),
      tag_info: {
        id: gpsId,
        group: "GPS",
        name: "GPSLatitude",
        writable: true,
        kind: { kind: "Real" },
        description: null,
      },
      write_target: { group1: "GPS", tag_name: "GPSLatitude" },
    };
    const loadedBeforeGps = current;
    act(() => {
      loadedBeforeGps.imageMetadataOccurrences.set("gps.jpg", [gpsOccurrence]);
      result.current[1].setExistingOccurrenceDraft(
        "gps.jpg",
        gpsOccurrence.id,
        { intent: "Set", value: { kind: "Real", value: 52 } },
      );
    });
    current = result.current[0];
    if (current.kind !== "loaded") return;
    expect(Object.values(current.targetDraftEdits["gps.jpg"])).toHaveLength(1);

    const ownerOccurrence = targetableOccurrence(id, "sibling", {
      copy: 1,
      path: "JPEG-APP1-IFD1",
      tagName: "SiblingTitle",
    });
    const loadedState = current;
    act(() => {
      loadedState.imageMetadataOccurrences.set("owned-existing.jpg", [exact]);
      loadedState.targetDraftEditsStore.setMetadataTarget(
        "owned-existing.jpg",
        {
          kind: "ExistingOccurrence",
          occurrence_id: ownerOccurrence.id,
          schema_id: id,
          write_target: ownerOccurrence.write_target!,
        },
        edit,
      );
      result.current[1].setExistingOccurrenceDraft(
        "owned-existing.jpg",
        exact.id,
        edit,
      );
    });
    current = result.current[0];
    if (current.kind !== "loaded") return;
    const owners = Object.values(
      current.targetDraftEdits["owned-existing.jpg"],
    );
    expect(owners).toHaveLength(1);
    expect(owners[0].target).toMatchObject({
      kind: "ExistingOccurrence",
      occurrence_id: ownerOccurrence.id,
    });
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
      result.current[1].setMetadataDraftBatch("legacy.jpg", [
        { id: testId("XMP-dc:Title"), edit },
      ]);
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

  it("invalidates image sorting for v5 progress exactly once when the final result is identical", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" }));
      mock.emitPhotoFound(makePhoto({ relative_path: "b.jpg" }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    act(() => {
      mock.emitImageMetadataReady("a.jpg", {
        "XMP-dc:Title": { kind: "Text", value: "Zulu" },
      });
      mock.emitImageMetadataReady("b.jpg", {
        "XMP-dc:Title": { kind: "Text", value: "Alpha" },
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    act(() => {
      mock.emitScanComplete();
      result.current[1].setSortConfig({
        primary: {
          kind: "image",
          id: testId("XMP-dc:Title"),
          direction: "asc",
        },
        secondary: null,
      });
    });

    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(
      sortPhotos(state.photos, state.sortConfig, state.imageMetadata).map(
        (photo) => photo.relative_path,
      ),
    ).toEqual(["b.jpg", "a.jpg"]);
    const resultV5 = targetV5Result(
      "a.jpg",
      testId("XMP-dc:Title"),
      "Aardvark",
    );
    mock.targetApplyProgressResultsByPath["a.jpg"] = resultV5;
    mock.targetApplyFinalResultsByPath["a.jpg"] = structuredClone(resultV5);
    act(() =>
      result.current[1].setNewPropertyDraft("a.jpg", testId("XMP-dc:Subject"), {
        intent: "Set",
        value: { kind: "Text", value: "draft" },
      }),
    );
    await act(async () => result.current[1].applyDraftEdits("a.jpg"));

    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.metadataVersion).toBe(1);
    expect(
      sortPhotos(state.photos, state.sortConfig, state.imageMetadata).map(
        (photo) => photo.relative_path,
      ),
    ).toEqual(["a.jpg", "b.jpg"]);
  });

  it("invalidates v5 final-only metadata and invalidates again for a genuinely different final result", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const draftId = testId("XMP-dc:Subject");
    const metadataId = testId("XMP-dc:Title");
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "draft" },
    };

    act(() =>
      result.current[1].setNewPropertyDraft("final.jpg", draftId, edit),
    );
    mock.targetApplyProgressResultsByPath["final.jpg"] = targetV5Result(
      "final.jpg",
      metadataId,
      null,
    );
    mock.targetApplyFinalResultsByPath["final.jpg"] = targetV5Result(
      "final.jpg",
      metadataId,
      "final only",
    );
    await act(async () => result.current[1].applyDraftEdits("final.jpg"));
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.metadataVersion).toBe(1);

    act(() =>
      result.current[1].setNewPropertyDraft("changed.jpg", draftId, edit),
    );
    mock.targetApplyProgressResultsByPath["changed.jpg"] = targetV5Result(
      "changed.jpg",
      metadataId,
      "progress",
    );
    mock.targetApplyFinalResultsByPath["changed.jpg"] = targetV5Result(
      "changed.jpg",
      metadataId,
      "different final",
    );
    await act(async () => result.current[1].applyDraftEdits("changed.jpg"));
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.metadataVersion).toBe(3);
  });

  it("does not bump metadataVersion for a draft-only v5 result", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const id = testId("XMP-dc:Subject");
    act(() =>
      result.current[1].setNewPropertyDraft("draft-only.jpg", id, {
        intent: "Set",
        value: { kind: "Text", value: "draft" },
      }),
    );
    await act(async () => result.current[1].applyDraftEdits("draft-only.jpg"));
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);
  });

  it("invalidates stale occurrences after v4 fresh metadata and allows scan or v5 to restore them", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitPhotoFound(makePhoto({ relative_path: "same.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const id = testId("XMP-dc:Title");
    const oldOccurrence = targetV5Result("same.jpg", id, "old")
      .fresh_image_metadata!.occurrences[0];
    act(() =>
      mock.emitImageMetadataReady(
        "same.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "old" } },
        undefined,
        [oldOccurrence],
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    mock.applyEditsResult = {
      applied: ["same.jpg"],
      failed: [],
      fresh_metadata: {
        "same.jpg": [{ id, value: { kind: "Text", value: "fresh v4" } }],
      },
    };
    act(() =>
      result.current[1].setMetadataDraftBatch("same.jpg", [
        {
          id,
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "fresh v4" },
          },
        },
      ]),
    );
    await act(async () => result.current[1].applyDraftEdits("same.jpg"));

    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.imageMetadataOccurrences.get("same.jpg")).toBe("loading");
    const freshV4Metadata = state.imageMetadata.get("same.jpg");
    expect(freshV4Metadata).not.toBe("loading");
    if (freshV4Metadata === "loading") return;
    expect(metadataGet(freshV4Metadata, id)).toMatchObject({
      value: "fresh v4",
    });

    const scannedOccurrence = targetV5Result("same.jpg", id, "rescanned")
      .fresh_image_metadata!.occurrences[0];
    act(() =>
      mock.emitImageMetadataReady(
        "same.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "rescanned" } },
        undefined,
        [scannedOccurrence],
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.imageMetadataOccurrences.get("same.jpg")).toEqual([
      scannedOccurrence,
    ]);

    act(() =>
      result.current[1].setNewPropertyDraft(
        "same.jpg",
        testId("XMP-dc:Subject"),
        {
          intent: "Set",
          value: { kind: "Text", value: "new" },
        },
      ),
    );
    const v5Result = targetV5Result("same.jpg", id, "fresh v5", {
      occurrenceCopy: 2,
    });
    mock.targetApplyProgressResultsByPath["same.jpg"] = v5Result;
    await act(async () => result.current[1].applyDraftEdits("same.jpg"));
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.imageMetadataOccurrences.get("same.jpg")).toEqual(
      v5Result.fresh_image_metadata!.occurrences,
    );
  });

  it("leaves occurrences unchanged when v4 produces no fresh metadata", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitPhotoFound(makePhoto({ relative_path: "error.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const id = testId("XMP-dc:Title");
    const occurrence = targetV5Result("error.jpg", id, "unchanged")
      .fresh_image_metadata!.occurrences[0];
    act(() =>
      mock.emitImageMetadataReady(
        "error.jpg",
        { "XMP-dc:Title": { kind: "Text", value: "unchanged" } },
        undefined,
        [occurrence],
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    mock.applyEditsResult = {
      applied: [],
      failed: [{ relative_path: "error.jpg", reason: "write failed" }],
      fresh_metadata: {},
    };
    act(() =>
      result.current[1].setMetadataDraftBatch("error.jpg", [
        {
          id,
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "attempt" },
          },
        },
      ]),
    );
    await act(async () => result.current[1].applyDraftEdits("error.jpg"));
    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.imageMetadataOccurrences.get("error.jpg")).toEqual([
        occurrence,
      ]);
    }
  });

  it("ends a mixed same-file v5 then v4 apply with fresh compatibility and invalidated occurrences", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const targetId = testId("XMP-dc:Subject");
    const legacyId = testId("XMP-dc:Title");
    act(() => {
      result.current[1].setNewPropertyDraft("same.jpg", targetId, {
        intent: "Set",
        value: { kind: "Text", value: "target" },
      });
      result.current[1].setMetadataDraftBatch("same.jpg", [
        {
          id: legacyId,
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "legacy" },
          },
        },
      ]);
    });
    mock.targetApplyProgressResultsByPath["same.jpg"] = targetV5Result(
      "same.jpg",
      targetId,
      "v5 complete",
    );
    mock.applyEditsResult = {
      applied: ["same.jpg"],
      failed: [],
      fresh_metadata: {
        "same.jpg": [
          { id: legacyId, value: { kind: "Text", value: "v4 final" } },
        ],
      },
    };

    await act(async () => result.current[1].applyDraftEdits("same.jpg"));
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(
      mock.invocations
        .filter(({ cmd }) =>
          [
            "apply_metadata_draft_edits_v5_cmd",
            "apply_metadata_draft_edits_cmd",
          ].includes(cmd),
        )
        .map(({ cmd }) => cmd),
    ).toEqual([
      "apply_metadata_draft_edits_v5_cmd",
      "apply_metadata_draft_edits_cmd",
    ]);
    expect(state.imageMetadataOccurrences.get("same.jpg")).toBe("loading");
    const mixedMetadata = state.imageMetadata.get("same.jpg");
    expect(mixedMetadata).not.toBe("loading");
    if (mixedMetadata === "loading") return;
    expect(metadataGet(mixedMetadata, legacyId)).toMatchObject({
      value: "v4 final",
    });
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

  it("treats a valid empty v5 load as writable", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(state.targetDraftPersistence).toEqual({ status: "ready" });

    act(() =>
      result.current[1].setNewPropertyDraft("new.jpg", testId("XMP-dc:Title"), {
        intent: "Set",
        value: { kind: "Text", value: "writable" },
      }),
    );
    expect(
      state.targetDraftEditsStore.getMetadataFile("new.jpg"),
    ).toBeDefined();
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(1);
  });

  it("target verification actions use the exact replacement slot and v5 persistence only", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    const targetDraftStore = state.targetDraftEditsStore;
    const targetVerificationStore = state.targetVerifyOutcomesStore;

    const id = testId("XMP-dc:Subject");
    const replacement = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: {
        document: null,
        path: "JPEG-APP1-XMP",
        tag_id: id.tag_id,
        copy: 0,
      },
      schema_id: id,
      write_target: { group1: "XMP-dc", tag_name: "SubjectPrimary" },
    };
    const sibling = {
      ...structuredClone(replacement),
      occurrence_id: { ...replacement.occurrence_id, copy: 1 },
      write_target: { group1: "XMP-dc", tag_name: "SubjectSibling" },
    };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "pending" },
    };
    act(() => {
      targetDraftStore.setMetadataTarget("replace.jpg", replacement, edit);
      targetDraftStore.setMetadataTarget("replace.jpg", sibling, edit);
    });
    const entry = targetVerifyOutcomeFromBackend("replace.jpg", {
      target: { kind: "NewProperty", schema_id: id },
      draft_reconciliation: { kind: "Replace", target: replacement },
      display_name: "Subject",
      kind: "Mismatch",
      sent: { kind: "Text", value: "pending" },
      before: null,
      observed: { kind: "Text", value: "on disk" },
      message: "coerced",
    })!;
    act(() => targetVerificationStore.replaceFile("replace.jpg", [entry]));
    mock.invocations.length = 0;

    act(() =>
      result.current[1].acceptTargetVerifyOutcome("replace.jpg", replacement),
    );
    let current = result.current[0];
    if (current.kind !== "loaded") return;
    expect(
      current.targetDraftEdits["replace.jpg"][
        metadataDraftTargetSlotToken(replacement)
      ],
    ).toBeUndefined();
    expect(
      current.targetDraftEdits["replace.jpg"][
        metadataDraftTargetSlotToken(sibling)
      ],
    ).toBeDefined();
    expect(current.targetVerifyOutcomes["replace.jpg"]).toBeUndefined();
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(1);
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(0);

    act(() => {
      targetDraftStore.setMetadataTarget("replace.jpg", replacement, edit);
      targetVerificationStore.replaceFile("replace.jpg", [entry]);
    });
    mock.invocations.length = 0;
    act(() =>
      result.current[1].keepTargetDraftAndDismissOutcome(
        "replace.jpg",
        replacement,
      ),
    );
    current = result.current[0];
    if (current.kind !== "loaded") return;
    expect(
      current.targetDraftEdits["replace.jpg"][
        metadataDraftTargetSlotToken(replacement)
      ],
    ).toBeDefined();
    expect(current.targetVerifyOutcomes["replace.jpg"]).toBeUndefined();
    expect(mock.invocations).toHaveLength(0);

    act(() => targetVerificationStore.replaceFile("replace.jpg", [entry]));
    act(() =>
      result.current[1].discardTargetDraftAndOutcome(
        "replace.jpg",
        replacement,
      ),
    );
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(1);
  });

  it("production v5 apply installs authoritative replacement verification and surfaces diagnostics once", async () => {
    const mock = createMockTauriApi();
    const path = "add-property.jpg";
    const id = testId("XMP-dc:Subject");
    const original = { kind: "NewProperty" as const, schema_id: id };
    const replacement = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: {
        document: null,
        path: "JPEG-APP1-XMP",
        tag_id: id.tag_id,
        copy: 2,
      },
      schema_id: id,
      write_target: { group1: "XMP-dc", tag_name: "SubjectRuntime" },
    };
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(path, original, {
      intent: "Set",
      value: { kind: "Text", value: "requested" },
    });
    mock.targetDraftEditsByFolder["/photos"] = store.getAllMetadata();
    const fileResult: MetadataApplyFileResultV5 = {
      relative_path: path,
      applied: false,
      error: "semantic write failure",
      warning: "file metadata was partially refreshed",
      fresh_image_metadata: null,
      target_outcomes: [
        {
          target: original,
          draft_reconciliation: { kind: "Replace", target: replacement },
          display_name: "Subject",
          kind: "Mismatch",
          sent: { kind: "Text", value: "requested" },
          before: null,
          observed: { kind: "Text", value: "observed" },
          message: "verification mismatch",
        },
      ],
      persisted_draft_entries: [
        {
          target: replacement,
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "requested" },
          },
        },
      ],
    };
    mock.targetApplyProgressResultsByPath[path] = fileResult;
    mock.targetApplyFinalResultsByPath[path] = structuredClone(fileResult);
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    await act(async () => result.current[1].applyDraftEdits(path));

    const state = result.current[0];
    if (state.kind !== "loaded") return;
    const verification = Object.values(state.targetVerifyOutcomes[path])[0];
    expect(verification.originalTarget).toEqual(original);
    expect(verification.currentTarget).toEqual(replacement);
    expect(Object.values(state.targetDraftEdits[path])[0].target).toEqual(
      replacement,
    );
    expect(
      state.workerErrors.filter(
        ({ worker_type }) => worker_type === "metadata-v5-file",
      ),
    ).toHaveLength(1);
    expect(
      state.workerErrors.filter(
        ({ worker_type }) => worker_type === "metadata-v5-warning",
      ),
    ).toHaveLength(1);
    expect(
      state.workerErrors[state.workerErrors.length - 1]?.affected_files,
    ).toEqual([path]);
  });

  it("blocks every target mutation and v5 apply after strict-load failure while v4 remains usable", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/broken");
    mock.applyEditsResult = {
      applied: ["legacy.jpg"],
      failed: [],
      fresh_metadata: {
        "legacy.jpg": [
          {
            id: testId("XMP-dc:Title"),
            value: { kind: "Text", value: "legacy result" },
          },
        ],
      },
    };
    const api = {
      ...mock.api,
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        cmd === "load_metadata_draft_edits_v5" && args?.folderPath === "/broken"
          ? Promise.reject(new Error("malformed v5 file"))
          : mock.api.invoke(cmd, args),
    };
    const { result } = renderHook(() => useMediaLibrary(api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftPersistence).toEqual({
      status: "load-failed",
      error: "malformed v5 file",
    });
    const targetSnapshot = state.targetDraftEdits;
    const id = testId("XMP-dc:Subject");
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "blocked" },
    };
    const existingTarget = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: {
        document: null,
        path: "JPEG-APP1-XMP",
        tag_id: id.tag_id,
        copy: 0,
      },
      schema_id: id,
      write_target: { group1: "XMP-dc", tag_name: "Subject" },
    };

    let groupRemovalSucceeded = true;
    let selectedRemovalSucceeded = true;
    act(() => {
      result.current[1].setNewPropertyDraft("blocked.jpg", id, edit);
      result.current[1].setExistingOccurrenceDraft(
        "blocked.jpg",
        existingTarget.occurrence_id,
        edit,
      );
      result.current[1].discardTargetPropertyDraft(
        "blocked.jpg",
        existingTarget,
      );
      groupRemovalSucceeded = result.current[1].removeMetadataFieldsV5(
        "blocked.jpg",
        [id],
      );
      selectedRemovalSucceeded =
        result.current[1].removeMetadataFieldFromFilesV5(id, ["blocked.jpg"]);
    });
    expect(groupRemovalSucceeded).toBe(false);
    expect(selectedRemovalSucceeded).toBe(false);
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits).toBe(targetSnapshot);
    expect(state.targetDraftEdits).toEqual({});
    const loadFailedTargetDraftStore = state.targetDraftEditsStore;
    const loadFailedTargetVerificationStore = state.targetVerifyOutcomesStore;
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(0);

    act(() =>
      loadFailedTargetDraftStore.setMetadataTarget(
        "blocked.jpg",
        existingTarget,
        edit,
      ),
    );
    const blockedVerification = targetVerifyOutcomeFromBackend("blocked.jpg", {
      target: existingTarget,
      draft_reconciliation: { kind: "Blocked", reason: "stale" },
      display_name: "Subject",
      kind: "Blocked",
      sent: null,
      before: null,
      observed: null,
      message: null,
    })!;
    act(() =>
      loadFailedTargetVerificationStore.replaceFile("blocked.jpg", [
        blockedVerification,
      ]),
    );
    act(() => {
      result.current[1].acceptTargetVerifyOutcome(
        "blocked.jpg",
        existingTarget,
      );
      result.current[1].keepTargetDraftAndDismissOutcome(
        "blocked.jpg",
        existingTarget,
      );
      result.current[1].discardTargetDraftAndOutcome(
        "blocked.jpg",
        existingTarget,
      );
    });
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits["blocked.jpg"]).toBeDefined();
    expect(state.targetVerifyOutcomes["blocked.jpg"]).toBeDefined();
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(0);

    await act(async () => {
      await expect(
        result.current[1].applyDraftEdits("blocked.jpg"),
      ).rejects.toThrow(/could not be loaded safely/);
    });
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
      ),
    ).toHaveLength(0);

    // Even if a non-UI caller mutates the exposed store directly, the apply
    // boundary still refuses to invoke v5 for the failed-load folder.
    act(() =>
      state.targetDraftEditsStore.setMetadataTarget(
        "forced.jpg",
        { kind: "NewProperty", schema_id: id },
        edit,
      ),
    );
    await act(async () => {
      await expect(
        result.current[1].applyDraftEdits("forced.jpg"),
      ).rejects.toThrow(/could not be loaded safely/);
    });
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
      ),
    ).toHaveLength(0);

    act(() =>
      result.current[1].setMetadataDraftBatch("legacy.jpg", [
        { id: testId("XMP-dc:Title"), edit },
      ]),
    );
    await act(async () => {
      await result.current[1].applyDraftEdits("legacy.jpg");
    });
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
      ),
    ).toHaveLength(1);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toHaveLength(0);
  });

  it("enforces exact target-schema ownership while retaining the existing NewProperty slot", async () => {
    const mock = createMockTauriApi();
    const path = "owned.jpg";
    const id = testId("XMP-dc:Subject");
    const zero = { ...id, index: 0 };
    const initial = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "initial" },
    };
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(
      path,
      { kind: "NewProperty", schema_id: id },
      initial,
    );
    const concrete = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: {
        document: null,
        path: "JPEG-APP1-XMP",
        tag_id: id.tag_id,
        copy: 0,
      },
      schema_id: zero,
      write_target: { group1: "XMP-dc", tag_name: "Subject" },
    };
    store.setMetadataTarget(path, concrete, initial);
    mock.targetDraftEditsByFolder["/photos"] = store.getAllMetadata();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const replacement = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "replacement" },
    };
    act(() => result.current[1].setNewPropertyDraft(path, id, replacement));
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    const afterReplacement = state.targetDraftEdits[path];
    expect(Object.values(afterReplacement)).toHaveLength(2);
    expect(
      Object.values(afterReplacement).find(
        (entry) => entry.target.kind === "NewProperty",
      )?.edit,
    ).toEqual(replacement);

    const beforeRejected = state.targetDraftEdits;
    act(() => result.current[1].setNewPropertyDraft(path, zero, replacement));
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits).toBe(beforeRejected);
    expect(Object.values(state.targetDraftEdits[path])).toHaveLength(2);
    expect(state.draftEdits[path]).toBeUndefined();
    expect(
      state.workerErrors[state.workerErrors.length - 1]?.error_message,
    ).toMatch(/target-aware ownership/);
  });

  it("rejects ambiguous exact-schema target ownership without creating a third target", async () => {
    const mock = createMockTauriApi();
    const path = "ambiguous.jpg";
    const id = testId("XMP-dc:Subject");
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "existing" },
    };
    const store = new TargetDraftEditsStore();
    for (const copy of [0, 1]) {
      store.setMetadataTarget(
        path,
        {
          kind: "ExistingOccurrence",
          occurrence_id: {
            document: null,
            path: "JPEG-APP1-XMP",
            tag_id: id.tag_id,
            copy,
          },
          schema_id: id,
          write_target: { group1: "XMP-dc", tag_name: `Subject-${copy}` },
        },
        edit,
      );
    }
    store.setMetadataTarget(
      "mixed.jpg",
      { kind: "NewProperty", schema_id: id },
      edit,
    );
    store.setMetadataTarget(
      "mixed.jpg",
      {
        kind: "ExistingOccurrence",
        occurrence_id: {
          document: null,
          path: "JPEG-APP1-XMP",
          tag_id: id.tag_id,
          copy: 0,
        },
        schema_id: id,
        write_target: { group1: "XMP-dc", tag_name: "Subject" },
      },
      edit,
    );
    mock.targetDraftEditsByFolder["/photos"] = store.getAllMetadata();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const before = result.current[0];
    if (before.kind !== "loaded") return;
    const snapshot = before.targetDraftEdits;

    act(() =>
      result.current[1].setNewPropertyDraft(path, id, {
        intent: "Set",
        value: { kind: "Text", value: "third" },
      }),
    );
    const after = result.current[0];
    if (after.kind !== "loaded") return;
    expect(after.targetDraftEdits).toBe(snapshot);
    expect(Object.values(after.targetDraftEdits[path])).toHaveLength(2);
    expect(after.draftEdits[path]).toBeUndefined();

    const beforeMixed = after.targetDraftEdits;
    act(() =>
      result.current[1].setNewPropertyDraft("mixed.jpg", id, {
        intent: "Set",
        value: { kind: "Text", value: "replacement" },
      }),
    );
    const afterMixed = result.current[0];
    if (afterMixed.kind !== "loaded") return;
    expect(afterMixed.targetDraftEdits).toBe(beforeMixed);
    expect(
      Object.values(afterMixed.targetDraftEdits["mixed.jpg"]),
    ).toHaveLength(2);
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
    expect(state.targetDraftPersistence).toEqual({
      status: "load-failed",
      error: "invalid schema version",
    });
    expect(state.workerErrors[0].worker_type).toBe("metadata-v5-load");
    expect(
      mock.invocations.some(
        ({ cmd }) => cmd === "save_metadata_draft_edits_v5",
      ),
    ).toBe(false);

    await act(async () => result.current[1].openRecent("/second"));
    act(() => mock.emitScanComplete());
    const secondState = result.current[0];
    if (secondState.kind !== "loaded") return;
    expect(secondState.folder).toBe("/second");
    expect(secondState.targetDraftPersistence).toEqual({ status: "ready" });
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
    expect(
      mock.invocations.some(
        ({ cmd, args }) =>
          cmd === "save_metadata_draft_edits_v5" &&
          args?.folderPath === "/photos",
      ),
    ).toBe(false);
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
