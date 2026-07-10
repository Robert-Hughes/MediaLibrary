import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { mockMetadata } from "./factories";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import { _clearTagInfoCache, _setTagInfoCacheEntry } from "../hooks/useTagInfo";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

describe("PhotoRow", () => {
  beforeEach(() => {
    _clearTagInfoCache();
    _setTagInfoCacheEntry("IFD0:Model", null);
    _setTagInfoCacheEntry("ExifIFD:DateTimeOriginal", null);
  });

  it("renders PhotoList with photos without crashing", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();

    // add some metadata
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", mockMetadata({ Model: "Nikon" }));

    const photos = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        date_modified: null,
        date_created: null,
      },
    ];

    render(
      <PhotoList
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
          { key: "IFD0:Model", kind: "image" },
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );
  });

  it("fits thumbnail images without cropping", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", {});

    render(
      <PhotoList
        photos={[
          {
            relative_path: "1.jpg",
            filename: "1.jpg",
            date_modified: null,
            date_created: null,
          },
        ]}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
      />,
    );

    expect(document.querySelector(".photo-thumb-img")).not.toBeNull();
  });

  it("rows read gridTemplateColumns from a CSS custom property, not from props", () => {
    // Regression: gridColumns used to be a per-render string passed to every
    // memoised PhotoRow.  A column-resize drag (which fires setLiveWidths on
    // every pointermove) would change that string and re-render every visible
    // row.  The fix is to set --grid-columns on a parent and have rows read it
    // via var(--grid-columns) — a constant string that never changes per render.
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();
    const photos = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        date_modified: null,
        date_created: null,
      },
    ];
    thumbnails.add("1.jpg");
    metadata.add("1.jpg");

    render(
      <PhotoList
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "IFD0:Model", kind: "image" },
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    const row = screen.getByTestId("photo-row") as HTMLElement;
    expect(row.style.gridTemplateColumns).toBe("var(--grid-columns)");

    // The grid container exposes the variable so descendants can resolve it.
    const grid = screen.getByTestId("photo-list");
    expect(grid.style.getPropertyValue("--grid-columns")).not.toBe("");
  });

  it("displays em dash — for missing metadata and not mojibake â€”", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();

    // We add metadata as empty object, so "IFD0:Model" will be missing/undefined.
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", {});

    const photos = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        date_modified: null,
        date_created: null,
      },
    ];

    render(
      <PhotoList
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={[{ key: "IFD0:Model", kind: "image" }]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    expect(screen.queryByText("—")).not.toBeNull();
    expect(screen.queryByText("â€”")).toBeNull();
  });

  it("displays schema-backed enum labels for image metadata columns", () => {
    _setTagInfoCacheEntry("IFD0:Orientation", {
      group: "IFD0",
      name: "Orientation",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "Integer",
          options: [{ code: "6", label: "Rotate 90 CW" }],
        },
      },
      description: null,
    });

    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", {
      "IFD0:Orientation": { kind: "Integer", value: 6 },
    });

    render(
      <PhotoList
        photos={[
          {
            relative_path: "1.jpg",
            filename: "1.jpg",
            date_modified: null,
            date_created: null,
          },
        ]}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={[{ key: "IFD0:Orientation", kind: "image" }]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    const cell = document.querySelector('[data-col="IFD0:Orientation"]');
    expect(cell).not.toBeNull();
    expect(within(cell as HTMLElement).getByText("Rotate 90 CW")).toBeTruthy();
    expect(within(cell as HTMLElement).queryByText("6")).toBeNull();
  });

  it("falls back to generic image metadata display when schema is missing", () => {
    _setTagInfoCacheEntry("IFD0:Orientation", null);

    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", {
      "IFD0:Orientation": { kind: "Integer", value: 6 },
    });

    render(
      <PhotoList
        photos={[
          {
            relative_path: "1.jpg",
            filename: "1.jpg",
            date_modified: null,
            date_created: null,
          },
        ]}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={[{ key: "IFD0:Orientation", kind: "image" }]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    const cell = document.querySelector('[data-col="IFD0:Orientation"]');
    expect(cell).not.toBeNull();
    expect(within(cell as HTMLElement).getByText("6")).toBeTruthy();
    expect(within(cell as HTMLElement).queryByText("Rotate 90 CW")).toBeNull();
  });

  it("displays error cell ✗ on metadata failure and not mojibake âœ—", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();

    // We add metadata as failed by setting _error
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", { _error: "Failed to load metadata" } as any);

    const photos = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        date_modified: null,
        date_created: null,
      },
    ];

    render(
      <PhotoList
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={[{ key: "IFD0:Model", kind: "image" }]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    expect(screen.queryByText("✗")).not.toBeNull();
    expect(screen.queryByText("âœ—")).toBeNull();
  });
});
