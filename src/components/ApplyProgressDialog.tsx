import type { ApplyEditsInFlight } from "../types";

interface Props {
  applying: ApplyEditsInFlight;
  onCancel: () => void;
}

/**
 * Modal shown while apply_draft_edits_cmd is running.
 *
 * Blocks the rest of the UI so users can't issue conflicting commands while
 * exiftool is rewriting files.  Updates incrementally from the per-file
 * `apply_edits_progress` events emitted by the backend.
 */
export function ApplyProgressDialog({ applying, onCancel }: Props) {
  return (
    <div className="dialog-overlay" data-testid="apply-progress-dialog">
      <div className="dialog-content" style={{ width: 460 }}>
        <div className="dialog-header">
          <span className="dialog-title">
            {applying.cancelling ? "Cancelling…" : "Applying edits"}
          </span>
        </div>
        <div className="dialog-body">
          <div className="dialog-hint" data-testid="apply-progress-count">
            {applying.current} of {applying.total} {applying.total === 1 ? "file" : "files"}
            {applying.failureCount > 0 && (
              <span style={{ marginLeft: 12, color: "var(--accent-error, #d33)" }}>
                ({applying.failureCount} failed)
              </span>
            )}
          </div>

          <progress
            value={applying.current}
            max={Math.max(applying.total, 1)}
            style={{ width: "100%", height: 8 }}
            data-testid="apply-progress-bar"
          />

          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            data-testid="apply-progress-current-file"
            title={applying.currentFile ?? ""}
          >
            {applying.currentFile ?? " "}
          </div>

          <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
            <button
              className="button button--secondary"
              onClick={onCancel}
              disabled={applying.cancelling}
              data-testid="apply-progress-cancel-btn"
            >
              {applying.cancelling ? "Cancelling…" : "Cancel"}
            </button>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-secondary)" }}>
            Progress is saved after each file. If cancelled, files already
            processed remain applied; remaining edits stay as drafts.
          </div>
        </div>
      </div>
    </div>
  );
}

export default ApplyProgressDialog;
