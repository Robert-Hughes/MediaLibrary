/**
 * Generic projection and command-dispatch glue for backend-owned image jobs.
 *
 * Every such flow shares the same shape:
 *
 *   [estimating?] → awaiting-confirm → running → done
 *
 * Each job has its own estimate and summary payload, while lifecycle,
 * progress, failures, and retained inputs come from the Rust session snapshot.
 *
 * The hook is intentionally non-opinionated about *which* fields the
 * estimate or summary objects carry — it stores whatever the backend
 * emits and the adapter renders. The shared piece is the lifecycle:
 *
 *  - opens on `start`, never closes between phases,
 *  - projects durable progress, failures, and staged-draft outcomes from Rust,
 *  - signals cancellation via the configured cancel command,
 *  - releases all event subscriptions on close.
 *
 * The describe hook (`useDescribeImages`) and geocode hook
 * (`useGeocodeImages`) are thin adapters around this primitive.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BatchJobFailureKind,
  MediaLibraryBatchOperation,
  MediaLibrarySessionSnapshot,
} from "../types";

export type BatchJobPhase =
  "estimating" | "awaiting-confirm" | "running" | "done";

export type { BatchJobFailureKind } from "../types";

export interface BatchJobFailure {
  relativePath: string;
  kind: BatchJobFailureKind;
  detail: string;
}

interface BatchJobProgress {
  current: number;
  total: number;
  relativePath: string;
  status: string;
  error?: string;
}

/**
 * Generic state shape for any batch job phase machine.
 *
 * `E` is the job-specific estimate payload (e.g. token totals + cost
 * for describe). Set to `null` for jobs that have no estimate phase.
 *
 * `S` is the job-specific final summary payload (token usage for
 * describe, source-counter breakdown for geocode).
 */
export interface BatchJobState<E, S> {
  phase: BatchJobPhase;
  total: number;
  current: number;
  currentFile: string | null;
  cancelling: boolean;
  failures: BatchJobFailure[];
  succeeded: string[];
  estimate: E | null;
  estimateError: string | null;
  summary: S | null;
  /** Original rel-paths the dialog was opened for — used for confirm. */
  relPaths: string[];
}

function initialState<E, S>(): BatchJobState<E, S> {
  return {
    phase: "estimating",
    total: 0,
    current: 0,
    currentFile: null,
    cancelling: false,
    failures: [],
    succeeded: [],
    estimate: null,
    estimateError: null,
    summary: null,
    relPaths: [],
  };
}

export interface BatchJobActions<StartArgs> {
  /** Begin the flow with caller-supplied start arguments. */
  start: (folderPath: string, startArgs: StartArgs) => void;
  /** User clicked "Confirm and run" on the awaiting-confirm phase. */
  confirm: () => void;
  /** User clicked "Cancel" — works in any phase before `done`. */
  cancel: () => void;
  /** User clicked "Close" on the done panel. */
  close: () => void;
}

/**
 * Configuration for one job's adapter. Adapters supply command names and
 * transient input mapping until Rust accepts and retains the job.
 *
 * Commands:
 *  - `estimate`  : Tauri command that creates the durable operation and may
 *                  also perform a cost preflight.
 *  - `run`       : Tauri command name for the main loop.
 *  - `cancel`    : Tauri command name for the cancel signal.
 *
 * Once accepted, the operation identity and retained request are Rust-owned;
 * `buildRecoveryRunArgs` supports confirming that operation after remount.
 */
export interface BatchJobConfig<StartArgs> {
  /** Key of the authoritative operation in the Rust session snapshot. */
  operationKind: string;
  /** Consume `${operationKind}_progress_batch` instead of per-item events. */
  batchedProgress?: boolean;
  commands: {
    estimate?: string;
    run: string;
    cancel: string;
  };
  /** Build the args object passed to `invoke(commands.estimate, …)`. */
  buildEstimateArgs?: (
    folderPath: string,
    startArgs: StartArgs,
  ) => Record<string, unknown>;
  /** Build the args object passed to `invoke(commands.run, …)`. */
  buildRunArgs: (
    folderPath: string,
    startArgs: StartArgs,
  ) => Record<string, unknown>;
  /** Arguments still needed when a retained Rust operation is confirmed after remount. */
  buildRecoveryRunArgs?: () => Record<string, unknown>;
  /** How many items will be processed — used to populate `total` before the first event arrives. */
  totalItems: (startArgs: StartArgs) => number;
  /** Input order used only for the optimistic pre-acceptance projection. */
  relativePaths?: (startArgs: StartArgs) => string[];
}

export interface UseBatchImageJobOptions {
  sessionId?: number;
  /** Authoritative Rust operation projection used for recovery and lifecycle. */
  operation?: MediaLibraryBatchOperation;
}
/**
 * Generic batch-image-job hook. See file-level doc-comment for shape.
 *
 * `StartArgs` is whatever the adapter needs to drive a run — describe
 * passes `string[]` (rel paths); geocode passes a typed
 * `GeocodeRequestItem[]`.
 */
export function useBatchImageJob<StartArgs, EstimatePayload, SummaryPayload>(
  config: BatchJobConfig<StartArgs>,
  options: UseBatchImageJobOptions = {},
): {
  open: boolean;
  state: BatchJobState<EstimatePayload, SummaryPayload>;
  actions: BatchJobActions<StartArgs>;
} {
  const [open, setOpen] = useState(false);
  const [state, setState] =
    useState<BatchJobState<EstimatePayload, SummaryPayload>>(initialState);
  const projectedOperationIdRef = useRef<string | null>(null);
  const recoveredOperationIdRef = useRef<string | null>(null);
  const recoveredSessionIdRef = useRef<number | undefined>(undefined);
  const pendingEstimateRef = useRef<null | (() => void)>(null);
  const listenersReadyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const unlisteners: UnlistenFn[] = [];
    let mounted = true;
    let progressQueue = Promise.resolve();

    const safeSetState = (
      updater: (
        state: BatchJobState<EstimatePayload, SummaryPayload>,
      ) => BatchJobState<EstimatePayload, SummaryPayload>,
    ) => {
      if (mounted) setState(updater);
    };
    const subscribe = async <T>(
      event: string,
      handler: (payload: T) => void,
    ) => {
      const unlisten = await listen<T>(event, ({ payload }) => {
        if (mounted) handler(payload);
      });
      unlisteners.push(unlisten);
    };
    const applyProgress = (items: readonly BatchJobProgress[]) => {
      if (items.length === 0) return;
      safeSetState((state) => {
        const failures = [...state.failures];
        const succeeded = [...state.succeeded];
        for (const item of items) {
          if (item.status === "ok") {
            if (!succeeded.includes(item.relativePath)) {
              succeeded.push(item.relativePath);
            }
          } else if (
            !failures.some(
              (failure) =>
                failure.relativePath === item.relativePath &&
                failure.kind === item.status &&
                failure.detail === (item.error ?? ""),
            )
          ) {
            failures.push({
              relativePath: item.relativePath,
              kind: item.status as BatchJobFailureKind,
              detail: item.error ?? "",
            });
          }
        }
        const latest = items[items.length - 1];
        return {
          ...state,
          phase: "running",
          current: latest.current,
          total: latest.total,
          currentFile: latest.relativePath,
          failures,
          succeeded,
        };
      });
    };

    void (async () => {
      const prefix = config.operationKind;
      await subscribe<{ total: number }>(`${prefix}_started`, ({ total }) => {
        safeSetState((state) => ({
          ...state,
          phase: "running",
          total,
          current: 0,
          currentFile: null,
        }));
      });
      if (config.batchedProgress) {
        await subscribe<{ results: BatchJobProgress[] }>(
          `${prefix}_progress_batch`,
          ({ results }) => {
            progressQueue = progressQueue.then(() => applyProgress(results));
          },
        );
      } else {
        await subscribe<BatchJobProgress>(`${prefix}_progress`, (progress) => {
          progressQueue = progressQueue.then(() => applyProgress([progress]));
        });
      }
      await subscribe<{
        succeeded: string[];
        failed: Array<{
          relativePath: string;
          kind: BatchJobFailureKind;
          detail: string;
        }>;
        usageSummary: SummaryPayload;
      }>(`${prefix}_complete`, (payload) => {
        void progressQueue.then(() => {
          safeSetState((state) => ({
            ...state,
            phase: "done",
            currentFile: null,
            cancelling: false,
            failures: payload.failed,
            succeeded: payload.succeeded,
            summary: payload.usageSummary,
          }));
        });
      });
      if (config.commands.estimate) {
        await subscribe<{ total: number }>(
          `${prefix}_estimate_started`,
          ({ total }) => {
            safeSetState((state) => ({
              ...state,
              phase: "estimating",
              total,
              current: 0,
              currentFile: null,
            }));
          },
        );
        await subscribe<{
          current: number;
          total: number;
          relativePath: string;
        }>(`${prefix}_estimate_progress`, (payload) => {
          safeSetState((state) => ({
            ...state,
            phase: "estimating",
            current: payload.current,
            total: payload.total,
            currentFile: payload.relativePath,
          }));
        });
        await subscribe<
          | { relativePath: string; message: string }
          | { relative_path: string; message: string }
        >(`${prefix}_estimate_error`, (payload) => {
          const relativePath =
            "relativePath" in payload
              ? payload.relativePath
              : payload.relative_path;
          safeSetState((state) => ({
            ...state,
            estimateError: `${relativePath}: ${payload.message}`,
          }));
        });
        await subscribe<EstimatePayload>(
          `${prefix}_estimate_complete`,
          (estimate) => {
            safeSetState((state) => ({
              ...state,
              phase: "awaiting-confirm",
              currentFile: null,
              estimate,
            }));
          },
        );
      }
      if (mounted) {
        listenersReadyRef.current = true;
        pendingEstimateRef.current?.();
        pendingEstimateRef.current = null;
      }
    })();

    return () => {
      mounted = false;
      listenersReadyRef.current = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [
    config.batchedProgress,
    config.commands.estimate,
    config.operationKind,
    open,
  ]);

  const projectOperation = useCallback(
    (operation: MediaLibraryBatchOperation) => {
      const phase: BatchJobPhase =
        operation.phase === "completed" || operation.phase === "failed"
          ? "done"
          : operation.phase;
      projectedOperationIdRef.current = operation.operation_id;
      setOpen(true);
      setState((current) => ({
        ...current,
        phase,
        total: operation.total,
        current: operation.current,
        currentFile: operation.current_file,
        cancelling: operation.cancelling,
        failures: operation.failures.map((failure) => ({
          relativePath: failure.relative_path,
          kind: failure.kind as BatchJobFailureKind,
          detail: failure.detail,
        })),
        succeeded: [...operation.succeeded],
        estimate: operation.estimate as EstimatePayload | null,
        summary: operation.summary as SummaryPayload | null,
        estimateError: operation.error,
        relPaths: [...operation.requested_paths],
      }));
    },
    [],
  );

  const recoverAuthoritativeOperation = useCallback(async () => {
    try {
      const snapshot = (await invoke(
        "get_media_library_session_snapshot",
      )) as MediaLibrarySessionSnapshot;
      const operation = snapshot.batch_operations[config.operationKind];
      if (operation) {
        recoveredOperationIdRef.current = operation.operation_id;
        recoveredSessionIdRef.current = options.sessionId;
        projectOperation(operation);
      } else {
        projectedOperationIdRef.current = null;
        recoveredOperationIdRef.current = null;
        setOpen(false);
        setState(initialState);
      }
    } catch (error) {
      console.error("Failed to recover authoritative batch operation", error);
      setOpen(false);
      setState(initialState);
    }
  }, [config.operationKind, options.sessionId, projectOperation]);

  useEffect(() => {
    const operation = options.operation;
    if (operation) {
      recoveredOperationIdRef.current = null;
      recoveredSessionIdRef.current = undefined;
      projectOperation(operation);
    } else if (
      projectedOperationIdRef.current !== null &&
      (recoveredOperationIdRef.current !== projectedOperationIdRef.current ||
        recoveredSessionIdRef.current !== options.sessionId)
    ) {
      projectedOperationIdRef.current = null;
      recoveredOperationIdRef.current = null;
      recoveredSessionIdRef.current = undefined;
      setOpen(false);
      setState(initialState);
    }
  }, [options.operation, options.sessionId, projectOperation]);
  // Track latest phase synchronously so `cancel` can decide whether to
  // close immediately without depending on setState batching order.
  const phaseRef = useRef<BatchJobPhase>("estimating");
  phaseRef.current = state.phase;
  // Folder + start args remembered for the confirm step.
  const folderRef = useRef<string>("");
  const startArgsRef = useRef<StartArgs | null>(null);
  const start = useCallback(
    (folderPath: string, startArgs: StartArgs) => {
      folderRef.current = folderPath;
      startArgsRef.current = startArgs;
      const total = config.totalItems(startArgs);
      const relativePaths = config.relativePaths
        ? config.relativePaths(startArgs)
        : Array.isArray(startArgs)
          ? (startArgs as unknown as string[]).filter(
              (value) => typeof value === "string",
            )
          : [];
      // If this job has no estimate phase, jump straight to
      // awaiting-confirm. The dialog renders its confirm panel from the
      // saved relPaths/total alone.
      const initialPhase: BatchJobPhase = config.commands.estimate
        ? "estimating"
        : "awaiting-confirm";
      setState({
        ...initialState<EstimatePayload, SummaryPayload>(),
        phase: initialPhase,
        total,
        relPaths: relativePaths,
      });
      if (config.commands.estimate && config.buildEstimateArgs) {
        const estimateCmd = config.commands.estimate;
        const args = {
          ...config.buildEstimateArgs(folderPath, startArgs),
          sessionId: options.sessionId,
        };
        const runEstimate = () => {
          void invoke(estimateCmd, args).catch(recoverAuthoritativeOperation);
        };
        if (listenersReadyRef.current) runEstimate();
        else pendingEstimateRef.current = runEstimate;
      }
      setOpen(true);
    },
    [config, options.sessionId, recoverAuthoritativeOperation],
  );

  const confirm = useCallback(() => {
    const folder = folderRef.current;
    const startArgs = startArgsRef.current;
    if (startArgs == null && !options.operation) return;
    setState((s) => ({
      ...s,
      phase: "running",
      current: 0,
      currentFile: null,
    }));

    void invoke(config.commands.run, {
      ...(startArgs == null
        ? (config.buildRecoveryRunArgs?.() ?? {})
        : config.buildRunArgs(folder, startArgs)),
      sessionId: options.sessionId,
      ...(options.operation
        ? { operationId: options.operation.operation_id }
        : {}),
    }).catch(recoverAuthoritativeOperation);
  }, [
    config,
    options.operation,
    options.sessionId,
    recoverAuthoritativeOperation,
  ]);

  const cancel = useCallback(() => {
    // In `estimating` or `awaiting-confirm` there is no backend run to
    // wait on — close the dialog immediately so Cancel feels responsive.
    // We still signal the backend so an in-flight estimate loop stops
    // at the next image boundary instead of burning more work after the
    // user has bailed.
    //
    // In `running` we leave the dialog open and wait for `_complete`
    // to flip the phase to `done`, since cancellation is per-image and
    // the user wants to see what landed before the dialog disappears.
    const operation = options.operation;
    if (!operation || options.sessionId === undefined) {
      projectedOperationIdRef.current = null;
      recoveredOperationIdRef.current = null;
      recoveredSessionIdRef.current = undefined;
      setOpen(false);
      setState(initialState);
      return;
    }
    void invoke(config.commands.cancel, {
      sessionId: options.sessionId,
      operationId: operation.operation_id,
    }).catch(() => {
      /* best effort */
    });
    if (phaseRef.current === "running") {
      setState((s) => ({ ...s, cancelling: true }));
    } else {
      void invoke("dismiss_media_library_session_batch_operation", {
        sessionId: options.sessionId,
        operationId: operation.operation_id,
      });
      projectedOperationIdRef.current = null;
      recoveredOperationIdRef.current = null;
      recoveredSessionIdRef.current = undefined;
      setOpen(false);
      setState(initialState);
    }
  }, [config.commands.cancel, options.operation, options.sessionId]);
  const close = useCallback(() => {
    if (options.operation) {
      void invoke("dismiss_media_library_session_batch_operation", {
        sessionId: options.sessionId,
        operationId: options.operation.operation_id,
      });
    }
    projectedOperationIdRef.current = null;
    recoveredOperationIdRef.current = null;
    recoveredSessionIdRef.current = undefined;
    setOpen(false);
    setState(initialState);
  }, [options.operation, options.sessionId]);

  return { open, state, actions: { start, confirm, cancel, close } };
}
