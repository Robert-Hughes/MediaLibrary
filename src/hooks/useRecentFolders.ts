import { useCallback, useEffect, useState } from "react";
import { MAX_RECENT_FOLDERS, RECENT_FOLDERS_KEY } from "../utils/scanEvents";

/**
 * Persisted MRU list of opened folders. Stored in localStorage as a
 * plain JSON array of absolute paths. The hook returns the current
 * snapshot plus a `push(folder)` that moves the folder to the front,
 * caps the list, and persists.
 */
export function useRecentFolders(): [string[], (folder: string) => void] {
  const [recentFolders, setRecentFolders] = useState<string[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!saved) return;
    try {
      setRecentFolders(JSON.parse(saved));
    } catch (e) {
      console.error("Failed to load recent folders:", e);
    }
  }, []);

  const push = useCallback((folder: string) => {
    setRecentFolders((prev) => {
      const filtered = prev.filter((f) => f !== folder);
      const updated = [folder, ...filtered].slice(0, MAX_RECENT_FOLDERS);
      localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  return [recentFolders, push];
}
