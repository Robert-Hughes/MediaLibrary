import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadColumnConfig,
  saveColumnConfig,
  COLUMN_CONFIG_KEY,
  DEFAULT_VISIBLE_COLUMNS,
  DEFAULT_SORT_CONFIG,
} from "../utils/columnConfig";
import type { VisibleColumn } from "../types";
import { imgCol, osCol, testId } from "./factories";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

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
      osCol("date_modified"),
      imgCol("IFD0:Model"),
      imgCol("ExifIFD:DateTimeOriginal"),
    ];
    saveColumnConfig({
      visibleColumns: cols,
      sortConfig: {
        primary: {
          id: testId("IFD0:Model"),
          kind: "image",
          direction: "asc",
        },
        secondary: null,
      },
      columnWidths: {
        relative_path: 300,
        [schemaDefinitionIdToken(testId("IFD0:Model"))]: 180,
      },
    });
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(cols);
    expect(config.sortConfig.primary).toEqual({
      id: testId("IFD0:Model"),
      kind: "image",
      direction: "asc",
    });
    expect(config.columnWidths).toEqual({
      relative_path: 300,
      [schemaDefinitionIdToken(testId("IFD0:Model"))]: 180,
    });
  });

  it("falls back to defaults when stored visibleColumns is not the new shape", () => {
    localStorage.setItem(
      COLUMN_CONFIG_KEY,
      JSON.stringify({
        visibleColumns: ["ExifIFD:DateTimeOriginal"],
        visibleOSColumns: ["date_modified"],
        sortConfig: null,
        columnWidths: {},
      }),
    );
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it("falls back to defaults when stored value is not an array", () => {
    localStorage.setItem(
      COLUMN_CONFIG_KEY,
      JSON.stringify({ visibleColumns: "not-an-array" }),
    );
    expect(loadColumnConfig().visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it("falls back to default sortConfig when stored value is malformed", () => {
    localStorage.setItem(
      COLUMN_CONFIG_KEY,
      JSON.stringify({
        visibleColumns: [],
        sortConfig: { primary: { column: 123 } },
        columnWidths: {},
      }),
    );
    expect(loadColumnConfig().sortConfig).toEqual(DEFAULT_SORT_CONFIG);
  });

  it("falls back to empty columnWidths when stored value contains non-numbers", () => {
    localStorage.setItem(
      COLUMN_CONFIG_KEY,
      JSON.stringify({
        visibleColumns: [],
        sortConfig: null,
        columnWidths: { path: "wide" },
      }),
    );
    expect(loadColumnConfig().columnWidths).toEqual({});
  });

  it("accepts a valid secondary sort in stored config", () => {
    saveColumnConfig({
      visibleColumns: [],
      sortConfig: {
        primary: {
          key: "date_modified",
          kind: "os",
          direction: "desc",
        },
        secondary: {
          kind: "path",
          direction: "asc",
        },
      },
      columnWidths: NO_WIDTHS,
    });
    expect(loadColumnConfig().sortConfig.secondary?.kind).toBe("path");
  });

  it("returns defaults when localStorage contains invalid JSON", () => {
    localStorage.setItem(COLUMN_CONFIG_KEY, "not-valid-json{{{");
    const config = loadColumnConfig();
    expect(config.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(config.sortConfig).toEqual(DEFAULT_SORT_CONFIG);
    expect(config.columnWidths).toEqual({});
  });

  it("accepts an empty array for visible columns (user hides all columns)", () => {
    saveColumnConfig({
      visibleColumns: [],
      sortConfig: DEFAULT_SORT_CONFIG,
      columnWidths: NO_WIDTHS,
    });
    expect(loadColumnConfig().visibleColumns).toEqual([]);
  });

  it("falls back to empty columnWidths when columnWidths is missing from stored value", () => {
    localStorage.setItem(
      COLUMN_CONFIG_KEY,
      JSON.stringify({ visibleColumns: [], sortConfig: null }),
    );
    expect(loadColumnConfig().columnWidths).toEqual({});
  });
});

describe("saveColumnConfig", () => {
  beforeEach(clearStorage);
  afterEach(clearStorage);

  it("writes a value that loadColumnConfig can read back", () => {
    const original = {
      visibleColumns: [osCol("date_created"), imgCol("IFD0:Make")],
      sortConfig: DEFAULT_SORT_CONFIG,
      columnWidths: { relative_path: 250 },
    };
    saveColumnConfig(original);
    expect(loadColumnConfig()).toEqual(original);
  });

  it("overwrites a previous saved value", () => {
    saveColumnConfig({
      visibleColumns: [imgCol("A")],
      sortConfig: DEFAULT_SORT_CONFIG,
      columnWidths: {},
    });
    saveColumnConfig({
      visibleColumns: [osCol("date_modified"), imgCol("B"), imgCol("C")],
      sortConfig: DEFAULT_SORT_CONFIG,
      columnWidths: { relative_path: 300 },
    });
    expect(loadColumnConfig().visibleColumns).toEqual([
      osCol("date_modified"),
      imgCol("B"),
      imgCol("C"),
    ]);
    expect(loadColumnConfig().columnWidths).toEqual({ relative_path: 300 });
  });
});
