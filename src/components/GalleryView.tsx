import { useEffect, useState, useSyncExternalStore, useRef } from "react";
import { useSpinnerSync } from "../hooks/useSpinnerSync";
import { DetailsPane } from "./DetailsPane";
import type {
  MetadataDraftEdit,
  PhotoInfo,
  ImageMetadataStore,
} from "../types";

const GALLERY_DETAILS_VISIBLE_KEY = "media_library_gallery_details_visible";

function loadDetailsVisible(): boolean {
  try {
    return localStorage.getItem(GALLERY_DETAILS_VISIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveDetailsVisible(visible: boolean): void {
  try {
    localStorage.setItem(GALLERY_DETAILS_VISIBLE_KEY, visible ? "1" : "0");
  } catch {
    // localStorage may be unavailable (e.g. in tests) — silently ignore
  }
}

interface Props {
  photos: PhotoInfo[];
  currentIndex: number;
  folderPath: string;
  onClose: () => void;
  onNavigate: (delta: -1 | 1) => void;
  /** Injectable for testing — defaults to the real Tauri invoke */
  loadImage?: (path: string) => Promise<string | null>;
  /** Observable store for image metadata (EXIF, XMP, etc.) */
  imageMetadata?: ImageMetadataStore;
  typedDraftEdits?: Record<string, MetadataDraftEdit>;
  onSetMetadataDraft?: (
    fileRelativePath: string,
    key: string,
    edit: MetadataDraftEdit,
  ) => void;
  onSetMetadataDraftBatch?: (
    fileRelativePath: string,
    edits: Array<{ key: string; edit: MetadataDraftEdit }>,
  ) => void;
  onDiscardDraft?: (fileRelativePath: string, key: string) => void;
  onDiscardAllEdits?: (fileRelativePath: string) => void;
  onApplyEdits?: (fileRelativePath: string) => void;
  /** Trigger the AI-description flow for the currently-displayed photo. */
  onGenerateAiDescription?: (fileRelativePath: string) => void;
  /** Trigger the reverse-geocoding flow for the currently-displayed photo. */
  onGeocode?: (fileRelativePath: string) => void;
  /** Trigger the metadata-normalisation flow for the currently-displayed photo. */
  onNormalise?: (fileRelativePath: string) => void;
  /** Reveal the current photo in the host file manager. Index resolved by the parent. */
  onShowInFileExplorer?: (fileRelativePath: string) => void;
}

export function GalleryView({
  photos,
  currentIndex,
  folderPath,
  onClose,
  onNavigate,
  loadImage,
  imageMetadata,
  typedDraftEdits,
  onSetMetadataDraft,
  onSetMetadataDraftBatch,
  onDiscardDraft,
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onShowInFileExplorer,
}: Props) {
  const photo = photos[currentIndex];
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailsVisible, setDetailsVisibleState] =
    useState<boolean>(loadDetailsVisible);
  const setDetailsVisible = (
    update: boolean | ((prev: boolean) => boolean),
  ) => {
    setDetailsVisibleState((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      saveDetailsVisible(next);
      return next;
    });
  };
  const spinStyle = useSpinnerSync();

  const areaRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Reset zoom on navigation
  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [currentIndex]);

  // Subscribe to this photo's metadata reactively via useSyncExternalStore.
  const metadataState = useSyncExternalStore(
    (cb) =>
      imageMetadata?.subscribe(photo?.relative_path ?? "", cb) ?? (() => {}),
    () => imageMetadata?.get(photo?.relative_path ?? "") ?? "loading",
  );

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
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onNavigate(-1);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onNavigate(1);
      }
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        setDetailsVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!imageSrc) return;

    const zoomFactor = Math.pow(2, e.deltaY * -0.002);
    let newScale = scale * zoomFactor;
    newScale = Math.max(1, Math.min(newScale, 50));

    if (newScale === 1) {
      setScale(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    if (areaRef.current) {
      const rect = areaRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const px = e.clientX - centerX;
      const py = e.clientY - centerY;

      const scaleRatio = newScale / scale;
      const newX = px - (px - pan.x) * scaleRatio;
      const newY = py - (py - pan.y) * scaleRatio;

      const maxPanX = rect.width * newScale * 0.45;
      const maxPanY = rect.height * newScale * 0.45;

      setPan({
        x: Math.max(-maxPanX, Math.min(newX, maxPanX)),
        y: Math.max(-maxPanY, Math.min(newY, maxPanY)),
      });
    }
    setScale(newScale);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 1) {
      e.preventDefault();
      setScale(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    if (scale <= 1 || !imageSrc || e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !areaRef.current) return;
    const rect = areaRef.current.getBoundingClientRect();
    const maxPanX = rect.width * scale * 0.45;
    const maxPanY = rect.height * scale * 0.45;

    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;

    setPan({
      x: Math.max(-maxPanX, Math.min(newX, maxPanX)),
      y: Math.max(-maxPanY, Math.min(newY, maxPanY)),
    });
  };

  const handleMouseUpOrLeave = () => {
    setIsDragging(false);
  };

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
        className={`gallery-content ${detailsVisible ? "gallery-content--with-details" : ""}`}
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
          className={`gallery-info-toggle ${detailsVisible ? "gallery-info-toggle--active" : ""}`}
          data-testid="gallery-info-toggle"
          onClick={() => setDetailsVisible((v) => !v)}
          aria-label={detailsVisible ? "Hide details" : "Show details"}
          title={detailsVisible ? "Hide details (I)" : "Show details (I)"}
        >
          ℹ
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

        <div
          className="gallery-image-area"
          data-testid="gallery-image-area"
          ref={areaRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUpOrLeave}
          onMouseLeave={handleMouseUpOrLeave}
          style={{ overflow: "hidden" }}
        >
          {loading ? (
            <div
              style={spinStyle}
              className="gallery-spinner"
              data-testid="gallery-spinner"
            />
          ) : imageSrc ? (
            <img
              src={imageSrc}
              alt={photo.relative_path}
              className="gallery-image"
              data-testid="gallery-image"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                transition: isDragging ? "none" : "transform 0.1s ease-out",
                cursor:
                  scale > 1 ? (isDragging ? "grabbing" : "grab") : "default",
              }}
              draggable={false}
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

        {detailsVisible && (
          <DetailsPane
            photo={photo}
            metadata={metadataState}
            typedDraftEdits={typedDraftEdits}
            onSetMetadataDraft={(key, edit) =>
              onSetMetadataDraft?.(photo.relative_path, key, edit)
            }
            onSetMetadataDraftBatch={(edits) =>
              onSetMetadataDraftBatch?.(photo.relative_path, edits)
            }
            onDiscardDraft={(key) => onDiscardDraft?.(photo.relative_path, key)}
            onDiscardAllEdits={() => onDiscardAllEdits?.(photo.relative_path)}
            onApplyEdits={() => onApplyEdits?.(photo.relative_path)}
            onGenerateAiDescription={
              onGenerateAiDescription
                ? () => onGenerateAiDescription(photo.relative_path)
                : undefined
            }
            onGeocode={
              onGeocode ? () => onGeocode(photo.relative_path) : undefined
            }
            onNormalise={
              onNormalise ? () => onNormalise(photo.relative_path) : undefined
            }
            onShowInFileExplorer={
              onShowInFileExplorer
                ? () => onShowInFileExplorer(photo.relative_path)
                : undefined
            }
          />
        )}

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
