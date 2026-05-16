/**
 * Modal that owns the entire AI-description flow for a set of images.
 *
 * Walks through four phases without ever closing/reopening:
 *
 *   estimating       → preflight token-count calls per image
 *   awaiting-confirm → cost shown, user clicks Confirm or Cancel
 *   running          → /responses calls per image, drafts persisted
 *   done             → final usage summary and per-image outcomes
 *
 * Generalises the visual idiom from `ApplyProgressDialog` (overlay,
 * progress bar, current-file row) but adds the cost-confirm and final-
 * results panels so the user only sees one dialog through the whole
 * operation. Cancellation is a single backend `cancel_describe_cmd` call
 * that the loop honours at the next image boundary in either phase.
 */
import type {
  DescribeFailure,
  DescribeProgressState,
  DescribeUsageSummary,
} from "../types";

interface Props {
  state: DescribeProgressState;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}

function formatCost(usd: number): string {
  // Below a cent we want users to see the actual scale, not a confusing
  // "$0.00". Sub-cent costs are the norm for single-image runs.
  if (usd < 0.01 && usd > 0) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function PhaseHeader({ state }: { state: DescribeProgressState }) {
  const title = (() => {
    switch (state.phase) {
      case "estimating": return "Estimating cost…";
      case "awaiting-confirm": return "Confirm AI description";
      case "running": return state.cancelling ? "Cancelling…" : "Generating descriptions…";
      case "done": return "Done";
    }
  })();
  return (
    <div className="dialog-header">
      <span className="dialog-title">{title}</span>
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <progress
      value={current}
      max={Math.max(total, 1)}
      style={{ width: "100%", height: 8 }}
      data-testid="describe-progress-bar"
    />
  );
}

function FailureList({ failures }: { failures: DescribeFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <details style={{ marginTop: 12 }} data-testid="describe-failure-list">
      <summary style={{ cursor: "pointer", color: "var(--accent-error, #d33)" }}>
        {failures.length} failed
      </summary>
      <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12 }}>
        {failures.map((f) => (
          <li key={f.relativePath} title={f.detail}>
            <strong>{f.relativePath}</strong>: {f.kind} — {f.detail}
          </li>
        ))}
      </ul>
    </details>
  );
}

function UsageSummary({ s }: { s: DescribeUsageSummary }) {
  return (
    <div
      style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
      data-testid="describe-usage-summary"
    >
      <div>
        Input tokens: {s.totalInputTokens.toLocaleString()}
        {s.totalCachedTokens > 0 && (
          <> (cached {s.totalCachedTokens.toLocaleString()})</>
        )}
        {" · "}
        Output tokens: {s.totalOutputTokens.toLocaleString()}
      </div>
      <div>
        Predicted: {formatCost(s.predictedCostUsd)}{" · "}
        Actual: <strong>{formatCost(s.actualCostUsd)}</strong>
        {s.predictedCostUsd > 0 && (
          <> ({((s.actualCostUsd - s.predictedCostUsd) / s.predictedCostUsd * 100).toFixed(0)}% vs estimate)</>
        )}
      </div>
    </div>
  );
}

export function DescribeProgressDialog({ state, onConfirm, onCancel, onClose }: Props) {
  return (
    <div className="dialog-overlay" data-testid="describe-progress-dialog">
      <div className="dialog-content" style={{ width: 520 }}>
        <PhaseHeader state={state} />
        <div className="dialog-body">

          {/* ── Estimating phase ───────────────────────────────────────── */}
          {state.phase === "estimating" && (
            <>
              <div className="dialog-hint" data-testid="describe-estimate-count">
                Counting tokens: {state.current} of {state.total}{" "}
                {state.total === 1 ? "image" : "images"}
              </div>
              <ProgressBar current={state.current} total={state.total} />
              <div
                style={{
                  marginTop: 12, fontSize: 12, color: "var(--text-secondary)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
                title={state.currentFile ?? ""}
                data-testid="describe-current-file"
              >
                {state.currentFile ?? " "}
              </div>
              {state.estimateError && (
                <div
                  style={{ marginTop: 12, color: "var(--accent-error, #d33)", fontSize: 12 }}
                  data-testid="describe-estimate-error"
                >
                  {state.estimateError}
                </div>
              )}
              <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="button button--secondary"
                  onClick={onCancel}
                  data-testid="describe-cancel-btn"
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {/* ── Awaiting confirm ───────────────────────────────────────── */}
          {state.phase === "awaiting-confirm" && state.estimate && (
            <>
              <div className="dialog-hint" data-testid="describe-confirm-summary">
                Ready to describe {state.total}{" "}
                {state.total === 1 ? "image" : "images"} using{" "}
                <code>{state.estimate.model}</code>.
              </div>
              <div style={{ marginTop: 12, fontSize: 13 }}>
                <div>
                  Total input tokens: {state.estimate.totalInputTokens.toLocaleString()}
                </div>
                <div>
                  Estimated cost: <strong>{formatCost(state.estimate.predictedCostUsd)}</strong>
                </div>
                <div style={{ color: "var(--text-secondary)" }}>
                  Upper bound (if output hits the token cap): {formatCost(state.estimate.upperBoundCostUsd)}
                </div>
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-secondary)" }}>
                Each image is uploaded to OpenAI for analysis. Results land
                as draft edits under the XMP-mlib namespace and can be
                reviewed before applying.
              </div>
              <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  className="button button--secondary"
                  onClick={onCancel}
                  data-testid="describe-cancel-btn"
                >
                  Cancel
                </button>
                <button
                  className="button button--primary"
                  onClick={onConfirm}
                  data-testid="describe-confirm-btn"
                  autoFocus
                >
                  Confirm and run
                </button>
              </div>
            </>
          )}

          {/* ── Running ────────────────────────────────────────────────── */}
          {state.phase === "running" && (
            <>
              <div className="dialog-hint" data-testid="describe-running-count">
                {state.current} of {state.total}{" "}
                {state.total === 1 ? "image" : "images"}
                {state.failures.length > 0 && (
                  <span style={{ marginLeft: 12, color: "var(--accent-error, #d33)" }}>
                    ({state.failures.length} failed)
                  </span>
                )}
              </div>
              <ProgressBar current={state.current} total={state.total} />
              <div
                style={{
                  marginTop: 12, fontSize: 12, color: "var(--text-secondary)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
                title={state.currentFile ?? ""}
                data-testid="describe-current-file"
              >
                {state.currentFile ?? " "}
              </div>
              <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="button button--secondary"
                  onClick={onCancel}
                  disabled={state.cancelling}
                  data-testid="describe-cancel-btn"
                >
                  {state.cancelling ? "Cancelling…" : "Cancel"}
                </button>
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-secondary)" }}>
                Each image's description is added to your drafts as soon as
                it arrives. If cancelled, descriptions already produced
                remain in drafts.
              </div>
            </>
          )}

          {/* ── Done ───────────────────────────────────────────────────── */}
          {state.phase === "done" && (
            <>
              <div className="dialog-hint" data-testid="describe-done-summary">
                Completed: {state.succeeded.length}/{state.total} succeeded
                {state.failures.length > 0 && (
                  <span style={{ marginLeft: 8, color: "var(--accent-error, #d33)" }}>
                    , {state.failures.length} failed
                  </span>
                )}
              </div>
              {state.usageSummary && <UsageSummary s={state.usageSummary} />}
              <FailureList failures={state.failures} />
              <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="button button--primary"
                  onClick={onClose}
                  data-testid="describe-close-btn"
                  autoFocus
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default DescribeProgressDialog;
