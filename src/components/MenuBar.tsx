import { useTheme } from "../hooks/useTheme";

interface Props {
  onOpenFolder: () => void;
  onCloseFolder: () => void;
  onSelectColumns: () => void;
  onOpenSettings: () => void;
  /** Optional search wiring — when provided, MenuBar renders the search box in the right group. */
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export function MenuBar({
  onOpenFolder,
  onCloseFolder,
  onSelectColumns,
  onOpenSettings,
  searchQuery,
  onSearchQueryChange,
}: Props) {
  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <div className="menu-bar" data-testid="menu-bar">
      <div className="menu-bar-left">
        <button className="menu-bar-btn" onClick={onOpenFolder} data-testid="menu-bar-open-btn">
          Open Folder…
        </button>
        <button className="menu-bar-btn" onClick={onCloseFolder} data-testid="menu-bar-close-btn">
          Close Folder
        </button>
        <div className="menu-bar-divider" />
        <button className="menu-bar-btn" onClick={onSelectColumns} data-testid="menu-bar-columns-btn">
          Select Columns…
        </button>
        <button className="menu-bar-btn" onClick={onOpenSettings} data-testid="menu-bar-settings-btn">
          Settings…
        </button>
      </div>

      <div className="menu-bar-right">
        {onSearchQueryChange && (
          <div className="menu-bar-search" data-testid="menu-bar-search">
            <label className="list-search-label" htmlFor="list-search-input">Search</label>
            <input
              id="list-search-input"
              type="search"
              className="list-search-input"
              data-testid="list-search-input"
              placeholder="Path, file dates, image metadata…"
              value={searchQuery ?? ""}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              aria-label="Search photos"
            />
          </div>
        )}
        <button
          type="button"
          className="menu-bar-btn menu-bar-theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          data-testid="menu-bar-theme-toggle"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </div>
  );
}
