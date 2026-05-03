/**
 * Gallery view tests.
 *
 * Covers:
 * - Opening gallery by double-clicking a photo row
 * - Correct photo shown for the clicked index
 * - Left/right navigation (buttons and keyboard)
 * - Gallery index stays in sync with the photo list order
 * - Closing via button, Escape key, and overlay click
 * - Boundary conditions (first/last photo)
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { GalleryView } from "../components/GalleryView";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, MetadataStore } from "../types";
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

/** A loadImage stub that immediately resolves with a fake data URI. */
const fakeLoad = async (_path: string) => "data:image/jpeg;base64,FAKE";
/** A loadImage stub that always fails. */
const failLoad = async (_path: string): Promise<null> => null;

// ── GalleryView component ─────────────────────────────────────────────────────

describe("GalleryView", () => {
  it("renders the current photo path in the caption", () => {
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    expect(screen.getByTestId("gallery-caption")).toHaveTextContent("b.jpg");
  });

  it("shows counter with correct position", () => {
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    // Caption is always rendered regardless of image load state.
    const counter = document.querySelector(".gallery-counter");
    expect(counter).not.toBeNull();
    expect(counter!.textContent).toMatch(/2.*3/);
  });

  it("shows the loaded image when loadImage resolves", async () => {
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    const img = await screen.findByTestId("gallery-image");
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,FAKE");
  });

  it("shows error state when loadImage returns null", async () => {
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        loadImage={failLoad}
      />
    );
    expect(await screen.findByTestId("gallery-error")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={onClose}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    await userEvent.click(screen.getByTestId("gallery-close-btn"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when overlay background is clicked", async () => {
    const onClose = vi.fn();
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={onClose}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    await userEvent.click(screen.getByTestId("gallery-overlay"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={onClose}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onNavigate(-1) when left arrow button is clicked", async () => {
    const onNavigate = vi.fn();
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={onNavigate}
        loadImage={fakeLoad}
      />
    );
    await userEvent.click(screen.getByTestId("gallery-prev-btn"));
    expect(onNavigate).toHaveBeenCalledWith(-1);
  });

  it("calls onNavigate(1) when right arrow button is clicked", async () => {
    const onNavigate = vi.fn();
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={onNavigate}
        loadImage={fakeLoad}
      />
    );
    await userEvent.click(screen.getByTestId("gallery-next-btn"));
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("calls onNavigate(-1) when ArrowLeft key is pressed", () => {
    const onNavigate = vi.fn();
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={onNavigate}
        loadImage={fakeLoad}
      />
    );
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onNavigate).toHaveBeenCalledWith(-1);
  });

  it("calls onNavigate(1) when ArrowRight key is pressed", () => {
    const onNavigate = vi.fn();
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={1}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={onNavigate}
        loadImage={fakeLoad}
      />
    );
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("prev button is disabled on the first photo", () => {
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={0}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    expect(screen.getByTestId("gallery-prev-btn")).toBeDisabled();
    expect(screen.getByTestId("gallery-next-btn")).not.toBeDisabled();
  });

  it("next button is disabled on the last photo", () => {
    render(
      <GalleryView
        photos={PHOTOS}
        currentIndex={2}
        folderPath="/photos"
        onClose={() => {}}
        onNavigate={() => {}}
        loadImage={fakeLoad}
      />
    );
    expect(screen.getByTestId("gallery-next-btn")).toBeDisabled();
    expect(screen.getByTestId("gallery-prev-btn")).not.toBeDisabled();
  });
});

describe("useMediaLibrary gallery state", () => {
  it("galleryIndex starts as null after first photo_found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") expect(state.galleryIndex).toBeNull();
  });

  it("openGallery sets the correct index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    act(() => { result.current[1].openGallery(2); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(2);
  });

  it("closeGallery resets galleryIndex to null", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    act(() => { result.current[1].openGallery(1); });
    act(() => { result.current[1].closeGallery(); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBeNull();
  });

  it("navigateGallery(1) increments the index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    act(() => { result.current[1].openGallery(0); });
    act(() => { result.current[1].navigateGallery(1); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  it("navigateGallery(-1) decrements the index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    act(() => { result.current[1].openGallery(2); });
    act(() => { result.current[1].navigateGallery(-1); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(1);
  });

  it("navigateGallery does not go below 0", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    act(() => { result.current[1].openGallery(0); });
    act(() => { result.current[1].navigateGallery(-1); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(0);
  });

  it("navigateGallery does not go past the last photo", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    act(() => { result.current[1].openGallery(2); });
    act(() => { result.current[1].navigateGallery(1); });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(2);
  });

  it("gallery index matches photo list order — index 1 shows b.jpg", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/photos");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => { await result.current[1].openFolder(); });
    act(() => { PHOTOS.forEach((p) => mock.emitPhotoFound(p)); });
    act(() => { result.current[1].openGallery(1); });
    const state = result.current[0];
    if (state.kind === "loaded" && state.galleryIndex !== null) {
      expect(state.photos[state.galleryIndex].relative_path).toBe("b.jpg");
    }
  });
});

// ── PhotoList double-click integration ────────────────────────────────────────

describe("PhotoList double-click opens gallery", () => {
  function renderList(photos: PhotoInfo[], onPhotoOpen: (i: number) => void) {
    const thumbs = makeStore(photos);
    const meta = new MetadataStore();
    photos.forEach((p) => meta.add(p.relative_path));
    render(
      <PhotoList
        photos={photos}
        thumbnails={thumbs}
        metadata={meta}
        onVisibilityChange={() => {}}
        onPhotoOpen={onPhotoOpen}
      />
    );
  }
  it("calls onPhotoOpen with the correct index when a row is double-clicked", async () => {
    const onPhotoOpen = vi.fn();
    const photos = makePhotos(["a.jpg", "b.jpg", "c.jpg"]);
    renderList(photos, onPhotoOpen);
    const rows = screen.getAllByTestId("photo-row");
    await userEvent.dblClick(rows[1]);
    expect(onPhotoOpen).toHaveBeenCalledWith(1);
  });

  it("double-clicking the first row opens index 0", async () => {
    const onPhotoOpen = vi.fn();
    renderList(makePhotos(["a.jpg", "b.jpg"]), onPhotoOpen);
    await userEvent.dblClick(screen.getAllByTestId("photo-row")[0]);
    expect(onPhotoOpen).toHaveBeenCalledWith(0);
  });

  it("double-clicking the last row opens the last index", async () => {
    const onPhotoOpen = vi.fn();
    renderList(makePhotos(["a.jpg", "b.jpg", "c.jpg"]), onPhotoOpen);
    const rows = screen.getAllByTestId("photo-row");
    await userEvent.dblClick(rows[rows.length - 1]);
    expect(onPhotoOpen).toHaveBeenCalledWith(2);
  });
});
