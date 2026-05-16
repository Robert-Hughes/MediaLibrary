import { useEffect, useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, SortConfig, VisibleColumn } from "../types";
import { ContextMenu } from "./ContextMenu";
import { PhotoRow } from "./PhotoRow";
import { ResizeHandle } from "./ResizeHandle";
import { ask } from "@tauri-apps/plugin-dialog";
import { nextSortConfig } from "../utils/sorting";

interface Props {
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  imageMetadata: ImageMetadataStore;
  visibleColumns: VisibleColumn[];
  columnWidths?: Record<string, number>;
  onColumnWidthChange?: (col: string, width: number) => void;
  onColumnsReorder?: (columns: VisibleColumn[]) => void;
  sortConfig: SortConfig;
  onSortChange: (config: SortConfig) => void;
  /** When true, sort-toggle clicks are ignored and the ▲/▼ markers are hidden.
   *  Set during scanning to make it visually clear that sorting isn't active. */
  sortingDisabled?: boolean;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onShowInExplorer: (index: number) => void;
  onVisibilityChange: (visiblePaths: string[]) => void;
  onPhotoOpen: (index: number) => void;
  onSelectColumns?: () => void;
  /** Case-insensitive substring match highlighting in visible cells. */
  searchQuery?: string;
  /** Shown in the grid body when `photos` is empty but the folder is not (search had no hits). */
  emptySearchMessage?: string | null;
  draftEdits?: Record<string, Record<string, string | null>>;
  onDiscardAllEdits?: (fileRelativePaths: string[]) => void;
  onApplyEdits?: (fileRelativePaths: string[]) => void;
  /** Trigger AI-description flow for the given relative paths. */
  onGenerateAiDescription?: (fileRelativePaths: string[]) => void;
}

const MIN_COL_WIDTH = 40;
const DEFAULT_PREVIEW_COL_WIDTH = 52;
const MIN_ROW_HEIGHT = 44;
const THUMBNAIL_CELL_GUTTER = 8;
const PREVIEW_ASPECT_HEIGHT = 3;
const PREVIEW_ASPECT_WIDTH = 4;

/**
 * Return the visible paths that still need a thumbnail or metadata load,
 * in the iteration order of `visible` (which matches display top-to-bottom).
 *
 * Iterates `visible` directly — O(V), not O(total photos) — so a 30-row
 * scroll on a 10k-photo library doesn't scan the full list.
 */
export function selectVisibleNeedingLoad(
  visible: Iterable<string>,
  thumbnails: { get: (path: string) => unknown },
  imageMetadata: { get: (path: string) => unknown },
): string[] {
  const out: string[] = [];
  for (const path of visible) {
    if (thumbnails.get(path) === "loading" || imageMetadata.get(path) === "loading") {
      out.push(path);
    }
  }
  return out;
}

function buildGridTemplate(
  visibleColumns: VisibleColumn[],
  widths: Record<string, number>,
): string {
  const w = (key: string, def: string) => widths[key] ? `${widths[key]}px` : def;
  return [
    w("preview", "52px"),
    w("relative_path", "minmax(200px, 2fr)"),
    ...visibleColumns.map((c) =>
      w(c.key, c.kind === "os" ? "minmax(120px, 1fr)" : "minmax(150px, 1fr)"),
    ),
  ].join(" ");
}

function previewColumnWidth(widths: Record<string, number>): number {
  return widths.preview || DEFAULT_PREVIEW_COL_WIDTH;
}

function rowHeightForPreview(width: number): number {
  const thumbnailWidth = Math.max(0, width - THUMBNAIL_CELL_GUTTER);
  const thumbnailHeight = Math.round((thumbnailWidth * PREVIEW_ASPECT_HEIGHT) / PREVIEW_ASPECT_WIDTH);
  return Math.max(MIN_ROW_HEIGHT, thumbnailHeight + THUMBNAIL_CELL_GUTTER);
}

function SortIndicator({ column, sortConfig, disabled }: { column: string; sortConfig: SortConfig; disabled?: boolean }) {
  if (disabled) return null;
  const { primary, secondary } = sortConfig;
  if (primary?.column === column) {
    return <span className="sort-indicator sort-indicator--primary">{primary.direction === "asc" ? " ▲" : " ▼"}</span>;
  }
  if (secondary?.column === column) {
    return <span className="sort-indicator sort-indicator--secondary">{secondary.direction === "asc" ? " ▲" : " ▼"}</span>;
  }
  return null;
}

interface HeaderProps {
  visibleColumns: VisibleColumn[];
  sortConfig: SortConfig;
  sortingDisabled?: boolean;
  dragOver: { col: string; side: "before" | "after" } | null;
  onColumnContextMenu: (e: React.MouseEvent) => void;
  onColumnClick: (column: string, columnType: "path" | "os" | "image") => void;
  onResizeStart: (e: React.PointerEvent, col: string) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
  onResetWidth: (col: string) => void;
  onColDragStart: (e: React.DragEvent, col: string) => void;
  onColDragOver: (e: React.DragEvent, col: string) => void;
  onColDragLeave: (e: React.DragEvent) => void;
  onColDrop: (e: React.DragEvent, col: string) => void;
  onColDragEnd: () => void;
}

const OS_COLUMN_LABELS: Record<string, string> = {
  date_modified: "Modified",
  date_created: "Created",
};

const KIND_LABELS: Record<VisibleColumn["kind"], string> = {
  os: "OS",
  image: "Image",
};

function cssPixels(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function PhotoListHeader(props: HeaderProps) {
  const {
    visibleColumns, sortConfig, sortingDisabled, dragOver,
    onColumnContextMenu, onColumnClick,
    onResizeStart, onResizeMove, onResizeEnd, onResetWidth,
    onColDragStart, onColDragOver, onColDragLeave, onColDrop, onColDragEnd,
  } = props;

  const headerClass = (col: string) => {
    const drop = dragOver?.col === col ? ` grid-header--drop-${dragOver.side}` : "";
    return `grid-header grid-header--sortable${drop}`;
  };

  // Headers span both header rows so the kind label and column label share the
  // same height and interaction target.
  return (
    <>
      <div
        className="grid-header grid-header--metadata"
        style={{ gridRow: "1 / 3", gridColumn: 1 }}
      >
        <span className="grid-header-kind grid-header-kind--empty" aria-hidden="true" />
        <span className="grid-header-label">Preview</span>
        <ResizeHandle col="preview" onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} onReset={onResetWidth} />
      </div>
      <div
        className="grid-header grid-header--sortable grid-header--metadata"
        style={{ gridRow: "1 / 3", gridColumn: 2 }}
        onContextMenu={onColumnContextMenu}
        onClick={() => onColumnClick("relative_path", "path")}
      >
        <span className="grid-header-kind">OS</span>
        <span className="grid-header-label">
          Path
          <SortIndicator column="relative_path" sortConfig={sortConfig} disabled={sortingDisabled} />
        </span>
        <ResizeHandle col="relative_path" onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} onReset={onResetWidth} />
      </div>

      {visibleColumns.map((col, i) => {
        const label = col.kind === "os" ? (OS_COLUMN_LABELS[col.key] ?? col.key) : col.key;
        return (
          <div
            key={col.key}
            className={`${headerClass(col.key)} grid-header--metadata`}
            style={{ gridRow: "1 / 3", gridColumn: 3 + i }}
            draggable
            onDragStart={(e) => onColDragStart(e, col.key)}
            onDragOver={(e) => onColDragOver(e, col.key)}
            onDragLeave={onColDragLeave}
            onDrop={(e) => onColDrop(e, col.key)}
            onDragEnd={onColDragEnd}
            onContextMenu={onColumnContextMenu}
            onClick={() => onColumnClick(col.key, col.kind)}
          >
            <span className="grid-header-kind">{KIND_LABELS[col.kind]}</span>
            <span className="grid-header-label">
              {label}
              <SortIndicator column={col.key} sortConfig={sortConfig} disabled={sortingDisabled} />
            </span>
            <ResizeHandle col={col.key} onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} onReset={onResetWidth} />
          </div>
        );
      })}
    </>
  );
}

export function PhotoList({
  photos, thumbnails, imageMetadata, visibleColumns,
  columnWidths = {}, onColumnWidthChange,
  onColumnsReorder,
  sortConfig, onSortChange, sortingDisabled,
  selectedIndex, onSelect, onShowInExplorer, onVisibilityChange, onPhotoOpen, onSelectColumns,
  searchQuery = "",
  emptySearchMessage = null,
  draftEdits = {},
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<Set<string>>(new Set());

  // Live column widths during a resize drag (overrides saved widths until pointer up)
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const resizeDragRef = useRef<{ col: string; startX: number; startWidth: number; pointerId: number } | null>(null);

  // Column drag-and-drop reorder state
  const colDragRef = useRef<{ col: string } | null>(null);
  const [dragOver, setDragOver] = useState<{ col: string; side: "before" | "after" } | null>(null);

  const effectiveWidths = Object.keys(liveWidths).length > 0
    ? { ...columnWidths, ...liveWidths }
    : columnWidths;
  const rowHeight = rowHeightForPreview(previewColumnWidth(effectiveWidths));
  const thumbnailHeight = Math.max(0, rowHeight - THUMBNAIL_CELL_GUTTER);
  
  // Use refs for callbacks to avoid re-creating observers when they change
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;
  
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Set up virtualizer
  const rowVirtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowHeight, // Matches --row-height below.
    overscan: 10, // Render 10 extra rows above/below viewport for smooth scrolling
  });

  // When rowHeight changes (e.g. preview column resize), the virtualizer's
  // cached item sizes become stale.  measure() clears the cache so every item
  // is re-estimated with the new height on the next layout pass.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  const virtualItems = rowVirtualizer.getVirtualItems();

  // Track visibility for prioritization
  useEffect(() => {
    const notify = () => {
      const visibleOrdered = selectVisibleNeedingLoad(visibleRef.current, thumbnails, imageMetadata);
      if (visibleOrdered.length > 0) {
        onVisibilityChangeRef.current(visibleOrdered);
      }
    };

    // Update visible set based on virtual items
    const updateVisible = () => {
      const newVisible = new Set<string>();
      for (const virtualItem of virtualItems) {
        const photo = photosRef.current[virtualItem.index];
        if (photo) {
          newVisible.add(photo.relative_path);
        }
      }
      
      // Check if visibility changed
      if (newVisible.size !== visibleRef.current.size || 
          ![...newVisible].every(p => visibleRef.current.has(p))) {
        visibleRef.current = newVisible;
        notify();
      }
    };

    updateVisible();
  }, [virtualItems, thumbnails, imageMetadata]);

  // Defensive kickstart: when photos first appear in a scan, notify about the
  // first 30 paths that still need loading.  This runs once per scan so the
  // backend can begin draining the prioritised queue before the virtualizer
  // has measured the DOM.  After this fires, the visibility-tracking effect
  // above takes over.
  //
  // The latch is keyed by `thumbnails` identity: a new scan installs new store
  // instances, which resets the latch and lets the kickstart fire again.
  const kickstartedForStoreRef = useRef<ThumbnailStore | null>(null);
  useEffect(() => {
    if (photos.length === 0) return;
    if (kickstartedForStoreRef.current === thumbnails) return;
    kickstartedForStoreRef.current = thumbnails;

    const initialPaths: string[] = [];
    const limit = Math.min(30, photos.length);
    for (let i = 0; i < limit; i++) {
      const path = photos[i].relative_path;
      if (thumbnails.get(path) === "loading" || imageMetadata.get(path) === "loading") {
        initialPaths.push(path);
      }
    }

    if (initialPaths.length > 0) {
      onVisibilityChange(initialPaths);
    }
  }, [photos, thumbnails, imageMetadata, onVisibilityChange]);

  useEffect(() => {
    if (selectedIndex !== null && listRef.current) {
      // Scroll to selected index using virtualizer
      rowVirtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    }
  }, [selectedIndex, rowVirtualizer]);

  // Multi-select state. `selectedIndex` from the parent is the anchor; the
  // internal Set captures additional rows added via Ctrl/Shift-click. Plain
  // clicks collapse the set back to a single item.
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() =>
    selectedIndex !== null ? new Set([selectedIndex]) : new Set(),
  );
  const anchorRef = useRef<number | null>(selectedIndex);

  // Reset multi-selection when the parent's anchor changes externally
  // (e.g. keyboard nav, search clearing) so we never display stale highlights.
  useEffect(() => {
    if (selectedIndex === null) {
      setSelectedIndices(new Set());
      anchorRef.current = null;
      return;
    }
    setSelectedIndices((prev) => (prev.has(selectedIndex) && prev.size > 0 ? prev : new Set([selectedIndex])));
    if (anchorRef.current === null) anchorRef.current = selectedIndex;
  }, [selectedIndex]);

  // Drop selections that no longer point to valid rows (search filter, etc.).
  useEffect(() => {
    setSelectedIndices((prev) => {
      const trimmed = new Set<number>();
      for (const i of prev) if (i >= 0 && i < photos.length) trimmed.add(i);
      return trimmed.size === prev.size ? prev : trimmed;
    });
  }, [photos.length]);

  const handleRowSelect = useCallback((index: number, modifiers: { ctrl: boolean; shift: boolean }) => {
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
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
      anchorRef.current = index;
      onSelect(index);
      return;
    }
    anchorRef.current = index;
    setSelectedIndices(new Set([index]));
    onSelect(index);
  }, [onSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault();
    // If right-clicking a row that's not already part of the selection,
    // collapse the selection to that row first — matches OS file-manager
    // conventions and avoids surprising "this acts on N rows" prompts.
    setSelectedIndices((prev) => {
      if (prev.has(index)) return prev;
      anchorRef.current = index;
      onSelect(index);
      return new Set([index]);
    });
    setContextMenu({ x: e.clientX, y: e.clientY, index });
  }, [onSelect]);

  const handleColumnContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (onSelectColumns) {
      setColumnContextMenu({ x: e.clientX, y: e.clientY });
    }
  }, [onSelectColumns]);

  const handleColumnClick = useCallback((column: string, columnType: "path" | "os" | "image") => {
    // Clicks are always honoured — sortingDisabled only governs whether the
    // *resulting* sort applies and is shown.  Without this, once a user lands
    // in a suspended state (e.g., image-column sort while metadata is still
    // loading) they would be unable to click an OS column to escape it.
    onSortChange(nextSortConfig(sortConfig, column, columnType));
  }, [onSortChange, sortConfig]);

  const handleResizeStart = useCallback((e: React.PointerEvent, col: string) => {
    e.preventDefault();
    e.stopPropagation();
    const header = (e.currentTarget as HTMLElement).parentElement;
    if (!header) return;
    const startWidth = header.getBoundingClientRect().width;
    resizeDragRef.current = { col, startX: e.clientX, startWidth, pointerId: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeDragRef.current || resizeDragRef.current.pointerId !== e.pointerId) return;
    const { col, startX, startWidth } = resizeDragRef.current;
    const newWidth = Math.max(MIN_COL_WIDTH, startWidth + (e.clientX - startX));
    setLiveWidths((prev) => ({ ...prev, [col]: newWidth }));
  }, []);

  const handleResizeEnd = useCallback((e: React.PointerEvent) => {
    if (!resizeDragRef.current || resizeDragRef.current.pointerId !== e.pointerId) return;
    const { col } = resizeDragRef.current;
    resizeDragRef.current = null;
    setLiveWidths((prev) => {
      const width = prev[col];
      if (width !== undefined && onColumnWidthChange) onColumnWidthChange(col, Math.round(width));
      return {};
    });
  }, [onColumnWidthChange]);

  const handleResetWidth = useCallback((col: string) => {
    if (!onColumnWidthChange) return;
    const container = listRef.current;
    if (!container) { onColumnWidthChange(col, 0); return; }

    // Use Range.getBoundingClientRect() to get the intrinsic content width.
    // Unlike scrollWidth, this reports the actual rendered content extent rather
    // than the element's layout width, so it works correctly whether the column
    // is currently too wide or too narrow.
    const range = document.createRange();
    let maxWidth = 0;
    const cells = container.querySelectorAll<HTMLElement>(`[data-col="${col}"]`);
    // Compute padding once from the first cell — all share the same class.
    let cellPadding = 0;
    if (cells.length > 0) {
      const s = getComputedStyle(cells[0]);
      cellPadding = cssPixels(s.paddingLeft) + cssPixels(s.paddingRight);
    }
    cells.forEach((cell) => {
      const textSpan = cell.querySelector('.photo-cell-text');
      const badge = cell.querySelector('.row-draft-badge');
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

    // Header cell: select up to (not including) the ResizeHandle so the handle's
    // position at the column's right edge doesn't anchor the measurement there.
    const handle = container.querySelector<HTMLElement>(`[data-testid="resize-handle-${col}"]`);
    if (handle?.parentElement) {
      const headerCell = handle.parentElement;
      const hs = getComputedStyle(headerCell);
      const headerPadding = cssPixels(hs.paddingLeft) + cssPixels(hs.paddingRight);
      const headerParts = headerCell.querySelectorAll<HTMLElement>(".grid-header-kind, .grid-header-label");
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
  }, [onColumnWidthChange]);

  const handleColDragStart = useCallback((e: React.DragEvent, col: string) => {
    colDragRef.current = { col };
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }, []);

  /** Returns "before" | "after" based on whether the cursor is in the left or right half of the element. */
  const dropSide = (e: React.DragEvent): "before" | "after" => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

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

  // Allow drop anywhere on the wrapper while a column drag is in progress so the
  // browser shows the "move" cursor over gaps/body instead of the no-entry symbol.
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

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number } | null>(null);
  const [columnContextMenu, setColumnContextMenu] = useState<{ x: number, y: number } | null>(null);

  const headerProps: HeaderProps = {
    visibleColumns, sortConfig, sortingDisabled, dragOver,
    onColumnContextMenu: handleColumnContextMenu,
    onColumnClick: handleColumnClick,
    onResizeStart: handleResizeStart,
    onResizeMove: handleResizeMove,
    onResizeEnd: handleResizeEnd,
    onResetWidth: handleResetWidth,
    onColDragStart: handleColDragStart,
    onColDragOver: handleColDragOver,
    onColDragLeave: handleColDragLeave,
    onColDrop: handleColDrop,
    onColDragEnd: handleColDragEnd,
  };

  // The grid template is exposed to descendants via the --grid-columns CSS
  // variable.  PhotoRow reads it via var(--grid-columns) so column-width
  // changes don't invalidate every memoised row's props.
  const gridColumns = buildGridTemplate(visibleColumns, effectiveWidths);
  const gridStyle = {
    gridTemplateColumns: gridColumns,
    gridTemplateRows: "auto auto 1fr",
    "--grid-columns": gridColumns,
    "--row-height": `${rowHeight}px`,
    "--thumb-height": `${thumbnailHeight}px`,
  } as React.CSSProperties;

  if (photos.length === 0) {
    return (
      <div className="photo-table-wrapper" ref={listRef} onClick={() => { setContextMenu(null); setColumnContextMenu(null); }} onDragOver={handleWrapperDragOver}>
        <div
          className="photo-grid"
          data-testid={emptySearchMessage ? "photo-list-search-empty" : "photo-list-empty"}
          role="grid"
          style={gridStyle}
        >
          <PhotoListHeader {...headerProps} />
          <div
            className="grid-body"
            data-testid={emptySearchMessage ? "photo-list-search-empty-message" : undefined}
            style={{
              gridColumn: "1 / -1",
              gridRow: 3,
              position: "relative",
              minHeight: "200px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#666",
              fontStyle: emptySearchMessage ? "normal" : "italic",
              padding: "0 24px",
              textAlign: "center",
            }}
          >
            {emptySearchMessage ?? null}
          </div>
        </div>
      </div>
    );
  }

  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <div className="photo-table-wrapper" ref={listRef} onClick={() => { setContextMenu(null); setColumnContextMenu(null); }} onDragOver={handleWrapperDragOver}>
      <div
        className="photo-grid"
        data-testid="photo-list"
        role="grid"
        style={gridStyle}
      >
        <PhotoListHeader {...headerProps} />

        {/* Virtual rows container */}
        <div
          className="grid-body"
          style={{
            gridColumn: `1 / -1`,
            gridRow: 3,
            position: "relative",
            height: `${totalSize}px`
          }}
        >
          {virtualItems.map((virtualRow) => {
            const photo = photos[virtualRow.index];
            return (
              <PhotoRow
                key={photo.relative_path}
                photo={photo}
                index={virtualRow.index}
                selected={selectedIndices.has(virtualRow.index)}
                thumbnails={thumbnails}
                imageMetadata={imageMetadata}
                visibleColumns={visibleColumns}
                draftEdits={draftEdits[photo.relative_path]}
                onSelect={handleRowSelect}
                onPhotoOpen={onPhotoOpen}
                onContextMenu={handleContextMenu}
                virtualStart={virtualRow.start}
                searchQuery={searchQuery}
              />
            );
          })}
        </div>
      </div>

      {contextMenu && (() => {
        const indices = Array.from(selectedIndices).sort((a, b) => a - b);
        const effectiveIndices = indices.length > 0 ? indices : [contextMenu.index];
        const selectedPaths = effectiveIndices
          .map((i) => photos[i]?.relative_path)
          .filter((p): p is string => typeof p === "string");
        const editablePaths = selectedPaths.filter(
          (p) => draftEdits[p] && Object.keys(draftEdits[p]).length > 0,
        );
        const totalEdits = editablePaths.reduce(
          (sum, p) => sum + Object.keys(draftEdits[p] ?? {}).length,
          0,
        );
        const count = selectedPaths.length;
        const noun = count === 1 ? "photo" : "photos";
        const firstIndex = effectiveIndices[0];
        return (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            options={[
              {
                label: count > 1 ? `View (${photos[firstIndex]?.filename ?? "first"})` : "View",
                onClick: () => onPhotoOpen(firstIndex),
              },
              {
                label: count > 1
                  ? `Show in File Explorer (${photos[firstIndex]?.filename ?? "first"})`
                  : "Show in File Explorer",
                onClick: () => onShowInExplorer(firstIndex),
              },
              ...(onGenerateAiDescription && selectedPaths.length > 0
                ? [{
                    label: count > 1
                      ? `Generate AI Description (${count} ${noun})`
                      : "Generate AI Description",
                    onClick: () => onGenerateAiDescription(selectedPaths),
                  }]
                : []),
              ...(editablePaths.length > 0 && onApplyEdits
                ? [{
                    label: editablePaths.length > 1
                      ? `Apply edits (${editablePaths.length} ${editablePaths.length === 1 ? "photo" : "photos"})`
                      : "Apply edits",
                    onClick: async () => {
                      const target = editablePaths.length === 1
                        ? (photos[effectiveIndices.find((i) => photos[i]?.relative_path === editablePaths[0])!]?.filename ?? editablePaths[0])
                        : `${editablePaths.length} photos`;
                      const confirmed = await ask(
                        `Apply ${totalEdits} edit${totalEdits === 1 ? "" : "s"} to ${target}?\n\nThis will permanently modify the original image file${editablePaths.length === 1 ? "" : "s"}. There is no backup.`,
                        { title: "Apply Edits", kind: "warning" },
                      );
                      if (confirmed) { setContextMenu(null); onApplyEdits(editablePaths); }
                    },
                  }]
                : []),
              ...(editablePaths.length > 0 && onDiscardAllEdits
                ? [{
                    label: editablePaths.length > 1
                      ? `Discard all edits (${editablePaths.length} ${editablePaths.length === 1 ? "photo" : "photos"})`
                      : "Discard all edits",
                    onClick: async () => {
                      const confirmed = await ask(
                        `Are you sure you want to discard ${totalEdits} edit${totalEdits === 1 ? "" : "s"} across ${editablePaths.length} ${editablePaths.length === 1 ? "photo" : "photos"}?`,
                        { title: "Discard Edits", kind: "warning" },
                      );
                      if (confirmed) onDiscardAllEdits(editablePaths);
                    },
                  }]
                : []),
            ]}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {columnContextMenu && onSelectColumns && (
        <ContextMenu
          x={columnContextMenu.x}
          y={columnContextMenu.y}
          options={[
            { label: "Select Columns...", onClick: () => { onSelectColumns(); setColumnContextMenu(null); } },
          ]}
          onClose={() => setColumnContextMenu(null)}
        />
      )}
    </div>
  );
}

