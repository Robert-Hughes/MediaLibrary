interface Props {
  onOpenFolder: () => void;
  recentFolders: string[];
  onOpenRecent: (folder: string) => void;
}

export function WelcomeScreen({ onOpenFolder, recentFolders, onOpenRecent }: Props) {
  return (
    <div className="welcome-screen" data-testid="welcome-screen">
      <img src="/icon.png" alt="Media Library Logo" className="welcome-logo" />
      <h1 className="welcome-title">Media Library</h1>
      <p className="welcome-subtitle">Open a folder to browse your photos</p>
      <button
        className="btn-primary"
        onClick={onOpenFolder}
        data-testid="open-folder-btn"
      >
        Open Folder…
      </button>

      {recentFolders.length > 0 && (
        <div className="recent-folders" data-testid="recent-folders">
          <h2 className="recent-title">Recent Folders</h2>
          <ul className="recent-list">
            {recentFolders.map((folder) => (
              <li key={folder} className="recent-item">
                <button
                  className="recent-btn"
                  onClick={() => onOpenRecent(folder)}
                  title={folder}
                  data-testid="recent-folder-item"
                >
                  <span className="recent-icon">📁</span>
                  <span className="recent-path">{folder}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
