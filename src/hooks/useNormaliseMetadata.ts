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
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  NormaliseEstimate,
  NormaliseGroup,
  NormaliseRequestItem,
  NormaliseSummary,
  MediaLibraryBatchOperation,
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
  /** Frontend request construction before the backend estimate starts. */
  preparing?: boolean;
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
  startFromPaths: (
    folderPath: string,
    relPaths: string[],
    enabledGroups: NormaliseGroup[],
    buildItems: () => NormaliseRequestItem[],
  ) => void;
  setEnabledGroups: (groups: NormaliseGroup[]) => void;
  confirm: () => void;
  cancel: () => void;
  close: () => void;
}

export interface UseNormaliseMetadataOptions {
  sessionId?: number;
  operation?: MediaLibraryBatchOperation;
}

interface StartArgs {
  items: NormaliseRequestItem[];
  enabledGroups: NormaliseGroup[];
}

const NORMALISE_GROUPS = new Set<NormaliseGroup>([
  "keywords",
  "description",
  "title",
  "headline",
  "creator",
  "copyright",
  "location",
  "dates",
  "iptc_utf8",
]);

function isNormaliseGroup(value: unknown): value is NormaliseGroup {
  return (
    typeof value === "string" && NORMALISE_GROUPS.has(value as NormaliseGroup)
  );
}

function retainedNormaliseRequest(
  operation: MediaLibraryBatchOperation | undefined,
): StartArgs | null {
  const request = operation?.request;
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    return null;
  }
  const { items, enabledGroups } = request as {
    items?: unknown;
    enabledGroups?: unknown;
  };
  if (!Array.isArray(items) || !Array.isArray(enabledGroups)) return null;
  return {
    items: items as NormaliseRequestItem[],
    enabledGroups: enabledGroups.filter(isNormaliseGroup),
  };
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
  const [preparingPaths, setPreparingPaths] = useState<string[] | null>(null);
  const prepareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (prepareTimerRef.current !== null) {
        clearTimeout(prepareTimerRef.current);
      }
    },
    [],
  );

  const config = useMemo<BatchJobConfig<StartArgs>>(
    () => ({
      operationKind: "normalise",
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
      buildRunArgs: () => ({
        enabledGroups: stash.confirmedEnabledGroups,
      }),
      buildRecoveryRunArgs: () => ({
        enabledGroups: stash.confirmedEnabledGroups,
      }),
      totalItems: (args) => args.items.length,
      relativePaths: (args) => args.items.map((item) => item.relPath),
    }),
    [stash],
  );

  const job = useBatchImageJob<StartArgs, NormaliseEstimate, NormaliseSummary>(
    config,
    {
      sessionId: options.sessionId,
      operation: options.operation,
    },
  );

  useEffect(() => {
    const retained = retainedNormaliseRequest(options.operation);
    if (!retained) return;
    stash.items = retained.items;
    stash.enabledGroups = retained.enabledGroups;
    if (options.operation?.phase === "running") {
      stash.confirmedEnabledGroups = retained.enabledGroups;
    }
    setEnabledGroupsState(retained.enabledGroups);
  }, [options.operation, stash]);

  useEffect(() => {
    const estimate = job.state.estimate;
    if (!estimate) return;
    const candidates =
      stash.enabledGroups.length > 0
        ? stash.enabledGroups
        : (Object.keys(estimate.perGroupOutcomes) as NormaliseGroup[]);
    const filtered = candidates.filter((group) => {
      const counts = estimate.perGroupOutcomes[group];
      return (
        counts !== undefined &&
        counts.nNormalisedDeterministic +
          counts.nNormalisedAi +
          counts.nConflict >
          0
      );
    });
    if (
      filtered.length === stash.enabledGroups.length &&
      filtered.every((group, index) => group === stash.enabledGroups[index])
    ) {
      return;
    }
    stash.enabledGroups = filtered;
    setEnabledGroupsState(filtered);
  }, [job.state.estimate, stash]);

  const setEnabledGroups = (groups: NormaliseGroup[]) => {
    stash.enabledGroups = groups;
    setEnabledGroupsState(groups);
  };

  const startWithItems = (
    folderPath: string,
    items: NormaliseRequestItem[],
    initialEnabledGroups: NormaliseGroup[],
  ) => {
    stash.items = items;
    stash.enabledGroups = [...initialEnabledGroups];
    stash.confirmedEnabledGroups = [];
    setEnabledGroupsState(initialEnabledGroups);
    job.actions.start(folderPath, {
      items,
      enabledGroups: initialEnabledGroups,
    });
  };

  const actions: NormaliseActions = {
    start: startWithItems,
    startFromPaths: (
      folderPath,
      relPaths,
      initialEnabledGroups,
      buildItems,
    ) => {
      if (prepareTimerRef.current !== null) {
        clearTimeout(prepareTimerRef.current);
      }
      stash.items = [];
      stash.enabledGroups = [...initialEnabledGroups];
      stash.confirmedEnabledGroups = [];
      setEnabledGroupsState(initialEnabledGroups);
      setPreparingPaths([...relPaths]);
      prepareTimerRef.current = setTimeout(() => {
        prepareTimerRef.current = null;
        const items = buildItems();
        setPreparingPaths(null);
        startWithItems(folderPath, items, initialEnabledGroups);
      }, 0);
    },
    setEnabledGroups,
    confirm: () => {
      stash.confirmedEnabledGroups = structuredClone(stash.enabledGroups);
      job.actions.confirm();
    },
    cancel: () => {
      if (preparingPaths !== null) {
        if (prepareTimerRef.current !== null) {
          clearTimeout(prepareTimerRef.current);
          prepareTimerRef.current = null;
        }
        setPreparingPaths(null);
        stash.items = [];
        return;
      }
      job.actions.cancel();
    },
    close: () => {
      if (prepareTimerRef.current !== null) {
        clearTimeout(prepareTimerRef.current);
        prepareTimerRef.current = null;
      }
      setPreparingPaths(null);
      stash.items = [];
      stash.enabledGroups = [];
      stash.confirmedEnabledGroups = [];
      setEnabledGroupsState([]);
      job.actions.close();
    },
  };

  const preparingState: NormaliseProgressState | null =
    preparingPaths === null
      ? null
      : {
          phase: "estimating",
          preparing: true,
          total: preparingPaths.length,
          current: 0,
          currentFile: null,
          cancelling: false,
          failures: [],
          succeeded: [],
          summary: null,
          estimate: null,
          estimateError: null,
          items: [],
          enabledGroups: enabledGroupsState,
        };

  return {
    open: preparingState !== null || job.open,
    state:
      preparingState ??
      toNormaliseShape(job.state, stash.items, enabledGroupsState),
    actions,
  };
}
