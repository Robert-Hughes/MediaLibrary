import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  FileMetadataOccurrencesStore,
  FileInfo,
  ThumbnailStore,
} from "../types";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import { isValidCoordinate } from "../utils/gpsUtils";
import { ModalDialog } from "./ModalDialog";
import { FileMap, type FileMapItem } from "./FileMap";

interface FullMapViewProps {
  relativePaths: string[];
  files: FileInfo[];
  thumbnails: ThumbnailStore;
  fileMetadataOccurrences: FileMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftEditsByFile;
  onClose: () => void;
}

export function FullMapView({
  relativePaths,
  files,
  thumbnails,
  fileMetadataOccurrences,
  targetDraftEdits,
  onClose,
}: FullMapViewProps) {
  const [, refreshStores] = useReducer((value: number) => value + 1, 0);
  const [fitRequest, setFitRequest] = useState(0);
  const [thumbnailSize, setThumbnailSize] = useState(48);
  const thumbnailSaveTimerRef = useRef<number | null>(null);
  const pendingThumbnailSizeRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke<{ map_thumbnail_size: number }>("load_settings_cmd")
      .then((settings) => {
        if (!cancelled) setThumbnailSize(settings.map_thumbnail_size);
      })
      .catch((error) =>
        console.error("Failed to load map thumbnail size", error),
      );

    return () => {
      cancelled = true;
      if (thumbnailSaveTimerRef.current !== null) {
        window.clearTimeout(thumbnailSaveTimerRef.current);
      }
      const pendingSize = pendingThumbnailSizeRef.current;
      if (pendingSize !== null) {
        void invoke("save_map_thumbnail_size_cmd", {
          thumbnailSize: pendingSize,
        }).catch((error) =>
          console.error("Failed to save map thumbnail size", error),
        );
      }
    };
  }, []);

  const updateThumbnailSize = (size: number) => {
    setThumbnailSize(size);
    pendingThumbnailSizeRef.current = size;
    if (thumbnailSaveTimerRef.current !== null) {
      window.clearTimeout(thumbnailSaveTimerRef.current);
    }
    thumbnailSaveTimerRef.current = window.setTimeout(() => {
      thumbnailSaveTimerRef.current = null;
      pendingThumbnailSizeRef.current = null;
      void invoke("save_map_thumbnail_size_cmd", { thumbnailSize: size }).catch(
        (error) => console.error("Failed to save map thumbnail size", error),
      );
    }, 250);
  };

  useEffect(() => {
    const unsubscribers = relativePaths.flatMap((path) => [
      thumbnails.subscribe(path, refreshStores),
      fileMetadataOccurrences.subscribe(path, refreshStores),
    ]);
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [fileMetadataOccurrences, relativePaths, thumbnails]);

  const selectedFiles = useMemo(() => {
    const byPath = new Map(files.map((file) => [file.relative_path, file]));
    return relativePaths
      .map((path) => byPath.get(path))
      .filter((file): file is FileInfo => file !== undefined);
  }, [files, relativePaths]);

  const mapItems: FileMapItem[] = [];
  for (const file of selectedFiles) {
    const position = resolveEffectiveGpsForFile({
      occurrences: fileMetadataOccurrences.get(file.relative_path),
      targetDrafts: targetDraftEdits[file.relative_path],
    });
    if (
      position.lat === null ||
      position.lon === null ||
      !isValidCoordinate(position.lat, position.lon)
    ) {
      continue;
    }
    mapItems.push({
      relativePath: file.relative_path,
      lat: position.lat,
      lon: position.lon,
      thumbnail: thumbnails.get(file.relative_path),
    });
  }

  const missingCount = selectedFiles.length - mapItems.length;

  return (
    <ModalDialog
      open
      onDismiss={onClose}
      className="full-map-dialog"
      testId="full-map-overlay"
      aria-label="File map"
    >
      <div className="full-map-content">
        <header className="full-map-header">
          <div>
            <h2 className="full-map-title">File map</h2>
            <div className="full-map-summary" data-testid="full-map-summary">
              {mapItems.length} of {selectedFiles.length} files mapped
              {missingCount > 0
                ? ` · ${missingCount} without GPS or still loading`
                : ""}
            </div>
          </div>
          <div className="full-map-actions">
            <label className="full-map-thumbnail-size">
              <span>Thumbnail size</span>
              <input
                type="range"
                aria-label="Thumbnail size"
                min="16"
                max="512"
                step="8"
                value={thumbnailSize}
                onChange={(event) =>
                  updateThumbnailSize(Number(event.target.value))
                }
              />
              <output>{thumbnailSize} px</output>
            </label>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setFitRequest((value) => value + 1)}
              disabled={mapItems.length === 0}
            >
              Fit all
            </button>
            <button
              type="button"
              className="full-map-close"
              data-testid="full-map-close-btn"
              onClick={onClose}
              aria-label="Close file map"
              autoFocus
              data-modal-initial-focus="true"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="full-map-canvas">
          <FileMap
            items={mapItems}
            fitRequest={fitRequest}
            thumbnailSize={thumbnailSize}
          />
          {mapItems.length === 0 && (
            <div className="full-map-empty" data-testid="full-map-empty">
              None of the selected files currently has a GPS location.
            </div>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
