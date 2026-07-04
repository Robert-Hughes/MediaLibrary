/**
 * End-to-end tests for the reverse-geocoding UI flow.
 *
 * Mirrors describe-flow.test.tsx in shape (single image, App-level
 * render, mocked Tauri invoke + listen). The geocode flow has no
 * estimate phase so it lands straight in awaiting-confirm.
 */
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto } from "./factories";
import type { Variant } from "../types";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: any) => mockApiInstance.api.invoke(cmd, args),
  convertFileSrc: (path: string) => `data:image/jpeg;base64,FAKE_${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (evt: string, handler: any) =>
    mockApiInstance.api.listen(evt, (payload: any) => handler({ payload })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

async function openFolderAndSelectPhoto(
  rel = "test.jpg",
  metadata: Record<string, Variant> = {},
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
  // Same flow as the describe tests: double-click the row to open
  // gallery view, then toggle the details pane on so the Reverse
  // Geocode button appears.
  const row = screen.getByTestId("photo-row");
  await user.dblClick(row);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const detailsToggle = screen.getByTestId("gallery-info-toggle");
  await user.click(detailsToggle);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
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

describe("Reverse-geocoding flow", () => {
  it("walks straight to awaiting-confirm (no estimate phase) and shows the warning copy", async () => {
    // Plan §4: the confirm panel must explicitly state which tags will be
    // written and that fields the geocoder doesn't return will be
    // cleared. Pin that copy here so a refactor doesn't quietly drop
    // it.
    const { user } = await openFolderAndSelectPhoto("test.jpg", {
      "Composite:GPSLatitude": 51.5001,
      "Composite:GPSLongitude": -0.1262,
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await screen.findByTestId("geocode-progress-dialog");
    await screen.findByTestId("geocode-confirm-btn");
    expect(screen.getByTestId("geocode-confirm-summary")).toHaveTextContent(
      /Nominatim/,
    );
    expect(screen.getByTestId("geocode-progress-dialog")).toHaveTextContent(
      /will be cleared/i,
    );
  });

  it("sends resolved lat/lon to the backend and merges returned edits into drafts", async () => {
    mockApiInstance.geocodeSchedule = [
      {
        relativePath: "test.jpg",
        status: "ok",
        edits: {
          "XMP-iptcCore:Location": {
            value: { type: "String", value: "Big Ben" },
            intent: "Set",
          },
          "XMP-photoshop:City": {
            value: { type: "String", value: "London" },
            intent: "Set",
          },
          "XMP-photoshop:State": { value: null, intent: "Delete" },
        },
      },
    ];
    mockApiInstance.geocodeSummary = {
      nSucceededFromNominatim: 1,
      nSucceededFromCache: 0,
      nSucceededFromOverpass: 0,
      nNoGps: 0,
      nFailed: 0,
    };

    const { user } = await openFolderAndSelectPhoto("test.jpg", {
      "Composite:GPSLatitude": 51.5001,
      "Composite:GPSLongitude": -0.1262,
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(await screen.findByTestId("geocode-confirm-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Backend got the resolved coords.
    expect(mockApiInstance.lastGeocodeArgs?.items[0]).toMatchObject({
      relPath: "test.jpg",
      lat: 51.5001,
      lon: -0.1262,
    });

    // Done panel rendered with the per-source breakdown.
    await screen.findByTestId("geocode-done-summary");
    expect(screen.getByTestId("geocode-summary-breakdown")).toHaveTextContent(
      /Nominatim/,
    );

    // Drafts merged into the in-memory store via setDraftBatch.
    const folderDrafts = mockApiInstance.draftEditsByFolder["/photos"];
    expect(folderDrafts?.["test.jpg"]?.["XMP-iptcCore:Location"]).toBeTruthy();
    expect(folderDrafts?.["test.jpg"]?.["XMP-photoshop:City"]).toBeTruthy();
    // Delete-intent drafts also land — they're how the coherent-
    // replacement rule from plan §1 is communicated to the apply
    // pipeline.
    expect(folderDrafts?.["test.jpg"]?.["XMP-photoshop:State"]).toBeTruthy();
  });

  it("renders no_gps failures in the done panel without crashing the flow", async () => {
    // Image has no GPS in metadata or drafts — frontend sends null/null,
    // backend (mock) emits no_gps for that item. The friendly label
    // must show "No GPS coordinates" so the user understands why it
    // was skipped.
    mockApiInstance.geocodeSchedule = [
      {
        relativePath: "test.jpg",
        status: "no_gps",
        error: "no GPS coordinates",
      },
    ];
    mockApiInstance.geocodeSummary = {
      nSucceededFromNominatim: 0,
      nSucceededFromCache: 0,
      nSucceededFromOverpass: 0,
      nNoGps: 1,
      nFailed: 0,
    };

    const { user } = await openFolderAndSelectPhoto("test.jpg", {});
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // Confirm panel reports the missing-GPS warning before run.
    expect(screen.getByTestId("geocode-no-gps-warning")).toHaveTextContent(
      /no GPS coordinates/i,
    );
    await user.click(await screen.findByTestId("geocode-confirm-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await screen.findByTestId("geocode-done-summary");
    expect(screen.getByTestId("geocode-failure-list")).toHaveTextContent(
      /No GPS coordinates/,
    );
  });

  it("Cancel before confirm closes the dialog and signals backend", async () => {
    const { user } = await openFolderAndSelectPhoto("test.jpg", {
      "Composite:GPSLatitude": 51.5,
      "Composite:GPSLongitude": -0.1,
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(await screen.findByTestId("geocode-cancel-btn"));
    expect(mockApiInstance.cancelGeocodeCalled).toBe(true);
    await waitFor(() => {
      expect(
        screen.queryByTestId("geocode-progress-dialog"),
      ).not.toBeInTheDocument();
    });
  });

  it("DetailsPane button surfaces the overwrite notice inside the dialog when existing location data is present", async () => {
    // The overwrite notice now lives in the dialog's awaiting-confirm
    // panel, not in a pre-dialog ask().
    const dialogModule = await import("@tauri-apps/plugin-dialog");
    const askMock = (
      dialogModule as unknown as { ask: ReturnType<typeof vi.fn> }
    ).ask;
    askMock.mockClear();
    const { user } = await openFolderAndSelectPhoto("test.jpg", {
      "Composite:GPSLatitude": 51.5,
      "Composite:GPSLongitude": -0.1,
      "XMP-iptcCore:Location": "Existing Place",
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    expect(askMock).not.toHaveBeenCalled();
    const notice = await screen.findByTestId("geocode-overwrite-notice");
    expect(notice).toHaveTextContent(/Overwrite location data\?/);
    expect(notice).toHaveTextContent(/already has location data/i);
    expect(notice).toHaveTextContent(/will be cleared/i);
  });

  it("DetailsPane button shows no overwrite notice when there is no existing location data", async () => {
    const { user } = await openFolderAndSelectPhoto("test.jpg", {
      "Composite:GPSLatitude": 51.5,
      "Composite:GPSLongitude": -0.1,
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await screen.findByTestId("geocode-confirm-btn");
    expect(screen.queryByTestId("geocode-overwrite-notice")).toBeNull();
  });
});
