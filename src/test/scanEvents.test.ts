// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleBatchedFlush } from "../utils/scanEvents";

describe("scheduleBatchedFlush", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const makeTimerRef = () => ({
    current: null as ReturnType<typeof setTimeout> | null,
  });

  it("flushes immediately on the first call", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: true };
    scheduleBatchedFlush(1, timer, first, flush, 100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(first.current).toBe(false);
    expect(timer.current).toBeNull();
  });

  it("flushes immediately at the count threshold", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const timer = makeTimerRef();
    scheduleBatchedFlush(50, timer, { current: false }, flush, 100, 50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
  });

  it("debounces small later batches without stacking timers", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    scheduleBatchedFlush(3, timer, first, flush, 100);
    scheduleBatchedFlush(5, timer, first, flush, 100);
    scheduleBatchedFlush(7, timer, first, flush, 100);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
  });

  it("clears a pending timer when the count threshold fires", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    scheduleBatchedFlush(3, timer, first, flush, 100);
    scheduleBatchedFlush(50, timer, first, flush, 100, 50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
