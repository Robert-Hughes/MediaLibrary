import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { MenuBar } from "../components/MenuBar";
import { PhotoList } from "../components/PhotoList";
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

function renderList(photos: PhotoInfo[], opts: { thumbOverrides?: Record<string, string>, selectedIndex?: number | null, onSelect?: (i: number | null) => void, onPhotoOpen?: (i: number) => void, onShowInExplorer?: (i: number) => void, visibleColumns?: import("../types").VisibleColumn[], onSelectColumns?: () => void } = {}) {
  const { thumbs, imageMetadata } = makeStores(photos, opts.thumbOverrides ?? {});
  render(
    <PhotoList
      photos={photos}
      thumbnails={thumbs}
      imageMetadata={imageMetadata}
      visibleColumns={opts.visibleColumns ?? [
        { key: "date_modified", kind: "os" },
        { key: "date_created", kind: "os" },
        { key: "IFD0:Model", kind: "image" },
      ]}
      selectedIndex={opts.selectedIndex ?? null}
      onSelect={opts.onSelect ?? (() => {})}
      onShowInExplorer={opts.onShowInExplorer ?? (() => {})}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
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

// ── MenuBar ───────────────────────────────────────────────────────────────────

describe("MenuBar", () => {
  const base = { onOpenFolder: noop, onCloseFolder: noop, onSelectColumns: noop, onOpenSettings: noop };

  it("renders open / close / columns / settings buttons", () => {
    render(<MenuBar {...base} />);
    expect(screen.getByTestId("menu-bar-open-btn")).toBeInTheDocument();
    expect(screen.getByTestId("menu-bar-close-btn")).toBeInTheDocument();
    expect(screen.getByTestId("menu-bar-columns-btn")).toBeInTheDocument();
    expect(screen.getByTestId("menu-bar-settings-btn")).toBeInTheDocument();
  });

  it("renders search box only when onSearchQueryChange is provided", () => {
    const { rerender } = render(<MenuBar {...base} />);
    expect(screen.queryByTestId("menu-bar-search")).not.toBeInTheDocument();
    rerender(<MenuBar {...base} searchQuery="" onSearchQueryChange={noop} />);
    expect(screen.getByTestId("menu-bar-search")).toBeInTheDocument();
  });

  it("renders theme toggle", () => {
    render(<MenuBar {...base} />);
    expect(screen.getByTestId("menu-bar-theme-toggle")).toBeInTheDocument();
  });

  it("calls onSelectColumns when columns button is clicked", async () => {
    const handler = vi.fn();
    render(<MenuBar {...base} onSelectColumns={handler} />);
    await userEvent.click(screen.getByTestId("menu-bar-columns-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── PhotoList ─────────────────────────────────────────────────────────────────

describe("PhotoList", () => {
  it("shows empty message when no photos", () => {
    const { thumbs, imageMetadata } = makeStores([]);
    render(<PhotoList photos={[]} thumbnails={thumbs} imageMetadata={imageMetadata}
      visibleColumns={[{ key: "date_modified", kind: "os" }, { key: "date_created", kind: "os" }]} sortConfig={{ primary: null, secondary: null }} onSortChange={noop} selectedIndex={null} onSelect={noop} onShowInExplorer={noop} onVisibilityChange={noop} onPhotoOpen={noop} onSelectColumns={noop} />);
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
      visibleColumns={[{ key: "date_modified", kind: "os" }, { key: "date_created", kind: "os" }, { key: "IFD0:Model", kind: "image" }]} sortConfig={{ primary: null, secondary: null }} onSortChange={noop} selectedIndex={null} onSelect={noop} onShowInExplorer={noop} onVisibilityChange={noop} onPhotoOpen={noop} onSelectColumns={noop} />);
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
    render(<ColumnSelectionDialog allKeys={allKeys} visibleColumns={[{ key: "date_modified", kind: "os" }, { key: "date_created", kind: "os" }]} onSave={noop} onClose={noop} />);
    expect(screen.getByText("IFD0:Model")).toBeInTheDocument();
    expect(screen.getByText("(10 files)")).toBeInTheDocument();
    expect(screen.getByText("IFD0:Make")).toBeInTheDocument();
    expect(screen.getByText("(8 files)")).toBeInTheDocument();
  });

  it("checks currently visible columns", () => {
    render(<ColumnSelectionDialog allKeys={allKeys} visibleColumns={[{ key: "date_modified", kind: "os" }, { key: "date_created", kind: "os" }, { key: "IFD0:Model", kind: "image" }]} onSave={noop} onClose={noop} />);
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.find(c => c.nextSibling?.textContent === "IFD0:Model")?.checked).toBe(true);
    expect(checkboxes.find(c => c.nextSibling?.textContent === "IFD0:Make")?.checked).toBe(false);
  });

  it("calls onSave with updated selection", async () => {
    const onSave = vi.fn();
    render(<ColumnSelectionDialog allKeys={allKeys} visibleColumns={[{ key: "date_modified", kind: "os" }, { key: "date_created", kind: "os" }, { key: "IFD0:Model", kind: "image" }]} onSave={onSave} onClose={noop} />);

    // Toggle Make on
    const makeLabel = screen.getByText("IFD0:Make");
    await userEvent.click(makeLabel);

    await userEvent.click(screen.getByText("Save Changes"));
    const [saved] = onSave.mock.calls[0];
    const keys = (saved as Array<{ key: string }>).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["date_modified", "date_created", "IFD0:Model", "IFD0:Make"]));
  });
});
