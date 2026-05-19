/**
 * Modal that drives the metadata-normalisation flow.
 *
 * v1 has no estimate phase (plan §7). Three phases:
 *
 *   awaiting-confirm → per-group checkbox list + overwrite warning;
 *                      user confirms or cancels.
 *   running          → progress bar, drafts arrive per image.
 *   done             → per-group breakdown of what was normalised.
 *
 * Thin wrapper around `BatchJobDialog` — the overlay, header, dialog
 * body frame and Escape handling live there.
 */
import type { NormaliseGroup, NormaliseSummary } from "../types";
import type { NormaliseProgressState } from "../hooks/useNormaliseMetadata";
import { BatchJobDialog } from "./BatchJobDialog";
import { BatchSummaryCountersRow } from "./BatchSummaryCountersRow";
import { RunningProgressPanel } from "./RunningProgressPanel";

export type { NormaliseProgressState };

interface Props {
  state: NormaliseProgressState;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
  onSetEnabledGroups: (groups: NormaliseGroup[]) => void;
}

/** Human-readable group label for the confirm-phase checkbox list. */
function groupLabel(g: NormaliseGroup): string {
  switch (g) {
    case "keywords": return "Keywords";
    case "creator": return "Creator";
    case "copyright": return "Copyright";
    case "headline": return "Headline";
    case "title": return "Title";
    case "location": return "Location (XMP ↔ IPTC mirror sync)";
    case "dates": return "Dates (DateTimeOriginal + CreateDate)";
    case "description":
      return "Description (AI merge — needs OpenAI key)";
  }
}

/** Groups the user can toggle. Group B (Description) requires an AI
 *  call when sources are distinct — but the deterministic branches
 *  (cases 1–3) still work without an API key, so we expose it always. */
const V1_GROUPS: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
  "headline",
  "title",
  "location",
  "dates",
  "description",
];

function phaseTitle(state: NormaliseProgressState): string {
  switch (state.phase) {
    case "awaiting-confirm":
      return "Normalise metadata";
    case "running":
      return state.cancelling ? "Cancelling…" : "Normalising metadata…";
    case "done":
      return "Done";
  }
}

function AwaitingConfirmPanel({
  state,
  onCancel,
  onConfirm,
  onSetEnabledGroups,
}: {
  state: NormaliseProgressState;
  onCancel: () => void;
  onConfirm: () => void;
  onSetEnabledGroups: (groups: NormaliseGroup[]) => void;
}) {
  const word = state.total === 1 ? "image" : "images";

  function toggle(g: NormaliseGroup) {
    const current = new Set(state.enabledGroups);
    if (current.has(g)) current.delete(g);
    else current.add(g);
    onSetEnabledGroups(V1_GROUPS.filter((x) => current.has(x)));
  }

  const noneEnabled = state.enabledGroups.length === 0;

  return (
    <>
      <div className="dialog-hint" data-testid="normalise-confirm-summary">
        Ready to normalise metadata for {state.total} {word}. Choose which
        groups to normalise — drafts are proposed; nothing is written to
        disk until you apply them.
      </div>
      <div
        style={{ marginTop: 12, fontSize: 13 }}
        data-testid="normalise-group-checklist"
      >
        {V1_GROUPS.map((g) => {
          const checked = state.enabledGroups.includes(g);
          return (
            <label
              key={g}
              style={{
                display: "block",
                padding: "4px 0",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(g)}
                data-testid={`normalise-group-${g}-checkbox`}
              />{" "}
              {groupLabel(g)}
            </label>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          color: "var(--accent-error, #d33)",
        }}
      >
        Existing values in any chosen group <strong>will be overwritten</strong>{" "}
        with drafts — including any unapplied drafts you may already have.
        Fields outside the canonical form for each group will be cleared.
      </div>
      <div
        style={{
          marginTop: 20,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        <button
          className="button button--secondary"
          onClick={onCancel}
          data-testid="normalise-cancel-btn"
        >
          Cancel
        </button>
        <button
          className="button button--primary"
          onClick={onConfirm}
          data-testid="normalise-confirm-btn"
          autoFocus
          disabled={noneEnabled}
          title={noneEnabled ? "Enable at least one group to continue" : ""}
        >
          Confirm and normalise
        </button>
      </div>
    </>
  );
}

function SummaryBreakdown({ s }: { s: NormaliseSummary }) {
  return (
    <div
      style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
      data-testid="normalise-summary-breakdown"
    >
      <BatchSummaryCountersRow
        counters={[
          { label: "Groups normalised", value: s.nGroupsNormalisedTotal },
          { label: "Groups skipped (already normalised)", value: s.nGroupsNoopTotal },
        ]}
      />
      <BatchSummaryCountersRow
        counters={[
          {
            label: "Location XMP↔IPTC conflicts",
            value: s.nLocationXmpIimConflictTotal,
            show: s.nLocationXmpIimConflictTotal > 0,
          },
          {
            label: "Date conflicts",
            value: s.nDateConflictTotal,
            show: s.nDateConflictTotal > 0,
          },
          {
            label: "DTO from filename",
            value: s.nDtoFromFilenameTotal,
            show: s.nDtoFromFilenameTotal > 0,
          },
          {
            label: "DTO from filename (date only)",
            value: s.nDtoFromFilenameDateOnlyTotal,
            show: s.nDtoFromFilenameDateOnlyTotal > 0,
          },
          {
            label: "Unparseable date inputs",
            value: s.nUnparseableDateInputsTotal,
            show: s.nUnparseableDateInputsTotal > 0,
          },
          {
            label: "AI description merges",
            value: s.nAiDescriptionMergedTotal,
            show: s.nAiDescriptionMergedTotal > 0,
          },
          {
            label: "AI titles generated",
            value: s.nAiTitleGeneratedTotal,
            show: s.nAiTitleGeneratedTotal > 0,
          },
          {
            label: "AI errors",
            value: s.nAiErrorsTotal,
            show: s.nAiErrorsTotal > 0,
          },
        ]}
      />
    </div>
  );
}

export function NormaliseProgressDialog({
  state,
  onConfirm,
  onCancel,
  onClose,
  onSetEnabledGroups,
}: Props) {
  return (
    <BatchJobDialog
      testidPrefix="normalise"
      width={560}
      phase={state.phase}
      title={phaseTitle(state)}
      onCancel={onCancel}
      onClose={onClose}
    >
      {state.phase === "awaiting-confirm" && (
        <AwaitingConfirmPanel
          state={state}
          onCancel={onCancel}
          onConfirm={onConfirm}
          onSetEnabledGroups={onSetEnabledGroups}
        />
      )}
      {state.phase === "running" && (
        <RunningProgressPanel
          current={state.current}
          total={state.total}
          currentFile={state.currentFile}
          cancelling={state.cancelling}
          onCancel={onCancel}
          testidPrefix="normalise"
          noun="image"
          footer="Each result lands in drafts as soon as it arrives. Cancelling preserves results already returned."
        />
      )}
      {state.phase === "done" && (
        <>
          <div className="dialog-hint" data-testid="normalise-done-summary">
            Completed: <strong>{state.succeeded.length}</strong> /{" "}
            <strong>{state.total}</strong>{" "}
            {state.total === 1 ? "image" : "images"}
            {state.summary != null && state.summary.nSkippedAllNormalised > 0 && (
              <>
                {" — "}
                <strong>{state.summary.nSkippedAllNormalised}</strong> already
                normalised (no changes)
              </>
            )}
          </div>
          {state.summary && <SummaryBreakdown s={state.summary} />}
          {state.failures.length > 0 && (
            <details
              style={{ marginTop: 12 }}
              data-testid="normalise-failure-list"
            >
              <summary
                style={{ cursor: "pointer", color: "var(--accent-error, #d33)" }}
              >
                {state.failures.length} failed
              </summary>
              <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12 }}>
                {state.failures.map((f) => (
                  <li key={f.relativePath} title={`${f.kind}: ${f.detail}`}>
                    <strong>{f.relativePath}</strong>: {f.detail || f.kind}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div
            style={{
              marginTop: 20,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              className="button button--primary"
              onClick={onClose}
              data-testid="normalise-close-btn"
              autoFocus
            >
              Close
            </button>
          </div>
        </>
      )}
    </BatchJobDialog>
  );
}
