/**
 * Drives the metadata-normalisation flow end-to-end.
 *
 * Thin adapter around `useBatchImageJob`. v1 of the normaliser has no
 * AI dispatch, so there is no estimate phase (plan §7 — the estimate
 * phase lands with v2 alongside the Description group's AI merge).
 * The hook therefore jumps straight to `awaiting-confirm` with the
 * items + enabled-groups the caller passed, then on `confirm` invokes
 * `normalise_metadata_cmd` and lets the backend's `normalise_*` events
 * drive the rest of the state machine.
 *
 * See `docs/NORMALISE_METADATA_PLAN.md` §9 (hook + dialog wiring).
 */
import { useMemo } from "react";
import type {
  DraftEdit,
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
 * UI state for the normaliser dialog. Mirrors `GeocodeProgressState`
 * in spirit — the BatchJobDialog reads `phase` and the dialog body
 * renders the matching panel.
 */
export interface NormaliseProgressState {
  phase: Exclude<BatchJobPhase, "estimating">;
  total: number;
  current: number;
  currentFile: string | null;
  cancelling: boolean;
  failures: BatchJobFailure[];
  succeeded: string[];
  summary: NormaliseSummary | null;
  /** Items the dialog was opened for; kept so the awaiting-confirm
   *  panel can show per-group preview counts. */
  items: NormaliseRequestItem[];
  /** Groups the user chose in the confirm dialog (or supplied at
   *  `start`). */
  enabledGroups: NormaliseGroup[];
}

export interface NormaliseActions {
  /**
   * Begin the flow. The frontend has already resolved the
   * draft-overlay for every relevant field across all enabled groups
   * and packed it into the per-image `groupInputs`; the backend
   * trusts what it receives.
   */
  start: (folderPath: string, items: NormaliseRequestItem[], enabledGroups: NormaliseGroup[]) => void;
  confirm: () => void;
  cancel: () => void;
  close: () => void;
}

export interface UseNormaliseMetadataOptions {
  onApplyEdits?: (relativePath: string, edits: Record<string, DraftEdit>) => void;
}

interface StartArgs {
  items: NormaliseRequestItem[];
  enabledGroups: NormaliseGroup[];
}

function toNormaliseShape(
  s: BatchJobState<null, NormaliseSummary>,
  items: NormaliseRequestItem[],
  enabledGroups: NormaliseGroup[],
): NormaliseProgressState {
  const phase = s.phase === "estimating" ? "awaiting-confirm" : s.phase;
  return {
    phase,
    total: s.total,
    current: s.current,
    currentFile: s.currentFile,
    cancelling: s.cancelling,
    failures: s.failures,
    succeeded: s.succeeded,
    summary: s.summary,
    items,
    enabledGroups,
  };
}

export function useNormaliseMetadata(options: UseNormaliseMetadataOptions = {}): {
  open: boolean;
  state: NormaliseProgressState;
  actions: NormaliseActions;
} {
  // Stash the items + group list across the dialog lifetime so the
  // dialog panels can read them back. Mirrors the geocode adapter
  // pattern.
  const stash = useMemo<{ items: NormaliseRequestItem[]; groups: NormaliseGroup[] }>(
    () => ({ items: [], groups: [] }),
    [],
  );

  const config = useMemo<BatchJobConfig<StartArgs, null, NormaliseSummary>>(
    () => ({
      eventPrefix: "normalise",
      commands: {
        // No estimate command in v1 — see file-level comment.
        run: "normalise_metadata_cmd",
        cancel: "cancel_normalise_cmd",
      },
      buildRunArgs: (folderPath, args) => ({
        folderPath,
        items: args.items,
        enabledGroups: args.enabledGroups,
      }),
      totalItems: (args) => args.items.length,
      parseSummaryPayload: (raw) => raw as NormaliseSummary,
    }),
    [],
  );

  const job = useBatchImageJob<StartArgs, null, NormaliseSummary>(config, {
    onApplyEdits: options.onApplyEdits,
  });

  const actions: NormaliseActions = {
    start: (folderPath, items, enabledGroups) => {
      stash.items = items;
      stash.groups = enabledGroups;
      job.actions.start(folderPath, { items, enabledGroups });
    },
    confirm: job.actions.confirm,
    cancel: job.actions.cancel,
    close: () => {
      stash.items = [];
      stash.groups = [];
      job.actions.close();
    },
  };

  return {
    open: job.open,
    state: toNormaliseShape(job.state, stash.items, stash.groups),
    actions,
  };
}
