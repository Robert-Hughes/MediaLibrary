/**
 * Drives the AI-description flow end-to-end.
 *
 * Thin adapter around `useBatchImageJob` (the shared phase machine for
 * any sequential per-image batch job). This file owns only the
 * describe-specific bits: the four `describe_*` command names, the
 * `describe_estimate_*` event subscriptions, and the typed shapes of
 * the estimate + summary payloads.
 *
 * The previous version of this hook held its own state machine and
 * Tauri subscriptions; that logic now lives in `useBatchImageJob.ts`
 * so reverse-geocode and any future batch job can share the same
 * lifecycle without copy-paste.
 */
import { useMemo } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import type {
  DescribeEstimate,
  DescribeProgressState,
  DescribeUsageSummary,
  MetadataDraftEntry,
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
  /**
   * Invoked for each image whose describe call succeeded, with the typed
   * draft edits the backend produced for it. The caller is responsible
   * for merging these into the in-memory draft store (which then
   * persists via the semantic metadata-draft pipeline).
   *
   * Keeping persistence in the caller — rather than the backend writing
   * directly to draft_edits.jsonl — means the UI re-renders immediately
   * and there is exactly one writer to the typed-draft store.
   */
  onApplyEdits?: (relativePath: string, edits: MetadataDraftEntry[]) => void;
}

/**
 * Map the generic `BatchJobState` to the legacy `DescribeProgressState`
 * shape that `DescribeProgressDialog` already renders. Keeping the
 * adapter at the hook boundary means the dialog component need not
 * change as part of the refactor.
 */
function toLegacyShape(
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
  const config = useMemo<
    BatchJobConfig<string[], DescribeEstimate, DescribeUsageSummary>
  >(
    () => ({
      eventPrefix: "describe",
      commands: {
        estimate: "estimate_describe_cost_cmd",
        run: "describe_images_cmd",
        cancel: "cancel_describe_cmd",
      },
      buildEstimateArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
      buildRunArgs: (folderPath, relPaths) => ({ folderPath, relPaths }),
      totalItems: (relPaths) => relPaths.length,
      parseEstimatePayload: (raw) => raw as DescribeEstimate,
      parseSummaryPayload: (raw) => raw as DescribeUsageSummary,
      subscribeExtras: async (setState) => {
        // Describe-only: the estimate phase emits its own progress
        // events because the generic loop's `${prefix}_progress` is
        // reserved for the main run.
        const unlisteners: UnlistenFn[] = [];

        unlisteners.push(
          await listen<{ total: number }>("describe_estimate_started", (e) => {
            setState((s) => ({
              ...s,
              phase: "estimating",
              total: e.payload.total,
              current: 0,
            }));
          }),
        );
        unlisteners.push(
          await listen<{
            current: number;
            total: number;
            relativePath: string;
          }>("describe_estimate_progress", (e) => {
            setState((s) => ({
              ...s,
              phase: "estimating",
              current: e.payload.current,
              total: e.payload.total,
              currentFile: e.payload.relativePath,
            }));
          }),
        );
        unlisteners.push(
          await listen<{ relativePath: string; message: string }>(
            "describe_estimate_error",
            (e) => {
              setState((s) => ({
                ...s,
                estimateError: `${e.payload.relativePath}: ${e.payload.message}`,
              }));
            },
          ),
        );
        unlisteners.push(
          await listen<DescribeEstimate>("describe_estimate_complete", (e) => {
            setState((s) => ({
              ...s,
              phase: "awaiting-confirm",
              currentFile: null,
              estimate: e.payload,
            }));
          }),
        );
        return unlisteners;
      },
    }),
    [],
  );

  const job = useBatchImageJob<
    string[],
    DescribeEstimate,
    DescribeUsageSummary
  >(config, {
    onApplyEdits: options.onApplyEdits,
  });

  return {
    open: job.open,
    state: toLegacyShape(job.state),
    actions: job.actions,
  };
}
