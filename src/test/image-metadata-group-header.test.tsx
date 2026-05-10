import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, VisibleColumn } from "../types";

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

const mockPhotos: PhotoInfo[] = [
  {
    relative_path: "photo1.jpg",
    filename: "photo1.jpg",
    date_modified: 1640995200,
    date_created: 1640995200,
  },
];

function makeStores(photos: PhotoInfo[]) {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataStore();
  photos.forEach((p) => {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  });
  return { thumbnails, imageMetadata };
}

const osCol = (key: string): VisibleColumn => ({ key, kind: "os" });
const imgCol = (key: string): VisibleColumn => ({ key, kind: "image" });

describe("PhotoList per-column kind labels", () => {
  it("shows 'Image' label above each image-metadata column header", () => {
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[osCol("date_modified"), imgCol("ExifIFD:DateTimeOriginal")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.getByText("Image")).toBeInTheDocument();
    expect(screen.getByText("OS")).toBeInTheDocument();
  });

  it("does not render any 'Image' kind label when no image columns are enabled", () => {
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[osCol("date_modified")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.queryByText("Image")).not.toBeInTheDocument();
  });

  it("renders no kind labels in empty-state when no metadata columns are enabled", () => {
    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataStore();
    render(
      <PhotoList
        photos={[]}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.queryByText("Image")).not.toBeInTheDocument();
    expect(screen.queryByText("OS")).not.toBeInTheDocument();
  });

  it("renders one 'Image' label per image column when multiple image columns are enabled", () => {
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[imgCol("ExifIFD:DateTimeOriginal"), imgCol("IFD0:Model")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.getAllByText("Image")).toHaveLength(2);
  });
});

describe("PhotoList kind-label context menu", () => {
  it("shows context menu when right-clicking an 'OS' kind label", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[osCol("date_modified"), imgCol("ExifIFD:DateTimeOriginal")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />
    );

    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("OS") });
    expect(screen.getByText("Select Columns...")).toBeInTheDocument();
  });

  it("shows context menu when right-clicking an 'Image' kind label", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />
    );

    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("Image") });
    expect(screen.getByText("Select Columns...")).toBeInTheDocument();
  });

  it("clicking Select Columns from a kind-label context menu invokes onSelectColumns", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[osCol("date_modified"), imgCol("ExifIFD:DateTimeOriginal")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />
    );

    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("OS") });
    await userEvent.click(screen.getByText("Select Columns..."));
    expect(onSelectColumns).toHaveBeenCalledTimes(1);
  });
});
