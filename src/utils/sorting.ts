import type {
  FileMetadataOccurrencesStore,
  MetadataValue,
  FileInfo,
  SchemaDefinitionId,
  SortConfig,
  SortKey,
} from "../types";
import { formatMetadataValue } from "../draft";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";
import { buildSchemaValueResolutionIndex } from "./schemaMetadataProjection";

export type SortTarget =
  | { kind: "path" }
  | { kind: "os"; key: "date_modified" | "date_created" }
  | { kind: "image"; id: SchemaDefinitionId };

function getMetadataValueAsString(v: MetadataValue | undefined): string {
  if (v === undefined) return "";
  return formatMetadataValue({ value: v });
}

type PrecomputedImageSortValues = Map<string, Map<string, string>>;

function activeImageSortIds(sortConfig: SortConfig): SchemaDefinitionId[] {
  const ids = [sortConfig.primary, sortConfig.secondary]
    .filter(
      (key): key is Extract<SortKey, { kind: "image" }> =>
        key?.kind === "image",
    )
    .map((key) => key.id);
  return [
    ...new Map(ids.map((id) => [schemaDefinitionIdToken(id), id])).values(),
  ];
}

function precomputeImageSortValues(
  files: readonly FileInfo[],
  sortConfig: SortConfig,
  occurrencesStore: FileMetadataOccurrencesStore,
): PrecomputedImageSortValues {
  const ids = activeImageSortIds(sortConfig);
  const values: PrecomputedImageSortValues = new Map();
  if (ids.length === 0) return values;

  for (const file of files) {
    const occurrences = occurrencesStore.get(file.relative_path);
    const fileValues = new Map<string, string>();
    if (occurrences !== "loading") {
      const projection = buildSchemaValueResolutionIndex(occurrences);
      for (const id of ids) {
        const token = schemaDefinitionIdToken(id);
        const resolution = projection.get(token);
        if (resolution?.kind === "value") {
          fileValues.set(token, getMetadataValueAsString(resolution.value));
        }
      }
    }
    values.set(file.relative_path, fileValues);
  }
  return values;
}

function compareByKey(
  a: FileInfo,
  b: FileInfo,
  key: SortKey,
  imageValues: PrecomputedImageSortValues,
): number {
  let valA: string | number | null;
  let valB: string | number | null;

  if (key.kind === "path") {
    valA = a.relative_path;
    valB = b.relative_path;
  } else if (key.kind === "os") {
    valA = key.key === "date_modified" ? a.date_modified : a.date_created;
    valB = key.key === "date_modified" ? b.date_modified : b.date_created;
    if (valA === null && valB === null) return 0;
    if (valA === null) return 1;
    if (valB === null) return -1;
  } else {
    const token = schemaDefinitionIdToken(key.id);
    valA = imageValues.get(a.relative_path)?.get(token) ?? "";
    valB = imageValues.get(b.relative_path)?.get(token) ?? "";
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

export function sortFiles(
  files: FileInfo[],
  sortConfig: SortConfig,
  occurrencesStore: FileMetadataOccurrencesStore,
): FileInfo[] {
  if (!sortConfig.primary) return files;
  const imageValues = precomputeImageSortValues(
    files,
    sortConfig,
    occurrencesStore,
  );

  return [...files].sort((a, b) => {
    const primary = compareByKey(a, b, sortConfig.primary!, imageValues);
    if (primary !== 0 || !sortConfig.secondary) return primary;
    return compareByKey(a, b, sortConfig.secondary, imageValues);
  });
}

export function shouldSuspendSorting(
  scanning: boolean,
  sortConfig: SortConfig,
  metadataRemaining: number,
): boolean {
  if (scanning) return true;
  const primaryNeedsMetadata = sortConfig.primary?.kind === "image";
  return primaryNeedsMetadata && metadataRemaining > 0;
}

export function nextSortConfig(
  current: SortConfig,
  target: SortTarget,
): SortConfig {
  const { primary } = current;

  if (primary && sortKeyMatches(primary, target)) {
    return {
      primary: {
        ...primary,
        direction: primary.direction === "asc" ? "desc" : "asc",
      },
      secondary: current.secondary,
    };
  }

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
