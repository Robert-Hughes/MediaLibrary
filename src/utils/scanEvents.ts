/**
 * Pure helpers for the scan-event pipeline owned by `useMediaLibrary`.
 *
 * Kept free of React + Tauri so the hook stays a thin orchestrator and
 * these bits can be unit-tested without a render harness.
 */
import type { MetadataOccurrence, MetadataOccurrences } from "../types";
import {
  compareMetadataOccurrenceIds,
  metadataOccurrenceIdToken,
} from "./metadataOccurrenceId";
import {
  isMetadataOccurrence,
  metadataOccurrenceSchemaIdentityError,
} from "./metadataWireGuards";

export function normalizeMetadataOccurrencesFromTauri(
  raw: unknown,
): MetadataOccurrences {
  if (!Array.isArray(raw)) return [];

  const occurrences: MetadataOccurrence[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const value of raw) {
    const schemaIdentityError = metadataOccurrenceSchemaIdentityError(value);
    if (schemaIdentityError !== null) {
      console.error(
        `[metadata] Rejected occurrence payload: ${schemaIdentityError}`,
      );
      return [];
    }
    if (!isMetadataOccurrence(value)) {
      dropped += 1;
      continue;
    }
    const token = metadataOccurrenceIdToken(value.id);
    if (seen.has(token)) {
      dropped += 1;
      continue;
    }
    seen.add(token);
    occurrences.push(value);
  }

  if (dropped > 0) {
    console.warn(`[metadata] Dropped ${dropped} invalid occurrence value(s)`);
  }
  occurrences.sort((a, b) => compareMetadataOccurrenceIds(a.id, b.id));
  return occurrences;
}

/**
 * Decide whether to flush the buffer now or schedule a deferred flush.
 *
 * The first flush of a stream goes immediately (so the UI shows results as
 * soon as the first event lands), and any flush where the buffer has
 * accumulated `flushAtCount` items also goes immediately (to keep memory
 * bounded under heavy load).  Otherwise we defer for `debounceMs` so a
 * burst of small events coalesces into one React update.
 *
 * Used by three near-identical handlers (file_found, image_metadata_ready,
 * thumbnail_ready); extracted so they share the same coalescing semantics.
 */
export function scheduleBatchedFlush(
  bufferLength: number,
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  isFirstFlushRef: { current: boolean },
  flush: () => void,
  debounceMs: number,
  flushAtCount = 50,
) {
  const shouldFlushNow =
    isFirstFlushRef.current || bufferLength >= flushAtCount;
  if (shouldFlushNow) {
    isFirstFlushRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    flush();
  } else if (!timerRef.current) {
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, debounceMs);
  }
}

/** Cap on retained worker errors. A misconfigured ExifTool or a bad folder
 *  can produce thousands of failures; without a cap the array grows unbounded
 *  and bloats React state.  Most-recent-N is what the user can act on. */
export const MAX_APPLICATION_ERRORS = 20;

export const RECENT_FOLDERS_KEY = "media_library_recent_folders";
export const MAX_RECENT_FOLDERS = 5;
