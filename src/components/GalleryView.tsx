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
  MetadataRemovalPreview,
  SchemaMetadataEdit,
  TargetDraftPersistenceState,
} from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { confirmRecycleFiles } from "../utils/recyclePrompts";
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
  ) => boolean | Promise<boolean>;
  onPreviewMetadataTargetRemovals?: (
    fileRelativePath: string,
    targets: MetadataDraftTarget[],
  ) => Promise<MetadataRemovalPreview | null>;
  onPreviewGpsTargetDraftBatch?: (
    fileRelativePath: string,
    edits: SchemaMetadataEdit[],
  ) => Promise<MetadataTargetDraftEntry[] | null>;
  onApplyGpsTargetDraftBatch?: (
    fileRelativePath: string,
    edits: SchemaMetadataEdit[],
  ) => Promise<boolean>;
  onSetNewPropertyDraft?: (
    fileRelativePath: string,
    target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    edit: MetadataDraftEdit,
  ) => boolean | Promise<boolean>;
  onReplaceNewPropertyDraftTarget?: (
    fileRelativePath: string,
    originalTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    replacementTarget: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
    originalEdit: MetadataDraftEdit,
  ) => boolean | Promise<boolean>;
  onDiscardTargetPropertyDraft?: (
    fileRelativePath: string,
    target: MetadataDraftTarget,
  ) => void;
  onDiscardTargetDraftBatch?: (
    fileRelativePath: string,
    targets: MetadataDraftTarget[],
  ) => boolean | Promise<boolean>;
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
  /** Move the currently-displayed file to the host recycle bin. */
  onRecycleFile?: (fileRelativePath: string) => void | Promise<void>;
}

function isGalleryShortcutEventSafe(
  event: React.KeyboardEvent<HTMLDialogElement>,
): boolean {
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return false;
  }

  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    )
  ) {
    return false;
  }
  if (target.closest(".context-menu")) return false;
  return target.closest("dialog") === event.currentTarget;
}

/**
 * Append a cache-busting query parameter so a rewritten file is fetched again.
 *
 * The gallery preview serves the file through Tauri's asset protocol, whose URL
 * is derived only from the path. When apply rewrites the file in place (for
 * example a corrected EXIF Orientation tag), the URL is byte-identical and the
 * WebView may serve a cached copy. `data:`/`blob:` URLs are inline and have no
 * cache, so they are left untouched.
 */
function cacheBustedSrc(src: string, nonce: number): string {
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}v=${nonce}`;
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
  onPreviewMetadataTargetRemovals,
  onPreviewGpsTargetDraftBatch,
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
  onRecycleFile,
}: Props) {
  const file = files[currentIndex];
  const [mediaSource, setMediaSource] = useState<{
    path: string;
    src: string;
  } | null>(null);
  const [readyPath, setReadyPath] = useState<string | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  // Monotonic bump that forces the preview <img> to remount and re-fetch when
  // the current file is rewritten in place. Kept as transient local state rather
  // than a stored revision: it only needs to change to invalidate the URL/key.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [detailsVisible, setDetailsVisibleState] =
    useState<boolean>(loadDetailsVisible);
  const [detailsWidth, setDetailsWidth] = useState(loadDetailsWidth);
  const detailsResizeDragRef = useRef<DetailsResizeDrag | null>(null);
  const recyclePendingRef = useRef(false);
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
  const subscribeMetadata = (cb: () => void) =>
    fileMetadataOccurrences.subscribe(file?.relative_path ?? "", cb);
  const occurrencesState: FileMetadataOccurrencesState = useSyncExternalStore(
    subscribeMetadata,
    () => fileMetadataOccurrences.get(file?.relative_path ?? ""),
  );
  const metadataFailure = useSyncExternalStore(subscribeMetadata, () =>
    fileMetadataOccurrences.getFailure(file?.relative_path ?? ""),
  );

  // Refresh the preview when apply rewrites the current file in place.
  //
  // The preview URL is derived only from the path, so a metadata-only rewrite
  // (for example a corrected IFD0:Orientation tag) leaves the URL unchanged and
  // the raw pixels would otherwise stay stale. Applying commits the fresh
  // metadata into `fileMetadataOccurrences`, which replaces this path's ready
  // snapshot with a new array. We treat that "ready -> different ready"
  // replacement as the rewrite signal (as opposed to the initial
  // "loading -> ready" scan load, or a navigation to another file) and bump
  // `reloadNonce`, which is folded into the <img> key and cache-busting query
  // string below so the element remounts and fetches fresh bytes.
  const previousOccurrencesRef = useRef<{
    path: string | null;
    state: FileMetadataOccurrencesState;
  }>({
    path: file?.relative_path ?? null,
    state: occurrencesState,
  });
  useEffect(() => {
    const path = file?.relative_path ?? null;
    const previous = previousOccurrencesRef.current;
    previousOccurrencesRef.current = { path, state: occurrencesState };

    if (previous.path !== path) return; // navigation, not an in-place rewrite
    if (previous.state === occurrencesState) return;
    // Only a ready -> different-ready replacement means the file was rewritten.
    // Requiring both ends to be arrays skips the initial scan load and the
    // "loading" dip from a full snapshot rebuild, which would otherwise reload
    // an extra time after apply.
    if (Array.isArray(previous.state) && Array.isArray(occurrencesState)) {
      // Re-enter the loading state so the spinner shows instead of a stale
      // frame while the freshly-written pixels are re-fetched.
      setReadyPath(null);
      setFailedPath(null);
      setReloadNonce((nonce) => nonce + 1);
    }
  }, [occurrencesState, file]);

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
  const recycleCurrentFile = async () => {
    if (!file || !onRecycleFile || recyclePendingRef.current) return;
    recyclePendingRef.current = true;
    try {
      const editCount = Object.keys(targetDraftEdits ?? {}).length;
      const confirmed = await confirmRecycleFiles({
        fileCount: 1,
        singleFilename: file.filename,
        draftFileCount: editCount > 0 ? 1 : 0,
        editCount,
      });
      if (confirmed) await onRecycleFile(file.relative_path);
    } finally {
      recyclePendingRef.current = false;
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (!isGalleryShortcutEventSafe(e)) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onNavigate(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onNavigate(1);
    } else if (e.key === "i" || e.key === "I") {
      e.preventDefault();
      if (e.repeat) return;
      setDetailsVisible((v) => !v);
    } else if (e.key === "Delete" && onRecycleFile) {
      e.preventDefault();
      if (e.repeat || recyclePendingRef.current) return;
      void recycleCurrentFile();
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
                key={`${currentPath}:${reloadNonce}`}
                src={cacheBustedSrc(mediaSrc, reloadNonce)}
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
              metadataFailure={metadataFailure}
              targetDraftEdits={targetDraftEdits}
              targetDraftPersistence={targetDraftPersistence}
              onSetExistingOccurrenceDraft={(target, edit) =>
                onSetExistingOccurrenceDraft?.(file.relative_path, target, edit)
              }
              onRemoveMetadataTargets={(targets) =>
                onRemoveMetadataTargets?.(file.relative_path, targets) ?? false
              }
              onPreviewMetadataTargetRemovals={(targets) =>
                onPreviewMetadataTargetRemovals?.(
                  file.relative_path,
                  targets,
                ) ?? Promise.resolve(null)
              }
              onPreviewGpsTargetDraftBatch={(edits) =>
                onPreviewGpsTargetDraftBatch?.(file.relative_path, edits) ??
                Promise.resolve(null)
              }
              onApplyGpsTargetDraftBatch={(entries) =>
                onApplyGpsTargetDraftBatch?.(file.relative_path, entries) ??
                Promise.resolve(false)
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
