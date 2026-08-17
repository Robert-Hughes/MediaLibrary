import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi, type MockTauriApi } from "./mockTauriApi";
import {
  makeFile,
  mockTargetDraftsByFile,
  newPropertyTargetDraft,
  testId,
} from "./factories";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataApplyFileResult,
  MetadataOccurrence,
  MetadataRemovalPreview,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import {
  family7GroupFromRuntimeTagId,
  family7GroupFromSchemaId,
} from "../utils/metadataWriteTarget";
import { sortFiles } from "../utils/sorting";
import { _setWritableSchemaDefinitionsCache } from "../hooks/useWritableSchemaDefinitions";

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

async function settleAutosaves(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
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
    fresh_file_metadata:
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
    group0: "XMP",
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
  if (!mock.foundPaths.has(relativePath)) {
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: relativePath }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
  }
  act(() => {
    mock.emitFileMetadataReady(relativePath, {}, undefined, occurrences);
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

describe("useMediaLibrary", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    _setWritableSchemaDefinitionsCache([]);
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

  it("recovers the complete Rust-authoritative session projection on mount", async () => {
    vi.useRealTimers();
    const mock = createMockTauriApi();
    const draft = newPropertyTargetDraft("RecoveredField", "pending");
    const occurrence = occurrenceFor(testId("RecoveredMetadata"));
    mock.setSessionSnapshot({
      session_id: 42,
      revision: 7,
      lifecycle: "loaded",
      folder: "/recovered",
      files: [makeFile({ relative_path: "recovered.jpg" })],
      discovery_running: true,
      issues: [
        {
          issue_id: 8,
          severity: "warning",
          error_type: "recovered_issue",
          error_message: "Recovered issue",
          affected_files: ["recovered.jpg"],
        },
      ],
      metadata: [
        {
          relative_path: "recovered.jpg",
          state: { status: "ready", occurrences: [occurrence] },
        },
      ],
      thumbnails: [
        {
          relative_path: "recovered.jpg",
          state: { status: "ready", cache_key: "recovered-thumb" },
        },
      ],
      drafts: { "recovered.jpg": [draft] },
      draft_persistence: { status: "ready" },
      apply_operation: {
        operation_id: "apply-1",
        requested_paths: ["recovered.jpg"],
        state: { status: "running" },
        total: 1,
        current: 0,
        current_file: "recovered.jpg",
        cancelling: false,
        file_failure_count: 0,
        warning_count: 0,
        issues: [],
        summary: null,
      },
      verification_outcomes: {
        "recovered.jpg": [
          {
            target: draft.target,
            draft_reconciliation: { kind: "Keep" },
            display_name: "RecoveredField",
            kind: "Mismatch",
            sent: draft.edit.value,
            before: null,
            observed: { kind: "Text", value: "observed" },
            message: "Recovered verification outcome",
          },
        ],
      },
      batch_operations: {
        describe: {
          operation_id: "describe-1",
          kind: "describe",
          requested_paths: ["recovered.jpg"],
          request: ["recovered.jpg"],
          phase: "running",
          total: 1,
          current: 0,
          current_file: "recovered.jpg",
          cancelling: false,
          failures: [],
          succeeded: [],
          estimate: null,
          summary: null,
          error: null,
        },
      },
    });
    mock.setThumbnailPayload("recovered-thumb", "recovered-thumbnail-data");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

    const recovered = result.current[0];
    if (recovered.kind !== "loaded") throw new Error("Expected loaded state");
    expect(recovered).toMatchObject({
      folder: "/recovered",
      files: [expect.objectContaining({ relative_path: "recovered.jpg" })],
      scanning: true,
      applying: {
        total: 1,
        current: 0,
        currentFile: "recovered.jpg",
      },
      applicationErrors: [
        expect.objectContaining({ error_type: "recovered_issue" }),
      ],
      batchOperations: {
        describe: expect.objectContaining({
          operation_id: "describe-1",
          phase: "running",
        }),
      },
    });
    expect(recovered.thumbnails.get("recovered.jpg")).toBe(
      "recovered-thumbnail-data",
    );
    expect(recovered.fileMetadataOccurrences.get("recovered.jpg")).toEqual([
      occurrence,
    ]);
    expect(
      recovered.targetDraftEdits["recovered.jpg"][
        metadataDraftTargetSlotToken(draft.target)
      ],
    ).toEqual(draft);
    expect(
      Object.values(recovered.targetVerifyOutcomes["recovered.jpg"]),
    ).toEqual([
      expect.objectContaining({
        displayName: "RecoveredField",
        message: "Recovered verification outcome",
      }),
    ]);
    expect(
      mock.invocations.some(
        ({ cmd }) => cmd === "get_media_library_thumbnails",
      ),
    ).toBe(true);
    consoleError.mockRestore();
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
    mock.pickFolderResolves("/files/new");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    expect(result.current[0].recentFolders).toEqual(["/files/new"]);
  });

  it("transitions to loaded on first file_found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
  });

  it("appends files as file_found events arrive (batched)", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    await act(async () => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
      mock.emitFileFound(makeFile({ relative_path: "b.jpg" }));
      mock.emitFileFound(makeFile({ relative_path: "c.jpg" }));
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.files).toHaveLength(3);
  });

  it("fileMetadataRemaining decrements when file_metadata_ready fires", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "b.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitFileMetadataReady("a.jpg", {});
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.metadataProgress.getRemaining()).toBe(1);
    }
  });

  it("recycles successful files, retains failures, discards drafts, and ignores late work", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    mock.targetDraftEditsByFolder["/files"] = mockTargetDraftsByFile({
      "a.jpg": [newPropertyTargetDraft("Title", "draft a")],
      "b.mov": [newPropertyTargetDraft("Title", "draft b")],
    });
    mock.recycleFailuresByPath["b.mov"] = "The file is locked";
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
      mock.emitFileFound(
        makeFile({
          relative_path: "b.mov",
          filename: "b.mov",
          media_kind: "video",
        }),
      );
      mock.emitFileFound(makeFile({ relative_path: "c.png" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      mock.emitFileMetadataReady("b.mov", {});
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => {
      result.current[1].selectFile("a.jpg");
    });

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let logMessages: string[];
    let warnMessages: string[];
    try {
      await act(async () => {
        await result.current[1].recycleFiles(["a.jpg", "b.mov"]);
      });
      logMessages = consoleLog.mock.calls.map((args) =>
        args.map((value) => String(value)).join(" "),
      );
      warnMessages = consoleWarn.mock.calls.map((args) =>
        args.map((value) => String(value)).join(" "),
      );
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
      consoleWarn.mockRestore();
    }

    const state = result.current[0];
    expect(logMessages).toEqual([
      "[recycleFiles] requesting 2 file(s)",
      "[recycleFiles] removed 1 file(s) from UI state: a.jpg",
    ]);
    expect(warnMessages).toEqual([
      "[recycleFiles] 1 file(s) failed to recycle: b.mov: The file is locked",
    ]);
    expect(mock.lastRecycleArgs).toEqual({
      folder: "/files",
      relativePaths: ["a.jpg", "b.mov"],
    });
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    expect(state.files.map((file) => file.relative_path)).toEqual([
      "b.mov",
      "c.png",
    ]);
    expect(state.targetDraftEdits["a.jpg"]).toBeUndefined();
    expect(state.targetDraftEdits["b.mov"]).toBeDefined();
    expect(state.selectedPath).toBeNull();
    expect(mock.targetDraftEditsByFolder["/files"]["a.jpg"]).toBeUndefined();
    expect(mock.targetDraftEditsByFolder["/files"]["b.mov"]).toBeDefined();
    expect(state.metadataProgress.getTotal()).toBe(2);
    expect(state.metadataProgress.getRemaining()).toBe(1);
    expect(
      state.applicationErrors[state.applicationErrors.length - 1],
    ).toMatchObject({
      error_type: "recycle-files",
      affected_files: ["b.mov"],
    });

    act(() => {
      mock.emitFileMetadataReady("a.jpg", {});
      mock.emitThumbnailReady("a.jpg", "late-thumbnail");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(
      Array.from(state.fileMetadataOccurrences.entries()).some(
        ([path]) => path === "a.jpg",
      ),
    ).toBe(false);
    const thumbnailData = (
      state.thumbnails as unknown as { data: Map<string, unknown> }
    ).data;
    expect(thumbnailData.has("a.jpg")).toBe(false);
  });

  it("stores canonical metadata from file_metadata_ready", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      mock.emitFileMetadataReady("a.jpg", {
        "IFD0:Orientation": { kind: "Integer", value: 6 },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      const metadata = state.fileMetadataOccurrences.get("a.jpg");
      expect(metadata).not.toBe("loading");
      if (Array.isArray(metadata)) {
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

  it("selectFile stores the selected relative path", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      result.current[1].selectFile("a.jpg");
    });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.selectedPath).toBe("a.jpg");
    act(() => result.current[1].closeFolder());
  });

  it("openGallery stores and selects the relative path", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      result.current[1].openGallery("a.jpg");
    });
    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.galleryPath).toBe("a.jpg");
      expect(state.selectedPath).toBe("a.jpg");
    }
    act(() => result.current[1].closeFolder());
  });
  it("showInExplorer passes folder and relativePath separately to the backend and is called once", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("C:/MyFiles");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "nature/sunset.jpg" }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current[1].showInExplorer(0);
    });
    const explorerCalls = mock.invocations.filter(
      (c) => c.cmd === "show_in_explorer",
    );
    expect(explorerCalls).toHaveLength(1);
    expect(explorerCalls[0].args).toEqual({
      folder: "C:/MyFiles",
      relativePath: "nature/sunset.jpg",
    });
  });
  it("surfaces show-in-file-manager failures as application issues", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    mock.showInExplorerError = "Finder could not reveal the file";
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "nature/sunset.jpg" }));
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        await Promise.resolve();
        await result.current[1].showInExplorer(0);
        await Promise.resolve();
      });
    } finally {
      consoleError.mockRestore();
    }

    const issueCall = mock.invocations.find(
      (call) =>
        call.cmd === "record_media_library_session_issue" &&
        call.args?.errorType === "show-in-file-manager",
    );
    expect(issueCall?.args).toMatchObject({
      severity: "error",
      errorType: "show-in-file-manager",
      affectedFiles: ["nature/sunset.jpg"],
    });
    expect(String(issueCall?.args?.errorMessage)).toContain(
      "Finder could not reveal the file",
    );
  });

  it("projects an authoritative failed scan session", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    expect(result.current[0]).toMatchObject({ kind: "loaded", scanning: true });

    await expectConsoleErrorMessages(
      ["Worker error (scan): not a directory"],
      () => {
        act(() => {
          mock.emitScanError("not a directory");
        });
      },
    );
    expect(result.current[0]).toMatchObject({
      kind: "loaded",
      scanning: false,
      applicationErrors: [
        expect.objectContaining({
          error_type: "scan",
          error_message: "not a directory",
        }),
      ],
    });
  });

  it("retains discovered files when Rust marks the scan failed", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current[0].kind).toBe("loaded");

    await expectConsoleErrorMessages(
      ["Worker error (scan): disk read failed"],
      () => {
        act(() => {
          mock.emitScanError("disk read failed");
        });
      },
    );
    expect(result.current[0]).toMatchObject({
      kind: "loaded",
      scanning: false,
      files: [expect.objectContaining({ relative_path: "a.jpg" })],
    });
  });

  it("scan_error with a stale scan_id does not reset an in-progress scan", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));

    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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

  it("file_found events with a stale scan_id are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    const currentScanId = mock.currentScanId;

    // Emit a file_found with a different (stale) scan_id
    act(() => {
      mock.emitFileFound(
        makeFile({ relative_path: "stale.jpg" }),
        currentScanId - 1,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // Stale file should not have been added; the active Rust session remains loaded.
    expect(result.current[0]).toMatchObject({ kind: "loaded", files: [] });
    // A current-scan file should be accepted
    act(() => {
      mock.emitFileFound(
        makeFile({ relative_path: "fresh.jpg" }),
        currentScanId,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.files).toHaveLength(1);
      expect(state.files[0].relative_path).toBe("fresh.jpg");
    }
  });

  it("file_metadata_ready and thumbnail_ready with a stale scan_id are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const stale = mock.currentScanId - 1;
    act(() => {
      mock.emitFileMetadataReady(
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
      expect(state.fileMetadataOccurrences.get("a.jpg")).toBe("loading");
      expect(state.thumbnails.get("a.jpg")).toBe("loading");
      expect(state.metadataProgress.getRemaining()).toBe(1);
    }
  });

  it("worker issues from a stale session are rejected", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
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
      expect(state.applicationErrors).toHaveLength(0);
    }
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("file_found events after closeFolder are ignored", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    act(() => {
      result.current[1].closeFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "b.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current[0].kind).toBe("idle");
  });

  it("scan_complete with zero files marks discovery complete", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/empty");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    expect(result.current[0]).toMatchObject({ kind: "loaded", scanning: true });

    act(() => {
      mock.emitScanComplete();
    });

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.files).toEqual([]);
      expect(state.scanning).toBe(false);
      expect(state.folder).toBe("/empty");
    }
  });
  it("scan_complete after files arrive sets scanning to false", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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
    // and sortConfig is preserved.  App.tsx skips sortFiles while scanning
    // is true and runs it once when scanning becomes false — the test in
    // column-sorting verifies the FileList side of that contract.
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "b.jpg" }));
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // No primary sort: metadataVersion stays at 0 when metadata arrives
    let state = result.current[0];
    if (state.kind === "loaded") expect(state.metadataVersion).toBe(0);
    act(() => {
      mock.emitFileMetadataReady("a.jpg", {
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
      mock.emitFileFound(makeFile({ relative_path: "b.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      mock.emitFileMetadataReady("b.jpg", {
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
      mock.emitFileFound(makeFile({ relative_path: "c.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      mock.emitFileMetadataReady("c.jpg", {
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
    // Buffer files that are sitting in fileBufferRef waiting for the 100ms
    // batch flush.  closeFolder should drop them so a stale flush doesn't
    // try to apply them after the user has left the folder.
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });

    // Get past the loading→loaded transition so we're in a state with timers.
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // Queue more files that are sitting in the buffer behind the timer.
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "b.jpg" }));
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "c.jpg" }));
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

  it("closeFolder invokes the Rust session close command", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    mock.invocations.length = 0;

    act(() => {
      result.current[1].closeFolder();
    });

    const closeCalls = mock.invocations.filter(
      (c) => c.cmd === "close_media_library_session",
    );
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]?.args).toEqual({ sessionId: 1 });
  });

  it("starting a new scan stops the old one and discards old events", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "old1.jpg" }));
    });
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "old2.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const oldScanId = mock.currentScanId;

    // Start a new scan via openRecent — clears file list and gets a new scan_id
    mock.invocations.length = 0;
    await act(async () => {
      await result.current[1].openRecent("/files/second");
    });
    expect(mock.currentScanId).not.toBe(oldScanId);

    // Rust opens a new authoritative session before its scan starts.
    const cmds = mock.invocations.map((c) => c.cmd);
    const openIdx = cmds.indexOf("open_media_library_session");
    const startIdx = cmds.indexOf("start_scan");
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(openIdx);

    // Late events from the previous scan must be ignored
    act(() => {
      mock.emitFileFound(
        makeFile({ relative_path: "leftover.jpg" }),
        oldScanId,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // New scan: emit a file to confirm it lands
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "new1.jpg" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.folder).toBe("/files/second");
      expect(state.files.map((p) => p.relative_path)).toEqual(["new1.jpg"]);
    }
  });

  it("retains colliding occurrences while the schema-keyed projection stays blank and progress increments once", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitFileFound(makeFile({ relative_path: "a.jpg" })));
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
      mock.emitFileMetadataReady("a.jpg", {}, undefined, [
        occurrence,
        secondOccurrence,
      ]);
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));

    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") {
      expect(state.fileMetadataOccurrences.get("a.jpg")).toEqual([
        occurrence,
        secondOccurrence,
      ]);
      const loaded = state.fileMetadataOccurrences.get("a.jpg");
      expect(loaded).not.toBe("loading");
      if (Array.isArray(loaded)) {
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

  it("metadata worker failures retain an explicit failed state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitFileFound(makeFile({ relative_path: "failed.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    act(() =>
      mock.emitWorkerError("metadata", "ExifTool could not read the file", [
        "failed.jpg",
      ]),
    );

    const state = result.current[0];
    if (state.kind === "loaded") {
      expect(state.fileMetadataOccurrences.get("failed.jpg")).toBe("failed");
      expect(state.fileMetadataOccurrences.getFailure("failed.jpg")).toBe(
        "ExifTool could not read the file",
      );
      expect(state.metadataProgress.getRemaining()).toBe(0);
      act(() => {
        expect(
          result.current[1].canOpenBulkMetadataEditor(["failed.jpg"]),
        ).toBe(false);
        expect(
          result.current[1].canStageGeneratedMetadata(["failed.jpg"]),
        ).toBe(false);
      });
      expect(result.current[0].kind).toBe("loaded");
      if (result.current[0].kind === "loaded") {
        expect(
          result.current[0].applicationErrors.some((error) =>
            error.error_message.includes(
              "Metadata could not be loaded for 'failed.jpg'",
            ),
          ),
        ).toBe(true);
      }
    }
  });

  it("stale metadata does not update occurrences and a replacement scan clears them", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/first");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitFileFound(makeFile({ relative_path: "a.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const oldScanId = mock.currentScanId;
    const firstState = result.current[0];
    expect(firstState.kind).toBe("loaded");
    if (firstState.kind !== "loaded") return;
    const oldStore = firstState.fileMetadataOccurrences;

    act(() =>
      mock.emitFileMetadataReady(
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
    expect(firstState.fileMetadataOccurrences.get("a.jpg")).toBe("loading");

    await act(async () => result.current[1].openRecent("/second"));
    act(() => mock.emitFileFound(makeFile({ relative_path: "b.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const replacement = result.current[0];
    if (replacement.kind === "loaded") {
      expect(replacement.fileMetadataOccurrences).toBe(oldStore);
      expect([...replacement.fileMetadataOccurrences.entries()]).toEqual([
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
    mock.targetDraftEditsByFolder["/files"] = store.getAllMetadata();
    mock.pickFolderResolves("/files");
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => {
      mock.emitFileFound(makeFile({ relative_path: "a.jpg" }));
      mock.emitFileFound(makeFile({ relative_path: "b.jpg" }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    act(() => {
      mock.emitFileMetadataReady("a.jpg", {
        "XMP-dc:Title": { kind: "Text", value: "Zulu" },
      });
      mock.emitFileMetadataReady("b.jpg", {
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
      sortFiles(
        state.files,
        state.sortConfig,
        state.fileMetadataOccurrences,
      ).map((file) => file.relative_path),
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
      sortFiles(
        state.files,
        state.sortConfig,
        state.fileMetadataOccurrences,
      ).map((file) => file.relative_path),
    ).toEqual(["a.jpg", "b.jpg"]);
  });

  it("keeps authoritative post-write metadata when an older scan result flushes later", async () => {
    const mock = createMockTauriApi();
    const draftId = testId("XMP-dc:Subject");
    const metadataId = testId("XMP-dc:Title");
    const persistedDrafts = new TargetDraftEditsStore();
    persistedDrafts.setMetadataTarget("a.jpg", newPropertyTargetFor(draftId), {
      intent: "Set",
      value: { kind: "Text", value: "draft" },
    });
    mock.targetDraftEditsByFolder["/files"] = persistedDrafts.getAllMetadata();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitFileFound(makeFile({ relative_path: "a.jpg" })));
    await act(async () => vi.advanceTimersByTimeAsync(150));

    act(() => {
      mock.emitFileMetadataReady("a.jpg", {
        "XMP-dc:Title": { kind: "Text", value: "stale scan value" },
      });
    });
    mock.targetApplyFinalResultsByPath["a.jpg"] = targetDraftResult(
      "a.jpg",
      metadataId,
      "fresh post-write value",
    );
    await act(async () => result.current[1].applyDraftEdits("a.jpg"));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    const state = result.current[0];
    if (state.kind !== "loaded") return;
    const occurrences = state.fileMetadataOccurrences.get("a.jpg");
    expect(occurrences).not.toBe("loading");
    if (!Array.isArray(occurrences)) return;
    expect(occurrences[0]?.value).toEqual({
      kind: "Text",
      value: "fresh post-write value",
    });
  });

  it("installs authoritative metadata for terminal fallback results", async () => {
    const mock = createMockTauriApi();
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
    const finalOccurrences = state.fileMetadataOccurrences.get("final.jpg");
    expect(
      Array.isArray(finalOccurrences) && finalOccurrences[0]?.value,
    ).toEqual({
      kind: "Text",
      value: "final only",
    });

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
    const changedOccurrences = state.fileMetadataOccurrences.get("changed.jpg");
    expect(
      Array.isArray(changedOccurrences) && changedOccurrences[0]?.value,
    ).toEqual({
      kind: "Text",
      value: "different final",
    });
  });

  it("does not bump metadataVersion for a draft-only target-aware result", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
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
    const beforeApply = result.current[0];
    const versionBeforeApply =
      beforeApply.kind === "loaded" ? beforeApply.metadataVersion : 0;
    await act(async () => result.current[1].applyDraftEdits("draft-only.jpg"));
    const state = result.current[0];
    if (state.kind === "loaded")
      expect(state.metadataVersion).toBe(versionBeforeApply);
  });

  it("treats a valid empty target-aware load as writable", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
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
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(1);
  });

  it("projects draft persistence changes from the delta event", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    act(() => {
      mock.emitDraftPersistenceChanged({
        status: "save-failed",
        error: "disk full",
      });
    });

    const state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftPersistence).toEqual({
      status: "save-failed",
      error: "disk full",
    });
  });

  it("atomically moves a New Property draft and preserves its semantic edit", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
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
      mock.invocations.filter(
        ({ cmd }) => cmd === "replace_media_library_session_new_property_draft",
      ).length;
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
    await settleAutosaves();
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
    expect(saveCount()).toBe(unchangedSaveCount + 1);

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    act(() =>
      mock.emitVerificationOutcomes({
        "move.jpg": [
          {
            target: replacement,
            draft_reconciliation: { kind: "Keep" },
            display_name: "Move",
            kind: "Mismatch",
            sent: edit.value,
            before: null,
            observed: { kind: "Text", value: "readback" },
            message: "pending verification",
          },
        ],
      }),
    );
    await act(async () => {
      moved = await result.current[1].replaceNewPropertyDraftTarget(
        "move.jpg",
        replacement,
        {
          ...structuredClone(replacement),
          write_target: {
            ...replacement.write_target,
            group1: "XMP-blocked",
          },
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
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "[application-error:metadata-target-new-property-move-failed]",
      ),
      expect.objectContaining({ affectedFiles: ["move.jpg"] }),
    );
    consoleError.mockRestore();
  });

  it("surfaces a Rust rejection for an attempted New Property schema change", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
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
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ).length;
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
          error_type === "metadata-target-new-property-move-failed",
      ),
    ).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "[application-error:metadata-target-new-property-move-failed]",
      ),
      expect.objectContaining({ affectedFiles: ["schema-change.jpg"] }),
    );
    consoleError.mockRestore();
  });

  it("leaves New Property drafts untouched when Rust rejects a collision or stale edit", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
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
      ...structuredClone(original),
      write_target: { ...original.write_target, group1: "XMP-occupied" },
    };
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "move-failure.jpg",
        collisionTarget,
        edit,
      );
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
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
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

    await act(async () => result.current[1].openRecent("/files"));
    act(() => mock.emitScanComplete());
    await publishOccurrences(mock, "current.jpg");
    mock.tagInfos = [tagInfoFor(id)];
    await act(async () => {
      await result.current[1].setNewPropertyDraft(
        "current.jpg",
        newPropertyTargetFor(id),
        edit,
      );
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
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(1);
  });

  it("target verification actions use the exact replacement slot and target-aware persistence only", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const state = result.current[0];
    if (state.kind !== "loaded") return;

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
    await act(async () => {
      await mock.api.invoke("mutate_media_library_session_draft_rows", {
        sessionId: mock.currentScanId,
        mutations: [
          {
            relative_path: "replace.jpg",
            entries: [
              { target: replacement, edit },
              { target: sibling, edit },
            ],
          },
        ],
      });
    });
    const emitReplacementVerification = () =>
      mock.emitVerificationOutcomes({
        "replace.jpg": [
          {
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
          },
        ],
      });
    act(emitReplacementVerification);
    await settleAutosaves();
    mock.invocations.length = 0;

    act(() =>
      result.current[1].acceptTargetVerifyOutcome("replace.jpg", replacement),
    );
    await settleAutosaves();
    const current = result.current[0];
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
    expect(
      mock.invocations.filter(
        ({ cmd }) =>
          cmd === "resolve_media_library_session_verification_outcome",
      ),
    ).toHaveLength(1);
    await settleAutosaves();

    await act(async () => {
      await mock.api.invoke("mutate_media_library_session_draft_rows", {
        sessionId: mock.currentScanId,
        mutations: [
          {
            relative_path: "replace.jpg",
            entries: [
              { target: replacement, edit },
              { target: sibling, edit },
            ],
          },
        ],
      });
      emitReplacementVerification();
    });
    mock.invocations.length = 0;
    await act(async () => {
      result.current[1].keepTargetDraftAndDismissOutcome(
        "replace.jpg",
        replacement,
      );
      await settleAutosaves();
    });
    if (current.kind !== "loaded") return;
    expect(
      current.targetDraftEdits["replace.jpg"]?.[
        metadataDraftTargetSlotToken(replacement)
      ],
    ).toBeUndefined();
    expect(current.targetVerifyOutcomes["replace.jpg"]).toBeUndefined();
    expect(mock.invocations).toHaveLength(1);

    act(emitReplacementVerification);
    act(() =>
      result.current[1].discardTargetDraftAndOutcome(
        "replace.jpg",
        replacement,
      ),
    );
    await settleAutosaves();
    expect(
      mock.invocations.filter(
        ({ cmd }) =>
          cmd === "resolve_media_library_session_verification_outcome",
      ),
    ).toHaveLength(2);
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
    mock.targetDraftEditsByFolder["/files"] = store.getAllMetadata();
    const fileResult: MetadataApplyFileResult = {
      relative_path: path,
      applied: false,
      error: "semantic write failure",
      warning: "file metadata was partially refreshed",
      fresh_file_metadata: null,
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
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => result.current[1].applyDraftEdits(path));

    const applyInvocation = mock.invocations.find(
      ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
    );
    expect(applyInvocation?.args).toEqual({
      sessionId: 1,
      relPaths: [path],
    });

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
          error_type === "metadata-apply-file" && severity === "error",
      ),
    ).toHaveLength(1);
    expect(
      state.applicationErrors.filter(
        ({ error_type, severity }) =>
          error_type === "metadata-apply-warning" && severity === "warning",
      ),
    ).toHaveLength(1);
    expect(
      state.applicationErrors[state.applicationErrors.length - 1]
        ?.affected_files,
    ).toEqual([path]);
    expect(consoleError).toHaveBeenCalledWith(
      "Worker error (metadata-apply-file):",
      "semantic write failure",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Worker error (metadata-apply-warning):",
      "file metadata was partially refreshed",
    );
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("removes selected complete metadata targets without widening to their schema", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
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
    let preview: MetadataRemovalPreview | null = null;
    await act(async () => {
      preview = await result.current[1].previewMetadataTargetRemovals(
        "shared-schema.jpg",
        [target],
      );
    });
    expect(preview).toEqual({
      existingFieldsToDelete: 1,
      stagedCreationsToCancel: 0,
      noOpTargets: 0,
      affectedCount: 1,
    });
    let removed = false;
    await act(async () => {
      removed = await result.current[1].removeMetadataTargets(
        "shared-schema.jpg",
        [target],
      );
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
    expect(
      mock.invocations.filter(
        ({ cmd }) =>
          cmd === "preview_media_library_session_metadata_target_removals",
      ),
    ).toHaveLength(1);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "remove_media_library_session_metadata_targets",
      ),
    ).toHaveLength(1);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(0);
  });

  it("removes one exact schema from selected files through the Rust batch command", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const id = testId("XMP-dc:Subject");
    await publishOccurrences(mock, "a.jpg", [occurrenceFor(id, 0)]);
    await publishOccurrences(mock, "b.jpg", [occurrenceFor(id, 1)]);

    let removed = false;
    await act(async () => {
      removed = await result.current[1].removeMetadataFieldFromFiles(id, [
        "a.jpg",
        "b.jpg",
        "a.jpg",
      ]);
    });
    expect(removed).toBe(true);
    expect(
      mock.invocations.filter(
        ({ cmd }) =>
          cmd === "remove_media_library_session_metadata_field_from_files",
      ),
    ).toHaveLength(1);
    const invocation = mock.invocations.find(
      ({ cmd }) =>
        cmd === "remove_media_library_session_metadata_field_from_files",
    );
    expect(invocation?.args?.relativePaths).toEqual(["a.jpg", "b.jpg"]);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(0);

    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("expected loaded state");
    for (const path of ["a.jpg", "b.jpg"]) {
      const entries = Object.values(
        state.targetDraftEditsStore.getMetadataFile(path) ?? {},
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].edit).toEqual({ intent: "Delete", value: null });
    }
  });

  it("routes bulk Delete through the Rust bulk staging command", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const id = testId("XMP-dc:Subject");
    await publishOccurrences(mock, "a.jpg", [occurrenceFor(id, 0)]);
    await publishOccurrences(mock, "b.jpg", [occurrenceFor(id, 1)]);

    let staged = false;
    await act(async () => {
      staged = await result.current[1].stageBulkMetadataDraftBatch(
        ["a.jpg", "b.jpg", "a.jpg"],
        { operation: "Delete", schemaId: id },
      );
    });
    expect(staged).toBe(true);
    const invocation = mock.invocations.find(
      ({ cmd }) => cmd === "stage_media_library_session_bulk_drafts",
    );
    expect(invocation?.args?.relativePaths).toEqual(["a.jpg", "b.jpg"]);
    expect(invocation?.args?.request).toEqual({
      operation: "Delete",
      schemaId: id,
    });
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(0);
  });

  it("removes multiple exact schemas from one file through the Rust group command", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const firstId = testId("XMP-dc:Subject");
    const secondId = testId("XMP-dc:Title");
    const unrelatedId = testId("XMP-dc:Description");
    await publishOccurrences(mock, "group.jpg", [
      occurrenceFor(firstId, 0),
      occurrenceFor(secondId, 0),
      occurrenceFor(unrelatedId, 0),
    ]);

    let removed = false;
    await act(async () => {
      removed = await result.current[1].removeMetadataFields("group.jpg", [
        firstId,
        secondId,
      ]);
    });
    expect(removed).toBe(true);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "remove_media_library_session_metadata_fields",
      ),
    ).toHaveLength(1);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(0);

    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("expected loaded state");
    const entries = Object.values(
      state.targetDraftEditsStore.getMetadataFile("group.jpg") ?? {},
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.target.schema_id)).toEqual(
      expect.arrayContaining([firstId, secondId]),
    );
    expect(entries.every((entry) => entry.edit.intent === "Delete")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          JSON.stringify(entry.target.schema_id) ===
          JSON.stringify(unrelatedId),
      ),
    ).toBe(false);
  });

  it("stages captured GPS targets through the Rust command", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
    act(() => mock.emitScanComplete());

    const id = { table: "GPS::Main", tag_id: "2" };
    const occurrence = occurrenceFor(id, 0);
    await publishOccurrences(mock, "gps.jpg", [occurrence]);
    const entry = {
      target: {
        kind: "ExistingOccurrence" as const,
        occurrence_id: structuredClone(occurrence.id),
        schema_id: structuredClone(occurrence.schema_id),
        write_target: structuredClone(occurrence.write_target!),
      },
      edit: {
        intent: "Set" as const,
        value: { kind: "Real" as const, value: -0 },
      },
    };

    let staged = false;
    await act(async () => {
      staged = await result.current[1].applyGpsTargetDraftBatch("gps.jpg", [
        { schema_id: structuredClone(id), edit: structuredClone(entry.edit) },
      ]);
    });
    expect(staged).toBe(true);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "stage_media_library_session_gps_drafts",
      ),
    ).toHaveLength(1);
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(0);
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("expected loaded state");
    const stored = Object.values(
      state.targetDraftEditsStore.getMetadataFile("gps.jpg") ?? {},
    );
    expect(stored).toEqual([entry]);
    const value = stored[0].edit.value;
    expect(value?.kind).toBe("Real");
    if (value?.kind === "Real") expect(Object.is(value.value, -0)).toBe(true);
  });

  it("blocks target mutation and apply after strict target-load failure", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/broken");
    mock.draftLoadFailuresByFolder["/broken"] = "malformed target-aware file";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
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
    await act(async () => {
      result.current[1].setExistingOccurrenceDraft(
        "blocked.jpg",
        existingTarget,
        edit,
      );
      result.current[1].discardTargetPropertyDraft(
        "blocked.jpg",
        existingTarget,
      );
      exactRemovalSucceeded = await result.current[1].removeMetadataTargets(
        "blocked.jpg",
        [existingTarget],
      );
      groupRemovalSucceeded = await result.current[1].removeMetadataFields(
        "blocked.jpg",
        [id],
      );
      selectedRemovalSucceeded =
        await result.current[1].removeMetadataFieldFromFiles(id, [
          "blocked.jpg",
        ]);
    });
    expect(exactRemovalSucceeded).toBe(false);
    expect(groupRemovalSucceeded).toBe(false);
    expect(selectedRemovalSucceeded).toBe(false);
    state = result.current[0];
    if (state.kind !== "loaded") return;
    expect(state.targetDraftEdits).toBe(targetSnapshot);
    expect(state.targetDraftEdits).toEqual({});
    const loadFailedTargetDraftStore = state.targetDraftEditsStore;
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(1);

    act(() =>
      mock.emitVerificationOutcomes({
        "blocked.jpg": [
          {
            target: existingTarget,
            draft_reconciliation: { kind: "Blocked", reason: "stale" },
            display_name: "Subject",
            kind: "Blocked",
            sent: null,
            before: null,
            observed: null,
            message: null,
          },
        ],
      }),
    );
    act(() =>
      loadFailedTargetDraftStore.setMetadataTarget(
        "blocked.jpg",
        existingTarget,
        edit,
      ),
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
    expect(state.targetDraftEdits["blocked.jpg"]).toBeUndefined();
    expect(state.targetVerifyOutcomes["blocked.jpg"]).toBeDefined();
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
    ).toHaveLength(1);

    await act(async () => {
      await expect(
        result.current[1].applyDraftEdits("blocked.jpg"),
      ).rejects.toThrow(/could not be loaded safely/);
    });
    expect(
      mock.invocations.filter(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
      ),
    ).toHaveLength(1);

    // Even if a non-UI caller mutates the exposed store directly, Rust still
    // rejects Apply for the failed-load folder.
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
    ).toHaveLength(2);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
  it("reports strict target-aware load failure, preserves it, then switches safely", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    mock.draftLoadFailuresByFolder["/files"] = "invalid schema version";
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => result.current[1].openFolder());
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
      mock.invocations.some(
        ({ cmd }) => cmd === "set_media_library_session_draft",
      ),
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
    expect(mock.targetDraftEditsByFolder["/second"]?.["new.jpg"]).toBeDefined();
    expect(
      mock.targetDraftEditsByFolder["/files"]?.["new.jpg"],
    ).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "Worker error (metadata-target-load):",
      "invalid schema version",
    );
    consoleError.mockRestore();
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
    const mutationSessionIds = mock.invocations
      .filter(({ cmd }) => cmd === "set_media_library_session_draft")
      .map(({ args }) => args?.sessionId);
    expect(mutationSessionIds).toEqual([1, 2]);
    const loaded = result.current[0];
    if (loaded.kind !== "loaded") return;
    const store = loaded.targetDraftEditsStore;
    act(() => result.current[1].closeFolder());
    expect(store.getAllMetadata()).toEqual({});
    expect(result.current[0].kind).toBe("idle");
  });
});
