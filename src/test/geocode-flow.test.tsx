/**
 * End-to-end tests for the reverse-geocoding UI flow.
 *
 * Mirrors describe-flow.test.tsx in shape (single image, App-level
 * render, mocked Tauri invoke + listen). The geocode flow has no
 * estimate phase so it lands straight in awaiting-confirm.
 */
import {
  render,
  screen,
  act,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { createMockTauriApi } from "./mockTauriApi";
import { makeFile, mockGeneratedDraftEntries } from "./factories";
import type {
  MetadataDraftEdit,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { GPS_IDS } from "../metadata/knownIds";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { TargetDraftEditsStore } from "../targetDraftEdits";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

function singletonList(value: MetadataValue): MetadataValue {
  return { kind: "List", value: { list_kind: "Bag", items: [value] } };
}

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
vi.mock("../components/GpsMap", () => ({
  GpsMap: ({ position }: { position: { lat: number; lon: number } | null }) => (
    <div
      data-testid="gps-map"
      data-lat={position === null ? "" : String(position.lat)}
      data-lon={position === null ? "" : String(position.lon)}
    />
  ),
}));

function gpsOccurrence(
  id: SchemaDefinitionId,
  value: MetadataValue,
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: `JPEG-APP1-GPS-${id.tag_id}`,
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
      copy: 0,
    },
    schema_id: structuredClone(id),
    value,
    tag_info: {
      id,
      group: "GPS",
      name: id.tag_id,
      writable: true,
      kind: { kind: value.kind } as never,
      description: null,
    },
    observed_selector: {
      group1: "GPS",
      group7: "ID-Test",
      tag_name: id.tag_id,
    },
    write_target: { group1: "GPS", group7: "ID-Test", tag_name: id.tag_id },
  };
}

function rawGpsOccurrences(): MetadataOccurrence[] {
  return [
    gpsOccurrence(GPS_IDS.latitude, { kind: "Real", value: 51 }),
    gpsOccurrence(GPS_IDS.latitudeRef, { kind: "Text", value: "N" }),
    gpsOccurrence(GPS_IDS.longitude, { kind: "Real", value: 0 }),
    gpsOccurrence(GPS_IDS.longitudeRef, { kind: "Text", value: "E" }),
  ];
}

function rawGpsMetadata(): Record<string, MetadataValue> {
  return {
    "GPS:GPSLatitude": { kind: "Real", value: 51 },
    "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
    "GPS:GPSLongitude": { kind: "Real", value: 0 },
    "GPS:GPSLongitudeRef": { kind: "Text", value: "E" },
  };
}

function seedExistingGpsTargets(
  rel: string,
  occurrences: MetadataOccurrence[],
  edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
) {
  const store = new TargetDraftEditsStore();
  store.setMetadataBatch(
    rel,
    edits.map(({ id, edit }) => {
      const current = occurrences.find(
        (item) =>
          item.tag_info?.id === id || item.tag_info?.id.tag_id === id.tag_id,
      );
      if (!current) throw new Error(`Missing test occurrence ${id.tag_id}`);
      const target = existingOccurrenceTargetFromOccurrence(current);
      if (target.kind !== "targetable") throw new Error(target.reason);
      return { target: target.target, edit };
    }),
  );
  mockApiInstance.targetDraftEditsByFolder["/files"] = store.getAllMetadata();
}

async function openFolderAndSelectFile(
  rel = "test.jpg",
  metadata: Record<string, MetadataValue> = {},
  occurrences?: MetadataOccurrence[],
) {
  const file = makeFile({ relative_path: rel });
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/files");
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await user.click(screen.getByTestId("open-folder-btn"));
  await act(async () => {
    mockApiInstance.emitFileFound(file);
  });
  await act(async () => {
    mockApiInstance.emitScanComplete();
  });
  await act(async () => {
    mockApiInstance.emitFileMetadataReady(
      rel,
      metadata,
      undefined,
      occurrences,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
  const row = screen.getByTestId("file-row");
  await user.dblClick(row);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const detailsToggle = screen.getByTestId("gallery-info-toggle");
  await user.click(detailsToggle);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return { user, file };
}
function expectMapCoordinates(lat: number, lon: number) {
  const maps = screen.getAllByTestId("gps-map");
  expect(maps).toHaveLength(4);
  for (const map of maps) {
    expect(map).toHaveAttribute("data-lat", String(lat));
    expect(map).toHaveAttribute("data-lon", String(lon));
  }
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
    // Pin the two evidence targets and Normalize guidance.
    const { user } = await openFolderAndSelectFile("test.jpg", {
      "GPS:GPSLatitude": { kind: "Real", value: 51.5001 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
      "GPS:GPSLongitude": { kind: "Real", value: 0.1262 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "W" },
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
      /XMP-mlib:ReverseGeocodeGeocodeJSON/i,
    );
    expect(screen.getByTestId("geocode-progress-dialog")).toHaveTextContent(
      /Normalise Location/i,
    );
  });

  it("sends resolved lat/lon and stages returned edits as exact target-aware targets", async () => {
    mockApiInstance.geocodeSchedule = [
      {
        relativePath: "test.jpg",
        status: "ok",
        edits: mockGeneratedDraftEntries({
          "XMP-mlib:ReverseGeocodeGeocodeJSON": {
            value: {
              kind: "Text",
              value: '{"features":[]}',
            },
            intent: "Set",
          },
          "XMP-mlib:ReverseGeocodeJSONv2": {
            value: {
              kind: "Text",
              value: '{"display_name":"Big Ben, London"}',
            },
            intent: "Set",
          },
        }),
      },
    ];
    mockApiInstance.geocodeSummary = {
      nSucceededFromNominatim: 1,
      nSucceededFromCache: 0,
      nNoGps: 0,
      nFailed: 0,
    };

    const { user } = await openFolderAndSelectFile("test.jpg", {
      "GPS:GPSLatitude": { kind: "Real", value: 51.5001 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
      "GPS:GPSLongitude": { kind: "Real", value: 0.1262 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "W" },
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

    // Both exact response bodies are staged in the target-aware store.
    const targetDrafts =
      mockApiInstance.targetDraftEditsByFolder["/files"]?.["test.jpg"] ?? {};
    expect(
      Object.values(targetDrafts).some(
        ({ target }) => target.schema_id.tag_id === "ReverseGeocodeGeocodeJSON",
      ),
    ).toBe(true);
    expect(
      Object.values(targetDrafts).some(
        ({ target }) => target.schema_id.tag_id === "ReverseGeocodeJSONv2",
      ),
    ).toBe(true);
    expect(Object.values(targetDrafts)).toHaveLength(2);
  });

  it("sends raw GPS Real longitude with W ref as negative to the backend", async () => {
    mockApiInstance.geocodeSchedule = [
      {
        relativePath: "test.jpg",
        status: "ok",
        edits: [],
      },
    ];
    mockApiInstance.geocodeSummary = {
      nSucceededFromNominatim: 1,
      nSucceededFromCache: 0,
      nNoGps: 0,
      nFailed: 0,
    };

    const { user } = await openFolderAndSelectFile("test.jpg", {
      "GPS:GPSLatitude": { kind: "Real", value: 53.983856 },
      "GPS:GPSLatitudeRef": singletonList({ kind: "Text", value: "N" }),
      "GPS:GPSLongitude": { kind: "Real", value: 1.100918 },
      "GPS:GPSLongitudeRef": singletonList({ kind: "Text", value: "W" }),
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(await screen.findByTestId("geocode-confirm-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockApiInstance.lastGeocodeArgs?.items[0]).toMatchObject({
      relPath: "test.jpg",
      lat: 53.983856,
      lon: -1.100918,
    });
  });

  it("sends target-aware staged coordinates from the FileList selection action", async () => {
    const rel = "list-target.jpg";
    const occurrences = rawGpsOccurrences();
    seedExistingGpsTargets(rel, occurrences, [
      {
        id: GPS_IDS.latitude,
        edit: { intent: "Set", value: { kind: "Real", value: 52 } },
      },
      {
        id: GPS_IDS.longitude,
        edit: { intent: "Set", value: { kind: "Real", value: 1 } },
      },
      {
        id: GPS_IDS.longitudeRef,
        edit: { intent: "Set", value: { kind: "Text", value: "W" } },
      },
    ]);
    const { user } = await openFolderAndSelectFile(
      rel,
      rawGpsMetadata(),
      occurrences,
    );
    await user.click(screen.getByTestId("gallery-close-btn"));
    const row = screen.getByTestId("file-row");
    await user.click(row);
    fireEvent.contextMenu(row);
    await user.click(
      await screen.findByRole("button", { name: "Reverse Geocode…" }),
    );
    await user.click(await screen.findByTestId("geocode-confirm-btn"));

    await waitFor(() => {
      expect(mockApiInstance.lastGeocodeArgs?.items[0]).toEqual({
        relPath: rel,
        lat: 52,
        lon: -1,
      });
    });
  });

  it("keeps the Gallery map and geocode payload equivalent for a target-aware Delete", async () => {
    const rel = "gallery-delete.jpg";
    const occurrences = rawGpsOccurrences();
    seedExistingGpsTargets(rel, occurrences, [
      {
        id: GPS_IDS.latitude,
        edit: { intent: "Delete", value: null },
      },
    ]);
    const { user } = await openFolderAndSelectFile(
      rel,
      rawGpsMetadata(),
      occurrences,
    );
    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await user.click(await screen.findByTestId("geocode-confirm-btn"));

    await waitFor(() => {
      expect(mockApiInstance.lastGeocodeArgs?.items[0]).toEqual({
        relPath: rel,
        lat: null,
        lon: null,
      });
    });
  });

  it("keeps the Gallery map and geocode payload equivalent for target-aware reference changes", async () => {
    const rel = "gallery-ref.jpg";
    const occurrences = rawGpsOccurrences();
    occurrences[2] = gpsOccurrence(GPS_IDS.longitude, {
      kind: "Real",
      value: 1,
    });
    seedExistingGpsTargets(rel, occurrences, [
      {
        id: GPS_IDS.latitudeRef,
        edit: { intent: "Set", value: { kind: "Text", value: "S" } },
      },
      {
        id: GPS_IDS.longitudeRef,
        edit: { intent: "Set", value: { kind: "Text", value: "W" } },
      },
    ]);
    const metadata = rawGpsMetadata();
    metadata["GPS:GPSLongitude"] = { kind: "Real", value: 1 };
    const { user } = await openFolderAndSelectFile(rel, metadata, occurrences);
    expectMapCoordinates(-51, -1);
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await user.click(await screen.findByTestId("geocode-confirm-btn"));

    await waitFor(() => {
      expect(mockApiInstance.lastGeocodeArgs?.items[0]).toEqual({
        relPath: rel,
        lat: -51,
        lon: -1,
      });
    });
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
      nNoGps: 1,
      nFailed: 0,
    };

    const { user } = await openFolderAndSelectFile("test.jpg", {});
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
    const { user } = await openFolderAndSelectFile("test.jpg", {
      "GPS:GPSLatitude": { kind: "Real", value: 51.5 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
      "GPS:GPSLongitude": { kind: "Real", value: 0.1 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "W" },
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

  it("DetailsPane button surfaces the overwrite notice when reverse-geocode evidence exists", async () => {
    // The overwrite notice now lives in the dialog's awaiting-confirm
    // panel, not in a pre-dialog ask().
    const dialogModule = await import("@tauri-apps/plugin-dialog");
    const askMock = (
      dialogModule as unknown as { ask: ReturnType<typeof vi.fn> }
    ).ask;
    askMock.mockClear();
    const { user } = await openFolderAndSelectFile("test.jpg", {
      "GPS:GPSLatitude": { kind: "Real", value: 51.5 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
      "GPS:GPSLongitude": { kind: "Real", value: 0.1 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "W" },
      "XMP-mlib:ReverseGeocodeGeocodeJSON": {
        kind: "Text",
        value: '{"features":[]}',
      },
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    expect(askMock).not.toHaveBeenCalled();
    const notice = await screen.findByTestId("geocode-overwrite-notice");
    expect(notice).toHaveTextContent(/Overwrite reverse-geocode evidence\?/);
    expect(notice).toHaveTextContent(/already has reverse-geocode evidence/i);
    expect(notice).toHaveTextContent(/replace the GeocodeJSON and JSONv2/i);
  });

  it("DetailsPane button shows no overwrite notice when there is no existing location data", async () => {
    const { user } = await openFolderAndSelectFile("test.jpg", {
      "GPS:GPSLatitude": { kind: "Real", value: 51.5 },
      "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
      "GPS:GPSLongitude": { kind: "Real", value: 0.1 },
      "GPS:GPSLongitudeRef": { kind: "Text", value: "W" },
    });
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    await screen.findByTestId("geocode-confirm-btn");
    expect(screen.queryByTestId("geocode-overwrite-notice")).toBeNull();
  });
});
