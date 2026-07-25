import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryView } from "../components/GalleryView";
import { ImageMetadataOccurrencesStore } from "../types";
import type { MetadataOccurrence, TagInfo } from "../types";
import { makeFiles } from "./factories";
import { _setTagInfoCacheEntry } from "../hooks/useTagInfo";

const files = makeFiles(["a.jpg", "b.jpg"]);
const tagInfo: TagInfo = {
  id: { table: "Exif::Main", tag_id: "282" },
  group: "IFD0",
  name: "XResolution",
  writable: true,
  kind: { kind: "Integer", data: { min: null, max: null } },
  description: null,
  storage_count: undefined,
};

function occurrence(
  path: string,
  value: number,
  group1: string,
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path,
      runtime_tag_id: "282",
      tag_id_scope: { table: "Exif::Main", tag_id: "282", index: null },
      copy: 0,
    },
    schema_id: structuredClone(tagInfo.id),
    value: { kind: "Integer", value },
    tag_info: { ...tagInfo, group: group1 },
    observed_selector: {
      group1,
      group7: "ID-282",
      tag_name: "XResolution",
    },
    write_target: { group1, group7: "ID-282", tag_name: "XResolution" },
  };
}

function props(imageMetadataOccurrences: ImageMetadataOccurrencesStore) {
  return {
    files,
    folderPath: "/files",
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    loadImage: async () => "data:image/jpeg;base64,FAKE",
    imageMetadataOccurrences,
    onRemoveMetadataTargets: vi.fn(),
    onDiscardTargetDraftBatch: vi.fn(),
  };
}

describe("Gallery occurrence-store subscription", () => {
  beforeEach(() => {
    localStorage.setItem("media_library_gallery_details_visible", "1");
    _setTagInfoCacheEntry(tagInfo.id, tagInfo);
  });

  it("rerenders from the current path and follows navigation subscriptions", async () => {
    const occurrences = new ImageMetadataOccurrencesStore();
    for (const file of files) occurrences.add(file.relative_path);

    const subscribe = vi.spyOn(occurrences, "subscribe");
    const base = props(occurrences);
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

  it("reacts when loading changes to an empty authoritative set", async () => {
    const occurrences = new ImageMetadataOccurrencesStore();
    occurrences.add("a.jpg");
    render(
      <GalleryView
        {...props(occurrences)}
        files={[files[0]]}
        currentIndex={0}
      />,
    );
    await screen.findByTestId("gallery-image");
    expect(screen.getByText("Loading metadata…")).toBeInTheDocument();
    act(() => occurrences.set("a.jpg", []));
    expect(screen.getByText("No image metadata available")).toBeInTheDocument();
  });

  it("reacts when one schema gains a second authoritative occurrence", async () => {
    const occurrences = new ImageMetadataOccurrencesStore();
    occurrences.set("a.jpg", [occurrence("JPEG-APP1-IFD0", 301, "IFD0")]);

    render(
      <GalleryView
        {...props(occurrences)}
        files={[files[0]]}
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

    expect(
      await screen.findByTestId("details-section-IFD1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Additional Metadata Occurrences"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("2 occurrences")).not.toBeInTheDocument();

    const occurrenceRows = screen
      .getAllByTestId("details-row")
      .filter((row) => row.dataset.rowKind === "ExistingOccurrenceRow");
    expect(occurrenceRows).toHaveLength(2);
    expect(
      within(screen.getByTestId("details-section-IFD0")).getByText("301"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("details-section-IFD1")).getByText("301"),
    ).toBeInTheDocument();

    for (const row of occurrenceRows) {
      fireEvent.contextMenu(row);
      expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
    }
  });
});
