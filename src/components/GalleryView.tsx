import { useEffect, useState, useSyncExternalStore, useRef } from "react";
import { useSpinnerSync } from "../hooks/useSpinnerSync";
import { DetailsPane } from "./DetailsPane";
import type {
  MetadataDraftEdit,
  FileInfo,
  FileMetadataOccurrencesState,
  FileMetadataOccurrencesStore,
  MetadataDraftTarget,
  MetadataTargetDraftEntry,
  TargetDraftPersistenceState,
} from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { ModalDialog } from "./ModalDialog";

const GALLERY_DETAILS_VISIBLE_KEY = "media_library_gallery_details_visible";
const GALLERY_DETAILS_WIDTH_KEY = "media_library_gallery_details_width";
const DEFAULT_DETAILS_WIDTH = 360;
const MIN_DETAILS_WIDTH = 280;
const MAX_DETAILS_WIDTH = 720;
const MIN_GALLERY_WIDTH = 320;

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

function clampStoredDetailsWidth(width: number): number {
  return Math.min(MAX_DETAILS_WIDTH, Math.max(MIN_DETAILS_WIDTH, width));
}

function loadDetailsWidth(): number {
  try {
    const stored = Number(localStorage.getItem(GALLERY_DETAILS_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clampStoredDetailsWidth(stored)
      : DEFAULT_DETAILS_WIDTH;
  } catch {
    return DEFAULT_DETAILS_WIDTH;
  }
}

function saveDetailsWidth(width: number): void {
  try {
    localStorage.setItem(GALLERY_DETAILS_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // localStorage may be unavailable (e.g. in tests) — silently ignore
  }
}

function availableDetailsWidth(): number {
  const viewportWidth =
    typeof window === "undefined" ? 1024 : window.innerWidth;
  return Math.max(
    MIN_DETAILS_WIDTH,
    Math.min(MAX_DETAILS_WIDTH, viewportWidth - MIN_GALLERY_WIDTH),
  );
}

interface DetailsResizeDrag {
  pointerId: number;
  startX: number;
  startWidth: number;
  currentWidth: number;
}

interface Props {
  files: FileInfo[];
  currentIndex: number;
  folderPath: string;
  onClose: () => void;
  onNavigate: (delta: -1 | 1) => void;
  /** Injectable for testing — defaults to the real Tauri invoke */
  loadMedia?: (path: string) => Promise<string | null>;
  /** Observable authoritative occurrence store. */
  fileMetadataOccurrences: FileMetadataOccurrencesStore;
  targetDraftEdits?: TargetDraftCollection;
  targetDraftPersistence?: TargetDraftPersistenceState;
  onSetExistingOccurrenceDraft?: (
    fileRelativePath: string,
    target: Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }>,
    edit: MetadataDraftEdit,
  ) => void;
  onRemoveMetadataTargets?: (
    fileRelativePath: string,
    targets: MetadataDraftTarget[],
  ) => boolean;
  onApplyGpsTargetDraftBatch?: (
    fileRelativePath: string,
    entries: MetadataTargetDraftEntry[],
  ) => boolean;
  onSetNewPropertyDraft?: (
    fileRelativePath: string,
    target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    edit: MetadataDraftEdit,
  ) => Promise<boolean>;
  onReplaceNewPropertyDraftTarget?: (
    fileRelativePath: string,
    originalTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    replacementTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    originalEdit: MetadataDraftEdit,
  ) => Promise<boolean>;
  onDiscardTargetPropertyDraft?: (
    fileRelativePath: string,
    target: MetadataDraftTarget,
  ) => void;
  onDiscardTargetDraftBatch?: (
    fileRelativePath: string,
    targets: MetadataDraftTarget[],
  ) => boolean;
  onDiscardAllEdits?: (fileRelativePath: string) => void;
  onApplyEdits?: (fileRelativePath: string) => void;
  /** Trigger the AI-description flow for the currently-displayed file. */
  onGenerateAiDescription?: (fileRelativePath: string) => void;
  /** Trigger the reverse-geocoding flow for the currently-displayed file. */
  onGeocode?: (fileRelativePath: string) => void;
  /** Trigger the metadata-normalisation flow for the currently-displayed file. */
  onNormalise?: (fileRelativePath: string) => void;
  /** Reveal the current file in the host file manager. Index resolved by the parent. */
  onShowInFileExplorer?: (fileRelativePath: string) => void;
  /** Open the current file in the app-level full map view. */
  onOpenFullMap?: (fileRelativePath: string) => void;
}

export function GalleryView({
  files,
  currentIndex,
  folderPath,
  onClose,
  onNavigate,
  loadMedia,
  fileMetadataOccurrences,
  targetDraftEdits,
  targetDraftPersistence,
  onSetExistingOccurrenceDraft,
  onRemoveMetadataTargets,
  onApplyGpsTargetDraftBatch,
  onSetNewPropertyDraft,
  onReplaceNewPropertyDraftTarget,
  onDiscardTargetPropertyDraft,
  onDiscardTargetDraftBatch,
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onShowInFileExplorer,
  onOpenFullMap,
}: Props) {
  const file = files[currentIndex];
  const [mediaSource, setMediaSource] = useState<{
    path: string;
    src: string;
  } | null>(null);
  const [readyPath, setReadyPath] = useState<string | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [detailsVisible, setDetailsVisibleState] =
    useState<boolean>(loadDetailsVisible);
  const [detailsWidth, setDetailsWidth] = useState(loadDetailsWidth);
  const detailsResizeDragRef = useRef<DetailsResizeDrag | null>(null);
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

  const setClampedDetailsWidth = (width: number, persist: boolean) => {
    const next = Math.min(
      availableDetailsWidth(),
      Math.max(MIN_DETAILS_WIDTH, width),
    );
    setDetailsWidth(next);
    if (persist) saveDetailsWidth(next);
    return next;
  };

  const handleDetailsResizeStart = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = Math.min(detailsWidth, availableDetailsWidth());
    detailsResizeDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth,
      currentWidth: startWidth,
    };
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const handleDetailsResizeMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = detailsResizeDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = setClampedDetailsWidth(
      drag.startWidth + (drag.startX - e.clientX),
      false,
    );
    drag.currentWidth = next;
  };

  const handleDetailsResizeEnd = (e: React.PointerEvent<HTMLElement>) => {
    const drag = detailsResizeDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    detailsResizeDragRef.current = null;
    saveDetailsWidth(drag.currentWidth);
  };

  const handleDetailsResizeKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    let next: number | null = null;
    const step = e.shiftKey ? 50 : 10;
    const currentWidth = Math.min(detailsWidth, availableDetailsWidth());
    if (e.key === "ArrowLeft") next = currentWidth + step;
    if (e.key === "ArrowRight") next = currentWidth - step;
    if (e.key === "Home") next = MIN_DETAILS_WIDTH;
    if (e.key === "End") next = availableDetailsWidth();
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setClampedDetailsWidth(next, true);
  };

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

  // This hook is unconditional so navigation changes the subscribed path and
  // unsubscribes from the previously displayed file.
  const occurrencesState: FileMetadataOccurrencesState = useSyncExternalStore(
    (cb) => fileMetadataOccurrences.subscribe(file?.relative_path ?? "", cb),
    () => fileMetadataOccurrences.get(file?.relative_path ?? ""),
  );

  // Resolve the asset URL whenever the current file changes. The media remains
  // in its loading state until the newly-mounted element reports readiness.
  useEffect(() => {
    if (!file || !loadMedia) return;
    const path = file.relative_path;
    let current = true;
    setFailedPath(null);
    const absPath = `${folderPath}/${path}`.replace(/\\/g, "/");

    loadMedia(absPath)
      .then((src) => {
        if (!current) return;
        if (src) setMediaSource({ path, src });
        else setFailedPath(path);
      })
      .catch(() => {
        if (current) setFailedPath(path);
      });

    return () => {
      current = false;
    };
  }, [file, folderPath, loadMedia]);

  const currentPath = file?.relative_path ?? null;
  const mediaSrc = mediaSource?.path === currentPath ? mediaSource.src : null;
  const loading =
    currentPath !== null &&
    failedPath !== currentPath &&
    readyPath !== currentPath;
  const markMediaReady = () => {
    if (currentPath) setReadyPath(currentPath);
  };
  const markMediaFailed = () => {
    if (!currentPath) return;
    setFailedPath(currentPath);
    setMediaSource((source) => (source?.path === currentPath ? null : source));
  };
  const onKey = (e: React.KeyboardEvent<HTMLDialogElement>) => {
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

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!mediaSrc) return;

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
    if (scale <= 1 || !mediaSrc || e.button !== 0) return;
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

  if (!file) return null;

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < files.length - 1;
  const effectiveDetailsWidth = Math.min(detailsWidth, availableDetailsWidth());

  return (
    <ModalDialog
      open
      onDismiss={onClose}
      className="gallery-dialog"
      testId="gallery-overlay"
      aria-label="File gallery"
      onKeyDown={onKey}
    >
      <div
        className={`gallery-content ${detailsVisible ? "gallery-content--with-details" : ""}`}
        data-testid="gallery-content"
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
          aria-label="Previous file"
        >
          ‹
        </button>

        <div
          className="gallery-media-area"
          data-testid="gallery-media-area"
          ref={areaRef}
          onWheel={file.media_kind === "image" ? handleWheel : undefined}
          onMouseDown={
            file.media_kind === "image" ? handleMouseDown : undefined
          }
          onMouseMove={
            file.media_kind === "image" ? handleMouseMove : undefined
          }
          onMouseUp={
            file.media_kind === "image" ? handleMouseUpOrLeave : undefined
          }
          onMouseLeave={
            file.media_kind === "image" ? handleMouseUpOrLeave : undefined
          }
          style={{ overflow: "hidden" }}
        >
          {loading && (
            <div
              style={spinStyle}
              className="gallery-spinner"
              data-testid="gallery-spinner"
            />
          )}
          {mediaSrc &&
            (file.media_kind === "image" ? (
              <img
                key={currentPath}
                src={mediaSrc}
                alt={file.relative_path}
                className="gallery-image"
                data-testid="gallery-image"
                onLoad={markMediaReady}
                onError={markMediaFailed}
                style={{
                  visibility: loading ? "hidden" : "visible",
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                  transition: isDragging ? "none" : "transform 0.1s ease-out",
                  cursor:
                    scale > 1 ? (isDragging ? "grabbing" : "grab") : "default",
                }}
                draggable={false}
              />
            ) : file.media_kind === "audio" ? (
              <audio
                key={currentPath}
                src={mediaSrc}
                className="gallery-audio"
                data-testid="gallery-audio"
                onLoadedData={markMediaReady}
                onError={markMediaFailed}
                style={{ visibility: loading ? "hidden" : "visible" }}
                controls
              />
            ) : (
              <video
                key={currentPath}
                src={mediaSrc}
                className="gallery-video"
                data-testid="gallery-video"
                onLoadedData={markMediaReady}
                onError={markMediaFailed}
                style={{ visibility: loading ? "hidden" : "visible" }}
                controls
              />
            ))}
          {!loading && !mediaSrc && (
            <div className="gallery-error" data-testid="gallery-error">
              Could not load file
            </div>
          )}
        </div>

        <button
          className="gallery-nav gallery-nav--next"
          data-testid="gallery-next-btn"
          onClick={() => onNavigate(1)}
          disabled={!hasNext}
          aria-label="Next file"
        >
          ›
        </button>

        {detailsVisible && (
          <div
            className="gallery-details-region"
            data-testid="gallery-details-region"
            style={{ width: `${effectiveDetailsWidth}px` }}
          >
            <div
              className="gallery-details-resize-handle"
              data-testid="gallery-details-resize-handle"
              role="separator"
              aria-label="Resize details pane"
              aria-orientation="vertical"
              aria-valuemin={MIN_DETAILS_WIDTH}
              aria-valuemax={availableDetailsWidth()}
              aria-valuenow={Math.round(effectiveDetailsWidth)}
              tabIndex={0}
              title="Drag to resize; double-click to reset"
              onPointerDown={handleDetailsResizeStart}
              onPointerMove={handleDetailsResizeMove}
              onPointerUp={handleDetailsResizeEnd}
              onPointerCancel={handleDetailsResizeEnd}
              onKeyDown={handleDetailsResizeKeyDown}
              onDoubleClick={() =>
                setClampedDetailsWidth(DEFAULT_DETAILS_WIDTH, true)
              }
            />
            <DetailsPane
              file={file}
              occurrences={occurrencesState}
              targetDraftEdits={targetDraftEdits}
              targetDraftPersistence={targetDraftPersistence}
              onSetExistingOccurrenceDraft={(target, edit) =>
                onSetExistingOccurrenceDraft?.(file.relative_path, target, edit)
              }
              onRemoveMetadataTargets={(targets) =>
                onRemoveMetadataTargets?.(file.relative_path, targets) ?? false
              }
              onApplyGpsTargetDraftBatch={(entries) =>
                onApplyGpsTargetDraftBatch?.(file.relative_path, entries) ??
                false
              }
              onSetNewPropertyDraft={(target, edit) =>
                onSetNewPropertyDraft?.(file.relative_path, target, edit) ??
                Promise.resolve(false)
              }
              onReplaceNewPropertyDraftTarget={(
                originalTarget,
                replacementTarget,
                originalEdit,
              ) =>
                onReplaceNewPropertyDraftTarget?.(
                  file.relative_path,
                  originalTarget,
                  replacementTarget,
                  originalEdit,
                ) ?? Promise.resolve(false)
              }
              onDiscardTargetPropertyDraft={(target) =>
                onDiscardTargetPropertyDraft?.(file.relative_path, target)
              }
              onDiscardTargetDraftBatch={(targets) =>
                onDiscardTargetDraftBatch?.(file.relative_path, targets) ??
                false
              }
              onDiscardAllEdits={() => onDiscardAllEdits?.(file.relative_path)}
              onApplyEdits={() => onApplyEdits?.(file.relative_path)}
              onGenerateAiDescription={
                onGenerateAiDescription
                  ? () => onGenerateAiDescription(file.relative_path)
                  : undefined
              }
              onGeocode={
                onGeocode ? () => onGeocode(file.relative_path) : undefined
              }
              onNormalise={
                onNormalise ? () => onNormalise(file.relative_path) : undefined
              }
              onShowInFileExplorer={
                onShowInFileExplorer
                  ? () => onShowInFileExplorer(file.relative_path)
                  : undefined
              }
              onOpenFullMap={
                onOpenFullMap
                  ? () => onOpenFullMap(file.relative_path)
                  : undefined
              }
            />
          </div>
        )}

        <div className="gallery-caption" data-testid="gallery-caption">
          <span className="gallery-path">{file.relative_path}</span>
          <span className="gallery-counter">
            {currentIndex + 1} / {files.length}
          </span>
        </div>
      </div>
    </ModalDialog>
  );
}
