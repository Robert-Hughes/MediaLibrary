/**
 * Gallery view tests.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GalleryView } from "../components/GalleryView";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhotos } from "./factories";
import type { PhotoInfo } from "../types";

const PHOTOS: PhotoInfo[] = makePhotos(["a.jpg", "b.jpg", "c.jpg"]);

function makeStore(photos: PhotoInfo[]) {
  const s = new ThumbnailStore();
  s.reset(photos.map((p) => p.relative_path));
  return s;
}

const fakeLoad = async (_path: string) => "data:image/jpeg;base64,FAKE";

describe("GalleryView", () => {
  it("renders the current photo path in the caption", async () => {
    render(
      <GalleryView
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        imageMetadataOccurrences={new ImageMetadataOccurrencesStore()}
        loadImage={fakeLoad}
      />,
    );
    await screen.findByTestId("gallery-image");
    expect(screen.getByTestId("gallery-caption")).toHaveTextContent("b.jpg");
  });

  it("shows counter with correct position", async () => {
    render(
      <GalleryView
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        imageMetadataOccurrences={new ImageMetadataOccurrencesStore()}
        loadImage={fakeLoad}
      />,
    );
    await screen.findByTestId("gallery-image");
    const counter = document.querySelector(".gallery-counter");
    expect(counter).not.toBeNull();
    expect(counter!.textContent).toMatch(/2.*3/);
  });

  it("shows the loaded image when loadImage resolves", async () => {
    render(
      <GalleryView
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        imageMetadataOccurrences={new ImageMetadataOccurrencesStore()}
        loadImage={fakeLoad}
      />,
    );
    const img = await screen.findByTestId("gallery-image");
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,FAKE");
  });

  it("does not close when clicking the gallery content or dialog element", async () => {
    const onClose = vi.fn();
    render(
      <GalleryView
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={onClose}
        onNavigate={vi.fn()}
        imageMetadataOccurrences={new ImageMetadataOccurrencesStore()}
        loadImage={fakeLoad}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Photo gallery",
    });
    expect(dialog).toHaveClass("modal-dialog", "gallery-dialog");

    // Clicking gallery content does nothing
    fireEvent.click(screen.getByTestId("gallery-content"));
    expect(onClose).not.toHaveBeenCalled();

    // Clicking the dialog element itself does nothing
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <GalleryView
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={onClose}
        onNavigate={vi.fn()}
        imageMetadataOccurrences={new ImageMetadataOccurrencesStore()}
        loadImage={fakeLoad}
      />,
    );
    await screen.findByTestId("gallery-image");
    await userEvent.click(screen.getByTestId("gallery-close-btn"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <GalleryView
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={onClose}
        onNavigate={vi.fn()}
        imageMetadataOccurrences={new ImageMetadataOccurrencesStore()}
        loadImage={fakeLoad}
      />,
    );
    await screen.findByTestId("gallery-image");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("useMediaLibrary gallery state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("galleryIndex starts as null after first photo_found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(PHOTOS[0]);
    });
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") expect(state.galleryIndex).toBeNull();
  });

  it("openGallery sets the correct index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitPhotoFound(PHOTOS[0]);
    });

    act(() => {
      result.current[1].openGallery(0);
    });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(0);
  });

  it("navigateGallery(1) increments the index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      PHOTOS.forEach((p) => mock.emitPhotoFound(p));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => {
      result.current[1].openGallery(0);
    });
    act(() => {
      result.current[1].navigateGallery(1);
    });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });
});

describe("PhotoList interaction", () => {
  function renderList(
    photos: PhotoInfo[],
    onPhotoOpen: (i: number) => void,
    onSelect: (i: number | null) => void,
  ) {
    const thumbs = makeStore(photos);
    const imageMetadata = new ImageMetadataOccurrencesStore();
    photos.forEach((p) => imageMetadata.add(p.relative_path));
    render(
      <PhotoList
        photos={photos}
        thumbnails={thumbs}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={onSelect}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={onPhotoOpen}
        onSelectColumns={() => {}}
      />,
    );
  }

  it("calls onPhotoOpen with the correct index when a row is double-clicked", async () => {
    const onPhotoOpen = vi.fn();
    const photos = makePhotos(["a.jpg", "b.jpg", "c.jpg"]);
    renderList(photos, onPhotoOpen, () => {});
    const rows = screen.getAllByTestId("photo-row");
    await userEvent.dblClick(rows[1]);
    expect(onPhotoOpen).toHaveBeenCalledWith(1);
  });

  it("calls onSelect with the correct index when a row is clicked", async () => {
    const onSelect = vi.fn();
    const photos = makePhotos(["a.jpg", "b.jpg", "c.jpg"]);
    renderList(photos, () => {}, onSelect);
    const rows = screen.getAllByTestId("photo-row");
    await userEvent.click(rows[2]);
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
