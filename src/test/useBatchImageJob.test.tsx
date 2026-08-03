import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaLibraryBatchOperation } from "../types";
import {
  useBatchImageJob,
  type BatchJobConfig,
} from "../hooks/useBatchImageJob";

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const eventListeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    eventListeners.set(event, handler);
    return () => eventListeners.delete(event);
  },
}));

const config: BatchJobConfig<string[]> = {
  operationKind: "describe",
  commands: {
    estimate: "estimate_cmd",
    run: "run_cmd",
    cancel: "cancel_cmd",
  },
  buildEstimateArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
  buildRunArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
  totalItems: (relPaths) => relPaths.length,
  relativePaths: (relPaths) => relPaths,
};

function operation(
  overrides: Partial<MediaLibraryBatchOperation> = {},
): MediaLibraryBatchOperation {
  return {
    operation_id: "describe-7",
    kind: "describe",
    requested_paths: ["a.jpg", "b.jpg"],
    request: ["a.jpg", "b.jpg"],
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
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  eventListeners.clear();
});

describe("useBatchImageJob Rust projection", () => {
  it("starts estimation with the authoritative session identity", async () => {
    const { result } = renderHook(() =>
      useBatchImageJob(config, { sessionId: 12 }),
    );
    act(() => result.current.actions.start("/folder", ["a.jpg"]));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("estimate_cmd", {
        folderPath: "/folder",
        relPaths: ["a.jpg"],
        sessionId: 12,
      }),
    );
  });

  it("projects compact progress events without fetching a session snapshot", async () => {
    const { result } = renderHook(() =>
      useBatchImageJob(config, { sessionId: 12 }),
    );
    act(() => result.current.actions.start("/folder", ["a.jpg", "b.jpg"]));
    await waitFor(() =>
      expect(eventListeners.has("describe_progress")).toBe(true),
    );

    act(() => {
      eventListeners.get("describe_progress")?.({
        payload: {
          current: 1,
          total: 2,
          relativePath: "a.jpg",
          status: "ok",
        },
      });
    });

    await waitFor(() => expect(result.current.state.current).toBe(1));
    expect(result.current.state.currentFile).toBe("a.jpg");
    expect(result.current.state.succeeded).toEqual(["a.jpg"]);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "get_media_library_session_snapshot",
    );
  });

  it("recovers a rejected command from the Rust session instead of inventing a failure", async () => {
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === "estimate_cmd") throw new Error("missing API key");
      if (command === "get_media_library_session_snapshot") {
        return {
          session_id: 12,
          batch_operations: {
            describe: operation({
              phase: "failed",
              error: "missing API key",
            }),
          },
        };
      }
      return undefined;
    });
    const { result } = renderHook(() =>
      useBatchImageJob(config, { sessionId: 12 }),
    );

    act(() => result.current.actions.start("/folder", ["a.jpg"]));

    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    expect(result.current.state.estimateError).toBe("missing API key");
    expect(result.current.state.failures).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith(
      "get_media_library_session_snapshot",
    );
  });

  it("does not recover a batch operation from a replacement session", async () => {
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === "estimate_cmd") throw new Error("stale command");
      if (command === "get_media_library_session_snapshot") {
        return {
          session_id: 13,
          batch_operations: {
            describe: operation({ phase: "failed", error: "wrong session" }),
          },
        };
      }
      return undefined;
    });
    const { result } = renderHook(() =>
      useBatchImageJob(config, { sessionId: 12 }),
    );

    act(() => result.current.actions.start("/folder", ["a.jpg"]));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "get_media_library_session_snapshot",
      ),
    );
    expect(result.current.state.phase).toBe("estimating");
    expect(result.current.state.estimateError).toBeNull();
  });
  it("reconstructs all durable lifecycle state from one Rust operation", async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: MediaLibraryBatchOperation }) =>
        useBatchImageJob(config, { sessionId: 12, operation: value }),
      { initialProps: { value: operation() } },
    );
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.state.phase).toBe("awaiting-confirm");
    expect(result.current.state.relPaths).toEqual(["a.jpg", "b.jpg"]);

    act(() => result.current.actions.confirm());
    expect(invokeMock).toHaveBeenCalledWith("run_cmd", {
      sessionId: 12,
      operationId: "describe-7",
    });

    rerender({
      value: operation({
        phase: "running",
        current: 1,
        current_file: "a.jpg",
        cancelling: true,
      }),
    });
    await waitFor(() => expect(result.current.state.phase).toBe("running"));
    expect(result.current.state.currentFile).toBe("a.jpg");

    rerender({
      value: operation({
        phase: "completed",
        succeeded: ["a.jpg", "b.jpg"],
        summary: { actualCostUsd: 0.25 },
      }),
    });
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    expect(result.current.state.summary).toEqual({ actualCostUsd: 0.25 });

    act(() => result.current.actions.close());
    expect(invokeMock).toHaveBeenCalledWith(
      "dismiss_media_library_session_batch_operation",
      { sessionId: 12, operationId: "describe-7" },
    );
  });

  it("ignores progress from a stale session or replacement operation", async () => {
    const activeOperation = operation();
    const { result } = renderHook(() =>
      useBatchImageJob(config, { sessionId: 12, operation: activeOperation }),
    );
    await waitFor(() =>
      expect(eventListeners.has("describe_progress")).toBe(true),
    );
    act(() => {
      eventListeners.get("describe_progress")?.({
        payload: {
          sessionId: 13,
          operationId: "describe-7",
          current: 1,
          total: 2,
          relativePath: "wrong-session.jpg",
          status: "ok",
        },
      });
      eventListeners.get("describe_progress")?.({
        payload: {
          sessionId: 12,
          operationId: "describe-previous",
          current: 1,
          total: 2,
          relativePath: "wrong-operation.jpg",
          status: "ok",
        },
      });
    });

    await Promise.resolve();
    expect(result.current.state.current).toBe(2);
    expect(result.current.state.currentFile).toBeNull();
    expect(result.current.state.succeeded).toEqual([]);
  });

  it("does not reopen an authoritative operation the user dismissed", async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: MediaLibraryBatchOperation }) =>
        useBatchImageJob(config, { sessionId: 12, operation: value }),
      { initialProps: { value: operation() } },
    );
    await waitFor(() => expect(result.current.open).toBe(true));

    act(() => result.current.actions.cancel());
    expect(result.current.open).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith(
      "dismiss_media_library_session_batch_operation",
      { sessionId: 12, operationId: "describe-7" },
    );

    // The cancel command itself pushes a snapshot that still contains the
    // operation (cancelling=true); a late completion snapshot can follow
    // seconds later. Neither may reopen the dismissed dialog.
    rerender({ value: operation({ cancelling: true }) });
    await Promise.resolve();
    expect(result.current.open).toBe(false);
    rerender({ value: operation({ phase: "completed" }) });
    await Promise.resolve();
    expect(result.current.open).toBe(false);
  });

  it("dismisses an operation that appears after the user cancelled before it", async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: MediaLibraryBatchOperation | undefined }) =>
        useBatchImageJob(config, { sessionId: 12, operation: value }),
      {
        initialProps: {
          value: undefined as MediaLibraryBatchOperation | undefined,
        },
      },
    );

    act(() => result.current.actions.cancel());
    expect(result.current.open).toBe(false);

    rerender({ value: operation() });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "dismiss_media_library_session_batch_operation",
        { sessionId: 12, operationId: "describe-7" },
      ),
    );
    expect(result.current.open).toBe(false);
  });

  it("does not regress an open dialog to estimating from a lagging begin snapshot", async () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: MediaLibraryBatchOperation | undefined }) =>
        useBatchImageJob(config, { sessionId: 12, operation: value }),
      {
        initialProps: {
          value: undefined as MediaLibraryBatchOperation | undefined,
        },
      },
    );

    act(() => result.current.actions.start("/folder", ["a.jpg"]));
    await waitFor(() =>
      expect(eventListeners.has("describe_estimate_started")).toBe(true),
    );

    // The command thread emits the projection events synchronously, so the
    // dialog advances straight to the confirmation stage.
    act(() => {
      eventListeners.get("describe_estimate_started")?.({
        payload: { total: 1 },
      });
      eventListeners.get("describe_estimate_complete")?.({
        payload: {
          sessionId: 12,
          operationId: "describe-7",
          totalInputTokens: 42,
          predictedCostUsd: 0.001,
          upperBoundCostUsd: 0.002,
          model: "gpt-test",
          estimateMode: "heuristic",
        },
      });
    });
    expect(result.current.state.phase).toBe("awaiting-confirm");

    // The Estimating begin snapshot drains through the session channel
    // afterwards and must not push the dialog back to the estimating panel.
    rerender({
      value: operation({ phase: "estimating", current: 0, current_file: null }),
    });
    expect(result.current.state.phase).toBe("awaiting-confirm");

    // The completion snapshot lands even later; it confirms the phase and
    // supplies the authoritative estimate payload.
    rerender({ value: operation({ phase: "awaiting-confirm" }) });
    expect(result.current.state.phase).toBe("awaiting-confirm");
    expect(result.current.state.estimate).toEqual({ totalInputTokens: 42 });
  });
});
