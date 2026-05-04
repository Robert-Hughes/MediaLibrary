import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadColumnConfig,
  saveColumnConfig,
  COLUMN_CONFIG_KEY,
  DEFAULT_COLUMNS,
  DEFAULT_OS_COLUMNS,
  DEFAULT_SORT_CONFIG,
} from "../utils/columnConfig";

// ── helpers ────────────────────────────────────────────────────────────────────

function clearStorage() {
  localStorage.removeItem(COLUMN_CONFIG_KEY);
}

// ── loadColumnConfig ───────────────────────────────────────────────────────────

describe("loadColumnConfig", () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it("returns defaults when nothing is stored", () => {
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_COLUMNS);
    expect(config.visibleOSColumns).toEqual(DEFAULT_OS_COLUMNS);
    expect(config.sortConfig).toEqual(DEFAULT_SORT_CONFIG);
  });

  it("returns a saved config verbatim", () => {
    saveColumnConfig({
      visibleColumns: ["IFD0:Model", "ExifIFD:DateTimeOriginal"],
      visibleOSColumns: ["date_modified"],
      sortConfig: { primary: { column: "IFD0:Model", columnType: "image", direction: "asc" }, secondary: null },
    });
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(["IFD0:Model", "ExifIFD:DateTimeOriginal"]);
    expect(config.visibleOSColumns).toEqual(["date_modified"]);
    expect(config.sortConfig.primary).toEqual({ column: "IFD0:Model", columnType: "image", direction: "asc" });
  });

  it("falls back to default visibleColumns when stored value is not an array", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({ visibleColumns: "not-an-array", visibleOSColumns: [], sortConfig: null }));
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_COLUMNS);
  });

  it("falls back to default visibleOSColumns when stored value contains non-strings", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({ visibleColumns: [], visibleOSColumns: [1, 2], sortConfig: null }));
    const config = loadColumnConfig();
    expect(config.visibleOSColumns).toEqual(DEFAULT_OS_COLUMNS);
  });

  it("falls back to default sortConfig when stored value is malformed", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify({ visibleColumns: [], visibleOSColumns: [], sortConfig: { primary: { column: 123 } } }));
    const config = loadColumnConfig();
    expect(config.sortConfig).toEqual(DEFAULT_SORT_CONFIG);
  });

  it("accepts a valid secondary sort in stored config", () => {
    saveColumnConfig({
      visibleColumns: [],
      visibleOSColumns: [],
      sortConfig: {
        primary: { column: "date_modified", columnType: "os", direction: "desc" },
        secondary: { column: "relative_path", columnType: "path", direction: "asc" },
      },
    });
    const config = loadColumnConfig();
    expect(config.sortConfig.secondary?.column).toBe("relative_path");
  });

  it("returns defaults when localStorage contains invalid JSON", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, "not-valid-json{{{");
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_COLUMNS);
    expect(config.visibleOSColumns).toEqual(DEFAULT_OS_COLUMNS);
    expect(config.sortConfig).toEqual(DEFAULT_SORT_CONFIG);
  });

  it("accepts empty arrays for visible columns (user hides all columns)", () => {
    saveColumnConfig({ visibleColumns: [], visibleOSColumns: [], sortConfig: DEFAULT_SORT_CONFIG });
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual([]);
    expect(config.visibleOSColumns).toEqual([]);
  });
});

// ── saveColumnConfig ───────────────────────────────────────────────────────────

describe("saveColumnConfig", () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it("writes a value that loadColumnConfig can read back", () => {
    const original = {
      visibleColumns: ["IFD0:Make"],
      visibleOSColumns: ["date_created"],
      sortConfig: DEFAULT_SORT_CONFIG,
    };
    saveColumnConfig(original);
    expect(loadColumnConfig()).toEqual(original);
  });

  it("overwrites a previous saved value", () => {
    saveColumnConfig({ visibleColumns: ["A"], visibleOSColumns: [], sortConfig: DEFAULT_SORT_CONFIG });
    saveColumnConfig({ visibleColumns: ["B", "C"], visibleOSColumns: ["date_modified"], sortConfig: DEFAULT_SORT_CONFIG });
    expect(loadColumnConfig().visibleColumns).toEqual(["B", "C"]);
  });
});
