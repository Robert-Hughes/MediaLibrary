import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo } from "../types";

/**
 * jsdom's DragEvent constructor silently ignores `clientX` in its init dict,
 * so fireEvent.dragOver/drop({ clientX }) never reaches the handler.
 *
 * Workaround: dispatch a plain MouseEvent with type 'dragover'/'drop'.
 * MouseEvent DOES honour clientX from its init.  React's synthetic event
 * delegation fires onDragOver/onDrop based on the event type string, so the
 * correct handlers still run.
 *
 * getBoundingClientRect() returns all-zeros in jsdom → midpoint = 0:
 *   clientX: -1  →  -1 < 0  →  side = "before"  (drop indicator on left edge)
 *   clientX:  1  →   1 < 0  →  side = "after"   (drop indicator on right edge)
 */
const BEFORE = -1;
const AFTER  =  1;

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

// ── draggable attribute ───────────────────────────────────────────────────────

describe("column header draggable attribute", () => {
  it("image metadata column headers are draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal"]} visibleOSColumns={[]}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    expect(document.querySelectorAll(".grid-header--sortable[draggable]").length).toBeGreaterThan(0);
  });

  it("OS metadata column headers are draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[]} visibleOSColumns={["date_modified", "date_created"]}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    expect(document.querySelectorAll(".grid-header--sortable[draggable]").length).toBe(2);
  });

  it("path column is NOT draggable", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[]} visibleOSColumns={[]}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    expect(document.querySelectorAll(".grid-header--sortable[draggable]").length).toBe(0);
  });
});

// ── insertion logic ───────────────────────────────────────────────────────────

describe("image metadata column reorder insertion", () => {
  // columns: [IFD0:Model(0), ExifIFD(1), GPS(2)]
  function setup(onColumnsReorder = vi.fn()) {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal", "GPS:GPSLatitude"]}
        visibleOSColumns={[]} onColumnsReorder={onColumnsReorder}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const headers = () =>
      Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const get = (text: string) => headers().find((h) => h.textContent?.includes(text))!;
    return { onColumnsReorder, get };
  }

  it("drag right, drop on LEFT half → inserts before target", () => {
    // drag IFD0(0) onto GPS(2), left half → IFD0 lands before GPS
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("GPS:GPSLatitude"), BEFORE);
    doDrop(get("GPS:GPSLatitude"), BEFORE);
    expect(onColumnsReorder).toHaveBeenCalledWith(["ExifIFD:DateTimeOriginal", "IFD0:Model", "GPS:GPSLatitude"]);
  });

  it("drag right, drop on RIGHT half → inserts after target", () => {
    // drag IFD0(0) onto ExifIFD(1), right half → IFD0 lands after ExifIFD
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("IFD0:Model"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), AFTER);
    doDrop(get("ExifIFD:DateTimeOriginal"), AFTER);
    expect(onColumnsReorder).toHaveBeenCalledWith(["ExifIFD:DateTimeOriginal", "IFD0:Model", "GPS:GPSLatitude"]);
  });

  it("drag left, drop on LEFT half → inserts before target", () => {
    // drag GPS(2) onto IFD0(0), left half → GPS lands before IFD0
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("GPS:GPSLatitude"));
    doDragOver(get("IFD0:Model"), BEFORE);
    doDrop(get("IFD0:Model"), BEFORE);
    expect(onColumnsReorder).toHaveBeenCalledWith(["GPS:GPSLatitude", "IFD0:Model", "ExifIFD:DateTimeOriginal"]);
  });

  it("drag left, drop on RIGHT half → inserts after target", () => {
    // drag GPS(2) onto ExifIFD(1), right half → GPS lands after ExifIFD
    const { onColumnsReorder, get } = setup();
    fireEvent.dragStart(get("GPS:GPSLatitude"));
    doDragOver(get("ExifIFD:DateTimeOriginal"), AFTER);
    doDrop(get("ExifIFD:DateTimeOriginal"), AFTER);
    expect(onColumnsReorder).toHaveBeenCalledWith(["IFD0:Model", "ExifIFD:DateTimeOriginal", "GPS:GPSLatitude"]);
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
  // columns: [date_modified(0), date_created(1)]
  function setup(onOSColumnsReorder = vi.fn()) {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={[]} visibleOSColumns={["date_modified", "date_created"]}
        onOSColumnsReorder={onOSColumnsReorder}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const headers = () =>
      Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const get = (text: string) => headers().find((h) => h.textContent?.includes(text))!;
    return { onOSColumnsReorder, get };
  }

  it("drag right-to-left, drop on LEFT half → inserts before target", () => {
    // drag date_created(1) onto date_modified(0), left half → created before modified
    const { onOSColumnsReorder, get } = setup();
    fireEvent.dragStart(get("Created"));
    doDragOver(get("Modified"), BEFORE);
    doDrop(get("Modified"), BEFORE);
    expect(onOSColumnsReorder).toHaveBeenCalledWith(["date_created", "date_modified"]);
  });

  it("drag right-to-left, drop on RIGHT half → inserts after target (no-op)", () => {
    // drag date_created(1) onto date_modified(0), right half → created after modified = original order
    const { onOSColumnsReorder, get } = setup();
    fireEvent.dragStart(get("Created"));
    doDragOver(get("Modified"), AFTER);
    doDrop(get("Modified"), AFTER);
    expect(onOSColumnsReorder).toHaveBeenCalledWith(["date_modified", "date_created"]);
  });
});

describe("cross-group drop is ignored", () => {
  it("dropping an OS column onto an image column does nothing", () => {
    const onColumnsReorder = vi.fn();
    const onOSColumnsReorder = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model"]} visibleOSColumns={["date_modified", "date_created"]}
        onColumnsReorder={onColumnsReorder} onOSColumnsReorder={onOSColumnsReorder}
        {...defaultSortProps} selectedIndex={null} onSelect={() => {}}
        onShowInExplorer={() => {}} onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
    );
    const all = Array.from(document.querySelectorAll(".grid-header--sortable[draggable]")) as HTMLElement[];
    const modifiedHeader = all.find((h) => h.textContent?.includes("Modified"))!;
    const modelHeader    = all.find((h) => h.textContent?.includes("IFD0:Model"))!;
    fireEvent.dragStart(modifiedHeader);
    doDragOver(modelHeader, BEFORE);
    doDrop(modelHeader, BEFORE);
    expect(onColumnsReorder).not.toHaveBeenCalled();
    expect(onOSColumnsReorder).not.toHaveBeenCalled();
  });
});

// ── drop indicator classes ─────────────────────────────────────────────────────

describe("drag-over drop indicator", () => {
  function setup() {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <PhotoList photos={mockPhotos} thumbnails={thumbnails} imageMetadata={imageMetadata}
        visibleColumns={["IFD0:Model", "ExifIFD:DateTimeOriginal"]} visibleOSColumns={[]}
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
    // cursor moves to right half
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
