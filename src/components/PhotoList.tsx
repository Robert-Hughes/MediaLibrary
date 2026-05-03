import { useEffect, useRef, useState, useCallback, memo } from "react";
import { useSyncExternalStore } from "react";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo } from "../types";
import { Spinner } from "./Spinner";
import { ContextMenu } from "./ContextMenu";

interface Props {
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  imageMetadata: ImageMetadataStore;
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

export function PhotoList({ photos, thumbnails, imageMetadata, selectedIndex, onSelect, onShowInExplorer, onVisibilityChange, onPhotoOpen }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<Set<string>>(new Set());
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, index: number } | null>(null);

  useEffect(() => {
    if (!listRef.current) return;

    const notify = () => {
      // Return visible paths in the order they appear in the photos array
      // to ensure consistent prioritization.
      const visibleOrdered = photos
        .filter(p => visibleRef.current.has(p.relative_path))
        .map(p => p.relative_path);
      
      if (visibleOrdered.length > 0) {
        onVisibilityChangeRef.current(visibleOrdered);
      }
    };

    const observer = new IntersectionObserver(
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
        root: listRef.current, // Use the scrolling container as root
        threshold: 0 
      }
    );

    // Observe newly added rows
    const rows = listRef.current.querySelectorAll<HTMLElement>("[data-path]");
    rows.forEach((row) => observer.observe(row));

    return () => observer.disconnect();
  }, [photos]); // We still need to re-scan for new rows when photos change

  useEffect(() => {
    if (selectedIndex !== null && listRef.current) {
      const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      if (selectedEl && selectedEl.scrollIntoView) {
        selectedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [selectedIndex]);

  const handleContextMenu = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault();
    onSelect(index);
    setContextMenu({ x: e.clientX, y: e.clientY, index });
  }, [onSelect]);

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
            <th className="col-group-header" colSpan={2}>Image Metadata</th>
          </tr>
          <tr>
            <th className="col-header">Path</th>
            <th className="col-header">Modified</th>
            <th className="col-header">Created</th>
            <th className="col-header">Date Taken</th>
            <th className="col-header">Camera</th>
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
              onClick={() => onSelect(i)}
              onDoubleClick={() => onPhotoOpen(i)}
              onContextMenu={(e) => handleContextMenu(e, i)}
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
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const PhotoRow = memo(function PhotoRow({ photo, index, selected, thumbnails, imageMetadata, onClick, onDoubleClick, onContextMenu }: RowProps) {
  const thumbnail = useSyncExternalStore(
    (cb) => thumbnails.subscribe(photo.relative_path, cb),
    thumbnails.getSnapshot(photo.relative_path),
  );

  const exif = useSyncExternalStore(
    (cb) => imageMetadata.subscribe(photo.relative_path, cb),
    imageMetadata.getSnapshot(photo.relative_path),
  );

  const isLoading = thumbnail === "loading";
  const hasSrc = thumbnail !== "loading" && thumbnail !== "failed";
  const src = hasSrc ? `data:image/jpeg;base64,${thumbnail}` : null;

  const exifLoading = exif === "loading";
  const dateTaken   = exifLoading ? null : exif.date_taken;
  const cameraModel = exifLoading ? null : exif.camera_model;

  return (
    <tr
      className={`photo-row ${index % 2 === 0 ? "photo-row--even" : "photo-row--odd"} ${selected ? "photo-row--selected" : ""}`}
      data-testid="photo-row"
      data-path={photo.relative_path}
      data-index={index}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
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
      <td className="col-date" data-testid="photo-date-taken">
        {exifLoading
          ? <Spinner className="cell-spinner" aria-label="Loading" data-testid="exif-loading" />
          : (dateTaken ?? "—")}
      </td>
      <td className="col-camera" data-testid="photo-camera">
        {exifLoading
          ? <Spinner className="cell-spinner" aria-label="Loading" />
          : (cameraModel ?? "—")}
      </td>
    </tr>
  );
});
