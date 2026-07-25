import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import type { FileInfo } from "../types";
import { imgCol } from "./factories";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

const files: FileInfo[] = [
  {
    relative_path: "file1.jpg",
    filename: "file1.jpg",
    date_modified: 1640995200,
    date_created: 1640995200,
  },
];

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

describe("FileList column header context menu", () => {
  let thumbnails: ThumbnailStore;
  let occurrences: ImageMetadataOccurrencesStore;

  beforeEach(() => {
    thumbnails = new ThumbnailStore();
    occurrences = new ImageMetadataOccurrencesStore();
    thumbnails.add("file1.jpg");
    occurrences.add("file1.jpg");
    _clearTagInfoCache();
    _setTagInfoCacheEntry("ExifIFD:DateTimeOriginal", {
      group: "ExifIFD",
      name: "DateTimeOriginal",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
  });

  function renderList(onSelectColumns?: () => void) {
    return render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        imageMetadataOccurrences={occurrences}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />,
    );
  }

  it("shows only Select Columns on image metadata headers", async () => {
    renderList(vi.fn());

    await userEvent.pointer({
      keys: "[MouseRight]",
      target: screen.getByText("ExifIFD:DateTimeOriginal"),
    });

    expect(screen.getByText("Select Columns…")).toBeInTheDocument();
    expect(screen.queryByText(/Remove field from/i)).not.toBeInTheDocument();
  });

  it("invokes Select Columns from an OS header", async () => {
    const onSelectColumns = vi.fn();
    renderList(onSelectColumns);

    await userEvent.pointer({
      keys: "[MouseRight]",
      target: screen.getByText("Modified"),
    });
    await userEvent.click(screen.getByText("Select Columns…"));

    expect(onSelectColumns).toHaveBeenCalledTimes(1);
  });

  it("does not open a header menu without Select Columns", async () => {
    renderList();

    await userEvent.pointer({
      keys: "[MouseRight]",
      target: screen.getByText("Path"),
    });

    expect(screen.queryByText("Select Columns…")).not.toBeInTheDocument();
  });
});
