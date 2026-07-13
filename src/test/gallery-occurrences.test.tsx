import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryView } from "../components/GalleryView";
import { ImageMetadataOccurrencesStore, ImageMetadataStore } from "../types";
import type { MetadataOccurrence, TagInfo } from "../types";
import { makePhotos } from "./factories";
import { metadataCollection } from "../utils/metadataCollection";

const photos = makePhotos(["a.jpg", "b.jpg"]);
const tagInfo: TagInfo = {
  id: { table: "Exif::Main", tag_id: "282" },
  group: "IFD0",
  name: "XResolution",
  writable: true,
  kind: { kind: "Integer", data: { min: null, max: null } },
  description: null,
};

function occurrence(
  path: string,
  value: number,
  group1: string,
): MetadataOccurrence {
  return {
    id: { document: null, path, tag_id: "282", copy: 0 },
    value: { kind: "Integer", value },
    tag_info: tagInfo,
    write_target: { group1, tag_name: "XResolution" },
  };
}

function props(
  imageMetadata: ImageMetadataStore,
  imageMetadataOccurrences: ImageMetadataOccurrencesStore,
) {
  return {
    photos,
    folderPath: "/photos",
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    loadImage: async () => "data:image/jpeg;base64,FAKE",
    imageMetadata,
    imageMetadataOccurrences,
    onSetMetadataDraftBatch: vi.fn(),
    onDiscardDraftBatch: vi.fn(),
  };
}

describe("Gallery occurrence-store subscription", () => {
  beforeEach(() => {
    localStorage.setItem("media_library_gallery_details_visible", "1");
  });

  it("rerenders from the current path and follows navigation subscriptions", async () => {
    const legacy = new ImageMetadataStore();
    const occurrences = new ImageMetadataOccurrencesStore();
    for (const photo of photos) {
      legacy.set(photo.relative_path, {});
      occurrences.add(photo.relative_path);
    }

    const subscribe = vi.spyOn(occurrences, "subscribe");
    const base = props(legacy, occurrences);
    const { rerender } = render(<GalleryView {...base} currentIndex={0} />);
    await screen.findByTestId("gallery-image");
    expect(subscribe).toHaveBeenCalledWith("a.jpg", expect.any(Function));

    act(() => {
      occurrences.set("a.jpg", [occurrence("JPEG-APP1-IFD0", 300, "IFD0")]);
    });
    expect(screen.getByText("300")).toBeInTheDocument();

    occurrences.set("b.jpg", [occurrence("JPEG-APP1-IFD1", 72, "IFD1")]);
    rerender(<GalleryView {...base} currentIndex={1} />);
    expect(subscribe).toHaveBeenCalledWith("b.jpg", expect.any(Function));
    expect(await screen.findByText("72")).toBeInTheDocument();
    expect(screen.queryByText("300")).not.toBeInTheDocument();

    act(() => {
      occurrences.set("a.jpg", [occurrence("JPEG-APP1-IFD0", 600, "IFD0")]);
    });
    expect(screen.queryByText("600")).not.toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
  });

  it("keeps the legacy metadata subscription reactive", async () => {
    const legacy = new ImageMetadataStore();
    legacy.add("a.jpg");
    const occurrences = new ImageMetadataOccurrencesStore();
    occurrences.set("a.jpg", []);
    render(
      <GalleryView
        {...props(legacy, occurrences)}
        photos={[photos[0]]}
        currentIndex={0}
      />,
    );
    await screen.findByTestId("gallery-image");
    expect(screen.getByText("Loading metadata…")).toBeInTheDocument();
    act(() => legacy.set("a.jpg", {}));
    expect(screen.getByText("No image metadata available")).toBeInTheDocument();
  });

  it("reacts when the current photo changes from unique to multiple", async () => {
    const legacy = new ImageMetadataStore();
    legacy.set(
      "a.jpg",
      metadataCollection([
        { id: tagInfo.id, value: { kind: "Integer", value: 300 } },
      ]),
    );
    const occurrences = new ImageMetadataOccurrencesStore();
    occurrences.set("a.jpg", [occurrence("JPEG-APP1-IFD0", 301, "IFD0")]);

    render(
      <GalleryView
        {...props(legacy, occurrences)}
        photos={[photos[0]]}
        currentIndex={0}
      />,
    );
    await screen.findByTestId("gallery-image");
    const uniqueRow = screen.getByText("XResolution").closest("tr")!;
    expect(uniqueRow).toHaveTextContent("301");
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
    fireEvent.contextMenu(uniqueRow);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    act(() => {
      occurrences.set("a.jpg", [
        occurrence("JPEG-APP1-IFD0", 301, "IFD0"),
        occurrence("JPEG-APP1-IFD1", 301, "IFD1"),
      ]);
    });

    const ambiguousRow = await screen.findByText("2 occurrences");
    expect(ambiguousRow.closest("tr")).toHaveAttribute(
      "data-occurrence-resolution",
      "multiple",
    );
    const supplemental = screen.getByTestId(
      "details-section-additional-occurrences",
    );
    expect(
      within(supplemental).getAllByTestId("details-occurrence-row"),
    ).toHaveLength(2);
    fireEvent.contextMenu(ambiguousRow.closest("tr")!);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
