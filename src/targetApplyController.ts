import type {
  MetadataApplyStartedPayload,
  MetadataApplyProgressPayload,
  MetadataApplyResult,
  MetadataApplyFileResult,
} from "./types";
import {
  applyTargetApplyFileResult,
  applyTargetApplyResult,
  type TargetApplyFileApplication,
  type TargetApplyResultApplication,
  type TargetApplyResultStores,
} from "./targetApplyResults";
import {
  applyTargetDraftEdits,
  cancelTargetApply,
  subscribeTargetApplyEvents,
  type TargetApplyTauriApi,
} from "./targetApplyTauri";
import type { TargetDraftAutosaveGate } from "./targetDraftAutosaveGate";

const PROGRESS_EVENT = "apply_metadata_edits_progress";

export interface TargetApplyControllerDependencies {
  api: TargetApplyTauriApi;
  stores: TargetApplyResultStores;
  autosaveGate: TargetDraftAutosaveGate;
}

export interface TargetApplyControllerProtocolError {
  eventName: string;
  error: Error;
  rawPayload: unknown;
}

export interface TargetApplyControllerApplicationError {
  eventName: string;
  error: Error;
  rawPayload: unknown;
}

export interface TargetApplyControllerRunResult {
  commandResult: MetadataApplyResult;
  application: TargetApplyResultApplication;
  protocolErrors: TargetApplyControllerProtocolError[];
  progressApplicationErrors: TargetApplyControllerApplicationError[];
}

export type TargetApplyControllerState =
  | { status: "idle" }
  | {
      status: "running";
      total: number | null;
      current: number;
      currentFile: string | null;
      cancelling: boolean;
      protocolErrorCount: number;
      progressApplicationErrorCount: number;
      fileFailureCount: number;
    };

export interface TargetApplyControllerCallbacks {
  onStarted?: (payload: MetadataApplyStartedPayload) => void;
  onProgress?: (
    payload: MetadataApplyProgressPayload,
    application: TargetApplyFileApplication,
  ) => void;
  onProtocolError?: (error: TargetApplyControllerProtocolError) => void;
  onProgressApplicationError?: (
    error: TargetApplyControllerApplicationError,
  ) => void;
  onFileError?: (relativePath: string, error: string) => void;
  onFileWarning?: (relativePath: string, warning: string) => void;
  onFinalApplied?: (
    result: MetadataApplyResult,
    application: TargetApplyResultApplication,
  ) => void;
}

export class TargetApplyControllerBusyError extends Error {
  constructor() {
    super("A target-aware target apply is already owned by this controller");
    this.name = "TargetApplyControllerBusyError";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function statesEqual(
  left: TargetApplyControllerState,
  right: TargetApplyControllerState,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "idle" || right.status === "idle") return true;
  return (
    left.total === right.total &&
    left.current === right.current &&
    left.currentFile === right.currentFile &&
    left.cancelling === right.cancelling &&
    left.protocolErrorCount === right.protocolErrorCount &&
    left.progressApplicationErrorCount ===
      right.progressApplicationErrorCount &&
    left.fileFailureCount === right.fileFailureCount
  );
}

function cloneState(
  state: TargetApplyControllerState,
): TargetApplyControllerState {
  return { ...state };
}

/**
 * Sole production coordinator for the complete frontend target-aware apply
 * protocol. Versioned backend events carry no operation ID, so callers must
 * share one controller instance.
 */
export class TargetApplyController {
  private state: TargetApplyControllerState = { status: "idle" };
  private readonly listeners = new Set<
    (state: TargetApplyControllerState) => void
  >();
  private activeRunToken: symbol | null = null;
  private cancellationRequest: Promise<void> | null = null;

  constructor(
    private readonly dependencies: TargetApplyControllerDependencies,
    private readonly callbacks: TargetApplyControllerCallbacks = {},
  ) {}

  getState(): TargetApplyControllerState {
    return cloneState(this.state);
  }

  subscribe(listener: (state: TargetApplyControllerState) => void): () => void {
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
  ): Promise<TargetApplyControllerRunResult> {
    if (this.activeRunToken !== null) {
      throw new TargetApplyControllerBusyError();
    }

    const runToken = Symbol("target-apply-controller-run");
    this.activeRunToken = runToken;
    const protocolErrors: TargetApplyControllerProtocolError[] = [];
    const progressApplicationErrors: TargetApplyControllerApplicationError[] =
      [];
    const progressFailedFiles = new Set<string>();
    const presentedFileErrors = new Set<string>();
    const presentedFileWarnings = new Set<string>();
    let acceptEvents = true;
    let acceptProgress = true;
    let suspension: ReturnType<TargetDraftAutosaveGate["trySuspend"]> | null =
      null;
    let cleanup: (() => void) | null = null;
    let primaryError: unknown;
    let cleanupError: unknown;
    let hasPrimaryError = false;
    let hasCleanupError = false;
    let completed: TargetApplyControllerRunResult | undefined;

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
        fileFailureCount: 0,
      });

      cleanup = await subscribeTargetApplyEvents(this.dependencies.api, {
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
          if (payload.result.error !== null) {
            progressFailedFiles.add(payload.result.relative_path);
          }
          this.updateRunningState({
            current: payload.current,
            total: payload.total,
            currentFile: payload.result.relative_path,
            fileFailureCount: progressFailedFiles.size,
          });
          this.presentFileDiagnostics(
            payload.result,
            presentedFileErrors,
            presentedFileWarnings,
          );

          let application: TargetApplyFileApplication;
          try {
            application = applyTargetApplyFileResult(
              payload.result,
              this.dependencies.stores,
            );
          } catch (error) {
            const record: TargetApplyControllerApplicationError = {
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

          this.callSafely("onProgress", () =>
            this.callbacks.onProgress?.(payload, application),
          );
        },
        onProtocolError: (error, eventName, rawPayload) => {
          if (!this.isAccepting(runToken, acceptEvents)) return;
          const record: TargetApplyControllerProtocolError = {
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

      const commandResult = await applyTargetDraftEdits(
        this.dependencies.api,
        folderPath,
        relativePaths,
      );
      acceptProgress = false;
      acceptEvents = false;
      for (const file of commandResult.files) {
        if (file.error !== null) progressFailedFiles.add(file.relative_path);
        this.presentFileDiagnostics(
          file,
          presentedFileErrors,
          presentedFileWarnings,
        );
      }
      this.updateRunningState({ fileFailureCount: progressFailedFiles.size });
      const application = applyTargetApplyResult(
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
          "[metadata] Failed to clean up target-aware apply listeners after an earlier failure",
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
    const request = cancelTargetApply(this.dependencies.api).catch(
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
      Omit<Extract<TargetApplyControllerState, { status: "running" }>, "status">
    >,
  ): void {
    if (this.state.status !== "running") return;
    this.setState({ ...this.state, ...updates });
  }

  private setState(next: TargetApplyControllerState): void {
    if (statesEqual(this.state, next)) return;
    this.state = cloneState(next);
    for (const listener of this.listeners) {
      try {
        listener(cloneState(this.state));
      } catch (error) {
        console.error(
          "[metadata] Target-aware apply state listener failed",
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
        `[metadata] Target-aware apply callback ${name} failed`,
        error,
      );
    }
  }

  private presentFileDiagnostics(
    result: Pick<
      MetadataApplyFileResult,
      "relative_path" | "error" | "warning"
    >,
    presentedErrors: Set<string>,
    presentedWarnings: Set<string>,
  ): void {
    const relativePath = result.relative_path;
    if (result.error !== null) {
      const key = `${relativePath}\u0000${result.error}`;
      if (!presentedErrors.has(key)) {
        presentedErrors.add(key);
        this.callSafely("onFileError", () =>
          this.callbacks.onFileError?.(relativePath, result.error!),
        );
      }
    }
    if (result.warning !== null) {
      const key = `${relativePath}\u0000${result.warning}`;
      if (!presentedWarnings.has(key)) {
        presentedWarnings.add(key);
        this.callSafely("onFileWarning", () =>
          this.callbacks.onFileWarning?.(relativePath, result.warning!),
        );
      }
    }
  }
}
