interface Props {
  folder: string;
  fileCount: number;
  onOpenFolder: () => void;
  onCloseFolder: () => void;
}

export function Toolbar({
  folder,
  fileCount,
  onOpenFolder,
  onCloseFolder,
}: Props) {
  return (
    <div className="toolbar" data-testid="toolbar">
      <span
        className="toolbar-folder"
        data-testid="toolbar-folder"
        title={folder}
      >
        {folder}
      </span>
      <span className="toolbar-spacer" />
      <span className="toolbar-count" data-testid="toolbar-count">
        {fileCount} file{fileCount === 1 ? "" : "s"}
      </span>
      <div className="toolbar-divider" />
      <button
        className="toolbar-btn"
        onClick={onOpenFolder}
        data-testid="toolbar-open-btn"
        title="Open a different folder"
      >
        Open Folder…
      </button>
      <button
        className="toolbar-btn"
        onClick={onCloseFolder}
        data-testid="toolbar-close-btn"
        title="Close current folder"
      >
        Close
      </button>
    </div>
  );
}
