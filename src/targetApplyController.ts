import type {
  MetadataApplyFileResult,
  MetadataApplyResult,
  MetadataApplyStreamMessage,
  MetadataApplySummary,
} from "./types";
import {
  applyTargetDraftEdits,
  cancelTargetApply,
  type TargetApplyTauriApi,
} from "./targetApplyTauri";

export interface TargetApplyFileApplication {
  relativePath: string;
  draftsChanged: false;
  occurrencesChanged: false;
}

const STREAM_EVENT = "metadata_apply_stream";
const MAX_RETAINED_CONTROLLER_ERRORS = 20;
const FALLBACK_BATCH_SIZE = 100;
let nextOperationId = 0;

type ProgressBatchMessage = Extract<
  MetadataApplyStreamMessage,
  { kind: "progress_batch" }
>;
export interface TargetApplyControllerDependencies {
  api: TargetApplyTauriApi;
}

export interface TargetApplyControllerProtocolError {
  eventName: string;
  operationId: string;
  error: Error;
}

export interface TargetApplyControllerApplicationError {
  eventName: string;
  operationId: string;
  error: Error;
  relativePaths: string[];
}

export interface TargetApplyControllerApplication {
  processed: number;
  draftsChanged: number;
  occurrencesChanged: number;
}

export interface TargetApplyControllerRunResult {
  commandResult: MetadataApplyResult;
  application: TargetApplyControllerApplication;
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
  onStarted?: (total: number) => void;
  onProgressBatch?: (
    payload: ProgressBatchMessage,
    applications: readonly TargetApplyFileApplication[],
  ) => void;
  onProtocolError?: (error: TargetApplyControllerProtocolError) => void;
  onProgressApplicationError?: (
    error: TargetApplyControllerApplicationError,
  ) => void;
  onFileError?: (relativePath: string, error: string) => void;
  onFileWarning?: (relativePath: string, warning: string) => void;
  onFinalApplied?: (
    result: MetadataApplyResult,
    application: TargetApplyControllerApplication,
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

function summariesEqual(
  left: MetadataApplySummary,
  right: MetadataApplySummary,
): boolean {
  return (
    left.requested === right.requested &&
    left.selected === right.selected &&
    left.completed === right.completed &&
    left.applied === right.applied &&
    left.failed === right.failed &&
    left.warning_count === right.warning_count &&
    left.cancelled === right.cancelled &&
    left.aborted === right.aborted &&
    left.abort_reason === right.abort_reason &&
    left.delivery_failure_count === right.delivery_failure_count
  );
}

function pushBounded<T>(values: T[], value: T): void {
  if (values.length === MAX_RETAINED_CONTROLLER_ERRORS) values.shift();
  values.push(value);
}

/** Sole frontend owner of the command-scoped target-aware Apply stream. */
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
    relativePaths?: readonly string[],
  ): Promise<TargetApplyControllerRunResult> {
    if (this.activeRunToken !== null) {
      throw new TargetApplyControllerBusyError();
    }

    const runToken = Symbol("target-apply-controller-run");
    const operationId = `target-apply-${++nextOperationId}`;
    this.activeRunToken = runToken;
    const protocolErrors: TargetApplyControllerProtocolError[] = [];
    const progressApplicationErrors: TargetApplyControllerApplicationError[] =
      [];
    let acceptMessages = true;
    let lastSequence = 0;
    let streamCurrent = 0;
    let streamTotal: number | null = null;
    let streamSummary: MetadataApplySummary | null = null;
    let fileFailureCount = 0;
    let retry: {
      message: ProgressBatchMessage;
      results: MetadataApplyFileResult[];
    } | null = null;
    const application: TargetApplyControllerApplication = {
      processed: 0,
      draftsChanged: 0,
      occurrencesChanged: 0,
    };

    const recordProtocolError = (error: unknown) => {
      const record: TargetApplyControllerProtocolError = {
        eventName: STREAM_EVENT,
        operationId,
        error: asError(error),
      };
      pushBounded(protocolErrors, record);
      this.updateRunningState({ protocolErrorCount: protocolErrors.length });
      this.callSafely("onProtocolError", () =>
        this.callbacks.onProtocolError?.(record),
      );
    };

    const recordApplicationError = (
      error: unknown,
      results: readonly MetadataApplyFileResult[],
    ) => {
      const record: TargetApplyControllerApplicationError = {
        eventName: STREAM_EVENT,
        operationId,
        error: asError(error),
        relativePaths: results.map((result) => result.relative_path),
      };
      pushBounded(progressApplicationErrors, record);
      this.updateRunningState({
        progressApplicationErrorCount: progressApplicationErrors.length,
      });
      this.callSafely("onProgressApplicationError", () =>
        this.callbacks.onProgressApplicationError?.(record),
      );
    };

    const presentDiagnostics = (
      results: readonly MetadataApplyFileResult[],
    ) => {
      for (const result of results) {
        if (result.error !== null) {
          this.callSafely("onFileError", () =>
            this.callbacks.onFileError?.(result.relative_path, result.error!),
          );
        }
        if (result.warning !== null) {
          this.callSafely("onFileWarning", () =>
            this.callbacks.onFileWarning?.(
              result.relative_path,
              result.warning!,
            ),
          );
        }
      }
    };

    const applyBatch = (
      message: ProgressBatchMessage,
      results: MetadataApplyFileResult[],
    ): boolean => {
      presentDiagnostics(results);
      const applications: TargetApplyFileApplication[] = results.map(
        (result) => ({
          relativePath: result.relative_path,
          draftsChanged: false,
          occurrencesChanged: false,
        }),
      );
      application.draftsChanged += applications.filter(
        (item) => item.draftsChanged,
      ).length;
      application.occurrencesChanged += applications.filter(
        (item) => item.occurrencesChanged,
      ).length;
      this.callSafely("onProgressBatch", () =>
        this.callbacks.onProgressBatch?.(message, applications),
      );
      return true;
    };

    try {
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

      const commandResult = await applyTargetDraftEdits(
        this.dependencies.api,
        folderPath,
        relativePaths,
        operationId,
        {
          onMessage: (message) => {
            if (!this.isAccepting(runToken, acceptMessages)) return;
            if (message.kind === "started") {
              if (streamTotal !== null) {
                recordProtocolError(
                  new Error("Duplicate Apply started message"),
                );
                return;
              }
              streamTotal = message.total;
              this.updateRunningState({
                total: message.total,
                current: 0,
                currentFile: null,
              });
              this.callSafely("onStarted", () =>
                this.callbacks.onStarted?.(message.total),
              );
              return;
            }

            if (message.kind === "complete") {
              streamSummary = message.summary;
              return;
            }

            if (streamTotal === null) {
              recordProtocolError(
                new Error("Apply progress arrived before the started message"),
              );
              return;
            }
            if (message.total !== streamTotal) {
              recordProtocolError(new Error("Apply progress total changed"));
              return;
            }
            if (message.sequence !== lastSequence + 1) {
              recordProtocolError(
                new Error("Apply progress sequence is not contiguous"),
              );
              return;
            }
            if (message.current !== streamCurrent + message.results.length) {
              recordProtocolError(
                new Error("Apply progress current is not contiguous"),
              );
              return;
            }

            lastSequence = message.sequence;
            streamCurrent = message.current;
            fileFailureCount += message.results.filter(
              (result) => result.error !== null,
            ).length;
            applyBatch(message, message.results);
            this.updateRunningState({
              current: message.current,
              total: message.total,
              currentFile:
                message.results[message.results.length - 1]?.relative_path ??
                null,
              fileFailureCount,
            });
          },
          onProtocolError: recordProtocolError,
          onMessageError: (error) => recordApplicationError(error, []),
        },
      );

      acceptMessages = false;
      if (
        streamSummary !== null &&
        !summariesEqual(streamSummary, commandResult.summary)
      ) {
        recordProtocolError(
          new Error("Stream completion summary differs from command result"),
        );
      }
      if (
        streamCurrent + commandResult.summary.delivery_failure_count !==
        commandResult.summary.completed
      ) {
        recordProtocolError(
          new Error(
            "Stream and undelivered counts do not cover completed files",
          ),
        );
      }

      for (
        let offset = 0;
        offset < commandResult.undelivered_files.length;
        offset += FALLBACK_BATCH_SIZE
      ) {
        const results = commandResult.undelivered_files.slice(
          offset,
          offset + FALLBACK_BATCH_SIZE,
        );
        fileFailureCount += results.filter(
          (result) => result.error !== null,
        ).length;
        const fallbackMessage: ProgressBatchMessage = {
          kind: "progress_batch",
          operation_id: operationId,
          sequence: ++lastSequence,
          current: Math.min(
            commandResult.summary.completed,
            streamCurrent + offset + results.length,
          ),
          total: commandResult.summary.selected,
          results,
        };
        applyBatch(fallbackMessage, results);
      }
      commandResult.undelivered_files.length = 0;

      const pendingRetry = retry as {
        message: ProgressBatchMessage;
        results: MetadataApplyFileResult[];
      } | null;
      if (pendingRetry !== null) {
        const pending = pendingRetry;
        retry = null;
        applyBatch(pending.message, pending.results);
      }

      application.processed = commandResult.summary.completed;
      this.updateRunningState({
        current: commandResult.summary.completed,
        total: commandResult.summary.selected,
        fileFailureCount: commandResult.summary.failed,
      });
      this.callSafely("onFinalApplied", () =>
        this.callbacks.onFinalApplied?.(commandResult, application),
      );
      return {
        commandResult,
        application,
        protocolErrors,
        progressApplicationErrors,
      };
    } finally {
      acceptMessages = false;
      retry = null;
      if (this.activeRunToken === runToken) this.activeRunToken = null;
      this.cancellationRequest = null;
      this.setState({ status: "idle" });
    }
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

  private isAccepting(runToken: symbol, acceptMessages: boolean): boolean {
    return acceptMessages && this.activeRunToken === runToken;
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
}
