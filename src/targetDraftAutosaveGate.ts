export interface TargetDraftAutosaveSuspension {
  readonly token: symbol;
  release(): void;
}

export class TargetDraftAutosaveAlreadySuspendedError extends Error {
  constructor() {
    super("Target-aware target draft autosave is already suspended");
    this.name = "TargetDraftAutosaveAlreadySuspendedError";
  }
}

/** Production ownership gate between controller snapshots and UI autosave. */
export class TargetDraftAutosaveGate {
  private activeToken: symbol | null = null;

  trySuspend(): TargetDraftAutosaveSuspension {
    if (this.activeToken !== null) {
      throw new TargetDraftAutosaveAlreadySuspendedError();
    }

    const token = Symbol("target-draft-autosave-suspension");
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
