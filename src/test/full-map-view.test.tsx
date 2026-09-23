import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FullMapView } from "../components/FullMapView";
import { FileMetadataOccurrencesStore, ThumbnailStore } from "../types";
import { makeFiles, mockOccurrences } from "./factories";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("../components/FileMap", () => ({
  FileMap: ({
    items,
    thumbnailSize,
  }: {
    items: Array<{ relativePath: string }>;
    thumbnailSize: number;
  }) => (
    <div
      data-testid="file-map"
      data-paths={items.map((item) => item.relativePath).join(",")}
      data-thumbnail-size={thumbnailSize}
    />
  ),
}));

describe("FullMapView", () => {
  it("maps effective GPS files and reports selected files without GPS", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "load_settings_cmd"
        ? Promise.resolve({ map_thumbnail_size: 80 })
        : Promise.resolve(),
    );
    const files = makeFiles(["located.jpg", "missing.jpg"]);
    const thumbnails = new ThumbnailStore();
    thumbnails.add("located.jpg");
    thumbnails.add("missing.jpg");
    thumbnails.set("located.jpg", "THUMB");
    thumbnails.set("missing.jpg", "failed");
    const occurrences = new FileMetadataOccurrencesStore();
    occurrences.add("located.jpg");
    occurrences.add("missing.jpg");
    occurrences.set(
      "located.jpg",
      mockOccurrences({
        "GPS:GPSLatitude": 51.5,
        "GPS:GPSLatitudeRef": "N",
        "GPS:GPSLongitude": 0.12,
        "GPS:GPSLongitudeRef": "W",
      }),
    );
    occurrences.set("missing.jpg", []);

    render(
      <FullMapView
        relativePaths={["located.jpg", "missing.jpg"]}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={occurrences}
        targetDraftEdits={{}}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("full-map-overlay")).toHaveAttribute("open"),
    );
    expect(screen.getByTestId("full-map-summary")).toHaveTextContent(
      "1 of 2 files mapped · 1 without GPS or still loading",
    );
    expect(screen.getByTestId("file-map")).toHaveAttribute(
      "data-paths",
      "located.jpg",
    );
    const slider = screen.getByRole("slider", { name: "Thumbnail size" });
    await waitFor(() => expect(slider).toHaveValue("80"));
    expect(slider).toHaveAttribute("min", "16");
    expect(slider).toHaveAttribute("max", "512");
    fireEvent.change(slider, { target: { value: "512" } });
    expect(screen.getByTestId("file-map")).toHaveAttribute(
      "data-thumbnail-size",
      "512",
    );
    expect(screen.getByText("512 px")).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: "16" } });
    expect(screen.getByTestId("file-map")).toHaveAttribute(
      "data-thumbnail-size",
      "16",
    );
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("save_map_thumbnail_size_cmd", {
        thumbnailSize: 16,
      }),
    );
  });
});
