import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface GpsMapProps {
  lat: number;
  lon: number;
}

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const gpsMarkerIcon = L.divIcon({
  className: "gps-map-marker",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

export function GpsMap({ lat, lon }: GpsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = L.map(containerRef.current, {
      center: [lat, lon],
      zoom: 16,
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      tap: false,
      attributionControl: true,
    } as L.MapOptions & { tap?: boolean });

    L.tileLayer(OSM_TILE_URL, {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    markerRef.current = L.marker([lat, lon], { icon: gpsMarkerIcon }).addTo(
      map,
    );
    mapRef.current = map;

    const invalidateSizeTimeout = window.setTimeout(
      () => map.invalidateSize(),
      0,
    );

    return () => {
      window.clearTimeout(invalidateSizeTimeout);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;

    const point: L.LatLngExpression = [lat, lon];
    marker.setLatLng(point);
    map.setView(point, map.getZoom(), { animate: false });
  }, [lat, lon]);

  return (
    <div
      className="gps-map"
      data-testid="gps-map"
      aria-label={`Map showing GPS location ${lat}, ${lon}`}
      ref={containerRef}
    />
  );
}
