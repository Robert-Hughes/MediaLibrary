/**
 * Runs at most one async operation at a time and retains only the newest
 * pending value while that operation is in flight or throttled.
 */
export class CoalescingAsyncQueue<T> {
  private pending: T | null = null;
  private running = false;
  private flushRequested = false;
  private lastRunStartedAt: number | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private finishDelay: (() => void) | null = null;
  private idleWaiters: Array<() => void> = [];
  private readonly minIntervalMs: number;

  constructor(
    private readonly run: (value: T) => Promise<void>,
    private readonly onError: (error: unknown, value: T) => void,
    options: { minIntervalMs?: number } = {},
  ) {
    const minIntervalMs = options.minIntervalMs ?? 0;
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError(
        "minIntervalMs must be a finite non-negative number",
      );
    }
    this.minIntervalMs = minIntervalMs;
  }

  schedule(value: T): void {
    this.pending = value;
    if (!this.running) void this.drain();
  }

  async flush(): Promise<void> {
    if (!this.running && this.pending === null) return;
    this.flushRequested = true;
    this.finishDelay?.();
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending !== null) {
      const throttleDelay = this.throttleDelay();
      if (throttleDelay) await throttleDelay;
      const value = this.pending;
      this.pending = null;
      this.lastRunStartedAt = Date.now();
      try {
        await this.run(value);
      } catch (error) {
        try {
          this.onError(error, value);
        } catch {
          // Error reporting must not strand a newer pending value.
        }
      }
    }
    this.running = false;
    this.flushRequested = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private throttleDelay(): Promise<void> | null {
    if (
      this.flushRequested ||
      this.lastRunStartedAt === null ||
      this.minIntervalMs === 0
    ) {
      return null;
    }
    const remainingMs =
      this.minIntervalMs - (Date.now() - this.lastRunStartedAt);
    if (remainingMs <= 0) return null;

    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (this.delayTimer !== null) clearTimeout(this.delayTimer);
        this.delayTimer = null;
        this.finishDelay = null;
        resolve();
      };
      this.finishDelay = finish;
      this.delayTimer = setTimeout(finish, remainingMs);
    });
  }
}
