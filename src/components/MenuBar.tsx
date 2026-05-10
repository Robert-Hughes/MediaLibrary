import { useSyncExternalStore } from "react";
import { useSpinnerSync } from "../hooks/useSpinnerSync";
import type { MetadataProgressStore } from "../types";

interface Props {
  photoCount: number;
  scanning: boolean;
  metadataProgress: MetadataProgressStore | null;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
  onSelectColumns: () => void;
}

export function MenuBar({ photoCount, scanning, metadataProgress, onOpenFolder, onCloseFolder, onSelectColumns }: Props) {
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
        {photoCount} photo{photoCount === 1 ? "" : "s"}
      </span>
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
