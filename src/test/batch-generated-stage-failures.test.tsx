import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  useBatchImageJob,
  type BatchJobConfig,
} from "../hooks/useBatchImageJob";
import type { SchemaMetadataEdit } from "../types";

let invokeMock: Mock<(...args: unknown[]) => Promise<unknown>>;
let listenMock: Mock<(...args: unknown[]) => Promise<() => void>>;
let handlers: Record<string, Array<(event: { payload: unknown }) => void>>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

interface Summary {
  count: number;
}

const config: BatchJobConfig<string[], never, Summary> = {
  eventPrefix: "stage",
  commands: { run: "run_cmd", cancel: "cancel_cmd" },
  buildRunArgs: (folderPath, relativePaths) => ({
    folderPath,
    relativePaths,
  }),
  totalItems: (relativePaths) => relativePaths.length,
  relativePaths: (relativePaths) => [...relativePaths],
  parseSummaryPayload: (raw) => raw as Summary,
};

const edits: SchemaMetadataEdit[] = [];

function emit(event: string, payload: unknown): void {
  for (const handler of handlers[event] ?? []) handler({ payload });
}

async function startRun(
  onApplyEdits: (
    relativePath: string,
    generated: SchemaMetadataEdit[],
  ) =>
    { kind: "success"; changed: boolean } | { kind: "failure"; reason: string },
  paths = ["a.jpg", "b.jpg"],
) {
  const hook = renderHook(() => useBatchImageJob(config, { onApplyEdits }));
  act(() => hook.result.current.actions.start("/photos", paths));
  await waitFor(() => expect(hook.result.current.open).toBe(true));
  await waitFor(() =>
    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining([
        "stage_started",
        "stage_progress",
        "stage_complete",
      ]),
    ),
  );
  act(() => hook.result.current.actions.confirm());
  return hook;
}

beforeEach(() => {
  handlers = {};
  invokeMock = vi.fn().mockResolvedValue(undefined);
  listenMock = vi.fn(async (event: unknown, handler: unknown) => {
    const name = String(event);
    (handlers[name] ??= []).push(
      handler as (event: { payload: unknown }) => void,
    );
    return () => {
      handlers[name] = handlers[name].filter(
        (candidate) => candidate !== handler,
      );
    };
  });
});

afterEach(() => vi.clearAllMocks());

describe("useBatchImageJob generated staging failures", () => {
  it("records frontend failure, continues later files, and preserves it at completion", async () => {
    const staged: string[] = [];
    const hook = await startRun((relativePath) => {
      staged.push(relativePath);
      return relativePath === "a.jpg"
        ? { kind: "failure", reason: "unsafe exact owner" }
        : { kind: "success", changed: true };
    });

    act(() => {
      emit("stage_started", { total: 2 });
      emit("stage_progress", {
        current: 1,
        total: 2,
        relativePath: "a.jpg",
        status: "ok",
        error: null,
        edits,
      });
      emit("stage_progress", {
        current: 2,
        total: 2,
        relativePath: "b.jpg",
        status: "ok",
        error: null,
        edits,
      });
      emit("stage_complete", {
        succeeded: ["a.jpg", "b.jpg"],
        failed: [],
        usageSummary: { count: 2 },
      });
    });

    expect(staged).toEqual(["a.jpg", "b.jpg"]);
    expect(hook.result.current.state.phase).toBe("done");
    expect(hook.result.current.state.succeeded).toEqual(["b.jpg"]);
    expect(hook.result.current.state.failures).toEqual([
      {
        relativePath: "a.jpg",
        kind: "draft_stage_failed",
        detail: "unsafe exact owner",
      },
    ]);
  });

  it("treats exact no-op staging as a successful processed file", async () => {
    const hook = await startRun(
      () => ({ kind: "success", changed: false }),
      ["noop.jpg"],
    );
    act(() => {
      emit("stage_progress", {
        current: 1,
        total: 1,
        relativePath: "noop.jpg",
        status: "ok",
        error: null,
        edits,
      });
      emit("stage_complete", {
        succeeded: ["noop.jpg"],
        failed: [],
        usageSummary: { count: 1 },
      });
    });
    expect(hook.result.current.state.succeeded).toEqual(["noop.jpg"]);
    expect(hook.result.current.state.failures).toEqual([]);
  });

  it("converts callback exceptions to one structured staging failure", async () => {
    const hook = await startRun(() => {
      throw new Error("callback exploded");
    }, ["bad.jpg"]);
    act(() => {
      const progress = {
        current: 1,
        total: 1,
        relativePath: "bad.jpg",
        status: "ok",
        error: null,
        edits,
      };
      emit("stage_progress", progress);
      emit("stage_progress", progress);
      emit("stage_complete", {
        succeeded: ["bad.jpg"],
        failed: [],
        usageSummary: { count: 1 },
      });
    });
    expect(hook.result.current.state.succeeded).toEqual([]);
    expect(hook.result.current.state.failures).toEqual([
      {
        relativePath: "bad.jpg",
        kind: "draft_stage_failed",
        detail: "callback exploded",
      },
    ]);
  });

  it("clears frontend staging state when the dialog closes and a new run starts", async () => {
    let fail = true;
    const hook = await startRun(
      () =>
        fail
          ? { kind: "failure", reason: "first run" }
          : { kind: "success", changed: true },
      ["photo.jpg"],
    );
    act(() => {
      emit("stage_progress", {
        current: 1,
        total: 1,
        relativePath: "photo.jpg",
        status: "ok",
        error: null,
        edits,
      });
      emit("stage_complete", {
        succeeded: ["photo.jpg"],
        failed: [],
        usageSummary: { count: 1 },
      });
    });
    expect(hook.result.current.state.failures).toHaveLength(1);

    act(() => hook.result.current.actions.close());
    fail = false;
    act(() => hook.result.current.actions.start("/photos", ["photo.jpg"]));
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    act(() => hook.result.current.actions.confirm());
    act(() => {
      emit("stage_progress", {
        current: 1,
        total: 1,
        relativePath: "photo.jpg",
        status: "ok",
        error: null,
        edits,
      });
      emit("stage_complete", {
        succeeded: ["photo.jpg"],
        failed: [],
        usageSummary: { count: 1 },
      });
    });
    expect(hook.result.current.state.failures).toEqual([]);
    expect(hook.result.current.state.succeeded).toEqual(["photo.jpg"]);
  });
});
