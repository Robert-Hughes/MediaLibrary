interface Props {
  onOpenFolder: () => void;
}

export function WelcomeScreen({ onOpenFolder }: Props) {
  return (
    <div className="welcome-screen" data-testid="welcome-screen">
      <h1 className="welcome-title">Media Library</h1>
      <p className="welcome-subtitle">Open a folder to browse your photos</p>
      <button
        className="btn-primary"
        onClick={onOpenFolder}
        data-testid="open-folder-btn"
      >
        Open Folder
      </button>
      <p className="welcome-hint">or press Space</p>
    </div>
  );
}
