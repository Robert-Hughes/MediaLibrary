import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";
import type { FileInfo } from "../types";
import { imgCol, osCol } from "./factories";

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

const mockFiles: FileInfo[] = [
  {
    relative_path: "file1.jpg",
    filename: "file1.jpg",
    media_kind: "image" as const,
    date_modified: 1640995200,
    date_created: 1640995200,
  },
];

function makeStores(files: FileInfo[]) {
  const thumbnails = new ThumbnailStore();
  const fileMetadata = new FileMetadataOccurrencesStore();
  files.forEach((p) => {
    thumbnails.add(p.relative_path);
    fileMetadata.add(p.relative_path);
  });
  return { thumbnails, fileMetadata };
}

describe("FileList per-column kind labels", () => {
  it("shows 'Image' label above each image-metadata column header", () => {
    const { thumbnails, fileMetadata } = makeStores(mockFiles);
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[
          osCol("date_modified"),
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
      />,
    );
    expect(screen.getByText("Image")).toBeInTheDocument();
    expect(screen.getAllByText("OS")).toHaveLength(2);
  });

  it("does not render any 'Image' kind label when no image columns are enabled", () => {
    const { thumbnails, fileMetadata } = makeStores(mockFiles);
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[osCol("date_modified")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
      />,
    );
    expect(screen.queryByText("Image")).not.toBeInTheDocument();
  });

  it("renders only the Path OS kind label in empty-state when no metadata columns are enabled", () => {
    const thumbnails = new ThumbnailStore();
    const fileMetadata = new FileMetadataOccurrencesStore();
    render(
      <FileList
        targetDraftEdits={{}}
        files={[]}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
      />,
    );
    expect(screen.queryByText("Image")).not.toBeInTheDocument();
    expect(screen.getAllByText("OS")).toHaveLength(1);
  });

  it("formats Preview and Path with the same two-line header layout", () => {
    const { thumbnails, fileMetadata } = makeStores(mockFiles);
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
      />,
    );

    const previewHeader = screen
      .getByText("Preview")
      .closest(".grid-header") as HTMLElement;
    const pathHeader = screen
      .getByText("Path")
      .closest(".grid-header") as HTMLElement;

    expect(previewHeader).toHaveClass("grid-header--metadata");
    expect(pathHeader).toHaveClass("grid-header--metadata");
    expect(previewHeader.style.gridRow).toBe("1 / 3");
    expect(pathHeader.style.gridRow).toBe("1 / 3");
    expect(pathHeader.querySelector(".grid-header-kind")?.textContent).toBe(
      "OS",
    );
    expect(
      previewHeader.querySelector(".grid-header-kind--empty"),
    ).toBeInTheDocument();
  });

  it("renders one 'Image' label per image column when multiple image columns are enabled", () => {
    const { thumbnails, fileMetadata } = makeStores(mockFiles);
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[
          imgCol("ExifIFD:DateTimeOriginal"),
          imgCol("IFD0:Model"),
        ]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
      />,
    );
    expect(screen.getAllByText("Image")).toHaveLength(2);
  });
});

describe("FileList kind-label context menu", () => {
  it("shows context menu when right-clicking an 'OS' kind label", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, fileMetadata } = makeStores(mockFiles);
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[
          osCol("date_modified"),
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />,
    );

    const osKindLabels = screen.getAllByText("OS");
    await userEvent.pointer({ keys: "[MouseRight]", target: osKindLabels[1] });
    expect(screen.getByText("Select Columns…")).toBeInTheDocument();
  });

  it("shows context menu when right-clicking an 'Image' kind label", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, fileMetadata } = makeStores(mockFiles);
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[imgCol("ExifIFD:DateTimeOriginal")]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />,
    );

    await userEvent.pointer({
      keys: "[MouseRight]",
      target: screen.getByText("Image"),
    });
    expect(screen.getByText("Select Columns…")).toBeInTheDocument();
  });

  it("clicking Select Columns from a kind-label context menu invokes onSelectColumns", async () => {
    const onSelectColumns = vi.fn();
    const { thumbnails, fileMetadata } = makeStores(mockFiles);
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[
          osCol("date_modified"),
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        {...defaultSortProps}
        onFileOpen={() => {}}
        onSelectColumns={onSelectColumns}
      />,
    );

    const osKindLabels = screen.getAllByText("OS");
    await userEvent.pointer({ keys: "[MouseRight]", target: osKindLabels[1] });
    await userEvent.click(screen.getByText("Select Columns…"));
    expect(onSelectColumns).toHaveBeenCalledTimes(1);
  });
});
