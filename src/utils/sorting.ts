import type { PhotoInfo, SortConfig, SortKey, Variant } from "../types";
import type { ImageMetadataStore } from "../types";

function getVariantAsString(v: Variant | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return v.toString();
  if (Array.isArray(v)) return v.map(getVariantAsString).join(", ");
  return "";
}

function compareByKey(a: PhotoInfo, b: PhotoInfo, key: SortKey, imageMetadata: ImageMetadataStore): number {
  let valA: string | number | null;
  let valB: string | number | null;

  if (key.columnType === "path") {
    valA = a.relative_path;
    valB = b.relative_path;
  } else if (key.columnType === "os") {
    valA = key.column === "date_modified" ? a.date_modified : a.date_created;
    valB = key.column === "date_modified" ? b.date_modified : b.date_created;
    // Nulls sort to the end regardless of direction
    if (valA === null && valB === null) return 0;
    if (valA === null) return 1;
    if (valB === null) return -1;
  } else {
    // image metadata — look up from store; photos still loading sort to the end
    const metaA = imageMetadata.get(a.relative_path);
    const metaB = imageMetadata.get(b.relative_path);
    const rawA = metaA === "loading" ? undefined : metaA[key.column];
    const rawB = metaB === "loading" ? undefined : metaB[key.column];
    valA = getVariantAsString(rawA);
    valB = getVariantAsString(rawB);
    // Empty strings (no value or still loading) sort to the end
    if (valA === "" && valB === "") return 0;
    if (valA === "") return 1;
    if (valB === "") return -1;
  }

  let cmp: number;
  if (typeof valA === "number" && typeof valB === "number") {
    cmp = valA - valB;
  } else {
    cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: "base" });
  }

  return key.direction === "asc" ? cmp : -cmp;
}

export function sortPhotos(
  photos: PhotoInfo[],
  sortConfig: SortConfig,
  imageMetadata: ImageMetadataStore,
): PhotoInfo[] {
  if (!sortConfig.primary) return photos;

  return [...photos].sort((a, b) => {
    const primary = compareByKey(a, b, sortConfig.primary!, imageMetadata);
    if (primary !== 0 || !sortConfig.secondary) return primary;
    return compareByKey(a, b, sortConfig.secondary, imageMetadata);
  });
}

/** Returns the next SortConfig when a column header is clicked. */
export function nextSortConfig(current: SortConfig, column: string, columnType: SortKey["columnType"]): SortConfig {
  const { primary } = current;

  if (primary && primary.column === column) {
    // Toggle direction on the current primary column
    return {
      primary: { ...primary, direction: primary.direction === "asc" ? "desc" : "asc" },
      secondary: current.secondary,
    };
  }

  // New column: becomes primary asc; old primary demoted to secondary
  return {
    primary: { column, columnType, direction: "asc" },
    secondary: primary ?? null,
  };
}
