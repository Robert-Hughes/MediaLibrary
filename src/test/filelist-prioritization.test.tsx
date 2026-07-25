import { render } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import type { FileInfo } from "../types";
import { imgCol, makeFiles, mockMetadata } from "./factories";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";
import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

describe("FileList prioritization optimization", () => {
  const mockFiles: FileInfo[] = makeFiles([
    "file1.jpg",
    "file2.jpg",
    "file3.jpg",
  ]).map((p) => ({
    ...p,
    media_kind: "image" as const,
    date_modified: 1640995200,
    date_created: 1640995200,
  }));

  let thumbnailStore: ThumbnailStore;
  let metadataStore: ImageMetadataOccurrencesStore;
  let onVisibilityChangeMock: ReturnType<
    typeof vi.fn<(paths: string[]) => void>
  >;

  beforeEach(() => {
    thumbnailStore = new ThumbnailStore();
    metadataStore = new ImageMetadataOccurrencesStore();
    onVisibilityChangeMock = vi.fn<(paths: string[]) => void>();

    // Add all files to stores (they start in "loading" state)
    mockFiles.forEach((file) => {
      thumbnailStore.add(file.relative_path);
      metadataStore.add(file.relative_path);
    });

    _clearTagInfoCache();
    _setTagInfoCacheEntry("ExifIFD:DateTimeOriginal", null);
  });

  it("should prioritize all files when none are loaded", () => {
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnailStore}
        imageMetadataOccurrences={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onFileOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should call onVisibilityChange with all files since none are loaded
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["file1.jpg", "file2.jpg", "file3.jpg"]),
    );
  });

  it("should not prioritize files that are fully loaded", () => {
    // Mark first file as fully loaded (both thumbnail and metadata)
    thumbnailStore.set("file1.jpg", "base64thumbnaildata");
    metadataStore.set(
      "file1.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({
          "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
        }),
      ),
    );

    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnailStore}
        imageMetadataOccurrences={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onFileOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should only call with files 2 and 3, not file 1 which is fully loaded
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["file2.jpg", "file3.jpg"]),
    );
    expect(onVisibilityChangeMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["file1.jpg"]),
    );
  });

  it("should prioritize files with only thumbnail loaded but missing metadata", () => {
    // Mark first file as having thumbnail but no metadata
    thumbnailStore.set("file1.jpg", "base64thumbnaildata");
    // metadata still in "loading" state

    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnailStore}
        imageMetadataOccurrences={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onFileOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should call with all files since file1 still needs metadata
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["file1.jpg", "file2.jpg", "file3.jpg"]),
    );
  });

  it("notifies visible paths in display order (top-to-bottom)", () => {
    // Regression: notify() used to iterate filesRef.current (the full list,
    // up to 10k items) and filter by visibleRef.  The fix iterates the visible
    // Set directly, which preserves insertion order set by updateVisible.
    // This test asserts the order is still display order, not Set-mutation order.
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnailStore}
        imageMetadataOccurrences={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onFileOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // The most recent call should contain file1, file2, file3 in that order.
    const calls = onVisibilityChangeMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1][0] as string[];
    expect(lastCall).toEqual(["file1.jpg", "file2.jpg", "file3.jpg"]);
  });

  it("preserves display order when some files have already loaded", () => {
    // Loaded files drop out, but the remaining ones stay in display order.
    thumbnailStore.set("file2.jpg", "data");
    metadataStore.set(
      "file2.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({
          "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
        }),
      ),
    );

    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnailStore}
        imageMetadataOccurrences={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onFileOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    const calls = onVisibilityChangeMock.mock.calls;
    const lastCall = calls[calls.length - 1][0] as string[];
    expect(lastCall).toEqual(["file1.jpg", "file3.jpg"]);
  });

  it("should prioritize files with only metadata loaded but missing thumbnail", () => {
    // Mark first file as having metadata but no thumbnail
    metadataStore.set(
      "file1.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({
          "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
        }),
      ),
    );
    // thumbnail still in "loading" state

    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnailStore}
        imageMetadataOccurrences={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onFileOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should call with all files since file1 still needs thumbnail
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["file1.jpg", "file2.jpg", "file3.jpg"]),
    );
  });

  it("should not prioritize failed thumbnails if metadata is loaded", () => {
    // Mark first file as having failed thumbnail but loaded metadata
    thumbnailStore.set("file1.jpg", "failed");
    metadataStore.set(
      "file1.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({
          "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
        }),
      ),
    );

    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnailStore}
        imageMetadataOccurrences={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onFileOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should only call with files 2 and 3, not file 1 which has failed thumbnail
    // (we don't want to keep retrying failed thumbnails)
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["file2.jpg", "file3.jpg"]),
    );
    // The call should not include file1.jpg since it's not in loading state
    const calls = onVisibilityChangeMock.mock.calls;
    const allCalledPaths = calls.flat();
    expect(allCalledPaths).not.toContain("file1.jpg");
  });
});

describe("initial-kickstart prioritization fires once per scan", () => {
  function makeProps(
    files: FileInfo[],
    onVisibilityChange: (paths: string[]) => void,
    stores?: {
      thumbnails: ThumbnailStore;
      metadata: ImageMetadataOccurrencesStore;
    },
  ) {
    const thumbs = stores?.thumbnails ?? new ThumbnailStore();
    const metadata = stores?.metadata ?? new ImageMetadataOccurrencesStore();
    files.forEach((p) => {
      thumbs.add(p.relative_path);
      metadata.add(p.relative_path);
    });
    return {
      thumbs,
      metadata,
      element: (
        <FileList
          targetDraftEdits={{}}
          files={files}
          thumbnails={thumbs}
          imageMetadataOccurrences={metadata}
          visibleColumns={[]}
          {...defaultSortProps}
          selectedIndex={null}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={onVisibilityChange}
          onFileOpen={() => {}}
          onSelectColumns={() => {}}
        />
      ),
    };
  }

  it("does not re-fire the first-30 kickstart on subsequent file batches", () => {
    // Regression: the initial-kickstart effect was keyed by files.length and
    // re-ran on every batch — for a 10k scan at 50/batch, it fired 200 times
    // and each time re-prioritised the first 30 paths even after they had
    // already been kickstarted (and were likely no longer at the top of view).
    //
    // Approach: render once with the first batch, snapshot the calls so far,
    // then re-render with a much larger files array using the same store
    // instances.  The first 30 paths from the kickstart are identical in both
    // renders — if the latch fails, we'd see the kickstart call signature
    // appear again in the post-rerender calls.
    const onVis = vi.fn();
    const files50 = makeFiles(
      Array.from({ length: 50 }, (_, i) => `p${i}.jpg`),
    );
    const { thumbs, metadata, element } = makeProps(files50, onVis);
    const { rerender } = render(element);

    const firstThirty = files50.slice(0, 30).map((p) => p.relative_path);

    // The kickstart call shape: exactly the first 30 paths in order.
    const kickstartCalls = onVis.mock.calls.filter(([arg]) => {
      const a = arg as string[];
      return (
        a.length === firstThirty.length &&
        a.every((v, i) => v === firstThirty[i])
      );
    });
    expect(kickstartCalls).toHaveLength(1);

    // Re-render with more files using the SAME stores (= same scan).
    const files200 = makeFiles(
      Array.from({ length: 200 }, (_, i) => `p${i}.jpg`),
    );
    files200.forEach((p) => {
      thumbs.add(p.relative_path);
      metadata.add(p.relative_path);
    });
    const { element: nextEl } = makeProps(files200, onVis, {
      thumbnails: thumbs,
      metadata,
    });
    rerender(nextEl);

    const kickstartCallsAfter = onVis.mock.calls.filter(([arg]) => {
      const a = arg as string[];
      return (
        a.length === firstThirty.length &&
        a.every((v, i) => v === firstThirty[i])
      );
    });
    expect(kickstartCallsAfter).toHaveLength(1);
  });

  it("fires the kickstart again when stores are replaced (= new scan)", () => {
    const onVis = vi.fn();
    const files = makeFiles(Array.from({ length: 50 }, (_, i) => `p${i}.jpg`));
    const first = makeProps(files, onVis);
    const { rerender } = render(first.element);

    const initialKickstartCount = onVis.mock.calls.length;
    expect(initialKickstartCount).toBeGreaterThan(0);

    // Simulate a new scan: brand-new store instances.
    const newScan = makeProps(files, onVis);
    rerender(newScan.element);

    // The kickstart should fire again under the new store identity.
    expect(onVis.mock.calls.length).toBeGreaterThan(initialKickstartCount);
  });
});
