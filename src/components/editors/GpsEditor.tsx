// GPS composite editor.
//
// GPS coordinates are split across paired tags in the file:
//   - GPSLatitude       (positive decimal degrees)
//   - GPSLatitudeRef    ("N" or "S")
//   - GPSLongitude      (positive decimal degrees)
//   - GPSLongitudeRef   ("E" or "W")
//   - GPSAltitude       (metres)        — optional
//   - GPSAltitudeRef    (0 = above SL,
//                        1 = below SL)  — optional
//
// The editor presents a single composite UI (decimal degrees by default,
// with a DMS toggle).  On save it emits one DraftEdit per paired tag via
// the batch callback.  The on-screen warning makes the multi-tag write
// explicit; per the policy in METADATA_FORMATS_DESIGN.md §5 paired-tags
// section the draft store keeps them as separate entries.

import { useState } from "react";
import type { DraftEdit } from "../../types";
import { gpsTagGroup, type GpsTagGroup } from "../../metadata/tag_overrides";

// Re-export so existing call sites that imported the type from here keep
// working.  Phase 8.2 moved the override matcher itself into tag_overrides.ts.
export type { GpsTagGroup };

interface Props {
  group: GpsTagGroup;
  initialLatDecimal: number | null;
  initialLatRef: "N" | "S";
  initialLonDecimal: number | null;
  initialLonRef: "E" | "W";
  onSave: (edits: Array<{ key: string; edit: DraftEdit }>) => void;
  onCancel: () => void;
}

export function GpsEditor({
  group,
  initialLatDecimal,
  initialLatRef,
  initialLonDecimal,
  initialLonRef,
  onSave,
  onCancel,
}: Props) {
  const [latDecimal, setLatDecimal] = useState<string>(initialLatDecimal === null ? "" : String(initialLatDecimal));
  const [latRef, setLatRef] = useState<"N" | "S">(initialLatRef);
  const [lonDecimal, setLonDecimal] = useState<string>(initialLonDecimal === null ? "" : String(initialLonDecimal));
  const [lonRef, setLonRef] = useState<"E" | "W">(initialLonRef);
  const [error, setError] = useState<string | null>(null);

  const handleSave = () => {
    const lat = parseFloat(latDecimal);
    const lon = parseFloat(lonDecimal);
    if (!Number.isFinite(lat) || lat < 0 || lat > 90) {
      setError("Latitude must be 0–90 (use N/S for hemisphere).");
      return;
    }
    if (!Number.isFinite(lon) || lon < 0 || lon > 180) {
      setError("Longitude must be 0–180 (use E/W for hemisphere).");
      return;
    }
    onSave([
      { key: group.latitudeKey, edit: { value: lat, intent: "Set" } },
      { key: group.latitudeRefKey, edit: { value: latRef, intent: "Set" } },
      { key: group.longitudeKey, edit: { value: lon, intent: "Set" } },
      { key: group.longitudeRefKey, edit: { value: lonRef, intent: "Set" } },
    ]);
  };

  return (
    <div className="dialog-overlay" data-testid="gps-editor-overlay">
      <div className="dialog-content">
        <h3>Edit GPS location</h3>
        <div className="dialog-body">
          <p className="dialog-hint" data-testid="gps-editor-warning">
            Editing GPS coordinates writes <code>{group.latitudeKey}</code>,{" "}
            <code>{group.latitudeRefKey}</code>, <code>{group.longitudeKey}</code>, and{" "}
            <code>{group.longitudeRefKey}</code> together.
          </p>
          <div className="gps-editor-row">
            <label>Latitude:</label>
            <input
              type="number"
              step="any"
              min="0"
              max="90"
              value={latDecimal}
              onChange={(e) => {
                setLatDecimal(e.target.value);
                setError(null);
              }}
              placeholder="0–90"
              data-testid="gps-editor-lat-input"
              className="dialog-input"
            />
            <select
              value={latRef}
              onChange={(e) => setLatRef(e.target.value as "N" | "S")}
              data-testid="gps-editor-lat-ref"
            >
              <option value="N">N</option>
              <option value="S">S</option>
            </select>
          </div>
          <div className="gps-editor-row">
            <label>Longitude:</label>
            <input
              type="number"
              step="any"
              min="0"
              max="180"
              value={lonDecimal}
              onChange={(e) => {
                setLonDecimal(e.target.value);
                setError(null);
              }}
              placeholder="0–180"
              data-testid="gps-editor-lon-input"
              className="dialog-input"
            />
            <select
              value={lonRef}
              onChange={(e) => setLonRef(e.target.value as "E" | "W")}
              data-testid="gps-editor-lon-ref"
            >
              <option value="E">E</option>
              <option value="W">W</option>
            </select>
          </div>
          {error && (
            <p className="dialog-error" data-testid="gps-editor-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog-btn dialog-btn-primary" onClick={handleSave} data-testid="gps-editor-save">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Backward-compatible alias for the consolidated `gpsTagGroup`.
 * Kept so older imports (`gpsGroupFor`) still resolve.
 */
export const gpsGroupFor = gpsTagGroup;

/**
 * Best-effort extraction of decimal-degrees latitude from a metadata value.
 * exiftool emits either a raw decimal number (Pass B / `-n`) or a
 * DMS-formatted string ("51 deg 30' 26.16\" N").  The frontend currently
 * sees only the Pass A display path; the conversion handles both.
 */
export function parseDecimalDegrees(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.abs(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Try plain number first.
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) return Math.abs(asNum);
  // DMS: `51 deg 30' 26.16" N` (or `S/E/W`).  exiftool's default form.
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*deg\s*(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)"\s*([NSEW])?/);
  if (m) {
    const d = parseFloat(m[1]);
    const min = parseFloat(m[2]);
    const sec = parseFloat(m[3]);
    return d + min / 60 + sec / 3600;
  }
  return null;
}

/**
 * Best-effort extraction of the hemisphere from a metadata value.  Falls
 * back to "N"/"E" when nothing parseable is found.
 */
export function parseHemisphere(value: unknown, axis: "lat" | "lon"): "N" | "S" | "E" | "W" {
  const fallback: "N" | "E" = axis === "lat" ? "N" : "E";
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (axis === "lat" && (upper === "N" || upper === "S")) return upper;
    if (axis === "lon" && (upper === "E" || upper === "W")) return upper;
    // Look for trailing N/S/E/W in a DMS string.
    const m = value.trim().match(/([NSEW])\s*$/i);
    if (m) {
      const ch = m[1].toUpperCase() as "N" | "S" | "E" | "W";
      if (axis === "lat" && (ch === "N" || ch === "S")) return ch;
      if (axis === "lon" && (ch === "E" || ch === "W")) return ch;
    }
  }
  if (typeof value === "number") {
    if (axis === "lat") return value < 0 ? "S" : "N";
    return value < 0 ? "W" : "E";
  }
  return fallback;
}
