import { useEffect, useRef, useState, useCallback, memo } from "react";
import { useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, Variant } from "../types";
import { Spinner } from "./Spinner";
import { ContextMenu } from "./ContextMenu";

interface Props {
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  imageMetadata: ImageMetadataStore;
  visibleColumns: string[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onShowInExplorer: (index: number) => void;
  onVisibilityChange: (visiblePaths: string[]) => void;
  onPhotoOpen: (index: number) => void;
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

/** 
 * Strips the group prefix from an ExifTool tag name (e.g. IFD0:Model -> Model)
 * for display in the column header.
 */
function displayTagName(tag: string): string {
  const parts = tag.split(":");
  return parts[parts.length - 1];
}

export function PhotoList({ 
  photos, thumbnails, imageMetadata, visibleColumns, 
  selectedIndex, onSelect, onShowInExplorer, onVisibilityChange, onPhotoOpen 
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);
  const visibleRef = useRef<Set<string>>(new Set());
  
  // Use refs for callbacks to avoid re-creating observers when they change
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;
  
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Set up virtualizer
  const rowVirtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 80, // Estimated row height in pixels
    overscan: 10, // Render 10 extra rows above/below viewport for smooth scrolling
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  // Track visibility for prioritization
  useEffect(() => {
    const notify = () => {
      const visibleOrdered = photosRef.current
        .filter(p => visibleRef.current.has(p.relative_path))
        .map(p => p.relative_path);
      
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
  }, [virtualItems]);

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

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number } | null>(null);

  if (photos.length === 0) {
    return (
      <div className="photo-list-empty" data-testid="photo-list-empty">
        No photos found in this folder.
      </div>
    );
  }

  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <div className="photo-table-wrapper" ref={listRef} onClick={() => setContextMenu(null)}>
      <table className="photo-table" data-testid="photo-list" role="grid">
        <thead>
          <tr>
            <th className="col-thumb" rowSpan={2} />
            <th className="col-group-header" colSpan={3}>OS Metadata</th>
            <th className="col-group-header" colSpan={visibleColumns.length}>Image Metadata</th>
          </tr>
          <tr>
            <th className="col-header">Path</th>
            <th className="col-header">Modified</th>
            <th className="col-header">Created</th>
            {visibleColumns.map((col) => (
              <th key={col} className="col-header">{displayTagName(col)}</th>
            ))}
          </tr>
        </thead>
        <tbody ref={tableBodyRef}>
          {/* Spacer for virtual scrolling */}
          <tr style={{ height: `${totalSize}px` }} aria-hidden="true">
            <td colSpan={4 + visibleColumns.length} style={{ padding: 0, border: 0 }} />
          </tr>
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
                onSelect={onSelect}
                onPhotoOpen={onPhotoOpen}
                onContextMenu={handleContextMenu}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              />
            );
          })}
        </tbody>
      </table>

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
  onSelect: (index: number | null) => void;
  onPhotoOpen: (index: number) => void;
  onContextMenu: (e: React.MouseEvent, index: number) => void;
  style?: React.CSSProperties;
}

const PhotoRow = memo(function PhotoRow({ 
  photo, index, selected, thumbnails, imageMetadata, visibleColumns, 
  onSelect, onPhotoOpen, onContextMenu, style 
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

  const handleSelect = useCallback(() => onSelect(index), [onSelect, index]);
  const handleDoubleClick = useCallback(() => onPhotoOpen(index), [onPhotoOpen, index]);
  const handleContextMenuEvent = useCallback((e: React.MouseEvent) => onContextMenu(e, index), [onContextMenu, index]);

  return (
    <tr
      className={`photo-row ${index % 2 === 0 ? "photo-row--even" : "photo-row--odd"} ${selected ? "photo-row--selected" : ""}`}
      data-testid="photo-row"
      data-path={photo.relative_path}
      data-index={index}
      onClick={handleSelect}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenuEvent}
      style={{ ...style, cursor: "pointer" }}
    >
      <td className="col-thumb" aria-hidden="true">
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
      </td>
      <td className="col-path" data-testid="photo-path">{photo.relative_path}</td>
      <td className="col-date" data-testid="photo-date-modified">{formatDate(photo.date_modified)}</td>
      <td className="col-date" data-testid="photo-date-created">{formatDate(photo.date_created)}</td>
      {visibleColumns.map((col) => (
        <td key={col} className="col-metadata">
          {metadataLoading ? (
            <Spinner className="cell-spinner" aria-label="Loading" data-testid="metadata-loading" />
          ) : (
            formatVariant(metadata[col])
          )}
        </td>
      ))}
    </tr>
  );
});
