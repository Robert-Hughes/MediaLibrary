import { StrictMode } from "react";
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
  getZoom: vi.fn(() => 5),
  project: vi.fn(({ lat, lng }: { lat: number; lng: number }) => ({
    x: lng * 10,
    y: lat * 10,
    distanceTo(other: { x: number; y: number }) {
      return Math.hypot(this.x - other.x, this.y - other.y);
    },
  })),
};

const clusterGroupInstance = {
  addTo: vi.fn().mockReturnThis(),
  addLayers: vi.fn().mockReturnThis(),
  clearLayers: vi.fn().mockReturnThis(),
};

const markerInstances: Array<{
  addTo: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("leaflet", () => ({
  default: {
    map: vi.fn(() => mapInstance),
    tileLayer: vi.fn(() => ({ addTo: vi.fn().mockReturnThis() })),
    markerClusterGroup: vi.fn(() => clusterGroupInstance),
    latLng: vi.fn((lat: number, lng: number) => ({ lat, lng })),
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

vi.mock("leaflet.markercluster", () => ({}));

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
    expect(L.markerClusterGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        maxClusterRadius: 56,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
      }),
    );
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
    expect(clusterGroupInstance.addLayers).toHaveBeenCalledWith(
      markerInstances.map((marker) => marker),
    );
  });

  it("ignores Leaflet's transient cluster position when sizing the footprint", () => {
    render(<PhotoMap fitRequest={0} items={[]} />);

    const options = vi.mocked(L.markerClusterGroup).mock.calls[0][0];
    const createIcon = options?.iconCreateFunction;
    const cluster = {
      getChildCount: () => 3,
      getLatLng: () => ({ lat: 500, lng: 500 }),
      getAllChildMarkers: () => [
        { getLatLng: () => ({ lat: 5, lng: 5 }) },
        { getLatLng: () => ({ lat: 8, lng: 9 }) },
        { getLatLng: () => ({ lat: 2, lng: 1 }) },
      ],
    } as unknown as L.MarkerCluster;

    const icon = createIcon?.(cluster) as unknown as {
      html: string;
      iconSize: number[];
      iconAnchor: number[];
    };

    expect(icon.html).toContain('style="width:100px;height:100px"');
    expect(icon.html).toContain('aria-label="3 photos"');
    expect(icon.iconSize).toEqual([100, 100]);
    expect(icon.iconAnchor).toEqual([50, 50]);
  });

  it("keeps the count badge full-sized for photos at identical coordinates", () => {
    render(<PhotoMap fitRequest={0} items={[]} />);

    const createIcon = vi.mocked(L.markerClusterGroup).mock.calls[0][0]
      ?.iconCreateFunction;
    const cluster = {
      getChildCount: () => 2,
      getLatLng: () => ({ lat: 5, lng: 5 }),
      getAllChildMarkers: () => [
        { getLatLng: () => ({ lat: 5, lng: 5 }) },
        { getLatLng: () => ({ lat: 5, lng: 5 }) },
      ],
    } as unknown as L.MarkerCluster;

    const icon = createIcon?.(cluster) as unknown as {
      html: string;
      iconSize: number[];
    };

    expect(icon.html).toContain('style="width:0px;height:0px"');
    expect(icon.iconSize).toEqual([36, 36]);
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

  it("fits the real map instance after a Strict Mode effect replay", () => {
    render(
      <StrictMode>
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
        />
      </StrictMode>,
    );

    expect(L.map).toHaveBeenCalledTimes(2);
    expect(mapInstance.setView).toHaveBeenCalledTimes(2);
    expect(mapInstance.setView).toHaveBeenLastCalledWith([51.5, -0.12], 16, {
      animate: false,
    });
  });
});
