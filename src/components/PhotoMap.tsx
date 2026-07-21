import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import { normaliseLongitude } from "../utils/gpsUtils";

export interface PhotoMapItem {
  relativePath: string;
  lat: number;
  lon: number;
  thumbnail: "loading" | "failed" | string;
}

interface PhotoMapProps {
  items: PhotoMapItem[];
  fitRequest: number;
}

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const CLUSTER_RADIUS_PX = 56;
const CLUSTER_BADGE_SIZE_PX = 36;

function displayLongitudes(items: PhotoMapItem[]): number[] {
  if (items.length < 2) {
    return items.map((item) => normaliseLongitude(item.lon));
  }

  const values = items
    .map((item, index) => ({
      index,
      value: ((normaliseLongitude(item.lon) % 360) + 360) % 360,
    }))
    .sort((left, right) => left.value - right.value);

  let largestGap = -1;
  let start = values[0].value;
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index].value;
    const next =
      index === values.length - 1
        ? values[0].value + 360
        : values[index + 1].value;
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      start = next % 360;
    }
  }

  const result = new Array<number>(items.length);
  for (const entry of values) {
    result[entry.index] = entry.value < start ? entry.value + 360 : entry.value;
  }
  return result;
}

function markerIcon(thumbnail: PhotoMapItem["thumbnail"]): L.DivIcon {
  const content =
    thumbnail === "loading" || thumbnail === "failed"
      ? '<span class="photo-map-marker__fallback" aria-hidden="true">▧</span>'
      : `<img class="photo-map-marker__image" src="data:image/jpeg;base64,${thumbnail}" alt="" />`;

  return L.divIcon({
    className: "photo-map-marker",
    html: `<span class="photo-map-marker__frame">${content}</span><span class="photo-map-marker__tip"></span>`,
    iconSize: [48, 58],
    iconAnchor: [24, 58],
  });
}

function clusterIcon(map: L.Map, cluster: L.MarkerCluster): L.DivIcon {
  const count = cluster.getChildCount();
  const zoom = map.getZoom();
  const centre = map.project(cluster.getLatLng(), zoom);
  const radius = cluster
    .getAllChildMarkers()
    .reduce(
      (largest, marker) =>
        Math.max(
          largest,
          centre.distanceTo(map.project(marker.getLatLng(), zoom)),
        ),
      0,
    );
  const footprintSize = Math.ceil(radius * 2);
  const iconSize = Math.max(CLUSTER_BADGE_SIZE_PX, footprintSize);
  const label = `${count.toLocaleString()} ${count === 1 ? "photo" : "photos"}`;

  return L.divIcon({
    className: "photo-map-cluster",
    html: `<span class="photo-map-cluster__footprint" style="width:${footprintSize}px;height:${footprintSize}px"></span><span class="photo-map-cluster__badge" aria-label="${label}" title="${label}">${count.toLocaleString()}</span>`,
    iconSize: [iconSize, iconSize],
    iconAnchor: [iconSize / 2, iconSize / 2],
  });
}

export function PhotoMap({ items, fitRequest }: PhotoMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterGroupRef = useRef<L.MarkerClusterGroup | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const userMovedRef = useRef(false);
  const previousCoordinateKeyRef = useRef("");
  const previousFitRequestRef = useRef(fitRequest);

  const longitudes = useMemo(() => displayLongitudes(items), [items]);
  const coordinateKey = items
    .map(
      (item, index) => `${item.relativePath}:${item.lat}:${longitudes[index]}`,
    )
    .join("|");

  useEffect(() => {
    if (!containerRef.current) return;

    const map = L.map(containerRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
      dragging: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      touchZoom: true,
      tap: true,
    } as L.MapOptions & { tap?: boolean });

    L.tileLayer(OSM_TILE_URL, {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: CLUSTER_RADIUS_PX,
      iconCreateFunction: (cluster) => clusterIcon(map, cluster),
      zoomToBoundsOnClick: true,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      removeOutsideVisibleBounds: true,
      chunkedLoading: true,
    }).addTo(map);

    const markUserMovement = () => {
      userMovedRef.current = true;
    };
    map.on("dragstart", markUserMovement);
    map.on("zoomstart", markUserMovement);
    mapRef.current = map;
    clusterGroupRef.current = clusterGroup;
    // A fresh Leaflet instance always needs an initial fit. In React Strict
    // Mode the construction effect is deliberately set up twice; retaining
    // the first instance's fit key would leave the second, real map at the
    // default world view.
    previousCoordinateKeyRef.current = "__unfitted__";
    userMovedRef.current = false;

    const invalidateSizeTimeout = window.setTimeout(
      () => map.invalidateSize(),
      0,
    );

    return () => {
      window.clearTimeout(invalidateSizeTimeout);
      map.off("dragstart", markUserMovement);
      map.off("zoomstart", markUserMovement);
      map.remove();
      mapRef.current = null;
      clusterGroupRef.current = null;
      markersRef.current = [];
    };
  }, []);

  useEffect(() => {
    const clusterGroup = clusterGroupRef.current;
    if (!clusterGroup) return;

    clusterGroup.clearLayers();
    markersRef.current = items.map((item, index) =>
      L.marker([item.lat, longitudes[index]], {
        icon: markerIcon(item.thumbnail),
        interactive: false,
        keyboard: false,
      }),
    );
    clusterGroup.addLayers(markersRef.current);
  }, [items, longitudes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const coordinatesChanged =
      coordinateKey !== previousCoordinateKeyRef.current;
    const fitExplicitlyRequested = fitRequest !== previousFitRequestRef.current;
    previousCoordinateKeyRef.current = coordinateKey;
    previousFitRequestRef.current = fitRequest;

    if (
      !fitExplicitlyRequested &&
      (!coordinatesChanged || userMovedRef.current)
    )
      return;

    if (items.length === 0) {
      map.setView([20, 0], 2, { animate: false });
    } else if (items.length === 1) {
      map.setView([items[0].lat, longitudes[0]], 16, { animate: false });
    } else {
      map.fitBounds(
        L.latLngBounds(
          items.map((item, index) => [item.lat, longitudes[index]]),
        ),
        { padding: [64, 64], maxZoom: 16, animate: false },
      );
    }
    userMovedRef.current = false;
  }, [coordinateKey, fitRequest, items, longitudes]);

  return (
    <div
      ref={containerRef}
      className="photo-map"
      data-testid="photo-map"
      aria-label={`Interactive map showing ${items.length} photo ${items.length === 1 ? "location" : "locations"}`}
    />
  );
}
