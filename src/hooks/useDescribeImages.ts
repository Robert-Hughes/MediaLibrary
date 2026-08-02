/**
 * Drives the AI-description flow end-to-end.
 *
 * Thin adapter around `useBatchImageJob` (the shared phase machine for
 * any per-image batch job). This file owns only the
 * describe-specific bits: the four `describe_*` command names, the
 * `describe_estimate_*` event subscriptions, and the typed shapes of
 * the estimate + summary payloads.
 *
 * The describe flow delegates its shared state machine and
 * Tauri subscriptions; that logic now lives in `useBatchImageJob.ts`
 * so reverse-geocode and any future batch job can share the same
 * lifecycle without copy-paste.
 */
import { useMemo } from "react";
import type {
  DescribeEstimate,
  DescribeProgressState,
  DescribeUsageSummary,
  MediaLibraryBatchOperation,
} from "../types";
import {
  useBatchImageJob,
  type BatchJobConfig,
  type BatchJobState,
} from "./useBatchImageJob";

export interface DescribeActions {
  /** Start the flow for the given absolute folder + relative paths. */
  start: (folderPath: string, relPaths: string[]) => void;
  /** User clicked "Confirm and run" in the awaiting-confirm phase. */
  confirm: () => void;
  /** User clicked "Cancel" — works in any phase before `done`. */
  cancel: () => void;
  /** User clicked "Close" on the done panel. */
  close: () => void;
}

export interface UseDescribeImagesOptions {
  sessionId?: number;
  operation?: MediaLibraryBatchOperation;
}

/**
 * Map the generic `BatchJobState` to the describe-specific `DescribeProgressState`
 * shape that `DescribeProgressDialog` already renders. Keeping the
 * adapter at the hook boundary means the dialog component need not
 * change as part of the refactor.
 */
function toDescribeProgressState(
  s: BatchJobState<DescribeEstimate, DescribeUsageSummary>,
): DescribeProgressState {
  return {
    phase: s.phase,
    total: s.total,
    current: s.current,
    currentFile: s.currentFile,
    cancelling: s.cancelling,
    failures: s.failures,
    succeeded: s.succeeded,
    estimate: s.estimate,
    estimateError: s.estimateError,
    usageSummary: s.summary,
    relPaths: s.relPaths,
  };
}

export function useDescribeImages(options: UseDescribeImagesOptions = {}): {
  open: boolean;
  state: DescribeProgressState;
  actions: DescribeActions;
} {
  // Build the adapter config once. `useMemo` is enough — the config has
  // no closed-over state, just constants and pure parsers.
  const config = useMemo<BatchJobConfig<string[]>>(
    () => ({
      operationKind: "describe",
      commands: {
        estimate: "estimate_describe_cost_cmd",
        run: "describe_images_cmd",
        cancel: "cancel_describe_cmd",
      },
      buildEstimateArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
      buildRunArgs: () => ({}),
      buildRecoveryRunArgs: () => ({}),
      totalItems: (relPaths) => relPaths.length,
      relativePaths: (relPaths) => [...relPaths],
    }),
    [],
  );

  const job = useBatchImageJob<
    string[],
    DescribeEstimate,
    DescribeUsageSummary
  >(config, {
    sessionId: options.sessionId,
    operation: options.operation,
  });

  return {
    open: job.open,
    state: toDescribeProgressState(job.state),
    actions: job.actions,
  };
}
