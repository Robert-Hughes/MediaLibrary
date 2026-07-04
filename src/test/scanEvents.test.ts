/**
 * Unit tests for the pure helpers behind the scan-event pipeline.
 *
 * `normalizeDraftsFromTauri` is the boundary between the Tauri-shaped
 * raw payload (which may still carry the legacy `string | null` shape
 * during gradual migration) and the typed in-memory store.
 *
 * `scheduleBatchedFlush` decides per call whether to flush a buffered
 * event stream immediately or defer for coalescing — the same shape is
 * shared by the photo / metadata / thumbnail buffers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeDraftsFromTauri,
  scheduleBatchedFlush,
} from "../utils/scanEvents";

describe("normalizeDraftsFromTauri", () => {
  it("returns empty object for non-object input", () => {
    expect(normalizeDraftsFromTauri(null)).toEqual({});
    expect(normalizeDraftsFromTauri(undefined)).toEqual({});
    expect(normalizeDraftsFromTauri("string")).toEqual({});
    expect(normalizeDraftsFromTauri(42)).toEqual({});
  });

  it("passes through already-typed edits unchanged", () => {
    const input = {
      "a.jpg": { "XMP-dc:Title": { value: "hi", intent: "Set" } },
    };
    expect(normalizeDraftsFromTauri(input)).toEqual({
      "a.jpg": { "XMP-dc:Title": { value: "hi", intent: "Set" } },
    });
  });

  it("converts null legacy values to Delete intent", () => {
    expect(
      normalizeDraftsFromTauri({
        "a.jpg": { "XMP-dc:Title": null },
      }),
    ).toEqual({
      "a.jpg": { "XMP-dc:Title": { value: null, intent: "Delete" } },
    });
  });

  it("converts string legacy values to Set intent", () => {
    expect(
      normalizeDraftsFromTauri({
        "a.jpg": { "XMP-dc:Title": "Beach" },
      }),
    ).toEqual({
      "a.jpg": { "XMP-dc:Title": { value: "Beach", intent: "Set" } },
    });
  });

  it("handles mixed-shape input per-edit", () => {
    const result = normalizeDraftsFromTauri({
      "a.jpg": {
        already_typed: { value: "x", intent: "Set" },
        legacy_string: "y",
        legacy_null: null,
      },
    });
    expect(result["a.jpg"]).toEqual({
      already_typed: { value: "x", intent: "Set" },
      legacy_string: { value: "y", intent: "Set" },
      legacy_null: { value: null, intent: "Delete" },
    });
  });

  it("skips files whose value is not an object", () => {
    expect(
      normalizeDraftsFromTauri({
        "good.jpg": { tag: "v" },
        "bad.jpg": null,
        "other.jpg": "scalar",
      }),
    ).toEqual({
      "good.jpg": { tag: { value: "v", intent: "Set" } },
    });
  });
});

describe("scheduleBatchedFlush", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const makeTimerRef = () => ({
    current: null as ReturnType<typeof setTimeout> | null,
  });

  it("flushes immediately on the first call (isFirstFlushRef=true)", () => {
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: true };
    scheduleBatchedFlush(1, timer, first, flush, 100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(first.current).toBe(false);
    expect(timer.current).toBeNull();
  });

  it("flushes immediately when buffer reaches flushAtCount", () => {
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    scheduleBatchedFlush(50, timer, first, flush, 100, 50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
  });

  it("defers a small post-first flush via setTimeout", () => {
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    scheduleBatchedFlush(3, timer, first, flush, 100);
    expect(flush).not.toHaveBeenCalled();
    expect(timer.current).not.toBeNull();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
  });

  it("does not stack timers when called repeatedly during the debounce window", () => {
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    scheduleBatchedFlush(3, timer, first, flush, 100);
    scheduleBatchedFlush(5, timer, first, flush, 100);
    scheduleBatchedFlush(7, timer, first, flush, 100);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("clears a pending timer when the count-threshold path fires", () => {
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    // Pending deferred flush.
    scheduleBatchedFlush(3, timer, first, flush, 100);
    expect(timer.current).not.toBeNull();
    // Crossing the threshold flushes now and clears the timer.
    scheduleBatchedFlush(50, timer, first, flush, 100, 50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
    // The deferred fire-time should NOT trigger a second flush.
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
