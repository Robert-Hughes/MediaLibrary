import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, SchemaDefinitionId } from "../types";
import type { MetadataRemovalFilesPreviewV5 } from "../metadataRemovalTargets";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";
import { imgCol, mockDraftsByFile, mockMetadata, testId } from "./factories";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  message: vi.fn(),
}));

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

    _clearTagInfoCache();
    _setTagInfoCacheEntry("ExifIFD:DateTimeOriginal", {
      group: "ExifIFD",
      name: "DateTimeOriginal",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    _setTagInfoCacheEntry("IFD0:Model", {
      group: "IFD0",
      name: "Model",
      writable: true,
      kind: { kind: "Text" },
      description: null,
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
          imgCol("ExifIFD:DateTimeOriginal"),
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
          imgCol("ExifIFD:DateTimeOriginal"),
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
          imgCol("ExifIFD:DateTimeOriginal"),
          imgCol("IFD0:Model"),
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
          imgCol("ExifIFD:DateTimeOriginal"),
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
    let onRemoveFieldMock: ReturnType<
      typeof vi.fn<(id: SchemaDefinitionId, paths: string[]) => boolean>
    >;
    let onPreviewFieldMock: ReturnType<
      typeof vi.fn<
        (
          id: SchemaDefinitionId,
          paths: string[],
        ) => MetadataRemovalFilesPreviewV5
      >
    >;

    beforeEach(() => {
      onRemoveFieldMock = vi.fn(() => true);
      onPreviewFieldMock = vi.fn((_id: unknown, paths: string[]) => ({
        kind: "ready" as const,
        photoCount: paths.length,
        affectedPhotoCount: 1,
        existingFieldsToDelete: 1,
        stagedCreationsToCancel: 0,
        noOpPhotoCount: Math.max(0, paths.length - 1),
      }));
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("does not show remove field option on Path or OS columns", async () => {
      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[
            { key: "date_modified", kind: "os" },
            imgCol("ExifIFD:DateTimeOriginal"),
          ]}
          {...defaultSortProps}
          selectedIndex={0}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
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

    it("shows remove option on image columns, confirm cancel does not call handler (selection scope)", async () => {
      vi.mocked(ask).mockResolvedValue(false);

      // Setup metadata: photo1 has ExifIFD:DateTimeOriginal, photo2 does not
      metadataStore.set(
        "photo1.jpg",
        mockMetadata({
          "ExifIFD:DateTimeOriginal": {
            kind: "Text",
            value: "2022:01:01 12:00:00",
          },
        }),
      );
      metadataStore.set("photo2.jpg", {});

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={0} // photo1 is selected
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
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

      expect(ask).toHaveBeenCalled();
      const confirmArg = vi.mocked(ask).mock.calls[0][0];
      expect(confirmArg).toContain(
        "Stage removal of ExifIFD:DateTimeOriginal from 2 selected photos?",
      );
      expect(confirmArg).toContain(
        "1 existing field will receive pending delete edit.",
      );
      expect(confirmArg).toContain("1 photo requires no change.");
      expect(confirmArg).not.toContain("delete edits only");
      expect(confirmArg).toContain("Nothing will be written");

      expect(onRemoveFieldMock).not.toHaveBeenCalled();
    });

    it("confirm accept calls onRemoveFieldFromSelectedPhotos with correct args", async () => {
      vi.mocked(ask).mockResolvedValue(true);

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={0}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
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
        testId("ExifIFD:DateTimeOriginal"),
        ["photo1.jpg", "photo2.jpg"],
      );
    });

    it("uses the target-aware preview instead of compatibility overlays", async () => {
      vi.mocked(ask).mockResolvedValue(true);

      onPreviewFieldMock.mockReturnValue({
        kind: "ready",
        photoCount: 2,
        affectedPhotoCount: 1,
        existingFieldsToDelete: 0,
        stagedCreationsToCancel: 1,
        noOpPhotoCount: 1,
      });

      // photo1 has value in metadata but Delete draft edit (effectively absent)
      metadataStore.set(
        "photo1.jpg",
        mockMetadata({
          "ExifIFD:DateTimeOriginal": {
            kind: "Text",
            value: "2022:01:01 12:00:00",
          },
        }),
      );
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
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={0}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
          draftEdits={mockDraftsByFile(draftEdits)}
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

      expect(ask).toHaveBeenCalled();
      const confirmArg = vi.mocked(ask).mock.calls[0][0];
      expect(confirmArg).toContain(
        "1 staged new-property addition will be cancelled.",
      );
      expect(confirmArg).toContain("1 photo requires no change.");
      expect(confirmArg).not.toContain("currently has a value");
    });

    it("reports a blocked exact preview with its affected path and does not confirm", async () => {
      onPreviewFieldMock.mockReturnValue({
        kind: "blocked",
        relativePath: "photo2.jpg",
        reason: "Several authoritative occurrences share the exact schema.",
      });
      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={null}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
        />,
      );

      const user = userEvent.setup();
      await user.pointer({
        keys: "[MouseRight]",
        target: screen.getByText("ExifIFD:DateTimeOriginal"),
      });
      await user.click(screen.getByText("Remove field from all 2 photos…"));

      expect(message).toHaveBeenCalledWith(
        expect.stringMatching(/photo2\.jpg.*Several authoritative/s),
        expect.objectContaining({ kind: "error" }),
      );
      expect(ask).not.toHaveBeenCalled();
      expect(onRemoveFieldMock).not.toHaveBeenCalled();
    });

    it("reports an all-no-op exact preview without confirmation or mutation", async () => {
      onPreviewFieldMock.mockReturnValue({
        kind: "ready",
        photoCount: 2,
        affectedPhotoCount: 0,
        existingFieldsToDelete: 0,
        stagedCreationsToCancel: 0,
        noOpPhotoCount: 2,
      });
      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={null}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
        />,
      );

      const user = userEvent.setup();
      await user.pointer({
        keys: "[MouseRight]",
        target: screen.getByText("ExifIFD:DateTimeOriginal"),
      });
      await user.click(screen.getByText("Remove field from all 2 photos…"));

      expect(message).toHaveBeenCalledWith(
        expect.stringContaining("No change is needed"),
        expect.objectContaining({ kind: "info" }),
      );
      expect(ask).not.toHaveBeenCalled();
      expect(onRemoveFieldMock).not.toHaveBeenCalled();
    });

    it("A/B. No selection -> operates on all photos in list, confirm message matches 'all' scope", async () => {
      vi.mocked(ask).mockResolvedValue(true);

      // Setup metadata: photo1 has value, photo2 does not
      metadataStore.set(
        "photo1.jpg",
        mockMetadata({
          "ExifIFD:DateTimeOriginal": {
            kind: "Text",
            value: "2022:01:01 12:00:00",
          },
        }),
      );
      metadataStore.set("photo2.jpg", {});

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={null} // NO selected photo
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
        />,
      );

      const user = userEvent.setup();
      const imageHeader = screen.getByText("ExifIFD:DateTimeOriginal");
      await user.pointer({ keys: "[MouseRight]", target: imageHeader });

      // Label should be "Remove field from all 2 photos…"
      const removeOption = screen.getByText("Remove field from all 2 photos…");
      expect(removeOption).toBeInTheDocument();

      await user.click(removeOption);

      expect(ask).toHaveBeenCalled();
      const confirmArg = vi.mocked(ask).mock.calls[0][0];
      expect(confirmArg).toContain(
        "Stage removal of ExifIFD:DateTimeOriginal from all 2 photos in the current list?",
      );
      expect(confirmArg).toContain(
        "1 existing field will receive pending delete edit.",
      );
      expect(confirmArg).not.toContain("delete edits only");
      expect(confirmArg).toContain("Nothing will be written");

      // Verify it operates on ALL photos
      expect(onRemoveFieldMock).toHaveBeenCalledWith(
        testId("ExifIFD:DateTimeOriginal"),
        ["photo1.jpg", "photo2.jpg"],
      );
    });

    it("C. Selection still wins over all", async () => {
      vi.mocked(ask).mockResolvedValue(true);

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={0} // Photo 1 is selected
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
        />,
      );

      const user = userEvent.setup();
      const imageHeader = screen.getByText("ExifIFD:DateTimeOriginal");
      await user.pointer({ keys: "[MouseRight]", target: imageHeader });

      // Only photo1 is selected, so label should be "Remove field from 1 photo…"
      const removeOption = screen.getByText("Remove field from 1 photo…");
      expect(removeOption).toBeInTheDocument();

      await user.click(removeOption);

      // Verify callback receives only photo1.jpg
      expect(onRemoveFieldMock).toHaveBeenCalledWith(
        testId("ExifIFD:DateTimeOriginal"),
        ["photo1.jpg"],
      );
    });

    it("E. Decoupled menu: remove works without Select Columns", async () => {
      vi.mocked(ask).mockResolvedValue(true);

      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={0}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          // No onSelectColumns
          onRemoveFieldFromSelectedPhotos={onRemoveFieldMock}
          onPreviewRemoveFieldFromSelectedPhotos={onPreviewFieldMock}
        />,
      );

      const user = userEvent.setup();
      const imageHeader = screen.getByText("ExifIFD:DateTimeOriginal");
      await user.pointer({ keys: "[MouseRight]", target: imageHeader });

      // Menu should show "Remove field from 1 photo…"
      const removeOption = screen.getByText("Remove field from 1 photo…");
      expect(removeOption).toBeInTheDocument();

      // "Select Columns…" should NOT be present
      expect(screen.queryByText("Select Columns…")).not.toBeInTheDocument();

      await user.click(removeOption);
      expect(onRemoveFieldMock).toHaveBeenCalled();
    });

    it("F. Existing Select Columns behaviour remains", async () => {
      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[{ key: "date_modified", kind: "os" }]}
          {...defaultSortProps}
          selectedIndex={null}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          onSelectColumns={onSelectColumnsMock}
        />,
      );

      const user = userEvent.setup();
      const modifiedHeader = screen.getByText("Modified");
      await user.pointer({ keys: "[MouseRight]", target: modifiedHeader });

      const selectOption = screen.getByText("Select Columns…");
      expect(selectOption).toBeInTheDocument();
      await user.click(selectOption);
      expect(onSelectColumnsMock).toHaveBeenCalledTimes(1);
    });

    it("G. If neither callback exists, context menu does not open", async () => {
      render(
        <PhotoList
          photos={mockPhotos}
          thumbnails={thumbnailStore}
          imageMetadata={metadataStore}
          visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
          {...defaultSortProps}
          selectedIndex={null}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onPhotoOpen={() => {}}
          // No callbacks provided
        />,
      );

      const user = userEvent.setup();
      const imageHeader = screen.getByText("ExifIFD:DateTimeOriginal");
      await user.pointer({ keys: "[MouseRight]", target: imageHeader });

      // No context menu should render
      expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
    });
  });
});
