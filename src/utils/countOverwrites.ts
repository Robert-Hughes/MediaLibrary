/**
 * Pure helpers that count how many of the selected images already
 * carry data the next batch run would overwrite. Used by App to feed
 * the inline overwrite notice rendered in each batch dialog's
 * awaiting-confirm panel. The same logic previously lived per-flow in
 * PhotoList / DetailsPane (computed at click time to drive a pre-dialog
 * `ask()`); pulling it into a single place keeps the three flows
 * consistent.
 */
import { GEOCODE_TARGET_TAGS } from "../types";
import type { DraftEdit, ImageMetadataStore } from "../types";

export interface OverwriteCount {
  existingCount: number;
  totalCount: number;
}

function metaBag(
  imageMetadata: ImageMetadataStore,
  relPath: string,
): Record<string, unknown> | undefined {
  const meta = imageMetadata.get(relPath);
  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)
    : undefined;
}

export function countDescribeOverwrites(
  relPaths: string[],
  imageMetadata: ImageMetadataStore,
  draftEdits: Record<string, Record<string, DraftEdit>>,
): OverwriteCount {
  const key = "XMP-mlib:AIDescription";
  let existing = 0;
  for (const p of relPaths) {
    const m = metaBag(imageMetadata, p);
    const inMeta = m != null && key in m;
    const inDraft = key in (draftEdits[p] ?? {});
    if (inMeta || inDraft) existing++;
  }
  return { existingCount: existing, totalCount: relPaths.length };
}

export function countGeocodeOverwrites(
  relPaths: string[],
  imageMetadata: ImageMetadataStore,
  draftEdits: Record<string, Record<string, DraftEdit>>,
): OverwriteCount {
  let existing = 0;
  for (const p of relPaths) {
    const m = metaBag(imageMetadata, p) ?? {};
    const d = draftEdits[p] ?? {};
    const hit = GEOCODE_TARGET_TAGS.some((k) => k in m || k in d);
    if (hit) existing++;
  }
  return { existingCount: existing, totalCount: relPaths.length };
}
