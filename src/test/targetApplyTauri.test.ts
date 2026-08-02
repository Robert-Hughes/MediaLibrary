// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MetadataApplyFileResult, MetadataApplySummary } from "../types";
import {
  applyTargetDraftEdits,
  cancelTargetApply,
  type TargetApplyChannel,
  type TargetApplyTauriApi,
} from "../targetApplyTauri";

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

function summary(
  overrides: Partial<MetadataApplySummary> = {},
): MetadataApplySummary {
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

function terminal(overrides: Record<string, unknown> = {}) {
  return {
    summary: summary(),
    undelivered_files: [],
    complete_delivery_failed: false,
    ...overrides,
  };
}

function harness(
  invokeImpl?: (
    command: string,
    args: Record<string, unknown> | undefined,
  ) => Promise<unknown>,
) {
  let channel: TargetApplyChannel | null = null;
  const invoke = vi.fn(invokeImpl ?? (async () => terminal()));
  const api: TargetApplyTauriApi = {
    invoke,
    createChannel: (handler) => {
      channel = { onmessage: handler };
      return channel;
    },
  };
  return { api, invoke, getChannel: () => channel! };
}

describe("target-aware apply command channel", () => {
  it("sends copied explicit paths and consumes ordered stream messages", async () => {
    const onMessage = vi.fn();
    const h = harness(async (_command, args) => {
      const channel = args?.progressChannel as TargetApplyChannel;
      const operationId = args?.operationId as string;
      channel.onmessage({
        kind: "started",
        operation_id: operationId,
        total: 1,
      });
      channel.onmessage({
        kind: "progress_batch",
        operation_id: operationId,
        sequence: 1,
        current: 1,
        total: 1,
        results: [fileResult()],
      });
      channel.onmessage({
        kind: "complete",
        operation_id: operationId,
        summary: summary(),
      });
      return terminal();
    });
    const paths = ["file.jpg"];

    const result = await applyTargetDraftEdits(
      h.api,
      7,
      "folder",
      paths,
      "operation",
      { onMessage },
    );

    expect(result).toEqual(terminal());
    expect(h.invoke).toHaveBeenCalledWith(
      "apply_metadata_draft_edits_cmd",
      expect.objectContaining({
        sessionId: 7,
        folderPath: "folder",
        relPaths: ["file.jpg"],
        operationId: "operation",
        progressChannel: expect.any(Object),
      }),
    );
    expect(paths).toEqual(["file.jpg"]);
    expect(onMessage.mock.calls.map(([message]) => message.kind)).toEqual([
      "started",
      "progress_batch",
      "complete",
    ]);
  });

  it("uses null scope for Apply-all instead of serialising every path", async () => {
    const h = harness(async (_command, args) => {
      const channel = args?.progressChannel as TargetApplyChannel;
      channel.onmessage({
        kind: "complete",
        operation_id: args?.operationId,
        summary: summary({
          requested: 0,
          selected: 0,
          completed: 0,
          applied: 0,
        }),
      });
      return terminal({
        summary: summary({
          requested: 0,
          selected: 0,
          completed: 0,
          applied: 0,
        }),
      });
    });
    await applyTargetDraftEdits(h.api, 7, "folder", undefined, "all", {});
    expect(h.invoke.mock.calls[0]?.[1]?.relPaths).toBeNull();
  });

  it("rejects duplicate explicit paths before invoking", async () => {
    const h = harness();
    await expect(
      applyTargetDraftEdits(
        h.api,
        7,
        "folder",
        ["same.jpg", "same.jpg"],
        "duplicate",
        {},
      ),
    ).rejects.toThrow(/duplicate.*same\.jpg/i);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("ignores stale malformed messages before deep validation", async () => {
    const onProtocolError = vi.fn();
    const h = harness(async (_command, args) => {
      const channel = args?.progressChannel as TargetApplyChannel;
      channel.onmessage({
        kind: "progress_batch",
        operation_id: "old-operation",
        sequence: "bad",
        results: [{ massive: "invalid" }],
      });
      channel.onmessage({
        kind: "complete",
        operation_id: args?.operationId,
        summary: summary(),
      });
      return terminal();
    });
    await applyTargetDraftEdits(h.api, 7, "folder", ["file.jpg"], "current", {
      onProtocolError,
    });
    expect(onProtocolError).not.toHaveBeenCalled();
  });

  it("contains frontend message-handler failures without rejecting the command", async () => {
    const onMessageError = vi.fn();
    const failure = new Error("frontend listener failed");
    const h = harness(async (_command, args) => {
      const channel = args?.progressChannel as TargetApplyChannel;
      channel.onmessage({
        kind: "started",
        operation_id: args?.operationId,
        total: 1,
      });
      channel.onmessage({
        kind: "complete",
        operation_id: args?.operationId,
        summary: summary(),
      });
      return terminal();
    });
    await expect(
      applyTargetDraftEdits(h.api, 7, "folder", ["file.jpg"], "operation", {
        onMessage: () => {
          throw failure;
        },
        onMessageError,
      }),
    ).resolves.toEqual(terminal());
    expect(onMessageError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ kind: "started" }),
    );
  });

  it("releases the channel handler after terminal completion", async () => {
    const onMessage = vi.fn();
    const h = harness(async (_command, args) => {
      const channel = args?.progressChannel as TargetApplyChannel;
      channel.onmessage({
        kind: "complete",
        operation_id: args?.operationId,
        summary: summary(),
      });
      return terminal();
    });
    await applyTargetDraftEdits(h.api, 7, "folder", ["file.jpg"], "operation", {
      onMessage,
    });
    onMessage.mockClear();
    h.getChannel().onmessage({
      kind: "progress_batch",
      operation_id: "operation",
      sequence: 1,
      current: 1,
      total: 1,
      results: [fileResult()],
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("uses the exact cancellation command", async () => {
    const h = harness();
    await cancelTargetApply(h.api, 7, "operation");
    expect(h.invoke).toHaveBeenCalledWith("cancel_apply_edits", {
      sessionId: 7,
      operationId: "operation",
    });
  });
});
