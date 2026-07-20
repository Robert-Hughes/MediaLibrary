import { useEffect, useMemo, useReducer, useState } from "react";
import type {
  ImageMetadataOccurrencesStore,
  PhotoInfo,
  ThumbnailStore,
} from "../types";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import { isValidCoordinate } from "../utils/gpsUtils";
import { ModalDialog } from "./ModalDialog";
import { PhotoMap, type PhotoMapItem } from "./PhotoMap";

interface FullMapViewProps {
  relativePaths: string[];
  photos: PhotoInfo[];
  thumbnails: ThumbnailStore;
  imageMetadataOccurrences: ImageMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftEditsByFile;
  onClose: () => void;
}

export function FullMapView({
  relativePaths,
  photos,
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

  const selectedPhotos = useMemo(() => {
    const byPath = new Map(photos.map((photo) => [photo.relative_path, photo]));
    return relativePaths
      .map((path) => byPath.get(path))
      .filter((photo): photo is PhotoInfo => photo !== undefined);
  }, [photos, relativePaths]);

  const mapItems: PhotoMapItem[] = [];
  for (const photo of selectedPhotos) {
    const position = resolveEffectiveGpsForFile({
      occurrences: imageMetadataOccurrences.get(photo.relative_path),
      targetDrafts: targetDraftEdits[photo.relative_path],
    });
    if (
      position.lat === null ||
      position.lon === null ||
      !isValidCoordinate(position.lat, position.lon)
    ) {
      continue;
    }
    mapItems.push({
      relativePath: photo.relative_path,
      lat: position.lat,
      lon: position.lon,
      thumbnail: thumbnails.get(photo.relative_path),
    });
  }

  const missingCount = selectedPhotos.length - mapItems.length;

  return (
    <ModalDialog
      open
      onDismiss={onClose}
      className="full-map-dialog"
      testId="full-map-overlay"
      aria-label="Photo map"
    >
      <div className="full-map-content">
        <header className="full-map-header">
          <div>
            <h2 className="full-map-title">Photo map</h2>
            <div className="full-map-summary" data-testid="full-map-summary">
              {mapItems.length} of {selectedPhotos.length} photos mapped
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
              aria-label="Close photo map"
              autoFocus
            >
              ✕
            </button>
          </div>
        </header>

        <div className="full-map-canvas">
          <PhotoMap items={mapItems} fitRequest={fitRequest} />
          {mapItems.length === 0 && (
            <div className="full-map-empty" data-testid="full-map-empty">
              None of the selected photos currently has a GPS location.
            </div>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
