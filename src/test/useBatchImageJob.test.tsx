import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaLibraryBatchOperation } from "../types";
import {
  useBatchImageJob,
  type BatchJobConfig,
} from "../hooks/useBatchImageJob";

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const config: BatchJobConfig<string[]> = {
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

beforeEach(() => invokeMock.mockReset().mockResolvedValue(undefined));

describe("useBatchImageJob Rust projection", () => {
  it("starts estimation with the authoritative session identity", () => {
    const { result } = renderHook(() =>
      useBatchImageJob(config, { sessionId: 12 }),
    );
    act(() => result.current.actions.start("/folder", ["a.jpg"]));
    expect(invokeMock).toHaveBeenCalledWith("estimate_cmd", {
      folderPath: "/folder",
      relPaths: ["a.jpg"],
      sessionId: 12,
    });
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
});
