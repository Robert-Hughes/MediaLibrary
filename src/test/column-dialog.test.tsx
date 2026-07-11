import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";
import { DEFAULT_VISIBLE_COLUMNS } from "../utils/columnConfig";
import type { VisibleColumn } from "../types";
import { imgCol, testFriendlyName, testId } from "./factories";
import {
  _ensureTagInfoCacheEntry,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

const keyCounts = (items: Array<{ key: string; count: number }>) =>
  items.map(({ key, count }) => {
    const id = testId(key);
    const colon = key.indexOf(":");
    _ensureTagInfoCacheEntry(id, {
      group: colon > 0 ? key.slice(0, colon) : "Test",
      name: colon > 0 ? key.slice(colon + 1) : key,
      writable: true,
      kind: { kind: "Text" },
      description: null,
      storage_count: undefined,
    });
    return { id, count };
  });

const columnLabel = (column: VisibleColumn) =>
  column.kind === "os" ? column.key : testFriendlyName(column.id);

describe("ColumnSelectionDialog tests", () => {
  const allKeys = keyCounts([
    { key: "ExifIFD:DateTimeOriginal", count: 15 },
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
    { key: "XMP-dc:Subject", count: 5 },
    { key: "GPS:GPSLatitude", count: 3 },
    { key: "GPS:GPSLongitude", count: 3 },
    { key: "XMP-photoshop:City", count: 7 },
  ]);

  const cols = (...arr: VisibleColumn[]): VisibleColumn[] => arr;

  beforeEach(() => {
    for (const { id } of allKeys) {
      const name = testFriendlyName(id);
      const colon = name.indexOf(":");
      _setTagInfoCacheEntry(id, {
        group: colon > 0 ? name.slice(0, colon) : "Test",
        name: colon > 0 ? name.slice(colon + 1) : name,
        writable: true,
        kind: { kind: "Text" },
        description: null,
        storage_count: undefined,
      });
    }
  });

  describe("Alphabetical sorting", () => {
    it("shows image metadata fields in alphabetical order", () => {
      const sortingKeys = keyCounts([
        { key: "XMP-dc:Subject", count: 5 },
        { key: "IFD0:Model", count: 10 },
        { key: "ExifIFD:DateTimeOriginal", count: 15 },
        { key: "GPS:GPSLatitude", count: 3 },
        { key: "IFD0:Make", count: 8 },
      ]);

      const { container } = render(
        <ColumnSelectionDialog
          allKeys={sortingKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      expect(screen.getByText("ExifIFD:DateTimeOriginal")).toBeInTheDocument();
      expect(screen.getByText("GPS:GPSLatitude")).toBeInTheDocument();
      expect(screen.getByText("IFD0:Make")).toBeInTheDocument();
      expect(screen.getByText("IFD0:Model")).toBeInTheDocument();
      expect(screen.getByText("XMP-dc:Subject")).toBeInTheDocument();

      const columnItems = container.querySelectorAll(".column-item");
      const imageMetadataItems = Array.from(columnItems).slice(2);
      const labelTexts = imageMetadataItems.map(
        (item) => item.querySelector(".column-label")?.textContent,
      );

      const expectedOrder = [
        "ExifIFD:DateTimeOriginal",
        "GPS:GPSLatitude",
        "IFD0:Make",
        "IFD0:Model",
        "XMP-dc:Subject",
      ];

      expect(labelTexts).toEqual(expectedOrder);
    });

    it("maintains alphabetical order regardless of count values", () => {
      const sortingKeys = keyCounts([
        { key: "Z-Last:Field", count: 1000 },
        { key: "A-First:Field", count: 1 },
        { key: "M-Middle:Field", count: 500 },
      ]);

      const { container } = render(
        <ColumnSelectionDialog
          allKeys={sortingKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const columnItems = container.querySelectorAll(".column-item");
      const imageMetadataItems = Array.from(columnItems).slice(2);
      const labelTexts = imageMetadataItems.map(
        (item) => item.querySelector(".column-label")?.textContent,
      );

      expect(labelTexts).toEqual([
        "A-First:Field",
        "M-Middle:Field",
        "Z-Last:Field",
      ]);
    });

    it("case-insensitive alphabetical sorting", () => {
      const sortingKeys = keyCounts([
        { key: "xmp-dc:Subject", count: 5 },
        { key: "IFD0:Model", count: 10 },
        { key: "ExifIFD:DateTimeOriginal", count: 15 },
        { key: "gps:GPSLatitude", count: 3 },
      ]);

      const { container } = render(
        <ColumnSelectionDialog
          allKeys={sortingKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const columnItems = container.querySelectorAll(".column-item");
      const imageMetadataItems = Array.from(columnItems).slice(2);
      const labelTexts = imageMetadataItems.map(
        (item) => item.querySelector(".column-label")?.textContent,
      );

      expect(labelTexts).toEqual([
        "ExifIFD:DateTimeOriginal",
        "gps:GPSLatitude",
        "IFD0:Model",
        "xmp-dc:Subject",
      ]);
    });
  });

  describe("Keyboard shortcuts", () => {
    it("closes dialog when Escape key is pressed", async () => {
      const onClose = vi.fn();
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(1, 3)}
          visibleColumns={cols(
            { key: "date_modified", kind: "os" },
            { key: "date_created", kind: "os" },
            imgCol("IFD0:Model"),
          )}
          onSave={onSave}
          onClose={onClose}
        />,
      );

      await userEvent.keyboard("{Escape}");

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
    });

    it("saves changes when Enter key is pressed", async () => {
      const onClose = vi.fn();
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(1, 3)}
          visibleColumns={cols(
            { key: "date_modified", kind: "os" },
            { key: "date_created", kind: "os" },
            imgCol("IFD0:Model"),
          )}
          onSave={onSave}
          onClose={onClose}
        />,
      );

      await userEvent.keyboard("{Enter}");

      expect(onSave).toHaveBeenCalledWith(
        [
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("IFD0:Model"),
        ],
        false,
      );
      expect(onClose).not.toHaveBeenCalled();
    });

    it("saves current selection state when Enter is pressed after making changes", async () => {
      const onClose = vi.fn();
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(1, 3)}
          visibleColumns={cols(
            { key: "date_modified", kind: "os" },
            imgCol("IFD0:Model"),
          )}
          onSave={onSave}
          onClose={onClose}
        />,
      );

      await userEvent.click(screen.getByText("IFD0:Make"));
      await userEvent.click(screen.getByText("Date Created"));

      await userEvent.keyboard("{Enter}");

      expect(onSave).toHaveBeenCalledTimes(1);
      const [savedCols, resetWidths] = onSave.mock.calls[0];
      expect(resetWidths).toBe(false);
      expect(savedCols).toEqual(
        expect.arrayContaining([
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("IFD0:Model"),
          imgCol("IFD0:Make"),
        ]),
      );
    });

    it("keyboard shortcuts work when dialog has focus", async () => {
      const onClose = vi.fn();
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(1, 3)}
          visibleColumns={[]}
          onSave={onSave}
          onClose={onClose}
        />,
      );

      const dialog = screen.getByTestId("column-dialog");
      dialog.focus();

      await userEvent.keyboard("{Escape}");

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Search functionality", () => {
    it("renders search input", () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      expect(searchInput).toBeInTheDocument();
    });

    it("filters columns based on search term", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "GPS");

      expect(screen.getByText("GPS:GPSLatitude")).toBeInTheDocument();
      expect(screen.getByText("GPS:GPSLongitude")).toBeInTheDocument();
      expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
      expect(
        screen.queryByText("ExifIFD:DateTimeOriginal"),
      ).not.toBeInTheDocument();
    });

    it("search is case insensitive", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "xmp");

      expect(screen.getByText("XMP-dc:Subject")).toBeInTheDocument();
      expect(screen.getByText("XMP-photoshop:City")).toBeInTheDocument();
      expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
      expect(screen.queryByText("GPS:GPSLatitude")).not.toBeInTheDocument();
    });

    it("shows no results message when no columns match", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "nonexistent");

      expect(
        screen.getByText("No columns match your search."),
      ).toBeInTheDocument();
      expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
    });

    it("clears search and shows all columns when search is cleared", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "GPS");
      expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();

      await userEvent.clear(searchInput);

      expect(screen.getByText("IFD0:Model")).toBeInTheDocument();
      expect(screen.getByText("ExifIFD:DateTimeOriginal")).toBeInTheDocument();
      expect(screen.getByText("GPS:GPSLatitude")).toBeInTheDocument();
    });

    it("can select filtered columns and save", async () => {
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={allKeys}
          visibleColumns={[]}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "GPS");

      const latitudeLabel = screen.getByText("GPS:GPSLatitude");
      await userEvent.click(latitudeLabel);

      await userEvent.click(screen.getByText("Save Changes"));

      expect(onSave).toHaveBeenCalledWith(
        [{ id: testId("GPS:GPSLatitude"), kind: "image" }],
        false,
      );
    });

    it("search works with partial matches", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "Date");

      expect(screen.getByText("ExifIFD:DateTimeOriginal")).toBeInTheDocument();
      expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
    });
  });

  describe("Search filters OS metadata fields", () => {
    it("shows OS metadata fields when search term matches 'Date Modified'", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(0, 2)}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "date modified");

      expect(screen.getByText("Date Modified")).toBeInTheDocument();
      expect(screen.queryByText("Date Created")).not.toBeInTheDocument();
      expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
    });

    it("shows OS metadata fields when search term matches 'date_created' key", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(0, 2)}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "created");

      expect(screen.getByText("Date Created")).toBeInTheDocument();
      expect(screen.queryByText("Date Modified")).not.toBeInTheDocument();
      expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
    });

    it("shows both OS fields when search term matches both (e.g. 'date')", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(0, 2)}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "date");

      expect(screen.getByText("Date Modified")).toBeInTheDocument();
      expect(screen.getByText("Date Created")).toBeInTheDocument();
    });

    it("hides OS Metadata section entirely when search matches only image metadata", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(0, 2)}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "EXIF");

      expect(screen.getByText("ExifIFD:DateTimeOriginal")).toBeInTheDocument();
      expect(screen.queryByText("Date Modified")).not.toBeInTheDocument();
      expect(screen.queryByText("Date Created")).not.toBeInTheDocument();
      expect(screen.queryByText("OS Metadata")).not.toBeInTheDocument();
    });

    it("shows 'no results' message when search matches neither OS nor image metadata", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(0, 2)}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "zzznomatch");

      expect(
        screen.getByText("No columns match your search."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Date Modified")).not.toBeInTheDocument();
      expect(screen.queryByText("OS Metadata")).not.toBeInTheDocument();
    });

    it("does not show 'no results' when only OS fields match", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(0, 2)}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "modified");

      expect(
        screen.queryByText("No columns match your search."),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Date Modified")).toBeInTheDocument();
    });

    it("search is case-insensitive for OS fields", async () => {
      render(
        <ColumnSelectionDialog
          allKeys={allKeys.slice(0, 2)}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      const searchInput = screen.getByPlaceholderText("Search columns...");
      await userEvent.type(searchInput, "DATE MODIFIED");

      expect(screen.getByText("Date Modified")).toBeInTheDocument();
    });
  });

  describe("Select All / Deselect All", () => {
    const dialogKeys = keyCounts([
      { key: "IFD0:Model", count: 10 },
      { key: "IFD0:Make", count: 8 },
      { key: "XMP-dc:Subject", count: 5 },
    ]);

    it("renders Select All and Deselect All buttons", () => {
      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );

      expect(screen.getByText("Select All")).toBeInTheDocument();
      expect(screen.getByText("Deselect All")).toBeInTheDocument();
    });

    it("selects all columns when Select All is clicked", async () => {
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={[]}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      await userEvent.click(screen.getByText("Select All"));

      const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      checkboxes.forEach((cb) => expect(cb.checked).toBe(true));

      await userEvent.click(screen.getByText("Save Changes"));
      const [saved] = onSave.mock.calls[0];
      const keys = saved.map((c: VisibleColumn) => columnLabel(c));
      expect(keys).toEqual(
        expect.arrayContaining([
          "IFD0:Model",
          "IFD0:Make",
          "XMP-dc:Subject",
          "date_modified",
          "date_created",
        ]),
      );
    });

    it("deselects all columns when Deselect All is clicked", async () => {
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={cols(
            { key: "date_modified", kind: "os" },
            { key: "date_created", kind: "os" },
            imgCol("IFD0:Model"),
            imgCol("IFD0:Make"),
          )}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      await userEvent.click(screen.getByText("Deselect All"));

      const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      checkboxes.forEach((cb) => expect(cb.checked).toBe(false));

      await userEvent.click(screen.getByText("Save Changes"));
      expect(onSave).toHaveBeenCalledWith([], false);
    });

    it("Select All works after making individual selections", async () => {
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={cols(
            { key: "date_modified", kind: "os" },
            imgCol("IFD0:Model"),
          )}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      await userEvent.click(screen.getByText("IFD0:Make"));
      await userEvent.click(screen.getByText("Date Created"));

      await userEvent.click(screen.getByText("Select All"));
      await userEvent.click(screen.getByText("Save Changes"));

      const [saved] = onSave.mock.calls[0];
      const keys = saved.map((c: VisibleColumn) => columnLabel(c));
      expect(keys).toEqual(
        expect.arrayContaining([
          "IFD0:Model",
          "IFD0:Make",
          "XMP-dc:Subject",
          "date_modified",
          "date_created",
        ]),
      );
    });

    it("Deselect All works after Select All", async () => {
      const onSave = vi.fn();

      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={[]}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      await userEvent.click(screen.getByText("Select All"));
      await userEvent.click(screen.getByText("Deselect All"));

      await userEvent.click(screen.getByText("Save Changes"));
      expect(onSave).toHaveBeenCalledWith([], false);
    });

    it("renders Default button", () => {
      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={[]}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );
      expect(screen.getByText("Default")).toBeInTheDocument();
    });

    it("Default button resets selection to defaults, with resetWidths=true", async () => {
      const onSave = vi.fn();
      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={cols(imgCol("IFD0:Model"), imgCol("IFD0:Make"))}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      await userEvent.click(screen.getByText("Default"));
      await userEvent.click(screen.getByText("Save Changes"));

      const [saved, resetWidths] = onSave.mock.calls[0];
      expect(resetWidths).toBe(true);
      const savedKeys = (saved as VisibleColumn[]).map(columnLabel).sort();
      const defaultKeys = DEFAULT_VISIBLE_COLUMNS.map(columnLabel).sort();
      expect(savedKeys).toEqual(defaultKeys);
    });

    it("normal Save does not set resetWidths", async () => {
      const onSave = vi.fn();
      render(
        <ColumnSelectionDialog
          allKeys={dialogKeys}
          visibleColumns={cols(imgCol("IFD0:Model"))}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      await userEvent.click(screen.getByText("Save Changes"));

      expect(onSave).toHaveBeenCalledWith([imgCol("IFD0:Model")], false);
    });

    it("Default button produces columns matching DEFAULT_VISIBLE_COLUMNS order", async () => {
      const onSave = vi.fn();
      render(
        <ColumnSelectionDialog
          allKeys={[
            ...dialogKeys,
            { id: testId("ExifIFD:DateTimeOriginal"), count: 3 },
          ]}
          visibleColumns={cols(imgCol("IFD0:Model"))}
          onSave={onSave}
          onClose={() => {}}
        />,
      );

      await userEvent.click(screen.getByText("Default"));
      await userEvent.click(screen.getByText("Save Changes"));

      const [saved] = onSave.mock.calls[0];
      const keys = (saved as VisibleColumn[]).map(columnLabel);
      expect(keys.indexOf("ExifIFD:DateTimeOriginal")).toBeLessThan(
        keys.indexOf("XMP-dc:Subject"),
      );
    });
  });
});
