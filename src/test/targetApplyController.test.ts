// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  type MetadataApplyFileResult,
  type MetadataApplyResult,
  type MetadataApplySummary,
} from "../types";
import {
  TargetApplyController,
  TargetApplyControllerBusyError,
  type TargetApplyControllerCallbacks,
} from "../targetApplyController";
import type {
  TargetApplyChannel,
  TargetApplyTauriApi,
} from "../targetApplyTauri";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fileResult(
  relativePath: string,
  overrides: Partial<MetadataApplyFileResult> = {},
): MetadataApplyFileResult {
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
    ...overrides,
  };
}

function heavyFileResult(relativePath: string): MetadataApplyFileResult {
  return fileResult(relativePath, {
    fresh_file_metadata: {
      relative_path: relativePath,
      occurrences: [
        {
          id: {
            document: null,
            path: `JPEG-APP1-${relativePath}`,
            runtime_tag_id: "282",
            tag_id_scope: {
              table: "TestFixture::Runtime",
              tag_id: "282",
              index: null,
            },
            copy: 0,
          },
          schema_id: { table: "Exif::Main", tag_id: "282" },
          value: { kind: "Text", value: "x".repeat(2_048) },
          tag_info: null,
          observed_selector: null,
          write_target: null,
        },
      ],
    },
    persisted_draft_entries: null,
  });
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
  completeDeliveryFailed = false,
): MetadataApplyResult {
  return {
    summary: value,
    undelivered_files: undeliveredFiles,
    complete_delivery_failed: completeDeliveryFailed,
  };
}

class FakeApplyApi implements TargetApplyTauriApi {
  readonly channels: TargetApplyChannel[] = [];
  readonly calls: Array<{
    command: string;
    args?: Record<string, unknown>;
  }> = [];
  onApply: (args: Record<string, unknown>) => Promise<unknown> = async () =>
    terminal(summary(0));
  onCancel: () => Promise<unknown> = async () => undefined;

  createChannel(handler: (payload: unknown) => void): TargetApplyChannel {
    const channel = { onmessage: handler };
    this.channels.push(channel);
    return channel;
  }

  async invoke(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ command, args });
    if (command === "cancel_apply_edits") return this.onCancel();
    return this.onApply(args ?? {});
  }
}

function harness(
  paths: readonly string[],
  callbacks: TargetApplyControllerCallbacks = {},
) {
  const api = new FakeApplyApi();
  void paths;
  const controller = new TargetApplyController({ api }, callbacks);
  return { api, controller };
}
function sendStarted(args: Record<string, unknown>, total: number): void {
  (args.progressChannel as TargetApplyChannel).onmessage({
    kind: "started",
    operation_id: args.operationId,
    total,
  });
}

function sendBatch(
  args: Record<string, unknown>,
  sequence: number,
  current: number,
  total: number,
  results: MetadataApplyFileResult[],
): void {
  (args.progressChannel as TargetApplyChannel).onmessage({
    kind: "progress_batch",
    operation_id: args.operationId,
    sequence,
    current,
    total,
    results,
  });
}

function sendComplete(
  args: Record<string, unknown>,
  value: MetadataApplySummary,
): void {
  (args.progressChannel as TargetApplyChannel).onmessage({
    kind: "complete",
    operation_id: args.operationId,
    summary: value,
  });
}

describe("TargetApplyController streamed ownership", () => {
  it("keeps returned controller state compact across thousands of heavyweight results", async () => {
    const count = 3_000;
    const paths = Array.from(
      { length: count },
      (_, index) => `file-${index}.jpg`,
    );
    const { api, controller } = harness(paths);
    const done = summary(count);
    api.onApply = async (args) => {
      sendStarted(args, count);
      for (
        let offset = 0, sequence = 1;
        offset < count;
        offset += 100, sequence += 1
      ) {
        const results = paths.slice(offset, offset + 100).map(heavyFileResult);
        sendBatch(args, sequence, offset + results.length, count, results);
      }
      sendComplete(args, done);
      return terminal(done);
    };

    const result = await controller.run("folder", paths);

    expect(result.application.processed).toBe(count);
    expect(result.protocolErrors).toEqual([]);
    expect(result.progressApplicationErrors).toEqual([]);
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
  });

  it("uses compact terminal fallback only for an undelivered file", async () => {
    const paths = ["fallback.jpg"];
    const { api, controller } = harness(paths);
    const fallback = fileResult("fallback.jpg");
    const done = summary(1, { delivery_failure_count: 1 });
    api.onApply = async (args) => {
      sendStarted(args, 1);
      sendComplete(args, done);
      return terminal(done, [fallback]);
    };

    const result = await controller.run("folder", paths);

    expect(result.application.processed).toBe(1);
  });

  it("reports compact cancelled completion without marking unprocessed files complete", async () => {
    const paths = ["done.jpg", "unprocessed.jpg"];
    const { api, controller } = harness(paths);
    const command = deferred<MetadataApplyResult>();
    let applyArgs: Record<string, unknown> | null = null;
    api.onApply = async (args) => {
      applyArgs = args;
      sendStarted(args, 2);
      sendBatch(args, 1, 1, 2, [fileResult("done.jpg")]);
      return command.promise;
    };
    api.onCancel = async () => {
      const done = summary(1, {
        requested: 2,
        selected: 2,
        cancelled: true,
      });
      sendComplete(applyArgs!, done);
      command.resolve(terminal(done));
    };

    const run = controller.run("folder", paths);
    await vi.waitFor(() =>
      expect(controller.getState()).toMatchObject({ current: 1, total: 2 }),
    );
    await controller.cancel();
    const result = await run;

    expect(result.commandResult.summary).toMatchObject({
      completed: 1,
      selected: 2,
      cancelled: true,
    });
    expect(result.application.processed).toBe(1);
  });

  it("preserves compact aborted counts and file diagnostics", async () => {
    const onFileError = vi.fn();
    const paths = ["failed.jpg", "later.jpg"];
    const { api, controller } = harness(paths, { onFileError });
    const failed = fileResult("failed.jpg", {
      applied: false,
      error: "persistence failed",
      fresh_file_metadata: null,
      persisted_draft_entries: null,
    });
    const done = summary(1, {
      requested: 2,
      selected: 2,
      applied: 0,
      failed: 1,
      aborted: true,
      abort_reason: "persistence failed",
    });
    api.onApply = async (args) => {
      sendStarted(args, 2);
      sendBatch(args, 1, 1, 2, [failed]);
      sendComplete(args, done);
      return terminal(done);
    };

    const result = await controller.run("folder", paths);

    expect(result.commandResult.summary).toMatchObject({
      completed: 1,
      failed: 1,
      aborted: true,
    });
    expect(onFileError).toHaveBeenCalledWith(
      "failed.jpg",
      "persistence failed",
    );
  });

  it("releases old channel state and rejects stale events from a prior Apply", async () => {
    const paths = ["file.jpg"];
    const { api, controller } = harness(paths);
    const firstDone = summary(0);
    api.onApply = async (args) => {
      sendStarted(args, 0);
      sendComplete(args, firstDone);
      return terminal(firstDone);
    };
    await controller.run("folder", []);
    const oldChannel = api.channels[0];

    const secondCommand = deferred<MetadataApplyResult>();
    let secondArgs: Record<string, unknown> | null = null;
    api.onApply = async (args) => {
      secondArgs = args;
      sendStarted(args, 0);
      return secondCommand.promise;
    };
    const secondRun = controller.run("folder", []);
    await vi.waitFor(() => expect(secondArgs).not.toBeNull());
    oldChannel.onmessage({
      kind: "progress_batch",
      operation_id: "old",
      sequence: 1,
      current: 1,
      total: 1,
      results: [heavyFileResult("file.jpg")],
    });
    (secondArgs!.progressChannel as TargetApplyChannel).onmessage({
      kind: "progress_batch",
      operation_id: "old-operation",
      sequence: "bad",
      results: [{ malformed: true }],
    });
    const secondDone = summary(0);
    sendComplete(secondArgs!, secondDone);
    secondCommand.resolve(terminal(secondDone));
    const result = await secondRun;

    expect(result.protocolErrors).toEqual([]);
  });

  it("contains callback failures and still releases lifecycle ownership", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const paths = ["file.jpg"];
    const { api, controller } = harness(paths, {
      onProgressBatch: () => {
        throw new Error("listener failed");
      },
    });
    const done = summary(1);
    api.onApply = async (args) => {
      sendStarted(args, 1);
      sendBatch(args, 1, 1, 1, [fileResult("file.jpg")]);
      sendComplete(args, done);
      return terminal(done);
    };

    await expect(controller.run("folder", paths)).resolves.toBeDefined();
    expect(controller.getState()).toEqual({ status: "idle" });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("onProgressBatch"),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
  it("rejects overlapping runs before a second command", async () => {
    const { api, controller } = harness([]);
    const command = deferred<MetadataApplyResult>();
    api.onApply = async (args) => {
      sendStarted(args, 0);
      return command.promise;
    };
    const first = controller.run("folder", []);
    await vi.waitFor(() =>
      expect(controller.getState().status).toBe("running"),
    );

    await expect(controller.run("folder", [])).rejects.toBeInstanceOf(
      TargetApplyControllerBusyError,
    );
    expect(
      api.calls.filter(
        ({ command }) => command === "apply_metadata_draft_edits_cmd",
      ),
    ).toHaveLength(1);
    const done = summary(0);
    sendComplete(api.calls[0].args!, done);
    command.resolve(terminal(done));
    await first;
  });
});
