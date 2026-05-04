import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo } from "../types";

describe("PhotoList Image Metadata group header visibility", () => {
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

  it("shows Image Metadata group header when image columns are enabled", () => {
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={["date_modified"]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.getByText("Image Metadata")).toBeInTheDocument();
  });

  it("hides Image Metadata group header when no image columns are enabled", () => {
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.queryByText("Image Metadata")).not.toBeInTheDocument();
  });

  it("hides Image Metadata group header in empty-state render (no photos yet)", () => {
    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataStore();
    render(
      <PhotoList
        photos={[]}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.queryByText("Image Metadata")).not.toBeInTheDocument();
  });

  it("shows Image Metadata group header in empty-state render when columns are enabled", () => {
    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataStore();
    render(
      <PhotoList
        photos={[]}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={["date_modified"]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(screen.getByText("Image Metadata")).toBeInTheDocument();
  });
});

describe("PhotoList group header context menu", () => {
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

  it("shows context menu when right-clicking the OS Metadata group header", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={["date_modified"]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />
    );

    const osHeader = screen.getByText("OS Metadata");
    await userEvent.pointer({ keys: "[MouseRight]", target: osHeader });
    expect(screen.getByText("Select Columns...")).toBeInTheDocument();
  });

  it("shows context menu when right-clicking the Image Metadata group header", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={["date_modified"]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />
    );

    const imgHeader = screen.getByText("Image Metadata");
    await userEvent.pointer({ keys: "[MouseRight]", target: imgHeader });
    expect(screen.getByText("Select Columns...")).toBeInTheDocument();
  });

  it("clicking Select Columns from group header context menu invokes onSelectColumns", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, imageMetadata } = makeStores(mockPhotos);
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={["ExifIFD:DateTimeOriginal"]}
        visibleOSColumns={["date_modified"]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />
    );

    const osHeader = screen.getByText("OS Metadata");
    await userEvent.pointer({ keys: "[MouseRight]", target: osHeader });
    await userEvent.click(screen.getByText("Select Columns..."));
    expect(onSelectColumns).toHaveBeenCalledTimes(1);
  });
});
