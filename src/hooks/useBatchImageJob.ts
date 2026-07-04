/**
 * Generic phase-machine + Tauri-event glue for sequential per-image
 * batch jobs (AI description, reverse geocoding, …).
 *
 * Every such flow shares the same shape:
 *
 *   [estimating?] → awaiting-confirm → running → done
 *
 * with `${prefix}_started`, `${prefix}_progress`, `${prefix}_complete`
 * events emitted by the backend's `BatchProgressEmitter`, plus optional
 * `${prefix}_estimate_*` events for the cost-preflight phase. Each job
 * also has its own per-job summary payload (token costs for describe,
 * source counters for geocode); the hook is generic over its shape so
 * each adapter wraps `useBatchImageJob` with strongly-typed wrappers.
 *
 * The hook is intentionally non-opinionated about *which* fields the
 * estimate or summary objects carry — it stores whatever the backend
 * emits and the adapter renders. The shared piece is the lifecycle:
 *
 *  - opens on `start`, never closes between phases,
 *  - persists per-item draft edits via `onApplyEdits` (caller owns the
 *    in-memory draft store, exactly as the describe flow does today),
 *  - signals cancellation via the configured cancel command,
 *  - releases all event subscriptions on close.
 *
 * The describe hook (`useDescribeImages`) and geocode hook
 * (`useGeocodeImages`) are thin adapters around this primitive.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BatchFailureKind, DraftEdit } from "../types";
import { normalizeGeneratedDraftEdits } from "../utils/semanticDrafts";

export type BatchJobPhase =
  "estimating" | "awaiting-confirm" | "running" | "done";

export interface BatchJobFailure {
  relativePath: string;
  kind: BatchFailureKind;
  detail: string;
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
 * Configuration for one job's adapter — names and shape of its
 * commands and events. Adapters supply this once at hook construction.
 *
 * Commands:
 *  - `estimate`  : Tauri command name for the preflight. Omit for jobs
 *                  with no estimate phase (e.g. geocode — it has nothing
 *                  to compute up front).
 *  - `run`       : Tauri command name for the main loop.
 *  - `cancel`    : Tauri command name for the cancel signal.
 *
 * `eventPrefix` is the `${prefix}` used by the backend's
 * `BatchProgressEmitter` for the three universal events
 * (`${prefix}_started`, `${prefix}_progress`, `${prefix}_complete`). The
 * adapter may also listen to `${prefix}_estimate_*` extras when an
 * estimate phase is configured.
 *
 * `relPaths` is the field name in the run-command invocation. Describe
 * passes `relPaths: string[]`; geocode passes `items: GeocodeRequestItem[]`.
 * `buildRunArgs` builds the full args object from the saved start
 * arguments, so each adapter controls its own wire shape.
 */
export interface BatchJobConfig<StartArgs, EstimatePayload, SummaryPayload> {
  eventPrefix: string;
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
  /** How many items will be processed — used to populate `total` before the first event arrives. */
  totalItems: (startArgs: StartArgs) => number;
  /**
   * Parse the `${prefix}_estimate_complete` event payload into the
   * adapter's `EstimatePayload`. Omit if no estimate phase.
   */
  parseEstimatePayload?: (raw: unknown) => EstimatePayload;
  /**
   * Parse the `usage_summary` field of the `${prefix}_complete` event
   * into the adapter's `SummaryPayload`.
   */
  parseSummaryPayload: (raw: unknown) => SummaryPayload;
  /**
   * Subscribe to job-specific extra events (e.g. `describe_estimate_started`,
   * `describe_estimate_progress`, `describe_estimate_error`). Called
   * inside the same effect that owns the universal subs so all
   * subscriptions are released together on close. The `setState`
   * callback lets the adapter merge partial updates into the shared
   * state shape (e.g. estimate progress updates `current` and
   * `currentFile`).
   *
   * Return an array of unlisteners — they will be joined with the
   * universal ones and called on cleanup.
   */
  subscribeExtras?: (
    setState: (
      updater: (
        s: BatchJobState<EstimatePayload, SummaryPayload>,
      ) => BatchJobState<EstimatePayload, SummaryPayload>,
    ) => void,
  ) => Promise<UnlistenFn[]>;
}

export interface UseBatchImageJobOptions {
  /**
   * Invoked for each item whose `${prefix}_progress` event reports
   * `status === "ok"` and carries draft edits. Caller merges these into
   * the draft store immediately so the UI re-renders without waiting
   * for the batch to finish.
   */
  onApplyEdits?: (
    relativePath: string,
    edits: Record<string, DraftEdit>,
  ) => void;
}

/**
 * Generic batch-image-job hook. See file-level doc-comment for shape.
 *
 * `StartArgs` is whatever the adapter needs to drive a run — describe
 * passes `string[]` (rel paths); geocode passes a typed
 * `GeocodeRequestItem[]`.
 */
export function useBatchImageJob<StartArgs, EstimatePayload, SummaryPayload>(
  config: BatchJobConfig<StartArgs, EstimatePayload, SummaryPayload>,
  options: UseBatchImageJobOptions = {},
): {
  open: boolean;
  state: BatchJobState<EstimatePayload, SummaryPayload>;
  actions: BatchJobActions<StartArgs>;
} {
  // Hold the latest onApplyEdits in a ref so re-renders with a new
  // closure don't force the event subscription effect to rebind.
  const onApplyEditsRef = useRef(options.onApplyEdits);
  onApplyEditsRef.current = options.onApplyEdits;

  const [open, setOpen] = useState(false);
  const [state, setState] =
    useState<BatchJobState<EstimatePayload, SummaryPayload>>(initialState);
  // Track latest phase synchronously so `cancel` can decide whether to
  // close immediately without depending on setState batching order.
  const phaseRef = useRef<BatchJobPhase>("estimating");
  phaseRef.current = state.phase;
  // Folder + start args remembered for the confirm step.
  const folderRef = useRef<string>("");
  const startArgsRef = useRef<StartArgs | null>(null);
  // Pending estimate-invoke deferred until the effect has attached all
  // event listeners. Without this gate the backend can finish (and emit
  // `${prefix}_estimate_complete`) before `subscribeExtras` registers
  // its listener, leaving the dialog stuck on the estimating panel.
  const pendingEstimateRef = useRef<null | (() => void)>(null);
  // True once the subscription effect has finished attaching listeners.
  // start() uses this to decide whether to invoke the estimate command
  // immediately (listeners ready) or defer it (will fire when ready).
  const listenersReadyRef = useRef(false);

  // Subscribe to all events while open. Unsubscribe on close.
  useEffect(() => {
    if (!open) return;
    const unlisteners: UnlistenFn[] = [];
    let mounted = true;

    const safeSetState = (
      updater: (
        s: BatchJobState<EstimatePayload, SummaryPayload>,
      ) => BatchJobState<EstimatePayload, SummaryPayload>,
    ) => {
      if (mounted) setState(updater);
    };

    const sub = async <T>(evt: string, h: (p: T) => void) => {
      const off = await listen<T>(evt, (e) => mounted && h(e.payload));
      unlisteners.push(off);
    };

    void (async () => {
      // Universal events — same shape across all batch jobs.
      await sub<{ total: number }>(`${config.eventPrefix}_started`, (p) => {
        safeSetState((s) => ({
          ...s,
          phase: "running",
          total: p.total,
          current: 0,
          currentFile: null,
        }));
      });
      await sub<{
        current: number;
        total: number;
        relativePath: string;
        status: string;
        error: string | null;
        edits?: unknown;
      }>(`${config.eventPrefix}_progress`, (p) => {
        if (p.status === "ok" && p.edits) {
          onApplyEditsRef.current?.(
            p.relativePath,
            normalizeGeneratedDraftEdits(p.edits),
          );
        }
        safeSetState((s) => {
          const failures =
            p.status !== "ok"
              ? [
                  ...s.failures,
                  {
                    relativePath: p.relativePath,
                    // Backend emits status="ok" on success or a
                    // BatchFailureKind wire string otherwise. The
                    // wire type is asserted here rather than carried
                    // in the event-payload Type to keep the listener
                    // shape minimal.
                    kind: p.status as BatchFailureKind,
                    detail: p.error ?? "",
                  },
                ]
              : s.failures;
          const succeeded =
            p.status === "ok" ? [...s.succeeded, p.relativePath] : s.succeeded;
          return {
            ...s,
            phase: "running",
            current: p.current,
            total: p.total,
            currentFile: p.relativePath,
            failures,
            succeeded,
          };
        });
      });
      await sub<{
        succeeded: string[];
        failed: BatchJobFailure[];
        usageSummary: unknown;
      }>(`${config.eventPrefix}_complete`, (p) => {
        const parsed = config.parseSummaryPayload(p.usageSummary);
        safeSetState((s) => ({
          ...s,
          phase: "done",
          cancelling: false,
          succeeded: p.succeeded,
          failures: p.failed,
          summary: parsed,
        }));
      });

      // Adapter-specific extras (e.g. describe estimate events).
      if (config.subscribeExtras) {
        const extra = await config.subscribeExtras(safeSetState);
        unlisteners.push(...extra);
      }

      // Listeners attached — fire any deferred estimate invoke now.
      if (mounted) {
        listenersReadyRef.current = true;
        if (pendingEstimateRef.current) {
          const run = pendingEstimateRef.current;
          pendingEstimateRef.current = null;
          run();
        }
      }
    })();

    return () => {
      mounted = false;
      listenersReadyRef.current = false;
      for (const off of unlisteners) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, config.eventPrefix]);

  const start = useCallback(
    (folderPath: string, startArgs: StartArgs) => {
      folderRef.current = folderPath;
      startArgsRef.current = startArgs;
      const total = config.totalItems(startArgs);
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
        relPaths: Array.isArray(startArgs)
          ? (startArgs as unknown as string[]).filter(
              (x) => typeof x === "string",
            )
          : [],
      });
      if (config.commands.estimate && config.buildEstimateArgs) {
        // Defer invoke until the subscription effect has attached all
        // listeners — otherwise a fast backend (e.g. the no-AI branch
        // of normalise_estimate_cost_cmd) can emit `_estimate_complete`
        // before `subscribeExtras` registers its listener and the
        // dialog stays stuck on the estimating panel.
        const estimateCmd = config.commands.estimate;
        const args = config.buildEstimateArgs(folderPath, startArgs);
        const runEstimate = () => {
          void invoke(estimateCmd, args).catch((e: unknown) => {
            setState((s) => ({
              ...s,
              phase: "done",
              estimateError: String(e),
              failures: s.relPaths.map((rp) => ({
                relativePath: rp,
                kind: "preflight_failed",
                detail: String(e),
              })),
            }));
          });
        };
        if (listenersReadyRef.current) {
          runEstimate();
        } else {
          pendingEstimateRef.current = runEstimate;
        }
      }
      setOpen(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.commands.estimate, config.eventPrefix],
  );

  const confirm = useCallback(() => {
    const folder = folderRef.current;
    const startArgs = startArgsRef.current;
    if (startArgs == null) return;
    setState((s) => ({
      ...s,
      phase: "running",
      current: 0,
      currentFile: null,
    }));

    void invoke(
      config.commands.run,
      config.buildRunArgs(folder, startArgs),
    ).catch((e: unknown) => {
      setState((curr) => ({
        ...curr,
        phase: "done",
        failures: [
          ...curr.failures,
          {
            relativePath: "(batch)",
            kind: "command_failed",
            detail: String(e),
          },
        ],
      }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.commands.run]);

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
    void invoke(config.commands.cancel).catch(() => {
      /* best effort */
    });
    if (phaseRef.current === "running") {
      setState((s) => ({ ...s, cancelling: true }));
    } else {
      setOpen(false);
      setState(initialState);
    }
  }, [config.commands.cancel]);

  const close = useCallback(() => {
    setOpen(false);
    setState(initialState);
  }, []);

  return { open, state, actions: { start, confirm, cancel, close } };
}
