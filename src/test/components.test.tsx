import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { LoadingScreen } from "../components/LoadingScreen";
import { MenuBar } from "../components/MenuBar";
import { PhotoList } from "../components/PhotoList";
import { StatusFooter } from "../components/StatusFooter";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo } from "../types";
import { makePhoto, makePhotos } from "./factories";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStores(photos: PhotoInfo[], thumbOverrides: Record<string, string> = {}) {
  const thumbs = new ThumbnailStore();
  thumbs.reset(photos.map((p) => p.relative_path));
  for (const [k, v] of Object.entries(thumbOverrides)) thumbs.set(k, v);
  const imageMetadata = new ImageMetadataStore();
  photos.forEach((p) => imageMetadata.add(p.relative_path));
  return { thumbs, imageMetadata };
}

function renderList(photos: PhotoInfo[], opts: { thumbOverrides?: Record<string, string>, selectedIndex?: number | null, onSelect?: (i: number | null) => void, onPhotoOpen?: (i: number) => void, onShowInExplorer?: (i: number) => void } = {}) {
  const { thumbs, imageMetadata } = makeStores(photos, opts.thumbOverrides ?? {});
  render(
    <PhotoList 
      photos={photos} 
      thumbnails={thumbs} 
      imageMetadata={imageMetadata}
      selectedIndex={opts.selectedIndex ?? null}
      onSelect={opts.onSelect ?? (() => {})}
      onShowInExplorer={opts.onShowInExplorer ?? (() => {})}
      onVisibilityChange={() => {}} 
      onPhotoOpen={opts.onPhotoOpen ?? (() => {})} 
    />
  );
  return { thumbs, imageMetadata };
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
  const base = { photoCount: 3, scanning: false, imageMetadataLoading: false, onOpenFolder: noop, onCloseFolder: noop };

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
    render(<MenuBar {...base} imageMetadataLoading={true} />);
    expect(screen.getByTestId("menu-bar-metadata-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("menu-bar-metadata-label")).toHaveTextContent("Loading metadata");
  });

  it("scanning spinner takes priority over metadata label", () => {
    // While still scanning, show only the scanning spinner, not the metadata label.
    render(<MenuBar {...base} scanning={true} imageMetadataLoading={true} />);
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
    const { thumbs, imageMetadata } = makeStores([]);
    render(<PhotoList photos={[]} thumbnails={thumbs} imageMetadata={imageMetadata}
      selectedIndex={null} onSelect={noop} onShowInExplorer={noop} onVisibilityChange={noop} onPhotoOpen={noop} />);
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

  // ── Selection ────────────────────────────────────────────────────────────

  it("calls onSelect with the correct index when a row is clicked", async () => {
    const onSelect = vi.fn();
    const photos = makePhotos(["a.jpg", "b.jpg"]);
    renderList(photos, { onSelect });
    
    const rows = screen.getAllByTestId("photo-row");
    await userEvent.click(rows[1]);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("calls onPhotoOpen with the correct index when a row is double-clicked", async () => {
    const onPhotoOpen = vi.fn();
    const photos = makePhotos(["a.jpg", "b.jpg"]);
    renderList(photos, { onPhotoOpen });
    
    const rows = screen.getAllByTestId("photo-row");
    await userEvent.dblClick(rows[1]);
    expect(onPhotoOpen).toHaveBeenCalledWith(1);
  });

  it("applies selected class to the correct row", () => {
    const photos = makePhotos(["a.jpg", "b.jpg"]);
    renderList(photos, { selectedIndex: 1 });
    
    const rows = screen.getAllByTestId("photo-row");
    expect(rows[0]).not.toHaveClass("photo-row--selected");
    expect(rows[1]).toHaveClass("photo-row--selected");
  });

  // ── Context Menu ───────────────────────────────────────────────────────────

  it("opens context menu on right click", async () => {
    const photos = makePhotos(["a.jpg"]);
    renderList(photos);
    
    const row = screen.getByTestId("photo-row");
    fireEvent.contextMenu(row);
    
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    expect(screen.getByText("View")).toBeInTheDocument();
    expect(screen.getByText("Show in File Explorer")).toBeInTheDocument();
  });

  it("View option in context menu opens gallery", async () => {
    const onPhotoOpen = vi.fn();
    const photos = makePhotos(["a.jpg"]);
    renderList(photos, { onPhotoOpen });
    
    fireEvent.contextMenu(screen.getByTestId("photo-row"));
    await userEvent.click(screen.getByText("View"));
    
    expect(onPhotoOpen).toHaveBeenCalledWith(0);
    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });

  it("Show in File Explorer option in context menu triggers callback", async () => {
    const onShowInExplorer = vi.fn();
    const photos = makePhotos(["a.jpg"]);
    renderList(photos, { onShowInExplorer });
    
    fireEvent.contextMenu(screen.getByTestId("photo-row"));
    await userEvent.click(screen.getByText("Show in File Explorer"));
    
    expect(onShowInExplorer).toHaveBeenCalledWith(0);
    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });
});
