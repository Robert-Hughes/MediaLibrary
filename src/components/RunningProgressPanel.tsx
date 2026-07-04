/**
 * Shared "running" panel used by `ApplyProgressDialog` and the running
 * phase of `DescribeProgressDialog`.
 *
 * The two flows have different phase machines (apply is a single panel;
 * describe wraps four phases), so they remain separate dialog components.
 * The visual idiom for the running phase itself — count line, progress
 * bar, current file, cancel button — is identical and was drifting
 * between the two; this component is the shared source of truth.
 */
import type { ReactNode } from "react";

interface Props {
  /** Prefix used for data-testids so each caller's existing selectors still resolve. */
  testidPrefix: string;
  current: number;
  total: number;
  /** Noun for the count line, e.g. "file" or "image". Pluralised by the panel. */
  noun: string;
  /** When non-zero, shown in red beside the count. */
  failureCount?: number;
  currentFile: string | null;
  cancelling: boolean;
  onCancel: () => void;
  /** Optional small-print footer (e.g. "Drafts saved after each image"). */
  footer?: ReactNode;
}

export function RunningProgressPanel({
  testidPrefix,
  current,
  total,
  noun,
  failureCount = 0,
  currentFile,
  cancelling,
  onCancel,
  footer,
}: Props) {
  return (
    <>
      <div className="dialog-hint" data-testid={`${testidPrefix}-count`}>
        {current} of {total} {total === 1 ? noun : `${noun}s`}
        {failureCount > 0 && (
          <span style={{ marginLeft: 12, color: "var(--accent-error, #d33)" }}>
            ({failureCount} failed)
          </span>
        )}
      </div>

      <progress
        value={current}
        max={Math.max(total, 1)}
        style={{ width: "100%", height: 8 }}
        data-testid={`${testidPrefix}-bar`}
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
        title={currentFile ?? ""}
        data-testid={`${testidPrefix}-current-file`}
      >
        {currentFile ?? " "}
      </div>

      <div
        style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}
      >
        <button
          className="button button--secondary"
          onClick={onCancel}
          disabled={cancelling}
          data-testid={`${testidPrefix}-cancel-btn`}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      </div>

      {footer}
    </>
  );
}

export default RunningProgressPanel;
