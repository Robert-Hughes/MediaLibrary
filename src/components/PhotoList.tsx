import { useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";
import type { PhotoInfo, ThumbnailStore, MetadataStore } from "../types";

interface Props {
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  metadata: MetadataStore;
  scanning: boolean;
  onVisibilityChange: (visiblePaths: string[]) => void;
  onPhotoOpen: (index: number) => void;
}

function formatDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

export function PhotoList({ photos, thumbnails, metadata, scanning, onVisibilityChange, onPhotoOpen }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<Map<string, boolean>>(new Map());
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;

  useEffect(() => {
    if (!listRef.current || photos.length === 0) return;

    const notify = () => {
      const visible = Array.from(visibleRef.current.entries())
        .filter(([, v]) => v).map(([k]) => k);
      onVisibilityChangeRef.current(visible);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.path;
          if (path) visibleRef.current.set(path, entry.isIntersecting);
        }
        notify();
      },
      { root: listRef.current.parentElement, threshold: 0 }
    );

    const rows = listRef.current.querySelectorAll<HTMLElement>("[data-path]");
    rows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [photos]);

  if (photos.length === 0 && !scanning) {
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
            <th className="col-group-header" colSpan={3}>Camera</th>
          </tr>
          <tr>
            <th className="col-header">Filename</th>
            <th className="col-header">Modified</th>
            <th className="col-header">Created</th>
            <th className="col-header">Date Taken</th>
            <th className="col-header">Camera</th>
            <th className="col-header">Path</th>
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
          {scanning && (
            <tr data-testid="scanning-row">
              <td colSpan={7} className="scanning-footer">
                <span className="scanning-spinner" aria-hidden="true" />
                <span className="scanning-label">Scanning…</span>
              </td>
            </tr>
          )}
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
            <div className="photo-thumb-spinner" />
          ) : (
            <div className="photo-thumb-placeholder" />
          )}
        </div>
      </td>
      <td className="col-filename" data-testid="photo-filename">{photo.filename}</td>
      <td className="col-date" data-testid="photo-date-modified">{formatDate(photo.date_modified)}</td>
      <td className="col-date" data-testid="photo-date-created">{formatDate(photo.date_created)}</td>
      <td className="col-date" data-testid="photo-date-taken">{exif.date_taken ?? "—"}</td>
      <td className="col-camera" data-testid="photo-camera">{exif.camera_model ?? "—"}</td>
      <td className="col-path" data-testid="photo-path">{photo.relative_path}</td>
    </tr>
  );
}
