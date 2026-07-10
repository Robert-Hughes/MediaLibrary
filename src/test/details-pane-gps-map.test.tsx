import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";

import { GpsMapOverview } from "../components/GpsMapOverview";
import { makePhoto, mockMetadata } from "./factories";
import type { MetadataDraftEdit } from "../types";
import { _clearTagInfoCache, _setTagInfoCacheEntry } from "../hooks/useTagInfo";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../components/GpsMap", () => ({
  GpsMap: ({
    lat,
    lon,
    zoom,
    showAttribution,
  }: {
    lat: number;
    lon: number;
    zoom?: number;
    showAttribution?: boolean;
  }) => (
    <div
      data-testid="gps-map"
      data-lat={lat}
      data-lon={lon}
      data-zoom={zoom}
      data-show-attribution={String(showAttribution)}
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
      _setTagInfoCacheEntry(tag, null);
    }
  });

  it("renders the map overview when a GPS section exists and coordinates resolve to valid values", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    render(
      <DetailsPane
        onSetMetadataDraftBatch={vi.fn()}
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
        onSetMetadataDraftBatch={vi.fn()}
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
        onSetMetadataDraftBatch={vi.fn()}
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
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        typedDraftEdits={typedDraftEdits}
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
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        typedDraftEdits={typedDraftEdits}
      />,
    );

    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
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
        onSetMetadataDraftBatch={vi.fn()}
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
