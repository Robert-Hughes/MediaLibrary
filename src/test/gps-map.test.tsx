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

  it("does not select on ordinary left-click", () => {
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

    const preventDefault = vi.fn();
    clickCallback({
      latlng: { lat: 10, lng: 10 },
      originalEvent: {
        shiftKey: false,
        preventDefault,
      },
    });

    expect(onPositionSelect).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("selects on Shift+left-click and normalises/clamps coordinates", () => {
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

    const preventDefault = vi.fn();
    // Trigger shifted click at [95, 541] -> lat clamps to 90, lon normalises to -179
    clickCallback({
      latlng: { lat: 95, lng: 541 },
      originalEvent: {
        shiftKey: true,
        preventDefault,
      },
    });
    expect(onPositionSelect).toHaveBeenCalledWith({ lat: 90, lon: -179 });

    // Trigger shifted click at [-0, -360] -> clamps to [0, 0]
    clickCallback({
      latlng: { lat: -0, lng: -360 },
      originalEvent: {
        shiftKey: true,
        preventDefault,
      },
    });
    expect(onPositionSelect).toHaveBeenLastCalledWith({ lat: 0, lon: 0 });
  });

  it("selects on right-click immediately available on mount and calls preventDefault", () => {
    const onPositionSelect = vi.fn();
    let contextmenuCallback: (e: any) => void = () => {};
    mockMapInstance.on.mockImplementation(
      (event: string, cb: (e: any) => void) => {
        if (event === "contextmenu") {
          contextmenuCallback = cb;
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

    const preventDefault = vi.fn();
    contextmenuCallback({
      latlng: { lat: 40, lng: 50 },
      originalEvent: {
        shiftKey: false,
        preventDefault,
      },
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onPositionSelect).toHaveBeenCalledWith({ lat: 40, lon: 50 });
  });

  it("right-click prevents default even for invalid coordinates", () => {
    const onPositionSelect = vi.fn();
    let contextmenuCallback: (e: any) => void = () => {};
    mockMapInstance.on.mockImplementation(
      (event: string, cb: (e: any) => void) => {
        if (event === "contextmenu") {
          contextmenuCallback = cb;
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

    const preventDefault = vi.fn();
    contextmenuCallback({
      latlng: { lat: NaN, lng: 50 },
      originalEvent: {
        shiftKey: false,
        preventDefault,
      },
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onPositionSelect).not.toHaveBeenCalled();
  });

  it("does not select on Shift+left-click when read-only", () => {
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

    const preventDefault = vi.fn();
    clickCallback({
      latlng: { lat: 10, lng: 10 },
      originalEvent: {
        shiftKey: true,
        preventDefault,
      },
    });

    expect(onPositionSelect).not.toHaveBeenCalled();
  });

  it("two consecutive ordinary clicks (double click candidate) do not invoke selection", () => {
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

    const preventDefault = vi.fn();
    const eventObj = {
      latlng: { lat: 10, lng: 10 },
      originalEvent: {
        shiftKey: false,
        preventDefault,
      },
    };

    // First click of a double click
    clickCallback(eventObj);
    // Second click of a double click
    clickCallback(eventObj);

    expect(onPositionSelect).not.toHaveBeenCalled();
  });

  it("uses the latest callback and readOnly values on click without reconstructing the map", () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    let clickCallback: (e: any) => void = () => {};
    mockMapInstance.on.mockImplementation(
      (event: string, cb: (e: any) => void) => {
        if (event === "click") {
          clickCallback = cb;
        }
        return mockMapInstance;
      },
    );

    // 1. Initial render with callback1 and readOnly={false}
    const { rerender } = render(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={callback1}
        readOnly={false}
      />,
    );

    // Verify map was created once
    expect(L.map).toHaveBeenCalledTimes(1);

    // 2. Rerender with callback2 and readOnly={true}
    rerender(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={callback2}
        readOnly={true}
      />,
    );

    // Verify map was NOT reconstructed
    expect(L.map).toHaveBeenCalledTimes(1);

    // Trigger click while readOnly={true} -> neither callback should be called
    clickCallback({
      latlng: { lat: 10, lng: 20 },
      originalEvent: { shiftKey: true, preventDefault: vi.fn() },
    });
    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).not.toHaveBeenCalled();

    // 3. Rerender back to readOnly={false} with callback2
    rerender(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={callback2}
        readOnly={false}
      />,
    );

    // Verify map was NOT reconstructed
    expect(L.map).toHaveBeenCalledTimes(1);

    // Trigger click -> callback2 should be called, but not callback1
    clickCallback({
      latlng: { lat: 10, lng: 20 },
      originalEvent: { shiftKey: true, preventDefault: vi.fn() },
    });
    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledOnce();
    expect(callback2).toHaveBeenCalledWith({ lat: 10, lon: 20 });
  });

  it("manages event listener registration and cleanup lifecycle based on mode and read-only status", () => {
    const onPositionSelect = vi.fn();
    const registered: Array<{ event: string; cb: any }> = [];
    const unregistered: Array<{ event: string; cb: any }> = [];

    mockMapInstance.on.mockImplementation((event: string, cb: any) => {
      registered.push({ event, cb });
      return mockMapInstance;
    });
    mockMapInstance.off.mockImplementation((event: string, cb: any) => {
      unregistered.push({ event, cb });
      return mockMapInstance;
    });

    // 1. Initial mount in editable picker mode
    const { rerender, unmount } = render(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={onPositionSelect}
        readOnly={false}
      />,
    );

    // Verify immediate registration of all three listeners after effect flushes
    const clicks = registered.filter((r) => r.event === "click");
    const moveends = registered.filter((r) => r.event === "moveend");
    const contextmenus = registered.filter((r) => r.event === "contextmenu");

    expect(clicks).toHaveLength(1);
    expect(moveends).toHaveLength(1);
    expect(contextmenus).toHaveLength(1);

    // 2. Transition from editable to read-only
    rerender(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={onPositionSelect}
        readOnly={true}
      />,
    );

    // Verify contextmenu handler was unregistered with the exact same reference
    const contextmenuOffs = unregistered.filter(
      (r) => r.event === "contextmenu",
    );
    expect(contextmenuOffs).toHaveLength(1);
    expect(contextmenuOffs[0].cb).toBe(contextmenus[0].cb);

    // Click and moveend should not be unregistered
    expect(unregistered.filter((r) => r.event === "click")).toHaveLength(0);
    expect(unregistered.filter((r) => r.event === "moveend")).toHaveLength(0);

    // 3. Transition back to editable
    registered.length = 0; // reset trace
    rerender(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={onPositionSelect}
        readOnly={false}
      />,
    );

    // Verify contextmenu is registered again without map reconstruction (L.map was called once)
    const newContextmenus = registered.filter((r) => r.event === "contextmenu");
    expect(newContextmenus).toHaveLength(1);
    expect(L.map).toHaveBeenCalledTimes(1);

    // 4. Unmount
    unregistered.length = 0; // reset trace
    unmount();

    // Verify all currently active listeners are unregistered
    expect(unregistered).toContainEqual({ event: "click", cb: clicks[0].cb });
    expect(unregistered).toContainEqual({
      event: "moveend",
      cb: moveends[0].cb,
    });
    expect(unregistered).toContainEqual({
      event: "contextmenu",
      cb: newContextmenus[0].cb,
    });
  });

  it("registers click and moveend but not contextmenu on initial read-only mount", () => {
    const registered: Array<{ event: string; cb: any }> = [];
    mockMapInstance.on.mockImplementation((event: string, cb: any) => {
      registered.push({ event, cb });
      return mockMapInstance;
    });

    render(
      <GpsMap
        position={null}
        mode="picker"
        onPositionSelect={vi.fn()}
        readOnly={true}
      />,
    );

    expect(registered.filter((r) => r.event === "click")).toHaveLength(1);
    expect(registered.filter((r) => r.event === "moveend")).toHaveLength(1);
    expect(registered.filter((r) => r.event === "contextmenu")).toHaveLength(0);
  });
});
