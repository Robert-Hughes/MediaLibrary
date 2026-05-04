import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { LoadingScreen } from "../components/LoadingScreen";
import { MenuBar } from "../components/MenuBar";
import { PhotoList } from "../components/PhotoList";
import { StatusFooter } from "../components/StatusFooter";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";
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

function renderList(photos: PhotoInfo[], opts: { thumbOverrides?: Record<string, string>, selectedIndex?: number | null, onSelect?: (i: number | null) => void, onPhotoOpen?: (i: number) => void, onShowInExplorer?: (i: number) => void, visibleColumns?: string[], visibleOSColumns?: string[], onSelectColumns?: () => void } = {}) {
  const { thumbs, imageMetadata } = makeStores(photos, opts.thumbOverrides ?? {});
  render(
    <PhotoList 
      photos={photos} 
      thumbnails={thumbs} 
      imageMetadata={imageMetadata}
      visibleColumns={opts.visibleColumns ?? ["IFD0:Model"]}
      visibleOSColumns={opts.visibleOSColumns ?? ["date_modified", "date_created"]}
      selectedIndex={opts.selectedIndex ?? null}
      onSelect={opts.onSelect ?? (() => {})}
      onShowInExplorer={opts.onShowInExplorer ?? (() => {})}
      onVisibilityChange={() => {}} 
      onPhotoOpen={opts.onPhotoOpen ?? (() => {})} 
      onSelectColumns={opts.onSelectColumns ?? (() => {})}
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
  const base = { photoCount: 3, scanning: false, metadataProgress: null, onOpenFolder: noop, onCloseFolder: noop, onSelectColumns: noop };

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

  it("shows metadata spinner and label when metadata is loading", async () => {
    const { MetadataProgressStore } = await import("../types");
    const progress = new MetadataProgressStore();
    progress.setTotal(10);
    progress.incrementReceived(5);
    
    render(<MenuBar {...base} metadataProgress={progress} />);
    expect(screen.getByTestId("menu-bar-metadata-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("menu-bar-metadata-label")).toHaveTextContent("Loading metadata");
  });

  it("calls onSelectColumns when columns button is clicked", async () => {
    const handler = vi.fn();
    render(<MenuBar {...base} onSelectColumns={handler} />);
    await userEvent.click(screen.getByTestId("menu-bar-columns-btn"));
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
      visibleColumns={[]} visibleOSColumns={["date_modified", "date_created"]} selectedIndex={null} onSelect={noop} onShowInExplorer={noop} onVisibilityChange={noop} onPhotoOpen={noop} onSelectColumns={noop} />);
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

  // ── Image metadata cells ───────────────────────────────────────────────────

  it("shows spinner in Image Metadata cells while metadata is loading", () => {
    renderList([makePhoto({ relative_path: "a.jpg" })]);
    expect(screen.getByTestId("metadata-loading")).toBeInTheDocument();
  });

  it("shows metadata value after it arrives", () => {
    const photos = [makePhoto({ relative_path: "a.jpg" })];
    const { thumbs, imageMetadata } = makeStores(photos);
    act(() => { imageMetadata.set("a.jpg", { "IFD0:Model": "Canon EOS R5" }); });
    render(<PhotoList photos={photos} thumbnails={thumbs} imageMetadata={imageMetadata}
      visibleColumns={["IFD0:Model"]} visibleOSColumns={["date_modified", "date_created"]} selectedIndex={null} onSelect={noop} onShowInExplorer={noop} onVisibilityChange={noop} onPhotoOpen={noop} onSelectColumns={noop} />);
    expect(screen.getByText("Canon EOS R5")).toBeInTheDocument();
    expect(screen.queryByTestId("metadata-loading")).not.toBeInTheDocument();
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
});

// ── ColumnSelectionDialog ─────────────────────────────────────────────────────

describe("ColumnSelectionDialog", () => {
  const allKeys = [
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
  ];

  it("renders all keys with counts", () => {
    render(<ColumnSelectionDialog allKeys={allKeys} visibleColumns={[]} visibleOSColumns={["date_modified", "date_created"]} onSave={noop} onClose={noop} />);
    expect(screen.getByText("IFD0:Model")).toBeInTheDocument();
    expect(screen.getByText("(10 files)")).toBeInTheDocument();
    expect(screen.getByText("IFD0:Make")).toBeInTheDocument();
    expect(screen.getByText("(8 files)")).toBeInTheDocument();
  });

  it("checks currently visible columns", () => {
    render(<ColumnSelectionDialog allKeys={allKeys} visibleColumns={["IFD0:Model"]} visibleOSColumns={["date_modified", "date_created"]} onSave={noop} onClose={noop} />);
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.find(c => c.nextSibling?.textContent === "IFD0:Model")?.checked).toBe(true);
    expect(checkboxes.find(c => c.nextSibling?.textContent === "IFD0:Make")?.checked).toBe(false);
  });

  it("calls onSave with updated selection", async () => {
    const onSave = vi.fn();
    render(<ColumnSelectionDialog allKeys={allKeys} visibleColumns={["IFD0:Model"]} visibleOSColumns={["date_modified", "date_created"]} onSave={onSave} onClose={noop} />);
    
    // Toggle Make on
    const makeLabel = screen.getByText("IFD0:Make");
    await userEvent.click(makeLabel);
    
    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith(
      expect.arrayContaining(["IFD0:Model", "IFD0:Make"]),
      expect.arrayContaining(["date_modified", "date_created"])
    );
  });
});
