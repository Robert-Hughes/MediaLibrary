import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, VisibleColumn } from "../types";

const BEFORE = -1;
const AFTER = 1;

function doDragOver(el: HTMLElement, clientX: number) {
  fireEvent(el, new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX }));
}
function doDrop(el: HTMLElement, clientX: number) {
  fireEvent(el, new MouseEvent("drop", { bubbles: true, cancelable: true, clientX }));
}

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

const img = (key: string): VisibleColumn => ({ key, kind: "image" });
const os = (key: string): VisibleColumn => ({ key, kind: "os" });

describe("column header draggable attribute", () => {
  it("image metadata column headers are draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[img("IFD0:Model"), img("ExifIFD:DateTimeOriginal")]}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    expect(document.querySelectorAll(".grid-header--sortable[draggable]").length).toBeGreaterThan(0);
  });

  it("OS metadata column headers are draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[os("date_modified"), os("date_created")]}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    expect(document.querySelectorAll(".grid-header--sortable[draggable]").length).toBe(2);
  });

  it("path column is NOT draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[]}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    expect(document.querySelectorAll(".grid-header--sortable[draggable]").length).toBe(0);
  });
});

describe("metadata column reorder insertion", () => {
  function setup(onColumnsReorder = vi.fn()) {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[img("IFD0:Model"), img("ExifIFD:DateTimeOriginal"), img("GPS:GPSLatitude")]}
        onColumnsReorder={onColumnsReorder}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const headers = () =>
      Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const get = (text: string) => headers().find((h) => h.textContent?.includes(text))!;
    return { onColumnsReorder, get };
  }

  it("drag right, drop on LEFT half → inserts before target", () => {
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("GPS:GPSLatitude"), BEFORE);
    doDrop(get("GPS:GPSLatitude"), BEFORE);
    expect(onColumnsReorder).toHaveBeenCalledWith([
      img("ExifIFD:DateTimeOriginal"), img("IFD0:Model"), img("GPS:GPSLatitude"),
    ]);
  });

  it("drag right, drop on RIGHT half → inserts after target", () => {
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), AFTER);
    doDrop(get("ExifIFD:DateTimeOriginal"), AFTER);
    expect(onColumnsReorder).toHaveBeenCalledWith([
      img("ExifIFD:DateTimeOriginal"), img("IFD0:Model"), img("GPS:GPSLatitude"),
    ]);
  });

  it("drag left, drop on LEFT half → inserts before target", () => {
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("GPS:GPSLatitude"));
    doDragOver(get("IFD0:Model"), BEFORE);
    doDrop(get("IFD0:Model"), BEFORE);
    expect(onColumnsReorder).toHaveBeenCalledWith([
      img("GPS:GPSLatitude"), img("IFD0:Model"), img("ExifIFD:DateTimeOriginal"),
    ]);
  });

  it("drag left, drop on RIGHT half → inserts after target", () => {
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("GPS:GPSLatitude"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), AFTER);
    doDrop(get("ExifIFD:DateTimeOriginal"), AFTER);
    expect(onColumnsReorder).toHaveBeenCalledWith([
      img("IFD0:Model"), img("ExifIFD:DateTimeOriginal"), img("GPS:GPSLatitude"),
    ]);
  });

  it("dropping onto the same column does nothing", () => {
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("IFD0:Model"), BEFORE);
    doDrop(get("IFD0:Model"), BEFORE);
    expect(onColumnsReorder).not.toHaveBeenCalled();
  });
});

describe("OS metadata column reorder insertion", () => {
  function setup(onColumnsReorder = vi.fn()) {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[os("date_modified"), os("date_created")]}
        onColumnsReorder={onColumnsReorder}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const headers = () =>
      Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const get = (text: string) => headers().find((h) => h.textContent?.includes(text))!;
    return { onColumnsReorder, get };
  }

  it("drag right-to-left, drop on LEFT half → inserts before target", () => {
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("Created"));
    doDragOver(get("Modified"), BEFORE);
    doDrop(get("Modified"), BEFORE);
    expect(onColumnsReorder).toHaveBeenCalledWith([os("date_created"), os("date_modified")]);
  });

  it("drag right-to-left, drop on RIGHT half → inserts after target (no-op)", () => {
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("Created"));
    doDragOver(get("Modified"), AFTER);
    doDrop(get("Modified"), AFTER);
    expect(onColumnsReorder).toHaveBeenCalledWith([os("date_modified"), os("date_created")]);
  });
});

describe("metadata column header gridColumn positions follow visibleColumns order", () => {
  function renderWithOrder(visibleColumns: VisibleColumn[]) {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={visibleColumns}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const headers = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const get = (label: string) => headers.find((h) => h.textContent?.includes(label))!;
    return { get };
  }

  it("renders [date_modified, date_created] at columns 3 and 4", () => {
    const { get } = renderWithOrder([os("date_modified"), os("date_created")]);
    expect(get("Modified").style.gridColumn).toBe("3");
    expect(get("Created").style.gridColumn).toBe("4");
  });

  it("renders [date_created, date_modified] at columns 3 and 4 in the reordered order", () => {
    const { get } = renderWithOrder([os("date_created"), os("date_modified")]);
    expect(get("Created").style.gridColumn).toBe("3");
    expect(get("Modified").style.gridColumn).toBe("4");
  });

  it("renders only date_created at column 3 when date_modified is hidden", () => {
    const { get } = renderWithOrder([os("date_created")]);
    expect(get("Created").style.gridColumn).toBe("3");
  });

  it("interleaved OS and image columns get sequential positions", () => {
    const { get } = renderWithOrder([
      img("IFD0:Model"),
      os("date_modified"),
      img("ExifIFD:DateTimeOriginal"),
    ]);
    expect(get("IFD0:Model").style.gridColumn).toBe("3");
    expect(get("Modified").style.gridColumn).toBe("4");
    expect(get("ExifIFD:DateTimeOriginal").style.gridColumn).toBe("5");
  });
});

describe("cross-kind drop is allowed (unified columns)", () => {
  it("dropping an OS column onto an image column reorders within the unified array", () => {
    const onColumnsReorder = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[os("date_modified"), os("date_created"), img("IFD0:Model")]}
        onColumnsReorder={onColumnsReorder}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const all = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modifiedHeader = all.find((h) => h.textContent?.includes("Modified"))!;
    const modelHeader = all.find((h) => h.textContent?.includes("IFD0:Model"))!;
    fireEvent.dragStart(modifiedHeader);
    doDragOver(modelHeader, BEFORE);
    doDrop(modelHeader, BEFORE);
    // date_modified was at index 0, dropped before IFD0:Model (index 2)
    expect(onColumnsReorder).toHaveBeenCalledWith([
      os("date_created"), os("date_modified"), img("IFD0:Model"),
    ]);
  });
});

describe("drag-over drop indicator", () => {
  function setup() {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[img("IFD0:Model"), img("ExifIFD:DateTimeOriginal")]}
        onColumnsReorder={() => {}}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const headers = () =>
      Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const get = (text: string) => headers().find((h) => h.textContent?.includes(text))!;
    return { get };
  }

  it("shows drop-before indicator on left half", () => {
    const { get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), BEFORE);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-before")).toBe(true);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-after")).toBe(false);
  });

  it("shows drop-after indicator on right half", () => {
    const { get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), AFTER);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-after")).toBe(true);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-before")).toBe(false);
  });

  it("indicator updates when cursor crosses the midpoint", () => {
    const { get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), BEFORE);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-before")).toBe(true);
    doDragOver(get("ExifIFD:DateTimeOriginal"), AFTER);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-after")).toBe(true);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-before")).toBe(false);
  });

  it("indicator is cleared after drop", () => {
    const { get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), BEFORE);
    doDrop(get("ExifIFD:DateTimeOriginal"), BEFORE);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-before")).toBe(false);
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-after")).toBe(false);
  });

  it("indicator is cleared after dragend", () => {
    const { get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), AFTER);
    fireEvent.dragEnd(get("IFD0:Model"));
    expect(get("ExifIFD:DateTimeOriginal").classList.contains("grid-header--drop-after")).toBe(false);
  });
});
