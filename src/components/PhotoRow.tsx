import { memo, useCallback, useSyncExternalStore } from "react";
import type { ImageMetadataStore, PhotoInfo, ThumbnailStore, Variant } from "../types";
import { Spinner } from "./Spinner";

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

export const PhotoRow = memo(function PhotoRow({
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
