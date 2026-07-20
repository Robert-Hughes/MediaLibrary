import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import L from "leaflet";
import { PhotoMap } from "../components/PhotoMap";

const mapInstance = {
  on: vi.fn().mockReturnThis(),
  off: vi.fn().mockReturnThis(),
  remove: vi.fn(),
  invalidateSize: vi.fn(),
  setView: vi.fn().mockReturnThis(),
  fitBounds: vi.fn().mockReturnThis(),
};

const markerInstances: Array<{
  addTo: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("leaflet", () => ({
  default: {
    map: vi.fn(() => mapInstance),
    tileLayer: vi.fn(() => ({ addTo: vi.fn().mockReturnThis() })),
    marker: vi.fn(() => {
      const marker = {
        addTo: vi.fn().mockReturnThis(),
        remove: vi.fn(),
      };
      markerInstances.push(marker);
      return marker;
    }),
    divIcon: vi.fn((options) => options),
    latLngBounds: vi.fn((points) => ({ points })),
  },
}));

describe("PhotoMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    markerInstances.length = 0;
  });

  afterEach(() => cleanup());

  it("renders non-interactive thumbnail markers and fits all locations", () => {
    render(
      <PhotoMap
        fitRequest={0}
        items={[
          {
            relativePath: "east.jpg",
            lat: 10,
            lon: 179,
            thumbnail: "EAST",
          },
          {
            relativePath: "west.jpg",
            lat: 11,
            lon: -179,
            thumbnail: "WEST",
          },
        ]}
      />,
    );

    expect(L.marker).toHaveBeenCalledTimes(2);
    expect(L.marker).toHaveBeenNthCalledWith(
      1,
      [10, 179],
      expect.objectContaining({ interactive: false, keyboard: false }),
    );
    expect(L.marker).toHaveBeenNthCalledWith(
      2,
      [11, 181],
      expect.objectContaining({ interactive: false, keyboard: false }),
    );
    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ padding: [64, 64], maxZoom: 16 }),
    );
  });

  it("centres a single photo at local zoom", () => {
    render(
      <PhotoMap
        fitRequest={0}
        items={[
          {
            relativePath: "one.jpg",
            lat: 51.5,
            lon: -0.12,
            thumbnail: "loading",
          },
        ]}
      />,
    );

    expect(mapInstance.setView).toHaveBeenCalledWith([51.5, -0.12], 16, {
      animate: false,
    });
  });
});
