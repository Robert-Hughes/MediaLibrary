/**
 * Runs at most one async operation at a time and retains only the newest
 * pending value while that operation is in flight.
 */
export class CoalescingAsyncQueue<T> {
  private pending: T | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly run: (value: T) => Promise<void>,
    private readonly onError: (error: unknown, value: T) => void,
  ) {}

  schedule(value: T): void {
    this.pending = value;
    if (!this.running) void this.drain();
  }

  async flush(): Promise<void> {
    if (!this.running && this.pending === null) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending !== null) {
      const value = this.pending;
      this.pending = null;
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
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
