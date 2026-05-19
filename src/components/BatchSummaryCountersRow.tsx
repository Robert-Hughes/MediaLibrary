/**
 * Shared renderer for the "label: bold-value · label: bold-value · …"
 * row used in batch-job done-panel summaries.
 *
 * Both the reverse-geocode and AI-describe summary panels (and the
 * planned normaliser per-group breakdown — see
 * `docs/NORMALISE_METADATA_PLAN.md` §10) have rows of this shape. The
 * inline JSX is small but identical, and we'd rather not copy the
 * separator/bold idiom a third time when normaliser lands.
 *
 * **Not** a general-purpose summary panel — only the inner row. Callers
 * compose multiple rows themselves and may interleave bespoke content
 * (e.g. describe's predicted-vs-actual percentage), which is why the
 * existing describe summary keeps its custom JSX.
 */
import { Fragment, type ReactNode } from "react";

export interface SummaryCounter {
  /** Plain-text label shown before the value (e.g. "Cache hits"). */
  label: string;
  /** Value rendered bold. Pass any ReactNode for formatted numbers. */
  value: ReactNode;
  /** Skip this counter when `false`. Useful for "cached: N" subtotals
   *  that only render when N > 0. Defaults to `true`. */
  show?: boolean;
}

export interface BatchSummaryCountersRowProps {
  counters: SummaryCounter[];
  /** Forwarded to the wrapping `<div>` so dialog tests can target it. */
  "data-testid"?: string;
}

export function BatchSummaryCountersRow({
  counters,
  ...rest
}: BatchSummaryCountersRowProps) {
  const visible = counters.filter((c) => c.show !== false);
  return (
    <div data-testid={rest["data-testid"]}>
      {visible.map((c, i) => (
        <Fragment key={c.label}>
          {i > 0 && " · "}
          {c.label}: <strong>{c.value}</strong>
        </Fragment>
      ))}
    </div>
  );
}
