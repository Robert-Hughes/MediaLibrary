import { useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";
import type { PhotoInfo, ThumbnailStore, MetadataStore } from "../types";
import { Spinner } from "./Spinner";
interface Props {
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  metadata: MetadataStore;
  onVisibilityChange: (visiblePaths: string[]) => void;
  onPhotoOpen: (index: number) => void;
}

function formatDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

export function PhotoList({ photos, thumbnails, metadata, onVisibilityChange, onPhotoOpen }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<Set<string>>(new Set());
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;

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

  if (photos.length === 0) {
    return (
      <div className="photo-list-empty" data-testid="photo-list-empty">
        No photos found in this folder.
      </div>
    );
  }

  return (
    <div className="photo-table-wrapper" ref={listRef}>
      <table className="photo-table" data-testid="photo-list" role="grid">
        <thead>
          <tr>
            <th className="col-thumb" rowSpan={2} />
            <th className="col-group-header" colSpan={3}>File</th>
            <th className="col-group-header" colSpan={2}>Photo</th>
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
              thumbnails={thumbnails}
              metadata={metadata}
              onDoubleClick={() => onPhotoOpen(i)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  photo: PhotoInfo;
  index: number;
  thumbnails: ThumbnailStore;
  metadata: MetadataStore;
  onDoubleClick: () => void;
}

function PhotoRow({ photo, index, thumbnails, metadata, onDoubleClick }: RowProps) {
  const thumbnail = useSyncExternalStore(
    (cb) => thumbnails.subscribe(photo.relative_path, cb),
    thumbnails.getSnapshot(photo.relative_path),
  );

  const exif = useSyncExternalStore(
    (cb) => metadata.subscribe(photo.relative_path, cb),
    metadata.getSnapshot(photo.relative_path),
  );

  const isLoading = thumbnail === "loading";
  const hasSrc = thumbnail !== "loading" && thumbnail !== "failed";
  const src = hasSrc ? `data:image/jpeg;base64,${thumbnail}` : null;

  const exifLoading = exif === "loading";
  const dateTaken   = exifLoading ? null : exif.date_taken;
  const cameraModel = exifLoading ? null : exif.camera_model;

  return (
    <tr
      className={`photo-row ${index % 2 === 0 ? "photo-row--even" : "photo-row--odd"}`}
      data-testid="photo-row"
      data-path={photo.relative_path}
      onDoubleClick={onDoubleClick}
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
}
