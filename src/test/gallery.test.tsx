/**
 * Gallery view tests.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GalleryView } from "../components/GalleryView";
import { FileList } from "../components/FileList";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";
import { useMediaLibrary } from "../useMediaLibrary";
import { createMockTauriApi } from "./mockTauriApi";
import { makeFiles } from "./factories";
import type { FileInfo } from "../types";

const PHOTOS: FileInfo[] = makeFiles(["a.jpg", "b.jpg", "c.jpg"]);

function makeStore(files: FileInfo[]) {
  const s = new ThumbnailStore();
  s.reset(files.map((p) => p.relative_path));
  return s;
}

const fakeLoadMedia = async (_path: string) => "data:image/jpeg;base64,FAKE";

describe("GalleryView", () => {
  it("renders audio files with browser controls", async () => {
    const files: FileInfo[] = [
      { ...makeFiles(["track.flac"])[0], media_kind: "audio" },
    ];

    render(
      <GalleryView
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={files}
        currentIndex={0}
        folderPath="/files"
        onClose={() => {}}
        onNavigate={() => {}}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={async () => "asset://track.flac"}
      />,
    );

    const audio = await screen.findByTestId("gallery-audio");
    expect(audio).toHaveAttribute("src", "asset://track.flac");
    expect(audio).toHaveAttribute("controls");
    expect(screen.queryByTestId("gallery-image")).not.toBeInTheDocument();
  });

  it("renders video files with browser controls", async () => {
    const files: FileInfo[] = [
      { ...makeFiles(["clip.mp4"])[0], media_kind: "video" },
    ];

    render(
      <GalleryView
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={files}
        currentIndex={0}
        folderPath="/files"
        onClose={() => {}}
        onNavigate={() => {}}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={async () => "asset://clip.mp4"}
      />,
    );

    const video = await screen.findByTestId("gallery-video");
    expect(video).toHaveAttribute("src", "asset://clip.mp4");
    expect(video).toHaveAttribute("controls");
    expect(screen.queryByTestId("gallery-image")).not.toBeInTheDocument();
  });

  it("renders the current file path in the caption", async () => {
    render(
      <GalleryView
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={PHOTOS}
        currentIndex={1}
        folderPath="/files"
        onClose={() => {}}
        onNavigate={() => {}}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={fakeLoadMedia}
      />,
    );
    await screen.findByTestId("gallery-image");
    expect(screen.getByTestId("gallery-caption")).toHaveTextContent("b.jpg");
  });

  it("shows counter with correct position", async () => {
    render(
      <GalleryView
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={PHOTOS}
        currentIndex={1}
        folderPath="/files"
        onClose={() => {}}
        onNavigate={() => {}}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={fakeLoadMedia}
      />,
    );
    await screen.findByTestId("gallery-image");
    const counter = document.querySelector(".gallery-counter");
    expect(counter).not.toBeNull();
    expect(counter!.textContent).toMatch(/2.*3/);
  });

  it("shows the loaded image when loadMedia resolves", async () => {
    render(
      <GalleryView
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={PHOTOS}
        currentIndex={0}
        folderPath="/files"
        onClose={() => {}}
        onNavigate={() => {}}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={fakeLoadMedia}
      />,
    );
    const img = await screen.findByTestId("gallery-image");
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,FAKE");
  });

  it("does not close when clicking the gallery content or dialog element", async () => {
    const onClose = vi.fn();
    render(
      <GalleryView
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={PHOTOS}
        currentIndex={0}
        folderPath="/files"
        onClose={onClose}
        onNavigate={vi.fn()}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={fakeLoadMedia}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "File gallery",
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
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={PHOTOS}
        currentIndex={0}
        folderPath="/files"
        onClose={onClose}
        onNavigate={vi.fn()}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={fakeLoadMedia}
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
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        files={PHOTOS}
        currentIndex={0}
        folderPath="/files"
        onClose={onClose}
        onNavigate={vi.fn()}
        fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
        loadMedia={fakeLoadMedia}
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

  it("galleryIndex starts as null after first file_found", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(PHOTOS[0]);
    });
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind === "loaded") expect(state.galleryIndex).toBeNull();
  });

  it("openGallery sets the correct index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      mock.emitFileFound(PHOTOS[0]);
    });

    act(() => {
      result.current[1].openGallery(0);
    });
    const state = result.current[0];
    if (state.kind === "loaded") expect(state.galleryIndex).toBe(0);
  });

  it("navigateGallery(1) increments the index", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/files");
    const { result } = renderHook(() => useMediaLibrary(mock.api));
    await act(async () => {
      await result.current[1].openFolder();
    });
    act(() => {
      PHOTOS.forEach((p) => mock.emitFileFound(p));
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

describe("FileList interaction", () => {
  function renderList(
    files: FileInfo[],
    onFileOpen: (i: number) => void,
    onSelect: (i: number | null) => void,
  ) {
    const thumbs = makeStore(files);
    const fileMetadata = new FileMetadataOccurrencesStore();
    files.forEach((p) => fileMetadata.add(p.relative_path));
    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbs}
        fileMetadataOccurrences={fileMetadata}
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
        onFileOpen={onFileOpen}
        onSelectColumns={() => {}}
      />,
    );
  }

  it("calls onFileOpen with the correct index when a row is double-clicked", async () => {
    const onFileOpen = vi.fn();
    const files = makeFiles(["a.jpg", "b.jpg", "c.jpg"]);
    renderList(files, onFileOpen, () => {});
    const rows = screen.getAllByTestId("file-row");
    await userEvent.dblClick(rows[1]);
    expect(onFileOpen).toHaveBeenCalledWith(1);
  });

  it("calls onSelect with the correct index when a row is clicked", async () => {
    const onSelect = vi.fn();
    const files = makeFiles(["a.jpg", "b.jpg", "c.jpg"]);
    renderList(files, () => {}, onSelect);
    const rows = screen.getAllByTestId("file-row");
    await userEvent.click(rows[2]);
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
