/**
 * Unit tests for the pure helpers behind the scan-event pipeline.
 *
 * `scheduleBatchedFlush` decides per call whether to flush a buffered
 * event stream immediately or defer for coalescing — the same shape is
 * shared by the photo / metadata / thumbnail buffers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleBatchedFlush } from "../utils/scanEvents";

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
