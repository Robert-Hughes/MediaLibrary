import { describe, expect, it } from "vitest";
import {
  emptyMetadataApplyResult,
  projectApplyOperation,
} from "../applyProjection";
import type { MediaLibraryApplyOperation } from "../types";

function operation(
  overrides: Partial<MediaLibraryApplyOperation> = {},
): MediaLibraryApplyOperation {
  return {
    operation_id: "apply-1",
    requested_paths: ["a.jpg"],
    state: { status: "running" },
    total: 2,
    current: 1,
    current_file: "a.jpg",
    cancelling: false,
    file_failure_count: 1,
    warning_count: 0,
    summary: null,
    ...overrides,
  };
}

describe("apply projection", () => {
  it("projects active Rust apply state for the UI", () => {
    expect(projectApplyOperation(operation())).toEqual({
      applying: {
        total: 2,
        current: 1,
        currentFile: "a.jpg",
        failureCount: 1,
        cancelling: false,
      },
      completion: null,
    });
  });

  it("projects completed Rust apply summaries and ignores failed operations", () => {
    const summary = emptyMetadataApplyResult().summary;
    expect(
      projectApplyOperation(
        operation({ state: { status: "completed" }, summary }),
      ),
    ).toEqual({ applying: null, completion: { summary, issues: [] } });
    expect(
      projectApplyOperation(
        operation({ state: { status: "failed", error: "failed" } }),
      ),
    ).toEqual({ applying: null, completion: null });
  });

  it("creates a fresh empty result", () => {
    const first = emptyMetadataApplyResult();
    const second = emptyMetadataApplyResult();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.summary.completed).toBe(0);
  });
});
