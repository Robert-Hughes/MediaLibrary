interface Props {
  photoCount: number;
  scanning: boolean;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
}

export function MenuBar({ photoCount, scanning, onOpenFolder, onCloseFolder }: Props) {
  return (
    <div className="menu-bar" data-testid="menu-bar">
      <button className="menu-bar-btn" onClick={onOpenFolder} data-testid="menu-bar-open-btn">
        Open Folder
      </button>
      <button className="menu-bar-btn" onClick={onCloseFolder} data-testid="menu-bar-close-btn">
        Close
      </button>
      <div className="menu-bar-divider" />
      <span className="menu-bar-count" data-testid="menu-bar-count">
        {photoCount} photo{photoCount === 1 ? "" : "s"}
      </span>
      {scanning && (
        <span className="menu-bar-spinner" data-testid="menu-bar-spinner" aria-label="Scanning…" />
      )}
    </div>
  );
}
