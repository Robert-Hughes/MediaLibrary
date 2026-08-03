import { isPromiseLike } from "./utils/promiseLike";

export interface SessionDelta {
  sessionId: number;
  revision: number;
  apply: () => void | Promise<void>;
}

export interface SessionDeltaCoordinatorOptions {
  getActiveSessionId: () => number;
  getCurrentRevision: () => number;
  setCurrentRevision: (revision: number) => void;
  refreshSnapshot: () => Promise<void>;
  isCancelled: () => boolean;
  onError: (error: unknown) => void;
}

export interface SessionDeltaCoordinator {
  enqueue: (delta: SessionDelta) => Promise<void>;
  enqueueSnapshot: (revision: number, apply: () => void | Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}

interface QueuedDelta {
  delta?: SessionDelta;
  snapshot?: { revision: number; apply: () => void | Promise<void> };
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
      return refresh()
        .then(() => {
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
    enqueueSnapshot: (revision, apply) =>
      new Promise<void>((resolve, reject) => {
        queue.push({ snapshot: { revision, apply }, resolve, reject });
        drain();
      }),
    refresh,
  };
}
