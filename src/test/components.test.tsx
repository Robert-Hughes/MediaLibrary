import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { MenuBar } from "../components/MenuBar";
import { FileList } from "../components/FileList";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";
import type { FileInfo } from "../types";
import {
  imgCol,
  makeFile,
  makeFiles,
  mockMetadata,
  osCol,
  testId,
} from "./factories";

import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStores(
  files: FileInfo[],
  thumbOverrides: Record<string, string> = {},
) {
  const thumbs = new ThumbnailStore();
  thumbs.reset(files.map((p) => p.relative_path));
  for (const [k, v] of Object.entries(thumbOverrides)) thumbs.set(k, v);
  const fileMetadata = new FileMetadataOccurrencesStore();
  files.forEach((p) => fileMetadata.add(p.relative_path));
  return { thumbs, fileMetadata };
}

function renderList(
  files: FileInfo[],
  opts: {
    thumbOverrides?: Record<string, string>;
    selectedPath?: string | null;
    onSelect?: (path: string | null) => void;
    onFileOpen?: (path: string) => void;
    onShowInExplorer?: (index: number) => void;
    visibleColumns?: import("../types").VisibleColumn[];
    onSelectColumns?: () => void;
  } = {},
) {
  const { thumbs, fileMetadata } = makeStores(files, opts.thumbOverrides ?? {});
  render(
    <FileList
      targetDraftEdits={{}}
      files={files}
      thumbnails={thumbs}
      fileMetadataOccurrences={fileMetadata}
      visibleColumns={
        opts.visibleColumns ?? [
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("IFD0:Model"),
        ]
      }
      selectedPath={opts.selectedPath ?? null}
      onSelect={opts.onSelect ?? (() => {})}
      onShowInExplorer={opts.onShowInExplorer ?? (() => {})}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      onVisibilityChange={() => {}}
      onFileOpen={opts.onFileOpen ?? (() => {})}
      onSelectColumns={opts.onSelectColumns ?? (() => {})}
    />,
  );
  return { thumbs, fileMetadata };
}

const noop = () => {};

// ── WelcomeScreen ─────────────────────────────────────────────────────────────

describe("WelcomeScreen", () => {
  it("renders the title and open button", () => {
    render(
      <WelcomeScreen
        onOpenFolder={noop}
        recentFolders={[]}
        onOpenRecent={noop}
      />,
    );
    expect(screen.getByText("Media Library")).toBeInTheDocument();
    expect(screen.getByTestId("open-folder-btn")).toBeInTheDocument();
  });

  it("calls onOpenFolder when the button is clicked", async () => {
    const handler = vi.fn();
    render(
      <WelcomeScreen
        onOpenFolder={handler}
        recentFolders={[]}
        onOpenRecent={noop}
      />,
    );
    await userEvent.click(screen.getByTestId("open-folder-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("shows recent folders when provided", () => {
    const recent = ["/files/2023", "/files/2024"];
    render(
      <WelcomeScreen
        onOpenFolder={noop}
        recentFolders={recent}
        onOpenRecent={noop}
      />,
    );
    expect(screen.getByTestId("recent-folders")).toBeInTheDocument();
    expect(screen.getAllByTestId("recent-folder-item")).toHaveLength(2);
    expect(screen.getByText("/files/2023")).toBeInTheDocument();
  });

  it("calls onOpenRecent when a recent item is clicked", async () => {
    const handler = vi.fn();
    render(
      <WelcomeScreen
        onOpenFolder={noop}
        recentFolders={["/files/old"]}
        onOpenRecent={handler}
      />,
    );
    await userEvent.click(screen.getByTestId("recent-folder-item"));
    expect(handler).toHaveBeenCalledWith("/files/old");
  });
});

// ── MenuBar ───────────────────────────────────────────────────────────────────

describe("MenuBar", () => {
  const base = {
    onOpenFolder: noop,
    onCloseFolder: noop,
    onSelectColumns: noop,
    onOpenSettings: noop,
  };

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

// ── FileList ─────────────────────────────────────────────────────────────────

describe("FileList", () => {
  beforeEach(() => {
    _clearTagInfoCache();
    _setTagInfoCacheEntry("IFD0:Model", null);
  });
  it("shows empty message when no files", () => {
    const { thumbs, fileMetadata } = makeStores([]);
    render(
      <FileList
        targetDraftEdits={{}}
        files={[]}
        thumbnails={thumbs}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={noop}
        selectedPath={null}
        onSelect={noop}
        onShowInExplorer={noop}
        onVisibilityChange={noop}
        onFileOpen={noop}
        onSelectColumns={noop}
      />,
    );
    expect(screen.getByTestId("file-list-empty")).toBeInTheDocument();
  });

  it("renders a row for each file", () => {
    renderList(makeFiles(["a.jpg", "b.png", "c.gif"]));
    expect(screen.getAllByTestId("file-row")).toHaveLength(3);
  });

  it("displays the relative path", () => {
    renderList([makeFile({ relative_path: "vacation/beach.jpg" })]);
    expect(screen.getByTestId("file-path")).toHaveTextContent(
      "vacation/beach.jpg",
    );
  });

  // ── Image metadata cells ───────────────────────────────────────────────────

  it("shows spinner in Image Metadata cells while metadata is loading", () => {
    renderList([makeFile({ relative_path: "a.jpg" })]);
    expect(screen.getByTestId("metadata-loading")).toBeInTheDocument();
  });

  it("shows metadata value after it arrives", () => {
    const files = [makeFile({ relative_path: "a.jpg" })];
    const { thumbs, fileMetadata } = makeStores(files);
    act(() => {
      fileMetadata.set(
        "a.jpg",
        occurrencesFromMetadataCollection(
          mockMetadata({ "IFD0:Model": "Canon EOS R5" }),
        ),
      );
    });
    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbs}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("IFD0:Model"),
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={noop}
        selectedPath={null}
        onSelect={noop}
        onShowInExplorer={noop}
        onVisibilityChange={noop}
        onFileOpen={noop}
        onSelectColumns={noop}
      />,
    );
    expect(screen.getByText("Canon EOS R5")).toBeInTheDocument();
    expect(screen.queryByTestId("metadata-loading")).not.toBeInTheDocument();
  });

  // ── Selection ────────────────────────────────────────────────────────────

  it("calls onSelect with the correct index when a row is clicked", async () => {
    const onSelect = vi.fn();
    const files = makeFiles(["a.jpg", "b.jpg"]);
    renderList(files, { onSelect });

    const rows = screen.getAllByTestId("file-row");
    await userEvent.click(rows[1]);
    expect(onSelect).toHaveBeenCalledWith("b.jpg");
  });

  it("calls onFileOpen with the correct index when a row is double-clicked", async () => {
    const onFileOpen = vi.fn();
    const files = makeFiles(["a.jpg", "b.jpg"]);
    renderList(files, { onFileOpen });

    const rows = screen.getAllByTestId("file-row");
    await userEvent.dblClick(rows[1]);
    expect(onFileOpen).toHaveBeenCalledWith("b.jpg");
  });

  it("applies selected class to the correct row", () => {
    const files = makeFiles(["a.jpg", "b.jpg"]);
    renderList(files, { selectedPath: "b.jpg" });

    const rows = screen.getAllByTestId("file-row");
    expect(rows[0]).not.toHaveClass("file-row--selected");
    expect(rows[1]).toHaveClass("file-row--selected");
  });

  // ── Context Menu ───────────────────────────────────────────────────────────

  it("opens context menu on right click", async () => {
    const files = makeFiles(["a.jpg"]);
    renderList(files);

    const row = screen.getByTestId("file-row");
    fireEvent.contextMenu(row);

    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    expect(screen.getByText("View")).toBeInTheDocument();
    expect(screen.getByText("Show in File Explorer")).toBeInTheDocument();
  });
});

// ── ColumnSelectionDialog ─────────────────────────────────────────────────────

describe("ColumnSelectionDialog", () => {
  const allKeys = [
    { id: testId("IFD0:Model"), count: 10 },
    { id: testId("IFD0:Make"), count: 8 },
  ];

  beforeEach(() => {
    _setTagInfoCacheEntry("IFD0:Model", {
      group: "IFD0",
      name: "Model",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
  });

  it("renders all keys with counts", () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
        ]}
        onSave={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText("IFD0:Model")).toBeInTheDocument();
    expect(screen.getByText("(10 files)")).toBeInTheDocument();
    expect(screen.getByText("IFD0:Make")).toBeInTheDocument();
    expect(screen.getByText("(8 files)")).toBeInTheDocument();
  });

  it("checks currently visible columns", () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("IFD0:Model"),
        ]}
        onSave={noop}
        onClose={noop}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(
      checkboxes.find((c) => c.nextSibling?.textContent === "IFD0:Model")
        ?.checked,
    ).toBe(true);
    expect(
      checkboxes.find((c) => c.nextSibling?.textContent === "IFD0:Make")
        ?.checked,
    ).toBe(false);
  });

  it("calls onSave with updated selection", async () => {
    const onSave = vi.fn();
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("IFD0:Model"),
        ]}
        onSave={onSave}
        onClose={noop}
      />,
    );

    // Toggle Make on
    const makeLabel = screen.getByText("IFD0:Make");
    await userEvent.click(makeLabel);

    await userEvent.click(screen.getByText("Save Changes"));
    const [saved] = onSave.mock.calls[0];
    expect(saved).toEqual(
      expect.arrayContaining([
        osCol("date_modified"),
        osCol("date_created"),
        imgCol("IFD0:Model"),
        imgCol("IFD0:Make"),
      ]),
    );
  });
});
