import { render, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GpsMap } from "../components/GpsMap";
import L from "leaflet";

// Mock Leaflet classes and methods
const mockMapInstance = {
  setView: vi.fn().mockReturnThis(),
  invalidateSize: vi.fn(),
  remove: vi.fn(),
  on: vi.fn().mockReturnThis(),
  off: vi.fn().mockReturnThis(),
  getBounds: vi.fn().mockReturnValue({
    contains: vi.fn().mockReturnValue(true),
  }),
  panTo: vi.fn().mockReturnThis(),
  getCenter: vi.fn().mockReturnValue({ lat: 0, lng: 0 }),
};

const mockMarkerInstance = {
  addTo: vi.fn().mockReturnThis(),
  setLatLng: vi.fn().mockReturnThis(),
  remove: vi.fn(),
};

vi.mock("leaflet", () => {
  return {
    default: {
      map: vi.fn(() => mockMapInstance),
      tileLayer: vi.fn().mockReturnValue({
        addTo: vi.fn().mockReturnThis(),
      }),
      marker: vi.fn(() => mockMarkerInstance),
      divIcon: vi.fn().mockReturnValue({}),
      latLng: (lat: number, lon: number) => ({ lat, lng: lon }),
    },
  };
});

describe("GpsMap component", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockMapInstance.getCenter.mockReturnValue({ lat: 0, lng: 0 });
    mockMapInstance.getBounds.mockReturnValue({
      contains: vi.fn().mockReturnValue(true),
    });
  });

  it("initialises picker mode with initial position and zoom 15", () => {
    vi.useFakeTimers();
    render(<GpsMap position={{ lat: 51.5, lon: -0.12 }} mode="picker" />);
    expect(L.map).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        center: [51.5, -0.12],
        zoom: 15,
        dragging: true,
      }),
    );
    vi.runAllTimers();
    expect(mockMapInstance.setView).toHaveBeenCalledWith([51.5, -0.12], 15, {
      animate: false,
    });
    vi.useRealTimers();
  });

  it("initialises picker mode with null position at [20, 0] and zoom 2", () => {
    render(<GpsMap position={null} mode="picker" />);
    expect(L.map).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        center: [20, 0],
        zoom: 2,
      }),
    );
    expect(L.marker).not.toHaveBeenCalled();
  });

  it("initialises static mode safely with null position", () => {
    render(<GpsMap position={null} mode="static" />);
    expect(L.map).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        center: [0, 0],
        zoom: 1,
        dragging: false,
      }),
    );
    expect(L.marker).not.toHaveBeenCalled();
  });

  it("does not recreate Leaflet map on coordinate changes", () => {
    const { rerender } = render(
      <GpsMap position={{ lat: 50, lon: 10 }} mode="picker" />,
    );
    expect(L.map).toHaveBeenCalledTimes(1);
    rerender(<GpsMap position={{ lat: 51, lon: 11 }} mode="picker" />);
    expect(L.map).toHaveBeenCalledTimes(1);
  });

  it("does not recreate Leaflet map on readOnly changes", () => {
    const { rerender } = render(
      <GpsMap position={{ lat: 50, lon: 10 }} mode="picker" readOnly={false} />,
    );
    expect(L.map).toHaveBeenCalledTimes(1);
    rerender(
      <GpsMap position={{ lat: 50, lon: 10 }} mode="picker" readOnly={true} />,
    );
    expect(L.map).toHaveBeenCalledTimes(1);
  });

  it("calls setView in static mode when coordinates change", () => {
    const { rerender } = render(
      <GpsMap position={{ lat: 50, lon: 10 }} mode="static" />,
    );
    rerender(<GpsMap position={{ lat: 51, lon: 11 }} mode="static" />);
    expect(mockMapInstance.setView).toHaveBeenCalledWith([51, 11], 16, {
      animate: false,
    });
  });

  it("manages marker creation, movement, and removal transitions", () => {
    const { rerender } = render(<GpsMap position={null} mode="picker" />);
    expect(L.marker).not.toHaveBeenCalled();

    // null -> valid position
    rerender(<GpsMap position={{ lat: 50, lon: 10 }} mode="picker" />);
    expect(L.marker).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 50, lng: 10 }),
      expect.objectContaining({ interactive: false }),
    );
    expect(mockMarkerInstance.addTo).toHaveBeenCalledWith(mockMapInstance);

    // position -> another position
    rerender(<GpsMap position={{ lat: 51, lon: 11 }} mode="picker" />);
    expect(mockMarkerInstance.setLatLng).toHaveBeenCalled();

    // position -> null
    rerender(<GpsMap position={null} mode="picker" />);
    expect(mockMarkerInstance.remove).toHaveBeenCalled();
  });

  it("positions marker and checks bounds using nearest equivalent longitude", () => {
    mockMapInstance.getCenter.mockReturnValue({ lat: 0, lng: 541 });

    const containsMock = vi.fn().mockReturnValue(true);
    mockMapInstance.getBounds.mockReturnValue({
      contains: containsMock,
    });

    render(<GpsMap position={{ lat: 0, lon: -179 }} mode="picker" />);

    // getNearestEquivalentLongitude(-179, 541) -> 541
    expect(mockMarkerInstance.setLatLng).toHaveBeenCalled();
    expect(containsMock).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 0, lng: 541 }),
    );
    expect(mockMapInstance.panTo).not.toHaveBeenCalled();
  });

  it("pans viewport if coordinates are outside visible bounds", () => {
    const containsMock = vi.fn().mockReturnValue(false); // outside bounds
    mockMapInstance.getBounds.mockReturnValue({
      contains: containsMock,
    });

    render(<GpsMap position={{ lat: 40, lon: 20 }} mode="picker" />);
    expect(mockMapInstance.panTo).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 40, lng: 20 }),
    );
  });

  it("handles map click and normalises longitude and clamps latitude", () => {
    const onPositionSelect = vi.fn();
    let clickCallback: (e: any) => void = () => {};
    mockMapInstance.on.mockImplementation(
      (event: string, cb: (e: any) => void) => {
        if (event === "click") {
          clickCallback = cb;
        }
        return mockMapInstance;
      },
    );

    render(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={onPositionSelect}
      />,
    );

    // Trigger a click at [95, 541] -> lat clamps to 90, lon normalises to -179
    clickCallback({ latlng: { lat: 95, lng: 541 } });
    expect(onPositionSelect).toHaveBeenCalledWith({ lat: 90, lon: -179 });

    // Trigger a click at [-0, -360] -> clamps to [0, 0]
    clickCallback({ latlng: { lat: -0, lng: -360 } });
    expect(onPositionSelect).toHaveBeenCalledWith({ lat: 0, lon: 0 });
  });

  it("does not call selection callback in read-only picker mode", () => {
    const onPositionSelect = vi.fn();
    let clickCallback: (e: any) => void = () => {};
    mockMapInstance.on.mockImplementation(
      (event: string, cb: (e: any) => void) => {
        if (event === "click") {
          clickCallback = cb;
        }
        return mockMapInstance;
      },
    );

    render(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={onPositionSelect}
        readOnly={true}
      />,
    );

    clickCallback({ latlng: { lat: 10, lng: 10 } });
    expect(onPositionSelect).not.toHaveBeenCalled();
  });

  it("removes marker and does not pass invalid coordinates to Leaflet if prop becomes invalid", () => {
    const { rerender } = render(
      <GpsMap position={{ lat: 50, lon: 10 }} mode="picker" />,
    );
    expect(mockMarkerInstance.addTo).toHaveBeenCalled();

    // Update to invalid position
    rerender(<GpsMap position={{ lat: 95, lon: 10 }} mode="picker" />);
    expect(mockMarkerInstance.remove).toHaveBeenCalled();
  });

  it("repositions marker to nearest world copy on moveend without triggering panTo or selection callbacks", () => {
    const onPositionSelect = vi.fn();
    let moveEndCallback: (e: any) => void = () => {};
    mockMapInstance.on.mockImplementation(
      (event: string, cb: (e: any) => void) => {
        if (event === "moveend") {
          moveEndCallback = cb;
        }
        return mockMapInstance;
      },
    );

    // Render at -179
    render(
      <GpsMap
        position={{ lat: 0, lon: -179 }}
        mode="picker"
        onPositionSelect={onPositionSelect}
      />,
    );

    // simulate moveend after centre becomes 541
    mockMapInstance.getCenter.mockReturnValue({ lat: 0, lng: 541 });
    moveEndCallback({});

    // expect marker.setLatLng(...541)
    expect(mockMarkerInstance.setLatLng).toHaveBeenLastCalledWith(
      expect.objectContaining({ lat: 0, lng: 541 }),
    );
    // expect onPositionSelect not called
    expect(onPositionSelect).not.toHaveBeenCalled();
    // expect panTo not called
    expect(mockMapInstance.panTo).not.toHaveBeenCalled();
  });
});
