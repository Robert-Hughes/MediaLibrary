/**
 * Drives the metadata-normalisation flow end-to-end.
 *
 * Thin adapter around `useBatchImageJob`. Plan §7 estimate phase fires
 * before awaiting-confirm whenever any AI-capable group (Description,
 * Title) is enabled — the backend walks every image and preflights
 * each fire-able AI prompt against `/responses/input_tokens` so the
 * dialog can show an exact cost preview.
 *
 * See `docs/NORMALISE_METADATA_PLAN.md` §7, §9.
 */
import { useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GeneratedDraftStageResult } from "../generatedTargetDrafts";
import type {
  SchemaMetadataEdit,
  NormaliseEstimate,
  NormaliseGroup,
  NormaliseRequestItem,
  NormaliseSummary,
} from "../types";
import {
  useBatchImageJob,
  type BatchJobConfig,
  type BatchJobPhase,
  type BatchJobState,
  type BatchJobFailure,
} from "./useBatchImageJob";

/**
 * UI state for the normaliser dialog. Mirrors `DescribeProgressState`
 * — the estimate phase is enabled now that v2 ships AI calls.
 */
export interface NormaliseProgressState {
  phase: BatchJobPhase;
  total: number;
  current: number;
  currentFile: string | null;
  cancelling: boolean;
  failures: BatchJobFailure[];
  succeeded: string[];
  summary: NormaliseSummary | null;
  estimate: NormaliseEstimate | null;
  estimateError: string | null;
  items: NormaliseRequestItem[];
  enabledGroups: NormaliseGroup[];
}

export interface NormaliseActions {
  start: (
    folderPath: string,
    items: NormaliseRequestItem[],
    enabledGroups: NormaliseGroup[],
  ) => void;
  setEnabledGroups: (groups: NormaliseGroup[]) => void;
  confirm: () => void;
  cancel: () => void;
  close: () => void;
}

export interface UseNormaliseMetadataOptions {
  onApplyEdits?: (
    relativePath: string,
    edits: SchemaMetadataEdit[],
    confirmedEnabledGroups: readonly NormaliseGroup[],
  ) => GeneratedDraftStageResult;
  onApplyEditsBatch?: (
    items: readonly {
      relativePath: string;
      edits: SchemaMetadataEdit[];
    }[],
    confirmedEnabledGroups: readonly NormaliseGroup[],
  ) => readonly GeneratedDraftStageResult[];
}

interface StartArgs {
  items: NormaliseRequestItem[];
  enabledGroups: NormaliseGroup[];
}

function toNormaliseShape(
  s: BatchJobState<NormaliseEstimate, NormaliseSummary>,
  items: NormaliseRequestItem[],
  enabledGroups: NormaliseGroup[],
): NormaliseProgressState {
  return {
    phase: s.phase,
    total: s.total,
    current: s.current,
    currentFile: s.currentFile,
    cancelling: s.cancelling,
    failures: s.failures,
    succeeded: s.succeeded,
    summary: s.summary,
    estimate: s.estimate,
    estimateError: s.estimateError,
    items,
    enabledGroups,
  };
}

export function useNormaliseMetadata(
  options: UseNormaliseMetadataOptions = {},
): {
  open: boolean;
  state: NormaliseProgressState;
  actions: NormaliseActions;
} {
  // Mutable stash read by `buildRunArgs` / `buildEstimateArgs` at fire
  // time so the user's latest checkbox selection is the one shipped to
  // the backend (rather than the value captured at start time).
  const stash = useMemo<{
    items: NormaliseRequestItem[];
    enabledGroups: NormaliseGroup[];
    confirmedEnabledGroups: NormaliseGroup[];
  }>(() => ({ items: [], enabledGroups: [], confirmedEnabledGroups: [] }), []);
  const [enabledGroupsState, setEnabledGroupsState] = useState<
    NormaliseGroup[]
  >([]);

  const config = useMemo<
    BatchJobConfig<StartArgs, NormaliseEstimate, NormaliseSummary>
  >(
    () => ({
      eventPrefix: "normalise",
      batchedProgress: true,
      commands: {
        estimate: "estimate_normalise_cost_cmd",
        run: "normalise_metadata_cmd",
        cancel: "cancel_normalise_cmd",
      },
      buildEstimateArgs: (folderPath) => ({
        folderPath,
        items: stash.items,
        enabledGroups: stash.enabledGroups,
      }),
      buildRunArgs: (folderPath) => ({
        folderPath,
        items: stash.items,
        enabledGroups: stash.confirmedEnabledGroups,
      }),
      totalItems: (args) => args.items.length,
      relativePaths: (args) => args.items.map((item) => item.relPath),
      parseEstimatePayload: (raw) => raw as NormaliseEstimate,
      parseSummaryPayload: (raw) => raw as NormaliseSummary,
      subscribeExtras: async (setState) => {
        const unlisteners: UnlistenFn[] = [];
        unlisteners.push(
          await listen<{ total: number }>("normalise_estimate_started", (e) => {
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
          }>("normalise_estimate_progress", (e) => {
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
            "normalise_estimate_error",
            (e) => {
              setState((s) => ({
                ...s,
                estimateError: `${e.payload.relativePath}: ${e.payload.message}`,
              }));
            },
          ),
        );
        unlisteners.push(
          await listen<NormaliseEstimate>(
            "normalise_estimate_complete",
            (e) => {
              const est = e.payload;
              // Drop groups that have nothing to do on any image from the
              // user's selection. The confirm-table renders these rows as
              // disabled+unchecked, so keeping them in `enabledGroups`
              // would silently smuggle them to the run cmd and produce a
              // post-run summary mentioning groups the user thought they
              // had unticked.
              const filtered = stash.enabledGroups.filter((g) => {
                const c = est.perGroupOutcomes[g];
                if (!c) return false;
                return (
                  c.nNormalisedDeterministic + c.nNormalisedAi + c.nConflict > 0
                );
              });
              if (filtered.length !== stash.enabledGroups.length) {
                stash.enabledGroups = filtered;
                setEnabledGroupsState(filtered);
              }
              setState((s) => ({
                ...s,
                phase: "awaiting-confirm",
                currentFile: null,
                estimate: est,
              }));
            },
          ),
        );
        return unlisteners;
      },
    }),
    [stash],
  );

  const job = useBatchImageJob<StartArgs, NormaliseEstimate, NormaliseSummary>(
    config,
    {
      onApplyEdits: options.onApplyEdits
        ? (relativePath, edits) =>
            options.onApplyEdits!(
              relativePath,
              edits,
              structuredClone(stash.confirmedEnabledGroups),
            )
        : undefined,
      onApplyEditsBatch: options.onApplyEditsBatch
        ? (items) =>
            options.onApplyEditsBatch!(
              items,
              structuredClone(stash.confirmedEnabledGroups),
            )
        : undefined,
    },
  );

  const setEnabledGroups = (groups: NormaliseGroup[]) => {
    stash.enabledGroups = groups;
    setEnabledGroupsState(groups);
  };

  const actions: NormaliseActions = {
    start: (folderPath, items, initialEnabledGroups) => {
      stash.items = items;
      stash.enabledGroups = [...initialEnabledGroups];
      stash.confirmedEnabledGroups = [];
      setEnabledGroupsState(initialEnabledGroups);
      job.actions.start(folderPath, {
        items,
        enabledGroups: initialEnabledGroups,
      });
    },
    setEnabledGroups,
    confirm: () => {
      stash.confirmedEnabledGroups = structuredClone(stash.enabledGroups);
      job.actions.confirm();
    },
    cancel: job.actions.cancel,
    close: () => {
      stash.items = [];
      stash.enabledGroups = [];
      stash.confirmedEnabledGroups = [];
      setEnabledGroupsState([]);
      job.actions.close();
    },
  };

  return {
    open: job.open,
    state: toNormaliseShape(job.state, stash.items, enabledGroupsState),
    actions,
  };
}
