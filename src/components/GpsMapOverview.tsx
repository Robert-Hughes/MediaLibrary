import { GpsMap } from "./GpsMap";

interface GpsMapOverviewProps {
  lat: number;
  lon: number;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
}

export function GpsMapOverview({
  lat,
  lon,
  onContextMenu,
}: GpsMapOverviewProps) {
  const position = { lat, lon };

  return (
    <div className="gps-map-overview" data-testid="gps-map-overview">
      <div
        className="gps-map-overview__grid"
        data-testid="gps-map-overview-grid"
        onContextMenu={onContextMenu}
      >
        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">World</div>
          <GpsMap
            position={position}
            zoom={1}
            mode="static"
            showAttribution={false}
          />
        </div>

        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">Country</div>
          <GpsMap
            position={position}
            zoom={4}
            mode="static"
            showAttribution={false}
          />
        </div>

        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">City</div>
          <GpsMap
            position={position}
            zoom={8}
            mode="static"
            showAttribution={false}
          />
        </div>

        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">Local</div>
          <GpsMap
            position={position}
            zoom={16}
            mode="static"
            showAttribution={false}
          />
        </div>
      </div>

      <div className="gps-map-attribution">
        <a
          href="https://leafletjs.com"
          title="A JavaScript library for interactive maps"
          target="_blank"
          rel="noopener noreferrer"
        >
          Leaflet
        </a>{" "}
        | &copy;{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
        >
          OpenStreetMap
        </a>{" "}
        contributors
      </div>
    </div>
  );
}
