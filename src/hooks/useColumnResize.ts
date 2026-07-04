/**
 * Owns the column-resize pointer drag for the photo-list grid.
 *
 * - `liveWidths` captures the in-flight width mid-drag (overrides the
 *   persisted `columnWidths` until pointer-up).
 * - `handleResetWidth` runs the auto-fit measurement using the DOM
 *   range trick (intrinsic content extent, not layout width).
 */
import { useCallback, useRef, useState } from "react";

const MIN_COL_WIDTH = 40;

function cssPixels(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

interface ResizeDrag {
  col: string;
  startX: number;
  startWidth: number;
  pointerId: number;
}

export function useColumnResize(
  columnWidths: Record<string, number>,
  onColumnWidthChange: ((col: string, width: number) => void) | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const resizeDragRef = useRef<ResizeDrag | null>(null);

  const effectiveWidths =
    Object.keys(liveWidths).length > 0
      ? { ...columnWidths, ...liveWidths }
      : columnWidths;

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, col: string) => {
      e.preventDefault();
      e.stopPropagation();
      const header = (e.currentTarget as HTMLElement).parentElement;
      if (!header) return;
      const startWidth = header.getBoundingClientRect().width;
      resizeDragRef.current = {
        col,
        startX: e.clientX,
        startWidth,
        pointerId: e.pointerId,
      };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [],
  );

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (
      !resizeDragRef.current ||
      resizeDragRef.current.pointerId !== e.pointerId
    )
      return;
    const { col, startX, startWidth } = resizeDragRef.current;
    const newWidth = Math.max(MIN_COL_WIDTH, startWidth + (e.clientX - startX));
    setLiveWidths((prev) => ({ ...prev, [col]: newWidth }));
  }, []);

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent) => {
      if (
        !resizeDragRef.current ||
        resizeDragRef.current.pointerId !== e.pointerId
      )
        return;
      const { col } = resizeDragRef.current;
      resizeDragRef.current = null;
      setLiveWidths((prev) => {
        const width = prev[col];
        if (width !== undefined && onColumnWidthChange)
          onColumnWidthChange(col, Math.round(width));
        return {};
      });
    },
    [onColumnWidthChange],
  );

  const handleResetWidth = useCallback(
    (col: string) => {
      if (!onColumnWidthChange) return;
      const container = containerRef.current;
      if (!container) {
        onColumnWidthChange(col, 0);
        return;
      }

      // Use Range.getBoundingClientRect() to get the intrinsic content
      // width. Unlike scrollWidth, this reports the actual rendered
      // content extent rather than the element's layout width, so it
      // works correctly whether the column is currently too wide or too
      // narrow.
      const range = document.createRange();
      let maxWidth = 0;
      const cells = container.querySelectorAll<HTMLElement>(
        `[data-col="${col}"]`,
      );
      // Compute padding once from the first cell — all share the same class.
      let cellPadding = 0;
      if (cells.length > 0) {
        const s = getComputedStyle(cells[0]);
        cellPadding = cssPixels(s.paddingLeft) + cssPixels(s.paddingRight);
      }
      cells.forEach((cell) => {
        const textSpan = cell.querySelector(".photo-cell-text");
        const badge = cell.querySelector(".row-draft-badge");
        let w = 0;
        if (textSpan || badge) {
          if (textSpan) {
            range.selectNodeContents(textSpan);
            w += range.getBoundingClientRect()?.width ?? 0;
          }
          if (badge) {
            w += badge.getBoundingClientRect().width + 8; // 8px gap
          }
        } else {
          range.selectNodeContents(cell);
          w = range.getBoundingClientRect()?.width ?? 0;
        }
        w += cellPadding;
        if (w > maxWidth) maxWidth = w;
      });

      // Header cell: select up to (not including) the ResizeHandle so the
      // handle's position at the column's right edge doesn't anchor the
      // measurement there.
      const handle = container.querySelector<HTMLElement>(
        `[data-testid="resize-handle-${col}"]`,
      );
      if (handle?.parentElement) {
        const headerCell = handle.parentElement;
        const hs = getComputedStyle(headerCell);
        const headerPadding =
          cssPixels(hs.paddingLeft) + cssPixels(hs.paddingRight);
        const headerParts = headerCell.querySelectorAll<HTMLElement>(
          ".grid-header-kind, .grid-header-label",
        );
        let headerContentWidth = 0;
        headerParts.forEach((part) => {
          range.selectNodeContents(part);
          const w = range.getBoundingClientRect?.().width ?? 0;
          if (w > headerContentWidth) headerContentWidth = w;
        });
        if (headerParts.length === 0) {
          range.setStart(headerCell, 0);
          range.setEndBefore(handle);
          headerContentWidth = range.getBoundingClientRect?.().width ?? 0;
        }
        const hw = headerContentWidth + headerPadding;
        if (hw > maxWidth) maxWidth = hw;
      }

      // Small breathing-room buffer so content is never right at the edge.
      const measured = maxWidth > 0 ? maxWidth + 4 : 0;
      onColumnWidthChange(col, measured);
    },
    [onColumnWidthChange, containerRef],
  );

  return {
    effectiveWidths,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    handleResetWidth,
  };
}
