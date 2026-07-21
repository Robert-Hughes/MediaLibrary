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
const CROSSFADE_DURATION_MS = 160;
const PHOTO_ICON_SELECTOR = ".photo-map-cluster, .photo-map-marker";

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

function clusterIcon(
  map: L.Map,
  cluster: L.MarkerCluster,
  markerCoordinates: WeakMap<L.Marker, L.LatLng>,
): L.DivIcon {
  const count = cluster.getChildCount();
  const zoom = map.getZoom();
  const markers = cluster.getAllChildMarkers();
  const coordinates = markers.map(
    (marker) => markerCoordinates.get(marker) ?? marker.getLatLng(),
  );
  const firstCoordinate = coordinates[0];
  const hasIdenticalCoordinates = coordinates.every(
    (coordinate) =>
      coordinate.lat === firstCoordinate.lat &&
      coordinate.lng === firstCoordinate.lng,
  );

  // MarkerCluster temporarily moves cluster markers while animating between
  // zoom levels. Calculate its final weighted centre from the immutable photo
  // coordinates instead of cluster.getLatLng(), which can expose that transient
  // position and leave the cached footprint permanently mis-sized.
  const centreLatLng = L.latLng(
    coordinates.reduce((sum, coordinate) => sum + coordinate.lat, 0) /
      coordinates.length,
    coordinates.reduce((sum, coordinate) => sum + coordinate.lng, 0) /
      coordinates.length,
  );
  const centre = map.project(centreLatLng, zoom);
  const radius = coordinates.reduce(
    (largest, coordinate) =>
      Math.max(largest, centre.distanceTo(map.project(coordinate, zoom))),
    0,
  );
  const footprintSize = Math.ceil(radius * 2);
  const iconSize = Math.max(CLUSTER_BADGE_SIZE_PX, footprintSize);
  const label = `${count.toLocaleString()} ${count === 1 ? "photo" : "photos"}${hasIdenticalCoordinates ? " at identical coordinates" : ""}`;

  return L.divIcon({
    className: `photo-map-cluster${hasIdenticalCoordinates ? " photo-map-cluster--identical" : ""}`,
    html: `<span class="photo-map-cluster__footprint" style="width:${footprintSize}px;height:${footprintSize}px"></span><span class="photo-map-cluster__badge" aria-label="${label}" title="${label}">${count.toLocaleString()}</span>`,
    iconSize: [iconSize, iconSize],
    iconAnchor: [iconSize / 2, iconSize / 2],
  });
}

export function PhotoMap({ items, fitRequest }: PhotoMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterGroupRef = useRef<L.MarkerClusterGroup | null>(null);
  const markerCoordinatesRef = useRef(new WeakMap<L.Marker, L.LatLng>());
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
      // Leaflet retains and scales the previous tile level only on its animated
      // zoom path. CSS makes that geometry transition effectively instant while
      // fadeAnimation crossfades each replacement tile after it has loaded.
      zoomAnimation: true,
      fadeAnimation: true,
      tap: true,
    } as L.MapOptions & { tap?: boolean });

    L.tileLayer(OSM_TILE_URL, {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    // MarkerCluster only swaps cluster layers on zoomend, and its built-in
    // positional animation can jump when rapid zooms interrupt its timeout
    // queue. Keep clustering non-animated and crossfade only the DOM icons it
    // actually replaces, without changing Leaflet's marker positions.
    type CrossfadeSnapshot = {
      originals: HTMLElement[];
      clones: Map<HTMLElement, HTMLElement>;
    };
    let crossfadeSnapshot: CrossfadeSnapshot | null = null;
    const crossfadeTimeouts = new Set<number>();
    const currentPhotoIcons = () =>
      Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          PHOTO_ICON_SELECTOR,
        ) ?? [],
      ).filter(
        (icon) =>
          !icon.classList.contains("photo-map-icon--snapshot") &&
          !icon.classList.contains("photo-map-icon--departing"),
      );
    const clearCrossfadeArtifacts = () => {
      for (const timeout of crossfadeTimeouts) window.clearTimeout(timeout);
      crossfadeTimeouts.clear();
      containerRef.current
        ?.querySelectorAll<HTMLElement>(
          ".photo-map-icon--snapshot, .photo-map-icon--departing",
        )
        .forEach((icon) => icon.remove());
      containerRef.current
        ?.querySelectorAll<HTMLElement>(".photo-map-icon--entering")
        .forEach((icon) => icon.classList.remove("photo-map-icon--entering"));
      crossfadeSnapshot = null;
    };
    const captureCrossfade = () => {
      clearCrossfadeArtifacts();
      const originals = currentPhotoIcons();
      const clones = new Map<HTMLElement, HTMLElement>();
      for (const original of originals) {
        const clone = original.cloneNode(true) as HTMLElement;
        clone.classList.add("photo-map-icon--snapshot");
        clone.setAttribute("aria-hidden", "true");
        original.parentElement?.append(clone);
        clones.set(original, clone);
      }
      crossfadeSnapshot = { originals, clones };
    };

    // Register before MarkerCluster so the outgoing icons are captured just
    // before its synchronous, non-animated layer swap on zoomend.
    map.on("zoomend", captureCrossfade);

    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: CLUSTER_RADIUS_PX,
      iconCreateFunction: (cluster) =>
        clusterIcon(map, cluster, markerCoordinatesRef.current),
      zoomToBoundsOnClick: true,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      removeOutsideVisibleBounds: true,
      chunkedLoading: true,
      animate: false,
    }).addTo(map);

    const finishCrossfade = () => {
      const snapshot = crossfadeSnapshot;
      if (!snapshot) return;
      crossfadeSnapshot = null;
      const retained = new Set(
        snapshot.originals.filter((icon) => icon.isConnected),
      );

      for (const [original, clone] of snapshot.clones) {
        if (retained.has(original)) {
          clone.remove();
          continue;
        }
        clone.classList.remove("photo-map-icon--snapshot");
        clone.classList.add("photo-map-icon--departing");
        const timeout = window.setTimeout(() => {
          clone.remove();
          crossfadeTimeouts.delete(timeout);
        }, CROSSFADE_DURATION_MS);
        crossfadeTimeouts.add(timeout);
      }

      for (const icon of currentPhotoIcons()) {
        if (retained.has(icon)) continue;
        icon.classList.add("photo-map-icon--entering");
        const timeout = window.setTimeout(() => {
          icon.classList.remove("photo-map-icon--entering");
          crossfadeTimeouts.delete(timeout);
        }, CROSSFADE_DURATION_MS);
        crossfadeTimeouts.add(timeout);
      }
    };
    map.on("zoomend", finishCrossfade);

    const markDragStart = () => {
      userMovedRef.current = true;
    };
    const markZoomStart = () => {
      userMovedRef.current = true;
      // Snapshots are not Leaflet layers and cannot follow another map zoom.
      // Remove an unfinished fade before it can become a stationary ghost.
      clearCrossfadeArtifacts();
    };
    map.on("dragstart", markDragStart);
    map.on("zoomstart", markZoomStart);
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
      map.off("dragstart", markDragStart);
      map.off("zoomstart", markZoomStart);
      map.off("zoomend", captureCrossfade);
      map.off("zoomend", finishCrossfade);
      clearCrossfadeArtifacts();
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
    markersRef.current = items.map((item, index) => {
      const coordinate = L.latLng(item.lat, longitudes[index]);
      const marker = L.marker([coordinate.lat, coordinate.lng], {
        icon: markerIcon(item.thumbnail),
        interactive: false,
        keyboard: false,
      });
      markerCoordinatesRef.current.set(marker, coordinate);
      return marker;
    });
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
