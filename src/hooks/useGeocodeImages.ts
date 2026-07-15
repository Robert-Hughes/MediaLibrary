/**
 * Drives the reverse-geocoding flow end-to-end.
 *
 * Thin adapter around `useBatchImageJob`. The geocode flow has no
 * estimate phase (no cost to compute) — the hook jumps straight to
 * `awaiting-confirm` with the items the caller passed, then on
 * `confirm` invokes `geocode_images_cmd` and lets the backend's
 * `geocode_*` events drive the rest of the state machine.
 */
import { useMemo } from "react";
import type { GeneratedDraftStageResultV5 } from "../generatedTargetDrafts";
import type {
  GeocodeProgressState,
  GeocodeRequestItem,
  GeocodeSummary,
  MetadataDraftEntry,
} from "../types";
import {
  useBatchImageJob,
  type BatchJobConfig,
  type BatchJobState,
} from "./useBatchImageJob";

export interface GeocodeActions {
  /**
   * Start the flow for the given absolute folder + per-image
   * GPS-resolved items.
   *
   * The frontend resolves draft-GPS-vs-metadata-GPS precedence before
   * calling this; the backend just trusts the lat/lon it receives.
   * See docs/REVERSE_GEOCODE_PLAN.md §2.
   */
  start: (folderPath: string, items: GeocodeRequestItem[]) => void;
  confirm: () => void;
  cancel: () => void;
  close: () => void;
}

export interface UseGeocodeImagesOptions {
  onApplyEdits?: (
    relativePath: string,
    edits: MetadataDraftEntry[],
  ) => GeneratedDraftStageResultV5;
}

/**
 * Map the generic `BatchJobState` to the geocode-specific shape used by
 * `GeocodeProgressDialog`.
 *
 * Notable: the geocode flow has no estimating phase, so the shared
 * hook starts in `awaiting-confirm`. We squash any spurious
 * `estimating` value to `awaiting-confirm` here for type safety; the
 * generic hook should never produce it when no estimate command is
 * configured, but a stronger type at the hook level would require more
 * type plumbing than this small mapping is worth.
 */
function toGeocodeShape(
  s: BatchJobState<null, GeocodeSummary>,
  items: GeocodeRequestItem[],
): GeocodeProgressState {
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
  };
}

export function useGeocodeImages(options: UseGeocodeImagesOptions = {}): {
  open: boolean;
  state: GeocodeProgressState;
  actions: GeocodeActions;
} {
  // Capture the items the dialog was opened for. The generic
  // `BatchJobState.relPaths` field only carries string arrays, but
  // geocode passes typed `GeocodeRequestItem[]` — we stash the full
  // items separately so the dialog can read them back for its
  // "X of N have no GPS" line.
  //
  // The items are only needed while the dialog is open; resetting on
  // close happens implicitly because the next `start` overwrites them.
  // For simplicity we hold them in a ref-ish closure variable via a
  // shared mutable that the start callback updates.
  const itemsRef = useMemo<{ current: GeocodeRequestItem[] }>(
    () => ({ current: [] }),
    [],
  );

  const config = useMemo<
    BatchJobConfig<GeocodeRequestItem[], null, GeocodeSummary>
  >(
    () => ({
      eventPrefix: "geocode",
      commands: {
        // No estimate command — see file-level comment.
        run: "geocode_images_cmd",
        cancel: "cancel_geocode_cmd",
      },
      buildRunArgs: (folderPath, items) => ({ folderPath, items }),
      totalItems: (items) => items.length,
      relativePaths: (items) => items.map((item) => item.relPath),
      parseSummaryPayload: (raw) => raw as GeocodeSummary,
    }),
    [],
  );

  const job = useBatchImageJob<GeocodeRequestItem[], null, GeocodeSummary>(
    config,
    {
      onApplyEdits: options.onApplyEdits,
    },
  );

  // Wrap the generic `start` so we can stash the typed items.
  const wrappedActions: GeocodeActions = {
    start: (folderPath, items) => {
      itemsRef.current = items;
      job.actions.start(folderPath, items);
    },
    confirm: job.actions.confirm,
    cancel: job.actions.cancel,
    close: () => {
      itemsRef.current = [];
      job.actions.close();
    },
  };

  return {
    open: job.open,
    state: toGeocodeShape(job.state, itemsRef.current),
    actions: wrappedActions,
  };
}
