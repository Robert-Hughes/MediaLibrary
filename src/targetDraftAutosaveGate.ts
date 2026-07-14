export interface TargetDraftAutosaveSuspensionV5 {
  readonly token: symbol;
  release(): void;
}

export class TargetDraftAutosaveAlreadySuspendedError extends Error {
  constructor() {
    super("Schema-v5 target draft autosave is already suspended");
    this.name = "TargetDraftAutosaveAlreadySuspendedError";
  }
}

/**
 * Inactive ownership gate for a future target-draft autosave subscriber.
 * The gate coordinates ownership only and performs no persistence itself.
 */
export class TargetDraftAutosaveGateV5 {
  private activeToken: symbol | null = null;

  trySuspend(): TargetDraftAutosaveSuspensionV5 {
    if (this.activeToken !== null) {
      throw new TargetDraftAutosaveAlreadySuspendedError();
    }

    const token = Symbol("target-draft-autosave-suspension-v5");
    this.activeToken = token;
    let released = false;

    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        if (this.activeToken === token) this.activeToken = null;
      },
    };
  }

  isSuppressed(): boolean {
    return this.activeToken !== null;
  }
}
