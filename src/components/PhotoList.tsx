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

function SortIndicator({ column, sortConfig }: { column: string; sortConfig: SortConfig }) {
  const { primary, secondary } = sortConfig;
  if (primary?.column === column) {
    return <span className="sort-indicator sort-indicator--primary">{primary.direction === "asc" ? " ▲" : " ▼"}</span>;
  }
  if (secondary?.column === column) {
    return <span className="sort-indicator sort-indicator--secondary">{secondary.direction === "asc" ? " ▲" : " ▼"}</span>;
  }
  return null;
}

export function PhotoList({
  photos, thumbnails, imageMetadata, visibleColumns, visibleOSColumns,
  columnWidths = {}, onColumnWidthChange,
  onColumnsReorder, onOSColumnsReorder,
  sortConfig, onSortChange,
  selectedIndex, onSelect, onShowInExplorer, onVisibilityChange, onPhotoOpen, onSelectColumns
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<Set<string>>(new Set());

  // Live column widths during a resize drag (overrides saved widths until pointer up)
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const resizeDragRef = useRef<{ col: string; startX: number; startWidth: number; pointerId: number } | null>(null);

  // Column drag-and-drop reorder state
  const colDragRef = useRef<{ col: string; group: "os" | "image" } | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

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
      const visibleOrdered = photosRef.current
        .filter(p => visibleRef.current.has(p.relative_path))
        .filter(p => {
          // Only prioritize images that don't already have both thumbnail and metadata loaded
          const thumbnailState = thumbnails.get(p.relative_path);
          const metadataState = imageMetadata.get(p.relative_path);
          
          const thumbnailNeedsLoading = thumbnailState === "loading";
          const metadataNeedsLoading = metadataState === "loading";
          
          return thumbnailNeedsLoading || metadataNeedsLoading;
        })
        .map(p => p.relative_path);
      
      console.log(`[PhotoList] Notifying visibility change: ${visibleOrdered.length} visible photos need loading`);
      
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
      
      console.log(`[PhotoList] Virtual items: ${virtualItems.length}, visible photos: ${newVisible.size}`);
      
      // Check if visibility changed
      if (newVisible.size !== visibleRef.current.size || 
          ![...newVisible].every(p => visibleRef.current.has(p))) {
        visibleRef.current = newVisible;
        notify();
      }
    };

    updateVisible();
  }, [virtualItems, thumbnails, imageMetadata]);

  // Initial notification when photos first load - notify about first batch immediately
  useEffect(() => {
    if (photos.length > 0) {
      // Notify about the first 30 photos that need loading to kickstart loading
      const initialPaths = photos.slice(0, 30)
        .filter(p => {
          // Only prioritize images that don't already have both thumbnail and metadata loaded
          const thumbnailState = thumbnails.get(p.relative_path);
          const metadataState = imageMetadata.get(p.relative_path);
          
          const thumbnailNeedsLoading = thumbnailState === "loading";
          const metadataNeedsLoading = metadataState === "loading";
          
          return thumbnailNeedsLoading || metadataNeedsLoading;
        })
        .map(p => p.relative_path);
      
      if (initialPaths.length > 0) {
        console.log(`[PhotoList] Initial load: notifying about first ${initialPaths.length} photos that need loading`);
        onVisibilityChange(initialPaths);
      }
    }
  }, [photos.length, thumbnails, imageMetadata, onVisibilityChange]); // Only run when photos first load or count changes

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
    if (onColumnWidthChange) onColumnWidthChange(col, 0);
  }, [onColumnWidthChange]);

  const handleColDragStart = useCallback((e: React.DragEvent, col: string, group: "os" | "image") => {
    colDragRef.current = { col, group };
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleColDragOver = useCallback((e: React.DragEvent, col: string) => {
    if (!colDragRef.current) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = colDragRef.current.col === col ? "none" : "move";
    if (colDragRef.current.col !== col) setDragOverCol(col);
  }, []);

  // Allow drop anywhere on the wrapper while a column drag is in progress so the
  // browser shows the "move" cursor over gaps/body instead of the no-entry symbol.
  const handleWrapperDragOver = useCallback((e: React.DragEvent) => {
    if (colDragRef.current) e.preventDefault();
  }, []);

  const handleColDragLeave = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDragOverCol(null);
    }
  }, []);

  const handleColDrop = useCallback((e: React.DragEvent, dropCol: string, group: "os" | "image") => {
    e.preventDefault();
    const drag = colDragRef.current;
    colDragRef.current = null;
    setDragOverCol(null);
    if (!drag || drag.group !== group || drag.col === dropCol) return;

    if (group === "os") {
      const arr = [...visibleOSColumns];
      const from = arr.indexOf(drag.col);
      const to = arr.indexOf(dropCol);
      if (from === -1 || to === -1) return;
      arr.splice(from, 1);
      arr.splice(to, 0, drag.col);
      onOSColumnsReorder?.(arr);
    } else {
      const arr = [...visibleColumns];
      const from = arr.indexOf(drag.col);
      const to = arr.indexOf(dropCol);
      if (from === -1 || to === -1) return;
      arr.splice(from, 1);
      arr.splice(to, 0, drag.col);
      onColumnsReorder?.(arr);
    }
  }, [visibleColumns, visibleOSColumns, onColumnsReorder, onOSColumnsReorder]);

  const handleColDragEnd = useCallback(() => {
    colDragRef.current = null;
    setDragOverCol(null);
  }, []);

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number } | null>(null);
  const [columnContextMenu, setColumnContextMenu] = useState<{ x: number, y: number } | null>(null);

  if (photos.length === 0) {
    const osColumnCount = visibleOSColumns.length;
    const gridColumns = buildGridTemplate(visibleOSColumns, visibleColumns, effectiveWidths);

    return (
      <div className="photo-table-wrapper" ref={listRef} onClick={() => { setContextMenu(null); setColumnContextMenu(null); }} onDragOver={handleWrapperDragOver}>
        <div
          className="photo-grid"
          data-testid="photo-list-empty"
          role="grid"
          style={{ gridTemplateColumns: gridColumns, gridTemplateRows: "auto auto 1fr" }}
        >
          <div className="grid-header-group grid-cell-thumb" style={{ gridRow: "1 / 3" }}>Preview</div>
          <div className="grid-header-group" style={{ gridColumn: `span ${1 + osColumnCount}`, gridRow: 1 }} onContextMenu={handleColumnContextMenu}>OS Metadata</div>
          {visibleColumns.length > 0 && (
            <div className="grid-header-group" style={{ gridColumn: `span ${visibleColumns.length}`, gridRow: 1 }} onContextMenu={handleColumnContextMenu}>Image Metadata</div>
          )}

          <div className="grid-header grid-cell-thumb" style={{ gridRow: 2, gridColumn: 1 }} />
          <div className="grid-header grid-header--sortable" style={{ gridRow: 2, gridColumn: 2 }} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick("relative_path", "path")}>Path<SortIndicator column="relative_path" sortConfig={sortConfig} /><ResizeHandle col="relative_path" onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
          {visibleOSColumns.includes("date_modified") && (
            <div className={`grid-header grid-header--sortable${dragOverCol === "date_modified" ? " grid-header--drag-over" : ""}`} style={{ gridRow: 2, gridColumn: 3 }} draggable onDragStart={(e) => handleColDragStart(e, "date_modified", "os")} onDragOver={(e) => handleColDragOver(e, "date_modified")} onDragLeave={handleColDragLeave} onDrop={(e) => handleColDrop(e, "date_modified", "os")} onDragEnd={handleColDragEnd} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick("date_modified", "os")}>Modified<SortIndicator column="date_modified" sortConfig={sortConfig} /><ResizeHandle col="date_modified" onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
          )}
          {visibleOSColumns.includes("date_created") && (
            <div className={`grid-header grid-header--sortable${dragOverCol === "date_created" ? " grid-header--drag-over" : ""}`} style={{ gridRow: 2, gridColumn: visibleOSColumns.includes("date_modified") ? 4 : 3 }} draggable onDragStart={(e) => handleColDragStart(e, "date_created", "os")} onDragOver={(e) => handleColDragOver(e, "date_created")} onDragLeave={handleColDragLeave} onDrop={(e) => handleColDrop(e, "date_created", "os")} onDragEnd={handleColDragEnd} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick("date_created", "os")}>Created<SortIndicator column="date_created" sortConfig={sortConfig} /><ResizeHandle col="date_created" onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
          )}
          {visibleColumns.map((col, index) => (
            <div key={col} className={`grid-header grid-header--sortable${dragOverCol === col ? " grid-header--drag-over" : ""}`} style={{ gridRow: 2, gridColumn: 3 + osColumnCount + index }} draggable onDragStart={(e) => handleColDragStart(e, col, "image")} onDragOver={(e) => handleColDragOver(e, col)} onDragLeave={handleColDragLeave} onDrop={(e) => handleColDrop(e, col, "image")} onDragEnd={handleColDragEnd} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick(col, "image")}>{col}<SortIndicator column={col} sortConfig={sortConfig} /><ResizeHandle col={col} onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
          ))}

          <div className="grid-body" style={{ gridColumn: "1 / -1", gridRow: 3, position: "relative", minHeight: "200px", display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontStyle: "italic" }} />
        </div>
      </div>
    );
  }

  const totalSize = rowVirtualizer.getTotalSize();
  const osColumnCount = visibleOSColumns.length;
  const gridColumns = buildGridTemplate(visibleOSColumns, visibleColumns, effectiveWidths);

  return (
    <div className="photo-table-wrapper" ref={listRef} onClick={() => { setContextMenu(null); setColumnContextMenu(null); }} onDragOver={handleWrapperDragOver}>
      <div
        className="photo-grid"
        data-testid="photo-list"
        role="grid"
        style={{ gridTemplateColumns: gridColumns, gridTemplateRows: "auto auto 1fr" }}
      >
        <div className="grid-header-group grid-cell-thumb" style={{ gridRow: "1 / 3" }}>Preview</div>
        <div className="grid-header-group" style={{ gridColumn: `span ${1 + osColumnCount}`, gridRow: 1 }} onContextMenu={handleColumnContextMenu}>OS Metadata</div>
        {visibleColumns.length > 0 && (
          <div className="grid-header-group" style={{ gridColumn: `span ${visibleColumns.length}`, gridRow: 1 }} onContextMenu={handleColumnContextMenu}>Image Metadata</div>
        )}

        <div className="grid-header grid-cell-thumb" style={{ gridRow: 2, gridColumn: 1 }} />
        <div className="grid-header grid-header--sortable" style={{ gridRow: 2, gridColumn: 2 }} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick("relative_path", "path")}>Path<SortIndicator column="relative_path" sortConfig={sortConfig} /><ResizeHandle col="relative_path" onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
        {visibleOSColumns.includes("date_modified") && (
          <div className={`grid-header grid-header--sortable${dragOverCol === "date_modified" ? " grid-header--drag-over" : ""}`} style={{ gridRow: 2, gridColumn: 3 }} draggable onDragStart={(e) => handleColDragStart(e, "date_modified", "os")} onDragOver={(e) => handleColDragOver(e, "date_modified")} onDragLeave={handleColDragLeave} onDrop={(e) => handleColDrop(e, "date_modified", "os")} onDragEnd={handleColDragEnd} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick("date_modified", "os")}>Modified<SortIndicator column="date_modified" sortConfig={sortConfig} /><ResizeHandle col="date_modified" onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
        )}
        {visibleOSColumns.includes("date_created") && (
          <div className={`grid-header grid-header--sortable${dragOverCol === "date_created" ? " grid-header--drag-over" : ""}`} style={{ gridRow: 2, gridColumn: visibleOSColumns.includes("date_modified") ? 4 : 3 }} draggable onDragStart={(e) => handleColDragStart(e, "date_created", "os")} onDragOver={(e) => handleColDragOver(e, "date_created")} onDragLeave={handleColDragLeave} onDrop={(e) => handleColDrop(e, "date_created", "os")} onDragEnd={handleColDragEnd} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick("date_created", "os")}>Created<SortIndicator column="date_created" sortConfig={sortConfig} /><ResizeHandle col="date_created" onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
        )}
        {visibleColumns.map((col, index) => (
          <div key={col} className={`grid-header grid-header--sortable${dragOverCol === col ? " grid-header--drag-over" : ""}`} style={{ gridRow: 2, gridColumn: 3 + osColumnCount + index }} draggable onDragStart={(e) => handleColDragStart(e, col, "image")} onDragOver={(e) => handleColDragOver(e, col)} onDragLeave={handleColDragLeave} onDrop={(e) => handleColDrop(e, col, "image")} onDragEnd={handleColDragEnd} onContextMenu={handleColumnContextMenu} onClick={() => handleColumnClick(col, "image")}>{col}<SortIndicator column={col} sortConfig={sortConfig} /><ResizeHandle col={col} onResizeStart={handleResizeStart} onResizeMove={handleResizeMove} onResizeEnd={handleResizeEnd} onReset={handleResetWidth} /></div>
        ))}
        
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
                gridColumns={gridColumns}
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
  gridColumns: string;
}

const PhotoRow = memo(function PhotoRow({ 
  photo, index, selected, thumbnails, imageMetadata, visibleColumns, visibleOSColumns,
  onSelect, onPhotoOpen, onContextMenu, virtualStart, gridColumns
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
        gridTemplateColumns: gridColumns,
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
      <div className="grid-cell grid-cell-path" data-testid="photo-path">{photo.relative_path}</div>
      {visibleOSColumns.includes("date_modified") && (
        <div className="grid-cell grid-cell-date" data-testid="photo-date-modified">{formatDate(photo.date_modified)}</div>
      )}
      {visibleOSColumns.includes("date_created") && (
        <div className="grid-cell grid-cell-date" data-testid="photo-date-created">{formatDate(photo.date_created)}</div>
      )}
      {visibleColumns.map((col) => (
        <div key={col} className="grid-cell grid-cell-metadata">
          {metadataLoading ? (
            <Spinner className="cell-spinner" aria-label="Loading" data-testid="metadata-loading" />
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
