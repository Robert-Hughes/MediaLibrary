import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeMetadataFromTauri,
  scheduleBatchedFlush,
} from "../utils/scanEvents";

describe("normalizeMetadataFromTauri", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps semantic MetadataValue entries unchanged", () => {
    const text = { kind: "Text", value: "Canon" } as const;
    const list = {
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [{ kind: "Text", value: "landscape" }],
      },
    } as const;

    expect(
      normalizeMetadataFromTauri({
        "IFD0:Make": text,
        "XMP-dc:Subject": list,
      }),
    ).toEqual({
      "IFD0:Make": text,
      "XMP-dc:Subject": list,
    });
  });

  it("drops plain JSON values instead of converting them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      normalizeMetadataFromTauri({
        "IFD0:Make": "Canon",
        "ExifIFD:ISO": 100,
        "XMP-dc:Subject": ["landscape", "nature"],
        "XMP-custom:Object": { nested: "value" },
        "XMP-dc:Title": { kind: "Text", value: "Semantic" },
      }),
    ).toEqual({
      "XMP-dc:Title": { kind: "Text", value: "Semantic" },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[metadata] Dropped 4 non-semantic metadata payload value(s)",
    );
  });

  it("returns an empty object for malformed top-level payloads", () => {
    expect(normalizeMetadataFromTauri(undefined)).toEqual({});
    expect(normalizeMetadataFromTauri(null)).toEqual({});
    expect(normalizeMetadataFromTauri("metadata")).toEqual({});
    expect(normalizeMetadataFromTauri(["not", "a", "record"])).toEqual({});
  });
});

describe("scheduleBatchedFlush", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const makeTimerRef = () => ({
    current: null as ReturnType<typeof setTimeout> | null,
  });

  it("flushes immediately on the first call (isFirstFlushRef=true)", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: true };
    scheduleBatchedFlush(1, timer, first, flush, 100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(first.current).toBe(false);
    expect(timer.current).toBeNull();
  });

  it("flushes immediately when buffer reaches flushAtCount", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    scheduleBatchedFlush(50, timer, first, flush, 100, 50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
  });

  it("defers a small post-first flush via setTimeout", () => {
    vi.useFakeTimers();
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
  });

  it("clears a pending timer when the count-threshold path fires", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const timer = makeTimerRef();
    const first = { current: false };
    scheduleBatchedFlush(3, timer, first, flush, 100);
    expect(timer.current).not.toBeNull();
    scheduleBatchedFlush(50, timer, first, flush, 100, 50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
