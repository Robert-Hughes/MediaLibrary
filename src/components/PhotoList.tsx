import { useEffect, useRef, useState, useCallback, memo } from "react";
import { useSyncExternalStore } from "react";
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
  const visibleRef = useRef<Set<string>>(new Set());
  
  // Use refs for callbacks to avoid re-creating observers when they change
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;
  
  const photosRef = useRef(photos);
  photosRef.current = photos;

  useEffect(() => {
    if (!listRef.current) return;

    const notify = () => {
      const visibleOrdered = photosRef.current
        .filter(p => visibleRef.current.has(p.relative_path))
        .map(p => p.relative_path);
      
      if (visibleOrdered.length > 0) {
        onVisibilityChangeRef.current(visibleOrdered);
      }
    };

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.path;
          if (!path) continue;

          if (entry.isIntersecting) {
            if (!visibleRef.current.has(path)) {
              visibleRef.current.add(path);
              changed = true;
            }
          } else {
            if (visibleRef.current.has(path)) {
              visibleRef.current.delete(path);
              changed = true;
            }
          }
        }
        if (changed) {
          notify();
        }
      },
      { 
        root: listRef.current,
        threshold: 0 
      }
    );

    // Watch for new rows being added to the table body
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement && node.dataset.path) {
            intersectionObserver.observe(node);
          } else if (node instanceof HTMLElement) {
            // Check children if the node itself isn't a row (though usually it will be)
            node.querySelectorAll("[data-path]").forEach(el => intersectionObserver.observe(el as HTMLElement));
          }
        }
      }
    });

    mutationObserver.observe(listRef.current, { childList: true, subtree: true });

    // Initial observation
    listRef.current.querySelectorAll<HTMLElement>("[data-path]").forEach(el => intersectionObserver.observe(el));

    return () => {
      intersectionObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []); // Only run once on mount

  useEffect(() => {
    if (selectedIndex !== null && listRef.current) {
      const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      if (selectedEl && (selectedEl as any).scrollIntoView) {
        (selectedEl as any).scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [selectedIndex]);

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
        <tbody>
          {photos.map((photo, i) => (
            <PhotoRow
              key={photo.relative_path}
              photo={photo}
              index={i}
              selected={selectedIndex === i}
              thumbnails={thumbnails}
              imageMetadata={imageMetadata}
              visibleColumns={visibleColumns}
              onSelect={onSelect}
              onPhotoOpen={onPhotoOpen}
              onContextMenu={handleContextMenu}
            />
          ))}
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
}

const PhotoRow = memo(function PhotoRow({ 
  photo, index, selected, thumbnails, imageMetadata, visibleColumns, 
  onSelect, onPhotoOpen, onContextMenu 
}: RowProps) {
  const thumbnail = useSyncExternalStore(
    (cb) => thumbnails.subscribe(photo.relative_path, cb),
    thumbnails.getSnapshot(photo.relative_path),
  );

  const metadata = useSyncExternalStore(
    (cb) => imageMetadata.subscribe(photo.relative_path, cb),
    imageMetadata.getSnapshot(photo.relative_path),
  );

  const isLoading = thumbnail === "loading";
  const hasSrc = thumbnail !== "loading" && thumbnail !== "failed";
  const src = hasSrc ? `data:image/jpeg;base64,${thumbnail}` : null;

  const metadataLoading = metadata === "loading";

  return (
    <tr
      className={`photo-row ${index % 2 === 0 ? "photo-row--even" : "photo-row--odd"} ${selected ? "photo-row--selected" : ""}`}
      data-testid="photo-row"
      data-path={photo.relative_path}
      data-index={index}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onPhotoOpen(index)}
      onContextMenu={(e) => onContextMenu(e, index)}
      style={{ cursor: "pointer" }}
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
