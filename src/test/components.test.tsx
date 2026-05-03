import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { LoadingScreen } from "../components/LoadingScreen";
import { MenuBar } from "../components/MenuBar";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, MetadataStore } from "../types";
import type { PhotoInfo } from "../types";
import { makePhoto, makePhotos } from "./factories";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStores(photos: PhotoInfo[], thumbOverrides: Record<string, string> = {}) {
  const thumbs = new ThumbnailStore();
  thumbs.reset(photos.map((p) => p.relative_path));
  for (const [k, v] of Object.entries(thumbOverrides)) thumbs.set(k, v);
  const meta = new MetadataStore();
  photos.forEach((p) => meta.add(p.relative_path));
  return { thumbs, meta };
}

const noop = () => {};

// ── WelcomeScreen ─────────────────────────────────────────────────────────────

describe("WelcomeScreen", () => {
  it("renders the title and open button", () => {
    render(<WelcomeScreen onOpenFolder={noop} />);
    expect(screen.getByText("Media Library")).toBeInTheDocument();
    expect(screen.getByTestId("open-folder-btn")).toBeInTheDocument();
  });

  it("calls onOpenFolder when the button is clicked", async () => {
    const handler = vi.fn();
    render(<WelcomeScreen onOpenFolder={handler} />);
    await userEvent.click(screen.getByTestId("open-folder-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── LoadingScreen ─────────────────────────────────────────────────────────────

describe("LoadingScreen", () => {
  it("shows the folder path", () => {
    render(<LoadingScreen folder="/photos/vacation" foundSoFar={0} />);
    expect(screen.getByTestId("loading-folder")).toHaveTextContent("/photos/vacation");
  });

  it("shows searching message when foundSoFar is 0", () => {
    render(<LoadingScreen folder="/photos" foundSoFar={0} />);
    expect(screen.getByTestId("loading-progress")).toHaveTextContent("Searching for photos");
  });
});

// ── MenuBar ───────────────────────────────────────────────────────────────────

describe("MenuBar", () => {
  const base = { photoCount: 3, scanning: false, onOpenFolder: noop, onCloseFolder: noop };

  it("shows the photo count", () => {
    render(<MenuBar {...base} />);
    expect(screen.getByTestId("menu-bar-count")).toHaveTextContent("3 photos");
  });

  it("uses singular when count is 1", () => {
    render(<MenuBar {...base} photoCount={1} />);
    expect(screen.getByTestId("menu-bar-count")).toHaveTextContent("1 photo");
  });

  it("shows spinner while scanning", () => {
    render(<MenuBar {...base} scanning={true} />);
    expect(screen.getByTestId("menu-bar-spinner")).toBeInTheDocument();
  });

  it("hides spinner when not scanning", () => {
    render(<MenuBar {...base} scanning={false} />);
    expect(screen.queryByTestId("menu-bar-spinner")).not.toBeInTheDocument();
  });

  it("calls onCloseFolder when close is clicked", async () => {
    const handler = vi.fn();
    render(<MenuBar {...base} onCloseFolder={handler} />);
    await userEvent.click(screen.getByTestId("menu-bar-close-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("calls onOpenFolder when open is clicked", async () => {
    const handler = vi.fn();
    render(<MenuBar {...base} onOpenFolder={handler} />);
    await userEvent.click(screen.getByTestId("menu-bar-open-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── PhotoList ─────────────────────────────────────────────────────────────────

describe("PhotoList", () => {
  it("shows empty message when no photos and not scanning", () => {
    const { thumbs, meta } = makeStores([]);
    render(<PhotoList photos={[]} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-list-empty")).toBeInTheDocument();
  });

  it("shows scanning row while scanning", () => {
    const photos = makePhotos(["a.jpg"]);
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={true} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("scanning-row")).toBeInTheDocument();
  });

  it("hides scanning row when not scanning", () => {
    const photos = makePhotos(["a.jpg"]);
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.queryByTestId("scanning-row")).not.toBeInTheDocument();
  });

  it("renders a row for each photo", () => {
    const photos = makePhotos(["a.jpg", "b.png", "c.gif"]);
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
  });

  it("displays the relative path", () => {
    const photos = [makePhoto({ relative_path: "vacation/beach.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-path")).toHaveTextContent("vacation/beach.jpg");
  });

  it("displays the filename", () => {
    const photos = [makePhoto({ relative_path: "vacation/beach.jpg", filename: "beach.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-filename")).toHaveTextContent("beach.jpg");
  });

  it("displays date modified when present", () => {
    const photos = [makePhoto({ relative_path: "a.jpg", date_modified: 1705276800 })];
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-date-modified")).not.toHaveTextContent("—");
  });

  it("displays — for missing date modified", () => {
    const photos = [makePhoto({ relative_path: "a.jpg", date_modified: null })];
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-date-modified")).toHaveTextContent("—");
  });

  it("displays EXIF date taken from metadata store", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    meta.set("a.jpg", { date_taken: "2023:06:15 14:30:00", camera_model: null });
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-date-taken")).toHaveTextContent("2023:06:15 14:30:00");
  });

  it("displays — for missing date taken", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-date-taken")).toHaveTextContent("—");
  });

  it("displays camera model from metadata store", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    meta.set("a.jpg", { date_taken: null, camera_model: "Canon EOS R5" });
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-camera")).toHaveTextContent("Canon EOS R5");
  });

  it("renders spinner when thumbnail is loading", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(document.querySelector(".photo-thumb-spinner")).toBeInTheDocument();
  });

  it("renders thumbnail img when data is present", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos, { "a.jpg": "abc123" });
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    const img = document.querySelector(".photo-thumb-img") as HTMLImageElement;
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,abc123");
  });

  it("renders placeholder when thumbnail failed", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos, { "a.jpg": "failed" });
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(document.querySelector(".photo-thumb-placeholder")).toBeInTheDocument();
  });

  it("sets data-path on each row", () => {
    const photos = makePhotos(["vacation/beach.jpg", "portrait.png"]);
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    const rows = screen.getAllByTestId("photo-row");
    expect(rows[0]).toHaveAttribute("data-path", "vacation/beach.jpg");
    expect(rows[1]).toHaveAttribute("data-path", "portrait.png");
  });

  it("calls onVisibilityChange when IntersectionObserver fires", () => {
    const observed: Element[] = [];
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) { callbacks.push(cb); }
      observe(el: Element) { observed.push(el); }
      disconnect() {}
    });

    const handler = vi.fn();
    const photos = makePhotos(["a.jpg", "b.jpg"]);
    const { thumbs, meta } = makeStores(photos);
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={handler} onPhotoOpen={noop} />);

    callbacks[0](
      observed.map((el) => ({ target: el, isIntersecting: true })) as IntersectionObserverEntry[],
      {} as IntersectionObserver
    );
    expect(handler).toHaveBeenCalledWith(expect.arrayContaining(["a.jpg", "b.jpg"]));
    vi.unstubAllGlobals();
  });

  it("row updates when thumbnail store is mutated", async () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    const { rerender } = render(
      <PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />
    );
    expect(document.querySelector(".photo-thumb-spinner")).toBeInTheDocument();
    act(() => { thumbs.set("a.jpg", "newdata"); });
    rerender(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(document.querySelector(".photo-thumb-img")).toHaveAttribute("src", "data:image/jpeg;base64,newdata");
  });

  it("row updates when metadata store is mutated", async () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    const { rerender } = render(
      <PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />
    );
    expect(screen.getByTestId("photo-camera")).toHaveTextContent("—");
    act(() => { meta.set("a.jpg", { date_taken: null, camera_model: "Sony A7" }); });
    rerender(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta} scanning={false} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-camera")).toHaveTextContent("Sony A7");
  });
});
