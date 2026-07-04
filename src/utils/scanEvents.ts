/**
 * Pure helpers for the scan-event pipeline owned by `useMediaLibrary`.
 *
 * Kept free of React + Tauri so the hook stays a thin orchestrator and
 * these bits can be unit-tested without a render harness.
 */
import type {
  DraftEdit,
  DraftEditsByFile,
  MetadataValue,
  Variant,
} from "../types";

/**
 * Convert whatever shape the Tauri boundary returned into the canonical
 * typed `DraftEditsByFile`.  Live backend returns typed; tests / older
 * builds may still return the legacy `string | null` shape.  Per-edit
 * detection handles mixed shapes gracefully.
 */
export function normalizeDraftsFromTauri(raw: unknown): DraftEditsByFile {
  if (!raw || typeof raw !== "object") return {};
  const out: DraftEditsByFile = {};
  for (const [file, fileEdits] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!fileEdits || typeof fileEdits !== "object") continue;
    const typed: Record<string, DraftEdit> = {};
    for (const [key, value] of Object.entries(
      fileEdits as Record<string, unknown>,
    )) {
      if (
        value &&
        typeof value === "object" &&
        "intent" in value &&
        "value" in value
      ) {
        typed[key] = value as DraftEdit;
      } else if (value === null) {
        typed[key] = { value: null, intent: "Delete" };
      } else if (typeof value === "string") {
        typed[key] = { value, intent: "Set" };
      } else {
        typed[key] = { value: value as DraftEdit["value"], intent: "Set" };
      }
    }
    out[file] = typed;
  }
  return out;
}

export function normalizeMetadataFromTauri(
  raw: unknown,
): Record<string, MetadataValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = isMetadataValue(value)
      ? (value as MetadataValue)
      : variantToMetadataValue(value as Variant);
  }
  return out;
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function variantToMetadataValue(value: Variant): MetadataValue {
  if (value === null) return { kind: "Null" };
  if (typeof value === "string") return { kind: "Text", value };
  if (typeof value === "boolean") return { kind: "Bool", value };
  if (typeof value === "number") return { kind: "Real", value };
  if (Array.isArray(value)) {
    return {
      kind: "List",
      value: {
        list_kind: "Unknown",
        items: value.map((item) => variantToMetadataValue(item as Variant)),
      },
    };
  }
  if (typeof value === "object") {
    return {
      kind: "Struct",
      value: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          variantToMetadataValue(child as Variant),
        ]),
      ),
    };
  }
  return {
    kind: "Unknown",
    value: {
      expected: null,
      raw: null,
      reason: "unsupported metadata payload value",
    },
  };
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
