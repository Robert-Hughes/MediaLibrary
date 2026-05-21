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
import type { BatchFailureKind, NormaliseEstimate, NormaliseGroup, NormaliseSummary } from "../types";
import { ALL_NORMALISE_GROUPS } from "../types";
import type { NormaliseProgressState } from "../hooks/useNormaliseMetadata";
import { BatchJobDialog } from "./BatchJobDialog";
import { BatchSummaryCountersRow } from "./BatchSummaryCountersRow";
import { RunningProgressPanel } from "./RunningProgressPanel";
import { OverwriteNotice } from "./OverwriteNotice";
import { assertExhaustive } from "../utils/assertExhaustive";

export interface NormaliseOverwriteInfo {
  existingCount: number;
  totalCount: number;
}

/**
 * Map normaliser BatchFailureKind values to short labels. Plan §8
 * failure kinds are the AI-flavoured ones; non-AI groups never fail in
 * v2 so the deterministic kinds are listed for exhaustiveness only.
 */
export function friendlyNormaliseFailureLabel(kind: BatchFailureKind): string {
  switch (kind) {
    case "ai_call_failed":
      return "AI request failed";
    case "ai_schema_invalid":
      return "AI response did not match expected schema";
    case "ai_rate_limited":
      return "AI request rate-limited";
    case "audit_log_io":
      return "Could not write audit log";
    case "internal":
      return "Internal error";
    case "ai_key_missing":
      return "OpenAI API key not configured";
    case "cancelled":
      return "Cancelled";
    case "command_failed":
      return "Normalise command failed to start";
    case "preflight_failed":
      return "Cost estimate failed before any image was processed";
    case "http":
      return "API request failed";
    case "network":
      return "Network error";
    // Kinds that belong to other batch jobs; listed for exhaustiveness.
    case "decode":
    case "incomplete":
    case "refused":
    case "bad_json":
    case "usage_parse":
    case "no_gps":
    case "nominatim_empty":
    case "cache_io":
      return kind;
    default:
      return assertExhaustive(kind);
  }
}

export type { NormaliseProgressState };

interface Props {
  state: NormaliseProgressState;
  /**
   * Pre-computed by the caller: how many of the selected images
   * already carry data in any normalise target group (metadata or
   * drafts). When `existingCount > 0` the awaiting-confirm panel
   * surfaces an inline overwrite notice.
   */
  overwriteInfo?: NormaliseOverwriteInfo;
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

/** Groups the user can toggle. Sourced from the single app-wide
 *  constant so dialog + caller agree on the v1 set + pass order. */
const V1_GROUPS: readonly NormaliseGroup[] = ALL_NORMALISE_GROUPS;

function phaseTitle(state: NormaliseProgressState): string {
  switch (state.phase) {
    case "estimating":
      return "Estimating cost…";
    case "awaiting-confirm":
      return "Normalise metadata";
    case "running":
      return state.cancelling ? "Cancelling…" : "Normalising metadata…";
    case "done":
      return "Done";
  }
}

function formatCost(usd: number): string {
  if (usd < 0.01 && usd > 0) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function EstimatingPanel({
  state,
  onCancel,
}: {
  state: NormaliseProgressState;
  onCancel: () => void;
}) {
  return (
    <div data-testid="normalise-estimating-panel">
      <div className="dialog-hint">
        Walking {state.total} {state.total === 1 ? "image" : "images"} to
        estimate AI cost…
      </div>
      <RunningProgressPanel
        testidPrefix="normalise-estimate"
        current={state.current}
        total={state.total}
        currentFile={state.currentFile}
        cancelling={state.cancelling}
        onCancel={onCancel}
        noun="image"
      />
      {state.estimateError && (
        <div
          style={{ marginTop: 8, color: "var(--accent-error, #d33)", fontSize: 12 }}
          data-testid="normalise-estimate-error"
        >
          {state.estimateError}
        </div>
      )}
    </div>
  );
}

function CostPreview({ estimate }: { estimate: NormaliseEstimate }) {
  const hasAi = estimate.nImagesWithAiB + estimate.nImagesWithAiC > 0;
  if (!hasAi) {
    return (
      <div
        style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
        data-testid="normalise-cost-preview"
      >
        No AI calls required. Free.
      </div>
    );
  }
  return (
    <div
      style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
      data-testid="normalise-cost-preview"
    >
      AI calls required with model <code>{estimate.model}</code>:
      <ul style={{ marginTop: 4, paddingLeft: 18 }}>
        {estimate.nImagesWithAiB > 0 && (
          <li>{estimate.nImagesWithAiB} description merges</li>
        )}
        {estimate.nImagesWithAiC > 0 && (
          <li>{estimate.nImagesWithAiC} title generations</li>
        )}
        {estimate.nImagesNoAi > 0 && (
          <li>{estimate.nImagesNoAi} images run purely deterministically</li>
        )}
      </ul>
      <div>
        <strong>Cost:</strong> {formatCost(estimate.predictedCostUsd)} predicted,
        up to {formatCost(estimate.upperBoundCostUsd)} worst case (output-token
        variation only).
      </div>
    </div>
  );
}

function AwaitingConfirmPanel({
  state,
  overwriteInfo,
  onCancel,
  onConfirm,
  onSetEnabledGroups,
}: {
  state: NormaliseProgressState;
  overwriteInfo?: NormaliseOverwriteInfo;
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
      {state.estimate && <CostPreview estimate={state.estimate} />}
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
      {overwriteInfo ? (
        <OverwriteNotice
          testidPrefix="normalise"
          input={{
            existingCount: overwriteInfo.existingCount,
            totalCount: overwriteInfo.totalCount,
            title: "Overwrite metadata fields?",
            subjectSingular: "image",
            subjectPlural: "images",
            dataPhrase: "metadata in the groups you have selected",
            actionSingle:
              "Normalising will overwrite those fields with drafts — fields outside the canonical form will be cleared.",
            actionPluralAll:
              "Normalising will overwrite those fields with drafts — fields outside the canonical form will be cleared.",
            actionPluralPartial:
              "Normalising will overwrite those fields with drafts for those images — fields outside the canonical form will be cleared.",
          }}
        />
      ) : (
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
      )}
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
  // Group ordering used in the awaiting-confirm checklist; re-used so
  // the done-panel breakdown reads in the same order users selected
  // the groups in.
  const groupOrder: readonly NormaliseGroup[] = V1_GROUPS;

  // Roll up a few totals across all groups for the headline strip so
  // users see the overall counts before drilling into per-group rows.
  let totalDeterministic = 0;
  let totalAi = 0;
  let totalNoop = 0;
  const perGroup = s.perGroup ?? {};
  for (const g of Object.values(perGroup)) {
    if (!g) continue;
    totalDeterministic += g.nNormalisedDeterministic;
    totalAi += g.nNormalisedAi;
    totalNoop += g.nNoop;
  }

  return (
    <div
      style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
      data-testid="normalise-summary-breakdown"
    >
      <BatchSummaryCountersRow
        counters={[
          { label: "Groups normalised (deterministic)", value: totalDeterministic },
          { label: "Groups normalised (AI)", value: totalAi, show: totalAi > 0 },
          { label: "Groups skipped (already normalised)", value: totalNoop },
        ]}
      />
      {s.aiCallsTotal > 0 && (
        <BatchSummaryCountersRow
          counters={[
            { label: "AI calls", value: s.aiCallsTotal },
            {
              label: "AI cost",
              value: `$${s.aiCostTotalUsd < 0.01 ? s.aiCostTotalUsd.toFixed(4) : s.aiCostTotalUsd.toFixed(2)}`,
            },
          ]}
        />
      )}
      <div
        style={{ marginTop: 10, fontSize: 12 }}
        data-testid="normalise-per-group-breakdown"
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Per group</div>
        {groupOrder
          .filter((g) => perGroup[g])
          .map((g) => {
            const stats = perGroup[g]!;
            const counters: Array<{ label: string; value: number; show?: boolean }> = [
              { label: "normalised", value: stats.nNormalisedDeterministic, show: stats.nNormalisedDeterministic > 0 },
              { label: "AI normalised", value: stats.nNormalisedAi, show: stats.nNormalisedAi > 0 },
              { label: "no-op", value: stats.nNoop, show: stats.nNoop > 0 },
              { label: "primary won", value: stats.nConflictPrimaryWon, show: stats.nConflictPrimaryWon > 0 },
              { label: "XMP↔IPTC conflicts", value: stats.nLocationXmpIimConflict, show: stats.nLocationXmpIimConflict > 0 },
              { label: "date conflicts", value: stats.nDateConflict, show: stats.nDateConflict > 0 },
              { label: "DTO from filename", value: stats.nDtoFromFilename, show: stats.nDtoFromFilename > 0 },
              { label: "DTO date-only fallback", value: stats.nDtoFromFilenameDateOnly, show: stats.nDtoFromFilenameDateOnly > 0 },
              { label: "unparseable dates", value: stats.nUnparseableDateInputs, show: stats.nUnparseableDateInputs > 0 },
              { label: "AI errors", value: stats.nAiErrors, show: stats.nAiErrors > 0 },
            ];
            const visible = counters.filter((c) => c.show);
            return (
              <div
                key={g}
                data-testid={`normalise-group-summary-${g}`}
                style={{
                  padding: "4px 0",
                  borderTop: "1px solid var(--border-subtle, #eee)",
                }}
              >
                <span style={{ fontWeight: 500 }}>{groupLabel(g)}: </span>
                {visible.length === 0 ? (
                  <span>no-op</span>
                ) : (
                  visible.map((c, i) => (
                    <span key={c.label}>
                      {i > 0 ? ", " : ""}
                      {c.value} {c.label}
                    </span>
                  ))
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

export function NormaliseProgressDialog({
  state,
  overwriteInfo,
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
      {state.phase === "estimating" && <EstimatingPanel state={state} onCancel={onCancel} />}
      {state.phase === "awaiting-confirm" && (
        <AwaitingConfirmPanel
          state={state}
          overwriteInfo={overwriteInfo}
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
                    <strong>{f.relativePath}</strong>: {friendlyNormaliseFailureLabel(f.kind)}
                    {f.detail && (
                      <>
                        {" — "}
                        <span style={{ color: "var(--text-secondary)" }}>{f.detail}</span>
                      </>
                    )}
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
