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
import { useMemo, useState } from "react";
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
   * Begin the flow with all groups in `groupInputs` populated. The
   * user toggles enabled groups inside the dialog before clicking
   * Confirm; the final set is shipped to the backend at `confirm`
   * time via `setEnabledGroups`.
   */
  start: (folderPath: string, items: NormaliseRequestItem[], enabledGroups: NormaliseGroup[]) => void;
  /** Update the enabled-group selection (typically from dialog
   *  checkboxes). Latest value is used at confirm time. */
  setEnabledGroups: (groups: NormaliseGroup[]) => void;
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
  // Mutable stash read by `buildRunArgs` at confirm time. Both items
  // and enabled-groups live here so the user's final checkbox
  // selection (which may have changed after `start`) is the one
  // shipped to the backend.
  //
  // `buildRunArgs` receives the static `StartArgs` captured at start
  // time, but we deliberately pass it the live stash via closure
  // below — the captured value is ignored.
  const stash = useMemo<{
    items: NormaliseRequestItem[];
    enabledGroups: NormaliseGroup[];
  }>(
    () => ({ items: [], enabledGroups: [] }),
    [],
  );
  // Separate React state so the dialog UI re-renders when the user
  // toggles a checkbox. Always kept in sync with `stash.enabledGroups`
  // via the `setEnabledGroups` action below.
  const [enabledGroupsState, setEnabledGroupsState] = useState<NormaliseGroup[]>([]);

  const config = useMemo<BatchJobConfig<StartArgs, null, NormaliseSummary>>(
    () => ({
      eventPrefix: "normalise",
      commands: {
        // No estimate command in v1 — see file-level comment.
        run: "normalise_metadata_cmd",
        cancel: "cancel_normalise_cmd",
      },
      buildRunArgs: (folderPath, _args) => ({
        folderPath,
        // Read from the live stash, NOT the start-time `_args`, so
        // the user's most-recent checkbox selection wins.
        items: stash.items,
        enabledGroups: stash.enabledGroups,
      }),
      totalItems: (args) => args.items.length,
      parseSummaryPayload: (raw) => raw as NormaliseSummary,
    }),
    [stash],
  );

  const job = useBatchImageJob<StartArgs, null, NormaliseSummary>(config, {
    onApplyEdits: options.onApplyEdits,
  });

  const setEnabledGroups = (groups: NormaliseGroup[]) => {
    stash.enabledGroups = groups;
    setEnabledGroupsState(groups);
  };

  const actions: NormaliseActions = {
    start: (folderPath, items, initialEnabledGroups) => {
      stash.items = items;
      stash.enabledGroups = initialEnabledGroups;
      setEnabledGroupsState(initialEnabledGroups);
      job.actions.start(folderPath, { items, enabledGroups: initialEnabledGroups });
    },
    setEnabledGroups,
    confirm: job.actions.confirm,
    cancel: job.actions.cancel,
    close: () => {
      stash.items = [];
      stash.enabledGroups = [];
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
