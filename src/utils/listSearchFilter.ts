import type { ImageMetadataState, ImageMetadataStore, PhotoInfo, Variant } from "../types";
import { haystackContainsNormalized, normalizeListSearchQuery } from "./listSearchText";

/** Match ISO 8601-ish years and paths; same semantics as PhotoRow date cells. */
export function formatPhotoRowDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

import { variantToDisplayString } from "../draft";

function formatVariantForSearch(v: Variant | undefined): string {
  return variantToDisplayString(v);
}

/**
 * Build searchable text for one list row: path, OS timestamps as shown in the grid,
 * and all image metadata keys/values (including keys not shown as columns).
 */
export function buildListSearchHaystack(photo: PhotoInfo, meta: ImageMetadataState, edits?: Record<string, string | null>): string {
  const chunks: string[] = [
    photo.relative_path,
    photo.filename,
    formatPhotoRowDate(photo.date_modified),
    formatPhotoRowDate(photo.date_created),
  ];

  if (meta && meta !== "loading" && typeof meta === "object") {
    for (const [key, value] of Object.entries(meta)) {
      if (key === "_error") continue;
      chunks.push(key, formatVariantForSearch(value as Variant));
    }
  }

  if (edits) {
    for (const [key, value] of Object.entries(edits)) {
      chunks.push(key, value === null ? "—" : value);
    }
  }

  return chunks.join("\n");
}

export function photoMatchesListSearch(
  photo: PhotoInfo,
  normalizedQuery: string,
  meta: ImageMetadataState,
  edits?: Record<string, string | null>,
): boolean {
  if (!normalizedQuery) return true;
  return haystackContainsNormalized(buildListSearchHaystack(photo, meta, edits), normalizedQuery);
}

export function filterPhotosForListSearch(
  photos: PhotoInfo[],
  query: string,
  imageMetadata: ImageMetadataStore,
  draftEdits?: Record<string, Record<string, string | null>>
): PhotoInfo[] {
  let q = normalizeListSearchQuery(query);
  const hasEditsFilter = q.includes("has:edits");
  if (hasEditsFilter) {
    q = q.replace("has:edits", "").trim();
  }

  if (!q && !hasEditsFilter) return photos;

  return photos.filter((p) => {
    if (hasEditsFilter) {
      const edits = draftEdits?.[p.relative_path];
      if (!edits || Object.keys(edits).length === 0) {
        return false;
      }
    }
    if (!q) return true;
    return photoMatchesListSearch(p, q, imageMetadata.get(p.relative_path), draftEdits?.[p.relative_path]);
  });
}
