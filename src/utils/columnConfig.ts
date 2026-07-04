import type { SortConfig, SortKey, VisibleColumn } from "../types";

export const COLUMN_CONFIG_KEY = "media_library_columns_config";

export const DEFAULT_VISIBLE_COLUMNS: VisibleColumn[] = [
  { key: "date_modified", kind: "os" },
  { key: "date_created", kind: "os" },
  { key: "ExifIFD:DateTimeOriginal", kind: "image" },
  { key: "XMP-dc:Description", kind: "image" },
  { key: "XMP-dc:Subject", kind: "image" },
  { key: "GPS:GPSLatitude", kind: "image" },
  { key: "GPS:GPSLongitude", kind: "image" },
  { key: "XMP-iptcCore:Location", kind: "image" },
  { key: "XMP-photoshop:City", kind: "image" },
  { key: "XMP-photoshop:State", kind: "image" },
  { key: "XMP-photoshop:Country", kind: "image" },
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

function isVisibleColumn(v: unknown): v is VisibleColumn {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.key === "string" && (c.kind === "os" || c.kind === "image");
}

function isVisibleColumnArray(v: unknown): v is VisibleColumn[] {
  return Array.isArray(v) && v.every(isVisibleColumn);
}

function isValidSortKey(v: unknown): v is SortKey {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.column === "string" &&
    (k.columnType === "path" ||
      k.columnType === "os" ||
      k.columnType === "image") &&
    (k.direction === "asc" || k.direction === "desc")
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
    if (!isVisibleColumnArray(parsed.visibleColumns)) {
      // Old shape (string[] + visibleOSColumns) or otherwise corrupt — reset.
      return defaultConfig();
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
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // localStorage may be unavailable (e.g. in tests) — silently ignore
  }
}
