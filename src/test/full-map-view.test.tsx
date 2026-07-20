import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FullMapView } from "../components/FullMapView";
import { ImageMetadataOccurrencesStore, ThumbnailStore } from "../types";
import { makePhotos, mockOccurrences } from "./factories";

vi.mock("../components/PhotoMap", () => ({
  PhotoMap: ({ items }: { items: Array<{ relativePath: string }> }) => (
    <div
      data-testid="photo-map"
      data-paths={items.map((item) => item.relativePath).join(",")}
    />
  ),
}));

describe("FullMapView", () => {
  it("maps effective GPS photos and reports selected photos without GPS", async () => {
    const photos = makePhotos(["located.jpg", "missing.jpg"]);
    const thumbnails = new ThumbnailStore();
    thumbnails.set("located.jpg", "THUMB");
    thumbnails.set("missing.jpg", "failed");
    const occurrences = new ImageMetadataOccurrencesStore();
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
        photos={photos}
        thumbnails={thumbnails}
        imageMetadataOccurrences={occurrences}
        targetDraftEdits={{}}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("full-map-overlay")).toHaveAttribute("open"),
    );
    expect(screen.getByTestId("full-map-summary")).toHaveTextContent(
      "1 of 2 photos mapped · 1 without GPS or still loading",
    );
    expect(screen.getByTestId("photo-map")).toHaveAttribute(
      "data-paths",
      "located.jpg",
    );
  });
});
