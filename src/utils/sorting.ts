import type { PhotoInfo, SortConfig, SortKey } from "../types";
import type { ImageMetadataStore } from "../types";
import { metadataEntryToDisplayString as metadataValueToDisplayString } from "../draft";
import { metadataGet } from "./metadataCollection";
import { schemaDefinitionIdEquals } from "./schemaDefinitionId";

export type SortTarget =
  | { kind: "path" }
  | { kind: "os"; key: "date_modified" | "date_created" }
  | { kind: "image"; id: import("../types").SchemaDefinitionId };

function getMetadataValueAsString(
  v: import("../types").MetadataValue | undefined,
): string {
  if (v === undefined || v === null) return "";
  return metadataValueToDisplayString(v);
}

function compareByKey(
  a: PhotoInfo,
  b: PhotoInfo,
  key: SortKey,
  imageMetadata: ImageMetadataStore,
): number {
  let valA: string | number | null;
  let valB: string | number | null;

  if (key.kind === "path") {
    valA = a.relative_path;
    valB = b.relative_path;
  } else if (key.kind === "os") {
    valA = key.key === "date_modified" ? a.date_modified : a.date_created;
    valB = key.key === "date_modified" ? b.date_modified : b.date_created;
    // Nulls sort to the end regardless of direction
    if (valA === null && valB === null) return 0;
    if (valA === null) return 1;
    if (valB === null) return -1;
  } else {
    // image metadata — look up from store; photos still loading sort to the end
    const metaA = imageMetadata.get(a.relative_path);
    const metaB = imageMetadata.get(b.relative_path);
    const rawA = metaA === "loading" ? undefined : metadataGet(metaA, key.id);
    const rawB = metaB === "loading" ? undefined : metadataGet(metaB, key.id);
    valA = getMetadataValueAsString(rawA);
    valB = getMetadataValueAsString(rawB);
    // Empty strings (no value or still loading) sort to the end
    if (valA === "" && valB === "") return 0;
    if (valA === "") return 1;
    if (valB === "") return -1;
  }

  let cmp: number;
  if (typeof valA === "number" && typeof valB === "number") {
    cmp = valA - valB;
  } else {
    cmp = String(valA).localeCompare(String(valB), undefined, {
      numeric: true,
      sensitivity: "base",
    });
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

/**
 * Decide whether sorting should be suspended right now.
 *
 * Suspended means: the photos list is shown in arrival order and the
 * column-header indicators are hidden in the UI.  Clicks on column headers
 * are *not* blocked — the user must always be able to change the sort, even
 * if the resulting sort is itself suspended.
 *
 * Two conditions trigger suspension:
 *  - the directory walk is still running, OR
 *  - the *primary* sort is by an image-metadata column and ExifTool data
 *    hasn't fully arrived yet.
 *
 * Only the primary is consulted: a secondary image sort is a tiebreaker, and
 * during loading it just degrades gracefully (rows missing the secondary
 * value sort to the end).  Checking secondary too made the user-visible
 * behaviour confusing — clicking an OS column to escape an image sort would
 * demote the image sort to secondary (per `nextSortConfig`) and still leave
 * the UI suspended.
 */
export function shouldSuspendSorting(
  scanning: boolean,
  sortConfig: SortConfig,
  metadataRemaining: number,
): boolean {
  if (scanning) return true;
  const primaryNeedsMetadata = sortConfig.primary?.kind === "image";
  return primaryNeedsMetadata && metadataRemaining > 0;
}

/** Returns the next SortConfig when a column header is clicked. */
export function nextSortConfig(
  current: SortConfig,
  target: SortTarget,
): SortConfig {
  const { primary } = current;

  if (primary && sortKeyMatches(primary, target)) {
    // Toggle direction on the current primary column
    return {
      primary: {
        ...primary,
        direction: primary.direction === "asc" ? "desc" : "asc",
      },
      secondary: current.secondary,
    };
  }

  // New column: becomes primary asc; old primary demoted to secondary
  return {
    primary: { ...target, direction: "asc" } as SortKey,
    secondary: primary ?? null,
  };
}

function sortKeyMatches(a: SortKey, b: SortTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "path") return true;
  if (a.kind === "os" && b.kind === "os") return a.key === b.key;
  return (
    a.kind === "image" &&
    b.kind === "image" &&
    schemaDefinitionIdEquals(a.id, b.id)
  );
}
