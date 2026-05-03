import { useEffect, useRef } from "react";
import type { PhotoInfo } from "../types";

interface Props {
  photos: PhotoInfo[];
  /** Called when the set of visible photo paths changes. */
  onVisibilityChange: (visiblePaths: string[]) => void;
}

export function PhotoList({ photos, onVisibilityChange }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  // Map from relative_path -> whether it's currently intersecting.
  const visibleRef = useRef<Map<string, boolean>>(new Map());
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;

  useEffect(() => {
    if (!listRef.current || photos.length === 0) return;

    const notify = () => {
      const visible = Array.from(visibleRef.current.entries())
        .filter(([, v]) => v)
        .map(([k]) => k);
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

    // Observe every row inside the list.
    const rows = listRef.current.querySelectorAll<HTMLElement>("[data-path]");
    rows.forEach((row) => observer.observe(row));

    return () => observer.disconnect();
  }, [photos]);

  if (photos.length === 0) {
    return (
      <div className="photo-list-empty" data-testid="photo-list-empty">
        No photos found in this folder.
      </div>
    );
  }

  return (
    <div className="photo-list" data-testid="photo-list" role="list" ref={listRef}>
      {photos.map((photo, i) => (
        <PhotoRow key={photo.relative_path} photo={photo} index={i} />
      ))}
    </div>
  );
}

interface RowProps {
  photo: PhotoInfo;
  index: number;
}

function PhotoRow({ photo, index }: RowProps) {
  const src = photo.thumbnail
    ? `data:image/jpeg;base64,${photo.thumbnail}`
    : null;

  return (
    <div
      className={`photo-row ${index % 2 === 0 ? "photo-row--even" : "photo-row--odd"}`}
      data-testid="photo-row"
      data-path={photo.relative_path}
      role="listitem"
    >
      <div className="photo-thumb" aria-hidden="true">
        {src ? (
          <img src={src} alt="" className="photo-thumb-img" />
        ) : (
          <div className="photo-thumb-placeholder" />
        )}
      </div>
      <span className="photo-path" data-testid="photo-path">
        {photo.relative_path}
      </span>
    </div>
  );
}
