import { useEffect, useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, SortConfig, VisibleColumn } from "../types";
import { ContextMenu } from "./ContextMenu";
import { PhotoRow } from "./PhotoRow";
import { ResizeHandle } from "./ResizeHandle";
import { nextSortConfig } from "../utils/sorting";
import { useColumnResize } from "../hooks/useColumnResize";
import {
  useColumnReorder,
  type ColumnDragOver,
} from "../hooks/useColumnReorder";
import { useRowSelection } from "../hooks/useRowSelection";
import { PhotoListContextMenu } from "./PhotoListContextMenu";
import { selectVisibleNeedingLoad } from "../utils/photoListHelpers";

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
  /** Trigger reverse-geocoding flow for the given relative paths. */
  onGeocode?: (fileRelativePaths: string[]) => void;
  /** Trigger metadata-normalisation flow for the given relative paths. */
  onNormalise?: (fileRelativePaths: string[]) => void;
  /** Copy absolute paths for the given relative paths to the clipboard. */
  onCopyPaths?: (fileRelativePaths: string[]) => void;
  /** Notified whenever the multi-selection size changes. */
  onSelectionCountChange?: (count: number) => void;
}

const DEFAULT_PREVIEW_COL_WIDTH = 52;
const MIN_ROW_HEIGHT = 44;
const THUMBNAIL_CELL_GUTTER = 8;
const PREVIEW_ASPECT_HEIGHT = 3;
const PREVIEW_ASPECT_WIDTH = 4;

function buildGridTemplate(
  visibleColumns: VisibleColumn[],
  widths: Record<string, number>,
): string {
  const w = (key: string, def: string) =>
    widths[key] ? `${widths[key]}px` : def;
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
  const thumbnailHeight = Math.round(
    (thumbnailWidth * PREVIEW_ASPECT_HEIGHT) / PREVIEW_ASPECT_WIDTH,
  );
  return Math.max(MIN_ROW_HEIGHT, thumbnailHeight + THUMBNAIL_CELL_GUTTER);
}

function SortIndicator({
  column,
  sortConfig,
  disabled,
}: {
  column: string;
  sortConfig: SortConfig;
  disabled?: boolean;
}) {
  if (disabled) return null;
  const { primary, secondary } = sortConfig;
  if (primary?.column === column) {
    return (
      <span className="sort-indicator sort-indicator--primary">
        {primary.direction === "asc" ? " ▲" : " ▼"}
      </span>
    );
  }
  if (secondary?.column === column) {
    return (
      <span className="sort-indicator sort-indicator--secondary">
        {secondary.direction === "asc" ? " ▲" : " ▼"}
      </span>
    );
  }
  return null;
}

interface HeaderProps {
  visibleColumns: VisibleColumn[];
  sortConfig: SortConfig;
  sortingDisabled?: boolean;
  dragOver: ColumnDragOver | null;
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

function PhotoListHeader(props: HeaderProps) {
  const {
    visibleColumns,
    sortConfig,
    sortingDisabled,
    dragOver,
    onColumnContextMenu,
    onColumnClick,
    onResizeStart,
    onResizeMove,
    onResizeEnd,
    onResetWidth,
    onColDragStart,
    onColDragOver,
    onColDragLeave,
    onColDrop,
    onColDragEnd,
  } = props;

  const headerClass = (col: string) => {
    const drop =
      dragOver?.col === col ? ` grid-header--drop-${dragOver.side}` : "";
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
        <span
          className="grid-header-kind grid-header-kind--empty"
          aria-hidden="true"
        />
        <span className="grid-header-label">Preview</span>
        <ResizeHandle
          col="preview"
          onResizeStart={onResizeStart}
          onResizeMove={onResizeMove}
          onResizeEnd={onResizeEnd}
          onReset={onResetWidth}
        />
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
          <SortIndicator
            column="relative_path"
            sortConfig={sortConfig}
            disabled={sortingDisabled}
          />
        </span>
        <ResizeHandle
          col="relative_path"
          onResizeStart={onResizeStart}
          onResizeMove={onResizeMove}
          onResizeEnd={onResizeEnd}
          onReset={onResetWidth}
        />
      </div>

      {visibleColumns.map((col, i) => {
        const label =
          col.kind === "os" ? (OS_COLUMN_LABELS[col.key] ?? col.key) : col.key;
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
              <SortIndicator
                column={col.key}
                sortConfig={sortConfig}
                disabled={sortingDisabled}
              />
            </span>
            <ResizeHandle
              col={col.key}
              onResizeStart={onResizeStart}
              onResizeMove={onResizeMove}
              onResizeEnd={onResizeEnd}
              onReset={onResetWidth}
            />
          </div>
        );
      })}
    </>
  );
}

export function PhotoList({
  photos,
  thumbnails,
  imageMetadata,
  visibleColumns,
  columnWidths = {},
  onColumnWidthChange,
  onColumnsReorder,
  sortConfig,
  onSortChange,
  sortingDisabled,
  selectedIndex,
  onSelect,
  onShowInExplorer,
  onVisibilityChange,
  onPhotoOpen,
  onSelectColumns,
  searchQuery = "",
  emptySearchMessage = null,
  draftEdits = {},
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onCopyPaths,
  onSelectionCountChange,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<Set<string>>(new Set());

  const {
    effectiveWidths,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    handleResetWidth,
  } = useColumnResize(columnWidths, onColumnWidthChange, listRef);

  const {
    dragOver,
    handleColDragStart,
    handleColDragOver,
    handleColDragLeave,
    handleColDrop,
    handleColDragEnd,
    handleWrapperDragOver,
  } = useColumnReorder(visibleColumns, onColumnsReorder);

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
      const visibleOrdered = selectVisibleNeedingLoad(
        visibleRef.current,
        thumbnails,
        imageMetadata,
      );
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
      if (
        newVisible.size !== visibleRef.current.size ||
        ![...newVisible].every((p) => visibleRef.current.has(p))
      ) {
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
      if (
        thumbnails.get(path) === "loading" ||
        imageMetadata.get(path) === "loading"
      ) {
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

  const { selectedIndices, handleRowSelect, handleRowContextMenu } =
    useRowSelection({
      photosLength: photos.length,
      selectedIndex,
      onSelect,
      onPhotoOpen,
      listRef,
      rowHeight,
      onSelectionCountChange,
    });

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  const [columnContextMenu, setColumnContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      handleRowContextMenu(index);
      setContextMenu({ x: e.clientX, y: e.clientY, index });
    },
    [handleRowContextMenu],
  );

  const handleColumnContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (onSelectColumns) {
        setColumnContextMenu({ x: e.clientX, y: e.clientY });
      }
    },
    [onSelectColumns],
  );

  const handleColumnClick = useCallback(
    (column: string, columnType: "path" | "os" | "image") => {
      // Clicks are always honoured — sortingDisabled only governs whether the
      // *resulting* sort applies and is shown.  Without this, once a user lands
      // in a suspended state (e.g., image-column sort while metadata is still
      // loading) they would be unable to click an OS column to escape it.
      onSortChange(nextSortConfig(sortConfig, column, columnType));
    },
    [onSortChange, sortConfig],
  );

  const headerProps: HeaderProps = {
    visibleColumns,
    sortConfig,
    sortingDisabled,
    dragOver,
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
      <div
        className="photo-table-wrapper"
        ref={listRef}
        onClick={() => {
          setContextMenu(null);
          setColumnContextMenu(null);
        }}
        onDragOver={handleWrapperDragOver}
      >
        <div
          className="photo-grid"
          data-testid={
            emptySearchMessage ? "photo-list-search-empty" : "photo-list-empty"
          }
          role="grid"
          style={gridStyle}
        >
          <PhotoListHeader {...headerProps} />
          <div
            className="grid-body"
            data-testid={
              emptySearchMessage ? "photo-list-search-empty-message" : undefined
            }
            style={{
              gridColumn: "1 / -1",
              gridRow: 3,
              position: "relative",
              minHeight: "200px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
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
    <div
      className="photo-table-wrapper"
      ref={listRef}
      onClick={() => {
        setContextMenu(null);
        setColumnContextMenu(null);
      }}
      onDragOver={handleWrapperDragOver}
    >
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
            height: `${totalSize}px`,
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

      {contextMenu && (
        <PhotoListContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          contextMenuIndex={contextMenu.index}
          selectedIndices={selectedIndices}
          photos={photos}
          draftEdits={draftEdits}
          onPhotoOpen={onPhotoOpen}
          onShowInExplorer={onShowInExplorer}
          onCopyPaths={onCopyPaths}
          onGenerateAiDescription={onGenerateAiDescription}
          onGeocode={onGeocode}
          onNormalise={onNormalise}
          onApplyEdits={onApplyEdits}
          onDiscardAllEdits={onDiscardAllEdits}
          onClose={() => setContextMenu(null)}
        />
      )}

      {columnContextMenu && onSelectColumns && (
        <ContextMenu
          x={columnContextMenu.x}
          y={columnContextMenu.y}
          options={[
            {
              label: "Select Columns…",
              onClick: () => {
                onSelectColumns();
                setColumnContextMenu(null);
              },
            },
          ]}
          onClose={() => setColumnContextMenu(null)}
        />
      )}
    </div>
  );
}
