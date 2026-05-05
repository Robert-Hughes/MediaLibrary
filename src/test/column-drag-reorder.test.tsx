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

describe("column header drag-and-drop reorder — image metadata", () => {
  it("image metadata column headers are draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={[]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]"));
    expect(headers.length).toBeGreaterThan(0);
  });

  it("drag right: inserts column before the drop target", () => {
    // [IFD0:Model, ExifIFD:DateTimeOriginal, GPS:GPSLatitude]
    // drag IFD0:Model (0) onto GPS:GPSLatitude (2) → IFD0:Model placed before GPS
    const onColumnsReorder = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal", "GPS:GPSLatitude"]}
        visibleOSColumns={[]}
        onColumnsReorder={onColumnsReorder}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modelHeader = headers.find((h) => h.textContent?.includes("IFD0:Model"))!;
    const gpsHeader = headers.find((h) => h.textContent?.includes("GPS:GPSLatitude"))!;

    fireEvent.dragStart(modelHeader);
    fireEvent.dragOver(gpsHeader);
    fireEvent.drop(gpsHeader);

    // IFD0:Model should land immediately before GPS:GPSLatitude
    expect(onColumnsReorder).toHaveBeenCalledWith(
      ["ExifIFD:DateTimeOriginal", "IFD0:Model", "GPS:GPSLatitude"]
    );
  });

  it("drag left: inserts column before the drop target", () => {
    // [IFD0:Model, ExifIFD:DateTimeOriginal, GPS:GPSLatitude]
    // drag GPS:GPSLatitude (2) onto IFD0:Model (0) → GPS placed before IFD0:Model
    const onColumnsReorder = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal", "GPS:GPSLatitude"]}
        visibleOSColumns={[]}
        onColumnsReorder={onColumnsReorder}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modelHeader = headers.find((h) => h.textContent?.includes("IFD0:Model"))!;
    const gpsHeader = headers.find((h) => h.textContent?.includes("GPS:GPSLatitude"))!;

    fireEvent.dragStart(gpsHeader);
    fireEvent.dragOver(modelHeader);
    fireEvent.drop(modelHeader);

    expect(onColumnsReorder).toHaveBeenCalledWith(
      ["GPS:GPSLatitude", "IFD0:Model", "ExifIFD:DateTimeOriginal"]
    );
  });

  it("does not call onColumnsReorder when dropping onto the same column", () => {
    const onColumnsReorder = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={[]}
        onColumnsReorder={onColumnsReorder}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modelHeader = headers.find((h) => h.textContent?.includes("IFD0:Model"))!;

    fireEvent.dragStart(modelHeader);
    fireEvent.dragOver(modelHeader);
    fireEvent.drop(modelHeader);

    expect(onColumnsReorder).not.toHaveBeenCalled();
  });
});

describe("column header drag-and-drop reorder — OS metadata", () => {
  it("OS metadata column headers are draggable", () => {
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
    const modifiedHeader = document.querySelector(".grid-header--sortable[draggable]");
    expect(modifiedHeader).not.toBeNull();
  });

  it("calls onOSColumnsReorder when OS column is dragged left onto the other", () => {
    // drag Created (1) onto Modified (0) → Created placed before Modified
    const onOSColumnsReorder = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified", "date_created"]}
        onOSColumnsReorder={onOSColumnsReorder}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modifiedHeader = headers.find((h) => h.textContent?.includes("Modified"))!;
    const createdHeader = headers.find((h) => h.textContent?.includes("Created"))!;

    // Drag Created (right) onto Modified (left) → Created moves before Modified
    fireEvent.dragStart(createdHeader);
    fireEvent.dragOver(modifiedHeader);
    fireEvent.drop(modifiedHeader);

    expect(onOSColumnsReorder).toHaveBeenCalledWith(["date_created", "date_modified"]);
  });

  it("does not call onColumnsReorder when OS column dropped onto image column (cross-group drop ignored)", () => {
    const onColumnsReorder = vi.fn();
    const onOSColumnsReorder = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model"]}
        visibleOSColumns={["date_modified", "date_created"]}
        onColumnsReorder={onColumnsReorder}
        onOSColumnsReorder={onOSColumnsReorder}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const allHeaders = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modifiedHeader = allHeaders.find((h) => h.textContent?.includes("Modified"))!;
    const modelHeader = allHeaders.find((h) => h.textContent?.includes("IFD0:Model"))!;

    // Drag OS column onto image column — cross-group, should be ignored
    fireEvent.dragStart(modifiedHeader);
    fireEvent.dragOver(modelHeader);
    fireEvent.drop(modelHeader);

    expect(onColumnsReorder).not.toHaveBeenCalled();
    expect(onOSColumnsReorder).not.toHaveBeenCalled();
  });
});

describe("drag-over visual indicator", () => {
  it("adds drag-over class to the drop target header during dragover", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={[]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modelHeader = headers.find((h) => h.textContent?.includes("IFD0:Model"))!;
    const dtHeader = headers.find((h) => h.textContent?.includes("ExifIFD:DateTimeOriginal"))!;

    fireEvent.dragStart(modelHeader);
    fireEvent.dragOver(dtHeader);

    expect(dtHeader.classList.contains("grid-header--drag-over")).toBe(true);
  });

  it("removes drag-over class after drop", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={[]}
        onColumnsReorder={() => {}}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );

    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modelHeader = headers.find((h) => h.textContent?.includes("IFD0:Model"))!;
    const dtHeader = headers.find((h) => h.textContent?.includes("ExifIFD:DateTimeOriginal"))!;

    fireEvent.dragStart(modelHeader);
    fireEvent.dragOver(dtHeader);
    fireEvent.drop(dtHeader);

    expect(dtHeader.classList.contains("grid-header--drag-over")).toBe(false);
  });

  it("path column is not draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={[]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    // With no OS or image columns, only the Path header is present — it should not have draggable
    const draggableHeaders = document.querySelectorAll(".grid-header--sortable[draggable]");
    expect(draggableHeaders.length).toBe(0);
  });
});
