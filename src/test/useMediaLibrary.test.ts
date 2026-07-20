import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi, type MockTauriApi } from "./mockTauriApi";
import { makePhoto, makePhotos, testId } from "./factories";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataApplyFileResult,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import { targetVerifyOutcomeFromBackend } from "../targetVerifyOutcomes";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import {
  family7GroupFromRuntimeTagId,
  family7GroupFromSchemaId,
} from "../utils/metadataWriteTarget";
import { sortPhotos } from "../utils/sorting";

async function expectConsoleErrorMessages(
  expected: readonly string[],
  action: () => void | Promise<void>,
): Promise<void> {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await action();
    const renderedMessages = consoleError.mock.calls.map((args) =>
      args.map((value) => String(value)).join(" "),
    );
    expect(renderedMessages).toEqual(expected);
  } finally {
    consoleError.mockRestore();
  }
}

function targetDraftResult(
  path: string,
  id: SchemaDefinitionId,
  value: string | null,
  options: { occurrenceCopy?: number; persistedDraftEntries?: [] | null } = {},
): MetadataApplyFileResult {
  const occurrence: MetadataOccurrence = {
    id: {
      document: null,
      path: "JPEG-APP1-XMP",
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
      copy: options.occurrenceCopy ?? 0,
    },
    schema_id: structuredClone(id),
    value: { kind: "Text", value: value ?? "" },
    tag_info: null,
    observed_selector: null,
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
          },
    target_outcomes: [],
    persisted_draft_entries: options.persistedDraftEntries ?? [],
  };
}

function tagInfoFor(
  id: SchemaDefinitionId,
  options: { writable?: boolean; kind?: TagKind; name?: string } = {},
): TagInfo {
  return {
    id: structuredClone(id),
    group: "XMP-test",
    name: options.name ?? "TestField",
    writable: options.writable ?? true,
    kind: options.kind ?? { kind: "Text" },
    description: null,
  };
}

function newPropertyTargetFor(id: SchemaDefinitionId) {
  return {
    kind: "NewProperty" as const,
    schema_id: structuredClone(id),
    write_target: {
      group1: "XMP-test",
      group7: family7GroupFromSchemaId(id),
      tag_name: "TestField",
    },
  };
}

async function publishOccurrences(
  mock: MockTauriApi,
  relativePath: string,
  occurrences: MetadataOccurrence[] = [],
): Promise<void> {
  act(() => {
    mock.emitImageMetadataReady(relativePath, {}, undefined, occurrences);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

function occurrenceFor(id: SchemaDefinitionId, copy = 0): MetadataOccurrence {
  const runtimeTagId = family7GroupFromSchemaId(id).slice("ID-".length);
  return {
    id: {
      document: null,
      path: "JPEG-APP1-XMP",
      runtime_tag_id: runtimeTagId,
      tag_id_scope: {
        table: id.table,
        tag_id: id.tag_id,
        index: id.index ?? null,
      },
      copy,
    },
    schema_id: structuredClone(id),
    value: { kind: "Text", value: `existing-${copy}` },
    tag_info: tagInfoFor(id),
    observed_selector: {
      group1: "XMP-test",
      group7: family7GroupFromRuntimeTagId(runtimeTagId),
      tag_name: "TestField",
    },
    write_target: {
      group1: "XMP-test",
      group7: family7GroupFromRuntimeTagId(runtimeTagId),
      tag_name: "TestField",
    },
  };
}

function deferNextTagInfoLookup(mock: MockTauriApi): {
  resolve: (info: TagInfo | null) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (info: TagInfo | null) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TagInfo | null>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  const invoke = mock.api.invoke;
  mock.api.invoke = async (cmd, args) => {
    if (cmd !== "get_tag_info") return invoke(cmd, args);
    mock.api.invoke = invoke;
    mock.invocations.push({ cmd, args });
    return promise;
  };
  return { resolve, reject };
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
      const metadata = state.imageMetadataOccurrences.get("a.jpg");
      expect(metadata).not.toBe("loading");
      if (metadata !== "loading") {
        expect(
          metadata.find(
            (item) =>
              item.schema_id.table === testId("IFD0:Orientation").table &&
              item.schema_id.tag_id === testId("IFD0:Orientation").tag_id,
          )?.value,
        ).toEqual({ kind: "Integer", value: 6 });
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

    await expectConsoleErrorMessages(["Scan error: not a directory"], () => {
      act(() => {
        mock.emitScanError("not a directory");
      });
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

    await expectConsoleErrorMessages(["Scan error: disk read failed"], () => {
      act(() => {
        mock.emitScanError("disk read failed");
      });
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

  it("worker_error events append to applicationErrors when loaded", async () => {
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

    await expectConsoleErrorMessages(
      [
        "Worker error (metadata): ExifTool failed",
        "Worker error (thumbnail): decode failed",
      ],
      () => {
        act(() => {
          mock.emitWorkerError("metadata", "ExifTool failed", ["a.jpg"]);
        });
        act(() => {
          mock.emitWorkerError("thumbnail", "decode failed", ["b.jpg"]);
        });
      },
    );

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.applicationErrors).toHaveLength(2);
      expect(state.applicationErrors[0].error_type).toBe("metadata");
      expect(state.applicationErrors[0].error_message).toBe("ExifTool failed");
      expect(state.applicationErrors[0].affected_files).toEqual(["a.jpg"]);
      expect(state.applicationErrors[1].error_type).toBe("thumbnail");
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

    await expectConsoleErrorMessages(
      [
        "Worker error (metadata): first error",
        "Worker error (metadata): second error",
      ],
      () => {
        act(() => {
          mock.emitWorkerError("metadata", "first error");
        });
        act(() => {
          mock.emitWorkerError("metadata", "second error");
        });
      },
    );

    act(() => {
      result.current[1].dismissError(0);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.applicationErrors).toHaveLength(1);
      expect(state.applicationErrors[0].error_message).toBe("second error");
    }
  });

  it("applicationErrors is capped and keeps the most recent entries", async () => {
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

    await expectConsoleErrorMessages(
      Array.from(
        { length: 30 },
        (_, index) => `Worker error (metadata): error ${index}`,
      ),
      () => {
        for (let i = 0; i < 30; i++) {
          act(() => {
            mock.emitWorkerError("metadata", `error ${i}`);
          });
        }
      },
    );

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.applicationErrors.length).toBeLessThanOrEqual(20);
      // The most recent error must be retained.
      expect(
        state.applicationErrors[state.applicationErrors.length - 1]
          .error_message,
      ).toBe("error 29");
      // The oldest one must have been dropped.
      expect(
        state.applicationErrors.find((e) => e.error_message === "error 0"),
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
      expect(state.imageMetadataOccurrences.get("a.jpg")).toBe("loading");
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

    await expectConsoleErrorMessages(["Worker error (metadata): stale"], () => {
      act(() => {
        mock.emitWorkerError(
          "metadata",
          "stale",
          ["x.jpg"],
          mock.currentScanId - 1,
        );
      });
    });
    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.applicationErrors).toHaveLength(1);
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

  it("retains colliding occurrences while the schema-keyed projection stays blank and progress increments once", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitPhotoFound(makePhoto({ relative_path: "a.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));

    const schemaId = testId("IFD0:XResolution");
    const occurrence = {
      id: {
        document: null,
        path: "JPEG-APP1-IFD0",
        runtime_tag_id: "282",
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: "282",
          index: null,
        },
        copy: 0,
      },
      schema_id: structuredClone(schemaId),
      value: { kind: "Integer" as const, value: 300 },
      tag_info: {
        id: schemaId,
        group: "IFD0",
        name: "XResolution",
        writable: true,
        kind: { kind: "Rational" as const },
        description: "X resolution",
      },
      observed_selector: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "XResolution",
      },
      write_target: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "XResolution",
      },
    };
    const secondOccurrence = {
      ...occurrence,
      id: {
        document: null,
        path: "JPEG-APP1-IFD1",
        runtime_tag_id: "282",
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: "282",
          index: null,
        },
        copy: 1,
      },
      value: { kind: "Integer" as const, value: 72 },
      observed_selector: {
        group1: "IFD1",
        group7: "ID-Test",
        tag_name: "XResolution",
      },
      write_target: {
        group1: "IFD1",
        group7: "ID-Test",
        tag_name: "XResolution",
      },
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
      const loaded = state.imageMetadataOccurrences.get("a.jpg");
      expect(loaded).not.toBe("loading");
      if (loaded !== "loading") {
        expect(
          loaded.filter(
            (item) =>
              item.schema_id.table === schemaId.table &&
              item.schema_id.tag_id === schemaId.tag_id,
          ),
        ).toHaveLength(2);
      }
      expect(state.metadataProgress.getRemaining()).toBe(0);
      expect(state.applicationErrors).toEqual([]);
    }
  });

  it("empty failed-file payloads clear occurrence loading", async () => {
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
    }
  });

  it("stale metadata does not update occurrences and a replacement scan clears them", async () => {
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
            id: {
              document: null,
              path: "IFD0",
              runtime_tag_id: "272",
              tag_id_scope: {
                table: "TestFixture::Runtime",
                tag_id: "272",
                index: null,
              },
              copy: 0,
            },
            schema_id: { table: "Exif::Main", tag_id: "272" },
            value: { kind: "Text", value: "stale" },
            tag_info: null,
            observed_selector: null,
            write_target: null,
          },
        ],
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(oldStore.get("a.jpg")).toBe("loading");
    expect(firstState.imageMetadataOccurrences.get("a.jpg")).toBe("loading");

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
  it("loads the active folder's exact target drafts", async () => {
    const mock = createMockTauriApi();
    const id = testId("XMP-dc:Title");
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(
      "drafted.jpg",
      {
        kind: "NewProperty",
        schema_id: id,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
      { intent: "Set", value: { kind: "Text", value: "pending" } },
    );
    mock.targetDraftEditsByFolder["/photos"] = store.getAllMetadata();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(Object.values(state.targetDraftEdits["drafted.jpg"])).toEqual([
      expect.objectContaining({
        target: {
          kind: "NewProperty",
          schema_id: id,
          write_target: {
            group1: "XMP-test",
            group7: "ID-Test",
            tag_name: "TestTag",
          },
        },
      }),
    ]);
    expect(state.targetDraftPersistence).toEqual({ status: "ready" });
  });
  it("invalidates image sorting for target-aware progress exactly once when the final result is identical", async () => {
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
      sortPhotos(
        state.photos,
        state.sortConfig,
        state.imageMetadataOccurrences,
      ).map((photo) => photo.relative_path),
    ).toEqual(["b.jpg", "a.jpg"]);
    const progressResult = targetDraftResult(
      "a.jpg",
      testId("XMP-dc:Title"),
      "Aardvark",
    );
    mock.targetApplyProgressResultsByPath["a.jpg"] = progressResult;
    mock.targetApplyFinalResultsByPath["a.jpg"] =
      structuredClone(progressResult);
    const subjectId = testId("XMP-dc:Subject");
    mock.tagInfos = [tagInfoFor(subjectId)];
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "a.jpg",
        newPropertyTargetFor(subjectId),
        {
          intent: "Set",
          value: { kind: "Text", value: "draft" },
        },
      );
    });
    await act(async () => result.current[1].applyDraftEdits("a.jpg"));

    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.metadataVersion).toBe(1);
    expect(
      sortPhotos(
        state.photos,
        state.sortConfig,
        state.imageMetadataOccurrences,
      ).map((photo) => photo.relative_path),
    ).toEqual(["a.jpg", "b.jpg"]);
  });

  it("invalidates target-aware final-only metadata and invalidates again for a genuinely different final result", async () => {
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
    mock.tagInfos = [tagInfoFor(draftId)];

    await publishOccurrences(mock, "final.jpg");
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "final.jpg",
        newPropertyTargetFor(draftId),
        edit,
      );
    });
    mock.targetApplyProgressResultsByPath["final.jpg"] = targetDraftResult(
      "final.jpg",
      metadataId,
      null,
    );
    mock.targetApplyFinalResultsByPath["final.jpg"] = targetDraftResult(
      "final.jpg",
      metadataId,
      "final only",
    );
    await act(async () => result.current[1].applyDraftEdits("final.jpg"));
    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.metadataVersion).toBe(1);

    await publishOccurrences(mock, "changed.jpg");
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "changed.jpg",
        newPropertyTargetFor(draftId),
        edit,
      );
    });
    mock.targetApplyProgressResultsByPath["changed.jpg"] = targetDraftResult(
      "changed.jpg",
      metadataId,
      "progress",
    );
    mock.targetApplyFinalResultsByPath["changed.jpg"] = targetDraftResult(
      "changed.jpg",
      metadataId,
      "different final",
    );
    await act(async () => result.current[1].applyDraftEdits("changed.jpg"));
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.metadataVersion).toBe(3);
  });

  it("does not bump metadataVersion for a draft-only target-aware result", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const id = testId("XMP-dc:Subject");
    mock.tagInfos = [tagInfoFor(id)];
    await publishOccurrences(mock, "draft-only.jpg");
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "draft-only.jpg",
        newPropertyTargetFor(id),
        {
          intent: "Set",
          value: { kind: "Text", value: "draft" },
        },
      );
    });
    await act(async () => result.current[1].applyDraftEdits("draft-only.jpg"));
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);
  });

  it("treats a valid empty target-aware load as writable", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(state.targetDraftPersistence).toEqual({ status: "ready" });

    const titleId = testId("XMP-dc:Title");
    mock.tagInfos = [tagInfoFor(titleId)];
    await publishOccurrences(mock, "new.jpg");
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "new.jpg",
        newPropertyTargetFor(titleId),
        {
          intent: "Set",
          value: { kind: "Text", value: "writable" },
        },
      );
    });
    expect(
      state.targetDraftEditsStore.getMetadataFile("new.jpg"),
    ).toBeDefined();
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(1);
  });

  it("enforces the complete direct NewProperty mutation boundary", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "draft" },
    };
    const saveCount = () =>
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits")
        .length;
    const stateStore = () => {
      const state = result.current[0];
      if (state.kind !== "loaded") throw new Error("expected loaded state");
      return state.targetDraftEditsStore;
    };
    const lastErrorType = () => {
      const state = result.current[0];
      if (state.kind !== "loaded") throw new Error("expected loaded state");
      return state.applicationErrors[state.applicationErrors.length - 1]
        ?.error_type;
    };
    const expectRejected = async (
      path: string,
      id: SchemaDefinitionId,
      expectedErrorType: string,
    ) => {
      const before = saveCount();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        await act(async () => {
          await result.current[1].setNewPropertyDraft(
            path,
            newPropertyTargetFor(id),
            edit,
          );
        });
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining(`[application-error:${expectedErrorType}]`),
          expect.objectContaining({ affectedFiles: [path] }),
        );
      } finally {
        consoleError.mockRestore();
      }
      expect(stateStore().getMetadataFile(path)).toBeUndefined();
      expect(saveCount()).toBe(before);
      expect(lastErrorType()).toBe(expectedErrorType);
    };

    const loadingId = testId("XMP-test:Loading");
    mock.tagInfos = [tagInfoFor(loadingId)];
    await expectRejected(
      "loading.jpg",
      loadingId,
      "metadata-target-new-property-occurrences-loading",
    );

    const presentId = testId("XMP-test:Present");
    await publishOccurrences(mock, "present.jpg", [occurrenceFor(presentId)]);
    mock.tagInfos = [tagInfoFor(presentId)];
    await expectRejected(
      "present.jpg",
      presentId,
      "metadata-target-new-property-destination-occupied",
    );

    const selectorCaseId = testId("XMP-test:SelectorCase");
    const selectorCaseOccurrence = occurrenceFor(selectorCaseId);
    selectorCaseOccurrence.observed_selector = {
      ...newPropertyTargetFor(selectorCaseId).write_target,
      group1: "xmp-TEST",
      tag_name: "testfield",
    };
    selectorCaseOccurrence.write_target = null;
    await publishOccurrences(mock, "selector-case.jpg", [
      selectorCaseOccurrence,
    ]);
    mock.tagInfos = [tagInfoFor(selectorCaseId)];
    await expectRejected(
      "selector-case.jpg",
      selectorCaseId,
      "metadata-target-new-property-destination-occupied",
    );

    const crossSchemaId = testId("XMP-test:CrossSchemaNew");
    const otherSchemaId = testId("XMP-test:CrossSchemaExisting");
    const crossSchemaOccurrence = occurrenceFor(otherSchemaId);
    crossSchemaOccurrence.observed_selector = structuredClone(
      newPropertyTargetFor(crossSchemaId).write_target,
    );
    crossSchemaOccurrence.write_target = null;
    await publishOccurrences(mock, "cross-schema.jpg", [crossSchemaOccurrence]);
    mock.tagInfos = [tagInfoFor(crossSchemaId)];
    await expectRejected(
      "cross-schema.jpg",
      crossSchemaId,
      "metadata-target-new-property-destination-occupied",
    );

    const repeatedId = testId("XMP-test:Repeated");
    await publishOccurrences(mock, "repeated.jpg", [
      occurrenceFor(repeatedId, 0),
      occurrenceFor(repeatedId, 1),
    ]);
    mock.tagInfos = [tagInfoFor(repeatedId)];
    await expectRejected(
      "repeated.jpg",
      repeatedId,
      "metadata-target-new-property-destination-occupied",
    );

    const unknownDestinationId = testId("XMP-test:UnknownDestination");
    const unknownDestination = occurrenceFor(unknownDestinationId);
    unknownDestination.observed_selector = null;
    unknownDestination.write_target = null;
    await publishOccurrences(mock, "unknown-destination.jpg", [
      unknownDestination,
    ]);
    mock.tagInfos = [tagInfoFor(unknownDestinationId)];
    await expectRejected(
      "unknown-destination.jpg",
      unknownDestinationId,
      "metadata-target-new-property-destination-unknown",
    );

    const missingId = testId("XMP-test:MissingDefinition");
    await publishOccurrences(mock, "missing.jpg");
    mock.tagInfos = [tagInfoFor(testId("XMP-test:Other"))];
    await expectRejected(
      "missing.jpg",
      missingId,
      "metadata-target-new-property-schema-missing",
    );

    const readOnlyId = testId("XMP-test:ReadOnly");
    await publishOccurrences(mock, "read-only.jpg");
    mock.tagInfos = [tagInfoFor(readOnlyId, { writable: false })];
    await expectRejected(
      "read-only.jpg",
      readOnlyId,
      "metadata-target-new-property-read-only",
    );

    const binaryId = testId("XMP-test:Binary");
    await publishOccurrences(mock, "binary.jpg");
    mock.tagInfos = [tagInfoFor(binaryId, { kind: { kind: "Binary" } })];
    await expectRejected(
      "binary.jpg",
      binaryId,
      "metadata-target-new-property-unsupported-kind",
    );

    const unknownId = testId("XMP-test:Unknown");
    await publishOccurrences(mock, "unknown.jpg");
    mock.tagInfos = [tagInfoFor(unknownId, { kind: { kind: "Unknown" } })];
    await expectRejected(
      "unknown.jpg",
      unknownId,
      "metadata-target-new-property-unsupported-kind",
    );

    const ownedId = testId("XMP-test:Owned");
    await publishOccurrences(mock, "owned.jpg");
    mock.tagInfos = [tagInfoFor(ownedId)];
    const existingTarget = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: {
        document: null,
        path: "JPEG-APP1-XMP",
        runtime_tag_id: ownedId.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: ownedId.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: structuredClone(ownedId),
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "Owned",
      },
    };
    act(() => {
      stateStore().setMetadataTarget("owned.jpg", existingTarget, edit);
    });
    const ownedSaveCount = saveCount();
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "owned.jpg",
        newPropertyTargetFor(ownedId),
        edit,
      );
    });
    expect(saveCount()).toBe(ownedSaveCount + 1);
    expect(
      Object.values(stateStore().getMetadataFile("owned.jpg") ?? {}).map(
        ({ target }) => target,
      ),
    ).toEqual(
      expect.arrayContaining([existingTarget, newPropertyTargetFor(ownedId)]),
    );

    const ambiguousId = testId("XMP-test:AmbiguousOwnership");
    await publishOccurrences(mock, "ambiguous.jpg");
    mock.tagInfos = [tagInfoFor(ambiguousId)];
    act(() => {
      for (const copy of [0, 1]) {
        stateStore().setMetadataTarget(
          "ambiguous.jpg",
          {
            kind: "ExistingOccurrence",
            occurrence_id: {
              document: null,
              path: "JPEG-APP1-XMP",
              runtime_tag_id: ambiguousId.tag_id,
              tag_id_scope: {
                table: ambiguousId.table,
                tag_id: ambiguousId.tag_id,
                index: ambiguousId.index ?? null,
              },
              copy,
            },
            schema_id: structuredClone(ambiguousId),
            write_target: {
              group1: "XMP-test",
              group7: "ID-Test",
              tag_name: `Ambiguous-${copy}`,
            },
          },
          edit,
        );
      }
    });
    const ambiguousSaveCount = saveCount();
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "ambiguous.jpg",
        newPropertyTargetFor(ambiguousId),
        edit,
      );
    });
    expect(saveCount()).toBe(ambiguousSaveCount + 1);
    expect(
      Object.values(stateStore().getMetadataFile("ambiguous.jpg") ?? {}),
    ).toHaveLength(3);

    const collisionId = testId("XMP-test:PendingCollision");
    const collisionTarget = newPropertyTargetFor(collisionId);
    await publishOccurrences(mock, "pending-collision.jpg");
    act(() => {
      stateStore().setMetadataTarget(
        "pending-collision.jpg",
        {
          kind: "ExistingOccurrence",
          occurrence_id: {
            document: null,
            path: "PENDING-OTHER-SCHEMA",
            runtime_tag_id: collisionId.tag_id,
            tag_id_scope: {
              table: "Other::Schema",
              tag_id: "other",
              index: null,
            },
            copy: 0,
          },
          schema_id: testId("Other:Schema"),
          write_target: structuredClone(collisionTarget.write_target),
        },
        edit,
      );
    });
    const collisionSaveCount = saveCount();
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "pending-collision.jpg",
        collisionTarget,
        edit,
      );
    });
    expect(saveCount()).toBe(collisionSaveCount);
    expect(lastErrorType()).toBe(
      "metadata-target-new-property-selector-collision",
    );

    const family7Upper = testId("XMP-test:AbC");
    const family7Lower = testId("XMP-test:abc");
    await publishOccurrences(mock, "family7-case.jpg");
    mock.tagInfos = [tagInfoFor(family7Upper), tagInfoFor(family7Lower)];
    const family7SaveCount = saveCount();
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "family7-case.jpg",
        newPropertyTargetFor(family7Upper),
        edit,
      );
      await result.current[1].setNewPropertyDraft(
        "family7-case.jpg",
        newPropertyTargetFor(family7Lower),
        edit,
      );
    });
    expect(saveCount()).toBe(family7SaveCount + 2);
    expect(
      Object.values(stateStore().getMetadataFile("family7-case.jpg") ?? {}),
    ).toHaveLength(2);

    const supportedId: SchemaDefinitionId = {
      table: "XMP::test",
      tag_id: "supported",
      index: 0,
    };
    const unrelatedUnknown = occurrenceFor(testId("XMP-test:UnrelatedUnknown"));
    unrelatedUnknown.observed_selector = null;
    unrelatedUnknown.write_target = null;
    await publishOccurrences(mock, "supported.jpg", [unrelatedUnknown]);
    mock.tagInfos = [tagInfoFor(supportedId)];
    const supportedSaveCount = saveCount();
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "supported.jpg",
        newPropertyTargetFor(supportedId),
        edit,
      );
    });
    expect(saveCount()).toBe(supportedSaveCount + 1);
    expect(
      Object.values(stateStore().getMetadataFile("supported.jpg") ?? {})[0]
        ?.target,
    ).toEqual(newPropertyTargetFor(supportedId));
  });

  it("atomically moves a New Property draft and preserves its semantic edit", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "move.jpg");

    const id = testId("XMP-test:Move");
    const original = newPropertyTargetFor(id);
    const replacement = {
      ...structuredClone(original),
      write_target: { ...original.write_target, group1: "XMP-moved" },
    };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "preserved" },
    };
    mock.tagInfos = [tagInfoFor(id)];
    await act(async () => {
      await result.current[1].setNewPropertyDraft("move.jpg", original, edit);
    });
    const saveCount = () =>
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits")
        .length;
    const beforeMoveSaves = saveCount();

    let moved = false;
    await act(async () => {
      moved = await result.current[1].replaceNewPropertyDraftTarget(
        "move.jpg",
        original,
        replacement,
        edit,
      );
    });
    expect(moved).toBe(true);
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("expected loaded state");
    const entries = Object.values(
      state.targetDraftEditsStore.getMetadataFile("move.jpg") ?? {},
    );
    expect(entries).toEqual([{ target: replacement, edit }]);
    expect(saveCount()).toBe(beforeMoveSaves + 1);

    const unchangedSaveCount = saveCount();
    await act(async () => {
      moved = await result.current[1].replaceNewPropertyDraftTarget(
        "move.jpg",
        replacement,
        structuredClone(replacement),
        edit,
      );
    });
    expect(moved).toBe(true);
    expect(saveCount()).toBe(unchangedSaveCount);

    const verification = targetVerifyOutcomeFromBackend("move.jpg", {
      target: replacement,
      draft_reconciliation: { kind: "Keep" },
      display_name: "Move",
      kind: "Mismatch",
      sent: edit.value,
      before: null,
      observed: { kind: "Text", value: "readback" },
      message: "pending verification",
    })!;
    act(() =>
      state.targetVerifyOutcomesStore.replaceFile("move.jpg", [verification]),
    );
    await act(async () => {
      moved = await result.current[1].replaceNewPropertyDraftTarget(
        "move.jpg",
        replacement,
        {
          ...structuredClone(replacement),
          write_target: { ...replacement.write_target, group1: "XMP-blocked" },
        },
        edit,
      );
    });
    expect(moved).toBe(false);
    let valueEdited = true;
    await act(async () => {
      valueEdited = await result.current[1].setNewPropertyDraft(
        "move.jpg",
        replacement,
        {
          intent: "Set",
          value: { kind: "Text", value: "blocked value" },
        },
      );
    });
    expect(valueEdited).toBe(false);
    expect(
      Object.values(
        state.targetDraftEditsStore.getMetadataFile("move.jpg") ?? {},
      ),
    ).toEqual([{ target: replacement, edit }]);
  });

  it("logs and rejects an attempted New Property schema change without showing an application error", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "schema-change.jpg");

    const original = newPropertyTargetFor(testId("XMP-test:Original"));
    const replacement = newPropertyTargetFor(testId("XMP-test:Replacement"));
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "preserved" },
    };
    mock.tagInfos = [tagInfoFor(original.schema_id)];
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "schema-change.jpg",
        original,
        edit,
      );
    });
    const saveCount = () =>
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits")
        .length;
    const beforeMoveSaves = saveCount();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    let moved = true;
    await act(async () => {
      moved = await result.current[1].replaceNewPropertyDraftTarget(
        "schema-change.jpg",
        original,
        replacement,
        edit,
      );
    });

    expect(moved).toBe(false);
    expect(saveCount()).toBe(beforeMoveSaves);
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("expected loaded state");
    expect(
      Object.values(
        state.targetDraftEditsStore.getMetadataFile("schema-change.jpg") ?? {},
      ),
    ).toEqual([{ target: original, edit }]);
    expect(
      state.applicationErrors.filter(
        ({ error_type }) =>
          error_type === "metadata-target-new-property-move-schema-changed",
      ),
    ).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "[application-error:metadata-target-new-property-move-schema-changed]",
      ),
      expect.objectContaining({ affectedFiles: ["schema-change.jpg"] }),
    );
    consoleError.mockRestore();
  });

  it("leaves the original New Property draft untouched when a move is stale or collides", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "move-failure.jpg");

    const id = testId("XMP-test:MoveFailure");
    const original = newPropertyTargetFor(id);
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "original" },
    };
    mock.tagInfos = [tagInfoFor(id)];
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "move-failure.jpg",
        original,
        edit,
      );
    });
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("expected loaded state");
    const store = state.targetDraftEditsStore;
    const collisionTarget = {
      ...newPropertyTargetFor(testId("XMP-test:Other")),
      write_target: { ...original.write_target, group1: "XMP-occupied" },
    };
    act(() => {
      store.setMetadataTarget("move-failure.jpg", collisionTarget, edit);
    });
    const replacement = {
      ...structuredClone(original),
      write_target: structuredClone(collisionTarget.write_target),
    };
    let moved = true;
    await act(async () => {
      moved = await result.current[1].replaceNewPropertyDraftTarget(
        "move-failure.jpg",
        original,
        replacement,
        edit,
      );
    });
    expect(moved).toBe(false);
    expect(
      Object.values(store.getMetadataFile("move-failure.jpg") ?? {}),
    ).toEqual(
      expect.arrayContaining([
        { target: original, edit },
        { target: collisionTarget, edit },
      ]),
    );

    await act(async () => {
      moved = await result.current[1].replaceNewPropertyDraftTarget(
        "move-failure.jpg",
        original,
        {
          ...structuredClone(original),
          write_target: { ...original.write_target, group1: "XMP-free" },
        },
        { ...edit, value: { kind: "Text", value: "stale" } },
      );
    });
    expect(moved).toBe(false);
    expect(store.getMetadataFile("move-failure.jpg")).toBeDefined();
  });

  it("abandons a deferred new-property lookup after switching folders", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    const id: SchemaDefinitionId = {
      table: "XMP::test",
      tag_id: "shared",
      index: 0,
    };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "stale" },
    };

    await act(async () => result.current[1].openRecent("/folder-a"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "shared.jpg");
    const deferred = deferNextTagInfoLookup(mock);
    let request!: Promise<boolean>;
    act(() => {
      request = result.current[1].setNewPropertyDraft(
        "shared.jpg",
        newPropertyTargetFor(id),
        edit,
      );
    });

    await act(async () => result.current[1].openRecent("/folder-b"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "shared.jpg");
    await act(async () => {
      deferred.resolve(tagInfoFor(id));
      await request;
    });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(state.folder).toBe("/folder-b");
    expect(
      state.targetDraftEditsStore.getMetadataFile("shared.jpg"),
    ).toBeUndefined();
    expect(state.imageMetadataOccurrences.get("shared.jpg")).toEqual([]);
    expect(state.targetVerifyOutcomes).toEqual({});
    expect(
      state.applicationErrors.filter(({ error_type }) =>
        error_type.includes("new-property"),
      ),
    ).toEqual([]);
    expect(
      mock.invocations
        .filter(({ cmd }) => cmd === "save_metadata_draft_edits")
        .map(({ args }) => args?.folderPath),
    ).toEqual([]);
  });

  it("abandons a deferred new-property lookup after replacing the same folder scan", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    const id: SchemaDefinitionId = {
      table: "XMP::test",
      tag_id: "same-folder",
      index: 1,
    };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "stale" },
    };

    await act(async () => result.current[1].openRecent("/photos"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "shared.jpg");
    const deferred = deferNextTagInfoLookup(mock);
    let request!: Promise<boolean>;
    act(() => {
      request = result.current[1].setNewPropertyDraft(
        "shared.jpg",
        newPropertyTargetFor(id),
        edit,
      );
    });

    await act(async () => result.current[1].openRecent("/photos"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "shared.jpg");
    await act(async () => {
      deferred.resolve(tagInfoFor(id));
      await request;
    });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(state.folder).toBe("/photos");
    expect(
      state.targetDraftEditsStore.getMetadataFile("shared.jpg"),
    ).toBeUndefined();
    expect(state.targetVerifyOutcomes).toEqual({});
    expect(
      state.applicationErrors.filter(({ error_type }) =>
        error_type.includes("new-property"),
      ),
    ).toEqual([]);
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toEqual([]);
  });

  it("keeps closed state untouched when a deferred new-property lookup resolves", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    const id = testId("XMP-test:ClosePending");
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "stale" },
    };

    await act(async () => result.current[1].openRecent("/photos"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "closed.jpg");
    const deferred = deferNextTagInfoLookup(mock);
    let request!: Promise<boolean>;
    act(() => {
      request = result.current[1].setNewPropertyDraft(
        "closed.jpg",
        newPropertyTargetFor(id),
        edit,
      );
      result.current[1].closeFolder();
    });
    await act(async () => {
      deferred.resolve(tagInfoFor(id));
      await request;
    });

    expect(result.current[0].kind).toBe("idle");
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toEqual([]);
    expect(mock.targetDraftEditsByFolder).toEqual({});
  });

  it("does not report a rejected stale lookup in the replacement folder", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    const id = testId("XMP-test:RejectedAfterSwitch");
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "stale" },
    };

    await act(async () => result.current[1].openRecent("/folder-a"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "shared.jpg");
    const deferred = deferNextTagInfoLookup(mock);
    let request!: Promise<boolean>;
    act(() => {
      request = result.current[1].setNewPropertyDraft(
        "shared.jpg",
        newPropertyTargetFor(id),
        edit,
      );
    });

    await act(async () => result.current[1].openRecent("/folder-b"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "shared.jpg");
    await act(async () => {
      deferred.reject(new Error("old folder lookup failed"));
      await request;
    });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(state.folder).toBe("/folder-b");
    expect(
      state.applicationErrors.filter(
        ({ error_type }) =>
          error_type === "metadata-target-new-property-schema-lookup",
      ),
    ).toEqual([]);
    expect(
      state.targetDraftEditsStore.getMetadataFile("shared.jpg"),
    ).toBeUndefined();
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toEqual([]);
  });

  it("stages and autosaves one indexed NewProperty in the current lifecycle", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    const id: SchemaDefinitionId = {
      table: "XMP::test",
      tag_id: "current-indexed",
      index: 2,
    };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "current" },
    };

    await act(async () => result.current[1].openRecent("/photos"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "current.jpg");
    const deferred = deferNextTagInfoLookup(mock);
    let request!: Promise<boolean>;
    act(() => {
      request = result.current[1].setNewPropertyDraft(
        "current.jpg",
        newPropertyTargetFor(id),
        edit,
      );
    });
    await act(async () => {
      deferred.resolve(tagInfoFor(id));
      await request;
    });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(
      Object.values(
        state.targetDraftEditsStore.getMetadataFile("current.jpg") ?? {},
      ),
    ).toEqual([
      {
        target: newPropertyTargetFor(id),
        edit,
      },
    ]);
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(1);
  });

  it("retains same-lifecycle eligibility rechecks after a deferred lookup", async () => {
    const mock = createMockTauriApi();
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: "pending" },
    };
    const saveCount = () =>
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits")
        .length;
    const startDeferredRequest = (path: string, id: SchemaDefinitionId) => {
      const deferred = deferNextTagInfoLookup(mock);
      let request!: Promise<boolean>;
      act(() => {
        request = result.current[1].setNewPropertyDraft(
          path,
          newPropertyTargetFor(id),
          edit,
        );
      });
      return { deferred, request };
    };
    const store = () => {
      const state = result.current[0];
      if (state.kind !== "loaded") throw new Error("expected loaded state");
      return state.targetDraftEditsStore;
    };

    await act(async () => result.current[1].openRecent("/photos"));
    act(() => mock.emitScanComplete());

    const appearedId = testId("XMP-test:AppearedDuringLookup");
    await publishOccurrences(mock, "appeared.jpg");
    const appeared = startDeferredRequest("appeared.jpg", appearedId);
    await publishOccurrences(mock, "appeared.jpg", [occurrenceFor(appearedId)]);
    const appearedSaves = saveCount();
    await act(async () => {
      appeared.deferred.resolve(tagInfoFor(appearedId));
      await appeared.request;
    });
    expect(store().getMetadataFile("appeared.jpg")).toBeUndefined();
    expect(saveCount()).toBe(appearedSaves);

    const ownedId = testId("XMP-test:OwnedDuringLookup");
    await publishOccurrences(mock, "owned-race.jpg");
    const owned = startDeferredRequest("owned-race.jpg", ownedId);
    const ownedTarget = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: {
        document: null,
        path: "JPEG-APP1-XMP",
        runtime_tag_id: ownedId.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: ownedId.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: structuredClone(ownedId),
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "OwnedDuringLookup",
      },
    };
    act(() => {
      store().setMetadataTarget("owned-race.jpg", ownedTarget, edit);
    });
    const ownedSaves = saveCount();
    await act(async () => {
      owned.deferred.resolve(tagInfoFor(ownedId));
      await owned.request;
    });
    expect(saveCount()).toBe(ownedSaves + 1);
    expect(
      Object.values(store().getMetadataFile("owned-race.jpg") ?? {}).map(
        ({ target }) => target,
      ),
    ).toEqual(
      expect.arrayContaining([ownedTarget, newPropertyTargetFor(ownedId)]),
    );

    const ambiguousId = testId("XMP-test:AmbiguousDuringLookup");
    await publishOccurrences(mock, "ambiguous-race.jpg");
    const ambiguous = startDeferredRequest("ambiguous-race.jpg", ambiguousId);
    act(() => {
      for (const copy of [0, 1]) {
        store().setMetadataTarget(
          "ambiguous-race.jpg",
          {
            kind: "ExistingOccurrence",
            occurrence_id: {
              document: null,
              path: "JPEG-APP1-XMP",
              runtime_tag_id: ambiguousId.tag_id,
              tag_id_scope: {
                table: ambiguousId.table,
                tag_id: ambiguousId.tag_id,
                index: ambiguousId.index ?? null,
              },
              copy,
            },
            schema_id: structuredClone(ambiguousId),
            write_target: {
              group1: "XMP-test",
              group7: "ID-Test",
              tag_name: `AmbiguousDuringLookup-${copy}`,
            },
          },
          edit,
        );
      }
    });
    const ambiguousSaves = saveCount();
    await act(async () => {
      ambiguous.deferred.resolve(tagInfoFor(ambiguousId));
      await ambiguous.request;
    });
    expect(saveCount()).toBe(ambiguousSaves + 1);
    expect(
      Object.values(store().getMetadataFile("ambiguous-race.jpg") ?? {}),
    ).toHaveLength(3);

    const unavailableId = testId("XMP-test:UnavailableDuringLookup");
    await publishOccurrences(mock, "unavailable-race.jpg");
    const unavailable = startDeferredRequest(
      "unavailable-race.jpg",
      unavailableId,
    );
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    Object.assign(state.targetDraftPersistence, {
      status: "load-failed",
      error: "persistence became unavailable",
    });
    const unavailableSaves = saveCount();
    await act(async () => {
      unavailable.deferred.resolve(tagInfoFor(unavailableId));
      await unavailable.request;
    });
    expect(store().getMetadataFile("unavailable-race.jpg")).toBeUndefined();
    expect(saveCount()).toBe(unavailableSaves);
    const finalState = result.current[0];
    if (finalState.kind !== "loaded") return;
    expect(
      finalState.applicationErrors[finalState.applicationErrors.length - 1]
        ?.error_type,
    ).toBe("metadata-target-unavailable");
  });

  it("target verification actions use the exact replacement slot and target-aware persistence only", async () => {
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
        runtime_tag_id: id.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: id.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: id,
      write_target: {
        group1: "XMP-dc",
        group7: "ID-Test",
        tag_name: "SubjectPrimary",
      },
    };
    const sibling = {
      ...structuredClone(replacement),
      occurrence_id: { ...replacement.occurrence_id, copy: 1 },
      write_target: {
        group1: "XMP-dc",
        group7: "ID-Test",
        tag_name: "SubjectSibling",
      },
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
      target: {
        kind: "NewProperty",
        schema_id: id,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
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
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(1);

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
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(1);
  });

  it("production target-aware apply installs authoritative replacement verification and surfaces diagnostics once", async () => {
    const mock = createMockTauriApi();
    const path = "add-property.jpg";
    const id = testId("XMP-dc:Subject");
    const original = {
      kind: "NewProperty" as const,
      schema_id: id,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const replacement = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: {
        document: null,
        path: "JPEG-APP1-XMP",
        runtime_tag_id: id.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: id.tag_id,
          index: null,
        },
        copy: 2,
      },
      schema_id: id,
      write_target: {
        group1: "XMP-dc",
        group7: "ID-Test",
        tag_name: "SubjectRuntime",
      },
    };
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(path, original, {
      intent: "Set",
      value: { kind: "Text", value: "requested" },
    });
    mock.targetDraftEditsByFolder["/photos"] = store.getAllMetadata();
    const fileResult: MetadataApplyFileResult = {
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
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      state.applicationErrors.filter(
        ({ error_type, severity }) =>
          error_type === "metadata-target-file" && severity === "error",
      ),
    ).toHaveLength(1);
    expect(
      state.applicationErrors.filter(
        ({ error_type, severity }) =>
          error_type === "metadata-target-warning" && severity === "warning",
      ),
    ).toHaveLength(1);
    expect(
      state.applicationErrors[state.applicationErrors.length - 1]
        ?.affected_files,
    ).toEqual([path]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[application-error:metadata-target-file]"),
      expect.objectContaining({ affectedFiles: [path] }),
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("[application-warning:metadata-target-warning]"),
      expect.objectContaining({ affectedFiles: [path] }),
    );
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("removes selected complete metadata targets without widening to their schema", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const id = testId("Exif::Main:282");
    const ifd0 = occurrenceFor(id, 0);
    ifd0.id.path = "JPEG-APP1-IFD0";
    ifd0.observed_selector = {
      ...ifd0.observed_selector!,
      group1: "IFD0",
    };
    ifd0.write_target = structuredClone(ifd0.observed_selector);
    const ifd1 = occurrenceFor(id, 1);
    ifd1.id.path = "JPEG-APP1-IFD1";
    ifd1.observed_selector = {
      ...ifd1.observed_selector!,
      group1: "IFD1",
    };
    ifd1.write_target = structuredClone(ifd1.observed_selector);
    await publishOccurrences(mock, "shared-schema.jpg", [ifd0, ifd1]);

    const target = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: structuredClone(ifd0.id),
      schema_id: structuredClone(ifd0.schema_id),
      write_target: structuredClone(ifd0.write_target!),
    };
    let removed = false;
    act(() => {
      removed = result.current[1].removeMetadataTargets("shared-schema.jpg", [
        target,
      ]);
    });

    expect(removed).toBe(true);
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("expected loaded state");
    expect(
      Object.values(
        state.targetDraftEditsStore.getMetadataFile("shared-schema.jpg") ?? {},
      ),
    ).toEqual([
      {
        target,
        edit: { intent: "Delete", value: null },
      },
    ]);
  });

  it("blocks target mutation and apply after strict target-load failure", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/broken");
    const api = {
      ...mock.api,
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        cmd === "load_metadata_draft_edits" && args?.folderPath === "/broken"
          ? Promise.reject(new Error("malformed target-aware file"))
          : mock.api.invoke(cmd, args),
    };
    const { result } = renderHook(() => useMediaLibrary(api));
    await expectConsoleErrorMessages(
      [
        "Failed to load target-aware target drafts Error: malformed target-aware file",
      ],
      async () => {
        await act(async () => result.current[1].openFolder());
      },
    );
    await act(async () => mock.emitScanComplete());

    let state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftPersistence).toEqual({
      status: "load-failed",
      error: "malformed target-aware file",
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
        runtime_tag_id: id.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: id.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: id,
      write_target: {
        group1: "XMP-dc",
        group7: "ID-Test",
        tag_name: "Subject",
      },
    };
    let exactRemovalSucceeded = true;
    let groupRemovalSucceeded = true;
    let selectedRemovalSucceeded = true;
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "blocked.jpg",
        newPropertyTargetFor(id),
        edit,
      );
    });
    act(() => {
      result.current[1].setExistingOccurrenceDraft(
        "blocked.jpg",
        existingTarget,
        edit,
      );
      result.current[1].discardTargetPropertyDraft(
        "blocked.jpg",
        existingTarget,
      );
      exactRemovalSucceeded = result.current[1].removeMetadataTargets(
        "blocked.jpg",
        [existingTarget],
      );
      groupRemovalSucceeded = result.current[1].removeMetadataFields(
        "blocked.jpg",
        [id],
      );
      selectedRemovalSucceeded = result.current[1].removeMetadataFieldFromFiles(
        id,
        ["blocked.jpg"],
      );
    });
    expect(exactRemovalSucceeded).toBe(false);
    expect(groupRemovalSucceeded).toBe(false);
    expect(selectedRemovalSucceeded).toBe(false);
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits).toBe(targetSnapshot);
    expect(state.targetDraftEdits).toEqual({});
    const loadFailedTargetDraftStore = state.targetDraftEditsStore;
    const loadFailedTargetVerificationStore = state.targetVerifyOutcomesStore;
    expect(
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
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
      mock.invocations.filter(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toHaveLength(0);

    await act(async () => {
      await expect(
        result.current[1].applyDraftEdits("blocked.jpg"),
      ).rejects.toThrow(/could not be loaded safely/);
    });
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
      ),
    ).toHaveLength(0);

    // Even if a non-UI caller mutates the exposed store directly, the apply
    // boundary still refuses to invoke target-aware for the failed-load folder.
    act(() =>
      state.targetDraftEditsStore.setMetadataTarget(
        "forced.jpg",
        {
          kind: "NewProperty",
          schema_id: id,
          write_target: {
            group1: "XMP-test",
            group7: "ID-Test",
            tag_name: "TestTag",
          },
        },
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
        ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
      ),
    ).toHaveLength(0);
  });
  it("reports strict target-aware load failure, preserves it, then switches safely", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const api = {
      ...mock.api,
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        cmd === "load_metadata_draft_edits" && args?.folderPath === "/photos"
          ? Promise.reject(new Error("invalid schema version"))
          : mock.api.invoke(cmd, args),
    };
    const { result } = renderHook(() => useMediaLibrary(api));
    await expectConsoleErrorMessages(
      [
        "Failed to load target-aware target drafts Error: invalid schema version",
      ],
      async () => {
        await act(async () => result.current[1].openFolder());
      },
    );
    await act(async () => mock.emitScanComplete());
    const state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits).toEqual({});
    expect(state.targetDraftPersistence).toEqual({
      status: "load-failed",
      error: "invalid schema version",
    });
    expect(state.applicationErrors[0].error_type).toBe("metadata-target-load");
    expect(
      mock.invocations.some(({ cmd }) => cmd === "save_metadata_draft_edits"),
    ).toBe(false);

    await act(async () => result.current[1].openRecent("/second"));
    await act(async () => mock.emitScanComplete());
    const secondState = result.current[0];
    if (secondState.kind !== "loaded") return;
    expect(secondState.folder).toBe("/second");
    expect(secondState.targetDraftPersistence).toEqual({ status: "ready" });
    const newFolderId = testId("XMP-dc:Title");
    mock.tagInfos = [tagInfoFor(newFolderId)];
    await publishOccurrences(mock, "new.jpg");
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "new.jpg",
        newPropertyTargetFor(newFolderId),
        {
          intent: "Set",
          value: { kind: "Text", value: "new folder" },
        },
      );
    });
    expect(
      mock.invocations.find(({ cmd }) => cmd === "save_metadata_draft_edits")
        ?.args?.folderPath,
    ).toBe("/second");
    expect(
      mock.invocations.some(
        ({ cmd, args }) =>
          cmd === "save_metadata_draft_edits" && args?.folderPath === "/photos",
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
    mock.tagInfos = [tagInfoFor(id)];
    await publishOccurrences(mock, "a.jpg");
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "a.jpg",
        newPropertyTargetFor(id),
        edit,
      );
    });
    await act(async () => result.current[1].applyDraftEdits("a.jpg"));
    await act(async () => result.current[1].openRecent("/second"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "b.jpg");
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "b.jpg",
        newPropertyTargetFor(id),
        edit,
      );
    });
    const saveFolders = mock.invocations
      .filter(({ cmd }) => cmd === "save_metadata_draft_edits")
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
