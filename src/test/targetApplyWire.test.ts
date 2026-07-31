// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MetadataApplyFileResult } from "../types";
import {
  targetApplyResultFromUnknown,
  targetApplyStreamMessageFromUnknown,
  targetApplySummaryFromUnknown,
} from "../utils/targetApplyWire";

function fileResult(relativePath = "file.jpg"): MetadataApplyFileResult {
  return {
    relative_path: relativePath,
    applied: true,
    error: null,
    warning: null,
    fresh_file_metadata: {
      relative_path: relativePath,
      occurrences: [],
    },
    target_outcomes: [],
    persisted_draft_entries: [],
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    requested: 1,
    selected: 1,
    completed: 1,
    applied: 1,
    failed: 0,
    warning_count: 0,
    cancelled: false,
    aborted: false,
    abort_reason: null,
    delivery_failure_count: 0,
    ...overrides,
  };
}

describe("target-aware apply compact wire", () => {
  it("parses compact summaries and enforces count invariants", () => {
    expect(targetApplySummaryFromUnknown(summary())).toEqual(summary());
    expect(() =>
      targetApplySummaryFromUnknown(summary({ applied: 0 })),
    ).toThrow(/applied plus failed/i);
    expect(() =>
      targetApplySummaryFromUnknown(
        summary({ cancelled: true, aborted: true }),
      ),
    ).toThrow(/cannot both/i);
  });

  it("parses compact terminal results without a complete file collection", () => {
    expect(
      targetApplyResultFromUnknown({
        summary: summary(),
        undelivered_files: [],
        complete_delivery_failed: false,
      }),
    ).toEqual({
      summary: summary(),
      undelivered_files: [],
      complete_delivery_failed: false,
    });
    expect(() =>
      targetApplyResultFromUnknown({
        summary: summary({ delivery_failure_count: 1 }),
        undelivered_files: [],
        complete_delivery_failed: false,
      }),
    ).toThrow(/length must equal/i);
  });

  it("parses one bounded progress batch", () => {
    const result = fileResult();
    expect(
      targetApplyStreamMessageFromUnknown(
        {
          kind: "progress_batch",
          operation_id: "current",
          sequence: 1,
          current: 1,
          total: 1,
          results: [result],
        },
        "current",
      ),
    ).toEqual({
      kind: "progress_batch",
      operation_id: "current",
      sequence: 1,
      current: 1,
      total: 1,
      results: [result],
    });
  });

  it("rejects stale operations before inspecting heavyweight results", () => {
    expect(
      targetApplyStreamMessageFromUnknown(
        {
          kind: "progress_batch",
          operation_id: "old",
          sequence: "malformed",
          current: 0,
          total: 0,
          results: [{ deeply: "invalid" }],
        },
        "current",
      ),
    ).toBeNull();
  });

  it("rejects malformed current-operation progress atomically", () => {
    expect(() =>
      targetApplyStreamMessageFromUnknown(
        {
          kind: "progress_batch",
          operation_id: "current",
          sequence: 1,
          current: 1,
          total: 1,
          results: [{ ...fileResult(), fresh_file_metadata: { bad: true } }],
        },
        "current",
      ),
    ).toThrow(/fresh_file_metadata/i);
  });
});
