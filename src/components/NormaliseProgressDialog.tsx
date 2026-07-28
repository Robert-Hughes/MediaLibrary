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
import type {
  NormaliseEstimate,
  NormaliseGroup,
  NormaliseSummary,
} from "../types";
import { useRef } from "react";
import { ALL_NORMALISE_GROUPS, NORMALISE_TARGET_TAGS_BY_GROUP } from "../types";
import type { NormaliseProgressState } from "../hooks/useNormaliseMetadata";
import { BatchJobDialog } from "./BatchJobDialog";
import { BatchSummaryCountersRow } from "./BatchSummaryCountersRow";
import { RunningProgressPanel } from "./RunningProgressPanel";
import { friendlyNormaliseFailureLabel } from "./batchHelpers";

export type { NormaliseProgressState };

interface Props {
  state: NormaliseProgressState;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
  onSetEnabledGroups: (groups: NormaliseGroup[]) => void;
}

/** Human-readable group label for the confirm-phase table. */
function groupLabel(g: NormaliseGroup): string {
  switch (g) {
    case "keywords":
      return "Keywords";
    case "creator":
      return "Creator";
    case "copyright":
      return "Copyright";
    case "headline":
      return "Headline";
    case "title":
      return "Title";
    case "location":
      return "Location";
    case "dates":
      return "Dates";
    case "description":
      return "Description";
    case "iptc_utf8":
      return "IPTC UTF-8";
  }
}

/** Groups whose normalisation may invoke an AI call. */
const AI_GROUPS: ReadonlySet<NormaliseGroup> = new Set([
  "description",
  "title",
  "location",
]);

/**
 * Short paragraph describing what the group does, surfaced as a
 * tooltip on the group name in the confirm-phase table. Mentions the
 * AI behaviour only for the groups that can actually invoke a model.
 */
function groupBehaviourSummary(g: NormaliseGroup): string {
  switch (g) {
    case "keywords":
      return "Writes target fields: XMP-lr:HierarchicalSubject, XMP-dc:Subject, and IPTC:Keywords. Reads read-only inputs: XMP-mlib:AITags and XMP-mlib:AIObjects. Behaviour: Unions existing keywords and AI inputs, normalises casing/separators, and mirrors hierarchical/flat projections. If all keyword and AI inputs are empty, no drafts.";
    case "creator":
      return "Writes target fields: XMP-dc:Creator, IFD0:Artist, and IPTC:By-line. Behaviour: Unions and deduplicates creator names preserving first-seen order. If all creator fields are empty, no drafts. No AI.";
    case "copyright":
      return "Writes target fields: XMP-dc:Rights, IFD0:Copyright, and IPTC:CopyrightNotice. Behaviour: Picks XMP rights if present, otherwise the longest derivative copyright notice. If all copyright fields are empty, no drafts. No AI.";
    case "headline":
      return "Writes target fields: XMP-photoshop:Headline and IPTC:Headline. Behaviour: Picks photoshop headline if present, otherwise IPTC headline. If both are empty, no drafts. No AI.";
    case "title":
      return "Writes target fields: XMP-dc:Title and IPTC:ObjectName. Reads description canonical plus keyword and location context. Behaviour: Existing XMP-dc:Title wins; otherwise IPTC:ObjectName wins. If both title targets are empty and Description canonical is available (including newly regenerated Description), calls AI to generate a short title. If both are empty and no description is available, no drafts.";
    case "location":
      return "Writes canonical XMP-iptcExt:LocationCreated and projects it to XMP-iptcCore:Location, IPTC:Sub-location, the City pair, the Province/State pair, the Country pair, and the CountryCode pair. For useful legacy display, LocationName is preferred over Sublocation. If one LocationCreated structure exists, trusts and projects it without AI. If it is absent and XMP-mlib:ReverseGeocodeGeocodeJSON or XMP-mlib:ReverseGeocodeJSONv2 evidence exists, calls AI to resolve human-facing place names, then adds coordinates, country code, and OSM identifiers deterministically. With no reverse-geocode evidence, legacy fields seed LocationCreated deterministically.";
    case "dates":
      return "Writes target fields: ExifIFD:DateTimeOriginal, ExifIFD:CreateDate, XMP-photoshop:DateCreated, IPTC:DateCreated, IPTC:TimeCreated, XMP-xmp:CreateDate, IPTC:DigitalCreationDate, and IPTC:DigitalCreationTime. Reads offset/subsecond fields (ExifIFD:OffsetTimeOriginal, ExifIFD:SubSecTimeOriginal, ExifIFD:OffsetTimeDigitized, ExifIFD:OffsetTime, ExifIFD:SubSecTimeDigitized) and filename fallback input. Behaviour: Normalises dates to ISO 8601; EXIF primary wins on conflict. Falls back to filename matching for shutter time if all shutter-time fields are empty. No AI.";
    case "description":
      return "Writes target fields: XMP-dc:Description, IFD0:ImageDescription, and IPTC:Caption-Abstract. Reads read-only AI inputs: XMP-mlib:AIDescription, XMP-mlib:AIInterpretation, XMP-mlib:AIOcrText, and XMP-mlib:AIObjects; and context: canonical keywords, location, and date. Behaviour: Calls AI to merge description targets on disagreement, or to generate from AI context when targets are empty. If no target or AI context exists, no drafts.";
    case "iptc_utf8":
      return "Writes IPTC:CodedCharacterSet=UTF8. When applied, the write planner also rewrites existing non-ASCII IPTC text using its current effective value because changing the marker alone does not transcode existing bytes. No AI.";
  }
}

/**
 * Tooltip text shown on hover of the group name: the behaviour summary
 * followed by the list of metadata fields the group writes.
 */
function groupTooltip(g: NormaliseGroup): string {
  const fields = NORMALISE_TARGET_TAGS_BY_GROUP[g].join(", ");
  return `${groupBehaviourSummary(g)}\n\nFields: ${fields}`;
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
        {state.preparing ? "Preparing metadata for" : "Walking"} {state.total}{" "}
        {state.total === 1 ? "image" : "images"}
        {state.preparing ? "…" : " to estimate AI cost…"}
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
          style={{
            marginTop: 8,
            color: "var(--accent-error, #d33)",
            fontSize: 12,
          }}
          data-testid="normalise-estimate-error"
        >
          {state.estimateError}
        </div>
      )}
    </div>
  );
}

/** Result of `computeCostForSelection` — `null` fields mean the
 *  estimate didn't include a preflight (no API key, or no pricing for
 *  the configured model). */
interface SelectionCost {
  predictedUsd: number | null;
  upperBoundUsd: number | null;
  descriptionCalls: number;
  titleCalls: number;
  locationCalls: number;
  metadataModel: string;
  locationModel: string;
}

/**
 * Recompute predicted / upper-bound cost for the currently-selected
 * groups. Pure function of the estimate (which always carries AI
 * counts for both Description and Title regardless of selection) and
 * the user's checkbox state.
 */
function computeCostForSelection(
  estimate: NormaliseEstimate,
  enabledGroups: readonly NormaliseGroup[],
): SelectionCost {
  const descEnabled = enabledGroups.includes("description");
  const titleEnabled = enabledGroups.includes("title");
  const locationEnabled = enabledGroups.includes("location");
  const breakdown = estimate.aiTokenBreakdown;
  const pricing = estimate.pricing;
  const locationPricing = estimate.locationPricing;
  const descCalls = descEnabled ? estimate.nImagesWithAiB : 0;
  const titleCalls = titleEnabled ? estimate.nImagesWithAiC : 0;
  const locationCalls = locationEnabled ? estimate.nImagesWithAiG : 0;
  const needsMetadataPricing = descCalls + titleCalls > 0;
  const needsLocationPricing = locationCalls > 0;
  if (
    !breakdown ||
    (needsMetadataPricing && !pricing) ||
    (needsLocationPricing && !locationPricing)
  ) {
    return {
      predictedUsd: null,
      upperBoundUsd: null,
      descriptionCalls: descCalls,
      titleCalls,
      locationCalls,
      metadataModel: estimate.model,
      locationModel: estimate.locationModel,
    };
  }
  const inputTokens =
    (descEnabled ? breakdown.descriptionInputTokens : 0) +
    (titleEnabled ? breakdown.titleInputTokens : 0);
  const locationInputTokens = locationEnabled
    ? breakdown.locationInputTokens
    : 0;
  const predictedOut =
    descCalls * estimate.expectedOutPerCallB +
    titleCalls * estimate.expectedOutPerCallC;
  const upperOut =
    descCalls * estimate.maxOutPerCallB + titleCalls * estimate.maxOutPerCallC;
  const locationPredictedOut = locationCalls * estimate.expectedOutPerCallG;
  const locationUpperOut = locationCalls * estimate.maxOutPerCallG;
  const inputCost =
    pricing == null ? 0 : (inputTokens / 1_000_000) * pricing.inputPer1M;
  const locationInputCost =
    locationPricing == null
      ? 0
      : (locationInputTokens / 1_000_000) * locationPricing.inputPer1M;
  const predicted =
    inputCost +
    (pricing == null ? 0 : (predictedOut / 1_000_000) * pricing.outputPer1M) +
    locationInputCost +
    (locationPricing == null
      ? 0
      : (locationPredictedOut / 1_000_000) * locationPricing.outputPer1M);
  const upper =
    inputCost +
    (pricing == null ? 0 : (upperOut / 1_000_000) * pricing.outputPer1M) +
    locationInputCost +
    (locationPricing == null
      ? 0
      : (locationUpperOut / 1_000_000) * locationPricing.outputPer1M);
  return {
    predictedUsd: predicted,
    upperBoundUsd: upper,
    descriptionCalls: descCalls,
    titleCalls,
    locationCalls,
    metadataModel: estimate.model,
    locationModel: estimate.locationModel,
  };
}

function CostPreview({
  estimate,
  enabledGroups,
}: {
  estimate: NormaliseEstimate;
  enabledGroups: readonly NormaliseGroup[];
}) {
  const cost = computeCostForSelection(estimate, enabledGroups);
  const hasAi =
    cost.descriptionCalls + cost.titleCalls + cost.locationCalls > 0;
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
  if (cost.predictedUsd == null || cost.upperBoundUsd == null) {
    return (
      <div
        style={{
          marginTop: 10,
          fontSize: 12,
          color: "var(--accent-error, #d33)",
        }}
        data-testid="normalise-cost-preview"
      >
        AI calls required ({cost.descriptionCalls} description AI call,{" "}
        {cost.titleCalls} title gen, {cost.locationCalls} location resolution)
        but no OpenAI key is configured — open Settings to enter your key before
        normalising.
      </div>
    );
  }
  return (
    <div
      style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}
      data-testid="normalise-cost-preview"
    >
      AI calls required:
      <ul style={{ marginTop: 4, paddingLeft: 18 }}>
        {cost.descriptionCalls > 0 && (
          <li>{cost.descriptionCalls} description AI calls</li>
        )}
        {cost.titleCalls > 0 && <li>{cost.titleCalls} title generations</li>}
        {cost.locationCalls > 0 && (
          <li>
            {cost.locationCalls} location resolutions with{" "}
            <code>{cost.locationModel}</code>
          </li>
        )}
        {cost.descriptionCalls + cost.titleCalls > 0 && (
          <li>
            Description/title model: <code>{cost.metadataModel}</code>
          </li>
        )}
      </ul>
      <div>
        <strong>Cost:</strong> {formatCost(cost.predictedUsd)} predicted, up to{" "}
        {formatCost(cost.upperBoundUsd)} worst case (output-token variation
        only).
      </div>
    </div>
  );
}

function emptyCounts() {
  return {
    nNoop: 0,
    nNormalisedDeterministic: 0,
    nNormalisedAi: 0,
    nConflict: 0,
    nOverwrites: 0,
  };
}

function iptcUtf8ApplicablePaths(
  estimate: NormaliseEstimate,
  enabledGroups: ReadonlySet<NormaliseGroup>,
): Set<string> {
  const paths = new Set(estimate.iptcUtf8BaseApplicablePaths ?? []);
  const byGroup = estimate.iptcUtf8OutputPathsByGroup ?? {};
  for (const group of enabledGroups) {
    if (group === "iptc_utf8") continue;
    for (const path of byGroup[group] ?? []) paths.add(path);
  }
  return paths;
}

/**
 * Per-group outcome table. Rows = the normalise groups; columns =
 * the four outcome buckets. Rows where every image is a no-op are
 * auto-disabled (and excluded from the selection) since enabling them
 * would be a no-op anyway. Conflict cell renders red when non-zero.
 */
function GroupOutcomeTable({
  estimate,
  enabledGroups,
  onSetEnabledGroups,
  total,
}: {
  estimate: NormaliseEstimate;
  enabledGroups: readonly NormaliseGroup[];
  onSetEnabledGroups: (g: NormaliseGroup[]) => void;
  total: number;
}) {
  const iptcUtf8ExplicitlyDisabled = useRef(false);

  function toggle(g: NormaliseGroup) {
    const current = new Set(enabledGroups);
    if (g === "iptc_utf8") {
      if (current.has(g)) {
        current.delete(g);
        iptcUtf8ExplicitlyDisabled.current = true;
      } else {
        current.add(g);
        iptcUtf8ExplicitlyDisabled.current = false;
      }
    } else {
      const wasApplicable = iptcUtf8ApplicablePaths(estimate, current).size > 0;
      if (current.has(g)) current.delete(g);
      else current.add(g);
      const isApplicable = iptcUtf8ApplicablePaths(estimate, current).size > 0;
      if (!isApplicable) {
        current.delete("iptc_utf8");
      } else if (!wasApplicable && !iptcUtf8ExplicitlyDisabled.current) {
        current.add("iptc_utf8");
      }
    }
    onSetEnabledGroups(V1_GROUPS.filter((x) => current.has(x)));
  }

  const cellBase: React.CSSProperties = {
    padding: "4px 8px",
    textAlign: "right" as const,
    fontVariantNumeric: "tabular-nums",
  };
  const headStyle: React.CSSProperties = {
    padding: "4px 8px",
    textAlign: "right" as const,
    fontWeight: 600,
    borderBottom: "1px solid var(--border-subtle, #ddd)",
  };

  function renderCount(n: number) {
    return <span>{n}</span>;
  }

  return (
    <table
      style={{
        marginTop: 12,
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
      }}
      data-testid="normalise-group-outcome-table"
    >
      <thead>
        <tr>
          <th style={{ ...headStyle, textAlign: "left", paddingLeft: 0 }}>
            Group
          </th>
          <th style={headStyle}>No change</th>
          <th style={headStyle}>Normalize</th>
          <th style={headStyle}>Normalize (AI)</th>
          <th style={headStyle}>Conflict</th>
          <th
            style={headStyle}
            title="Number of fields (across all selected images) where the current value would be replaced by a different value or removed. AI groups assume the output will always differ."
          >
            Overwrites
          </th>
        </tr>
      </thead>
      <tbody>
        {V1_GROUPS.map((g) => {
          const estimatedCounts = estimate.perGroupOutcomes[g] ?? emptyCounts();
          const prospectiveIptcCount =
            g === "iptc_utf8"
              ? iptcUtf8ApplicablePaths(estimate, new Set(enabledGroups)).size
              : null;
          const counts =
            prospectiveIptcCount == null
              ? estimatedCounts
              : {
                  ...estimatedCounts,
                  nNoop: total - prospectiveIptcCount,
                  nNormalisedDeterministic: prospectiveIptcCount,
                  nNormalisedAi: 0,
                  nConflict: 0,
                  nOverwrites:
                    prospectiveIptcCount === 0
                      ? 0
                      : estimatedCounts.nOverwrites,
                };
          const isAiGroup = AI_GROUPS.has(g);
          const allNoop =
            counts.nNormalisedDeterministic === 0 &&
            counts.nNormalisedAi === 0 &&
            counts.nConflict === 0;
          const checked = enabledGroups.includes(g);
          const disabled = allNoop;
          return (
            <tr
              key={g}
              data-testid={`normalise-group-row-${g}`}
              style={{
                borderBottom: "1px solid var(--border-subtle, #eee)",
              }}
            >
              <td style={{ padding: "4px 8px 4px 0", textAlign: "left" }}>
                <label style={{ cursor: disabled ? "default" : "pointer" }}>
                  <input
                    type="checkbox"
                    checked={checked && !disabled}
                    disabled={disabled}
                    onChange={() => toggle(g)}
                    data-testid={`normalise-group-${g}-checkbox`}
                  />{" "}
                  <span
                    title={groupTooltip(g)}
                    style={{
                      textDecoration: "underline dotted",
                      textUnderlineOffset: 2,
                      textDecorationColor: "var(--border-subtle, #bbb)",
                      cursor: "help",
                    }}
                    data-testid={`normalise-group-${g}-label`}
                  >
                    {groupLabel(g)}
                  </span>
                </label>
              </td>
              <td style={cellBase} data-testid={`normalise-group-${g}-noop`}>
                {renderCount(counts.nNoop)}
              </td>
              <td
                style={cellBase}
                data-testid={`normalise-group-${g}-deterministic`}
              >
                {renderCount(counts.nNormalisedDeterministic)}
              </td>
              <td style={cellBase} data-testid={`normalise-group-${g}-ai`}>
                {isAiGroup ? renderCount(counts.nNormalisedAi) : <span>—</span>}
              </td>
              <td
                style={{
                  ...cellBase,
                  color:
                    counts.nConflict > 0
                      ? "var(--accent-error, #d33)"
                      : undefined,
                  fontWeight: counts.nConflict > 0 ? 600 : undefined,
                }}
                data-testid={`normalise-group-${g}-conflict`}
              >
                {renderCount(counts.nConflict)}
              </td>
              <td
                style={{
                  ...cellBase,
                  color:
                    counts.nOverwrites > 0
                      ? "var(--accent-warning, #c70)"
                      : undefined,
                  fontWeight: counts.nOverwrites > 0 ? 600 : undefined,
                }}
                data-testid={`normalise-group-${g}-overwrites`}
              >
                {renderCount(counts.nOverwrites)}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td
            colSpan={6}
            style={{
              padding: "6px 0 0",
              fontSize: 12,
            }}
          >
            {total} {total === 1 ? "image" : "images"} · No change + Normalize +
            Normalize (AI) sum to {total} per row. Overwrites counts individual
            fields that would change. Rows with nothing to do are disabled.
          </td>
        </tr>
      </tfoot>
    </table>
  );
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

  const noneEnabled = state.enabledGroups.length === 0;

  return (
    <>
      <div className="dialog-hint" data-testid="normalise-confirm-summary">
        Ready to normalise metadata for {state.total} {word}. Choose which
        groups to normalise — drafts are proposed; nothing is written to disk
        until you apply them. The Overwrites column shows how many existing
        field values would be replaced.
      </div>
      {state.estimate && (
        <GroupOutcomeTable
          estimate={state.estimate}
          enabledGroups={state.enabledGroups}
          onSetEnabledGroups={onSetEnabledGroups}
          total={state.total}
        />
      )}
      {state.estimate && (
        <CostPreview
          estimate={state.estimate}
          enabledGroups={state.enabledGroups}
        />
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
          {
            label: "Groups normalised (deterministic)",
            value: totalDeterministic,
          },
          {
            label: "Groups normalised (AI)",
            value: totalAi,
            show: totalAi > 0,
          },
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
            const counters: Array<{
              label: string;
              value: number;
              show?: boolean;
            }> = [
              {
                label: "normalised",
                value: stats.nNormalisedDeterministic,
                show: stats.nNormalisedDeterministic > 0,
              },
              {
                label: "AI normalised",
                value: stats.nNormalisedAi,
                show: stats.nNormalisedAi > 0,
              },
              { label: "no-op", value: stats.nNoop, show: stats.nNoop > 0 },
              {
                label: "primary won",
                value: stats.nConflictPrimaryWon,
                show: stats.nConflictPrimaryWon > 0,
              },
              {
                label: "XMP↔IPTC conflicts",
                value: stats.nLocationXmpIimConflict,
                show: stats.nLocationXmpIimConflict > 0,
              },
              {
                label: "ambiguous LocationCreated",
                value: stats.nLocationCreatedAmbiguous,
                show: stats.nLocationCreatedAmbiguous > 0,
              },
              {
                label: "date conflicts",
                value: stats.nDateConflict,
                show: stats.nDateConflict > 0,
              },
              {
                label: "DTO from filename",
                value: stats.nDtoFromFilename,
                show: stats.nDtoFromFilename > 0,
              },
              {
                label: "DTO date-only fallback",
                value: stats.nDtoFromFilenameDateOnly,
                show: stats.nDtoFromFilenameDateOnly > 0,
              },
              {
                label: "unparseable dates",
                value: stats.nUnparseableDateInputs,
                show: stats.nUnparseableDateInputs > 0,
              },
              {
                label: "AI errors",
                value: stats.nAiErrors,
                show: stats.nAiErrors > 0,
              },
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
      {state.phase === "estimating" && (
        <EstimatingPanel state={state} onCancel={onCancel} />
      )}
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
            {state.summary != null &&
              state.summary.nSkippedAllNormalised > 0 && (
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
                style={{
                  cursor: "pointer",
                  color: "var(--accent-error, #d33)",
                }}
              >
                {state.failures.length} failed
              </summary>
              <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12 }}>
                {state.failures.map((f) => (
                  <li key={f.relativePath} title={`${f.kind}: ${f.detail}`}>
                    <strong>{f.relativePath}</strong>:{" "}
                    {friendlyNormaliseFailureLabel(f.kind)}
                    {f.detail && (
                      <>
                        {" — "}
                        <span style={{ color: "var(--text-secondary)" }}>
                          {f.detail}
                        </span>
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
