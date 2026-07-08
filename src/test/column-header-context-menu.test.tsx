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
    {
      relative_path: "photo2.jpg",
      filename: "photo2.jpg",
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

  describe("remove field action", () => {
    let onRemoveFieldMock: any;
    let originalConfirm: any;

    beforeEach(() => {
      onRemoveFieldMock = vi.fn();
      originalConfirm = window.confirm;
      window.confirm = vi.fn();
    });

    afterEach(() => {
      window.confirm = originalConfirm;
    });

    it("does not show remove field option on Path or OS columns", async () => {
      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[
            { key: "date_modified", kind: "os" },
            { key: "ExifIFD:DateTimeOriginal", kind: "image" },
          ]}
          {...defaultSortProps}
          selectedIndex={0}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
        />,
      );

      // Right-click Path column
      const pathHeader = screen.getByText("Path");
      await userEvent.pointer({ keys: "[MouseRight]", target: pathHeader });
      expect(screen.queryByText(/Remove field from/)).not.toBeInTheDocument();

      // Right-click Modified column
      const modifiedHeader = screen.getByText("Modified");
      await userEvent.pointer({ keys: "[MouseRight]", target: modifiedHeader });
      expect(screen.queryByText(/Remove field from/)).not.toBeInTheDocument();
    });

    it("shows remove option on image columns, confirm cancel does not call handler", async () => {
      vi.mocked(window.confirm).mockReturnValue(false);

      // Setup metadata: photo1 has ExifIFD:DateTimeOriginal, photo2 does not
      metadataStore.set("photo1.jpg", {
        "ExifIFD:DateTimeOriginal": {
          kind: "Text",
          value: "2022:01:01 12:00:00",
        },
      });
      metadataStore.set("photo2.jpg", {});

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[{ key: "ExifIFD:DateTimeOriginal", kind: "image" }]}
          {...defaultSortProps}
          selectedIndex={0} // photo1 is selected
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
        />,
      );

      // We'll select both photo1 and photo2 to test multi-selection
      const user = userEvent.setup();
      const rows = screen.getAllByTestId("photo-row");
      await user.click(rows[0]);
      await user.keyboard("{Control>}");
      await user.click(rows[1]);
      await user.keyboard("{/Control}");

      // Right-click image column header
      const imageHeader = screen.getByText("ExifIFD:DateTimeOriginal");
      await user.pointer({ keys: "[MouseRight]", target: imageHeader });

      const removeOption = screen.getByText("Remove field from 2 photos…");
      expect(removeOption).toBeInTheDocument();
      expect(screen.getByText("Select Columns…")).toBeInTheDocument();

      await user.click(removeOption);

      expect(window.confirm).toHaveBeenCalled();
      const confirmArg = vi.mocked(window.confirm).mock.calls[0][0];
      expect(confirmArg).toContain(
        "Stage removal of ExifIFD:DateTimeOriginal from 2 photos?",
      );
      expect(confirmArg).toContain(
        "This field currently has a value on 1 selected photo.",
      );
      expect(confirmArg).toContain("pending delete edits only");
      expect(confirmArg).toContain("Nothing will be written");

      expect(onRemoveFieldMock).not.toHaveBeenCalled();
    });

    it("confirm accept calls onRemoveFieldFromSelectedPhotos with correct args", async () => {
      vi.mocked(window.confirm).mockReturnValue(true);

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[{ key: "ExifIFD:DateTimeOriginal", kind: "image" }]}
          {...defaultSortProps}
          selectedIndex={0}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
        />,
      );

      const user = userEvent.setup();
      const rows = screen.getAllByTestId("photo-row");
      await user.click(rows[0]);
      await user.keyboard("{Control>}");
      await user.click(rows[1]);
      await user.keyboard("{/Control}");

      const imageHeader = screen.getByText("ExifIFD:DateTimeOriginal");
      await user.pointer({ keys: "[MouseRight]", target: imageHeader });

      const removeOption = screen.getByText("Remove field from 2 photos…");
      await user.click(removeOption);

      expect(onRemoveFieldMock).toHaveBeenCalledWith(
        "ExifIFD:DateTimeOriginal",
        ["photo1.jpg", "photo2.jpg"],
      );
    });

    it("respects draft overlays for present count", async () => {
      vi.mocked(window.confirm).mockReturnValue(true);

      // photo1 has value in metadata but Delete draft edit (effectively absent)
      metadataStore.set("photo1.jpg", {
        "ExifIFD:DateTimeOriginal": {
          kind: "Text",
          value: "2022:01:01 12:00:00",
        },
      });
      // photo2 has no value in metadata but Set draft edit (effectively present)
      metadataStore.set("photo2.jpg", {});

      const draftEdits = {
        "photo1.jpg": {
          "ExifIFD:DateTimeOriginal": {
            intent: "Delete" as const,
            value: null,
          },
        },
        "photo2.jpg": {
          "ExifIFD:DateTimeOriginal": {
            intent: "Set" as const,
            value: { kind: "Text" as const, value: "2022:02:02 12:00:00" },
          },
        },
      };

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[{ key: "ExifIFD:DateTimeOriginal", kind: "image" }]}
          {...defaultSortProps}
          selectedIndex={0}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          draftEdits={draftEdits}
        />,
      );

      const user = userEvent.setup();
      const rows = screen.getAllByTestId("photo-row");
      await user.click(rows[0]);
      await user.keyboard("{Control>}");
      await user.click(rows[1]);
      await user.keyboard("{/Control}");

      const imageHeader = screen.getByText("ExifIFD:DateTimeOriginal");
      await user.pointer({ keys: "[MouseRight]", target: imageHeader });

      const removeOption = screen.getByText("Remove field from 2 photos…");
      await user.click(removeOption);

      expect(window.confirm).toHaveBeenCalled();
      const confirmArg = vi.mocked(window.confirm).mock.calls[0][0];
      // photo1: effectively absent (Delete draft)
      // photo2: effectively present (Set draft)
      // Total present: 1
      expect(confirmArg).toContain(
        "This field currently has a value on 1 selected photo.",
      );
    });
  });
});
