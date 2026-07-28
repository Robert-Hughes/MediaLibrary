import { render } from "@testing-library/react";
import { describe, it, vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";
import { imgCol } from "./factories";

describe("FileList", () => {
  it("renders without crashing", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();

    const files = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        media_kind: "image" as const,
        date_modified: null,
        date_created: null,
      },
    ];

    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
          imgCol("IFD0:Model"),
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );
  });
});
