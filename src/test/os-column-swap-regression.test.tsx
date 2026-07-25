import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";
import type { FileInfo, VisibleColumn } from "../types";

const files: FileInfo[] = [
  // distinct timestamps so the rendered cells differ
  {
    relative_path: "a.jpg",
    filename: "a.jpg",
    media_kind: "image" as const,
    date_modified: 1700000000,
    date_created: 1500000000,
  },
];

function makeStores() {
  const thumbnails = new ThumbnailStore();
  const fileMetadata = new FileMetadataOccurrencesStore();
  files.forEach((p) => {
    thumbnails.add(p.relative_path);
    fileMetadata.add(p.relative_path);
  });
  return { thumbnails, fileMetadata };
}

function renderWith(visibleColumns: VisibleColumn[]) {
  const { thumbnails, fileMetadata } = makeStores();
  return render(
    <FileList
      targetDraftEdits={{}}
      files={files}
      thumbnails={thumbnails}
      fileMetadataOccurrences={fileMetadata}
      visibleColumns={visibleColumns}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedIndex={null}
      onSelect={() => {}}
      onShowInExplorer={() => {}}
      onVisibilityChange={() => {}}
      onFileOpen={() => {}}
    />,
  );
}

describe("OS metadata column swap regression", () => {
  it("renders cells in the same order as headers when modified comes first", () => {
    renderWith([
      { key: "date_modified", kind: "os" },
      { key: "date_created", kind: "os" },
    ]);
    const modifiedCell = screen.getByTestId("file-date-modified");
    const createdCell = screen.getByTestId("file-date-created");
    expect(
      modifiedCell.compareDocumentPosition(createdCell) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders cells in the same order as headers when created comes first (regression)", () => {
    // Previously the cells were always rendered modified-first regardless of
    // column order, so swapping the headers desync'd the data.
    renderWith([
      { key: "date_created", kind: "os" },
      { key: "date_modified", kind: "os" },
    ]);
    const modifiedCell = screen.getByTestId("file-date-modified");
    const createdCell = screen.getByTestId("file-date-created");
    expect(
      createdCell.compareDocumentPosition(modifiedCell) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
