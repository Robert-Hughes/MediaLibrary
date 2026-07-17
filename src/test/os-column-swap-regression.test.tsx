import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import type { PhotoInfo, VisibleColumn } from "../types";

const photos: PhotoInfo[] = [
  // distinct timestamps so the rendered cells differ
  {
    relative_path: "a.jpg",
    filename: "a.jpg",
    date_modified: 1700000000,
    date_created: 1500000000,
  },
];

function makeStores() {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataOccurrencesStore();
  photos.forEach((p) => {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  });
  return { thumbnails, imageMetadata };
}

function renderWith(visibleColumns: VisibleColumn[]) {
  const { thumbnails, imageMetadata } = makeStores();
  return render(
    <PhotoList
      photos={photos}
      thumbnails={thumbnails}
      imageMetadataOccurrences={imageMetadata}
      visibleColumns={visibleColumns}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedIndex={null}
      onSelect={() => {}}
      onShowInExplorer={() => {}}
      onVisibilityChange={() => {}}
      onPhotoOpen={() => {}}
    />,
  );
}

describe("OS metadata column swap regression", () => {
  it("renders cells in the same order as headers when modified comes first", () => {
    renderWith([
      { key: "date_modified", kind: "os" },
      { key: "date_created", kind: "os" },
    ]);
    const modifiedCell = screen.getByTestId("photo-date-modified");
    const createdCell = screen.getByTestId("photo-date-created");
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
    const modifiedCell = screen.getByTestId("photo-date-modified");
    const createdCell = screen.getByTestId("photo-date-created");
    expect(
      createdCell.compareDocumentPosition(modifiedCell) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
