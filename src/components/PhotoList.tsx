import type { PhotoInfo } from "../types";

interface Props {
  photos: PhotoInfo[];
}

export function PhotoList({ photos }: Props) {
  if (photos.length === 0) {
    return (
      <div className="photo-list-empty" data-testid="photo-list-empty">
        No photos found in this folder.
      </div>
    );
  }

  return (
    <div className="photo-list" data-testid="photo-list" role="list">
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
