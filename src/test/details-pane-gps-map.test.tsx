import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import { makePhoto, mockMetadata } from "./factories";
import type { MetadataDraftEdit } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../components/GpsMap", () => ({
  GpsMap: ({ lat, lon }: { lat: number; lon: number }) => (
    <div data-testid="gps-map" data-lat={lat} data-lon={lon} />
  ),
}));

describe("DetailsPane GPS Map integration", () => {
  const photo = makePhoto({
    relative_path: "gps-photo.jpg",
    filename: "gps-photo.jpg",
  });

  beforeEach(() => {
    cleanup();
  });

  it("renders the map when a GPS section exists and coordinates resolve to valid values", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    render(<DetailsPane photo={photo} metadata={metadata} />);

    const map = screen.getByTestId("gps-map");
    expect(map).toBeInTheDocument();
    expect(map.getAttribute("data-lat")).toBe("51.5001");
    expect(map.getAttribute("data-lon")).toBe("-0.1262");
  });

  it("does not render the map when no GPS metadata/group exists", () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
    });

    render(<DetailsPane photo={photo} metadata={metadata} />);

    expect(screen.queryByTestId("gps-map")).not.toBeInTheDocument();
  });

  it("does not render the map when a GPS section exists but valid lat/lon cannot both be resolved", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitudeRef": "N", // No latitude/longitude values
    });

    render(<DetailsPane photo={photo} metadata={metadata} />);

    expect(screen.queryByTestId("gps-map")).not.toBeInTheDocument();
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
        photo={photo}
        metadata={metadata}
        typedDraftEdits={typedDraftEdits}
      />,
    );

    const map = screen.getByTestId("gps-map");
    expect(map).toBeInTheDocument();
    expect(map.getAttribute("data-lat")).toBe("48.8584");
    expect(map.getAttribute("data-lon")).toBe("2.2945");
  });

  it("removes/hides the map when typed GPS delete drafts make coordinates unavailable", () => {
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
        photo={photo}
        metadata={metadata}
        typedDraftEdits={typedDraftEdits}
      />,
    );

    expect(screen.queryByTestId("gps-map")).not.toBeInTheDocument();
  });

  it("verifies DOM order: GPS section heading, then map, then first GPS row", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    render(<DetailsPane photo={photo} metadata={metadata} />);

    const gpsSection = screen.getByTestId("details-section-GPS");
    expect(gpsSection).toBeInTheDocument();

    const heading = gpsSection.querySelector(".details-section-header");
    const map = gpsSection.querySelector('[data-testid="gps-map"]');
    const table = gpsSection.querySelector(".details-table");

    expect(heading).toBeInTheDocument();
    expect(map).toBeInTheDocument();
    expect(table).toBeInTheDocument();

    // Verify DOM order: heading is followed by map, followed by table
    const children = Array.from(gpsSection.childNodes);
    const headingIndex = children.indexOf(heading!);
    const mapIndex = children.indexOf(map!);
    const tableIndex = children.indexOf(table!);

    expect(headingIndex).toBeLessThan(mapIndex);
    expect(mapIndex).toBeLessThan(tableIndex);
  });
});
