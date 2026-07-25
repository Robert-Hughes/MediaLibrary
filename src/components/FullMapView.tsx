import { useEffect, useMemo, useReducer, useState } from "react";
import type {
  ImageMetadataOccurrencesStore,
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
  imageMetadataOccurrences: ImageMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftEditsByFile;
  onClose: () => void;
}

export function FullMapView({
  relativePaths,
  files,
  thumbnails,
  imageMetadataOccurrences,
  targetDraftEdits,
  onClose,
}: FullMapViewProps) {
  const [, refreshStores] = useReducer((value: number) => value + 1, 0);
  const [fitRequest, setFitRequest] = useState(0);

  useEffect(() => {
    const unsubscribers = relativePaths.flatMap((path) => [
      thumbnails.subscribe(path, refreshStores),
      imageMetadataOccurrences.subscribe(path, refreshStores),
    ]);
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [imageMetadataOccurrences, relativePaths, thumbnails]);

  const selectedFiles = useMemo(() => {
    const byPath = new Map(files.map((file) => [file.relative_path, file]));
    return relativePaths
      .map((path) => byPath.get(path))
      .filter((file): file is FileInfo => file !== undefined);
  }, [files, relativePaths]);

  const mapItems: FileMapItem[] = [];
  for (const file of selectedFiles) {
    const position = resolveEffectiveGpsForFile({
      occurrences: imageMetadataOccurrences.get(file.relative_path),
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
            >
              ✕
            </button>
          </div>
        </header>

        <div className="full-map-canvas">
          <FileMap items={mapItems} fitRequest={fitRequest} />
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
