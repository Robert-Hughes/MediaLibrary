import { isPromiseLike } from "./utils/promiseLike";

export interface SessionDelta {
  sessionId: number;
  revision: number;
  source?: string;
  apply: () => void | Promise<void>;
}

export interface SessionRevisionDiagnostic {
  kind: "delta-gap" | "gap-recovery-complete" | "snapshot-jump";
  source: string;
  sessionId: number;
  currentRevision: number;
  receivedRevision: number;
  expectedRevision: number;
  recoveredRevision?: number;
  queuedItems: number;
}

export interface SessionDeltaCoordinatorOptions {
  getActiveSessionId: () => number;
  getCurrentRevision: () => number;
  setCurrentRevision: (revision: number) => void;
  refreshSnapshot: () => Promise<void>;
  isCancelled: () => boolean;
  onError: (error: unknown) => void;
  onDiagnostic?: (diagnostic: SessionRevisionDiagnostic) => void;
}

export interface SessionDeltaCoordinator {
  enqueue: (delta: SessionDelta) => Promise<void>;
  enqueueSnapshot: (
    revision: number,
    apply: () => void | Promise<void>,
    source?: string,
  ) => Promise<void>;
  refresh: () => Promise<void>;
}

interface QueuedDelta {
  delta?: SessionDelta;
  snapshot?: {
    revision: number;
    source: string;
    apply: () => void | Promise<void>;
  };
  resolve: () => void;
  reject: (error: unknown) => void;
}

export function createSessionDeltaCoordinator(
  options: SessionDeltaCoordinatorOptions,
): SessionDeltaCoordinator {
  const queue: QueuedDelta[] = [];
  let running = false;
  let refreshInFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (refreshInFlight === null) {
      refreshInFlight = options.refreshSnapshot().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  };

  const commit = (delta: SessionDelta): void => {
    if (options.isCancelled()) return;
    if (delta.sessionId !== options.getActiveSessionId()) return;
    if (delta.revision === options.getCurrentRevision() + 1) {
      options.setCurrentRevision(delta.revision);
    }
  };

  const recover = async (error: unknown): Promise<void> => {
    try {
      await refresh();
    } catch (refreshError) {
      options.onError(refreshError);
    }
    options.onError(error);
  };

  const applyDelta = (delta: SessionDelta): void | Promise<void> => {
    try {
      const result = delta.apply();
      if (isPromiseLike(result)) {
        return Promise.resolve(result)
          .then(() => commit(delta))
          .catch(recover);
      }
      commit(delta);
    } catch (error) {
      return recover(error);
    }
  };

  const process = (delta: SessionDelta): void | Promise<void> => {
    if (options.isCancelled()) return;
    if (delta.sessionId !== options.getActiveSessionId()) return;
    if (delta.revision <= options.getCurrentRevision()) return;

    if (delta.revision !== options.getCurrentRevision() + 1) {
      const currentRevision = options.getCurrentRevision();
      const source = delta.source ?? "unknown";
      options.onDiagnostic?.({
        kind: "delta-gap",
        source,
        sessionId: delta.sessionId,
        currentRevision,
        receivedRevision: delta.revision,
        expectedRevision: currentRevision + 1,
        queuedItems: queue.length,
      });
      return refresh()
        .then(() => {
          const recoveredRevision = options.getCurrentRevision();
          options.onDiagnostic?.({
            kind: "gap-recovery-complete",
            source,
            sessionId: delta.sessionId,
            currentRevision,
            receivedRevision: delta.revision,
            expectedRevision: currentRevision + 1,
            recoveredRevision,
            queuedItems: queue.length,
          });
          if (options.isCancelled()) return;
          if (delta.sessionId !== options.getActiveSessionId()) return;
          if (delta.revision <= options.getCurrentRevision()) return;
          if (delta.revision !== options.getCurrentRevision() + 1) return;
          return applyDelta(delta);
        })
        .catch((error) => {
          options.onError(error);
        });
    }

    return applyDelta(delta);
  };

  const drain = (): void => {
    if (running) return;
    running = true;

    while (queue.length > 0) {
      const item = queue.shift()!;
      let result: void | Promise<void>;
      try {
        if (item.snapshot) {
          if (item.snapshot.revision <= options.getCurrentRevision()) {
            result = undefined;
          } else {
            const currentRevision = options.getCurrentRevision();
            if (item.snapshot.revision > currentRevision + 1) {
              options.onDiagnostic?.({
                kind: "snapshot-jump",
                source: item.snapshot.source,
                sessionId: options.getActiveSessionId(),
                currentRevision,
                receivedRevision: item.snapshot.revision,
                expectedRevision: currentRevision + 1,
                queuedItems: queue.length,
              });
            }
            result = item.snapshot.apply();
          }
        } else {
          result = process(item.delta!);
        }
      } catch (error) {
        item.reject(error);
        continue;
      }
      if (isPromiseLike(result)) {
        Promise.resolve(result)
          .then(item.resolve, item.reject)
          .finally(() => {
            running = false;
            drain();
          });
        return;
      }
      item.resolve();
    }

    running = false;
  };

  return {
    enqueue: (delta) =>
      new Promise<void>((resolve, reject) => {
        queue.push({ delta, resolve, reject });
        drain();
      }),
    enqueueSnapshot: (revision, apply, source = "unknown") =>
      new Promise<void>((resolve, reject) => {
        queue.push({ snapshot: { revision, source, apply }, resolve, reject });
        drain();
      }),
    refresh,
  };
}
