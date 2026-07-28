/** Owns path-based file-list multi-selection and keyboard navigation. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function pathRange(
  paths: readonly string[],
  startPath: string,
  endPath: string,
) {
  const startIndex = paths.indexOf(startPath);
  const endIndex = paths.indexOf(endPath);
  if (startIndex < 0 || endIndex < 0) return new Set([endPath]);
  const start = Math.min(startIndex, endIndex);
  const end = Math.max(startIndex, endIndex);
  return new Set(paths.slice(start, end + 1));
}

export interface RowSelectionConfig {
  paths: readonly string[];
  selectedPath: string | null;
  onSelect: (relativePath: string | null) => void;
  onFileOpen: (relativePath: string) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  rowHeight: number;
  onSelectionCountChange?: (count: number) => void;
}

export function useRowSelection(cfg: RowSelectionConfig) {
  const {
    paths,
    selectedPath,
    onSelect,
    onFileOpen,
    listRef,
    rowHeight,
    onSelectionCountChange,
  } = cfg;
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() =>
    selectedPath === null ? new Set() : new Set([selectedPath]),
  );
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
  const anchorPathRef = useRef<string | null>(selectedPath);

  const selectedIndices = useMemo(() => {
    const result = new Set<number>();
    paths.forEach((path, index) => {
      if (selectedPaths.has(path)) result.add(index);
    });
    return result;
  }, [paths, selectedPaths]);

  useEffect(() => {
    if (selectedPath === null) {
      setSelectedPaths(new Set());
      anchorPathRef.current = null;
      return;
    }
    setSelectedPaths((prev) =>
      prev.has(selectedPath) && prev.size > 0 ? prev : new Set([selectedPath]),
    );
    if (anchorPathRef.current === null) anchorPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    onSelectionCountChange?.(selectedPaths.size);
  }, [selectedPaths, onSelectionCountChange]);

  // A completed filter change deliberately prunes hidden selections.
  useEffect(() => {
    const visible = new Set(paths);
    setSelectedPaths((prev) => {
      const trimmed = new Set([...prev].filter((path) => visible.has(path)));
      return trimmed.size === prev.size ? prev : trimmed;
    });
    if (anchorPathRef.current !== null && !visible.has(anchorPathRef.current)) {
      anchorPathRef.current =
        selectedPath && visible.has(selectedPath) ? selectedPath : null;
    }
  }, [paths, selectedPath]);

  const selectAll = useCallback(() => {
    if (paths.length === 0) return;
    setSelectedPaths(new Set(paths));
    anchorPathRef.current = paths[0];
    if (selectedPath === null) onSelect(paths[0]);
  }, [onSelect, paths, selectedPath]);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    anchorPathRef.current = null;
    onSelect(null);
  }, [onSelect]);

  const toggleAll = useCallback(() => {
    if (paths.length > 0 && selectedPathsRef.current.size === paths.length)
      clearSelection();
    else selectAll();
  }, [clearSelection, paths.length, selectAll]);

  const handleRowSelect = useCallback(
    (index: number, modifiers: { ctrl: boolean; shift: boolean }) => {
      const path = paths[index];
      if (!path) return;
      if (modifiers.shift && anchorPathRef.current !== null) {
        setSelectedPaths(pathRange(paths, anchorPathRef.current, path));
        onSelect(path);
        return;
      }
      if (modifiers.ctrl) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        anchorPathRef.current = path;
        onSelect(path);
        return;
      }
      anchorPathRef.current = path;
      setSelectedPaths(new Set([path]));
      onSelect(path);
    },
    [onSelect, paths],
  );

  const handleRowContextMenu = useCallback(
    (index: number) => {
      const path = paths[index];
      if (!path) return;
      setSelectedPaths((prev) => {
        if (prev.has(path)) return prev;
        anchorPathRef.current = path;
        onSelect(path);
        return new Set([path]);
      });
    },
    [onSelect, paths],
  );

  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;
  const onFileOpenRef = useRef(onFileOpen);
  onFileOpenRef.current = onFileOpen;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      if ((e.target as Element | null)?.closest?.("dialog")) return;
      const currentPaths = pathsRef.current;
      if (currentPaths.length === 0) return;
      const currentPath = selectedPathRef.current;
      const currentIndex =
        currentPath === null ? -1 : currentPaths.indexOf(currentPath);

      const moveTo = (index: number) => {
        e.preventDefault();
        const clamped = Math.max(0, Math.min(currentPaths.length - 1, index));
        const destination = currentPaths[clamped];
        if (e.shiftKey) {
          if (anchorPathRef.current === null)
            anchorPathRef.current = currentPath ?? destination;
          setSelectedPaths(
            pathRange(currentPaths, anchorPathRef.current, destination),
          );
          onSelect(destination);
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          setSelectedPaths((prev) => new Set(prev).add(destination));
          anchorPathRef.current = destination;
          onSelect(destination);
          return;
        }
        anchorPathRef.current = destination;
        setSelectedPaths(new Set([destination]));
        onSelect(destination);
      };

      const pageStep = () =>
        Math.max(
          1,
          Math.floor(
            (listRef.current?.clientHeight ?? 0) / (rowHeightRef.current || 1),
          ) || 10,
        );
      if (e.key === "ArrowDown")
        moveTo(currentIndex < 0 ? 0 : currentIndex + 1);
      else if (e.key === "ArrowUp")
        moveTo(currentIndex < 0 ? 0 : currentIndex - 1);
      else if (e.key === "PageDown")
        moveTo(currentIndex < 0 ? 0 : currentIndex + pageStep());
      else if (e.key === "PageUp")
        moveTo(currentIndex < 0 ? 0 : currentIndex - pageStep());
      else if (e.key === "Home") moveTo(0);
      else if (e.key === "End") moveTo(currentPaths.length - 1);
      else if (e.key === "Enter" && currentIndex >= 0 && currentPath !== null) {
        e.preventDefault();
        onFileOpenRef.current(currentPath);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        selectAll();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [listRef, onSelect, selectAll]);

  return {
    selectedIndices,
    selectAll,
    clearSelection,
    toggleAll,
    handleRowSelect,
    handleRowContextMenu,
  };
}
