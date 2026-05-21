/**
 * Owns the drag-to-reorder gesture for the photo-list column headers.
 *
 * Tracks the source column in a ref, the hovered drop target + side in
 * React state (so the header can paint a drop indicator), and computes
 * the final array order on drop.
 */
import { useCallback, useRef, useState } from "react";
import type { VisibleColumn } from "../types";

type DropSide = "before" | "after";

export interface ColumnDragOver {
  col: string;
  side: DropSide;
}

function dropSide(e: React.DragEvent): DropSide {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientX < rect.left + rect.width / 2 ? "before" : "after";
}

export function useColumnReorder(
  visibleColumns: VisibleColumn[],
  onColumnsReorder: ((cols: VisibleColumn[]) => void) | undefined,
) {
  const colDragRef = useRef<{ col: string } | null>(null);
  const [dragOver, setDragOver] = useState<ColumnDragOver | null>(null);

  const handleColDragStart = useCallback((e: React.DragEvent, col: string) => {
    colDragRef.current = { col };
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleColDragOver = useCallback((e: React.DragEvent, col: string) => {
    if (!colDragRef.current) return;
    e.preventDefault();
    if (colDragRef.current.col === col) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      setDragOver(null);
      return;
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOver({ col, side: dropSide(e) });
  }, []);

  // Allow drop anywhere on the wrapper while a column drag is in
  // progress so the browser shows the "move" cursor over gaps/body
  // instead of the no-entry symbol.
  const handleWrapperDragOver = useCallback((e: React.DragEvent) => {
    if (colDragRef.current) e.preventDefault();
  }, []);

  const handleColDragLeave = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDragOver(null);
    }
  }, []);

  const handleColDrop = useCallback((e: React.DragEvent, dropCol: string) => {
    e.preventDefault();
    const drag = colDragRef.current;
    colDragRef.current = null;
    setDragOver(null);
    if (!drag || drag.col === dropCol) return;

    const side = dropSide(e);

    /**
     * Compute insertion index after splice(from, 1).
     * - "before": insert at dropCol's post-removal position
     * - "after":  insert one past dropCol's post-removal position
     * When from < to, removing the source shifts dropCol left by 1.
     */
    const insertAt = (from: number, to: number) =>
      side === "before"
        ? (from < to ? to - 1 : to)
        : (from < to ? to : to + 1);

    const arr = [...visibleColumns];
    const from = arr.findIndex((c) => c.key === drag.col);
    const to = arr.findIndex((c) => c.key === dropCol);
    if (from === -1 || to === -1) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(insertAt(from, to), 0, moved);
    onColumnsReorder?.(arr);
  }, [visibleColumns, onColumnsReorder]);

  const handleColDragEnd = useCallback(() => {
    colDragRef.current = null;
    setDragOver(null);
  }, []);

  return {
    dragOver,
    handleColDragStart,
    handleColDragOver,
    handleColDragLeave,
    handleColDrop,
    handleColDragEnd,
    handleWrapperDragOver,
  };
}
