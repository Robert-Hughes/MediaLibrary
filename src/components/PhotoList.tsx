import { useEffect, useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import type {
  PhotoInfo,
  SchemaDefinitionId,
  SortConfig,
  VisibleColumn,
} from "../types";
import type {
  TargetDraftCollection,
  TargetDraftEditsByFile,
} from "../targetDraftEdits";
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
import {
  confirmRemoveFieldFromPhotos,
  showMetadataRemovalPreviewBlocked,
  showNoMetadataRemovalNeeded,
} from "../utils/removeFieldPrompts";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { useTagInfos } from "../hooks/useTagInfo";
import {
  visibleColumnToken,
  sortKeyMatchesColumn,
} from "../utils/columnIdentity";
import type { MetadataRemovalFilesPreview } from "../metadataRemovalTargets";

export type ColumnContextTarget =
  | { kind: "path"; key: "relative_path"; label: "Path" }
  | { kind: "os"; key: string; label: string }
  | { kind: "image"; id: SchemaDefinitionId; label: string };

export type HeaderActionScope = {
  paths: string[];
  scope: "selection" | "all";
};

interface Props {
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  imageMetadataOccurrences: ImageMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftEditsByFile;
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
  /** Open the bulk metadata editor for the selected photos. */
  onBulkEdit?: (fileRelativePaths: string[]) => void;
  /** Open the selected photos in the full map view. */
  onShowOnMap?: (fileRelativePaths: string[]) => void;
  /** Notified whenever the multi-selection size changes. */
  onSelectionCountChange?: (count: number) => void;
  onRemoveFieldFromSelectedPhotos?: (
    id: SchemaDefinitionId,
    relativePaths: string[],
  ) => boolean;
  onPreviewRemoveFieldFromSelectedPhotos?: (
    id: SchemaDefinitionId,
    relativePaths: string[],
  ) => MetadataRemovalFilesPreview;
}

const EMPTY_TARGET_DRAFT_COLLECTION: TargetDraftCollection = {};

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
      w(
        visibleColumnToken(c),
        c.kind === "os" ? "minmax(120px, 1fr)" : "minmax(150px, 1fr)",
      ),
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
  target,
  sortConfig,
  disabled,
}: {
  target: { kind: "path" } | VisibleColumn;
  sortConfig: SortConfig;
  disabled?: boolean;
}) {
  if (disabled) return null;
  const { primary, secondary } = sortConfig;
  const matches = (key: NonNullable<SortConfig["primary"]>) =>
    target.kind === "path"
      ? key.kind === "path"
      : sortKeyMatchesColumn(key, target);
  if (primary && matches(primary)) {
    return (
      <span className="sort-indicator sort-indicator--primary">
        {primary.direction === "asc" ? " ▲" : " ▼"}
      </span>
    );
  }
  if (secondary && matches(secondary)) {
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
  onColumnContextMenu: (
    e: React.MouseEvent,
    target: ColumnContextTarget,
  ) => void;
  onColumnClick: (target: { kind: "path" } | VisibleColumn) => void;
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
  const imageIds = visibleColumns.flatMap((column) =>
    column.kind === "image" ? [column.id] : [],
  );
  const tagInfos = useTagInfos(imageIds);

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
        onContextMenu={(e) =>
          onColumnContextMenu(e, {
            kind: "path",
            key: "relative_path",
            label: "Path",
          })
        }
        onClick={() => onColumnClick({ kind: "path" })}
      >
        <span className="grid-header-kind">OS</span>
        <span className="grid-header-label">
          Path
          <SortIndicator
            target={{ kind: "path" }}
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
        const token = visibleColumnToken(col);
        const tag =
          col.kind === "image"
            ? tagInfos[schemaDefinitionIdToken(col.id)]
            : null;
        const label =
          col.kind === "os"
            ? (OS_COLUMN_LABELS[col.key] ?? col.key)
            : tag && tag !== "loading"
              ? `${tag.group}:${tag.name}`
              : `${col.id.table} / ${col.id.tag_id}`;
        return (
          <div
            key={token}
            className={`${headerClass(token)} grid-header--metadata`}
            style={{ gridRow: "1 / 3", gridColumn: 3 + i }}
            draggable
            onDragStart={(e) => onColDragStart(e, token)}
            onDragOver={(e) => onColDragOver(e, token)}
            onDragLeave={onColDragLeave}
            onDrop={(e) => onColDrop(e, token)}
            onDragEnd={onColDragEnd}
            onContextMenu={(e) =>
              onColumnContextMenu(
                e,
                col.kind === "os"
                  ? { kind: "os", key: col.key, label }
                  : { kind: "image", id: col.id, label },
              )
            }
            onClick={() => onColumnClick(col)}
          >
            <span className="grid-header-kind">{KIND_LABELS[col.kind]}</span>
            <span className="grid-header-label">
              {label}
              <SortIndicator
                target={col}
                sortConfig={sortConfig}
                disabled={sortingDisabled}
              />
            </span>
            <ResizeHandle
              col={token}
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
  imageMetadataOccurrences,
  targetDraftEdits,
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
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onCopyPaths,
  onBulkEdit,
  onShowOnMap,
  onSelectionCountChange,
  onRemoveFieldFromSelectedPhotos,
  onPreviewRemoveFieldFromSelectedPhotos,
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
        imageMetadataOccurrences,
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
  }, [virtualItems, thumbnails, imageMetadataOccurrences]);

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
        imageMetadataOccurrences.get(path) === "loading"
      ) {
        initialPaths.push(path);
      }
    }

    if (initialPaths.length > 0) {
      onVisibilityChange(initialPaths);
    }
  }, [photos, thumbnails, imageMetadataOccurrences, onVisibilityChange]);

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

  function pathsForHeaderRemoveAction(): HeaderActionScope {
    const indices = Array.from(selectedIndices).sort((a, b) => a - b);

    if (indices.length > 0) {
      return {
        scope: "selection",
        paths: indices
          .map((i) => photos[i]?.relative_path)
          .filter((p): p is string => typeof p === "string"),
      };
    }

    if (selectedIndex !== null) {
      const path = photos[selectedIndex]?.relative_path;
      return {
        scope: "selection",
        paths: path ? [path] : [],
      };
    }

    return {
      scope: "all",
      paths: photos.map((p) => p.relative_path),
    };
  }

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  const [columnContextMenu, setColumnContextMenu] = useState<{
    x: number;
    y: number;
    target: ColumnContextTarget;
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
    (e: React.MouseEvent, target: ColumnContextTarget) => {
      e.preventDefault();
      e.stopPropagation();
      const canOpenColumnMenu =
        Boolean(onSelectColumns) ||
        (Boolean(onRemoveFieldFromSelectedPhotos) &&
          Boolean(onPreviewRemoveFieldFromSelectedPhotos));
      if (canOpenColumnMenu) {
        setColumnContextMenu({ x: e.clientX, y: e.clientY, target });
      }
    },
    [
      onSelectColumns,
      onRemoveFieldFromSelectedPhotos,
      onPreviewRemoveFieldFromSelectedPhotos,
    ],
  );

  const handleColumnClick = useCallback(
    (target: { kind: "path" } | VisibleColumn) => {
      // Clicks are always honoured — sortingDisabled only governs whether the
      // *resulting* sort applies and is shown.  Without this, once a user lands
      // in a suspended state (e.g., image-column sort while metadata is still
      // loading) they would be unable to click an OS column to escape it.
      onSortChange(nextSortConfig(sortConfig, target));
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
                imageMetadataOccurrences={imageMetadataOccurrences}
                targetDraftEdits={
                  targetDraftEdits[photo.relative_path] ??
                  EMPTY_TARGET_DRAFT_COLLECTION
                }
                visibleColumns={visibleColumns}
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
          targetDraftEdits={targetDraftEdits}
          onPhotoOpen={onPhotoOpen}
          onShowInExplorer={onShowInExplorer}
          onCopyPaths={onCopyPaths}
          onBulkEdit={onBulkEdit}
          onShowOnMap={onShowOnMap}
          onGenerateAiDescription={onGenerateAiDescription}
          onGeocode={onGeocode}
          onNormalise={onNormalise}
          onApplyEdits={onApplyEdits}
          onDiscardAllEdits={onDiscardAllEdits}
          onClose={() => setContextMenu(null)}
        />
      )}

      {columnContextMenu &&
        (() => {
          const scope = pathsForHeaderRemoveAction();
          const id =
            columnContextMenu.target.kind === "image"
              ? columnContextMenu.target.id
              : null;

          const options = [];
          if (
            columnContextMenu.target.kind === "image" &&
            id &&
            onRemoveFieldFromSelectedPhotos &&
            onPreviewRemoveFieldFromSelectedPhotos &&
            scope.paths.length > 0
          ) {
            const photoNoun = scope.paths.length === 1 ? "photo" : "photos";
            const label =
              scope.scope === "all"
                ? `Remove field from all ${scope.paths.length} ${photoNoun}…`
                : `Remove field from ${scope.paths.length} ${photoNoun}…`;

            options.push({
              label,
              onClick: async () => {
                const preview = onPreviewRemoveFieldFromSelectedPhotos(
                  id,
                  scope.paths,
                );
                if (preview.kind === "blocked") {
                  await showMetadataRemovalPreviewBlocked({
                    tag: columnContextMenu.target.label,
                    relativePath: preview.relativePath,
                    reason: preview.reason,
                  });
                  setColumnContextMenu(null);
                  return;
                }
                if (
                  preview.existingFieldsToDelete +
                    preview.stagedCreationsToCancel ===
                  0
                ) {
                  await showNoMetadataRemovalNeeded(
                    columnContextMenu.target.label,
                  );
                  setColumnContextMenu(null);
                  return;
                }
                const confirmed = await confirmRemoveFieldFromPhotos({
                  tag: columnContextMenu.target.label,
                  preview,
                  scope: scope.scope,
                });
                if (confirmed) {
                  onRemoveFieldFromSelectedPhotos(id, scope.paths);
                }
                setColumnContextMenu(null);
              },
            });
          }

          if (onSelectColumns) {
            options.push({
              label: "Select Columns…",
              onClick: () => {
                onSelectColumns();
                setColumnContextMenu(null);
              },
            });
          }

          if (options.length === 0) return null;

          return (
            <ContextMenu
              x={columnContextMenu.x}
              y={columnContextMenu.y}
              options={options}
              onClose={() => setColumnContextMenu(null)}
            />
          );
        })()}
    </div>
  );
}
