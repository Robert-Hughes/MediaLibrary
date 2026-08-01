/** App-level coverage for the sole target-aware metadata apply path. */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { KNOWN_METADATA_IDS } from "../metadata/knownIds";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataApplyFileResult,
  MetadataTargetDraftEntry,
  MetadataTargetOutcome,
} from "../types";
import {
  createApplyEditsProgressGate,
  createMockTauriApi,
} from "./mockTauriApi";
import { makeFile } from "./factories";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (payload: unknown) => void;

    constructor(handler: (payload: unknown) => void) {
      this.onmessage = handler;
      return mockApiInstance.api.createChannel(handler) as this;
    }
  },
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    mockApiInstance.api.invoke(cmd, args),
  convertFileSrc: (path: string) => `data:image/jpeg;base64,FAKE_${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) =>
    mockApiInstance.api.listen(event, (payload) => handler({ payload })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

const descriptionId = KNOWN_METADATA_IDS.xmpDescription;

function seedTargetDrafts(paths: string[]): MetadataTargetDraftEntry[] {
  const store = new TargetDraftEditsStore();
  const entries: MetadataTargetDraftEntry[] = [];
  for (const path of paths) {
    const target = {
      kind: "NewProperty" as const,
      schema_id: descriptionId,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    const edit = {
      intent: "Set" as const,
      value: { kind: "Text" as const, value: `Draft ${path}` },
    };
    store.setMetadataTarget(path, target, edit);
    entries.push({ target, edit });
  }
  mockApiInstance.targetDraftEditsByFolder["/files"] = store.getAllMetadata();
  return entries;
}

function fileResult(
  relativePath: string,
  overrides: Partial<MetadataApplyFileResult> = {},
): MetadataApplyFileResult {
  return {
    relative_path: relativePath,
    applied: true,
    error: null,
    warning: null,
    fresh_file_metadata: null,
    target_outcomes: [],
    persisted_draft_entries: [],
    ...overrides,
  };
}

async function openFolderWithFiles(files: ReturnType<typeof makeFile>[]) {
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/files");
  render(<App />);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  await user.click(screen.getByTestId("open-folder-btn"));
  act(() => {
    for (const file of files) mockApiInstance.emitFileFound(file);
    mockApiInstance.emitScanComplete();
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 120))));
  return { user };
}

async function openFolderWithFile(
  file = makeFile({ relative_path: "test.jpg" }),
) {
  const { user } = await openFolderWithFiles([file]);
  return { user, file };
}

beforeEach(() => {
  mockApiInstance = createMockTauriApi();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("target-aware Apply All", () => {
  it("is hidden without drafts and visible with target drafts", async () => {
    await openFolderWithFile();
    expect(screen.queryByTestId("status-bar-apply-all-btn")).toBeNull();
  });

  it("confirms and invokes only the target-aware command", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const file = makeFile({ relative_path: "test.jpg" });
    seedTargetDrafts([file.relative_path]);
    const { user } = await openFolderWithFile(file);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await waitFor(() =>
      expect(
        mockApiInstance.invocations.some(
          ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
        ),
      ).toBe(true),
    );
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("permanently modify"),
      expect.objectContaining({ title: "Apply All Edits" }),
    );
    expect(
      mockApiInstance.invocations.find(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
      )?.args?.relPaths,
    ).toBeNull();
  });

  it("leaves drafts available when confirmation is cancelled", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockResolvedValueOnce(false);
    seedTargetDrafts(["test.jpg"]);
    const { user } = await openFolderWithFile();
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeVisible();
    expect(
      mockApiInstance.invocations.some(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
      ),
    ).toBe(false);
  });
});

describe("single-file target apply", () => {
  it("applies only the row selected from the list context menu", async () => {
    const files = ["a.jpg", "b.jpg"].map((relative_path) =>
      makeFile({ relative_path }),
    );
    seedTargetDrafts(files.map((file) => file.relative_path));
    const { user } = await openFolderWithFiles(files);
    await user.pointer({
      target: screen.getAllByTestId("file-row")[0],
      keys: "[MouseRight]",
    });
    await user.click(screen.getByText("Apply edits…"));
    await waitFor(() =>
      expect(
        mockApiInstance.invocations.find(
          ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
        )?.args?.relPaths,
      ).toEqual(["a.jpg"]),
    );
  });

  it("shows and uses Apply in the Details Pane", async () => {
    const file = makeFile({ relative_path: "test.jpg" });
    seedTargetDrafts([file.relative_path]);
    const { user } = await openFolderWithFile(file);
    await user.dblClick(screen.getByTestId("file-row"));
    await user.click(screen.getByTestId("gallery-info-toggle"));
    const apply = await screen.findByTestId("details-pane-apply-btn");
    await user.click(apply);
    await waitFor(() =>
      expect(
        mockApiInstance.invocations.find(
          ({ cmd }) => cmd === "apply_metadata_draft_edits_cmd",
        )?.args?.relPaths,
      ).toEqual([file.relative_path]),
    );
  });
});

describe("target-aware progress and results", () => {
  it("shows incremental counts before completion and supports cancellation", async () => {
    const paths = ["a.jpg", "b.jpg", "c.jpg"];
    seedTargetDrafts(paths);
    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;
    const { user } = await openFolderWithFiles(
      paths.map((relative_path) => makeFile({ relative_path })),
    );
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "1 of 3 files",
      ),
    );
    await user.click(screen.getByTestId("apply-progress-cancel-btn"));
    expect(mockApiInstance.cancelTargetApplyCalled).toBe(true);
    expect(screen.getByTestId("apply-progress-cancel-btn")).toHaveTextContent(
      "Cancelling",
    );
    act(() => gate.advance());
    expect(await screen.findByTestId("apply-complete-summary")).toBeVisible();
    expect(screen.getByText("Apply cancelled")).toBeVisible();
    await user.click(screen.getByText("Close"));
    expect(screen.queryByTestId("apply-progress-dialog")).toBeNull();
    expect(mockApiInstance.applyProgressEvents).toHaveLength(1);
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeVisible();
  });

  it("merges authoritative metadata incrementally and clears successful drafts", async () => {
    seedTargetDrafts(["test.jpg"]);
    mockApiInstance.targetApplyProgressResultsByPath["test.jpg"] = fileResult(
      "test.jpg",
      {
        fresh_file_metadata: {
          relative_path: "test.jpg",
          occurrences: [],
        },
      },
    );
    const { user } = await openFolderWithFile();
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await waitFor(() =>
      expect(screen.queryByTestId("status-bar-apply-all-btn")).toBeNull(),
    );
  });

  it("keeps failed drafts and reports warnings without counting them as failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paths = ["warning.jpg", "failed.jpg", "clean.jpg"];
    const entries = seedTargetDrafts(paths);
    mockApiInstance.targetApplyProgressResultsByPath["warning.jpg"] =
      fileResult("warning.jpg", { warning: "ExifTool warning message" });
    mockApiInstance.targetApplyProgressResultsByPath["failed.jpg"] = fileResult(
      "failed.jpg",
      {
        applied: false,
        error: "File write error",
        persisted_draft_entries: [entries[1]],
      },
    );
    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;
    const { user } = await openFolderWithFiles(
      paths.map((relative_path) => makeFile({ relative_path })),
    );
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "1 of 3 files",
      ),
    );
    expect(screen.getByTestId("apply-progress-count")).not.toHaveTextContent(
      "failed",
    );
    act(() => gate.advance());
    await waitFor(() =>
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "1 failed",
      ),
    );
    act(() => gate.advance());
    await waitFor(() =>
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "3 of 3 files",
      ),
    );
    act(() => gate.advance());
    expect(
      await screen.findByTestId("apply-complete-summary"),
    ).toHaveTextContent("2 applied, 1 failed, 1 warning");
    expect(screen.queryByTestId("apply-complete-details")).toBeNull();
    await user.click(screen.getByText("Show details"));
    const details = screen.getByTestId("apply-complete-details");
    expect(within(details).getByText("failed.jpg")).toBeVisible();
    expect(within(details).getByText("File write error")).toBeVisible();
    expect(within(details).getByText("warning.jpg")).toBeVisible();
    expect(within(details).getByText("ExifTool warning message")).toBeVisible();
    await user.click(screen.getByText("Close"));
    expect(screen.queryByTestId("apply-progress-dialog")).toBeNull();
    expect(screen.getByText(/File write error/)).toBeVisible();
    expect(screen.getByText(/ExifTool warning message/)).toBeVisible();
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeVisible();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[application-error:metadata-target-file]"),
      expect.objectContaining({ affectedFiles: ["failed.jpg"] }),
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("[application-warning:metadata-target-warning]"),
      expect.objectContaining({ affectedFiles: ["warning.jpg"] }),
    );
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("opens target verification when an exact target needs attention", async () => {
    const [entry] = seedTargetDrafts(["test.jpg"]);
    const outcome: MetadataTargetOutcome = {
      target: entry.target,
      draft_reconciliation: { kind: "Keep" },
      display_name: "Description",
      kind: "Mismatch",
      sent: entry.edit.value,
      before: null,
      observed: { kind: "Text", value: "Different value" },
      message: "readback differed",
    };
    mockApiInstance.targetApplyProgressResultsByPath["test.jpg"] = fileResult(
      "test.jpg",
      {
        target_outcomes: [outcome],
        persisted_draft_entries: [entry],
      },
    );
    const { user } = await openFolderWithFile();
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    expect(await screen.findByTestId("apply-complete-summary")).toBeVisible();
    expect(screen.queryByTestId("target-verify-outcome-dialog")).toBeNull();
    expect(screen.queryByTestId("apply-verification-details")).toBeNull();
    await user.click(screen.getByText("Show details"));
    expect(screen.getByTestId("apply-verification-details")).toBeVisible();
    expect(screen.getByText("Mismatch")).toBeVisible();
  });
});
