/**
 * Owns the photo-list multi-selection state and its keyboard nav.
 *
 * The parent's `selectedIndex` is the *anchor*; `selectedIndices`
 * captures additional rows added via Ctrl/Shift-click. Plain clicks
 * collapse the set back to a single item. Keyboard nav (arrows,
 * PageUp/Down, Home/End, Ctrl+A) lives on `document` so the list
 * responds even when no specific row currently has focus.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface RowSelectionConfig {
  photosLength: number;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onPhotoOpen: (index: number) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  rowHeight: number;
  onSelectionCountChange?: (count: number) => void;
}

export function useRowSelection(cfg: RowSelectionConfig) {
  const {
    photosLength,
    selectedIndex,
    onSelect,
    onPhotoOpen,
    listRef,
    rowHeight,
    onSelectionCountChange,
  } = cfg;

  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() =>
    selectedIndex !== null ? new Set([selectedIndex]) : new Set(),
  );
  const anchorRef = useRef<number | null>(selectedIndex);

  // Reset multi-selection when the parent's anchor changes externally
  // (e.g. keyboard nav, search clearing) so we never display stale
  // highlights.
  useEffect(() => {
    if (selectedIndex === null) {
      setSelectedIndices(new Set());
      anchorRef.current = null;
      return;
    }
    setSelectedIndices((prev) =>
      prev.has(selectedIndex) && prev.size > 0
        ? prev
        : new Set([selectedIndex]),
    );
    if (anchorRef.current === null) anchorRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    onSelectionCountChange?.(selectedIndices.size);
  }, [selectedIndices, onSelectionCountChange]);

  // Drop selections that no longer point to valid rows (search filter, etc.).
  useEffect(() => {
    setSelectedIndices((prev) => {
      const trimmed = new Set<number>();
      for (const i of prev) if (i >= 0 && i < photosLength) trimmed.add(i);
      return trimmed.size === prev.size ? prev : trimmed;
    });
  }, [photosLength]);

  const handleRowSelect = useCallback(
    (index: number, modifiers: { ctrl: boolean; shift: boolean }) => {
      if (modifiers.shift && anchorRef.current !== null) {
        const start = Math.min(anchorRef.current, index);
        const end = Math.max(anchorRef.current, index);
        const range = new Set<number>();
        for (let i = start; i <= end; i++) range.add(i);
        setSelectedIndices(range);
        onSelect(index);
        return;
      }
      if (modifiers.ctrl) {
        setSelectedIndices((prev) => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
        anchorRef.current = index;
        onSelect(index);
        return;
      }
      anchorRef.current = index;
      setSelectedIndices(new Set([index]));
      onSelect(index);
    },
    [onSelect],
  );

  /**
   * Right-click acts on the row under the cursor: if that row isn't
   * already part of the selection, collapse to it (matches OS
   * file-manager conventions and avoids surprising "this acts on N
   * rows" prompts). Returns nothing — caller still owns the
   * context-menu open state.
   */
  const handleRowContextMenu = useCallback(
    (index: number) => {
      setSelectedIndices((prev) => {
        if (prev.has(index)) return prev;
        anchorRef.current = index;
        onSelect(index);
        return new Set([index]);
      });
    },
    [onSelect],
  );

  // Keyboard nav lives on document. Refs avoid rebinding on every
  // photos/selectedIndex/rowHeight tick.
  const photosLenRef = useRef(photosLength);
  photosLenRef.current = photosLength;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;
  const onPhotoOpenRef = useRef(onPhotoOpen);
  onPhotoOpenRef.current = onPhotoOpen;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          t.isContentEditable
        )
          return;
      }
      // Keyboard events bubbling from native dialogs belong to that dialog.
      if ((e.target as Element | null)?.closest?.("dialog")) return;
      const len = photosLenRef.current;
      if (len === 0) return;
      const cur = selectedIndexRef.current;

      const moveTo = (next: number) => {
        e.preventDefault();
        const clamped = Math.max(0, Math.min(len - 1, next));
        if (e.shiftKey) {
          // Extend range from the existing anchor.  If no anchor yet,
          // treat the current row (or the destination) as the anchor
          // so the very first Shift+Arrow gesture still produces a
          // sensible range.
          if (anchorRef.current === null) {
            anchorRef.current = cur ?? clamped;
          }
          const a = anchorRef.current;
          const start = Math.min(a, clamped);
          const end = Math.max(a, clamped);
          const range = new Set<number>();
          for (let i = start; i <= end; i++) range.add(i);
          setSelectedIndices(range);
          onSelect(clamped);
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          // Additive: keep existing selection, just add the
          // destination row and make it the new anchor (matches
          // Ctrl+click semantics).
          setSelectedIndices((prev) => {
            const next = new Set(prev);
            next.add(clamped);
            return next;
          });
          anchorRef.current = clamped;
          onSelect(clamped);
          return;
        }
        anchorRef.current = clamped;
        setSelectedIndices(new Set([clamped]));
        onSelect(clamped);
      };

      // One page = number of fully-visible rows in the scroll
      // viewport. Falls back to 10 if the list hasn't measured yet.
      const pageStep = () => {
        const h = listRef.current?.clientHeight ?? 0;
        const rh = rowHeightRef.current || 1;
        return Math.max(1, Math.floor(h / rh) || 10);
      };

      if (e.key === "ArrowDown") {
        moveTo(cur === null ? 0 : cur + 1);
      } else if (e.key === "ArrowUp") {
        moveTo(cur === null ? 0 : cur - 1);
      } else if (e.key === "PageDown") {
        moveTo(cur === null ? 0 : cur + pageStep());
      } else if (e.key === "PageUp") {
        moveTo(cur === null ? 0 : cur - pageStep());
      } else if (e.key === "Home") {
        moveTo(0);
      } else if (e.key === "End") {
        moveTo(len - 1);
      } else if (e.key === "Enter") {
        if (cur !== null && cur >= 0 && cur < len) {
          e.preventDefault();
          onPhotoOpenRef.current(cur);
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        const all = new Set<number>();
        for (let i = 0; i < len; i++) all.add(i);
        setSelectedIndices(all);
        anchorRef.current = 0;
        // Update the parent's anchor too so subsequent shift/ctrl
        // gestures and the row-context-menu pickup the right "first
        // selected" row.
        if (cur === null) onSelect(0);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onSelect, listRef]);

  return {
    selectedIndices,
    handleRowSelect,
    handleRowContextMenu,
  };
}
