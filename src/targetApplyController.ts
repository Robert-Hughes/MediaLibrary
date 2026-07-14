import type {
  ApplyEditsV5StartedPayload,
  MetadataApplyEditsProgressPayloadV5,
  MetadataApplyEditsResultV5,
} from "./types";
import {
  applyTargetApplyFileResultV5,
  applyTargetApplyResultV5,
  type TargetApplyFileApplicationV5,
  type TargetApplyResultApplicationV5,
  type TargetApplyResultStores,
} from "./targetApplyResults";
import {
  applyTargetDraftEditsV5,
  cancelTargetApplyV5,
  subscribeTargetApplyV5Events,
  type TargetApplyTauriApi,
} from "./targetApplyTauri";
import type { TargetDraftAutosaveGateV5 } from "./targetDraftAutosaveGate";

const PROGRESS_EVENT = "apply_metadata_edits_v5_progress";

export interface TargetApplyControllerDependenciesV5 {
  api: TargetApplyTauriApi;
  stores: TargetApplyResultStores;
  autosaveGate: TargetDraftAutosaveGateV5;
}

export interface TargetApplyControllerProtocolErrorV5 {
  eventName: string;
  error: Error;
  rawPayload: unknown;
}

export interface TargetApplyControllerApplicationErrorV5 {
  eventName: string;
  error: Error;
  rawPayload: unknown;
}

export interface TargetApplyControllerRunResultV5 {
  commandResult: MetadataApplyEditsResultV5;
  application: TargetApplyResultApplicationV5;
  protocolErrors: TargetApplyControllerProtocolErrorV5[];
  progressApplicationErrors: TargetApplyControllerApplicationErrorV5[];
}

export type TargetApplyControllerStateV5 =
  | { status: "idle" }
  | {
      status: "running";
      total: number | null;
      current: number;
      currentFile: string | null;
      cancelling: boolean;
      protocolErrorCount: number;
      progressApplicationErrorCount: number;
    };

export interface TargetApplyControllerCallbacksV5 {
  onStarted?: (payload: ApplyEditsV5StartedPayload) => void;
  onProgress?: (
    payload: MetadataApplyEditsProgressPayloadV5,
    application: TargetApplyFileApplicationV5,
  ) => void;
  onProtocolError?: (error: TargetApplyControllerProtocolErrorV5) => void;
  onProgressApplicationError?: (
    error: TargetApplyControllerApplicationErrorV5,
  ) => void;
  onFinalApplied?: (
    result: MetadataApplyEditsResultV5,
    application: TargetApplyResultApplicationV5,
  ) => void;
}

export class TargetApplyControllerBusyError extends Error {
  constructor() {
    super("A schema-v5 target apply is already owned by this controller");
    this.name = "TargetApplyControllerBusyError";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function statesEqual(
  left: TargetApplyControllerStateV5,
  right: TargetApplyControllerStateV5,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "idle" || right.status === "idle") return true;
  return (
    left.total === right.total &&
    left.current === right.current &&
    left.currentFile === right.currentFile &&
    left.cancelling === right.cancelling &&
    left.protocolErrorCount === right.protocolErrorCount &&
    left.progressApplicationErrorCount === right.progressApplicationErrorCount
  );
}

function cloneState(
  state: TargetApplyControllerStateV5,
): TargetApplyControllerStateV5 {
  return { ...state };
}

/**
 * Sole production coordinator for the complete frontend schema-v5 apply
 * protocol. Versioned backend events carry no operation ID, so callers must
 * share one controller instance.
 */
export class TargetApplyControllerV5 {
  private state: TargetApplyControllerStateV5 = { status: "idle" };
  private readonly listeners = new Set<
    (state: TargetApplyControllerStateV5) => void
  >();
  private activeRunToken: symbol | null = null;
  private cancellationRequest: Promise<void> | null = null;

  constructor(
    private readonly dependencies: TargetApplyControllerDependenciesV5,
    private readonly callbacks: TargetApplyControllerCallbacksV5 = {},
  ) {}

  getState(): TargetApplyControllerStateV5 {
    return cloneState(this.state);
  }

  subscribe(
    listener: (state: TargetApplyControllerStateV5) => void,
  ): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  async run(
    folderPath: string,
    relativePaths: string[],
  ): Promise<TargetApplyControllerRunResultV5> {
    if (this.activeRunToken !== null) {
      throw new TargetApplyControllerBusyError();
    }

    const runToken = Symbol("target-apply-controller-run-v5");
    this.activeRunToken = runToken;
    const protocolErrors: TargetApplyControllerProtocolErrorV5[] = [];
    const progressApplicationErrors: TargetApplyControllerApplicationErrorV5[] =
      [];
    let acceptEvents = true;
    let acceptProgress = true;
    let suspension: ReturnType<TargetDraftAutosaveGateV5["trySuspend"]> | null =
      null;
    let cleanup: (() => void) | null = null;
    let primaryError: unknown;
    let cleanupError: unknown;
    let hasPrimaryError = false;
    let hasCleanupError = false;
    let completed: TargetApplyControllerRunResultV5 | undefined;

    try {
      suspension = this.dependencies.autosaveGate.trySuspend();
      this.setState({
        status: "running",
        total: null,
        current: 0,
        currentFile: null,
        cancelling: false,
        protocolErrorCount: 0,
        progressApplicationErrorCount: 0,
      });

      cleanup = await subscribeTargetApplyV5Events(this.dependencies.api, {
        onStarted: (payload) => {
          if (!this.isAccepting(runToken, acceptEvents)) return;
          this.updateRunningState({
            total: payload.total,
            current: 0,
            currentFile: null,
          });
          this.callSafely("onStarted", () =>
            this.callbacks.onStarted?.(payload),
          );
        },
        onProgress: (payload) => {
          if (!this.isAccepting(runToken, acceptEvents) || !acceptProgress) {
            return;
          }
          let application: TargetApplyFileApplicationV5;
          try {
            application = applyTargetApplyFileResultV5(
              payload.result,
              this.dependencies.stores,
            );
          } catch (error) {
            const record: TargetApplyControllerApplicationErrorV5 = {
              eventName: PROGRESS_EVENT,
              error: asError(error),
              rawPayload: payload,
            };
            progressApplicationErrors.push(record);
            this.updateRunningState({
              progressApplicationErrorCount: progressApplicationErrors.length,
            });
            this.callSafely("onProgressApplicationError", () =>
              this.callbacks.onProgressApplicationError?.(record),
            );
            return;
          }

          this.updateRunningState({
            current: payload.current,
            total: payload.total,
            currentFile: payload.result.relative_path,
          });
          this.callSafely("onProgress", () =>
            this.callbacks.onProgress?.(payload, application),
          );
        },
        onProtocolError: (error, eventName, rawPayload) => {
          if (!this.isAccepting(runToken, acceptEvents)) return;
          const record: TargetApplyControllerProtocolErrorV5 = {
            eventName,
            error,
            rawPayload,
          };
          protocolErrors.push(record);
          this.updateRunningState({
            protocolErrorCount: protocolErrors.length,
          });
          this.callSafely("onProtocolError", () =>
            this.callbacks.onProtocolError?.(record),
          );
        },
      });

      const commandResult = await applyTargetDraftEditsV5(
        this.dependencies.api,
        folderPath,
        relativePaths,
      );
      acceptProgress = false;
      acceptEvents = false;
      const application = applyTargetApplyResultV5(
        commandResult,
        this.dependencies.stores,
      );
      this.callSafely("onFinalApplied", () =>
        this.callbacks.onFinalApplied?.(commandResult, application),
      );
      completed = {
        commandResult,
        application,
        protocolErrors,
        progressApplicationErrors,
      };
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
      acceptProgress = false;
      acceptEvents = false;
    } finally {
      if (cleanup !== null) {
        try {
          cleanup();
        } catch (error) {
          cleanupError = error;
          hasCleanupError = true;
        }
      }
      suspension?.release();
      if (this.activeRunToken === runToken) this.activeRunToken = null;
      this.cancellationRequest = null;
      this.setState({ status: "idle" });
    }

    if (hasPrimaryError) {
      if (hasCleanupError) {
        console.error(
          "[metadata] Failed to clean up schema-v5 apply listeners after an earlier failure",
          cleanupError,
        );
      }
      throw primaryError;
    }
    if (hasCleanupError) throw cleanupError;
    return completed!;
  }

  cancel(): Promise<void> {
    if (this.activeRunToken === null) return Promise.resolve();
    if (this.cancellationRequest !== null) return this.cancellationRequest;

    const runToken = this.activeRunToken;
    this.updateRunningState({ cancelling: true });
    const request = cancelTargetApplyV5(this.dependencies.api).catch(
      (error: unknown) => {
        if (this.activeRunToken === runToken) {
          this.updateRunningState({ cancelling: false });
          if (this.cancellationRequest === request) {
            this.cancellationRequest = null;
          }
        }
        throw error;
      },
    );
    this.cancellationRequest = request;
    return request;
  }

  private isAccepting(runToken: symbol, acceptEvents: boolean): boolean {
    return acceptEvents && this.activeRunToken === runToken;
  }

  private updateRunningState(
    updates: Partial<
      Omit<
        Extract<TargetApplyControllerStateV5, { status: "running" }>,
        "status"
      >
    >,
  ): void {
    if (this.state.status !== "running") return;
    this.setState({ ...this.state, ...updates });
  }

  private setState(next: TargetApplyControllerStateV5): void {
    if (statesEqual(this.state, next)) return;
    this.state = cloneState(next);
    for (const listener of this.listeners) {
      try {
        listener(cloneState(this.state));
      } catch (error) {
        console.error(
          "[metadata] Schema-v5 apply state listener failed",
          error,
        );
      }
    }
  }

  private callSafely(name: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error(
        `[metadata] Schema-v5 apply callback ${name} failed`,
        error,
      );
    }
  }
}
