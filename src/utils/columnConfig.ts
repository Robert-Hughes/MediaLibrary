import type { SortConfig, SortKey, VisibleColumn } from "../types";
import { KNOWN_METADATA_IDS } from "../metadata/knownIds";

const COLUMN_CONFIG_VERSION = 2;

export const COLUMN_CONFIG_KEY = "media_library_columns_config";

export const DEFAULT_VISIBLE_COLUMNS: VisibleColumn[] = [
  { key: "date_modified", kind: "os" },
  { key: "date_created", kind: "os" },
  { id: KNOWN_METADATA_IDS.dateTimeOriginal, kind: "image" },
  { id: KNOWN_METADATA_IDS.xmpDescription, kind: "image" },
  { id: KNOWN_METADATA_IDS.xmpSubject, kind: "image" },
  { id: KNOWN_METADATA_IDS.gpsLatitude, kind: "image" },
  { id: KNOWN_METADATA_IDS.gpsLongitude, kind: "image" },
  { id: KNOWN_METADATA_IDS.xmpLocation, kind: "image" },
  { id: KNOWN_METADATA_IDS.xmpCity, kind: "image" },
  { id: KNOWN_METADATA_IDS.xmpState, kind: "image" },
  { id: KNOWN_METADATA_IDS.xmpCountry, kind: "image" },
];

export const OS_COLUMN_KEYS = ["date_modified", "date_created"] as const;

export const DEFAULT_SORT_CONFIG: SortConfig = {
  primary: null,
  secondary: null,
};

export interface ColumnConfig {
  visibleColumns: VisibleColumn[];
  sortConfig: SortConfig;
  columnWidths: Record<string, number>;
}

function isSchemaDefinitionId(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const id = v as Record<string, unknown>;
  return (
    typeof id.table === "string" &&
    typeof id.tag_id === "string" &&
    (id.index === undefined || Number.isInteger(id.index))
  );
}

function isVisibleColumn(v: unknown): v is VisibleColumn {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return c.kind === "os"
    ? c.key === "date_modified" || c.key === "date_created"
    : c.kind === "image" && isSchemaDefinitionId(c.id);
}

function isVisibleColumnArray(v: unknown): v is VisibleColumn[] {
  return Array.isArray(v) && v.every(isVisibleColumn);
}

function isValidSortKey(v: unknown): v is SortKey {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  return (
    (k.direction === "asc" || k.direction === "desc") &&
    (k.kind === "path" ||
      (k.kind === "os" &&
        (k.key === "date_modified" || k.key === "date_created")) ||
      (k.kind === "image" && isSchemaDefinitionId(k.id)))
  );
}

function isValidSortConfig(v: unknown): v is SortConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    (c.primary === null || isValidSortKey(c.primary)) &&
    (c.secondary === null || isValidSortKey(c.secondary))
  );
}

function isValidColumnWidths(v: unknown): v is Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (n) => typeof n === "number" && n >= 0,
  );
}

function defaultConfig(): ColumnConfig {
  return {
    visibleColumns: DEFAULT_VISIBLE_COLUMNS,
    sortConfig: DEFAULT_SORT_CONFIG,
    columnWidths: {},
  };
}

export function loadColumnConfig(): ColumnConfig {
  try {
    const raw = localStorage.getItem(COLUMN_CONFIG_KEY);
    if (!raw) return defaultConfig();

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.version !== COLUMN_CONFIG_VERSION ||
      !isVisibleColumnArray(parsed.visibleColumns)
    ) {
      // Legacy image keys were ambiguous. Preserve only safe OS columns/widths.
      const legacyColumns = Array.isArray(parsed.visibleColumns)
        ? parsed.visibleColumns.filter(
            (
              value,
            ): value is { kind: "os"; key: "date_modified" | "date_created" } =>
              !!value &&
              typeof value === "object" &&
              (value as { kind?: unknown }).kind === "os" &&
              ((value as { key?: unknown }).key === "date_modified" ||
                (value as { key?: unknown }).key === "date_created"),
          )
        : [];
      const fallback = defaultConfig();
      return {
        ...fallback,
        visibleColumns:
          legacyColumns.length > 0
            ? [
                ...legacyColumns,
                ...fallback.visibleColumns.filter((c) => c.kind === "image"),
              ]
            : fallback.visibleColumns,
        columnWidths: isValidColumnWidths(parsed.columnWidths)
          ? Object.fromEntries(
              Object.entries(parsed.columnWidths).filter(
                ([key]) =>
                  key === "relative_path" ||
                  OS_COLUMN_KEYS.includes(
                    key as (typeof OS_COLUMN_KEYS)[number],
                  ),
              ),
            )
          : {},
      };
    }
    return {
      visibleColumns: parsed.visibleColumns,
      sortConfig: isValidSortConfig(parsed.sortConfig)
        ? parsed.sortConfig
        : DEFAULT_SORT_CONFIG,
      columnWidths: isValidColumnWidths(parsed.columnWidths)
        ? parsed.columnWidths
        : {},
    };
  } catch {
    return defaultConfig();
  }
}

export function saveColumnConfig(config: ColumnConfig): void {
  try {
    localStorage.setItem(
      COLUMN_CONFIG_KEY,
      JSON.stringify({
        version: COLUMN_CONFIG_VERSION,
        ...config,
      }),
    );
  } catch {
    // localStorage may be unavailable (e.g. in tests) — silently ignore
  }
}
