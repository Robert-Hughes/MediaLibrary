import { useState } from "react";
import { ModalDialog } from "./ModalDialog";
import type {
  ApplyEditsCompletion,
  ApplyEditsInFlight,
  MetadataDraftTarget,
} from "../types";
import type { TargetVerifyOutcomesByFile } from "../targetVerifyOutcomes";
import { TargetVerifyOutcomeDetails } from "./TargetVerifyOutcomeDialog";
import { RunningProgressPanel } from "./RunningProgressPanel";

interface Props {
  applying: ApplyEditsInFlight | null;
  completion: ApplyEditsCompletion | null;
  onCancel: () => void;
  onClose: () => void;
  verificationOutcomes: TargetVerifyOutcomesByFile;
  onAcceptVerification: (file: string, target: MetadataDraftTarget) => void;
  onKeepVerification: (file: string, target: MetadataDraftTarget) => void;
  onDiscardVerification: (file: string, target: MetadataDraftTarget) => void;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function ApplyProgressDialog({
  applying,
  completion,
  onCancel,
  onClose,
  verificationOutcomes,
  onAcceptVerification,
  onKeepVerification,
  onDiscardVerification,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!applying && !completion) return null;

  const summary = completion?.summary;
  const issues = completion?.issues ?? [];
  const verificationCount = Object.values(verificationOutcomes).reduce(
    (count, entries) => count + Object.keys(entries).length,
    0,
  );
  const detailCount = issues.length + verificationCount;
  const title = applying
    ? applying.cancelling
      ? "Cancelling…"
      : "Applying edits"
    : summary?.aborted
      ? "Apply stopped"
      : summary?.cancelled
        ? "Apply cancelled"
        : "Apply finished";

  return (
    <ModalDialog
      open
      onDismiss={applying ? onCancel : onClose}
      testId="apply-progress-dialog"
      aria-label={title}
    >
      <div
        className="dialog-content"
        style={{ width: 560, maxHeight: "85vh", overflowY: "auto" }}
      >
        <div className="dialog-header">
          <span className="dialog-title">{title}</span>
          <span data-testid="apply-progress-phase">Target-aware metadata</span>
        </div>
        <div className="dialog-body">
          {applying ? (
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
          ) : summary ? (
            <>
              <p
                data-testid="apply-complete-summary"
                style={{ fontSize: 16, marginTop: 0 }}
              >
                {countLabel(summary.applied, "applied", "applied")},{" "}
                {countLabel(summary.failed, "failed", "failed")},{" "}
                {countLabel(summary.warning_count, "warning")}
              </p>
              <p className="dialog-hint">
                Processed {summary.completed} of {summary.selected} selected
                files.
                {summary.cancelled
                  ? " The remaining edits are still drafts."
                  : ""}
                {summary.aborted && summary.abort_reason
                  ? ` ${summary.abort_reason}`
                  : ""}
              </p>
              {detailCount > 0 ? (
                <section>
                  <button
                    type="button"
                    className="dialog-btn dialog-btn-secondary"
                    onClick={() => setDetailsOpen((open) => !open)}
                    aria-expanded={detailsOpen}
                  >
                    {detailsOpen ? "Hide details" : "Show details"}
                  </button>
                  {detailsOpen ? (
                    <div
                      style={{ marginTop: 12 }}
                      data-testid="apply-complete-details"
                    >
                      {issues.map((issue, index) => (
                        <article
                          key={`${issue.severity}-${issue.relativePath}-${index}`}
                          style={{
                            borderTop: "1px solid var(--border-color)",
                            padding: "10px 0",
                          }}
                        >
                          <div style={{ fontWeight: 600 }}>
                            {issue.relativePath}
                          </div>
                          <div
                            style={{
                              color:
                                issue.severity === "error"
                                  ? "var(--accent-error, #d33)"
                                  : undefined,
                            }}
                          >
                            {issue.message}
                          </div>
                        </article>
                      ))}
                      {verificationCount > 0 ? (
                        <TargetVerifyOutcomeDetails
                          outcomes={verificationOutcomes}
                          onAccept={onAcceptVerification}
                          onKeep={onKeepVerification}
                          onDiscard={onDiscardVerification}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : (
                <p>No file-level errors or warnings were reported.</p>
              )}
            </>
          ) : null}
        </div>
        {!applying ? (
          <div className="dialog-footer">
            <button className="dialog-btn dialog-btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

export default ApplyProgressDialog;
