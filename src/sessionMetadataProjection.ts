import type {
  FileMetadataOccurrencesStore,
  MediaLibrarySessionFileMetadata,
  MetadataProgressStore,
} from "./types";
import { normalizeMetadataOccurrences } from "./utils/scanEvents";

export interface SessionMetadataProjectionStores {
  occurrences: FileMetadataOccurrencesStore;
  progress: MetadataProgressStore;
}

export function projectSessionMetadata(
  entries: readonly MediaLibrarySessionFileMetadata[],
  reset: boolean,
  stores: SessionMetadataProjectionStores,
): number {
  if (reset) {
    stores.occurrences.clear();
    stores.progress.reset();
  }

  let newlyCompleted = 0;
  let acceptedReady = 0;
  for (const entry of entries) {
    const previous = stores.occurrences.has(entry.relative_path)
      ? stores.occurrences.get(entry.relative_path)
      : undefined;
    stores.occurrences.add(entry.relative_path);
    if (entry.state.status === "loading") continue;

    if (entry.state.status === "ready") {
      stores.occurrences.set(
        entry.relative_path,
        normalizeMetadataOccurrences(entry.state.occurrences),
      );
      acceptedReady += 1;
    } else {
      stores.occurrences.setFailed(entry.relative_path, entry.state.error);
    }
    if (previous === undefined || previous === "loading") newlyCompleted += 1;
  }
  if (newlyCompleted > 0) stores.progress.incrementReceived(newlyCompleted);
  return acceptedReady;
}
