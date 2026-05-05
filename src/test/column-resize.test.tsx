import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo } from "../types";

const mockPhotos: PhotoInfo[] = [
  { relative_path: "a.jpg", filename: "a.jpg", date_modified: 100, date_created: 100 },
];

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

function makeStores() {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataStore();
  mockPhotos.forEach((p) => { thumbnails.add(p.relative_path); imageMetadata.add(p.relative_path); });
  return { thumbnails, imageMetadata };
}

describe("column resize handles", () => {
  it("renders a resize handle for the Path column", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector('[data-testid="resize-handle-relative_path"]')).not.toBeNull();
  });

  it("renders resize handles for OS metadata columns", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified", "date_created"]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector('[data-testid="resize-handle-date_modified"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="resize-handle-date_created"]')).not.toBeNull();
  });

  it("renders resize handle for image metadata columns", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model"]}
        visibleOSColumns={[]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector('[data-testid="resize-handle-IFD0:Model"]')).not.toBeNull();
  });

  it("calls onColumnWidthChange when a resize drag completes", () => {
    const onColumnWidthChange = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        columnWidths={{}}
        onColumnWidthChange={onColumnWidthChange}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const handle = document.querySelector('[data-testid="resize-handle-date_modified"]')!;

    // Simulate a drag: pointerdown at x=200, pointermove to x=250 (50px wider), pointerup
    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 250, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 250, pointerId: 1 });

    expect(onColumnWidthChange).toHaveBeenCalledWith("date_modified", expect.any(Number));
  });

  it("calls onColumnWidthChange with 0 on double-click (reset to auto)", () => {
    const onColumnWidthChange = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        columnWidths={{ date_modified: 200 }}
        onColumnWidthChange={onColumnWidthChange}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const handle = document.querySelector('[data-testid="resize-handle-date_modified"]')!;
    fireEvent.dblClick(handle);

    expect(onColumnWidthChange).toHaveBeenCalledWith("date_modified", 0);
  });

  it("clicking resize handle does not trigger column sort", () => {
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={onSortChange}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const handle = document.querySelector('[data-testid="resize-handle-date_modified"]')!;
    fireEvent.click(handle);

    expect(onSortChange).not.toHaveBeenCalled();
  });

  it("renders resize handles on empty-state (zero photos) headers too", () => {
    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataStore();
    render(
      <PhotoList
        photos={[]}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector('[data-testid="resize-handle-relative_path"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="resize-handle-date_modified"]')).not.toBeNull();
  });
});

describe("buildGridTemplate (via rendered styles)", () => {
  it("applies saved column widths as pixel values in grid template", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        columnWidths={{ relative_path: 350, date_modified: 140 }}
        onColumnWidthChange={() => {}}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    const grid = document.querySelector(".photo-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("350px");
    expect(grid.style.gridTemplateColumns).toContain("140px");
  });

  it("uses minmax defaults when no column widths are provided", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    const grid = document.querySelector(".photo-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("minmax(");
  });
});
