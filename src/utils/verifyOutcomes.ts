/**
 * Pure reducer helpers for the `verifyOutcomes` map.
 *
 * The map shape is `Record<relativePath, TagOutcomeEntry[]>`; mutators
 * either merge a fresh batch from an `apply_edits_progress` payload or
 * drop a single (path, tag) entry, removing the path key entirely when
 * its list goes empty.
 */
import type { MetadataTagOutcome, TagOutcomeEntry } from "../types";

/**
 * Subset of TagOutcome.kind that requires user attention. Match and
 * DeleteOk are handled silently by the apply path (draft pruning) and
 * never reach this map.
 */
const INTERESTING_KINDS = new Set([
  "Coerced",
  "Mismatch",
  "MissingPostWrite",
  "DeleteLingering",
]);

export function isInterestingOutcome(o: MetadataTagOutcome): boolean {
  return INTERESTING_KINDS.has(o.kind);
}

/**
 * Merge a fresh batch of per-tag outcomes for one file into the existing
 * map. Per-tag deduping: the latest verdict for a tag replaces any
 * prior entry so re-applies are idempotent.
 *
 * Returns the existing reference unchanged when the batch carries no
 * interesting outcomes — caller can use that to skip a setState.
 */
export function mergeVerifyOutcomes(
  existing: Record<string, TagOutcomeEntry[]>,
  relativePath: string,
  fileOutcomes: MetadataTagOutcome[],
): Record<string, TagOutcomeEntry[]> {
  const interesting = fileOutcomes.filter(isInterestingOutcome);
  if (interesting.length === 0) return existing;

  const next = { ...existing };
  const prior = next[relativePath] ?? [];
  const merged = [...prior];
  for (const o of interesting) {
    const entry: TagOutcomeEntry = {
      tag: o.tag,
      kind: o.kind,
      sent: o.sent,
      beforeDisplay: o.before_display,
      observedDisplay: o.observed_display,
      observedRaw: o.observed_raw,
      message: o.message,
    };
    const idx = merged.findIndex((m) => m.tag === o.tag);
    if (idx >= 0) merged[idx] = entry;
    else merged.push(entry);
  }
  next[relativePath] = merged;
  return next;
}

/**
 * Drop a single (path, tag) entry. Returns the original reference when
 * the entry was already absent so callers can short-circuit setState.
 */
export function removeVerifyOutcome(
  existing: Record<string, TagOutcomeEntry[]>,
  relativePath: string,
  tag: string,
): Record<string, TagOutcomeEntry[]> {
  const list = existing[relativePath];
  if (!list) return existing;
  const remaining = list.filter((o) => o.tag !== tag);
  if (remaining.length === list.length) return existing;
  const next = { ...existing };
  if (remaining.length === 0) delete next[relativePath];
  else next[relativePath] = remaining;
  return next;
}
