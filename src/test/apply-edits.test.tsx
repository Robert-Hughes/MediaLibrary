/** App-level coverage for the sole target-aware metadata apply path. */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { KNOWN_METADATA_IDS } from "../metadata/knownIds";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataApplyFileResultV5,
  MetadataDraftEntryV5,
  MetadataTargetOutcome,
} from "../types";
import {
  createApplyEditsProgressGate,
  createMockTauriApi,
} from "./mockTauriApi";
import { makePhoto } from "./factories";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
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

function seedTargetDrafts(paths: string[]): MetadataDraftEntryV5[] {
  const store = new TargetDraftEditsStore();
  const entries: MetadataDraftEntryV5[] = [];
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
  mockApiInstance.targetDraftEditsByFolder["/photos"] = store.getAllMetadata();
  return entries;
}

function fileResult(
  relativePath: string,
  overrides: Partial<MetadataApplyFileResultV5> = {},
): MetadataApplyFileResultV5 {
  return {
    relative_path: relativePath,
    applied: true,
    error: null,
    warning: null,
    fresh_image_metadata: null,
    target_outcomes: [],
    persisted_draft_entries: [],
    ...overrides,
  };
}

async function openFolderWithPhotos(photos: ReturnType<typeof makePhoto>[]) {
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/photos");
  render(<App />);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  await user.click(screen.getByTestId("open-folder-btn"));
  act(() => {
    for (const photo of photos) mockApiInstance.emitPhotoFound(photo);
    mockApiInstance.emitScanComplete();
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 120))));
  return { user };
}

async function openFolderWithPhoto(
  photo = makePhoto({ relative_path: "test.jpg" }),
) {
  const { user } = await openFolderWithPhotos([photo]);
  return { user, photo };
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
    await openFolderWithPhoto();
    expect(screen.queryByTestId("status-bar-apply-all-btn")).toBeNull();
  });

  it("confirms and invokes only the v5 command", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const photo = makePhoto({ relative_path: "test.jpg" });
    seedTargetDrafts([photo.relative_path]);
    const { user } = await openFolderWithPhoto(photo);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await waitFor(() =>
      expect(
        mockApiInstance.invocations.some(
          ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
        ),
      ).toBe(true),
    );
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("permanently modify"),
      expect.objectContaining({ title: "Apply All Edits" }),
    );
    expect(
      mockApiInstance.invocations.find(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
      )?.args?.relPaths,
    ).toEqual([photo.relative_path]);
  });

  it("leaves drafts available when confirmation is cancelled", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockResolvedValueOnce(false);
    seedTargetDrafts(["test.jpg"]);
    const { user } = await openFolderWithPhoto();
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeVisible();
    expect(
      mockApiInstance.invocations.some(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
      ),
    ).toBe(false);
  });
});

describe("single-file target apply", () => {
  it("applies only the row selected from the list context menu", async () => {
    const photos = ["a.jpg", "b.jpg"].map((relative_path) =>
      makePhoto({ relative_path }),
    );
    seedTargetDrafts(photos.map((photo) => photo.relative_path));
    const { user } = await openFolderWithPhotos(photos);
    await user.pointer({
      target: screen.getAllByTestId("photo-row")[0],
      keys: "[MouseRight]",
    });
    await user.click(screen.getByText("Apply edits…"));
    await waitFor(() =>
      expect(
        mockApiInstance.invocations.find(
          ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
        )?.args?.relPaths,
      ).toEqual(["a.jpg"]),
    );
  });

  it("shows and uses Apply in the Details Pane", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    seedTargetDrafts([photo.relative_path]);
    const { user } = await openFolderWithPhoto(photo);
    await user.dblClick(screen.getByTestId("photo-row"));
    await user.click(screen.getByTestId("gallery-info-toggle"));
    const apply = await screen.findByTestId("details-pane-apply-btn");
    await user.click(apply);
    await waitFor(() =>
      expect(
        mockApiInstance.invocations.find(
          ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
        )?.args?.relPaths,
      ).toEqual([photo.relative_path]),
    );
  });
});

describe("target-aware progress and results", () => {
  it("shows incremental counts before completion and supports cancellation", async () => {
    const paths = ["a.jpg", "b.jpg", "c.jpg"];
    seedTargetDrafts(paths);
    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;
    const { user } = await openFolderWithPhotos(
      paths.map((relative_path) => makePhoto({ relative_path })),
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
    await waitFor(() =>
      expect(screen.queryByTestId("apply-progress-dialog")).toBeNull(),
    );
    expect(mockApiInstance.applyProgressEvents).toHaveLength(1);
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeVisible();
  });

  it("merges authoritative metadata incrementally and clears successful drafts", async () => {
    seedTargetDrafts(["test.jpg"]);
    mockApiInstance.targetApplyProgressResultsByPath["test.jpg"] = fileResult(
      "test.jpg",
      {
        fresh_image_metadata: {
          relative_path: "test.jpg",
          occurrences: [],
        },
      },
    );
    const { user } = await openFolderWithPhoto();
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await waitFor(() =>
      expect(screen.queryByTestId("status-bar-apply-all-btn")).toBeNull(),
    );
  });

  it("keeps failed drafts and reports warnings without counting them as failures", async () => {
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
    const { user } = await openFolderWithPhotos(
      paths.map((relative_path) => makePhoto({ relative_path })),
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
    await waitFor(() =>
      expect(screen.queryByTestId("apply-progress-dialog")).toBeNull(),
    );
    expect(screen.getByText(/File write error/)).toBeVisible();
    expect(screen.getByText(/ExifTool warning message/)).toBeVisible();
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeVisible();
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
    const { user } = await openFolderWithPhoto();
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    expect(
      await screen.findByTestId("target-verify-outcome-dialog"),
    ).toBeVisible();
    expect(screen.getByText("Mismatch")).toBeVisible();
  });
});
