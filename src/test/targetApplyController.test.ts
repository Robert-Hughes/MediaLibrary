// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ImageMetadataOccurrencesStore,
  type MetadataApplyEditsResultV5,
  type MetadataApplyFileResultV5,
  type MetadataDraftEntryV5,
  type MetadataTargetOutcome,
} from "../types";
import {
  TargetApplyControllerBusyError,
  TargetApplyControllerV5,
  type TargetApplyControllerCallbacksV5,
} from "../targetApplyController";
import type { TargetApplyResultStores } from "../targetApplyResults";
import type { TargetApplyTauriApi } from "../targetApplyTauri";
import { TargetVerifyOutcomesStoreV5 } from "../targetVerifyOutcomesStore";
import {
  TargetDraftAutosaveAlreadySuspendedError,
  TargetDraftAutosaveGateV5,
} from "../targetDraftAutosaveGate";
import { TargetDraftEditsStore } from "../targetDraftEdits";

const STARTED_EVENT = "apply_edits_v5_started";
const PROGRESS_EVENT = "apply_metadata_edits_v5_progress";
const path = "photo.jpg";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function draft(value = "draft"): MetadataDraftEntryV5 {
  return {
    target: {
      kind: "NewProperty",
      schema_id: { table: "Exif::Main", tag_id: "282" },
    },
    edit: {
      intent: "Set",
      value: { kind: "Text", value },
      display: value,
    },
  };
}

function fileResult(
  overrides: Partial<MetadataApplyFileResultV5> = {},
): MetadataApplyFileResultV5 {
  return {
    relative_path: path,
    applied: true,
    error: null,
    warning: null,
    fresh_image_metadata: {
      relative_path: path,
      occurrences: [],
    },
    target_outcomes: [],
    persisted_draft_entries: [draft()],
    ...overrides,
  };
}

const replacementTarget = {
  kind: "ExistingOccurrence" as const,
  occurrence_id: {
    document: null,
    path: "JPEG-APP1-IFD0",
    runtime_tag_id: "282",
    tag_id_scope: { table: "TestFixture::Runtime", tag_id: "282", index: null },
    copy: 0,
  },
  schema_id: { table: "Exif::Main", tag_id: "282" },
  write_target: { group1: "IFD0", tag_name: "XResolution" },
};

function invalidPersistenceResult(
  error = "persistence failure",
  warning: string | null = "readback warning",
): MetadataApplyFileResultV5 {
  const targetOutcome: MetadataTargetOutcome = {
    target: {
      kind: "NewProperty",
      schema_id: { table: "Exif::Main", tag_id: "282" },
    },
    draft_reconciliation: {
      kind: "Replace",
      target: replacementTarget,
    },
    display_name: "XResolution",
    kind: "ReadbackFailed",
    sent: { kind: "Text", value: "requested" },
    before: null,
    observed: null,
    message: "readback failed",
  };
  return fileResult({
    applied: false,
    error,
    warning,
    fresh_image_metadata: null,
    target_outcomes: [targetOutcome],
    persisted_draft_entries: null,
  });
}

function batchResult(
  files: MetadataApplyFileResultV5[] = [fileResult()],
  overrides: Partial<MetadataApplyEditsResultV5> = {},
): MetadataApplyEditsResultV5 {
  return {
    files,
    cancelled: false,
    aborted: false,
    abort_reason: null,
    ...overrides,
  };
}

class FakeApplyApi implements TargetApplyTauriApi {
  readonly order: string[] = [];
  readonly invokeCalls: Array<{
    command: string;
    args?: Record<string, unknown>;
  }> = [];
  readonly captured = new Map<string, Array<(payload: unknown) => void>>();
  readonly live = new Map<string, (payload: unknown) => void>();
  readonly cleanupSuppression: boolean[] = [];
  failListenEvent: string | null = null;
  cleanupError: unknown;
  mutateApplyPaths = false;
  apply: () => Promise<unknown> = async () => batchResult();
  cancel: () => Promise<unknown> = async () => undefined;

  constructor(readonly gate: TargetDraftAutosaveGateV5) {}

  async listen(
    event: string,
    handler: (payload: unknown) => void,
  ): Promise<() => void> {
    this.order.push(`listen:${event}:${this.gate.isSuppressed()}`);
    if (this.failListenEvent === event)
      throw new Error(`listen failed: ${event}`);
    const handlers = this.captured.get(event) ?? [];
    handlers.push(handler);
    this.captured.set(event, handlers);
    this.live.set(event, handler);
    return () => {
      this.order.push(`cleanup:${event}`);
      this.cleanupSuppression.push(this.gate.isSuppressed());
      if (this.live.get(event) === handler) this.live.delete(event);
      if (this.cleanupError !== undefined) throw this.cleanupError;
    };
  }

  async invoke(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    this.order.push(`invoke:${command}`);
    this.invokeCalls.push({ command, args });
    if (command === "cancel_apply_edits_v5") return this.cancel();
    if (this.mutateApplyPaths) {
      (args?.relPaths as string[]).push("backend-mutation.jpg");
    }
    return this.apply();
  }

  emit(event: string, payload: unknown, generation?: number): void {
    const handler =
      generation === undefined
        ? this.live.get(event)
        : this.captured.get(event)?.[generation];
    handler?.(payload);
  }
}

function makeStores(): TargetApplyResultStores {
  return {
    drafts: new TargetDraftEditsStore(),
    occurrences: new ImageMetadataOccurrencesStore(),
    verification: new TargetVerifyOutcomesStoreV5(),
  };
}

function harness(callbacks: TargetApplyControllerCallbacksV5 = {}) {
  const gate = new TargetDraftAutosaveGateV5();
  const api = new FakeApplyApi(gate);
  const stores = makeStores();
  const controller = new TargetApplyControllerV5(
    { api, stores, autosaveGate: gate },
    callbacks,
  );
  return { api, callbacks, controller, gate, stores };
}

async function waitForApply(api: FakeApplyApi): Promise<void> {
  await vi.waitFor(() => {
    expect(
      api.invokeCalls.some(
        ({ command }) => command === "apply_metadata_draft_edits_v5_cmd",
      ),
    ).toBe(true);
  });
}

describe("TargetDraftAutosaveGateV5", () => {
  it("acquires once, rejects overlap, and supports idempotent release", () => {
    const gate = new TargetDraftAutosaveGateV5();
    const suspension = gate.trySuspend();
    expect(gate.isSuppressed()).toBe(true);
    expect(() => gate.trySuspend()).toThrow(
      TargetDraftAutosaveAlreadySuspendedError,
    );
    suspension.release();
    suspension.release();
    expect(gate.isSuppressed()).toBe(false);
  });

  it("does not let an old release clear a newer suspension", () => {
    const gate = new TargetDraftAutosaveGateV5();
    const old = gate.trySuspend();
    old.release();
    const current = gate.trySuspend();
    old.release();
    expect(gate.isSuppressed()).toBe(true);
    expect(current.token).not.toBe(old.token);
    current.release();
    expect(gate.isSuppressed()).toBe(false);
  });
});

describe("inactive TargetApplyControllerV5 lifecycle", () => {
  it("starts idle and isolates observable state snapshots and subscribers", async () => {
    const { api, controller } = harness();
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    expect(controller.getState()).toEqual({ status: "idle" });
    const listener = vi.fn((state) => {
      if (state.status === "running") state.current = 99;
    });
    const unsubscribe = controller.subscribe(listener);
    const run = controller.run("folder", []);
    await waitForApply(api);
    api.emit(STARTED_EVENT, { total: 2 });
    api.emit(STARTED_EVENT, { total: 2 });
    expect(controller.getState()).toMatchObject({
      status: "running",
      current: 0,
      total: 2,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    command.resolve(batchResult([]));
    await run;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it("suppresses autosave, registers both listeners, then invokes without mutating paths", async () => {
    const { api, controller, gate } = harness();
    api.mutateApplyPaths = true;
    const paths = ["z.jpg", "a.jpg"];
    await controller.run("folder", paths);
    expect(api.order.slice(0, 3)).toEqual([
      `listen:${STARTED_EVENT}:true`,
      `listen:${PROGRESS_EVENT}:true`,
      "invoke:apply_metadata_draft_edits_v5_cmd",
    ]);
    expect(paths).toEqual(["z.jpg", "a.jpg"]);
    expect(gate.isSuppressed()).toBe(false);
  });

  it("applies progress to all stores, reports its summary, and makes an identical final result a no-op", async () => {
    const onProgress = vi.fn();
    const { api, controller, stores } = harness({ onProgress });
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    const draftListener = vi.fn();
    const occurrenceListener = vi.fn();
    stores.drafts.subscribe(draftListener);
    stores.occurrences.subscribe(path, occurrenceListener);

    const run = controller.run("folder", [path]);
    await waitForApply(api);
    const progressResult = fileResult();
    api.emit(PROGRESS_EVENT, {
      current: 1,
      total: 1,
      result: progressResult,
    });
    expect(controller.getState()).toMatchObject({
      status: "running",
      current: 1,
      total: 1,
      currentFile: path,
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ current: 1, total: 1 }),
      expect.objectContaining({
        relativePath: path,
        draftsChanged: true,
        occurrencesChanged: true,
      }),
    );
    command.resolve(batchResult([progressResult]));
    const result = await run;
    expect(result.application.files[0]).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: false,
    });
    expect(
      [draftListener, occurrenceListener].map(
        (listener) => listener.mock.calls.length,
      ),
    ).toEqual([1, 1]);
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it("lets a genuinely different authoritative final result replace progress", async () => {
    const onFinalApplied = vi.fn();
    const { api, controller, stores } = harness({ onFinalApplied });
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    api.emit(PROGRESS_EVENT, {
      current: 1,
      total: 1,
      result: fileResult(),
    });
    const authoritative = fileResult({
      persisted_draft_entries: [draft("authoritative")],
      fresh_image_metadata: {
        relative_path: path,
        occurrences: [
          {
            id: {
              document: null,
              path: "JPEG-APP1-IFD0",
              runtime_tag_id: "282",
              tag_id_scope: {
                table: "TestFixture::Runtime",
                tag_id: "282",
                index: null,
              },
              copy: 0,
            },
            schema_id: { table: "Exif::Main", tag_id: "282" },
            value: { kind: "Text", value: "authoritative" },
            tag_info: null,
            write_target: null,
          },
        ],
      },
    });
    command.resolve(batchResult([authoritative]));
    const result = await run;
    expect(result.application.files[0]).toMatchObject({
      draftsChanged: true,
    });
    expect(
      Object.values(stores.drafts.getMetadataFile(path)!)[0].edit.display,
    ).toBe("authoritative");
    expect(onFinalApplied).toHaveBeenCalledWith(
      result.commandResult,
      result.application,
    );
  });

  it("ignores progress queued during cleanup and cleans listeners before releasing suppression", async () => {
    const onProgress = vi.fn();
    const { api, controller, gate, stores } = harness({ onProgress });
    const originalListen = api.listen.bind(api);
    api.listen = async (event, handler) => {
      const unregister = await originalListen(event, handler);
      return () => {
        if (event === STARTED_EVENT) {
          api.emit(PROGRESS_EVENT, {
            current: 1,
            total: 1,
            result: fileResult({ persisted_draft_entries: [draft("late")] }),
          });
        }
        unregister();
      };
    };
    await controller.run("folder", [path]);
    expect(onProgress).not.toHaveBeenCalled();
    expect(
      Object.values(stores.drafts.getMetadataFile(path)!)[0].edit.display,
    ).toBe("draft");
    expect(api.cleanupSuppression).toEqual([true, true]);
    expect(gate.isSuppressed()).toBe(false);
  });

  it("rejects local overlap before any second-run side effect", async () => {
    const { api, controller, gate, stores } = harness();
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    const first = controller.run("folder", [path]);
    await waitForApply(api);
    const counts = {
      order: api.order.length,
      invokes: api.invokeCalls.length,
      drafts: stores.drafts.getAllMetadata(),
    };
    await expect(controller.run("other", [])).rejects.toBeInstanceOf(
      TargetApplyControllerBusyError,
    );
    expect(api.order).toHaveLength(counts.order);
    expect(api.invokeCalls).toHaveLength(counts.invokes);
    expect(stores.drafts.getAllMetadata()).toBe(counts.drafts);
    expect(gate.isSuppressed()).toBe(true);
    command.resolve(batchResult([]));
    await first;
  });
});

describe("inactive TargetApplyControllerV5 errors", () => {
  it("counts semantic file failures and deduplicates exact file diagnostics per run", async () => {
    const onFileError = vi.fn();
    const onFileWarning = vi.fn();
    const { api, controller } = harness({ onFileError, onFileWarning });
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    const failed = fileResult({
      applied: false,
      error: "write failed",
      warning: "partial metadata remained",
    });
    const payload = { current: 1, total: 1, result: failed };
    api.emit(PROGRESS_EVENT, payload);
    api.emit(PROGRESS_EVENT, payload);
    expect(controller.getState()).toMatchObject({
      fileFailureCount: 1,
      protocolErrorCount: 0,
      progressApplicationErrorCount: 0,
    });
    command.resolve(batchResult([failed]));
    await run;
    expect(onFileError).toHaveBeenCalledOnce();
    expect(onFileError).toHaveBeenCalledWith(path, "write failed");
    expect(onFileWarning).toHaveBeenCalledOnce();
    expect(onFileWarning).toHaveBeenCalledWith(
      path,
      "partial metadata remained",
    );
  });

  it("preserves progress diagnostics when verification application fails", async () => {
    const onFileError = vi.fn();
    const onFileWarning = vi.fn();
    const onProgressApplicationError = vi.fn();
    const { api, controller } = harness({
      onFileError,
      onFileWarning,
      onProgressApplicationError,
    });
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    const failed = invalidPersistenceResult();
    const payload = { current: 1, total: 1, result: failed };
    api.emit(PROGRESS_EVENT, payload);

    expect(controller.getState()).toMatchObject({
      fileFailureCount: 1,
      progressApplicationErrorCount: 1,
      protocolErrorCount: 0,
    });
    expect(onFileError).toHaveBeenCalledWith(path, "persistence failure");
    expect(onFileWarning).toHaveBeenCalledWith(path, "readback warning");
    expect(onProgressApplicationError).toHaveBeenCalledOnce();
    const frontendError = onProgressApplicationError.mock.calls[0][0].error;
    expect(frontendError.message).toMatch(/verification contract error/i);
    expect(frontendError.message).not.toContain("persistence failure");

    command.resolve(batchResult([failed]));
    await expect(run).rejects.toThrow(/verification contract error/i);
    expect(onFileError).toHaveBeenCalledOnce();
    expect(onFileWarning).toHaveBeenCalledOnce();
  });

  it("presents final-only backend diagnostics before final validation fails", async () => {
    const onFileError = vi.fn();
    const onFileWarning = vi.fn();
    const { api, controller } = harness({ onFileError, onFileWarning });
    api.apply = async () =>
      batchResult([
        invalidPersistenceResult(
          "backend write/readback persistence failure",
          "backend final warning",
        ),
      ]);

    await expect(controller.run("folder", [path])).rejects.toThrow(
      /verification contract error/i,
    );
    expect(onFileError).toHaveBeenCalledWith(
      path,
      "backend write/readback persistence failure",
    );
    expect(onFileWarning).toHaveBeenCalledWith(path, "backend final warning");
  });

  it("does not invoke after atomic listener registration fails and releases all lifecycle state", async () => {
    const { api, controller, gate } = harness();
    api.failListenEvent = PROGRESS_EVENT;
    await expect(controller.run("folder", [])).rejects.toThrow(
      `listen failed: ${PROGRESS_EVENT}`,
    );
    expect(api.invokeCalls).toEqual([]);
    expect(api.order).toContain(`cleanup:${STARTED_EVENT}`);
    expect(gate.isSuppressed()).toBe(false);
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it.each([new Error("backend busy"), { kind: "load/apply failure" }])(
    "propagates command rejection unchanged and releases suppression %#",
    async (backendError) => {
      const { api, controller, gate } = harness();
      api.apply = async () => {
        throw backendError;
      };
      await expect(controller.run("folder", [])).rejects.toBe(backendError);
      expect(gate.isSuppressed()).toBe(false);
      expect(controller.getState()).toEqual({ status: "idle" });
    },
  );

  it("records malformed progress only as a structured protocol error", async () => {
    const onProtocolError = vi.fn();
    const onProgress = vi.fn();
    const { api, controller } = harness({ onProtocolError, onProgress });
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    const malformed = { current: 0, total: 1, result: fileResult() };
    api.emit(PROGRESS_EVENT, malformed);
    expect(controller.getState()).toMatchObject({
      protocolErrorCount: 1,
      progressApplicationErrorCount: 0,
    });
    command.resolve(batchResult([]));
    const result = await run;
    expect(result.protocolErrors).toEqual([
      expect.objectContaining({
        eventName: PROGRESS_EVENT,
        error: expect.any(Error),
        rawPayload: malformed,
      }),
    ]);
    expect(result.progressApplicationErrors).toEqual([]);
    expect(onProtocolError).toHaveBeenCalledWith(result.protocolErrors[0]);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("contains progress-application failure and still applies the authoritative final result", async () => {
    const onProgressApplicationError = vi.fn();
    const { api, controller, stores } = harness({
      onProgressApplicationError,
    });
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    const applicationError = new Error("local apply failed");
    vi.spyOn(stores.drafts, "replaceMetadataFile").mockImplementationOnce(
      () => {
        throw applicationError;
      },
    );
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    const payload = { current: 1, total: 1, result: fileResult() };
    expect(() => api.emit(PROGRESS_EVENT, payload)).not.toThrow();
    expect(controller.getState()).toMatchObject({
      progressApplicationErrorCount: 1,
    });
    command.resolve(batchResult([payload.result]));
    const result = await run;
    expect(result.progressApplicationErrors).toEqual([
      {
        eventName: PROGRESS_EVENT,
        error: applicationError,
        rawPayload: payload,
      },
    ]);
    expect(result.application.files[0].draftsChanged).toBe(true);
    expect(stores.drafts.getMetadataFile(path)).toBeDefined();
    expect(onProgressApplicationError).toHaveBeenCalledWith(
      result.progressApplicationErrors[0],
    );
  });

  it("rejects malformed final results and releases suppression", async () => {
    const { api, controller, gate } = harness();
    api.apply = async () => ({ files: "malformed" });
    await expect(controller.run("folder", [])).rejects.toThrow(
      /files must be an array/,
    );
    expect(gate.isSuppressed()).toBe(false);
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it("cleans up and releases suppression after final-application failure", async () => {
    const { api, controller, gate, stores } = harness();
    const finalError = new Error("final apply failed");
    vi.spyOn(stores.drafts, "replaceMetadataFile").mockImplementation(() => {
      throw finalError;
    });
    await expect(controller.run("folder", [path])).rejects.toBe(finalError);
    expect(api.cleanupSuppression).toEqual([true, true]);
    expect(gate.isSuppressed()).toBe(false);
    expect(controller.getState()).toEqual({ status: "idle" });
  });

  it("releases suppression and ownership when cleanup alone fails", async () => {
    const { api, controller, gate } = harness();
    const cleanupError = new Error("cleanup failed");
    api.cleanupError = cleanupError;
    await expect(controller.run("folder", [])).rejects.toBe(cleanupError);
    expect(api.cleanupSuppression).toEqual([true, true]);
    expect(gate.isSuppressed()).toBe(false);
    expect(controller.getState()).toEqual({ status: "idle" });
    api.cleanupError = undefined;
    await expect(controller.run("folder", [])).resolves.toBeDefined();
  });

  it("does not mask a primary error with cleanup failure", async () => {
    const { api, controller, gate } = harness();
    const primary = new Error("primary");
    api.apply = async () => {
      throw primary;
    };
    api.cleanupError = new Error("cleanup");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(controller.run("folder", [])).rejects.toBe(primary);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("after an earlier failure"),
      api.cleanupError,
    );
    expect(gate.isSuppressed()).toBe(false);
    consoleError.mockRestore();
  });

  it("contains every optional callback failure without corrupting lifecycle", async () => {
    const callbackError = new Error("callback failed");
    const callbacks: TargetApplyControllerCallbacksV5 = {
      onStarted: () => {
        throw callbackError;
      },
      onProgress: () => {
        throw callbackError;
      },
      onProtocolError: () => {
        throw callbackError;
      },
      onProgressApplicationError: () => {
        throw callbackError;
      },
      onFinalApplied: () => {
        throw callbackError;
      },
    };
    const { api, controller, stores } = harness(callbacks);
    const command = deferred<unknown>();
    api.apply = () => command.promise;
    vi.spyOn(stores.drafts, "replaceMetadataFile").mockImplementationOnce(
      () => {
        throw new Error("supplemental failure");
      },
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    expect(() => api.emit(STARTED_EVENT, { total: 1 })).not.toThrow();
    expect(() => api.emit(PROGRESS_EVENT, { bad: true })).not.toThrow();
    expect(() =>
      api.emit(PROGRESS_EVENT, {
        current: 1,
        total: 2,
        result: fileResult(),
      }),
    ).not.toThrow();
    expect(() =>
      api.emit(PROGRESS_EVENT, {
        current: 2,
        total: 2,
        result: fileResult(),
      }),
    ).not.toThrow();
    command.resolve(batchResult([fileResult()]));
    await expect(run).resolves.toBeDefined();
    expect(consoleError.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(controller.getState()).toEqual({ status: "idle" });
    consoleError.mockRestore();
  });
});

describe("inactive TargetApplyControllerV5 cancellation", () => {
  it("does nothing while idle", async () => {
    const { api, controller } = harness();
    await controller.cancel();
    expect(api.invokeCalls).toEqual([]);
  });

  it("signals the exact adapter once, shares repeats, and retains suppression until apply settles", async () => {
    const { api, controller, gate } = harness();
    const command = deferred<unknown>();
    const cancellation = deferred<unknown>();
    api.apply = () => command.promise;
    api.cancel = () => cancellation.promise;
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    const firstCancel = controller.cancel();
    const secondCancel = controller.cancel();
    expect(secondCancel).toBe(firstCancel);
    expect(controller.getState()).toMatchObject({
      status: "running",
      cancelling: true,
    });
    expect(
      api.invokeCalls.filter(
        ({ command }) => command === "cancel_apply_edits_v5",
      ),
    ).toHaveLength(1);
    expect(gate.isSuppressed()).toBe(true);
    cancellation.resolve(undefined);
    await firstCancel;
    expect(gate.isSuppressed()).toBe(true);
    expect(controller.cancel()).toBe(firstCancel);
    command.resolve(batchResult([], { cancelled: true }));
    await run;
    expect(controller.getState()).toEqual({ status: "idle" });
    expect(gate.isSuppressed()).toBe(false);
  });

  it("propagates cancellation failure while leaving the apply run active", async () => {
    const { api, controller, gate } = harness();
    const command = deferred<unknown>();
    const cancellationError = new Error("cancel failed");
    api.apply = () => command.promise;
    api.cancel = async () => {
      throw cancellationError;
    };
    const run = controller.run("folder", [path]);
    await waitForApply(api);
    await expect(controller.cancel()).rejects.toBe(cancellationError);
    expect(controller.getState()).toMatchObject({
      status: "running",
      cancelling: false,
    });
    expect(gate.isSuppressed()).toBe(true);
    command.resolve(batchResult([]));
    await run;
  });
});

describe("inactive TargetApplyControllerV5 generations", () => {
  it("ignores completed and older-generation events, including malformed payloads", async () => {
    const onProgress = vi.fn();
    const onProtocolError = vi.fn();
    const { api, controller, stores } = harness({
      onProgress,
      onProtocolError,
    });
    await controller.run("folder", []);
    onProgress.mockClear();
    onProtocolError.mockClear();
    const draftListener = vi.fn();
    stores.drafts.subscribe(draftListener);

    api.emit(PROGRESS_EVENT, { current: 1, total: 1, result: fileResult() }, 0);
    expect(draftListener).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();

    const nextCommand = deferred<unknown>();
    api.apply = () => nextCommand.promise;
    const nextRun = controller.run("folder", []);
    await waitForApply(api);
    api.emit(PROGRESS_EVENT, { current: 1, total: 1, result: fileResult() }, 0);
    api.emit(PROGRESS_EVENT, { malformed: true }, 0);
    expect(draftListener).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ protocolErrorCount: 0 });
    nextCommand.resolve(batchResult([]));
    await nextRun;
  });

  it("never sends local generation tokens through Tauri", async () => {
    const { api, controller } = harness();
    await controller.run("folder", ["b.jpg", "a.jpg"]);
    const applyCall = api.invokeCalls.find(
      ({ command }) => command === "apply_metadata_draft_edits_v5_cmd",
    );
    expect(applyCall).toEqual({
      command: "apply_metadata_draft_edits_v5_cmd",
      args: { folderPath: "folder", relPaths: ["b.jpg", "a.jpg"] },
    });
    expect(
      Object.values(applyCall!.args!).some(
        (value) => typeof value === "symbol",
      ),
    ).toBe(false);
  });
});
