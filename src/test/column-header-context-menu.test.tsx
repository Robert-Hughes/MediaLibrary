import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo } from "../types";

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

describe("PhotoList column header context menu", () => {
  const mockPhotos: PhotoInfo[] = [
    {
      relative_path: "photo1.jpg",
      filename: "photo1.jpg",
      date_modified: 1640995200,
      date_created: 1640995200,
    },
  ];

  let thumbnailStore: ThumbnailStore;
  let metadataStore: ImageMetadataStore;
  let onSelectColumnsMock: () => void;

  beforeEach(() => {
    thumbnailStore = new ThumbnailStore();
    metadataStore = new ImageMetadataStore();
    onSelectColumnsMock = vi.fn();

    mockPhotos.forEach((photo) => {
      thumbnailStore.add(photo.relative_path);
      metadataStore.add(photo.relative_path);
    });
  });

  it("shows context menu when right-clicking on column headers", async () => {
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumnsMock}
      />,
    );

    // Right-click on the Path column header
    const pathHeader = screen.getByText("Path");
    await userEvent.pointer({ keys: "[MouseRight]", target: pathHeader });

    // Should show context menu with "Select Columns..." option
    expect(screen.getByText("Select Columns…")).toBeInTheDocument();
  });

  it("calls onSelectColumns when clicking 'Select Columns...' in context menu", async () => {
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumnsMock}
      />,
    );

    // Right-click on the Modified column header
    const modifiedHeader = screen.getByText("Modified");
    await userEvent.pointer({ keys: "[MouseRight]", target: modifiedHeader });

    // Click on "Select Columns..." option
    const selectColumnsOption = screen.getByText("Select Columns…");
    await userEvent.click(selectColumnsOption);

    expect(onSelectColumnsMock).toHaveBeenCalledTimes(1);
  });

  it("works on image metadata column headers too", async () => {
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
          { key: "IFD0:Model", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        onSelectColumns={onSelectColumnsMock}
      />,
    );

    // Right-click on an image metadata column header
    const dateHeader = screen.getByText("ExifIFD:DateTimeOriginal");
    await userEvent.pointer({ keys: "[MouseRight]", target: dateHeader });

    // Should show context menu
    expect(screen.getByText("Select Columns…")).toBeInTheDocument();

    // Click on "Select Columns..." option
    const selectColumnsOption = screen.getByText("Select Columns…");
    await userEvent.click(selectColumnsOption);

    expect(onSelectColumnsMock).toHaveBeenCalledTimes(1);
  });

  it("does not show context menu when onSelectColumns is not provided", async () => {
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        // No onSelectColumns provided
      />,
    );

    // Right-click on the Path column header
    const pathHeader = screen.getByText("Path");
    await userEvent.pointer({ keys: "[MouseRight]", target: pathHeader });

    // Should not show context menu
    expect(screen.queryByText("Select Columns...")).not.toBeInTheDocument();
  });
});
