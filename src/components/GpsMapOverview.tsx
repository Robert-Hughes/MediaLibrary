import { GpsMap } from "./GpsMap";

interface GpsMapOverviewProps {
  lat: number;
  lon: number;
}

export function GpsMapOverview({ lat, lon }: GpsMapOverviewProps) {
  return (
    <div className="gps-map-overview" data-testid="gps-map-overview">
      <div className="gps-map-overview__grid">
        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">World</div>
          <GpsMap lat={lat} lon={lon} zoom={1} showAttribution={false} />
        </div>

        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">Country</div>
          <GpsMap lat={lat} lon={lon} zoom={4} showAttribution={false} />
        </div>

        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">City</div>
          <GpsMap lat={lat} lon={lon} zoom={8} showAttribution={false} />
        </div>

        <div className="gps-map-overview__item">
          <div className="gps-map-overview__label">Local</div>
          <GpsMap lat={lat} lon={lon} zoom={16} showAttribution={false} />
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
