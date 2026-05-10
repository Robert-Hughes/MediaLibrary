import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadColumnConfig,
  saveColumnConfig,
  COLUMN_CONFIG_KEY,
  DEFAULT_VISIBLE_COLUMNS,
  DEFAULT_SORT_CONFIG,
} from "../utils/columnConfig";
import type { VisibleColumn } from "../types";

function clearStorage() {
  localStorage.removeItem(COLUMN_CONFIG_KEY);
}

const NO_WIDTHS = {};

describe("loadColumnConfig", () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it("returns defaults when nothing is stored", () => {
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(config.sortConfig).toEqual(DEFAULT_SORT_CONFIG);
    expect(config.columnWidths).toEqual({});
  });

  it("returns a saved config verbatim", () => {
    const cols: VisibleColumn[] = [
      { key: "date_modified", kind: "os" },
      { key: "IFD0:Model", kind: "image" },
      { key: "ExifIFD:DateTimeOriginal", kind: "image" },
    ];
    saveColumnConfig({
      visibleColumns: cols,
      sortConfig: { primary: { column: "IFD0:Model", columnType: "image", direction: "asc" }, secondary: null },
      columnWidths: { relative_path: 300, "IFD0:Model": 180 },
    });
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(cols);
    expect(config.sortConfig.primary).toEqual({ column: "IFD0:Model", columnType: "image", direction: "asc" });
    expect(config.columnWidths).toEqual({ relative_path: 300, "IFD0:Model": 180 });
  });

  it("falls back to defaults when stored visibleColumns is not the new shape", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({
      visibleColumns: ["ExifIFD:DateTimeOriginal"],
      visibleOSColumns: ["date_modified"],
      sortConfig: null,
      columnWidths: {},
    }));
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it("falls back to defaults when stored value is not an array", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({ visibleColumns: "not-an-array" }));
    expect(loadColumnConfig().visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it("falls back to default sortConfig when stored value is malformed", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({
      visibleColumns: [],
      sortConfig: { primary: { column: 123 } },
      columnWidths: {},
    }));
    expect(loadColumnConfig().sortConfig).toEqual(DEFAULT_SORT_CONFIG);
  });

  it("falls back to empty columnWidths when stored value contains non-numbers", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({
      visibleColumns: [],
      sortConfig: null,
      columnWidths: { path: "wide" },
    }));
    expect(loadColumnConfig().columnWidths).toEqual({});
  });

  it("accepts a valid secondary sort in stored config", () => {
    saveColumnConfig({
      visibleColumns: [],
      sortConfig: {
        primary: { column: "date_modified", columnType: "os", direction: "desc" },
        secondary: { column: "relative_path", columnType: "path", direction: "asc" },
      },
      columnWidths: NO_WIDTHS,
    });
    expect(loadColumnConfig().sortConfig.secondary?.column).toBe("relative_path");
  });

  it("returns defaults when localStorage contains invalid JSON", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, "not-valid-json{{{");
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(config.sortConfig).toEqual(DEFAULT_SORT_CONFIG);
    expect(config.columnWidths).toEqual({});
  });

  it("accepts an empty array for visible columns (user hides all columns)", () => {
    saveColumnConfig({ visibleColumns: [], sortConfig: DEFAULT_SORT_CONFIG, columnWidths: NO_WIDTHS });
    expect(loadColumnConfig().visibleColumns).toEqual([]);
  });

  it("falls back to empty columnWidths when columnWidths is missing from stored value", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({ visibleColumns: [], sortConfig: null }));
    expect(loadColumnConfig().columnWidths).toEqual({});
  });
});

describe("saveColumnConfig", () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it("writes a value that loadColumnConfig can read back", () => {
    const original = {
      visibleColumns: [
        { key: "date_created", kind: "os" as const },
        { key: "IFD0:Make", kind: "image" as const },
      ],
      sortConfig: DEFAULT_SORT_CONFIG,
      columnWidths: { relative_path: 250 },
    };
    saveColumnConfig(original);
    expect(loadColumnConfig()).toEqual(original);
  });

  it("overwrites a previous saved value", () => {
    saveColumnConfig({
      visibleColumns: [{ key: "A", kind: "image" }],
      sortConfig: DEFAULT_SORT_CONFIG,
      columnWidths: {},
    });
    saveColumnConfig({
      visibleColumns: [
        { key: "date_modified", kind: "os" },
        { key: "B", kind: "image" },
        { key: "C", kind: "image" },
      ],
      sortConfig: DEFAULT_SORT_CONFIG,
      columnWidths: { relative_path: 300 },
    });
    expect(loadColumnConfig().visibleColumns).toEqual([
      { key: "date_modified", kind: "os" },
      { key: "B", kind: "image" },
      { key: "C", kind: "image" },
    ]);
    expect(loadColumnConfig().columnWidths).toEqual({ relative_path: 300 });
  });
});
