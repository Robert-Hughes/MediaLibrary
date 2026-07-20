import { ModalDialog } from "../ModalDialog";
// Grouped GPS editor.
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
// The editor presents one coordinated UI (decimal degrees by default,
// with a DMS toggle).  On save it emits one MetadataDraftEdit per paired tag via
// the batch callback.  The on-screen warning makes the multi-tag write
// explicit; per the policy in METADATA_FORMATS_DESIGN.md §5 paired-tags
// section the draft store keeps them as separate entries.

import { useState } from "react";
import type { MetadataDraftEdit, SchemaDefinitionId } from "../../types";
import { formatSchemaDefinitionIdForDiagnostics } from "../../utils/schemaDefinitionId";
import type { GpsTagGroup } from "../../metadata/tag_overrides";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import { enumDraftEdit, type EnumTagKind } from "./editorHelpers";
import { GpsMap, type GpsPosition } from "../GpsMap";
import { formatCoordinate } from "../../utils/gpsUtils";

// Re-export so existing call sites that imported the type from here keep
// working.  The override matcher lives in tag_overrides.ts.
export type { GpsTagGroup };

interface Props {
  group: GpsTagGroup;
  initialLatDecimal: number | null;
  initialLatRef: "N" | "S";
  initialLonDecimal: number | null;
  initialLonRef: "E" | "W";
  /** Paired GPSAltitude (metres). Empty string clears the tag. */
  initialAltitudeMetres?: number | null;
  /** "above" → AltitudeRef=0, "below" → AltitudeRef=1. */
  initialAltitudeRef?: "above" | "below";
  refKinds?: {
    latitude?: EnumTagKind;
    longitude?: EnumTagKind;
    altitude?: EnumTagKind;
  };
  onSave: (
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}

export function GpsEditor({
  group,
  initialLatDecimal,
  initialLatRef,
  initialLonDecimal,
  initialLonRef,
  initialAltitudeMetres,
  initialAltitudeRef,
  refKinds,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: Props) {
  const [latDecimal, setLatDecimal] = useState<string>(
    initialLatDecimal === null ? "" : String(initialLatDecimal),
  );
  const [latRef, setLatRef] = useState<"N" | "S">(initialLatRef);
  const [lonDecimal, setLonDecimal] = useState<string>(
    initialLonDecimal === null ? "" : String(initialLonDecimal),
  );
  const [lonRef, setLonRef] = useState<"E" | "W">(initialLonRef);
  const [altMetres, setAltMetres] = useState<string>(
    initialAltitudeMetres === null || initialAltitudeMetres === undefined
      ? ""
      : String(Math.abs(initialAltitudeMetres)),
  );
  const [altRef, setAltRef] = useState<"above" | "below">(
    initialAltitudeRef ?? "above",
  );
  const [error, setError] = useState<string | null>(null);

  // Derive a signed map position when both coordinate strings are valid numbers in range
  const parseCoordinateInput = (val: string, maxVal: number): number | null => {
    const parsed = parseFloat(val);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maxVal) {
      return null;
    }
    return parsed;
  };

  const parsedLat = parseCoordinateInput(latDecimal, 90);
  const parsedLon = parseCoordinateInput(lonDecimal, 180);

  const signedPos =
    parsedLat !== null && parsedLon !== null
      ? {
          lat: latRef === "S" ? -parsedLat : parsedLat,
          lon: lonRef === "W" ? -parsedLon : parsedLon,
        }
      : null;

  const handleMapPositionSelect = (position: GpsPosition) => {
    if (readOnly) return;
    setLatDecimal(formatCoordinate(Math.abs(position.lat)));
    setLatRef(position.lat < 0 ? "S" : "N");

    setLonDecimal(formatCoordinate(Math.abs(position.lon)));
    setLonRef(position.lon < 0 ? "W" : "E");

    setError(null);
  };

  const handleSave = () => {
    if (readOnly) return;
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
    // Altitude is optional. Empty input keeps the existing on-disk altitude
    // untouched by emitting no draft for the altitude pair.
    const altTrim = altMetres.trim();
    let altitudeEdits: Array<{
      id: SchemaDefinitionId;
      edit: MetadataDraftEdit;
    }> = [];
    if (altTrim !== "") {
      const alt = parseFloat(altTrim);
      if (!Number.isFinite(alt) || alt < 0) {
        setError(
          "Altitude must be a non-negative number of metres (use above/below for sign).",
        );
        return;
      }
      altitudeEdits = [
        {
          id: group.altitudeId,
          edit: {
            value: { kind: "Real", value: alt },
            intent: "Set",
          },
        },
        // exiftool encodes AltitudeRef as 0 (above sea level) or 1 (below).
        {
          id: group.altitudeRefId,
          edit: refKinds?.altitude
            ? enumDraftEdit(refKinds.altitude, altRef === "above" ? "0" : "1")
            : {
                value: { kind: "Integer", value: altRef === "above" ? 0 : 1 },
                intent: "Set",
              },
        },
      ];
    }
    onSave([
      {
        id: group.latitudeId,
        edit: {
          value: { kind: "Real", value: lat },
          intent: "Set",
        },
      },
      {
        id: group.latitudeRefId,
        edit: refKinds?.latitude
          ? enumDraftEdit(refKinds.latitude, latRef)
          : {
              value: { kind: "Text", value: latRef },
              intent: "Set",
            },
      },
      {
        id: group.longitudeId,
        edit: {
          value: { kind: "Real", value: lon },
          intent: "Set",
        },
      },
      {
        id: group.longitudeRefId,
        edit: refKinds?.longitude
          ? enumDraftEdit(refKinds.longitude, lonRef)
          : {
              value: { kind: "Text", value: lonRef },
              intent: "Set",
            },
      },
      ...altitudeEdits,
    ]);
  };

  return (
    <ModalDialog
      open
      onDismiss={onCancel}
      testId="gps-editor-overlay"
      aria-label="Edit GPS location"
    >
      <div className="dialog-content dialog-content--gps">
        <h3>Edit GPS location</h3>
        {headerHint}
        <div className="dialog-body">
          <div className="gps-editor-map">
            <GpsMap
              position={signedPos}
              mode="picker"
              readOnly={readOnly}
              onPositionSelect={handleMapPositionSelect}
            />
            <div className="gps-editor-map-help">
              {readOnly
                ? "Drag to pan, and double-click or scroll to zoom. Location selection is disabled in read-only mode."
                : "Right-click or Shift+left-click to choose a location. Drag to pan, and double-click or scroll to zoom. Panning and zooming do not change the selected coordinates."}
            </div>
          </div>

          <div className="gps-editor-coordinate-grid">
            <div className="gps-editor-coordinate-field">
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
                onChange={(e) => {
                  setLatRef(e.target.value as "N" | "S");
                  setError(null);
                }}
                data-testid="gps-editor-lat-ref"
              >
                <option value="N">N</option>
                <option value="S">S</option>
              </select>
            </div>
            <div className="gps-editor-coordinate-field">
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
                onChange={(e) => {
                  setLonRef(e.target.value as "E" | "W");
                  setError(null);
                }}
                data-testid="gps-editor-lon-ref"
              >
                <option value="E">E</option>
                <option value="W">W</option>
              </select>
            </div>
          </div>

          <div className="gps-editor-row">
            <label>Altitude (m):</label>
            <input
              type="number"
              step="any"
              min="0"
              value={altMetres}
              onChange={(e) => {
                setAltMetres(e.target.value);
                setError(null);
              }}
              placeholder="optional"
              data-testid="gps-editor-alt-input"
              className="dialog-input"
            />
            <select
              value={altRef}
              onChange={(e) => {
                setAltRef(e.target.value as "above" | "below");
                setError(null);
              }}
              data-testid="gps-editor-alt-ref"
            >
              <option value="above">above sea level</option>
              <option value="below">below sea level</option>
            </select>
          </div>

          <details className="gps-editor-details">
            <summary>Details about paired metadata fields</summary>
            <p className="dialog-hint" data-testid="gps-editor-warning">
              Editing GPS location writes{" "}
              <code>
                {formatSchemaDefinitionIdForDiagnostics(group.latitudeId)}
              </code>
              ,{" "}
              <code>
                {formatSchemaDefinitionIdForDiagnostics(group.latitudeRefId)}
              </code>
              ,{" "}
              <code>
                {formatSchemaDefinitionIdForDiagnostics(group.longitudeId)}
              </code>
              ,{" "}
              <code>
                {formatSchemaDefinitionIdForDiagnostics(group.longitudeRefId)}
              </code>
              {", and (when altitude is filled in) "}
              <code>
                {formatSchemaDefinitionIdForDiagnostics(group.altitudeId)}
              </code>
              {", "}
              <code>
                {formatSchemaDefinitionIdForDiagnostics(group.altitudeRefId)}
              </code>{" "}
              together.
            </p>
          </details>

          {error && (
            <p className="dialog-error" data-testid="gps-editor-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button
            className="dialog-btn dialog-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={handleSave}
            data-testid="gps-editor-save"
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TOOLTIP : undefined}
          >
            Save
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
