import { render } from "@testing-library/react";
import { describe, it, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";

describe("PhotoList", () => {
  it("renders without crashing", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();
    
    const photos = [
      { relative_path: "1.jpg", filename: "1.jpg", date_modified: null, date_created: null }
    ];

    render(
      <PhotoList 
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={["ExifIFD:DateTimeOriginal", "IFD0:Model"]}
        visibleOSColumns={["date_modified", "date_created"]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />
    );
  });
});
