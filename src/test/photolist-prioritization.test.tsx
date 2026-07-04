import { render } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo } from "../types";
import { makePhotos } from "./factories";

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

describe("PhotoList prioritization optimization", () => {
  const mockPhotos: PhotoInfo[] = makePhotos([
    "photo1.jpg",
    "photo2.jpg",
    "photo3.jpg",
  ]).map((p) => ({
    ...p,
    date_modified: 1640995200,
    date_created: 1640995200,
  }));

  let thumbnailStore: ThumbnailStore;
  let metadataStore: ImageMetadataStore;
  let onVisibilityChangeMock: ReturnType<
    typeof vi.fn<(paths: string[]) => void>
  >;

  beforeEach(() => {
    thumbnailStore = new ThumbnailStore();
    metadataStore = new ImageMetadataStore();
    onVisibilityChangeMock = vi.fn<(paths: string[]) => void>();

    // Add all photos to stores (they start in "loading" state)
    mockPhotos.forEach((photo) => {
      thumbnailStore.add(photo.relative_path);
      metadataStore.add(photo.relative_path);
    });
  });

  it("should prioritize all photos when none are loaded", () => {
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should call onVisibilityChange with all photos since none are loaded
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["photo1.jpg", "photo2.jpg", "photo3.jpg"]),
    );
  });

  it("should not prioritize photos that are fully loaded", () => {
    // Mark first photo as fully loaded (both thumbnail and metadata)
    thumbnailStore.set("photo1.jpg", "base64thumbnaildata");
    metadataStore.set("photo1.jpg", {
      "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
    });

    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should only call with photos 2 and 3, not photo 1 which is fully loaded
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["photo2.jpg", "photo3.jpg"]),
    );
    expect(onVisibilityChangeMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["photo1.jpg"]),
    );
  });

  it("should prioritize photos with only thumbnail loaded but missing metadata", () => {
    // Mark first photo as having thumbnail but no metadata
    thumbnailStore.set("photo1.jpg", "base64thumbnaildata");
    // metadata still in "loading" state

    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should call with all photos since photo1 still needs metadata
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["photo1.jpg", "photo2.jpg", "photo3.jpg"]),
    );
  });

  it("notifies visible paths in display order (top-to-bottom)", () => {
    // Regression: notify() used to iterate photosRef.current (the full list,
    // up to 10k items) and filter by visibleRef.  The fix iterates the visible
    // Set directly, which preserves insertion order set by updateVisible.
    // This test asserts the order is still display order, not Set-mutation order.
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // The most recent call should contain photo1, photo2, photo3 in that order.
    const calls = onVisibilityChangeMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1][0] as string[];
    expect(lastCall).toEqual(["photo1.jpg", "photo2.jpg", "photo3.jpg"]);
  });

  it("preserves display order when some photos have already loaded", () => {
    // Loaded photos drop out, but the remaining ones stay in display order.
    thumbnailStore.set("photo2.jpg", "data");
    metadataStore.set("photo2.jpg", {
      "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
    });

    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    const calls = onVisibilityChangeMock.mock.calls;
    const lastCall = calls[calls.length - 1][0] as string[];
    expect(lastCall).toEqual(["photo1.jpg", "photo3.jpg"]);
  });

  it("should prioritize photos with only metadata loaded but missing thumbnail", () => {
    // Mark first photo as having metadata but no thumbnail
    metadataStore.set("photo1.jpg", {
      "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
    });
    // thumbnail still in "loading" state

    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should call with all photos since photo1 still needs thumbnail
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["photo1.jpg", "photo2.jpg", "photo3.jpg"]),
    );
  });

  it("should not prioritize failed thumbnails if metadata is loaded", () => {
    // Mark first photo as having failed thumbnail but loaded metadata
    thumbnailStore.set("photo1.jpg", "failed");
    metadataStore.set("photo1.jpg", {
      "ExifIFD:DateTimeOriginal": "2022:01:01 12:00:00",
    });

    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnailStore}
        imageMetadata={metadataStore}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "ExifIFD:DateTimeOriginal", kind: "image" },
        ]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={onVisibilityChangeMock}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
      />,
    );

    // Should only call with photos 2 and 3, not photo 1 which has failed thumbnail
    // (we don't want to keep retrying failed thumbnails)
    expect(onVisibilityChangeMock).toHaveBeenCalledWith(
      expect.arrayContaining(["photo2.jpg", "photo3.jpg"]),
    );
    // The call should not include photo1.jpg since it's not in loading state
    const calls = onVisibilityChangeMock.mock.calls;
    const allCalledPaths = calls.flat();
    expect(allCalledPaths).not.toContain("photo1.jpg");
  });
});

describe("initial-kickstart prioritization fires once per scan", () => {
  function makeProps(
    photos: PhotoInfo[],
    onVisibilityChange: (paths: string[]) => void,
    stores?: { thumbnails: ThumbnailStore; metadata: ImageMetadataStore },
  ) {
    const thumbs = stores?.thumbnails ?? new ThumbnailStore();
    const metadata = stores?.metadata ?? new ImageMetadataStore();
    photos.forEach((p) => {
      thumbs.add(p.relative_path);
      metadata.add(p.relative_path);
    });
    return {
      thumbs,
      metadata,
      element: (
        <PhotoList
          photos={photos}
          thumbnails={thumbs}
          imageMetadata={metadata}
          visibleColumns={[]}
          {...defaultSortProps}
          selectedIndex={null}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={onVisibilityChange}
          onPhotoOpen={() => {}}
          onSelectColumns={() => {}}
        />
      ),
    };
  }

  it("does not re-fire the first-30 kickstart on subsequent photo batches", () => {
    // Regression: the initial-kickstart effect was keyed by photos.length and
    // re-ran on every batch — for a 10k scan at 50/batch, it fired 200 times
    // and each time re-prioritised the first 30 paths even after they had
    // already been kickstarted (and were likely no longer at the top of view).
    //
    // Approach: render once with the first batch, snapshot the calls so far,
    // then re-render with a much larger photos array using the same store
    // instances.  The first 30 paths from the kickstart are identical in both
    // renders — if the latch fails, we'd see the kickstart call signature
    // appear again in the post-rerender calls.
    const onVis = vi.fn();
    const photos50 = makePhotos(
      Array.from({ length: 50 }, (_, i) => `p${i}.jpg`),
    );
    const { thumbs, metadata, element } = makeProps(photos50, onVis);
    const { rerender } = render(element);

    const firstThirty = photos50.slice(0, 30).map((p) => p.relative_path);

    // The kickstart call shape: exactly the first 30 paths in order.
    const kickstartCalls = onVis.mock.calls.filter(([arg]) => {
      const a = arg as string[];
      return (
        a.length === firstThirty.length &&
        a.every((v, i) => v === firstThirty[i])
      );
    });
    expect(kickstartCalls).toHaveLength(1);

    // Re-render with more photos using the SAME stores (= same scan).
    const photos200 = makePhotos(
      Array.from({ length: 200 }, (_, i) => `p${i}.jpg`),
    );
    photos200.forEach((p) => {
      thumbs.add(p.relative_path);
      metadata.add(p.relative_path);
    });
    const { element: nextEl } = makeProps(photos200, onVis, {
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
    const photos = makePhotos(
      Array.from({ length: 50 }, (_, i) => `p${i}.jpg`),
    );
    const first = makeProps(photos, onVis);
    const { rerender } = render(first.element);

    const initialKickstartCount = onVis.mock.calls.length;
    expect(initialKickstartCount).toBeGreaterThan(0);

    // Simulate a new scan: brand-new store instances.
    const newScan = makeProps(photos, onVis);
    rerender(newScan.element);

    // The kickstart should fire again under the new store identity.
    expect(onVis.mock.calls.length).toBeGreaterThan(initialKickstartCount);
  });
});
