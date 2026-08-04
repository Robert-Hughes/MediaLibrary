/**
 * Modal that drives the reverse-geocoding flow for a set of files.
 *
 * Three phases (no estimating step — there's nothing to compute up
 * front, and no cost):
 *
 *   awaiting-confirm → user reads the upload + tag-write warning,
 *                      confirms or cancels
 *   running          → backend hits Nominatim,
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
import type {
  GeocodeFailure,
  GeocodeProgressState,
  GeocodeSummary,
} from "../types";
import { BatchJobDialog } from "./BatchJobDialog";
import { BatchSummaryCountersRow } from "./BatchSummaryCountersRow";
import { RunningProgressPanel } from "./RunningProgressPanel";
import { OverwriteNotice } from "./OverwriteNotice";
import { friendlyGeocodeFailureLabel } from "./batchHelpers";

export interface GeocodeOverwriteInfo {
  existingCount: number;
  totalCount: number;
}

interface Props {
  state: GeocodeProgressState;
  /**
   * Pre-computed by the caller: how many of the selected files
   * already carry any §1 location target tag (in metadata or drafts).
   * When `existingCount > 0` the awaiting-confirm panel surfaces an
   * inline overwrite notice.
   */
  overwriteInfo?: GeocodeOverwriteInfo;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
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
      <summary
        style={{ cursor: "pointer", color: "var(--accent-error, #d33)" }}
      >
        {failures.length} failed
      </summary>
      <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12 }}>
        {failures.map((f) => (
          <li key={f.relativePath} title={`${f.kind}: ${f.detail}`}>
            <strong>{f.relativePath}</strong>:{" "}
            {friendlyGeocodeFailureLabel(f.kind)}
            {f.detail && (
              <>
                {" — "}
                <span style={{ color: "var(--text-secondary)" }}>
                  {f.detail}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function SkippedList({ skipped }: { skipped: GeocodeFailure[] }) {
  if (skipped.length === 0) return null;
  return (
    <details style={{ marginTop: 12 }} data-testid="geocode-skipped-list">
      <summary style={{ cursor: "pointer", color: "var(--text-secondary)" }}>
        {skipped.length} skipped — no GPS coordinates
      </summary>
      <ul
        style={{
          marginTop: 6,
          paddingLeft: 18,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        {skipped.map((item) => (
          <li key={item.relativePath}>
            <strong>{item.relativePath}</strong>
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
  overwriteInfo,
  onCancel,
  onConfirm,
}: {
  state: GeocodeProgressState;
  overwriteInfo?: GeocodeOverwriteInfo;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const nWithoutGps = state.items.filter(
    (i) => i.lat == null || i.lon == null,
  ).length;
  const word = state.total === 1 ? "file" : "files";
  return (
    <>
      <div className="dialog-hint" data-testid="geocode-confirm-summary">
        Ready to reverse-geocode {state.total} {word} using OpenStreetMap
        Nominatim GeocodeJSON and JSONv2 evidence.
      </div>
      <div
        style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}
      >
        The <strong>GPS coordinates</strong> of each file will be sent to{" "}
        <code>nominatim.openstreetmap.org</code>. The files themselves are{" "}
        <strong>not</strong> uploaded. There is no cost.
      </div>
      <div style={{ marginTop: 12, fontSize: 12 }}>
        Two raw evidence tags will be proposed per file:
        <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.5 }}>
          <li>
            <code>XMP-mlib:ReverseGeocodeGeocodeJSON</code>
          </li>
          <li>
            <code>XMP-mlib:ReverseGeocodeJSONv2</code>
          </li>
        </ul>
      </div>
      <div
        style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}
      >
        These fields preserve Nominatim&apos;s responses verbatim. Existing
        location and EXIF GPS fields are not modified. Use Normalise Location to
        interpret the evidence into LocationCreated and its older XMP/IIM
        mirrors. Nothing is written until you apply drafts.
      </div>
      {overwriteInfo && (
        <OverwriteNotice
          testidPrefix="geocode"
          input={{
            existingCount: overwriteInfo.existingCount,
            totalCount: overwriteInfo.totalCount,
            title: "Overwrite reverse-geocode evidence?",
            subjectSingular: "file",
            subjectPlural: "files",
            dataPhrase: "reverse-geocode evidence",
            actionSingle:
              "Reverse-geocoding will replace the GeocodeJSON and JSONv2 evidence drafts; LocationCreated, EXIF GPS, and legacy location fields are not touched.",
            actionPluralPartial:
              "Reverse-geocoding will replace the GeocodeJSON and JSONv2 evidence drafts for those files; LocationCreated, EXIF GPS, and legacy location fields are not touched.",
          }}
        />
      )}
      {nWithoutGps > 0 && (
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: "var(--accent-error, #d33)",
          }}
          data-testid="geocode-no-gps-warning"
        >
          {nWithoutGps} of {state.total} selected {word} have no GPS coordinates
          and will be skipped.
        </div>
      )}
      <div
        style={{
          marginTop: 20,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
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

export function GeocodeProgressDialog({
  state,
  overwriteInfo,
  onConfirm,
  onCancel,
  onClose,
}: Props) {
  const skipped = state.failures.filter((failure) => failure.kind === "no_gps");
  const failures = state.failures.filter(
    (failure) => failure.kind !== "no_gps",
  );

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
        <AwaitingConfirmPanel
          state={state}
          overwriteInfo={overwriteInfo}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}

      {state.phase === "running" && (
        <RunningProgressPanel
          testidPrefix="geocode-running"
          current={state.current}
          total={state.total}
          noun="file"
          failureCount={failures.length}
          currentFile={state.currentFile}
          cancelling={state.cancelling}
          onCancel={onCancel}
          footer={
            <div
              style={{
                marginTop: 12,
                fontSize: 11,
                color: "var(--text-secondary)",
              }}
            >
              Each result lands in drafts as soon as it arrives. Cancelling
              preserves results already returned.
            </div>
          }
        />
      )}

      {state.phase === "done" && (
        <>
          <div className="dialog-hint" data-testid="geocode-done-summary">
            Completed: {state.succeeded.length}/{state.total} succeeded
            {skipped.length > 0 && (
              <span style={{ marginLeft: 8, color: "var(--text-secondary)" }}>
                , {skipped.length} skipped
              </span>
            )}
            {failures.length > 0 && (
              <span
                style={{ marginLeft: 8, color: "var(--accent-error, #d33)" }}
              >
                , {failures.length} failed
              </span>
            )}
          </div>
          {state.summary && <SummaryBreakdown s={state.summary} />}
          <SkippedList skipped={skipped} />
          <FailureList failures={failures} />
          <div
            style={{
              marginTop: 20,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
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
