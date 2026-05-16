/**
 * Drives the AI-description flow end-to-end.
 *
 * Returns a `state` object the dialog renders, and a set of action
 * handlers (`start`, `confirm`, `cancel`, `close`). The hook owns:
 *
 *  - Tauri event subscriptions for estimate + run phases.
 *  - A single state machine across phases — the dialog never closes
 *    between estimating, awaiting-confirm, running, and done.
 *  - Cancellation that targets the same backend flag in either phase.
 *
 * Tests can drive this by stubbing `invoke` and emitting events through
 * the mock `listen`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DescribeProgressState,
  DescribeFailure,
  DescribeUsageSummary,
  DraftEdit,
} from "../types";

const INITIAL_HIDDEN: DescribeProgressState = {
  phase: "estimating",
  total: 0,
  current: 0,
  currentFile: null,
  cancelling: false,
  failures: [],
  succeeded: [],
  estimate: null,
  estimateError: null,
  usageSummary: null,
  relPaths: [],
};

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
   * persists via the existing save_draft_edits_typed pipeline).
   *
   * Keeping persistence in the caller — rather than the backend writing
   * directly to draft_edits.jsonl — means the UI re-renders immediately
   * and there is exactly one writer to the typed-draft store.
   */
  onApplyEdits?: (relativePath: string, edits: Record<string, DraftEdit>) => void;
}

export function useDescribeImages(options: UseDescribeImagesOptions = {}): {
  open: boolean;
  state: DescribeProgressState;
  actions: DescribeActions;
} {
  // Hold the latest callback in a ref so the event subscription effect
  // doesn't have to resubscribe whenever the parent re-renders with a
  // fresh `onApplyEdits` closure.
  const onApplyEditsRef = useRef(options.onApplyEdits);
  onApplyEditsRef.current = options.onApplyEdits;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DescribeProgressState>(INITIAL_HIDDEN);
  // Folder remembered for the confirm step (the run command needs it too).
  const folderRef = useRef<string>("");

  // Subscribe to all describe events while open. Unsubscribe on close.
  useEffect(() => {
    if (!open) return;
    const unlisteners: UnlistenFn[] = [];
    let mounted = true;

    const sub = async <T,>(evt: string, h: (p: T) => void) => {
      const off = await listen<T>(evt, (e) => mounted && h(e.payload));
      unlisteners.push(off);
    };

    sub<{ total: number }>("describe_estimate_started", (p) => {
      setState((s) => ({ ...s, phase: "estimating", total: p.total, current: 0 }));
    });
    sub<{ current: number; total: number; relativePath: string }>(
      "describe_estimate_progress", (p) => {
        setState((s) => ({
          ...s,
          phase: "estimating",
          current: p.current,
          total: p.total,
          currentFile: p.relativePath,
        }));
      }
    );
    sub<{ relativePath: string; message: string }>(
      "describe_estimate_error", (p) => {
        setState((s) => ({
          ...s,
          estimateError: `${p.relativePath}: ${p.message}`,
        }));
      }
    );
    sub<{
      totalInputTokens: number;
      predictedCostUsd: number;
      upperBoundCostUsd: number;
      model: string;
    }>("describe_estimate_complete", (p) => {
      setState((s) => ({
        ...s,
        phase: "awaiting-confirm",
        currentFile: null,
        estimate: {
          totalInputTokens: p.totalInputTokens,
          predictedCostUsd: p.predictedCostUsd,
          upperBoundCostUsd: p.upperBoundCostUsd,
          model: p.model,
        },
      }));
    });

    sub<{ total: number }>("describe_started", (p) => {
      setState((s) => ({ ...s, phase: "running", total: p.total, current: 0, currentFile: null }));
    });
    sub<{
      current: number;
      total: number;
      relativePath: string;
      status: string;
      error: string | null;
      edits?: Record<string, DraftEdit>;
    }>("describe_progress", (p) => {
      if (p.status === "ok" && p.edits) {
        // Fire-and-forget: the parent's setDraftBatch is synchronous and
        // schedules its own persistence. We don't await it here so a slow
        // save doesn't stall the progress UI.
        onApplyEditsRef.current?.(p.relativePath, p.edits);
      }
      setState((s) => {
        const failures = p.status !== "ok"
          ? [...s.failures, { relativePath: p.relativePath, kind: p.status, detail: p.error ?? "" }]
          : s.failures;
        const succeeded = p.status === "ok" ? [...s.succeeded, p.relativePath] : s.succeeded;
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
    sub<{
      succeeded: string[];
      failed: DescribeFailure[];
      usageSummary: DescribeUsageSummary;
    }>("describe_complete", (p) => {
      setState((s) => ({
        ...s,
        phase: "done",
        cancelling: false,
        // Trust the authoritative backend summary on done.
        succeeded: p.succeeded,
        failures: p.failed,
        usageSummary: p.usageSummary,
      }));
    });

    return () => {
      mounted = false;
      for (const off of unlisteners) off();
    };
  }, [open]);

  const start = useCallback((folderPath: string, relPaths: string[]) => {
    folderRef.current = folderPath;
    setState({
      ...INITIAL_HIDDEN,
      total: relPaths.length,
      relPaths,
    });
    setOpen(true);
    // Fire-and-forget — events drive the state machine. Errors surface as
    // describe_estimate_error.
    void invoke("estimate_describe_cost_cmd", { folderPath, relPaths })
      .catch((e: unknown) => {
        // Top-level failures (e.g. missing API key) — fall through to done
        // with the failure noted so the user sees something rather than a
        // silent dialog.
        setState((s) => ({
          ...s,
          phase: "done",
          estimateError: String(e),
          failures: relPaths.map((rp) => ({
            relativePath: rp, kind: "preflight_failed", detail: String(e),
          })),
        }));
      });
  }, []);

  const confirm = useCallback(() => {
    const folder = folderRef.current;
    setState((s) => {
      void invoke("describe_images_cmd", { folderPath: folder, relPaths: s.relPaths })
        .catch((e: unknown) => {
          setState((curr) => ({
            ...curr,
            phase: "done",
            failures: [...curr.failures, {
              relativePath: "(batch)", kind: "command_failed", detail: String(e),
            }],
          }));
        });
      return { ...s, phase: "running", current: 0, currentFile: null };
    });
  }, []);

  const cancel = useCallback(() => {
    setState((s) => ({ ...s, cancelling: true }));
    void invoke("cancel_describe_cmd").catch(() => {/* best effort */});
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setState(INITIAL_HIDDEN);
  }, []);

  return { open, state, actions: { start, confirm, cancel, close } };
}
