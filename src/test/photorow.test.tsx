import { render } from "@testing-library/react";
import { describe, it, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";

describe("PhotoRow", () => {
  it("renders PhotoList with photos without crashing", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new ImageMetadataStore();
    
    // add some metadata
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", { Model: "Nikon" });

    const photos = [
      { relative_path: "1.jpg", filename: "1.jpg", date_modified: null, date_created: null }
    ];

    render(
      <PhotoList 
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={metadata}
        visibleColumns={["ExifIFD:DateTimeOriginal", "IFD0:Model"]}
        selectedIndex={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={vi.fn()}
      />
    );
  });
});
