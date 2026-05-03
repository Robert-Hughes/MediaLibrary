import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { LoadingScreen } from "../components/LoadingScreen";
import { MenuBar } from "../components/MenuBar";
import { PhotoList } from "../components/PhotoList";
import { StatusFooter } from "../components/StatusFooter";
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

function renderList(photos: PhotoInfo[], opts: { thumbOverrides?: Record<string, string> } = {}) {
  const { thumbs, meta } = makeStores(photos, opts.thumbOverrides ?? {});
  render(
    <PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={() => {}} onPhotoOpen={() => {}} />
  );
  return { thumbs, meta };
}

const noop = () => {};

// ── WelcomeScreen ─────────────────────────────────────────────────────────────

describe("WelcomeScreen", () => {
  it("renders the title and open button", () => {
    render(<WelcomeScreen onOpenFolder={noop} recentFolders={[]} onOpenRecent={noop} />);
    expect(screen.getByText("Media Library")).toBeInTheDocument();
    expect(screen.getByTestId("open-folder-btn")).toBeInTheDocument();
  });

  it("calls onOpenFolder when the button is clicked", async () => {
    const handler = vi.fn();
    render(<WelcomeScreen onOpenFolder={handler} recentFolders={[]} onOpenRecent={noop} />);
    await userEvent.click(screen.getByTestId("open-folder-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("shows recent folders when provided", () => {
    const recent = ["/photos/2023", "/photos/2024"];
    render(<WelcomeScreen onOpenFolder={noop} recentFolders={recent} onOpenRecent={noop} />);
    expect(screen.getByTestId("recent-folders")).toBeInTheDocument();
    expect(screen.getAllByTestId("recent-folder-item")).toHaveLength(2);
    expect(screen.getByText("/photos/2023")).toBeInTheDocument();
  });

  it("calls onOpenRecent when a recent item is clicked", async () => {
    const handler = vi.fn();
    render(<WelcomeScreen onOpenFolder={noop} recentFolders={["/photos/old"]} onOpenRecent={handler} />);
    await userEvent.click(screen.getByTestId("recent-folder-item"));
    expect(handler).toHaveBeenCalledWith("/photos/old");
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
  const base = { photoCount: 3, scanning: false, metadataLoading: false, onOpenFolder: noop, onCloseFolder: noop };

  it("shows the photo count", () => {
    render(<MenuBar {...base} />);
    expect(screen.getByTestId("menu-bar-count")).toHaveTextContent("3 photos");
  });

  it("uses singular when count is 1", () => {
    render(<MenuBar {...base} photoCount={1} />);
    expect(screen.getByTestId("menu-bar-count")).toHaveTextContent("1 photo");
  });

  it("shows scanning spinner while scanning", () => {
    render(<MenuBar {...base} scanning={true} />);
    expect(screen.getByTestId("menu-bar-spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("menu-bar-metadata-label")).not.toBeInTheDocument();
  });

  it("hides spinner when not scanning and not loading metadata", () => {
    render(<MenuBar {...base} />);
    expect(screen.queryByTestId("menu-bar-spinner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("menu-bar-metadata-label")).not.toBeInTheDocument();
  });

  it("shows metadata spinner and label when metadata is loading", () => {
    render(<MenuBar {...base} metadataLoading={true} />);
    expect(screen.getByTestId("menu-bar-metadata-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("menu-bar-metadata-label")).toHaveTextContent("Loading metadata");
  });

  it("scanning spinner takes priority over metadata label", () => {
    // While still scanning, show only the scanning spinner, not the metadata label.
    render(<MenuBar {...base} scanning={true} metadataLoading={true} />);
    expect(screen.getByTestId("menu-bar-spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("menu-bar-metadata-label")).not.toBeInTheDocument();
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

// ── StatusFooter ──────────────────────────────────────────────────────────────

describe("StatusFooter", () => {
  it("renders the message", () => {
    render(<StatusFooter message="Discovering files…" />);
    expect(screen.getByTestId("status-footer")).toHaveTextContent("Discovering files…");
  });

  it("renders a spinner element", () => {
    render(<StatusFooter message="Working…" />);
    expect(document.querySelector(".status-footer-spinner")).toBeInTheDocument();
  });
});

// ── PhotoList ─────────────────────────────────────────────────────────────────

describe("PhotoList", () => {
  it("shows empty message when no photos", () => {
    const { thumbs, meta } = makeStores([]);
    render(<PhotoList photos={[]} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-list-empty")).toBeInTheDocument();
  });

  it("renders a row for each photo", () => {
    renderList(makePhotos(["a.jpg", "b.png", "c.gif"]));
    expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
  });

  it("displays the relative path", () => {
    renderList([makePhoto({ relative_path: "vacation/beach.jpg" })]);
    expect(screen.getByTestId("photo-path")).toHaveTextContent("vacation/beach.jpg");
  });

  it("displays date modified when present", () => {
    renderList([makePhoto({ relative_path: "a.jpg", date_modified: 1705276800 })]);
    expect(screen.getByTestId("photo-date-modified")).not.toHaveTextContent("—");
  });

  it("displays — for missing date modified", () => {
    renderList([makePhoto({ relative_path: "a.jpg", date_modified: null })]);
    expect(screen.getByTestId("photo-date-modified")).toHaveTextContent("—");
  });

  // ── EXIF metadata cells ───────────────────────────────────────────────────

  it("shows spinner in EXIF cells while metadata is loading", () => {
    // MetadataStore.add() initialises as "loading" — no metadata_ready yet.
    renderList([makePhoto({ relative_path: "a.jpg" })]);
    expect(screen.getByTestId("exif-loading")).toBeInTheDocument();
  });

  it("shows date taken after metadata arrives", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    act(() => { meta.set("a.jpg", { date_taken: "2023:06:15 14:30:00", camera_model: null }); });
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-date-taken")).toHaveTextContent("2023:06:15 14:30:00");
    expect(screen.queryByTestId("exif-loading")).not.toBeInTheDocument();
  });

  it("shows — for null date taken after metadata arrives", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    act(() => { meta.set("a.jpg", { date_taken: null, camera_model: null }); });
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-date-taken")).toHaveTextContent("—");
  });

  it("shows camera model after metadata arrives", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    act(() => { meta.set("a.jpg", { date_taken: null, camera_model: "Canon EOS R5" }); });
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-camera")).toHaveTextContent("Canon EOS R5");
  });

  it("spinner replaced by value when metadata store is updated", async () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, meta } = makeStores(photos);
    const { rerender } = render(
      <PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
        onVisibilityChange={noop} onPhotoOpen={noop} />
    );
    expect(screen.getByTestId("exif-loading")).toBeInTheDocument();

    act(() => { meta.set("a.jpg", { date_taken: "2024:01:01 12:00:00", camera_model: "Sony A7" }); });
    rerender(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={noop} onPhotoOpen={noop} />);

    expect(screen.queryByTestId("exif-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("photo-date-taken")).toHaveTextContent("2024:01:01 12:00:00");
    expect(screen.getByTestId("photo-camera")).toHaveTextContent("Sony A7");
  });

  // ── Thumbnails ────────────────────────────────────────────────────────────

  it("renders spinner when thumbnail is loading", () => {
    renderList([makePhoto({ relative_path: "a.jpg" })]);
    expect(document.querySelector(".photo-thumb-spinner")).toBeInTheDocument();
  });

  it("renders thumbnail img when data is present", () => {
    renderList([makePhoto({ relative_path: "a.jpg" })], { thumbOverrides: { "a.jpg": "abc123" } });
    expect(document.querySelector(".photo-thumb-img")).toHaveAttribute("src", "data:image/jpeg;base64,abc123");
  });

  it("renders placeholder when thumbnail failed", () => {
    renderList([makePhoto({ relative_path: "a.jpg" })], { thumbOverrides: { "a.jpg": "failed" } });
    expect(document.querySelector(".photo-thumb-placeholder")).toBeInTheDocument();
  });

  it("sets data-path on each row", () => {
    renderList(makePhotos(["vacation/beach.jpg", "portrait.png"]));
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
    render(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={handler} onPhotoOpen={noop} />);

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
      <PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
        onVisibilityChange={noop} onPhotoOpen={noop} />
    );
    expect(document.querySelector(".photo-thumb-spinner")).toBeInTheDocument();
    act(() => { thumbs.set("a.jpg", "newdata"); });
    rerender(<PhotoList photos={photos} thumbnails={thumbs} metadata={meta}
      onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(document.querySelector(".photo-thumb-img")).toHaveAttribute("src", "data:image/jpeg;base64,newdata");
  });
});
