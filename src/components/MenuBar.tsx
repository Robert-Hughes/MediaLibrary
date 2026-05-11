import { useSyncExternalStore } from "react";
import { useSpinnerSync } from "../hooks/useSpinnerSync";
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
        <span className="menu-bar-draft-summary">
          {`${draftEditsSummary.edits} draft edit${draftEditsSummary.edits === 1 ? "" : "s"} across ${draftEditsSummary.files} file${draftEditsSummary.files === 1 ? "" : "s"}`}
        </span>
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
