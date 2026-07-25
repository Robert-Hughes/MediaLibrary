import { useSyncExternalStore } from "react";
import { useSpinnerSync } from "../hooks/useSpinnerSync";
import { ask } from "@tauri-apps/plugin-dialog";
import type { MetadataProgressStore } from "../types";

interface Props {
  fileCount: number;
  /** When set and different from `fileCount`, count label shows "n of total" (filtered list). */
  fileCountTotal?: number;
  scanning: boolean;
  metadataProgress: MetadataProgressStore | null;
  selectedCount: number;
  draftEditsSummary?: { files: number; edits: number } | null;
  onClickDraftSummary?: () => void;
  onApplyAllEdits?: () => void;
  onDiscardAllEdits?: () => void;
}

export function StatusBar({
  fileCount,
  fileCountTotal,
  scanning,
  metadataProgress,
  selectedCount,
  draftEditsSummary = null,
  onClickDraftSummary,
  onApplyAllEdits,
  onDiscardAllEdits,
}: Props) {
  const spinStyle = useSpinnerSync();

  const metadataRemaining = useSyncExternalStore(
    metadataProgress?.subscribe.bind(metadataProgress) ?? (() => () => {}),
    metadataProgress?.getSnapshot().bind(metadataProgress) ?? (() => 0),
  );
  const metadataTotal = useSyncExternalStore(
    metadataProgress?.subscribe.bind(metadataProgress) ?? (() => () => {}),
    metadataProgress?.getTotalSnapshot().bind(metadataProgress) ?? (() => 0),
  );

  const metadataLoading = !scanning && metadataRemaining > 0;
  const metadataLoaded = metadataTotal - metadataRemaining;

  const countLabel =
    fileCountTotal != null && fileCountTotal !== fileCount
      ? `${fileCount} of ${fileCountTotal} file${fileCountTotal === 1 ? "" : "s"}`
      : `${fileCount} file${fileCount === 1 ? "" : "s"}`;

  return (
    <div className="status-bar" data-testid="status-bar">
      <div className="status-bar-left">
        <span className="status-bar-item" data-testid="status-bar-count">
          {countLabel}
        </span>

        {scanning && (
          <span className="status-bar-item" data-testid="status-bar-scanning">
            <span
              style={spinStyle}
              className="status-bar-spinner"
              aria-hidden="true"
            />
            <span>Discovering files…</span>
          </span>
        )}

        {metadataLoading && (
          <span className="status-bar-item" data-testid="status-bar-metadata">
            <span
              style={spinStyle}
              className="status-bar-spinner"
              data-testid="status-bar-metadata-spinner"
              aria-hidden="true"
            />
            <span data-testid="status-bar-metadata-label">
              Loading metadata… ({metadataLoaded} of {metadataTotal})
            </span>
          </span>
        )}

        {selectedCount > 0 && (
          <span className="status-bar-item" data-testid="status-bar-selection">
            {selectedCount} selected
          </span>
        )}
      </div>

      {draftEditsSummary && draftEditsSummary.files > 0 && (
        <div className="status-bar-right">
          <span
            className="status-bar-draft-summary"
            onClick={onClickDraftSummary}
            style={{ cursor: onClickDraftSummary ? "pointer" : "default" }}
            title={
              onClickDraftSummary ? "Show only files with edits" : undefined
            }
            data-testid="status-bar-draft-summary"
          >
            {`${draftEditsSummary.edits} draft edit${draftEditsSummary.edits === 1 ? "" : "s"} across ${draftEditsSummary.files} file${draftEditsSummary.files === 1 ? "" : "s"}`}
          </span>
          {onApplyAllEdits && (
            <button
              className="button button--primary status-bar-btn"
              onClick={async () => {
                const confirmed = await ask(
                  `Apply ${draftEditsSummary.edits} edit${draftEditsSummary.edits === 1 ? "" : "s"} across ${draftEditsSummary.files} file${draftEditsSummary.files === 1 ? "" : "s"}?\n\nThis will permanently modify the original image files. There is no backup.`,
                  { title: "Apply All Edits", kind: "warning" },
                );
                if (confirmed) onApplyAllEdits();
              }}
              data-testid="status-bar-apply-all-btn"
              title="Apply all draft edits to the original image files"
            >
              Apply All Edits…
            </button>
          )}
          {onDiscardAllEdits && (
            <button
              className="button button--secondary status-bar-btn"
              onClick={async () => {
                const confirmed = await ask(
                  `Are you sure you want to discard all ${draftEditsSummary.edits} edit${draftEditsSummary.edits === 1 ? "" : "s"} across ${draftEditsSummary.files} file${draftEditsSummary.files === 1 ? "" : "s"}?`,
                  { title: "Discard All Edits", kind: "warning" },
                );
                if (confirmed) onDiscardAllEdits();
              }}
              data-testid="status-bar-discard-all-btn"
              title="Discard all edits across all files"
            >
              Discard All…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
