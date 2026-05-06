import { useEffect, useState } from "react";
import { useSpinnerSync } from "../hooks/useSpinnerSync";
import type { PhotoInfo } from "../types";

interface Props {
  photos: PhotoInfo[];
  currentIndex: number;
  folderPath: string;
  onClose: () => void;
  onNavigate: (delta: -1 | 1) => void;
  /** Injectable for testing — defaults to the real Tauri invoke */
  loadImage?: (path: string) => Promise<string | null>;
}

export function GalleryView({ photos, currentIndex, folderPath, onClose, onNavigate, loadImage }: Props) {
  const photo = photos[currentIndex];
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const spinStyle = useSpinnerSync();

  // Load the full image whenever the current photo changes.
  useEffect(() => {
    if (!photo || !loadImage) return;
    setLoading(true);
    setImageSrc(null);
    const absPath = `${folderPath}/${photo.relative_path}`.replace(/\\/g, "/");
    loadImage(absPath).then((src) => {
      setImageSrc(src);
      setLoading(false);
    });
  }, [photo, folderPath, loadImage]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowLeft")  { e.preventDefault(); onNavigate(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); onNavigate(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate]);

  if (!photo) return null;

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < photos.length - 1;

  return (
    <div
      className="gallery-overlay"
      data-testid="gallery-overlay"
      onClick={onClose}
    >
      {/* Stop clicks on the inner content from closing the overlay */}
      <div
        className="gallery-content"
        data-testid="gallery-content"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="gallery-close"
          data-testid="gallery-close-btn"
          onClick={onClose}
          aria-label="Close gallery"
        >
          ✕
        </button>

        <button
          className="gallery-nav gallery-nav--prev"
          data-testid="gallery-prev-btn"
          onClick={() => onNavigate(-1)}
          disabled={!hasPrev}
          aria-label="Previous photo"
        >
          ‹
        </button>

        <div className="gallery-image-area" data-testid="gallery-image-area">
          {loading ? (
            <div style={spinStyle} className="gallery-spinner" data-testid="gallery-spinner" />
          ) : imageSrc ? (
            <img
              src={imageSrc}
              alt={photo.relative_path}
              className="gallery-image"
              data-testid="gallery-image"
            />
          ) : (
            <div className="gallery-error" data-testid="gallery-error">
              Could not load image
            </div>
          )}
        </div>

        <button
          className="gallery-nav gallery-nav--next"
          data-testid="gallery-next-btn"
          onClick={() => onNavigate(1)}
          disabled={!hasNext}
          aria-label="Next photo"
        >
          ›
        </button>

        <div className="gallery-caption" data-testid="gallery-caption">
          <span className="gallery-path">{photo.relative_path}</span>
          <span className="gallery-counter">
            {currentIndex + 1} / {photos.length}
          </span>
        </div>
      </div>
    </div>
  );
}
