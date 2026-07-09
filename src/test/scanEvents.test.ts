// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeMetadataFromTauri,
  scheduleBatchedFlush,
} from "../utils/scanEvents";

import type { MetadataValue } from "../types";

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

  it("keeps all representative valid MetadataValue variants unchanged (table-driven)", () => {
    const variants: Record<string, MetadataValue> = {
      Null: { kind: "Null" },
      Text: { kind: "Text", value: "Canon" },
      Bool: { kind: "Bool", value: true },
      Integer: { kind: "Integer", value: 42 },
      Real: { kind: "Real", value: 3.14 },
      Rational: { kind: "Rational", value: { numerator: 1, denominator: 250 } },
      Date: { kind: "Date", value: { year: 2007, month: 7, day: 23 } },
      Time: {
        kind: "Time",
        value: {
          hour: 10,
          minute: 56,
          second: 5,
          subsecond: null,
          offset: { sign: "Plus", hours: 1, minutes: 0 },
        },
      },
      TimeOffsetless: {
        kind: "Time",
        value: {
          hour: 10,
          minute: 56,
          second: 5,
          subsecond: "123",
          offset: null,
        },
      },
      DateTime: {
        kind: "DateTime",
        value: {
          date: { year: 2007, month: 7, day: 23 },
          time: {
            hour: 10,
            minute: 56,
            second: 5,
            subsecond: null,
            offset: { sign: "Plus", hours: 1, minutes: 0 },
          },
        },
      },
      DateTimeOffsetless: {
        kind: "DateTime",
        value: {
          date: { year: 2007, month: 7, day: 23 },
          time: {
            hour: 10,
            minute: 56,
            second: 5,
            subsecond: null,
            offset: null,
          },
        },
      },
      TimeOffset: {
        kind: "TimeOffset",
        value: { sign: "Plus", hours: 1, minutes: 0 },
      },
      LangAlt: { kind: "LangAlt", value: { "x-default": "Hello" } },
      List: {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [{ kind: "Text", value: "landscape" }],
        },
      },
      Struct: {
        kind: "Struct",
        value: {
          nestedKey: { kind: "Text", value: "nestedValue" },
        },
      },
      Binary: { kind: "Binary" },
      Unknown: {
        kind: "Unknown",
        value: {
          expected: null,
          raw: "some raw value",
          reason: "unsupported format",
        },
      },
    };

    for (const [name, val] of Object.entries(variants)) {
      expect(
        normalizeMetadataFromTauri({
          [`tag:${name}`]: val,
        }),
        `variant ${name} should survive unchanged`,
      ).toEqual({
        [`tag:${name}`]: val,
      });
    }
  });

  it("keeps offset-bearing and offsetless date/time fields from real scan events", () => {
    const payload = {
      "ExifIFD:DateTimeOriginal": {
        kind: "DateTime",
        value: {
          date: { year: 2007, month: 7, day: 23 },
          time: {
            hour: 10,
            minute: 56,
            second: 5,
            subsecond: null,
            offset: null,
          },
        },
      },
      "ExifIFD:OffsetTimeOriginal": {
        kind: "TimeOffset",
        value: { sign: "Plus", hours: 1, minutes: 0 },
      },
      "IPTC:DateCreated": {
        kind: "Date",
        value: { year: 2007, month: 7, day: 23 },
      },
      "IPTC:TimeCreated": {
        kind: "Time",
        value: {
          hour: 10,
          minute: 56,
          second: 5,
          subsecond: null,
          offset: { sign: "Plus", hours: 1, minutes: 0 },
        },
      },
    };

    expect(normalizeMetadataFromTauri(payload)).toEqual(payload);
  });

  it("rejects invalid offset signs like Positive / Negative", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const invalidPayload = {
      "ExifIFD:OffsetTimeOriginal": {
        kind: "TimeOffset",
        value: { sign: "Positive", hours: 1, minutes: 0 },
      },
      "IPTC:TimeCreated": {
        kind: "Time",
        value: {
          hour: 10,
          minute: 56,
          second: 5,
          subsecond: null,
          offset: { sign: "Negative", hours: 1, minutes: 0 },
        },
      },
    };

    // The entire payload should map to {} because both keys are invalid and dropped.
    expect(normalizeMetadataFromTauri(invalidPayload)).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[metadata] Dropped 2 non-semantic metadata payload value(s)",
    );
  });

  it("rejects out-of-range dates, times, offsets and zero denominator rationals", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const invalidPayload = {
      invalidMonth: { kind: "Date", value: { year: 2026, month: 13, day: 5 } },
      invalidDay: { kind: "Date", value: { year: 2026, month: 12, day: 32 } },
      invalidHour: {
        kind: "Time",
        value: {
          hour: 24,
          minute: 0,
          second: 0,
          subsecond: null,
          offset: null,
        },
      },
      invalidMinute: {
        kind: "Time",
        value: {
          hour: 12,
          minute: 60,
          second: 0,
          subsecond: null,
          offset: null,
        },
      },
      invalidSecond: {
        kind: "Time",
        value: {
          hour: 12,
          minute: 0,
          second: 60,
          subsecond: null,
          offset: null,
        },
      },
      invalidOffsetHour: {
        kind: "TimeOffset",
        value: { sign: "Plus", hours: 24, minutes: 0 },
      },
      invalidOffsetMinute: {
        kind: "TimeOffset",
        value: { sign: "Plus", hours: 1, minutes: 60 },
      },
      zeroDenominator: {
        kind: "Rational",
        value: { numerator: 1, denominator: 0 },
      },
    };

    expect(normalizeMetadataFromTauri(invalidPayload)).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[metadata] Dropped 8 non-semantic metadata payload value(s)",
    );
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
