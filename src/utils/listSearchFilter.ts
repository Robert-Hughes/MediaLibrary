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

function formatVariantForSearch(v: Variant | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return v.toString();
  if (Array.isArray(v)) return v.map(formatVariantForSearch).join(", ");
  return "";
}

/**
 * Build searchable text for one list row: path, OS timestamps as shown in the grid,
 * and all image metadata keys/values (including keys not shown as columns).
 */
export function buildListSearchHaystack(photo: PhotoInfo, meta: ImageMetadataState): string {
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

  return chunks.join("\n");
}

export function photoMatchesListSearch(
  photo: PhotoInfo,
  normalizedQuery: string,
  meta: ImageMetadataState,
): boolean {
  if (!normalizedQuery) return true;
  return haystackContainsNormalized(buildListSearchHaystack(photo, meta), normalizedQuery);
}

export function filterPhotosForListSearch(
  photos: PhotoInfo[],
  query: string,
  imageMetadata: ImageMetadataStore,
): PhotoInfo[] {
  const q = normalizeListSearchQuery(query);
  if (!q) return photos;
  return photos.filter((p) => photoMatchesListSearch(p, q, imageMetadata.get(p.relative_path)));
}
