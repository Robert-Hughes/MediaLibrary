import type { ApplyEditsInFlight } from "../types";
import { RunningProgressPanel } from "./RunningProgressPanel";
import { useDialogEscape } from "../hooks/useDialogEscape";

interface Props {
  applying: ApplyEditsInFlight;
  onCancel: () => void;
}

/**
 * Modal shown while `apply_metadata_draft_edits_cmd` is running.
 *
 * Blocks the rest of the UI so users can't issue conflicting commands while
 * exiftool is rewriting files.  Updates incrementally from the per-file
 * `apply_metadata_edits_progress` events emitted by the backend.
 *
 * The body shares its layout with the running phase of
 * `DescribeProgressDialog` via `RunningProgressPanel` — the testids and
 * copy stay caller-specific, but the structure has one home.
 */
export function ApplyProgressDialog({ applying, onCancel }: Props) {
  useDialogEscape(onCancel);

  return (
    <div className="dialog-overlay" data-testid="apply-progress-dialog">
      <div className="dialog-content" style={{ width: 460 }}>
        <div className="dialog-header">
          <span className="dialog-title">
            {applying.cancelling ? "Cancelling…" : "Applying edits"}
          </span>
        </div>
        <div className="dialog-body">
          <RunningProgressPanel
            testidPrefix="apply-progress"
            current={applying.current}
            total={applying.total}
            noun="file"
            failureCount={applying.failureCount}
            currentFile={applying.currentFile}
            cancelling={applying.cancelling}
            onCancel={onCancel}
            footer={
              <div
                style={{
                  marginTop: 12,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                }}
              >
                Progress is saved after each file. If cancelled, files already
                processed remain applied; remaining edits stay as drafts.
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

export default ApplyProgressDialog;
