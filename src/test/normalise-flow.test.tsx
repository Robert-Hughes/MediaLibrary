/**
 * End-to-end test for the metadata-normalisation UI flow.
 *
 * Mirrors `geocode-flow.test.tsx` in shape (single image, App-level
 * render, mocked Tauri invoke + listen). The normalise flow has no
 * estimate phase in v1 — opens straight to the per-group checkbox
 * confirm panel. Verifies:
 *
 *   * Right-clicking a selected photo shows the "Normalise Metadata…"
 *     menu entry and clicking opens the progress dialog.
 *   * Awaiting-confirm panel exposes the v1 group checkboxes.
 *   * Confirm sends the per-image `groupInputs` + final `enabledGroups`
 *     to the backend and merges the returned edits into drafts.
 *   * Done panel renders the summary breakdown.
 */
import {
  render,
  screen,
  act,
  waitFor,
  fireEvent,
  renderHook,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto, mockGeneratedDraftEntries } from "./factories";
import type {
  MetadataValue,
  NormaliseGroup,
  NormaliseRequestItem,
  SchemaMetadataEdit,
} from "../types";
import { useNormaliseMetadata } from "../hooks/useNormaliseMetadata";

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
  rel = "test.jpg",
  metadata: Record<string, MetadataValue> = {},
) {
  const photo = makePhoto({ relative_path: rel });
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/photos");
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await user.click(screen.getByTestId("open-folder-btn"));
  await act(async () => {
    mockApiInstance.emitPhotoFound(photo);
  });
  await act(async () => {
    mockApiInstance.emitScanComplete();
  });
  await act(async () => {
    mockApiInstance.emitImageMetadataReady(rel, metadata);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
  return { user, photo };
}

beforeEach(() => {
  mockApiInstance = createMockTauriApi();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Metadata-normalisation flow", () => {
  it("stages one backend progress batch through the batch callback", async () => {
    const edits = mockGeneratedDraftEntries({
      "XMP-dc:Title": {
        intent: "Set",
        value: { kind: "Text", value: "normalised" },
      },
    });
    mockApiInstance.normaliseSchedule = [
      { relativePath: "one.jpg", status: "ok", edits },
      { relativePath: "two.jpg", status: "ok", edits },
    ];
    const stageBatch = vi.fn(
      (
        items: readonly {
          relativePath: string;
          edits: SchemaMetadataEdit[];
        }[],
      ) => items.map(() => ({ kind: "success" as const, changed: true })),
    );
    const { result } = renderHook(() =>
      useNormaliseMetadata({ onApplyEditsBatch: stageBatch }),
    );
    const items = ["one.jpg", "two.jpg"].map(
      (relPath) => ({ relPath }) as NormaliseRequestItem,
    );

    act(() => result.current.actions.start("/photos", items, ["title"]));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("awaiting-confirm"),
    );
    act(() => result.current.actions.confirm());
    await waitFor(() => expect(result.current.state.phase).toBe("done"));

    expect(stageBatch).toHaveBeenCalledOnce();
    expect(stageBatch).toHaveBeenCalledWith(
      [
        { relativePath: "one.jpg", edits },
        { relativePath: "two.jpg", edits },
      ],
      ["title"],
    );
    expect(result.current.state.succeeded).toEqual(["one.jpg", "two.jpg"]);
  });

  it("stages delayed results against the immutable confirmed group snapshot", async () => {
    let releaseProgress!: () => void;
    mockApiInstance.beforeNormaliseProgress = () =>
      new Promise<void>((resolve) => {
        releaseProgress = resolve;
      });
    const edits = mockGeneratedDraftEntries({
      "XMP-dc:Subject": {
        intent: "Set",
        value: {
          kind: "List",
          value: {
            list_kind: "Bag",
            items: [{ kind: "Text", value: "confirmed" }],
          },
        },
      },
      "XMP-dc:Title": {
        intent: "Set",
        value: { kind: "Text", value: "later-only" },
      },
    });
    mockApiInstance.normaliseSchedule = [
      { relativePath: "test.jpg", status: "ok", edits },
    ];
    const stage = vi.fn(
      (
        _relativePath: string,
        _edits: SchemaMetadataEdit[],
        _confirmedGroups: readonly NormaliseGroup[],
      ) => ({ kind: "success" as const, changed: true }),
    );
    const { result } = renderHook(() =>
      useNormaliseMetadata({ onApplyEdits: stage }),
    );
    const item = { relPath: "test.jpg" } as NormaliseRequestItem;

    act(() => result.current.actions.start("/photos", [item], ["keywords"]));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("awaiting-confirm"),
    );
    act(() => result.current.actions.confirm());
    await waitFor(() => expect(releaseProgress).toBeTypeOf("function"));

    // Diverge mutable checkbox/session state after confirmation while the
    // backend result is still in flight.
    act(() => result.current.actions.setEnabledGroups(["title"]));
    act(() => releaseProgress());

    await waitFor(() => expect(stage).toHaveBeenCalledOnce());
    expect(stage).toHaveBeenCalledWith("test.jpg", edits, ["keywords"]);
    expect(result.current.state.enabledGroups).toEqual(["title"]);
  });

  it("right-clicking a selected photo opens the dialog with per-group checkboxes", async () => {
    await openFolderWithPhoto("test.jpg", {
      "XMP-dc:Subject": {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [
            { kind: "Text", value: "A" },
            { kind: "Text", value: "B" },
          ],
        },
      },
    });
    const row = screen.getByTestId("photo-row");
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    const entry = await screen.findByRole("button", {
      name: /^Normalise Metadata/,
    });
    fireEvent.click(entry);

    await screen.findByTestId("normalise-progress-dialog");
    // Dialog opens in the estimating phase (plan §7); wait for the
    // estimate_complete event to transition into awaiting-confirm.
    await screen.findByTestId("normalise-group-keywords-checkbox");
    expect(
      screen.getByTestId("normalise-group-keywords-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("normalise-group-creator-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("normalise-group-copyright-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("normalise-group-headline-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("normalise-group-title-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("normalise-group-location-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("normalise-group-dates-checkbox"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("normalise-group-description-checkbox"),
    ).toBeInTheDocument();
  });

  it("confirm sends groupInputs + enabledGroups to backend and lands drafts", async () => {
    mockApiInstance.normaliseSchedule = [
      {
        relativePath: "test.jpg",
        status: "ok",
        edits: mockGeneratedDraftEntries({
          "XMP-lr:HierarchicalSubject": {
            value: {
              kind: "List",
              value: {
                list_kind: "Bag",
                items: [{ kind: "Text", value: "a" }],
              },
            },
            intent: "Set",
          },
        }),
      },
    ];
    mockApiInstance.normaliseSummary = {
      ...mockApiInstance.normaliseSummary,
      nSucceeded: 1,
      perGroup: {
        keywords: {
          nNoop: 0,
          nNormalisedDeterministic: 1,
          nNormalisedAi: 0,
          nConflictPrimaryWon: 0,
          nLocationXmpIimConflict: 0,
          nDateConflict: 0,
          nDtoFromFilename: 0,
          nDtoFromFilenameDateOnly: 0,
          nUnparseableDateInputs: 0,
          nAiErrors: 0,
        },
      },
    };

    await openFolderWithPhoto("test.jpg", {
      "XMP-dc:Subject": {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [{ kind: "Text", value: "A" }],
        },
      },
    });
    const row = screen.getByTestId("photo-row");
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    const entry = await screen.findByRole("button", {
      name: /^Normalise Metadata/,
    });
    fireEvent.click(entry);
    await screen.findByTestId("normalise-progress-dialog");
    await screen.findByTestId("normalise-group-keywords-checkbox");

    // Untick everything except Keywords to verify selection survives
    // through to the backend.
    fireEvent.click(screen.getByTestId("normalise-group-creator-checkbox"));
    fireEvent.click(screen.getByTestId("normalise-group-copyright-checkbox"));
    fireEvent.click(screen.getByTestId("normalise-group-headline-checkbox"));
    fireEvent.click(screen.getByTestId("normalise-group-title-checkbox"));
    fireEvent.click(screen.getByTestId("normalise-group-location-checkbox"));
    fireEvent.click(screen.getByTestId("normalise-group-dates-checkbox"));
    fireEvent.click(screen.getByTestId("normalise-group-description-checkbox"));

    fireEvent.click(screen.getByTestId("normalise-confirm-btn"));
    // Backend cmd resolves after a microtask + the event loop.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Backend received the final selection (Keywords only).
    expect(mockApiInstance.lastNormaliseArgs?.enabledGroups).toEqual([
      "keywords",
    ]);
    expect(mockApiInstance.lastNormaliseArgs?.items).toHaveLength(1);
    expect(mockApiInstance.lastNormaliseArgs?.items[0].relPath).toBe(
      "test.jpg",
    );

    // Done panel rendered.
    await waitFor(() => {
      expect(screen.getByTestId("normalise-done-summary")).toBeInTheDocument();
    });
    expect(screen.getByTestId("normalise-summary-breakdown")).toHaveTextContent(
      /Groups normalised \(deterministic\): 1/,
    );
    expect(
      screen.getByTestId("normalise-group-summary-keywords"),
    ).toHaveTextContent(/1 normalised/);
  });

  it("confirm button is disabled when no groups are enabled", async () => {
    await openFolderWithPhoto("test.jpg", {
      "XMP-dc:Subject": {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [{ kind: "Text", value: "A" }],
        },
      },
    });
    const row = screen.getByTestId("photo-row");
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    const entry = await screen.findByRole("button", {
      name: /^Normalise Metadata/,
    });
    fireEvent.click(entry);
    await screen.findByTestId("normalise-progress-dialog");
    await screen.findByTestId("normalise-group-keywords-checkbox");

    // Untick all eight (Description added in v2).
    for (const g of [
      "keywords",
      "creator",
      "copyright",
      "headline",
      "title",
      "location",
      "dates",
      "description",
    ]) {
      fireEvent.click(screen.getByTestId(`normalise-group-${g}-checkbox`));
    }
    const confirm = screen.getByTestId(
      "normalise-confirm-btn",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("cancelling from the confirm panel closes the dialog without invoking the backend", async () => {
    await openFolderWithPhoto("test.jpg", {});
    const row = screen.getByTestId("photo-row");
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    const entry = await screen.findByRole("button", {
      name: /^Normalise Metadata/,
    });
    fireEvent.click(entry);
    await screen.findByTestId("normalise-progress-dialog");
    // Wait for the estimate phase to transition to awaiting-confirm
    // before clicking the per-phase cancel button.
    await screen.findByTestId("normalise-cancel-btn");

    fireEvent.click(screen.getByTestId("normalise-cancel-btn"));
    await waitFor(() => {
      expect(screen.queryByTestId("normalise-progress-dialog")).toBeNull();
    });
    expect(mockApiInstance.lastNormaliseArgs).toBeNull();
  });
});
