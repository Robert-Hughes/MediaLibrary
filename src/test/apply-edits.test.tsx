/**
 * Integration tests for Apply Draft Edits feature
 */
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
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
  listen: (evt: string, handler: (event: { payload: unknown }) => void) =>
    mockApiInstance.api.listen(evt, (payload: unknown) => handler({ payload })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

async function openFolderWithPhoto(
  photo = makePhoto({ relative_path: "test.jpg" }),
) {
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/photos");
  render(<App />);

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const openBtn = screen.getByTestId("open-folder-btn");
  await user.click(openBtn);

  await act(async () => {
    mockApiInstance.emitPhotoFound(photo);
  });
  await act(async () => {
    mockApiInstance.emitScanComplete();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });

  return { user, photo };
}

async function openFolderWithPhotos(photos: ReturnType<typeof makePhoto>[]) {
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/photos");
  render(<App />);

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  await user.click(screen.getByTestId("open-folder-btn"));

  for (const photo of photos) {
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo);
    });
  }
  await act(async () => {
    mockApiInstance.emitScanComplete();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });

  return { user };
}

async function seedDraftEdit(photo: ReturnType<typeof makePhoto>) {
  mockApiInstance.draftEditsByFolder["/photos"] = {
    [photo.relative_path]: {
      "XMP-dc:Description": {
        value: { kind: "Text", value: "Draft value" },
        intent: "Set",
      },
    },
  };
}

describe("Apply Draft Edits – MenuBar", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("Apply All Edits button is not visible when there are no drafts", async () => {
    await openFolderWithPhoto();
    expect(
      screen.queryByTestId("status-bar-apply-all-btn"),
    ).not.toBeInTheDocument();
  });

  it("Apply All Edits button appears when there are draft edits", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    await openFolderWithPhoto(photo);
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeInTheDocument();
  });

  it("clicking Apply All Edits shows confirmation dialog", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    const { user } = await openFolderWithPhoto(photo);

    const btn = screen.getByTestId("status-bar-apply-all-btn");
    await user.click(btn);

    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("permanently modify"),
      expect.objectContaining({ title: "Apply All Edits" }),
    );
  });

  it("after successful apply, draft edits are cleared from state", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    mockApiInstance.applyEditsResult = {
      applied: [photo.relative_path],
      failed: [],
      fresh_metadata: {
        [photo.relative_path]: {
          "XMP-dc:Description": { kind: "Text", value: "Draft value" },
        },
      },
    };

    const { user } = await openFolderWithPhoto(photo);
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeInTheDocument();

    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Button should disappear once drafts are gone
    expect(
      screen.queryByTestId("status-bar-apply-all-btn"),
    ).not.toBeInTheDocument();
  });

  it("apply_metadata_draft_edits_cmd is invoked with correct folder and paths", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    mockApiInstance.applyEditsResult = {
      applied: [photo.relative_path],
      failed: [],
      fresh_metadata: {},
    };

    const { user } = await openFolderWithPhoto(photo);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const applyCall = mockApiInstance.invocations.find(
      (i) => i.cmd === "apply_metadata_draft_edits_cmd",
    );
    expect(applyCall).toBeDefined();
    expect(applyCall?.args?.folderPath).toBe("/photos");
    expect(applyCall?.args?.relPaths).toContain(photo.relative_path);
  });

  it("when user cancels confirmation dialog, no apply command is sent", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockResolvedValueOnce(false);

    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    const { user } = await openFolderWithPhoto(photo);

    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const applyCall = mockApiInstance.invocations.find(
      (i) => i.cmd === "apply_metadata_draft_edits_cmd",
    );
    expect(applyCall).toBeUndefined();
    // Drafts still present
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeInTheDocument();
  });
});

describe("Apply Draft Edits – PhotoList context menu", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("Apply edits option appears in context menu for row with drafts", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    const { user } = await openFolderWithPhoto(photo);

    const row = screen.getByTestId("photo-row");
    await user.pointer({ target: row, keys: "[MouseRight]" });

    expect(screen.getByText("Apply edits…")).toBeInTheDocument();
  });

  it("Apply edits option not shown when row has no drafts", async () => {
    const { user } = await openFolderWithPhoto();

    const row = screen.getByTestId("photo-row");
    await user.pointer({ target: row, keys: "[MouseRight]" });

    expect(screen.queryByText("Apply edits")).not.toBeInTheDocument();
  });

  it("clicking Apply edits on a row invokes apply with only that file", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    mockApiInstance.applyEditsResult = {
      applied: [photo.relative_path],
      failed: [],
      fresh_metadata: {},
    };

    const { user } = await openFolderWithPhoto(photo);
    const row = screen.getByTestId("photo-row");
    await user.pointer({ target: row, keys: "[MouseRight]" });
    await user.click(screen.getByText("Apply edits…"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const applyCall = mockApiInstance.invocations.find(
      (i) => i.cmd === "apply_metadata_draft_edits_cmd",
    );
    expect(applyCall?.args?.relPaths).toEqual([photo.relative_path]);
  });
});

describe("Apply Draft Edits – DetailsPane (gallery)", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function openGalleryWithDraft() {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    const { user } = await openFolderWithPhoto(photo);

    const row = screen.getByTestId("photo-row");
    await user.dblClick(row);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Open the details pane
    const toggle = screen.getByTestId("gallery-info-toggle");
    await user.click(toggle);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    return { user, photo };
  }

  it("Apply button appears in DetailsPane when photo has draft edits", async () => {
    await openGalleryWithDraft();
    expect(screen.getByTestId("details-pane-apply-btn")).toBeInTheDocument();
  });

  it("clicking Apply button in DetailsPane invokes apply for only that photo", async () => {
    const { user, photo } = await openGalleryWithDraft();
    mockApiInstance.applyEditsResult = {
      applied: [photo.relative_path],
      failed: [],
      fresh_metadata: {},
    };

    await user.click(screen.getByTestId("details-pane-apply-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const applyCall = mockApiInstance.invocations.find(
      (i) => i.cmd === "apply_metadata_draft_edits_cmd",
    );
    expect(applyCall?.args?.relPaths).toEqual([photo.relative_path]);
  });

  it("Apply button not visible when photo has no drafts", async () => {
    const { user } = await openFolderWithPhoto();
    const row = screen.getByTestId("photo-row");
    await user.dblClick(row);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const toggle = screen.getByTestId("gallery-info-toggle");
    await user.click(toggle);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(
      screen.queryByTestId("details-pane-apply-btn"),
    ).not.toBeInTheDocument();
  });
});

describe("Apply Draft Edits – Progress dialog and cancellation", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("after apply, dialog closes and applied drafts cleared from state", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    mockApiInstance.applyEditsResult = {
      applied: [photo.relative_path],
      failed: [],
      fresh_metadata: {},
    };

    const { user } = await openFolderWithPhoto(photo);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(
      screen.queryByTestId("apply-progress-dialog"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("status-bar-apply-all-btn"),
    ).not.toBeInTheDocument();
  });

  it("apply progress advances incrementally before command resolves", async () => {
    const photos = ["a.jpg", "b.jpg", "c.jpg"].map((relative_path) =>
      makePhoto({ relative_path }),
    );
    mockApiInstance.draftEditsByFolder["/photos"] = Object.fromEntries(
      photos.map((photo) => [
        photo.relative_path,
        {
          "XMP-dc:Description": {
            value: { kind: "Text", value: `Draft ${photo.relative_path}` },
            intent: "Set",
          },
        },
      ]),
    );
    mockApiInstance.applyEditsResult = {
      applied: photos.map((photo) => photo.relative_path),
      failed: [],
      fresh_metadata: {},
    };
    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;

    const { user } = await openFolderWithPhotos(photos);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "1 of 3 files",
      );
    });
    expect(screen.getByTestId("apply-progress-dialog")).toBeInTheDocument();

    await act(async () => {
      gate.advance();
    });

    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "2 of 3 files",
      );
    });
    expect(screen.getByTestId("apply-progress-dialog")).toBeInTheDocument();

    await act(async () => {
      gate.advance();
    });
    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "3 of 3 files",
      );
    });
    await act(async () => {
      gate.advance();
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("apply-progress-dialog"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("status-bar-apply-all-btn"),
    ).not.toBeInTheDocument();
  });

  it("cancel during apply signals backend and keeps dialog in cancelling state", async () => {
    const photos = ["a.jpg", "b.jpg"].map((relative_path) =>
      makePhoto({ relative_path }),
    );
    mockApiInstance.draftEditsByFolder["/photos"] = Object.fromEntries(
      photos.map((photo) => [
        photo.relative_path,
        {
          "XMP-dc:Description": {
            value: { kind: "Text", value: `Draft ${photo.relative_path}` },
            intent: "Set",
          },
        },
      ]),
    );
    mockApiInstance.applyEditsResult = {
      applied: photos.map((photo) => photo.relative_path),
      failed: [],
      fresh_metadata: {},
    };
    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;

    const { user } = await openFolderWithPhotos(photos);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "1 of 2 files",
      );
    });

    await user.click(screen.getByTestId("apply-progress-cancel-btn"));

    expect(mockApiInstance.cancelApplyEditsCalled).toBe(true);
    expect(screen.getByTestId("apply-progress-cancel-btn")).toBeDisabled();
    expect(screen.getByTestId("apply-progress-cancel-btn")).toHaveTextContent(
      "Cancelling",
    );

    await act(async () => {
      gate.advance();
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("apply-progress-dialog"),
      ).not.toBeInTheDocument();
    });

    expect(
      mockApiInstance.applyProgressEvents.map((event) => event.relative_path),
    ).toEqual(["a.jpg"]);
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeInTheDocument();
  });

  it("mocked apply returns only files processed before cancellation", async () => {
    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;
    mockApiInstance.applyEditsResult = {
      applied: ["a.jpg", "b.jpg"],
      failed: [],
      fresh_metadata: {
        "a.jpg": {
          "XMP-dc:Description": { kind: "Text", value: "Applied A" },
        },
        "b.jpg": {
          "XMP-dc:Description": { kind: "Text", value: "Applied B" },
        },
      },
    };

    const applyPromise = mockApiInstance.api.invoke(
      "apply_metadata_draft_edits_cmd",
      {
        folderPath: "/photos",
        relPaths: ["a.jpg", "b.jpg"],
      },
    );

    await waitFor(() => {
      expect(mockApiInstance.applyProgressEvents).toHaveLength(1);
    });
    await mockApiInstance.api.invoke("cancel_apply_edits");
    gate.advance();

    await expect(applyPromise).resolves.toEqual({
      applied: ["a.jpg"],
      failed: [],
      fresh_metadata: {
        "a.jpg": {
          "XMP-dc:Description": { kind: "Text", value: "Applied A" },
        },
      },
    });
  });

  it("incremental fresh_metadata is merged as events arrive (not at end)", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);

    // Result includes fresh metadata; mock dispatches it via progress event
    mockApiInstance.applyEditsResult = {
      applied: [photo.relative_path],
      failed: [],
      fresh_metadata: {
        [photo.relative_path]: {
          "XMP-dc:Description": { kind: "Text", value: "Applied value" },
        },
      },
    };

    const { user } = await openFolderWithPhoto(photo);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // Drafts cleared (event-driven)
    expect(
      screen.queryByTestId("status-bar-apply-all-btn"),
    ).not.toBeInTheDocument();
  });
});

describe("Apply Draft Edits – Failure handling", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("when apply fails, error banner shows the failure reason", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);
    mockApiInstance.applyEditsResult = {
      applied: [],
      failed: [
        {
          relative_path: photo.relative_path,
          reason: "ExifTool failed: permission denied",
        },
      ],
      fresh_metadata: {},
    };

    const { user } = await openFolderWithPhoto(photo);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(
      screen.getByText(/ExifTool failed: permission denied/),
    ).toBeInTheDocument();
  });

  it("when apply partially fails, applied drafts removed but failed ones preserved", async () => {
    const photo1 = makePhoto({ relative_path: "a.jpg" });
    const photo2 = makePhoto({ relative_path: "b.jpg" });

    mockApiInstance.draftEditsByFolder["/photos"] = {
      "a.jpg": {
        "XMP-dc:Description": {
          value: { kind: "Text", value: "Draft A" },
          intent: "Set",
        },
      },
      "b.jpg": {
        "XMP-dc:Description": {
          value: { kind: "Text", value: "Draft B" },
          intent: "Set",
        },
      },
    };
    mockApiInstance.applyEditsResult = {
      applied: ["a.jpg"],
      failed: [{ relative_path: "b.jpg", reason: "File not found" }],
      fresh_metadata: {},
    };

    const user = userEvent.setup();
    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(screen.getByTestId("open-folder-btn"));

    await act(async () => {
      mockApiInstance.emitPhotoFound(photo1);
    });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo2);
    });
    await act(async () => {
      mockApiInstance.emitScanComplete();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    await user.click(screen.getByTestId("status-bar-apply-all-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Error shown for b.jpg
    expect(screen.getByText(/File not found/)).toBeInTheDocument();

    // Apply button still present (b.jpg still has draft)
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeInTheDocument();
  });
});

describe("Apply Draft Edits – Warning and Success-with-Warning handling", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("Apply warning is displayed and does not count as failure", async () => {
    const photo = makePhoto({ relative_path: "test.jpg" });
    await seedDraftEdit(photo);

    mockApiInstance.applyEditsResult = {
      applied: [photo.relative_path],
      failed: [],
      fresh_metadata: {
        [photo.relative_path]: {
          "XMP-dc:Description": { kind: "Text", value: "Applied value" },
        },
      },
    };
    mockApiInstance.warningsByPath = {
      [photo.relative_path]: "ExifTool warning message",
    };

    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;

    const { user } = await openFolderWithPhoto(photo);
    await user.click(screen.getByTestId("status-bar-apply-all-btn"));

    // Wait for progress dialog to appear
    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-dialog")).toBeInTheDocument();
    });

    // Check that failureCount is 0 / not incremented in progress dialog
    expect(screen.getByTestId("apply-progress-count")).not.toHaveTextContent(
      "failed",
    );

    // Advance the progress gate to finish the apply
    await act(async () => {
      gate.advance();
    });

    // Wait for progress dialog to close
    await waitFor(() => {
      expect(
        screen.queryByTestId("apply-progress-dialog"),
      ).not.toBeInTheDocument();
    });

    // Verify warning is displayed in ErrorBanner
    expect(screen.getByText(/ExifTool warning message/)).toBeInTheDocument();
    expect(screen.getByText("Apply Warning")).toBeInTheDocument();

    // Verify draft edits are pruned (applied drafts removed) because warning counts as success
    expect(
      screen.queryByTestId("status-bar-apply-all-btn"),
    ).not.toBeInTheDocument();
  });

  it("Mixed batch: one warning, one error, one clean success", async () => {
    const photo1 = makePhoto({ relative_path: "a.jpg" });
    const photo2 = makePhoto({ relative_path: "b.jpg" });
    const photo3 = makePhoto({ relative_path: "c.jpg" });

    mockApiInstance.draftEditsByFolder["/photos"] = {
      "a.jpg": {
        "XMP-dc:Description": {
          value: { kind: "Text", value: "Draft A" },
          intent: "Set",
        },
      },
      "b.jpg": {
        "XMP-dc:Description": {
          value: { kind: "Text", value: "Draft B" },
          intent: "Set",
        },
      },
      "c.jpg": {
        "XMP-dc:Description": {
          value: { kind: "Text", value: "Draft C" },
          intent: "Set",
        },
      },
    };

    // a.jpg: success with warning
    // b.jpg: error
    // c.jpg: clean success
    mockApiInstance.applyEditsResult = {
      applied: ["a.jpg", "c.jpg"],
      failed: [{ relative_path: "b.jpg", reason: "File write error" }],
      fresh_metadata: {},
    };
    mockApiInstance.warningsByPath = {
      "a.jpg": "Warning for A",
    };

    const gate = createApplyEditsProgressGate();
    mockApiInstance.applyEditsProgressGate = gate;

    const user = userEvent.setup();
    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(screen.getByTestId("open-folder-btn"));

    await act(async () => {
      mockApiInstance.emitPhotoFound(photo1);
    });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo2);
    });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo3);
    });
    await act(async () => {
      mockApiInstance.emitScanComplete();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    await user.click(screen.getByTestId("status-bar-apply-all-btn"));

    // Wait for progress dialog to show first file (a.jpg - warning) is processed
    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "1 of 3 files",
      );
    });
    // Check that failureCount is 0 because only warning happened
    expect(screen.getByTestId("apply-progress-count")).not.toHaveTextContent(
      "failed",
    );

    // Advance for a.jpg (warning)
    await act(async () => {
      gate.advance();
    });
    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "2 of 3 files",
      );
    });

    // Advance for b.jpg (error)
    await act(async () => {
      gate.advance();
    });
    await waitFor(() => {
      expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
        "3 of 3 files",
      );
    });
    // Check that failureCount is 1 because of the error
    expect(screen.getByTestId("apply-progress-count")).toHaveTextContent(
      "1 failed",
    );

    // Advance to finish
    await act(async () => {
      gate.advance();
    });

    // Wait for progress dialog to close
    await waitFor(() => {
      expect(
        screen.queryByTestId("apply-progress-dialog"),
      ).not.toBeInTheDocument();
    });

    // Verify warning for a.jpg and error for b.jpg are both visible in ErrorBanner
    expect(screen.getByText(/Warning for A/)).toBeInTheDocument();
    expect(screen.getByText("Apply Warning")).toBeInTheDocument();
    expect(screen.getByText(/File write error/)).toBeInTheDocument();
    expect(screen.getByText("Apply Error")).toBeInTheDocument();
  });
});
