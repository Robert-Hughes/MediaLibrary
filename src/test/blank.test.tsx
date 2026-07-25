import { render } from "@testing-library/react";
import { describe, it, vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import { imgCol } from "./factories";

describe("FileList", () => {
  it("renders without crashing", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataOccurrencesStore();

    const files = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        date_modified: null,
        date_created: null,
      },
    ];

    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        imageMetadataOccurrences={metadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
          imgCol("IFD0:Model"),
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );
  });
});
