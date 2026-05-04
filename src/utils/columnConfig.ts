import type { SortConfig, SortKey } from "../types";

export const COLUMN_CONFIG_KEY = "media_library_columns_config";

export const DEFAULT_COLUMNS = [
  "ExifIFD:DateTimeOriginal",
  "XMP-dc:Description",
  "XMP-dc:Subject",
  "GPS:GPSLatitude",
  "GPS:GPSLongitude",
  "XMP-iptcCore:Location",
  "XMP-photoshop:City",
  "XMP-photoshop:State",
  "XMP-photoshop:Country",
];

export const DEFAULT_OS_COLUMNS = ["date_modified", "date_created"];

export const DEFAULT_SORT_CONFIG: SortConfig = { primary: null, secondary: null };

export interface ColumnConfig {
  visibleColumns: string[];
  visibleOSColumns: string[];
  sortConfig: SortConfig;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isValidSortKey(v: unknown): v is SortKey {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.column === "string" &&
    (k.columnType === "path" || k.columnType === "os" || k.columnType === "image") &&
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

export function loadColumnConfig(): ColumnConfig {
  try {
    const raw = localStorage.getItem(COLUMN_CONFIG_KEY);
    if (!raw) return { visibleColumns: DEFAULT_COLUMNS, visibleOSColumns: DEFAULT_OS_COLUMNS, sortConfig: DEFAULT_SORT_CONFIG };

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      visibleColumns: isStringArray(parsed.visibleColumns) ? parsed.visibleColumns : DEFAULT_COLUMNS,
      visibleOSColumns: isStringArray(parsed.visibleOSColumns) ? parsed.visibleOSColumns : DEFAULT_OS_COLUMNS,
      sortConfig: isValidSortConfig(parsed.sortConfig) ? parsed.sortConfig : DEFAULT_SORT_CONFIG,
    };
  } catch {
    return { visibleColumns: DEFAULT_COLUMNS, visibleOSColumns: DEFAULT_OS_COLUMNS, sortConfig: DEFAULT_SORT_CONFIG };
  }
}

export function saveColumnConfig(config: ColumnConfig): void {
  try {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // localStorage may be unavailable (e.g. in tests) — silently ignore
  }
}
