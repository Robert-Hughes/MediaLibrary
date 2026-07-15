import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";

import { GpsMapOverview } from "../components/GpsMapOverview";
import {
  makePhoto,
  mockDrafts,
  mockMetadata,
  testFriendlyName,
} from "./factories";
import type {
  MetadataDraftCollection,
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataOccurrence,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { buildGeocodeRequestItemForFile } from "../utils/effectiveGps";
import { GPS_IDS } from "../metadata/knownIds";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../components/GpsMap", () => ({
  GpsMap: ({
    position,
    zoom,
    mode,
    showAttribution,
    readOnly,
  }: {
    position: { lat: number; lon: number } | null;
    zoom?: number;
    mode?: "static" | "picker";
    showAttribution?: boolean;
    readOnly?: boolean;
  }) => (
    <div
      data-testid="gps-map"
      data-lat={position ? String(position.lat) : ""}
      data-lon={position ? String(position.lon) : ""}
      data-zoom={zoom}
      data-mode={mode}
      data-show-attribution={String(showAttribution)}
      data-readonly={String(readOnly)}
    />
  ),
}));

describe("DetailsPane GPS Map integration", () => {
  const photo = makePhoto({
    relative_path: "gps-photo.jpg",
    filename: "gps-photo.jpg",
  });

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
    const commonTags = [
      "GPS:GPSLatitude",
      "GPS:GPSLongitude",
      "GPS:GPSLatitudeRef",
      "GPS:GPSLongitudeRef",
      "IFD0:Make",
    ];
    for (const tag of commonTags) {
      const colon = tag.indexOf(":");
      _setTagInfoCacheEntry(tag, {
        group: tag.slice(0, colon),
        name: tag.slice(colon + 1),
        writable: true,
        kind: { kind: "Text" },
        description: null,
      });
    }
  });

  function occurrencesFor(
    metadata: ReturnType<typeof mockMetadata>,
  ): MetadataOccurrence[] {
    return Object.values(metadata).map((entry) => {
      const { id, ...value } = entry;
      const friendly = testFriendlyName(id);
      const separator = friendly.indexOf(":");
      const group = friendly.slice(0, separator);
      const name = friendly.slice(separator + 1);
      return {
        id: {
          document: null,
          path: `JPEG-APP1-GPS-${id.tag_id}`,
          tag_id: id.tag_id,
          copy: 0,
        },
        value,
        tag_info: {
          id,
          group,
          name,
          writable: true,
          kind: { kind: value.kind } as any,
          description: null,
        },
        write_target: { group1: group, tag_name: name },
      };
    });
  }

  it("renders the map overview when a GPS section exists and coordinates resolve to valid values", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
      />,
    );

    const overview = screen.getByTestId("gps-map-overview");
    expect(overview).toBeInTheDocument();

    const maps = screen.getAllByTestId("gps-map");
    expect(maps).toHaveLength(4);
    for (const map of maps) {
      expect(map.getAttribute("data-lat")).toBe("51.5001");
      expect(map.getAttribute("data-lon")).toBe("-0.1262");
    }
  });

  it("does not render the map overview when no GPS metadata/group exists", () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
    });

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
      />,
    );

    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gps-map")).not.toBeInTheDocument();
  });

  it("does not render the map overview when a GPS section exists but valid lat/lon cannot both be resolved", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitudeRef": "N", // No latitude/longitude values
    });

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
      />,
    );

    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
  });

  it("uses typed draft GPS values over metadata values", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    const typedDraftEdits: Record<string, MetadataDraftEdit> = {
      "GPS:GPSLatitude": {
        intent: "Set",
        value: { kind: "Real", value: 48.8584 },
      },
      "GPS:GPSLongitude": {
        intent: "Set",
        value: { kind: "Real", value: 2.2945 },
      },
      "GPS:GPSLongitudeRef": {
        intent: "Set",
        value: { kind: "Text", value: "E" },
      },
    };

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        typedDraftEdits={mockDrafts(typedDraftEdits)}
      />,
    );

    const overview = screen.getByTestId("gps-map-overview");
    expect(overview).toBeInTheDocument();

    const maps = screen.getAllByTestId("gps-map");
    expect(maps).toHaveLength(4);
    for (const map of maps) {
      expect(map.getAttribute("data-lat")).toBe("48.8584");
      expect(map.getAttribute("data-lon")).toBe("2.2945");
    }
  });

  it("removes/hides the map overview when typed GPS delete drafts make coordinates unavailable", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    const typedDraftEdits: Record<string, MetadataDraftEdit> = {
      "GPS:GPSLatitude": {
        intent: "Delete",
        value: null,
      },
    };

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        typedDraftEdits={mockDrafts(typedDraftEdits)}
      />,
    );

    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
  });

  it("moves the marker for exact v5 GPS drafts and hides it for an exact Delete", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": 0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });
    const occurrences = occurrencesFor(metadata);
    const latitude = occurrences.find(
      (item) => item.tag_info?.name === "GPSLatitude",
    )!;
    const longitude = occurrences.find(
      (item) => item.tag_info?.name === "GPSLongitude",
    )!;
    const latitudeTarget = existingOccurrenceTargetFromOccurrence(latitude);
    const longitudeTarget = existingOccurrenceTargetFromOccurrence(longitude);
    if (
      latitudeTarget.kind !== "targetable" ||
      longitudeTarget.kind !== "targetable"
    ) {
      throw new Error("test GPS occurrences must be targetable");
    }
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch(photo.relative_path, [
      {
        target: latitudeTarget.target,
        edit: { intent: "Set", value: { kind: "Real", value: 48.8584 } },
      },
      {
        target: longitudeTarget.target,
        edit: { intent: "Set", value: { kind: "Real", value: 2.2945 } },
      },
    ]);
    const baseProps = {
      onRemoveMetadataFieldsV5: vi.fn(),
      onSetGpsTargetDraftBatch: vi.fn(() => true),
      onDiscardDraftBatch: vi.fn(),
      photo,
      metadata,
      occurrences,
    };
    const rendered = render(
      <DetailsPane
        {...baseProps}
        targetDraftEdits={store.getMetadataFile(photo.relative_path)}
      />,
    );
    for (const map of screen.getAllByTestId("gps-map")) {
      expect(map).toHaveAttribute("data-lat", "48.8584");
      expect(map).toHaveAttribute("data-lon", "-2.2945");
    }

    store.setMetadataTarget(photo.relative_path, latitudeTarget.target, {
      intent: "Delete",
      value: null,
    });
    rendered.rerender(
      <DetailsPane
        {...baseProps}
        targetDraftEdits={store.getMetadataFile(photo.relative_path)}
      />,
    );
    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
  });

  it("keeps map-visible and generated geocode coordinates equivalent across draft states", () => {
    const baseMetadata = () =>
      mockMetadata({
        "GPS:GPSLatitude": 51,
        "GPS:GPSLatitudeRef": "N",
        "GPS:GPSLongitude": 1,
        "GPS:GPSLongitudeRef": "E",
        "Composite:GPSLatitude": 51,
        "Composite:GPSLongitude": 1,
      });
    const exactEntry = (
      occurrence: MetadataOccurrence,
      edit: MetadataDraftEdit,
    ): MetadataDraftEntryV5 => {
      const target = existingOccurrenceTargetFromOccurrence(occurrence);
      if (target.kind !== "targetable") throw new Error(target.reason);
      return { target: target.target, edit };
    };
    const targetCollection = (
      ...entries: MetadataDraftEntryV5[]
    ): TargetDraftCollection =>
      Object.fromEntries(entries.map((entry, index) => [String(index), entry]));
    const find = (occurrences: MetadataOccurrence[], tagId: string) =>
      occurrences.find((item) => item.tag_info?.id.tag_id === tagId)!;

    const noDraftMetadata = baseMetadata();
    const noDraftOccurrences = occurrencesFor(noDraftMetadata);

    const v4Metadata = baseMetadata();
    const v4Occurrences = occurrencesFor(v4Metadata);
    const v4Drafts = mockDrafts({
      "GPS:GPSLatitude": 48,
      "GPS:GPSLongitude": 2,
      "GPS:GPSLongitudeRef": "W",
    });

    const v5Metadata = baseMetadata();
    const v5Occurrences = occurrencesFor(v5Metadata);
    const v5Targets = targetCollection(
      exactEntry(find(v5Occurrences, GPS_IDS.latitude.tag_id), {
        intent: "Set",
        value: { kind: "Real", value: 52 },
      }),
      exactEntry(find(v5Occurrences, GPS_IDS.longitude.tag_id), {
        intent: "Set",
        value: { kind: "Real", value: 2 },
      }),
      exactEntry(find(v5Occurrences, GPS_IDS.longitudeRef.tag_id), {
        intent: "Set",
        value: { kind: "Text", value: "W" },
      }),
    );

    const missingRefMetadata = mockMetadata({
      "GPS:GPSLatitude": 51,
      "GPS:GPSLongitude": 1,
    });
    const missingRefOccurrences = occurrencesFor(missingRefMetadata);
    const missingRefTargets = targetCollection(
      {
        target: { kind: "NewProperty", schema_id: GPS_IDS.latitudeRef },
        edit: { intent: "Set", value: { kind: "Text", value: "S" } },
      },
      {
        target: { kind: "NewProperty", schema_id: GPS_IDS.longitudeRef },
        edit: { intent: "Set", value: { kind: "Text", value: "W" } },
      },
    );

    const refMetadata = baseMetadata();
    const refOccurrences = occurrencesFor(refMetadata);
    const refTargets = targetCollection(
      exactEntry(find(refOccurrences, GPS_IDS.latitudeRef.tag_id), {
        intent: "Set",
        value: { kind: "Text", value: "S" },
      }),
      exactEntry(find(refOccurrences, GPS_IDS.longitudeRef.tag_id), {
        intent: "Set",
        value: { kind: "Text", value: "W" },
      }),
    );

    const deleteMetadata = baseMetadata();
    const deleteOccurrences = occurrencesFor(deleteMetadata);
    const deleteTargets = targetCollection(
      exactEntry(find(deleteOccurrences, GPS_IDS.latitude.tag_id), {
        intent: "Delete",
        value: null,
      }),
    );

    const staleMetadata = baseMetadata();
    const staleOccurrences = occurrencesFor(staleMetadata);
    const stale = exactEntry(find(staleOccurrences, GPS_IDS.latitude.tag_id), {
      intent: "Set",
      value: { kind: "Real", value: 60 },
    });
    if (stale.target.kind !== "ExistingOccurrence") {
      throw new Error("Expected ExistingOccurrence target");
    }
    stale.target = {
      ...stale.target,
      occurrence_id: { ...stale.target.occurrence_id, copy: 99 },
    };

    const multipleMetadata = baseMetadata();
    const multipleOccurrences = occurrencesFor(multipleMetadata);
    const latitude = find(multipleOccurrences, GPS_IDS.latitude.tag_id);
    multipleOccurrences.push({
      ...structuredClone(latitude),
      id: { ...latitude.id, copy: 1 },
      value: { kind: "Real", value: 70 },
    });
    const multipleTargets = targetCollection(
      exactEntry(latitude, {
        intent: "Set",
        value: { kind: "Real", value: 60 },
      }),
    );

    const mixedMetadata = baseMetadata();
    const mixedOccurrences = occurrencesFor(mixedMetadata);
    const mixedLegacy = mockDrafts({ "GPS:GPSLatitude": 53 });
    const mixedTargets = targetCollection(
      exactEntry(find(mixedOccurrences, GPS_IDS.latitude.tag_id), {
        intent: "Set",
        value: { kind: "Real", value: 60 },
      }),
      exactEntry(find(mixedOccurrences, GPS_IDS.longitude.tag_id), {
        intent: "Set",
        value: { kind: "Real", value: 2 },
      }),
    );

    const scenarios: Array<{
      name: string;
      metadata: ReturnType<typeof mockMetadata>;
      occurrences: MetadataOccurrence[];
      legacyDrafts?: MetadataDraftCollection;
      targetDrafts?: TargetDraftCollection;
      expected: { lat: number | null; lon: number | null };
    }> = [
      {
        name: "no drafts",
        metadata: noDraftMetadata,
        occurrences: noDraftOccurrences,
        expected: { lat: 51, lon: 1 },
      },
      {
        name: "v4 coordinate drafts",
        metadata: v4Metadata,
        occurrences: v4Occurrences,
        legacyDrafts: v4Drafts,
        expected: { lat: 48, lon: -2 },
      },
      {
        name: "v5 existing-coordinate drafts",
        metadata: v5Metadata,
        occurrences: v5Occurrences,
        targetDrafts: v5Targets,
        expected: { lat: 52, lon: -2 },
      },
      {
        name: "v5 missing-reference NewProperty drafts",
        metadata: missingRefMetadata,
        occurrences: missingRefOccurrences,
        targetDrafts: missingRefTargets,
        expected: { lat: -51, lon: -1 },
      },
      {
        name: "southern/western reference drafts",
        metadata: refMetadata,
        occurrences: refOccurrences,
        targetDrafts: refTargets,
        expected: { lat: -51, lon: -1 },
      },
      {
        name: "v5 coordinate Delete",
        metadata: deleteMetadata,
        occurrences: deleteOccurrences,
        targetDrafts: deleteTargets,
        expected: { lat: null, lon: null },
      },
      {
        name: "stale v5 target",
        metadata: staleMetadata,
        occurrences: staleOccurrences,
        targetDrafts: targetCollection(stale),
        expected: { lat: 51, lon: 1 },
      },
      {
        name: "multiply-resolved GPS",
        metadata: multipleMetadata,
        occurrences: multipleOccurrences,
        targetDrafts: multipleTargets,
        expected: { lat: 51, lon: 1 },
      },
      {
        name: "mixed legacy/v5 ownership",
        metadata: mixedMetadata,
        occurrences: mixedOccurrences,
        legacyDrafts: mixedLegacy,
        targetDrafts: mixedTargets,
        expected: { lat: 53, lon: 2 },
      },
    ];

    for (const scenario of scenarios) {
      cleanup();
      const item = buildGeocodeRequestItemForFile(photo.relative_path, {
        metadata: scenario.metadata,
        occurrences: scenario.occurrences,
        legacyDrafts: scenario.legacyDrafts,
        targetDrafts: scenario.targetDrafts,
      });
      expect(item, scenario.name).toEqual({
        relPath: photo.relative_path,
        ...scenario.expected,
      });

      render(
        <DetailsPane
          onRemoveMetadataFieldsV5={vi.fn()}
          onSetGpsTargetDraftBatch={vi.fn(() => true)}
          onDiscardDraftBatch={vi.fn()}
          photo={photo}
          metadata={scenario.metadata}
          occurrences={scenario.occurrences}
          typedDraftEdits={scenario.legacyDrafts}
          targetDraftEdits={scenario.targetDrafts}
        />,
      );
      if (scenario.expected.lat === null || scenario.expected.lon === null) {
        expect(
          screen.queryByTestId("gps-map-overview"),
          scenario.name,
        ).not.toBeInTheDocument();
      } else {
        const maps = screen.getAllByTestId("gps-map");
        expect(maps, scenario.name).toHaveLength(4);
        for (const map of maps) {
          expect(map, scenario.name).toHaveAttribute(
            "data-lat",
            String(item.lat),
          );
          expect(map, scenario.name).toHaveAttribute(
            "data-lon",
            String(item.lon),
          );
        }
      }
    }
  });

  it("keeps map and geocode at zero while the editor preserves S/W references", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 0,
      "GPS:GPSLatitudeRef": "S",
      "GPS:GPSLongitude": 0,
      "GPS:GPSLongitudeRef": "W",
    });
    const occurrences = occurrencesFor(metadata);
    const geocodeItem = buildGeocodeRequestItemForFile(photo.relative_path, {
      metadata,
      occurrences,
      legacyDrafts: undefined,
      targetDrafts: undefined,
    });

    expect(geocodeItem.lat === 0).toBe(true);
    expect(geocodeItem.lon === 0).toBe(true);

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onSetGpsTargetDraftBatch={vi.fn(() => true)}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        occurrences={occurrences}
      />,
    );

    for (const map of screen.getAllByTestId("gps-map")) {
      expect(map).toHaveAttribute("data-lat", "0");
      expect(map).toHaveAttribute("data-lon", "0");
    }

    const latitudeRow = screen
      .getAllByTestId("details-row")
      .find((row) => within(row).queryByText("GPSLatitude") !== null);
    expect(latitudeRow).toBeDefined();
    fireEvent.contextMenu(latitudeRow!);
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));

    expect(await screen.findByTestId("gps-editor-lat-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");
  });

  it("verifies DOM order: GPS section heading, then map overview, then first GPS row", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
      />,
    );

    const gpsSection = screen.getByTestId("details-section-GPS");
    expect(gpsSection).toBeInTheDocument();

    const heading = gpsSection.querySelector(".details-section-header");
    const overview = gpsSection.querySelector(
      '[data-testid="gps-map-overview"]',
    );
    const table = gpsSection.querySelector(".details-table");

    expect(heading).toBeInTheDocument();
    expect(overview).toBeInTheDocument();
    expect(table).toBeInTheDocument();

    // Verify DOM order: heading is followed by overview, followed by table
    const children = Array.from(gpsSection.childNodes);
    const headingIndex = children.indexOf(heading!);
    const overviewIndex = children.indexOf(overview!);
    const tableIndex = children.indexOf(table!);

    expect(headingIndex).toBeLessThan(overviewIndex);
    expect(overviewIndex).toBeLessThan(tableIndex);
  });
});

describe("GpsMapOverview component", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders four GpsMap components with correct props", () => {
    render(<GpsMapOverview lat={34.0522} lon={-118.2437} />);

    const maps = screen.getAllByTestId("gps-map");
    expect(maps).toHaveLength(4);

    // Verify World map
    expect(maps[0].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[0].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[0].getAttribute("data-zoom")).toBe("1");
    expect(maps[0].getAttribute("data-show-attribution")).toBe("false");

    // Verify Country map
    expect(maps[1].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[1].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[1].getAttribute("data-zoom")).toBe("4");
    expect(maps[1].getAttribute("data-show-attribution")).toBe("false");

    // Verify City map
    expect(maps[2].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[2].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[2].getAttribute("data-zoom")).toBe("8");
    expect(maps[2].getAttribute("data-show-attribution")).toBe("false");

    // Verify Local map
    expect(maps[3].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[3].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[3].getAttribute("data-zoom")).toBe("16");
    expect(maps[3].getAttribute("data-show-attribution")).toBe("false");

    // Verify separate attribution row
    expect(screen.getByText(/OpenStreetMap/)).toBeInTheDocument();
  });
});
