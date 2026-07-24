import { describe, expect, it, vi } from "vitest";
import { CoalescingAsyncQueue } from "../coalescingAsyncQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CoalescingAsyncQueue", () => {
  it("runs one operation at a time and keeps only the newest pending value", async () => {
    const first = deferred();
    const second = deferred();
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async (value: number) => {
      started.push(value);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await (value === 1 ? first.promise : second.promise);
      active -= 1;
    });
    const queue = new CoalescingAsyncQueue(run, vi.fn());

    queue.schedule(1);
    queue.schedule(2);
    queue.schedule(3);
    expect(started).toEqual([1]);

    first.resolve();
    await vi.waitFor(() => expect(started).toEqual([1, 3]));
    second.resolve();
    await queue.flush();

    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("continues with the newest value after a failure", async () => {
    const first = deferred();
    const errors: Array<{ error: unknown; value: number }> = [];
    const completed: number[] = [];
    const queue = new CoalescingAsyncQueue<number>(
      async (value) => {
        if (value === 1) await first.promise;
        completed.push(value);
      },
      (error, value) => errors.push({ error, value }),
    );

    queue.schedule(1);
    queue.schedule(2);
    const failure = new Error("save failed");
    first.reject(failure);
    await queue.flush();

    expect(completed).toEqual([2]);
    expect(errors).toEqual([{ error: failure, value: 1 }]);
  });

  it("flush waits for both the active and pending operations", async () => {
    const first = deferred();
    const second = deferred();
    const queue = new CoalescingAsyncQueue<number>(
      (value) => (value === 1 ? first.promise : second.promise),
      vi.fn(),
    );

    queue.schedule(1);
    queue.schedule(2);
    let flushed = false;
    const flush = queue.flush().then(() => {
      flushed = true;
    });

    first.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);
    second.resolve();
    await flush;
    expect(flushed).toBe(true);
  });
});
