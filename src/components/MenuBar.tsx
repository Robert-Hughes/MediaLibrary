import { useSpinnerSync } from "../hooks/useSpinnerSync";

interface Props {
  photoCount: number;
  scanning: boolean;
  imageMetadataLoading: boolean;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
  onSelectColumns: () => void;
}

export function MenuBar({ photoCount, scanning, imageMetadataLoading, onOpenFolder, onCloseFolder, onSelectColumns }: Props) {
  const spinRef = useSpinnerSync<HTMLSpanElement>();
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
        <span ref={spinRef} className="menu-bar-spinner" data-testid="menu-bar-spinner" aria-label="Scanning…" />
      )}
      {!scanning && imageMetadataLoading && (
        <>
          <span ref={spinRef} className="menu-bar-spinner" data-testid="menu-bar-metadata-spinner" aria-label="Loading metadata…" />
          <span className="menu-bar-status" data-testid="menu-bar-metadata-label">Loading metadata…</span>
        </>
      )}
    </div>
  );
}
