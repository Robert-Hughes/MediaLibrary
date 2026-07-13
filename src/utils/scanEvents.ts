/**
 * Pure helpers for the scan-event pipeline owned by `useMediaLibrary`.
 *
 * Kept free of React + Tauri so the hook stays a thin orchestrator and
 * these bits can be unit-tested without a render harness.
 */
import type {
  MetadataEntry,
  MetadataOccurrence,
  MetadataOccurrences,
  TagInfo,
  TagKind,
} from "../types";
import {
  metadataCollection,
  type MetadataCollection,
} from "./metadataCollection";
import {
  compareMetadataOccurrenceIds,
  metadataOccurrenceIdToken,
} from "./metadataOccurrenceId";
import {
  isMetadataOccurrenceId,
  isMetadataValue,
  isMetadataWriteTarget,
  isRecord,
  isSchemaDefinitionId,
} from "./metadataWireGuards";

export function normalizeMetadataOccurrencesFromTauri(
  raw: unknown,
): MetadataOccurrences {
  if (!Array.isArray(raw)) return [];

  const occurrences: MetadataOccurrence[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const value of raw) {
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

function isMetadataOccurrence(value: unknown): value is MetadataOccurrence {
  return (
    isRecord(value) &&
    isMetadataOccurrenceId(value.id) &&
    isMetadataValue(value.value) &&
    (value.tag_info === null || isTagInfo(value.tag_info)) &&
    (value.write_target === null || isMetadataWriteTarget(value.write_target))
  );
}

function isTagInfo(value: unknown): value is TagInfo {
  return (
    isRecord(value) &&
    isSchemaDefinitionId(value.id) &&
    typeof value.group === "string" &&
    typeof value.name === "string" &&
    typeof value.writable === "boolean" &&
    isTagKind(value.kind) &&
    (value.description === null || typeof value.description === "string") &&
    (value.storage_count === undefined ||
      typeof value.storage_count === "string")
  );
}

function isTagKind(value: unknown): value is TagKind {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "Text":
    case "LangAlt":
    case "Real":
    case "Rational":
    case "Boolean":
    case "Date":
    case "Time":
    case "DateTime":
    case "TimeOffset":
    case "Binary":
    case "Unknown":
      return true;
    case "Integer":
      return (
        isRecord(value.data) &&
        (value.data.min === null ||
          (typeof value.data.min === "number" &&
            Number.isInteger(value.data.min))) &&
        (value.data.max === null ||
          (typeof value.data.max === "number" &&
            Number.isInteger(value.data.max)))
      );
    case "Enum":
      return (
        isRecord(value.data) &&
        (value.data.repr === "Integer" || value.data.repr === "String") &&
        Array.isArray(value.data.options) &&
        value.data.options.every(
          (option) =>
            isRecord(option) &&
            typeof option.code === "string" &&
            typeof option.label === "string",
        )
      );
    case "Bag":
    case "Seq":
    case "Alt":
      return isTagKind(value.data);
    case "Struct":
      return isRecord(value.data) && Object.values(value.data).every(isTagKind);
    default:
      return false;
  }
}

export function normalizeMetadataFromTauri(raw: unknown): MetadataCollection {
  if (!Array.isArray(raw)) return {};

  const out: MetadataEntry[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (isMetadataEntry(entry)) {
      out.push(entry);
    } else {
      dropped += 1;
    }
  }

  if (dropped > 0) {
    console.warn(
      `[metadata] Dropped ${dropped} non-semantic metadata payload value(s)`,
    );
  }

  return metadataCollection(out);
}

function isMetadataEntry(value: unknown): value is MetadataEntry {
  return (
    isRecord(value) &&
    isSchemaDefinitionId(value.id) &&
    isMetadataValue(value.value)
  );
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
 * Used by three near-identical handlers (photo_found, image_metadata_ready,
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
export const MAX_WORKER_ERRORS = 20;

export const RECENT_FOLDERS_KEY = "media_library_recent_folders";
export const MAX_RECENT_FOLDERS = 5;
