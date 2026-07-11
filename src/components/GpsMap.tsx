import { useCallback, useEffect, useRef, useLayoutEffect } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  isValidCoordinate,
  normaliseLongitude,
  getNearestEquivalentLongitude,
} from "../utils/gpsUtils";

export interface GpsPosition {
  lat: number;
  lon: number;
}

interface GpsMapProps {
  position: GpsPosition | null;
  zoom?: number;
  mode?: "static" | "picker";
  showAttribution?: boolean;
  onPositionSelect?: (position: GpsPosition) => void;
  readOnly?: boolean;
}

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const gpsMarkerIcon = L.divIcon({
  className: "gps-map-marker",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

export function GpsMap({
  position,
  zoom,
  mode = "static",
  showAttribution = true,
  onPositionSelect,
  readOnly = false,
}: GpsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Derive valid position
  const validPosition =
    position && isValidCoordinate(position.lat, position.lon)
      ? {
          lat: position.lat,
          lon: normaliseLongitude(position.lon),
        }
      : null;

  // Store selection callback in a ref to avoid map reconstruction
  const onPositionSelectRef = useRef(onPositionSelect);

  // Store readOnly in a ref for callback/listener access without reconstruction
  const readOnlyRef = useRef(readOnly);

  // Store validPosition in a ref for callback/listener access without reconstruction
  const validPositionRef = useRef(validPosition);

  const validLat = validPosition?.lat;
  const validLon = validPosition?.lon;

  // Synchronise refs after each committed render
  useLayoutEffect(() => {
    onPositionSelectRef.current = onPositionSelect;
    readOnlyRef.current = readOnly;
    validPositionRef.current =
      validLat !== undefined && validLon !== undefined
        ? { lat: validLat, lon: validLon }
        : null;
  }, [onPositionSelect, readOnly, validLat, validLon]);

  const selectMapPosition = useCallback((event: L.LeafletMouseEvent) => {
    if (readOnlyRef.current) return;

    const { lat, lng } = event.latlng;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return;
    }

    const clampedLat = Math.max(-90, Math.min(90, lat));
    const normalisedLon = normaliseLongitude(lng);

    onPositionSelectRef.current?.({
      lat: Object.is(clampedLat, -0) ? 0 : clampedLat,
      lon: Object.is(normalisedLon, -0) ? 0 : normalisedLon,
    });
  }, []);

  // 1. Map Construction Effect
  // Mode and showAttribution are treated as immutable for the component's lifetime.
  useEffect(() => {
    if (!containerRef.current) return;

    // Define initial viewport values based on mode and validPosition presence
    let initLat: number;
    let initLon: number;
    let initZoom: number;

    if (mode === "picker") {
      if (validPosition) {
        initLat = validPosition.lat;
        initLon = validPosition.lon;
        initZoom = zoom ?? 15;
      } else {
        initLat = 20;
        initLon = 0;
        initZoom = zoom ?? 2;
      }
    } else {
      // static mode
      if (validPosition) {
        initLat = validPosition.lat;
        initLon = validPosition.lon;
        initZoom = zoom ?? 16;
      } else {
        initLat = 0;
        initLon = 0;
        initZoom = zoom ?? 1;
      }
    }

    const map = L.map(containerRef.current, {
      center: [initLat, initLon],
      zoom: initZoom,
      zoomControl: mode === "picker",
      dragging: mode === "picker",
      scrollWheelZoom: mode === "picker",
      doubleClickZoom: mode === "picker",
      boxZoom: mode === "picker",
      keyboard: mode === "picker",
      touchZoom: mode === "picker",
      tap: mode === "picker",
      attributionControl: showAttribution,
    } as L.MapOptions & { tap?: boolean });

    L.tileLayer(OSM_TILE_URL, {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    // Initial marker setup if coordinate is valid
    if (validPosition) {
      markerRef.current = L.marker([validPosition.lat, validPosition.lon], {
        icon: gpsMarkerIcon,
        interactive: false,
      }).addTo(map);
    }

    mapRef.current = map;

    const invalidateSizeTimeout = window.setTimeout(() => {
      map.invalidateSize();
      if (validPosition) {
        map.setView([validPosition.lat, validPosition.lon], initZoom, {
          animate: false,
        });
      } else {
        map.setView([initLat, initLon], initZoom, { animate: false });
      }
    }, 0);

    return () => {
      window.clearTimeout(invalidateSizeTimeout);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // 2. Click Handling & Repeated-World Move Handling/Listener Effect
  // Sets up listeners only for picker mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== "picker") return;

    const handleMapClick = (event: L.LeafletMouseEvent) => {
      if (!event.originalEvent.shiftKey) return;
      selectMapPosition(event);
    };

    const handleMapMove = () => {
      const marker = markerRef.current;
      if (marker && validPositionRef.current) {
        const centerLon = map.getCenter().lng;
        const displayedLon = getNearestEquivalentLongitude(
          validPositionRef.current.lon,
          centerLon,
        );
        marker.setLatLng(L.latLng(validPositionRef.current.lat, displayedLon));
      }
    };

    map.on("click", handleMapClick);
    map.on("moveend", handleMapMove);
    return () => {
      map.off("click", handleMapClick);
      map.off("moveend", handleMapMove);
    };
  }, [mode, selectMapPosition]);

  // 2b. Context Menu Listener Effect
  // Only registered when selection is enabled (readOnly is false).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== "picker" || readOnly) return;

    const handleMapContextMenu = (event: L.LeafletMouseEvent) => {
      if (readOnlyRef.current) return;
      event.originalEvent.preventDefault();
      selectMapPosition(event);
    };

    map.on("contextmenu", handleMapContextMenu);

    return () => {
      map.off("contextmenu", handleMapContextMenu);
    };
  }, [mode, readOnly, selectMapPosition]);

  // 3. Marker & Viewport Sync Effect
  // Runs whenever coordinates or zoom changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (validLat !== undefined && validLon !== undefined) {
      if (mode === "static") {
        const point: L.LatLngExpression = [validLat, validLon];
        if (!markerRef.current) {
          markerRef.current = L.marker(point, {
            icon: gpsMarkerIcon,
            interactive: false,
          }).addTo(map);
        } else {
          markerRef.current.setLatLng(point);
        }
        map.setView(point, zoom ?? 16, { animate: false });
      } else {
        // picker mode
        // Determine nearest equivalent longitude to keep marker visible
        const centerLon = map.getCenter().lng;
        const displayedLon = getNearestEquivalentLongitude(validLon, centerLon);
        const point = L.latLng(validLat, displayedLon);

        if (!markerRef.current) {
          markerRef.current = L.marker(point, {
            icon: gpsMarkerIcon,
            interactive: false,
          }).addTo(map);
        } else {
          markerRef.current.setLatLng(point);
        }

        // Only pan if coordinate is outside current visible bounds
        const bounds = map.getBounds();
        if (!bounds.contains(point)) {
          map.panTo(point);
        }
      }
    } else {
      // validPosition is null/absent
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
    }
  }, [validLat, validLon, zoom, mode]);

  // Dynamic accessibility attributes & CSS classes
  const containerClass = [
    "gps-map",
    mode === "static" ? "gps-map--static" : "gps-map--picker",
    readOnly ? "gps-map--read-only" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const ariaLabel = (() => {
    if (mode === "static") {
      return validPosition
        ? `Map showing GPS location ${validPosition.lat}, ${validPosition.lon}`
        : "Map showing GPS location";
    }
    // picker mode
    if (readOnly) {
      return validPosition
        ? `Interactive map showing the selected GPS location; location selection is disabled`
        : "Interactive map; location selection is disabled";
    }
    return validPosition
      ? `Interactive map for choosing a GPS location, currently at the selected coordinate ${validPosition.lat}, ${validPosition.lon}`
      : "Interactive map for choosing a GPS location";
  })();

  return (
    <div
      className={containerClass}
      data-testid="gps-map"
      aria-label={ariaLabel}
      ref={containerRef}
    />
  );
}
