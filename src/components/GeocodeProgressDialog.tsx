/**
 * Reverse-geocoding confirmation, progress and results for saved areas,
 * cached provider evidence and live Nominatim lookups.
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
   * already carry location data or provider evidence (in metadata or drafts).
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
  // Distinguish local saved-area matches, cached evidence and web lookups.
  return (
    <div
      style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
      data-testid="geocode-summary-breakdown"
    >
      <BatchSummaryCountersRow
        counters={[
          { label: "Saved areas", value: s.nSucceededFromSavedLocation ?? 0 },
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

/** Explain both draft paths and which coordinates leave the machine. */
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
        Ready to reverse-geocode {state.total} {word} using saved areas or
        OpenStreetMap Nominatim.
      </div>
      <div style={{ marginTop: 12, fontSize: 12 }}>
        <strong>Saved-area matches:</strong> use the configured location names
        to update <code>LocationCreated</code> and the related XMP/IPTC
        location, city, province/state, country and country-code fields. Blank
        configured fields clear the corresponding values. GPS coordinates are
        preserved. No web lookup or AI call is needed. Review and apply the
        drafts; Normalise Location is not needed for these matches.
      </div>
      <div style={{ marginTop: 12, fontSize: 12 }}>
        <strong>Other files:</strong> use cached Nominatim responses or a web
        lookup to propose the two raw evidence fields:
        <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.5 }}>
          <li>
            <code>XMP-mlib:ReverseGeocodeGeocodeJSON</code>
          </li>
          <li>
            <code>XMP-mlib:ReverseGeocodeJSONv2</code>
          </li>
        </ul>
        This path preserves existing location fields. Use Normalise Location
        afterwards to interpret the evidence into LocationCreated and its
        related XMP/IPTC fields.
      </div>
      <div
        style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}
      >
        Saved areas are checked before the cache or web lookup. Only the{" "}
        <strong>GPS coordinates</strong> of files needing a web lookup are sent
        to <code>nominatim.openstreetmap.org</code>. The files themselves are{" "}
        <strong>not</strong> uploaded. Reverse geocoding has no cost. Nothing is
        written until you apply drafts.
      </div>
      {overwriteInfo && (
        <OverwriteNotice
          testidPrefix="geocode"
          input={{
            existingCount: overwriteInfo.existingCount,
            totalCount: overwriteInfo.totalCount,
            title: "Update existing location data?",
            subjectSingular: "file",
            subjectPlural: "files",
            dataPhrase: "location data or reverse-geocode evidence",
            actionSingle:
              "Saved-area matches can replace LocationCreated and related XMP/IPTC fields; other files replace the GeocodeJSON and JSONv2 evidence drafts. EXIF GPS is preserved.",
            actionPluralPartial:
              "For those files, saved-area matches can replace LocationCreated and related XMP/IPTC fields; other files replace the GeocodeJSON and JSONv2 evidence drafts. EXIF GPS is preserved.",
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
          data-modal-initial-focus="true"
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
              data-modal-initial-focus="true"
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
