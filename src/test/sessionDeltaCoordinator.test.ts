import { describe, expect, it, vi } from "vitest";
import { createSessionDeltaCoordinator } from "../sessionDeltaCoordinator";

describe("createSessionDeltaCoordinator", () => {
  it("yields between bounded slices without reordering or consuming queued revisions", async () => {
    let revision = 0;
    let clock = 0;
    let releaseFirst!: () => void;
    let resume!: () => void;
    const order: number[] = [];
    const yieldToBrowser = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 1,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {}),
      isCancelled: () => false,
      onError: vi.fn(),
      now: () => clock,
      yieldToBrowser,
    });
    const first = coordinator.enqueue({
      sessionId: 1,
      revision: 1,
      apply: () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    });
    const remaining = [2, 3, 4].map((next) =>
      coordinator.enqueue({
        sessionId: 1,
        revision: next,
        apply: () => {
          order.push(next);
          clock += 4;
        },
      }),
    );
    releaseFirst();
    await vi.waitFor(() => expect(yieldToBrowser).toHaveBeenCalledOnce());
    expect(order).toEqual([2, 3]);
    expect(revision).toBe(3);
    resume();
    await Promise.all([first, ...remaining]);
    expect(order).toEqual([2, 3, 4]);
    expect(revision).toBe(4);
  });

  it("discards the old session's backlog after yielding during replacement", async () => {
    let activeSession = 1;
    let revision = 0;
    let clock = 0;
    let releaseFirst!: () => void;
    let resume!: () => void;
    const staleApply = vi.fn();
    const yieldToBrowser = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => activeSession,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {}),
      isCancelled: () => false,
      onError: vi.fn(),
      now: () => clock,
      yieldToBrowser,
    });
    const first = coordinator.enqueue({
      sessionId: 1,
      revision: 1,
      apply: () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    });
    const stale = coordinator.enqueue({
      sessionId: 1,
      revision: 2,
      apply: staleApply,
    });
    clock = 8;
    releaseFirst();
    await vi.waitFor(() => expect(yieldToBrowser).toHaveBeenCalledOnce());
    activeSession = 2;
    revision = 0;
    const currentApply = vi.fn();
    const current = coordinator.enqueue({
      sessionId: 2,
      revision: 1,
      apply: currentApply,
    });
    resume();
    await Promise.all([first, stale, current]);
    expect(staleApply).not.toHaveBeenCalled();
    expect(currentApply).toHaveBeenCalledOnce();
    expect(revision).toBe(1);
  });

  it("commits a revision only after asynchronous application succeeds", async () => {
    let revision = 4;
    let resolveApply!: () => void;
    const apply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApply = resolve;
        }),
    );
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 7,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {}),
      isCancelled: () => false,
      onError: vi.fn(),
    });

    const pending = coordinator.enqueue({ sessionId: 7, revision: 5, apply });
    await Promise.resolve();
    expect(apply).toHaveBeenCalledOnce();
    expect(revision).toBe(4);

    resolveApply();
    await pending;
    expect(revision).toBe(5);
  });

  it("serialises deltas so later revisions cannot overtake earlier work", async () => {
    let revision = 10;
    let releaseFirst!: () => void;
    const order: string[] = [];
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 3,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {}),
      isCancelled: () => false,
      onError: vi.fn(),
    });

    const first = coordinator.enqueue({
      sessionId: 3,
      revision: 11,
      apply: async () => {
        order.push("first-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first-end");
      },
    });
    const second = coordinator.enqueue({
      sessionId: 3,
      revision: 12,
      apply: () => {
        order.push("second");
      },
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(revision).toBe(12);
  });

  it("shares one recovery snapshot request across concurrent callers", async () => {
    let resolveRefresh!: () => void;
    const refreshSnapshot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 1,
      getCurrentRevision: () => 1,
      setCurrentRevision: vi.fn(),
      refreshSnapshot,
      isCancelled: () => false,
      onError: vi.fn(),
    });

    const first = coordinator.refresh();
    const second = coordinator.refresh();
    expect(first).toBe(second);
    expect(refreshSnapshot).toHaveBeenCalledOnce();

    resolveRefresh();
    await Promise.all([first, second]);
  });

  it("recovers after a failed projection without consuming its revision", async () => {
    let revision = 2;
    const refreshSnapshot = vi.fn(async () => {});
    const onError = vi.fn();
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 9,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot,
      isCancelled: () => false,
      onError,
    });

    await coordinator.enqueue({
      sessionId: 9,
      revision: 3,
      apply: () => {
        throw new Error("projection failed");
      },
    });

    expect(revision).toBe(2);
    expect(refreshSnapshot).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "projection failed" }),
    );
  });
  it("reports a failed gap refresh without rejecting or advancing", async () => {
    let revision = 2;
    const refreshError = new Error("snapshot unavailable");
    const onError = vi.fn();
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 9,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {
        throw refreshError;
      }),
      isCancelled: () => false,
      onError,
    });

    await expect(
      coordinator.enqueue({ sessionId: 9, revision: 4, apply: vi.fn() }),
    ).resolves.toBeUndefined();
    expect(revision).toBe(2);
    expect(onError).toHaveBeenCalledWith(refreshError);
  });

  it("reports the exact delta gap and the revision installed by recovery", async () => {
    let revision = 6;
    const diagnostics = vi.fn();
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 4,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {
        revision = 9;
      }),
      isCancelled: () => false,
      onError: vi.fn(),
      onDiagnostic: diagnostics,
    });

    await coordinator.enqueue({
      sessionId: 4,
      revision: 8,
      source: "metadata",
      apply: vi.fn(),
    });

    expect(diagnostics).toHaveBeenNthCalledWith(1, {
      kind: "delta-gap",
      source: "metadata",
      sessionId: 4,
      currentRevision: 6,
      expectedRevision: 7,
      receivedRevision: 8,
      queuedItems: 0,
    });
    expect(diagnostics).toHaveBeenNthCalledWith(2, {
      kind: "gap-recovery-complete",
      source: "metadata",
      sessionId: 4,
      currentRevision: 6,
      expectedRevision: 7,
      receivedRevision: 8,
      recoveredRevision: 9,
      queuedItems: 0,
    });
  });

  it("reports an authoritative snapshot that jumps revisions", async () => {
    let revision = 3;
    const diagnostics = vi.fn();
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 2,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {}),
      isCancelled: () => false,
      onError: vi.fn(),
      onDiagnostic: diagnostics,
    });

    await coordinator.enqueueSnapshot(
      7,
      () => {
        revision = 7;
      },
      "session-changed",
    );

    expect(diagnostics).toHaveBeenCalledWith({
      kind: "snapshot-jump",
      source: "session-changed",
      sessionId: 2,
      currentRevision: 3,
      expectedRevision: 4,
      receivedRevision: 7,
      queuedItems: 0,
    });
  });

  it("serialises a newer full snapshot behind asynchronous delta projection", async () => {
    let revision = 0;
    let releaseDelta!: () => void;
    const order: string[] = [];
    const coordinator = createSessionDeltaCoordinator({
      getActiveSessionId: () => 1,
      getCurrentRevision: () => revision,
      setCurrentRevision: (next) => {
        revision = next;
      },
      refreshSnapshot: vi.fn(async () => {}),
      isCancelled: () => false,
      onError: vi.fn(),
    });

    const delta = coordinator.enqueue({
      sessionId: 1,
      revision: 1,
      apply: async () => {
        order.push("delta-start");
        await new Promise<void>((resolve) => {
          releaseDelta = resolve;
        });
        order.push("delta-end");
      },
    });
    const snapshot = coordinator.enqueueSnapshot(2, () => {
      order.push("snapshot");
      revision = 2;
    });

    await Promise.resolve();
    expect(order).toEqual(["delta-start"]);
    releaseDelta();
    await Promise.all([delta, snapshot]);

    expect(order).toEqual(["delta-start", "delta-end", "snapshot"]);
    expect(revision).toBe(2);
  });
});
