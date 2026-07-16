import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { GalleryView } from "../components/GalleryView";

import { makePhotos } from "./factories";

const PHOTOS = makePhotos(["a.jpg", "b.jpg"]);
const fakeLoad = async (_path: string) => "data:image/jpeg;base64,FAKE";

function renderGallery(
  overrides: Partial<ComponentProps<typeof GalleryView>> = {},
) {
  const onRemoveMetadataFieldsV5 = vi.fn();
  const onDiscardTargetDraftBatch = vi.fn();

  const props = {
    photos: PHOTOS,
    currentIndex: 0,
    folderPath: "/photos",
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    loadImage: fakeLoad,
    ...overrides,
  };

  return render(
    <GalleryView
      {...props}
      onRemoveMetadataFieldsV5={
        overrides.onRemoveMetadataFieldsV5 ?? onRemoveMetadataFieldsV5
      }
      onDiscardTargetDraftBatch={
        overrides.onDiscardTargetDraftBatch ?? onDiscardTargetDraftBatch
      }
    />,
  );
}

describe("Gallery Zoom and Pan", () => {
  it("initializes with scale 1 and no pan", async () => {
    renderGallery();
    const image = await screen.findByTestId("gallery-image");
    expect(image).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });
  });

  it("zooms in on wheel scroll", async () => {
    renderGallery();
    const area = screen.getByTestId("gallery-image-area");
    const image = await screen.findByTestId("gallery-image");

    // Simulate wheel event to zoom in
    fireEvent.wheel(area, { deltaY: -100, clientX: 100, clientY: 100 });

    // Scale should be > 1
    const transform = image.style.transform;
    expect(transform).not.toBe("translate(0px, 0px) scale(1)");
    expect(transform).toMatch(/scale\(/);
  });

  it("middle click resets zoom and pan", async () => {
    renderGallery();
    const area = screen.getByTestId("gallery-image-area");
    const image = await screen.findByTestId("gallery-image");

    // Zoom in
    fireEvent.wheel(area, { deltaY: -500 });
    expect(image.style.transform).not.toBe("translate(0px, 0px) scale(1)");

    // Middle click (button 1)
    fireEvent.mouseDown(area, { button: 1 });

    expect(image).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });
  });

  it("allows panning when zoomed in", async () => {
    renderGallery();
    const area = screen.getByTestId("gallery-image-area");
    const image = await screen.findByTestId("gallery-image");

    // Mock getBoundingClientRect so clampPan works properly
    area.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 1000,
          height: 1000,
          left: 0,
          top: 0,
          right: 1000,
          bottom: 1000,
        }) as DOMRect,
    );

    // Zoom in
    fireEvent.wheel(area, { deltaY: -500, clientX: 500, clientY: 500 });

    // Drag
    fireEvent.mouseDown(area, { button: 0, clientX: 500, clientY: 500 });
    fireEvent.mouseMove(area, { clientX: 400, clientY: 400 });

    expect(image.style.transform).toMatch(/translate\(-100px, -100px\)/);

    fireEvent.mouseUp(area);
  });

  it("does not allow panning when scale is 1", async () => {
    renderGallery();
    const area = screen.getByTestId("gallery-image-area");
    const image = await screen.findByTestId("gallery-image");

    // Drag without zoom
    fireEvent.mouseDown(area, { button: 0, clientX: 500, clientY: 500 });
    fireEvent.mouseMove(area, { clientX: 400, clientY: 400 });

    expect(image).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });
  });

  it("resets zoom and pan when navigating to a different photo", async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const onRemoveMetadataFieldsV5 = vi.fn();
    const onDiscardTargetDraftBatch = vi.fn();

    const { rerender } = render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={onClose}
        onNavigate={onNavigate}
        loadImage={fakeLoad}
        onRemoveMetadataFieldsV5={onRemoveMetadataFieldsV5}
        onDiscardTargetDraftBatch={onDiscardTargetDraftBatch}
      />,
    );
    const area = screen.getByTestId("gallery-image-area");
    const image = await screen.findByTestId("gallery-image");

    // Zoom in
    fireEvent.wheel(area, { deltaY: -500 });
    expect(image.style.transform).not.toBe("translate(0px, 0px) scale(1)");

    // Navigate
    rerender(
      <GalleryView
        photos={PHOTOS}
        currentIndex={1} // Changed
        folderPath="/photos"
        onClose={onClose}
        onNavigate={onNavigate}
        loadImage={fakeLoad}
        onRemoveMetadataFieldsV5={onRemoveMetadataFieldsV5}
        onDiscardTargetDraftBatch={onDiscardTargetDraftBatch}
      />,
    );

    // Check reset
    const newImage = await screen.findByTestId("gallery-image");
    expect(newImage).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });
  });
});
