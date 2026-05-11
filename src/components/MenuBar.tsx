import { useSyncExternalStore } from "react";
import { useSpinnerSync } from "../hooks/useSpinnerSync";
import { ask } from "@tauri-apps/plugin-dialog";
import type { MetadataProgressStore } from "../types";

interface Props {
  photoCount: number;
  /** When set and different from `photoCount`, count label shows "n of total" (filtered list). */
  photoCountTotal?: number;
  scanning: boolean;
  metadataProgress: MetadataProgressStore | null;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
  onSelectColumns: () => void;
  draftEditsSummary?: { files: number; edits: number } | null;
  onClickDraftSummary?: () => void;
  onDiscardAllEdits?: () => void;
}

export function MenuBar({
  photoCount,
  photoCountTotal,
  scanning,
  metadataProgress,
  onOpenFolder,
  onCloseFolder,
  onSelectColumns,
  draftEditsSummary = null,
  onClickDraftSummary,
  onDiscardAllEdits,
}: Props) {
  const spinStyle = useSpinnerSync();
  
  // Subscribe to metadata progress store
  const metadataRemaining = useSyncExternalStore(
    metadataProgress?.subscribe.bind(metadataProgress) ?? (() => () => {}),
    metadataProgress?.getSnapshot().bind(metadataProgress) ?? (() => 0)
  );
  const metadataTotal = useSyncExternalStore(
    metadataProgress?.subscribe.bind(metadataProgress) ?? (() => () => {}),
    metadataProgress?.getTotalSnapshot().bind(metadataProgress) ?? (() => 0)
  );

  const imageMetadataLoading = metadataRemaining > 0;
  const metadataLoaded = metadataTotal - metadataRemaining;
  
  return (
    <div className="menu-bar" data-testid="menu-bar">
      <img src="/icon.png" alt="Icon" className="menu-bar-logo" />
      <button className="menu-bar-btn" onClick={onOpenFolder} data-testid="menu-bar-open-btn">
        Open Folder
      </button>
      <button className="menu-bar-btn" onClick={onCloseFolder} data-testid="menu-bar-close-btn">
        Close
      </button>
      <div className="menu-bar-divider" />
      <button className="menu-bar-btn" onClick={onSelectColumns} data-testid="menu-bar-columns-btn">
        Select Columns…
      </button>
      <div className="menu-bar-divider" />
      <span className="menu-bar-count" data-testid="menu-bar-count">
        {photoCountTotal != null && photoCountTotal !== photoCount
          ? `${photoCount} of ${photoCountTotal} photo${photoCountTotal === 1 ? "" : "s"}`
          : `${photoCount} photo${photoCount === 1 ? "" : "s"}`}
      </span>
      {draftEditsSummary && draftEditsSummary.files > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span 
            className="menu-bar-draft-summary"
            onClick={onClickDraftSummary}
            style={{ cursor: onClickDraftSummary ? "pointer" : "default" }}
            title={onClickDraftSummary ? "Show only photos with edits" : undefined}
          >
            {`${draftEditsSummary.edits} draft edit${draftEditsSummary.edits === 1 ? "" : "s"} across ${draftEditsSummary.files} file${draftEditsSummary.files === 1 ? "" : "s"}`}
          </span>
          {onDiscardAllEdits && (
            <button
              className="button button--secondary"
              style={{ padding: "2px 6px", fontSize: "11px", minHeight: "auto", borderRadius: "8px" }}
              onClick={async () => {
                const confirmed = await ask(`Are you sure you want to discard all ${draftEditsSummary.edits} edit${draftEditsSummary.edits === 1 ? "" : "s"} across ${draftEditsSummary.files} file${draftEditsSummary.files === 1 ? "" : "s"}?`, { title: "Discard All Edits", kind: "warning" });
                if (confirmed) onDiscardAllEdits();
              }}
              title="Discard all edits across all files"
            >
              Discard All
            </button>
          )}
        </div>
      ) : null}
      {scanning && (
        <span style={spinStyle} className="menu-bar-spinner" data-testid="menu-bar-spinner" aria-label="Scanning…" />
      )}
      {!scanning && imageMetadataLoading && (
        <>
          <span style={spinStyle} className="menu-bar-spinner" data-testid="menu-bar-metadata-spinner" aria-label="Loading metadata…" />
          <span className="menu-bar-status" data-testid="menu-bar-metadata-label">Loading metadata… ({metadataLoaded} of {metadataTotal})</span>
        </>
      )}
    </div>
  );
}
