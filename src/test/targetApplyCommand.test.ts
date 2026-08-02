// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  MetadataApplyFileResult,
  MetadataApplyResult,
  MetadataApplySummary,
} from "../types";
import { runTargetApplyCommand } from "../targetApplyCommand";
import type {
  TargetApplyChannel,
  TargetApplyTauriApi,
} from "../targetApplyTauri";

function fileResult(
  relativePath: string,
  overrides: Partial<MetadataApplyFileResult> = {},
): MetadataApplyFileResult {
  return {
    relative_path: relativePath,
    applied: true,
    error: null,
    warning: null,
    fresh_file_metadata: null,
    target_outcomes: [],
    persisted_draft_entries: [],
    ...overrides,
  };
}

function summary(
  completed: number,
  overrides: Partial<MetadataApplySummary> = {},
): MetadataApplySummary {
  return {
    requested: completed,
    selected: completed,
    completed,
    applied: completed,
    failed: 0,
    warning_count: 0,
    cancelled: false,
    aborted: false,
    abort_reason: null,
    delivery_failure_count: 0,
    ...overrides,
  };
}

function terminal(
  value: MetadataApplySummary,
  undeliveredFiles: MetadataApplyFileResult[] = [],
): MetadataApplyResult {
  return {
    summary: value,
    undelivered_files: undeliveredFiles,
    complete_delivery_failed: false,
  };
}

class FakeApplyApi implements TargetApplyTauriApi {
  onApply: (args: Record<string, unknown>) => Promise<unknown> = async () =>
    terminal(summary(0));

  createChannel(handler: (payload: unknown) => void): TargetApplyChannel {
    return { onmessage: handler };
  }

  invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (command !== "apply_metadata_draft_edits_cmd") {
      return Promise.reject(new Error(`Unexpected command ${command}`));
    }
    return this.onApply(args ?? {});
  }
}

function send(
  args: Record<string, unknown>,
  payload: Record<string, unknown>,
): void {
  (args.progressChannel as TargetApplyChannel).onmessage({
    operation_id: args.operationId,
    ...payload,
  });
}

describe("runTargetApplyCommand", () => {
  it("validates the ordered stream and presents streamed and fallback diagnostics once", async () => {
    const api = new FakeApplyApi();
    const streamed = fileResult("streamed.jpg", {
      applied: false,
      error: "write failed",
      warning: "partial refresh",
    });
    const fallback = fileResult("fallback.jpg", {
      warning: "fallback warning",
    });
    const done = summary(2, {
      applied: 1,
      failed: 1,
      warning_count: 2,
      delivery_failure_count: 1,
    });
    api.onApply = async (args) => {
      send(args, { kind: "started", total: 2 });
      send(args, {
        kind: "progress_batch",
        sequence: 1,
        current: 1,
        total: 2,
        results: [streamed],
      });
      send(args, { kind: "complete", summary: done });
      return terminal(done, [fallback]);
    };
    const onProtocolError = vi.fn();
    const onFileError = vi.fn();
    const onFileWarning = vi.fn();

    const result = await runTargetApplyCommand(api, 7, "folder", undefined, {
      onProtocolError,
      onFileError,
      onFileWarning,
    });

    expect(onProtocolError).not.toHaveBeenCalled();
    expect(onFileError).toHaveBeenCalledOnce();
    expect(onFileError).toHaveBeenCalledWith("streamed.jpg", "write failed");
    expect(onFileWarning).toHaveBeenCalledTimes(2);
    expect(onFileWarning).toHaveBeenNthCalledWith(
      1,
      "streamed.jpg",
      "partial refresh",
    );
    expect(onFileWarning).toHaveBeenNthCalledWith(
      2,
      "fallback.jpg",
      "fallback warning",
    );
    expect(result.undelivered_files).toEqual([]);
  });

  it("reports ordering and terminal-summary mismatches without owning UI state", async () => {
    const api = new FakeApplyApi();
    const commandSummary = summary(1);
    api.onApply = async (args) => {
      send(args, { kind: "started", total: 1 });
      send(args, {
        kind: "progress_batch",
        sequence: 2,
        current: 1,
        total: 1,
        results: [fileResult("a.jpg")],
      });
      send(args, { kind: "complete", summary: summary(0) });
      return terminal(commandSummary);
    };
    const onProtocolError = vi.fn();

    await runTargetApplyCommand(api, 7, "folder", ["a.jpg"], {
      onProtocolError,
    });

    expect(onProtocolError.mock.calls.map(([error]) => error.message)).toEqual([
      "Apply progress sequence is not contiguous",
      "Stream completion summary differs from command result",
      "Stream and undelivered counts do not cover completed files",
    ]);
  });
});
