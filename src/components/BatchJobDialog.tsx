/**
 * Shared chrome for batch-image-job dialogs (AI description, reverse
 * geocoding, and any future per-image batch job that uses
 * `useBatchImageJob`).
 *
 * Both flows have the same outer shape:
 *
 *   estimating?      → optional preflight panel (cost / token counts)
 *   awaiting-confirm → user reads the per-flow warning + confirms
 *   running          → progress bar + cancel
 *   done             → succeeded/failed breakdown
 *
 * The two flows had been drifting (header text, overlay markup, Escape
 * handling, dialog width) — extracting this shell is the
 * `BatchJobDialog` half of the refactor sketched in
 * docs/REVERSE_GEOCODE_PLAN.md §4. Per-flow panels are passed as a
 * single `children` slot so each caller stays in control of its own
 * testids and copy.
 *
 * Escape mirrors the per-phase intent: in `done` it acts as Close; in
 * every other phase it acts as Cancel. This matches the previous
 * inline behaviour of both DescribeProgressDialog and
 * GeocodeProgressDialog.
 */
import { useEffect, type ReactNode } from "react";

export type BatchJobPhase =
  "estimating" | "awaiting-confirm" | "running" | "done";

export interface BatchJobDialogProps {
  /**
   * Used as the `data-testid` on the dialog overlay so existing
   * per-flow selectors keep resolving (e.g. `describe-progress-dialog`,
   * `geocode-progress-dialog`).
   */
  testidPrefix: string;
  /** Pixel width of the dialog content panel. */
  width?: number;
  phase: BatchJobPhase;
  /** Header text for the current phase. */
  title: string;
  /** Per-phase body — caller renders the panel that matches `phase`. */
  children: ReactNode;
  onCancel: () => void;
  onClose: () => void;
}

export function BatchJobDialog({
  testidPrefix,
  width = 520,
  phase,
  title,
  children,
  onCancel,
  onClose,
}: BatchJobDialogProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (phase === "done") onClose();
      else onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [phase, onCancel, onClose]);

  return (
    <div
      className="dialog-overlay"
      data-testid={`${testidPrefix}-progress-dialog`}
    >
      <div className="dialog-content" style={{ width }}>
        <div className="dialog-header">
          <span className="dialog-title">{title}</span>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

export default BatchJobDialog;
