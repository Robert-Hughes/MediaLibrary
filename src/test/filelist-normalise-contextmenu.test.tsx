/**
 * Coverage for the FileList "Normalise Metadata…" context-menu entry.
 *
 * Plan §13 places the overwrite warning inside the
 * NormaliseProgressDialog rather than a pre-click `ask()` (the dialog
 * needs to show per-group toggles either way, and the warning is
 * prominent in the confirm panel). So unlike Geocode and Describe,
 * this entry invokes `onNormalise` directly — no `ask` round-trip.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

interface SetupOptions {
  fileCount?: number;
  onNormalise?: (paths: string[]) => void;
}

function setup(opts: SetupOptions = {}) {
  const n = opts.fileCount ?? 5;
  const files = Array.from({ length: n }, (_, i) => ({
    relative_path: `${i}.jpg`,
    filename: `${i}.jpg`,
    media_kind: "image" as const,
    date_modified: null,
    date_created: null,
  }));
  const thumbnails = new ThumbnailStore();
  const fileMetadata = new FileMetadataOccurrencesStore();
  for (const p of files) {
    thumbnails.add(p.relative_path);
    fileMetadata.add(p.relative_path);
  }
  const onNormalise = vi.fn(opts.onNormalise ?? (() => {}));
  render(
    <FileList
      targetDraftEdits={{}}
      files={files}
      thumbnails={thumbnails}
      fileMetadataOccurrences={fileMetadata}
      visibleColumns={[]}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedIndex={null}
      onSelect={() => {}}
      onShowInExplorer={() => {}}
      onVisibilityChange={() => {}}
      onFileOpen={() => {}}
      onApplyEdits={() => {}}
      onDiscardAllEdits={() => {}}
      onGenerateAiDescription={() => {}}
      onGeocode={() => {}}
      onNormalise={onNormalise}
    />,
  );
  return { onNormalise };
}

function rows() {
  return screen.getAllByTestId("file-row");
}

describe("FileList: Normalise Metadata context-menu entry", () => {
  beforeEach(() => {
    cleanup();
  });

  it("entry is visible when a single file is selected", async () => {
    setup();
    fireEvent.click(rows()[2]);
    fireEvent.contextMenu(rows()[2]);
    const entry = await screen.findByRole("button", {
      name: "Normalise Metadata…",
    });
    expect(entry).toBeInTheDocument();
  });

  it("entry label includes count and noun for multi-select", async () => {
    setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[4], { ctrlKey: true });
    fireEvent.contextMenu(rows()[4]);
    const entry = await screen.findByRole("button", {
      name: "Normalise Metadata… (3 files)",
    });
    expect(entry).toBeInTheDocument();
  });

  it("clicking the entry invokes onNormalise with the selected paths", async () => {
    const { onNormalise } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const entry = await screen.findByRole("button", {
      name: /^Normalise Metadata/,
    });
    fireEvent.click(entry);
    expect(onNormalise).toHaveBeenCalledTimes(1);
    expect(onNormalise).toHaveBeenCalledWith(["1.jpg", "3.jpg"]);
  });

  it("entry is hidden when onNormalise is not wired", async () => {
    const n = 3;
    const files = Array.from({ length: n }, (_, i) => ({
      relative_path: `${i}.jpg`,
      filename: `${i}.jpg`,
      media_kind: "image" as const,
      date_modified: null,
      date_created: null,
    }));
    const thumbnails = new ThumbnailStore();
    const fileMetadata = new FileMetadataOccurrencesStore();
    for (const p of files) {
      thumbnails.add(p.relative_path);
      fileMetadata.add(p.relative_path);
    }
    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    fireEvent.click(rows()[0]);
    fireEvent.contextMenu(rows()[0]);
    // Some other entry should still be present so we know the menu opened.
    await screen.findByRole("button", { name: /^View/ });
    expect(
      screen.queryByRole("button", { name: /^Normalise Metadata/ }),
    ).toBeNull();
  });
});
