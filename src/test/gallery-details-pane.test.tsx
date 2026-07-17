/**
 * Integration tests for the gallery details pane feature.
 *
 * Tests simulate real UI interaction: clicking toggle buttons, pressing
 * keyboard shortcuts, and verifying that the DOM updates accordingly.
 */
import {
  render,
  screen,
  within,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { GalleryView } from "../components/GalleryView";

import { ImageMetadataOccurrencesStore } from "../types";
import { makePhotos, mockMetadata } from "./factories";
import type { PhotoInfo } from "../types";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
// ── Test helpers ─────────────────────────────────────────────────────────────

const PHOTOS: PhotoInfo[] = makePhotos([
  "2024/a.jpg",
  "2024/b.jpg",
  "2024/c.jpg",
]);
const fakeLoad = async (_path: string) => "data:image/jpeg;base64,FAKE";

/** Render the GalleryView with defaults suitable for integration testing. */
async function renderGallery(
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
    imageMetadataOccurrences: new ImageMetadataOccurrencesStore(),
    ...overrides,
  };

  const result = render(
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
  await screen.findByTestId("gallery-image");
  return result;
}

// ── Integration tests ────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  _clearTagInfoCache();
  const commonTags = [
    "IFD0:Make",
    "IFD0:Model",
    "ExifIFD:ISO",
    "XMP-dc:Subject",
    "IFD0:Orientation",
  ];
  for (const tag of commonTags) {
    const colon = tag.indexOf(":");
    _setTagInfoCacheEntry(tag, {
      group: tag.slice(0, colon),
      name: tag.slice(colon + 1),
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
  }
});

describe("Gallery details pane toggle", () => {
  it("details pane is hidden by default", async () => {
    await renderGallery();
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });

  it("shows details pane when toggle button is clicked", async () => {
    await renderGallery();

    const toggle = screen.getByTestId("gallery-info-toggle");
    expect(toggle).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();
  });

  it("hides details pane when toggle button is clicked again", async () => {
    await renderGallery();

    const toggle = screen.getByTestId("gallery-info-toggle");

    // Show
    await userEvent.click(toggle);
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Hide
    await userEvent.click(toggle);
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });

  it("toggles details pane with 'I' keyboard shortcut", async () => {
    await renderGallery();

    // Initially hidden
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();

    // Press I to show
    await userEvent.keyboard("i");
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Press I again to hide
    await userEvent.keyboard("i");
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });

  it("toggle button has correct aria-label reflecting current state", async () => {
    await renderGallery();

    const toggle = screen.getByTestId("gallery-info-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Show details");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Hide details");
  });

  it("gallery-content gets --with-details class when pane is visible", async () => {
    await renderGallery();

    const content = screen.getByTestId("gallery-content");
    expect(content.classList.contains("gallery-content--with-details")).toBe(
      false,
    );

    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    expect(content.classList.contains("gallery-content--with-details")).toBe(
      true,
    );
  });

  it("details pane visibility persists across gallery remounts", async () => {
    const { unmount } = await renderGallery();

    // Open the pane
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Simulate closing and re-opening the gallery
    unmount();
    await renderGallery();

    // Pane should still be visible on remount (state persisted via localStorage)
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();
  });

  it("details pane closed state also persists across remounts", async () => {
    // Pre-seed localStorage with hidden state
    localStorage.setItem("media_library_gallery_details_visible", "0");

    const { unmount } = await renderGallery();
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();

    // Open it, then close it
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();

    // Remount — should still be hidden
    unmount();
    await renderGallery();
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });
});

describe("Gallery details pane content", () => {
  it("displays OS metadata for the current photo", async () => {
    await renderGallery({ currentIndex: 0 });

    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    const osSection = screen.getByTestId("details-section-os");
    expect(within(osSection).getByText("Filename")).toBeInTheDocument();
    expect(within(osSection).getByText("a.jpg")).toBeInTheDocument();
    expect(within(osSection).getByText("Relative Path")).toBeInTheDocument();
    expect(within(osSection).getByText("2024/a.jpg")).toBeInTheDocument();
  });

  it("shows loading state when metadata has not been received", async () => {
    const store = new ImageMetadataOccurrencesStore();
    PHOTOS.forEach((p) => store.add(p.relative_path));
    // Don't set metadata — leave in "loading" state

    await renderGallery({ imageMetadataOccurrences: store });

    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    expect(screen.getByTestId("details-section-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading metadata…")).toBeInTheDocument();
  });

  it("shows grouped image metadata when available", async () => {
    const onClose = vi.fn();
    const occurrences = new ImageMetadataOccurrencesStore();
    occurrences.set("2024/a.jpg", [
      {
        id: {
          document: null,
          path: "JPEG-APP1-IFD0",
          runtime_tag_id: "Make",
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: "Make",
            index: null,
          },
          copy: 0,
        },
        schema_id: { table: "Test::Fixture", tag_id: "IFD0:Make" },
        value: { kind: "Text", value: "Canon" },
        tag_info: {
          id: { table: "Test::Fixture", tag_id: "IFD0:Make" },
          group: "IFD0",
          name: "Make",
          writable: true,
          kind: { kind: "Text" },
          description: null,
        },
        write_target: { group1: "IFD0", tag_name: "Make" },
      },
    ]);
    await renderGallery({
      imageMetadataOccurrences: occurrences,
      onSetExistingOccurrenceDraft: vi.fn(),
      onClose,
    });
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    fireEvent.contextMenu(screen.getByText("Canon"));
    await userEvent.click(await screen.findByRole("button", { name: /^Edit/ }));

    const gallery = screen.getByRole("dialog", { name: "Photo gallery" });
    const editor = screen.getByRole("dialog", { name: "Edit IFD0:Make" });
    editor.dispatchEvent(
      new Event("cancel", { bubbles: true, cancelable: true }),
    );
    await act(async () => {});

    expect(
      screen.queryByRole("dialog", { name: "Edit IFD0:Make" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("gallery-content")).toBeInTheDocument();
    expect(gallery).toHaveAttribute("open");
    expect(onClose).not.toHaveBeenCalled();

    gallery.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("I key toggles details while Escape still closes gallery", async () => {
    const onClose = vi.fn();
    await renderGallery({ onClose });

    // Toggle details
    await userEvent.keyboard("i");
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Escape should close the gallery
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("arrow keys still navigate photos when details pane is open", async () => {
    const onNavigate = vi.fn();
    await renderGallery({ onNavigate });

    // Open details
    await userEvent.keyboard("i");
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Arrow keys should still call onNavigate
    await userEvent.keyboard("{ArrowRight}");
    expect(onNavigate).toHaveBeenCalledWith(1);

    await userEvent.keyboard("{ArrowLeft}");
    expect(onNavigate).toHaveBeenCalledWith(-1);
  });
});

describe("Gallery details pane with reactive metadata", () => {
  it("updates displayed metadata when metadata store receives new data", async () => {
    const store = new ImageMetadataOccurrencesStore();
    PHOTOS.forEach((p) => store.add(p.relative_path));

    await renderGallery({ imageMetadataOccurrences: store, currentIndex: 0 });

    // Open details
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    // Initially loading
    expect(screen.getByTestId("details-section-loading")).toBeInTheDocument();

    // Simulate metadata arriving via store update
    act(() => {
      store.set(
        "2024/a.jpg",
        occurrencesFromMetadataCollection(
          mockMetadata({
            "IFD0:Make": "Sony",
            "IFD0:Model": "A7R IV",
          }),
        ),
      );
    });

    // Wait for reactive update
    await waitFor(() => {
      expect(
        screen.queryByTestId("details-section-loading"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Sony")).toBeInTheDocument();
      expect(screen.getByText("A7R IV")).toBeInTheDocument();
    });
  });
});
