/**
 * Modal that drives the reverse-geocoding flow for a set of images.
 *
 * Three phases (no estimating step — there's nothing to compute up
 * front, and no cost):
 *
 *   awaiting-confirm → user reads the upload + tag-write warning,
 *                      confirms or cancels
 *   running          → backend hits Nominatim (+Overpass fallback),
 *                      drafts arrive per-image
 *   done             → succeeded/failed breakdown + source counters
 *
 * Thin wrapper around `BatchJobDialog` — the overlay, header, dialog
 * body frame, and Escape handling live there. This file supplies the
 * geocode-specific awaiting-confirm copy (which must spell out the
 * coherent-replacement rule from docs/REVERSE_GEOCODE_PLAN.md §1 —
 * fields the geocoder doesn't return are cleared on apply, so the user
 * understands what they're confirming) and the per-source done-panel
 * breakdown.
 */
import type { BatchFailureKind, GeocodeFailure, GeocodeProgressState, GeocodeSummary } from "../types";
import { BatchJobDialog } from "./BatchJobDialog";
import { BatchSummaryCountersRow } from "./BatchSummaryCountersRow";
import { RunningProgressPanel } from "./RunningProgressPanel";

interface Props {
  state: GeocodeProgressState;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}

/**
 * Map the backend's `kind` strings to a short human label. Mirrors the
 * AI-description equivalent so the failure-list visual idiom is
 * identical across both flows.
 */
export function friendlyFailureLabel(kind: BatchFailureKind): string {
  switch (kind) {
    case "no_gps":
      return "No GPS coordinates";
    case "nominatim_empty":
      return "Nominatim returned no usable address";
    case "http":
      return "Network request failed";
    case "network":
      return "Network error";
    case "cache_io":
      return "Could not read or write the geocache file";
    case "cancelled":
      return "Cancelled";
    case "command_failed":
      return "Geocode command failed to start";
    // Describe-only kinds; geocode should never emit them, but the union
    // is shared so list them for exhaustiveness.
    case "decode":
    case "incomplete":
    case "refused":
    case "bad_json":
    case "usage_parse":
    case "preflight_failed":
      return kind;
  }
}

function phaseTitle(state: GeocodeProgressState): string {
  switch (state.phase) {
    case "awaiting-confirm":
      return "Confirm reverse geocoding";
    case "running":
      return state.cancelling ? "Cancelling…" : "Reverse-geocoding…";
    case "done":
      return "Done";
  }
}

function FailureList({ failures }: { failures: GeocodeFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <details style={{ marginTop: 12 }} data-testid="geocode-failure-list">
      <summary style={{ cursor: "pointer", color: "var(--accent-error, #d33)" }}>
        {failures.length} failed
      </summary>
      <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12 }}>
        {failures.map((f) => (
          <li key={f.relativePath} title={`${f.kind}: ${f.detail}`}>
            <strong>{f.relativePath}</strong>: {friendlyFailureLabel(f.kind)}
            {f.detail && (
              <>
                {" — "}
                <span style={{ color: "var(--text-secondary)" }}>{f.detail}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function SummaryBreakdown({ s }: { s: GeocodeSummary }) {
  // Each counter rendered separately so the user can see exactly what
  // came from cache vs. the network — useful both for trust ("did this
  // hit the API at all?") and for understanding why a second run is
  // fast.
  return (
    <div
      style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
      data-testid="geocode-summary-breakdown"
    >
      <BatchSummaryCountersRow
        counters={[
          { label: "Cache hits", value: s.nSucceededFromCache },
          { label: "Nominatim", value: s.nSucceededFromNominatim },
          { label: "Nominatim+Overpass", value: s.nSucceededFromOverpass },
        ]}
      />
      <BatchSummaryCountersRow
        counters={[
          { label: "No GPS", value: s.nNoGps },
          { label: "Failed", value: s.nFailed },
        ]}
      />
    </div>
  );
}

/**
 * Awaiting-confirm panel body. Spells out exactly what data leaves
 * the machine, what tags will be written, and the coherent-replacement
 * rule (fields the geocoder doesn't return will be cleared). The
 * wording is deliberate — see docs/REVERSE_GEOCODE_PLAN.md §1 and §4.
 */
function AwaitingConfirmPanel({
  state,
  onCancel,
  onConfirm,
}: {
  state: GeocodeProgressState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const nWithoutGps = state.items.filter((i) => i.lat == null || i.lon == null).length;
  const word = state.total === 1 ? "image" : "images";
  return (
    <>
      <div className="dialog-hint" data-testid="geocode-confirm-summary">
        Ready to reverse-geocode {state.total} {word} using OpenStreetMap Nominatim, with Overpass
        fallback for named buildings and POIs.
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}>
        The <strong>GPS coordinates</strong> of each image will be sent to{" "}
        <code>nominatim.openstreetmap.org</code> and (when needed){" "}
        <code>overpass-api.de</code>. The images themselves are <strong>not</strong> uploaded.
        There is no cost.
      </div>
      <div style={{ marginTop: 12, fontSize: 12 }}>
        The following draft tags will be proposed per image, where data is available:
        <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.5 }}>
          <li>
            <code>XMP-iptcCore:Location</code> and <code>IPTC:Sub-location</code>
          </li>
          <li>
            <code>XMP-photoshop:City</code> and <code>IPTC:City</code>
          </li>
          <li>
            <code>XMP-photoshop:State</code> and <code>IPTC:Province-State</code>
          </li>
          <li>
            <code>XMP-photoshop:Country</code> and <code>IPTC:Country-PrimaryLocationName</code>
          </li>
          <li>
            <code>XMP-iptcCore:CountryCode</code> and <code>IPTC:Country-PrimaryLocationCode</code>
          </li>
        </ul>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}>
        Existing GPS values are <strong>not</strong> modified. Fields the geocoder doesn't return
        will be <strong>cleared as drafts</strong> (so the location group stays internally
        consistent). Nothing is written to disk until you apply drafts.
      </div>
      {nWithoutGps > 0 && (
        <div
          style={{ marginTop: 12, fontSize: 12, color: "var(--accent-error, #d33)" }}
          data-testid="geocode-no-gps-warning"
        >
          {nWithoutGps} of {state.total} selected {word} have no GPS coordinates and will be
          skipped.
        </div>
      )}
      <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          className="button button--secondary"
          onClick={onCancel}
          data-testid="geocode-cancel-btn"
        >
          Cancel
        </button>
        <button
          className="button button--primary"
          onClick={onConfirm}
          data-testid="geocode-confirm-btn"
          autoFocus
        >
          Confirm and geocode
        </button>
      </div>
    </>
  );
}

export function GeocodeProgressDialog({ state, onConfirm, onCancel, onClose }: Props) {
  return (
    <BatchJobDialog
      testidPrefix="geocode"
      width={560}
      phase={state.phase}
      title={phaseTitle(state)}
      onCancel={onCancel}
      onClose={onClose}
    >
      {state.phase === "awaiting-confirm" && (
        <AwaitingConfirmPanel state={state} onCancel={onCancel} onConfirm={onConfirm} />
      )}

      {state.phase === "running" && (
        <RunningProgressPanel
          testidPrefix="geocode-running"
          current={state.current}
          total={state.total}
          noun="image"
          failureCount={state.failures.length}
          currentFile={state.currentFile}
          cancelling={state.cancelling}
          onCancel={onCancel}
          footer={
            <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-secondary)" }}>
              Each result lands in drafts as soon as it arrives. Cancelling preserves results
              already returned.
            </div>
          }
        />
      )}

      {state.phase === "done" && (
        <>
          <div className="dialog-hint" data-testid="geocode-done-summary">
            Completed: {state.succeeded.length}/{state.total} succeeded
            {state.failures.length > 0 && (
              <span style={{ marginLeft: 8, color: "var(--accent-error, #d33)" }}>
                , {state.failures.length} failed
              </span>
            )}
          </div>
          {state.summary && <SummaryBreakdown s={state.summary} />}
          <FailureList failures={state.failures} />
          <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
            <button
              className="button button--primary"
              onClick={onClose}
              data-testid="geocode-close-btn"
              autoFocus
            >
              Close
            </button>
          </div>
        </>
      )}
    </BatchJobDialog>
  );
}

export default GeocodeProgressDialog;
