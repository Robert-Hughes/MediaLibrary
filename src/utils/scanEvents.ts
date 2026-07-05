/**
 * Pure helpers for the scan-event pipeline owned by `useMediaLibrary`.
 *
 * Kept free of React + Tauri so the hook stays a thin orchestrator and
 * these bits can be unit-tested without a render harness.
 */
import type { MetadataValue } from "../types";

export function normalizeMetadataFromTauri(
  raw: unknown,
): Record<string, MetadataValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: Record<string, MetadataValue> = {};
  let dropped = 0;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isMetadataValue(value)) {
      out[key] = value;
    } else {
      dropped += 1;
    }
  }

  if (dropped > 0) {
    console.warn(
      `[metadata] Dropped ${dropped} non-semantic metadata payload value(s)`,
    );
  }

  return out;
}

function isMetadataValue(value: unknown): value is MetadataValue {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "Null":
    case "Binary":
      return true;
    case "Text":
      return typeof value.value === "string";
    case "Bool":
      return typeof value.value === "boolean";
    case "Integer":
    case "Real":
      return typeof value.value === "number" && Number.isFinite(value.value);
    case "Rational":
      return (
        isRecord(value.value) &&
        typeof value.value.numerator === "number" &&
        Number.isInteger(value.value.numerator) &&
        typeof value.value.denominator === "number" &&
        Number.isInteger(value.value.denominator) &&
        value.value.denominator !== 0
      );
    case "Date":
      return isDateValue(value.value);
    case "Time":
      return isTimeValue(value.value);
    case "DateTime":
      return (
        isRecord(value.value) &&
        isDateValue(value.value.date) &&
        isTimeValue(value.value.time)
      );
    case "TimeOffset":
      return isUtcOffsetValue(value.value);
    case "LangAlt":
      return (
        isRecord(value.value) &&
        Object.values(value.value).every((v) => typeof v === "string")
      );
    case "List":
      return (
        isRecord(value.value) &&
        isListKind(value.value.list_kind) &&
        Array.isArray(value.value.items) &&
        value.value.items.every(isMetadataValue)
      );
    case "Struct":
      return (
        isRecord(value.value) &&
        Object.values(value.value).every(isMetadataValue)
      );
    case "Unknown":
      return (
        isRecord(value.value) &&
        "raw" in value.value &&
        (value.value.reason === null || typeof value.value.reason === "string")
      );
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDateValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.year === "number" &&
    Number.isInteger(value.year) &&
    typeof value.month === "number" &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    typeof value.day === "number" &&
    Number.isInteger(value.day) &&
    value.day >= 1 &&
    value.day <= 31
  );
}

function isTimeValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.hour === "number" &&
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    typeof value.minute === "number" &&
    Number.isInteger(value.minute) &&
    value.minute >= 0 &&
    value.minute <= 59 &&
    typeof value.second === "number" &&
    Number.isInteger(value.second) &&
    value.second >= 0 &&
    value.second <= 59 &&
    (value.subsecond === null || typeof value.subsecond === "string") &&
    (value.offset === null || isUtcOffsetValue(value.offset))
  );
}

function isUtcOffsetValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.sign === "Plus" || value.sign === "Minus") &&
    typeof value.hours === "number" &&
    Number.isInteger(value.hours) &&
    value.hours >= 0 &&
    value.hours <= 23 &&
    typeof value.minutes === "number" &&
    Number.isInteger(value.minutes) &&
    value.minutes >= 0 &&
    value.minutes <= 59
  );
}

function isListKind(value: unknown): boolean {
  return (
    value === "Bag" || value === "Seq" || value === "Alt" || value === "Unknown"
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
