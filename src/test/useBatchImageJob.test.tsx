/**
 * Direct unit test for `useBatchImageJob` focused on the
 * deferred-estimate latch.
 *
 * Bug context (commit e848bba): the previous version invoked the
 * estimate command synchronously inside `start()`. A fast backend
 * (e.g. the no-AI branch of `normalise_estimate_cost_cmd`) could
 * emit `_estimate_complete` before the subscription effect had time
 * to register its listener via `subscribeExtras`, leaving the dialog
 * stuck on the estimating panel.
 *
 * The fix: `start()` enqueues the invoke into `pendingEstimateRef`
 * when listeners aren't ready yet, and the subscription effect fires
 * the pending invoke immediately after attaching listeners. These
 * tests pin that ordering: the estimate command must NEVER fire
 * before `subscribeExtras` has been called.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { MediaLibraryBatchOperation } from "../types";
import {
  useBatchImageJob,
  type BatchJobConfig,
} from "../hooks/useBatchImageJob";
let invokeMock: Mock<(...args: unknown[]) => Promise<unknown>>;
let listenMock: Mock<(...args: unknown[]) => Promise<() => void>>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

interface EstimatePayload {
  totalInputTokens: number;
}
interface SummaryPayload {
  actualCostUsd: number;
}

function makeConfig(
  subscribeExtras: BatchJobConfig<
    string[],
    EstimatePayload,
    SummaryPayload
  >["subscribeExtras"],
): BatchJobConfig<string[], EstimatePayload, SummaryPayload> {
  return {
    eventPrefix: "test",
    commands: {
      estimate: "estimate_cmd",
      run: "run_cmd",
      cancel: "cancel_cmd",
    },
    buildEstimateArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
    buildRunArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
    totalItems: (relPaths) => relPaths.length,
    parseEstimatePayload: (raw) => raw as EstimatePayload,
    parseSummaryPayload: (raw) => raw as SummaryPayload,
    subscribeExtras,
  };
}

beforeEach(() => {
  invokeMock = vi.fn().mockResolvedValue(undefined);
  // Default listen resolves with a no-op unlistener but never actually
  // fires anything — tests that need to drive events override this.
  listenMock = vi.fn().mockResolvedValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useBatchImageJob deferred estimate latch", () => {
  it("does NOT invoke the estimate command until subscribeExtras has attached its listener", async () => {
    // Block subscribeExtras on a promise we control; the hook must not
    // call invoke() until we resolve it.
    let releaseSubscribe!: () => void;
    const subscribePromise = new Promise<void>((r) => {
      releaseSubscribe = r;
    });
    const subscribeExtras = vi.fn(async () => {
      await subscribePromise;
      return [];
    });

    const { result } = renderHook(() =>
      useBatchImageJob<string[], EstimatePayload, SummaryPayload>(
        makeConfig(subscribeExtras),
      ),
    );

    // Kick off the flow.
    act(() => {
      result.current.actions.start("/folder", ["a.jpg"]);
    });

    // Let the subscription effect register the universal listeners
    // (started/progress/complete). Even after that, the estimate
    // invoke must still be deferred because subscribeExtras hasn't
    // finished.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "estimate_cmd",
      expect.anything(),
    );

    // Release subscribeExtras → listeners ready → pending invoke fires.
    await act(async () => {
      releaseSubscribe();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("estimate_cmd", {
        folderPath: "/folder",
        relPaths: ["a.jpg"],
      });
    });
  });

  it("invokes the estimate command directly when start() runs with listeners already attached", async () => {
    // No-op extras → subscription effect finishes synchronously.
    const subscribeExtras = vi.fn(async () => []);

    const { result } = renderHook(() =>
      useBatchImageJob<string[], EstimatePayload, SummaryPayload>(
        makeConfig(subscribeExtras),
      ),
    );

    act(() => {
      result.current.actions.start("/f", ["b.jpg"]);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("estimate_cmd", {
        folderPath: "/f",
        relPaths: ["b.jpg"],
      });
    });
  });

  it("skips the estimate phase entirely for configs without commands.estimate", async () => {
    // Geocode-shaped job: no estimate command, jumps straight to
    // awaiting-confirm so the dialog renders the confirm panel from
    // the saved relPaths/total alone.
    const config: BatchJobConfig<string[], EstimatePayload, SummaryPayload> = {
      eventPrefix: "noestimate",
      commands: { run: "run_cmd", cancel: "cancel_cmd" },
      buildRunArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
      totalItems: (relPaths) => relPaths.length,
      parseSummaryPayload: (raw) => raw as SummaryPayload,
    };

    const { result } = renderHook(() =>
      useBatchImageJob<string[], EstimatePayload, SummaryPayload>(config),
    );

    act(() => {
      result.current.actions.start("/f", ["c.jpg", "d.jpg"]);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.state.phase).toBe("awaiting-confirm");
    expect(result.current.state.total).toBe(2);
    // Estimate command is missing from config, so invoke must NEVER be
    // called with an "estimate"-style name.
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("estimate_cmd");
  });

  it("reconstructs awaiting-confirm, running, and completed state from Rust operations after remount", async () => {
    const config = makeConfig(async () => []);
    const awaiting: MediaLibraryBatchOperation = {
      operation_id: "describe-1",
      kind: "describe",
      phase: "awaiting-confirm",
      total: 2,
      current: 2,
      current_file: null,
      cancelling: false,
      failures: [],
      succeeded: [],
      estimate: { totalInputTokens: 42 },
      summary: null,
      error: null,
    };

    const { result, rerender } = renderHook(
      ({ operation }: { operation?: MediaLibraryBatchOperation }) =>
        useBatchImageJob<string[], EstimatePayload, SummaryPayload>(config, {
          operation,
        }),
      { initialProps: { operation: awaiting } },
    );

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.state.phase).toBe("awaiting-confirm");
    expect(result.current.state.estimate).toEqual({ totalInputTokens: 42 });

    rerender({
      operation: {
        ...awaiting,
        phase: "running",
        current: 1,
        current_file: "a.jpg",
        cancelling: true,
        succeeded: ["b.jpg"],
      },
    });
    await waitFor(() => expect(result.current.state.phase).toBe("running"));
    expect(result.current.state.currentFile).toBe("a.jpg");
    expect(result.current.state.cancelling).toBe(true);

    rerender({
      operation: {
        ...awaiting,
        phase: "completed",
        succeeded: ["a.jpg", "b.jpg"],
        summary: { actualCostUsd: 0.25 },
      },
    });
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    expect(result.current.state.summary).toEqual({ actualCostUsd: 0.25 });

    act(() => result.current.actions.close());
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "dismiss_media_library_session_batch_operation",
        { kind: "test" },
      ),
    );
  });
});
