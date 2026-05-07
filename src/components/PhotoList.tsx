import { useEffect, useRef, useState, useCallback, memo } from "react";
import { useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, Variant, SortConfig } from "../types";
import { Spinner } from "./Spinner";
import { ContextMenu } from "./ContextMenu";
import { nextSortConfig } from "../utils/sorting";

interface Props {
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  imageMetadata: ImageMetadataStore;
  visibleColumns: string[];
  visibleOSColumns: string[];
  columnWidths?: Record<string, number>;
  onColumnWidthChange?: (col: string, width: number) => void;
  onColumnsReorder?: (columns: string[]) => void;
  onOSColumnsReorder?: (columns: string[]) => void;
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
}

function formatDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function formatVariant(v: Variant | undefined): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number") return v.toString();
  if (Array.isArray(v)) return v.map(formatVariant).join(", ");
  return "—";
}



const MIN_COL_WIDTH = 40;

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
  visibleOSColumns: string[],
  visibleColumns: string[],
  widths: Record<string, number>,
): string {
  const w = (key: string, def: string) => widths[key] ? `${widths[key]}px` : def;
  return [
    "52px",
    w("relative_path", "minmax(200px, 2fr)"),
    ...visibleOSColumns.map((c) => w(c, "minmax(120px, 1fr)")),
    ...visibleColumns.map((c) => w(c, "minmax(150px, 1fr)")),
  ].join(" ");
}

interface ResizeHandleProps {
  col: string;
  onResizeStart: (e: React.PointerEvent, col: string) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
  onReset: (col: string) => void;
}

function ResizeHandle({ col, onResizeStart, onResizeMove, onResizeEnd, onReset }: ResizeHandleProps) {
  return (
    <div
      className="resize-handle"
      draggable={false}
      data-testid={`resize-handle-${col}`}
      onPointerDown={(e) => onResizeStart(e, col)}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      onPointerCancel={onResizeEnd}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); onReset(col); }}
    />
  );
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
  visibleColumns: string[];
  visibleOSColumns: string[];
  sortConfig: SortConfig;
  sortingDisabled?: boolean;
  dragOver: { col: string; side: "before" | "after" } | null;
  onColumnContextMenu: (e: React.MouseEvent) => void;
  onColumnClick: (column: string, columnType: "path" | "os" | "image") => void;
  onResizeStart: (e: React.PointerEvent, col: string) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
  onResetWidth: (col: string) => void;
  onColDragStart: (e: React.DragEvent, col: string, group: "os" | "image") => void;
  onColDragOver: (e: React.DragEvent, col: string) => void;
  onColDragLeave: (e: React.DragEvent) => void;
  onColDrop: (e: React.DragEvent, col: string, group: "os" | "image") => void;
  onColDragEnd: () => void;
}

const OS_COLUMN_LABELS: Record<string, string> = {
  date_modified: "Modified",
  date_created: "Created",
};

function PhotoListHeader(props: HeaderProps) {
  const {
    visibleColumns, visibleOSColumns, sortConfig, sortingDisabled, dragOver,
    onColumnContextMenu, onColumnClick,
    onResizeStart, onResizeMove, onResizeEnd, onResetWidth,
    onColDragStart, onColDragOver, onColDragLeave, onColDrop, onColDragEnd,
  } = props;
  const osColumnCount = visibleOSColumns.length;

  // First two columns are always thumbnail (1) + path (2). OS columns start at
  // gridColumn 3 in the order they appear in visibleOSColumns; image-metadata
  // columns follow in their own order.
  const osColumnStart = 3;
  const imageColumnStart = osColumnStart + osColumnCount;

  const headerClass = (col: string) => {
    const drop = dragOver?.col === col ? ` grid-header--drop-${dragOver.side}` : "";
    return `grid-header grid-header--sortable${drop}`;
  };

  return (
    <>
      <div className="grid-header-group grid-cell-thumb" style={{ gridRow: "1 / 3" }}>Preview</div>
      <div className="grid-header-group" style={{ gridColumn: `span ${1 + osColumnCount}`, gridRow: 1 }} onContextMenu={onColumnContextMenu}>OS Metadata</div>
      {visibleColumns.length > 0 && (
        <div className="grid-header-group" style={{ gridColumn: `span ${visibleColumns.length}`, gridRow: 1 }} onContextMenu={onColumnContextMenu}>Image Metadata</div>
      )}

      <div className="grid-header grid-cell-thumb" style={{ gridRow: 2, gridColumn: 1 }} />
      <div
        className="grid-header grid-header--sortable"
        style={{ gridRow: 2, gridColumn: 2 }}
        onContextMenu={onColumnContextMenu}
        onClick={() => onColumnClick("relative_path", "path")}
      >
        Path
        <SortIndicator column="relative_path" sortConfig={sortConfig} disabled={sortingDisabled} />
        <ResizeHandle col="relative_path" onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} onReset={onResetWidth} />
      </div>

      {visibleOSColumns.map((col, i) => (
        <div
          key={col}
          className={headerClass(col)}
          style={{ gridRow: 2, gridColumn: osColumnStart + i }}
          draggable
          onDragStart={(e) => onColDragStart(e, col, "os")}
          onDragOver={(e) => onColDragOver(e, col)}
          onDragLeave={onColDragLeave}
          onDrop={(e) => onColDrop(e, col, "os")}
          onDragEnd={onColDragEnd}
          onContextMenu={onColumnContextMenu}
          onClick={() => onColumnClick(col, "os")}
        >
          {OS_COLUMN_LABELS[col] ?? col}
          <SortIndicator column={col} sortConfig={sortConfig} disabled={sortingDisabled} />
          <ResizeHandle col={col} onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} onReset={onResetWidth} />
        </div>
      ))}

      {visibleColumns.map((col, i) => (
        <div
          key={col}
          className={headerClass(col)}
          style={{ gridRow: 2, gridColumn: imageColumnStart + i }}
          draggable
          onDragStart={(e) => onColDragStart(e, col, "image")}
          onDragOver={(e) => onColDragOver(e, col)}
          onDragLeave={onColDragLeave}
          onDrop={(e) => onColDrop(e, col, "image")}
          onDragEnd={onColDragEnd}
          onContextMenu={onColumnContextMenu}
          onClick={() => onColumnClick(col, "image")}
        >
          {col}
          <SortIndicator column={col} sortConfig={sortConfig} disabled={sortingDisabled} />
          <ResizeHandle col={col} onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd} onReset={onResetWidth} />
        </div>
      ))}
    </>
  );
}

export function PhotoList({
  photos, thumbnails, imageMetadata, visibleColumns, visibleOSColumns,
  columnWidths = {}, onColumnWidthChange,
  onColumnsReorder, onOSColumnsReorder,
  sortConfig, onSortChange, sortingDisabled,
  selectedIndex, onSelect, onShowInExplorer, onVisibilityChange, onPhotoOpen, onSelectColumns
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<Set<string>>(new Set());

  // Live column widths during a resize drag (overrides saved widths until pointer up)
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const resizeDragRef = useRef<{ col: string; startX: number; startWidth: number; pointerId: number } | null>(null);

  // Column drag-and-drop reorder state
  const colDragRef = useRef<{ col: string; group: "os" | "image" } | null>(null);
  const [dragOver, setDragOver] = useState<{ col: string; side: "before" | "after" } | null>(null);

  const effectiveWidths = Object.keys(liveWidths).length > 0
    ? { ...columnWidths, ...liveWidths }
    : columnWidths;
  
  // Use refs for callbacks to avoid re-creating observers when they change
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;
  
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Set up virtualizer
  const rowVirtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 44, // Estimated row height in pixels (matches .photo-row td height)
    overscan: 10, // Render 10 extra rows above/below viewport for smooth scrolling
  });

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

  const handleContextMenu = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault();
    onSelect(index);
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

    // scrollWidth returns the full content width even when overflow:hidden clips the
    // visible area, so it correctly measures the intrinsic width of each rendered cell.
    let maxWidth = 0;
    container.querySelectorAll<HTMLElement>(`[data-col="${col}"]`).forEach((cell) => {
      if (cell.scrollWidth > maxWidth) maxWidth = cell.scrollWidth;
    });

    // Also include the header cell's natural width (reached via its resize-handle).
    const handle = container.querySelector<HTMLElement>(`[data-testid="resize-handle-${col}"]`);
    if (handle?.parentElement) {
      const hw = handle.parentElement.scrollWidth;
      if (hw > maxWidth) maxWidth = hw;
    }

    // Small breathing-room buffer so content is never right at the edge.
    const measured = maxWidth > 0 ? maxWidth + 4 : 0;
    onColumnWidthChange(col, measured);
  }, [onColumnWidthChange]);

  const handleColDragStart = useCallback((e: React.DragEvent, col: string, group: "os" | "image") => {
    colDragRef.current = { col, group };
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

  const handleColDrop = useCallback((e: React.DragEvent, dropCol: string, group: "os" | "image") => {
    e.preventDefault();
    const drag = colDragRef.current;
    colDragRef.current = null;
    setDragOver(null);
    if (!drag || drag.group !== group || drag.col === dropCol) return;

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

    if (group === "os") {
      const arr = [...visibleOSColumns];
      const from = arr.indexOf(drag.col);
      const to = arr.indexOf(dropCol);
      if (from === -1 || to === -1) return;
      arr.splice(from, 1);
      arr.splice(insertAt(from, to), 0, drag.col);
      onOSColumnsReorder?.(arr);
    } else {
      const arr = [...visibleColumns];
      const from = arr.indexOf(drag.col);
      const to = arr.indexOf(dropCol);
      if (from === -1 || to === -1) return;
      arr.splice(from, 1);
      arr.splice(insertAt(from, to), 0, drag.col);
      onColumnsReorder?.(arr);
    }
  }, [visibleColumns, visibleOSColumns, onColumnsReorder, onOSColumnsReorder]);

  const handleColDragEnd = useCallback(() => {
    colDragRef.current = null;
    setDragOver(null);
  }, []);

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number } | null>(null);
  const [columnContextMenu, setColumnContextMenu] = useState<{ x: number, y: number } | null>(null);

  const headerProps: HeaderProps = {
    visibleColumns, visibleOSColumns, sortConfig, sortingDisabled, dragOver,
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
  const gridColumns = buildGridTemplate(visibleOSColumns, visibleColumns, effectiveWidths);
  const gridStyle = {
    gridTemplateColumns: gridColumns,
    gridTemplateRows: "auto auto 1fr",
    "--grid-columns": gridColumns,
  } as React.CSSProperties;

  if (photos.length === 0) {
    return (
      <div className="photo-table-wrapper" ref={listRef} onClick={() => { setContextMenu(null); setColumnContextMenu(null); }} onDragOver={handleWrapperDragOver}>
        <div
          className="photo-grid"
          data-testid="photo-list-empty"
          role="grid"
          style={gridStyle}
        >
          <PhotoListHeader {...headerProps} />
          <div className="grid-body" style={{ gridColumn: "1 / -1", gridRow: 3, position: "relative", minHeight: "200px", display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontStyle: "italic" }} />
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
                selected={selectedIndex === virtualRow.index}
                thumbnails={thumbnails}
                imageMetadata={imageMetadata}
                visibleColumns={visibleColumns}
                visibleOSColumns={visibleOSColumns}
                onSelect={onSelect}
                onPhotoOpen={onPhotoOpen}
                onContextMenu={handleContextMenu}
                virtualStart={virtualRow.start}
              />
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          options={[
            { label: "View", onClick: () => onPhotoOpen(contextMenu.index) },
            { label: "Show in File Explorer", onClick: () => onShowInExplorer(contextMenu.index) },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}

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

interface RowProps {
  photo: PhotoInfo;
  index: number;
  selected: boolean;
  thumbnails: ThumbnailStore;
  imageMetadata: ImageMetadataStore;
  visibleColumns: string[];
  visibleOSColumns: string[];
  onSelect: (index: number | null) => void;
  onPhotoOpen: (index: number) => void;
  onContextMenu: (e: React.MouseEvent, index: number) => void;
  virtualStart: number;
}

const PhotoRow = memo(function PhotoRow({
  photo, index, selected, thumbnails, imageMetadata, visibleColumns, visibleOSColumns,
  onSelect, onPhotoOpen, onContextMenu, virtualStart
}: RowProps) {
  const subscribeThumb = useCallback((cb: () => void) => thumbnails.subscribe(photo.relative_path, cb), [thumbnails, photo.relative_path]);
  const getThumbSnapshot = useCallback(() => thumbnails.get(photo.relative_path), [thumbnails, photo.relative_path]);
  const thumbnail = useSyncExternalStore(subscribeThumb, getThumbSnapshot);

  const subscribeMeta = useCallback((cb: () => void) => imageMetadata.subscribe(photo.relative_path, cb), [imageMetadata, photo.relative_path]);
  const getMetaSnapshot = useCallback(() => imageMetadata.get(photo.relative_path), [imageMetadata, photo.relative_path]);
  const metadata = useSyncExternalStore(subscribeMeta, getMetaSnapshot);

  const isLoading = thumbnail === "loading";
  const hasSrc = thumbnail !== "loading" && thumbnail !== "failed";
  const src = hasSrc ? `data:image/jpeg;base64,${thumbnail}` : null;

  const metadataLoading = metadata === "loading";
  const metadataFailed = metadata !== "loading" && typeof metadata === "object" && "_error" in metadata;

  const handleSelect = useCallback(() => onSelect(index), [onSelect, index]);
  const handleDoubleClick = useCallback(() => onPhotoOpen(index), [onPhotoOpen, index]);
  const handleContextMenuEvent = useCallback((e: React.MouseEvent) => onContextMenu(e, index), [onContextMenu, index]);

  const rowClass = `photo-row ${index % 2 === 0 ? "photo-row--even" : "photo-row--odd"} ${selected ? "photo-row--selected" : ""}`;

  return (
    <div
      className={rowClass}
      data-testid="photo-row"
      data-path={photo.relative_path}
      data-index={index}
      onClick={handleSelect}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenuEvent}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${virtualStart}px)`,
        cursor: "pointer",
        gridTemplateColumns: "var(--grid-columns)",
      }}
    >
      <div className="grid-cell grid-cell-thumb">
        <div className="photo-thumb">
          {src ? (
            <img src={src} alt="" className="photo-thumb-img" />
          ) : isLoading ? (
            <div className="photo-thumb-spinner">
              <Spinner className="photo-thumb-spin-inner" />
            </div>
          ) : (
            <div className="photo-thumb-placeholder" />
          )}
        </div>
      </div>
      <div className="grid-cell grid-cell-path" data-col="relative_path" data-testid="photo-path">{photo.relative_path}</div>
      {visibleOSColumns.includes("date_modified") && (
        <div className="grid-cell grid-cell-date" data-col="date_modified" data-testid="photo-date-modified">{formatDate(photo.date_modified)}</div>
      )}
      {visibleOSColumns.includes("date_created") && (
        <div className="grid-cell grid-cell-date" data-col="date_created" data-testid="photo-date-created">{formatDate(photo.date_created)}</div>
      )}
      {visibleColumns.map((col, i) => (
        <div key={col} className="grid-cell grid-cell-metadata" data-col={col}>
          {metadataLoading ? (
            // One spinner per row (in the first metadata cell), dashes elsewhere.
            // Per-cell spinners were O(rows × cols) and dominated initial render.
            i === 0 ? (
              <Spinner className="cell-spinner" aria-label="Loading" data-testid="metadata-loading" />
            ) : (
              <span className="cell-loading-placeholder" aria-hidden="true">—</span>
            )
          ) : metadataFailed ? (
            <span className="metadata-error" title="Failed to load metadata">✗</span>
          ) : (
            formatVariant(metadata[col])
          )}
        </div>
      ))}
    </div>
  );
});
