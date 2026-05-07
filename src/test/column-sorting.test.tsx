import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { PhotoInfo, SortConfig } from "../types";
import { sortPhotos, nextSortConfig } from "../utils/sorting";
import { makePhoto } from "./factories";

// ── sorting utility unit tests ─────────────────────────────────────────────────

describe("nextSortConfig", () => {
  const noSort: SortConfig = { primary: null, secondary: null };

  it("clicking a new column sets it as primary asc with no secondary", () => {
    const result = nextSortConfig(noSort, "date_modified", "os");
    expect(result.primary).toEqual({ column: "date_modified", columnType: "os", direction: "asc" });
    expect(result.secondary).toBeNull();
  });

  it("clicking the current primary column toggles direction to desc", () => {
    const current: SortConfig = {
      primary: { column: "date_modified", columnType: "os", direction: "asc" },
      secondary: null,
    };
    const result = nextSortConfig(current, "date_modified", "os");
    expect(result.primary?.direction).toBe("desc");
    expect(result.secondary).toBeNull();
  });

  it("clicking the current primary column (desc) toggles direction to asc", () => {
    const current: SortConfig = {
      primary: { column: "date_modified", columnType: "os", direction: "desc" },
      secondary: null,
    };
    const result = nextSortConfig(current, "date_modified", "os");
    expect(result.primary?.direction).toBe("asc");
  });

  it("clicking a different column promotes old primary to secondary", () => {
    const current: SortConfig = {
      primary: { column: "date_modified", columnType: "os", direction: "desc" },
      secondary: null,
    };
    const result = nextSortConfig(current, "relative_path", "path");
    expect(result.primary).toEqual({ column: "relative_path", columnType: "path", direction: "asc" });
    expect(result.secondary).toEqual({ column: "date_modified", columnType: "os", direction: "desc" });
  });

  it("clicking a third column replaces secondary with old primary", () => {
    const current: SortConfig = {
      primary: { column: "date_modified", columnType: "os", direction: "asc" },
      secondary: { column: "date_created", columnType: "os", direction: "asc" },
    };
    const result = nextSortConfig(current, "relative_path", "path");
    expect(result.primary?.column).toBe("relative_path");
    expect(result.secondary?.column).toBe("date_modified");
  });
});

describe("sortPhotos", () => {
  const imageMetadata = new ImageMetadataStore();

  it("returns the same order when no sort is configured", () => {
    const photos = [
      makePhoto({ relative_path: "b.jpg" }),
      makePhoto({ relative_path: "a.jpg" }),
    ];
    const noSort: SortConfig = { primary: null, secondary: null };
    const result = sortPhotos(photos, noSort, imageMetadata);
    expect(result.map(p => p.relative_path)).toEqual(["b.jpg", "a.jpg"]);
  });

  it("sorts by path ascending", () => {
    const photos = [
      makePhoto({ relative_path: "c.jpg" }),
      makePhoto({ relative_path: "a.jpg" }),
      makePhoto({ relative_path: "b.jpg" }),
    ];
    const sort: SortConfig = {
      primary: { column: "relative_path", columnType: "path", direction: "asc" },
      secondary: null,
    };
    const result = sortPhotos(photos, sort, imageMetadata);
    expect(result.map(p => p.relative_path)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("sorts by path descending", () => {
    const photos = [
      makePhoto({ relative_path: "a.jpg" }),
      makePhoto({ relative_path: "c.jpg" }),
      makePhoto({ relative_path: "b.jpg" }),
    ];
    const sort: SortConfig = {
      primary: { column: "relative_path", columnType: "path", direction: "desc" },
      secondary: null,
    };
    const result = sortPhotos(photos, sort, imageMetadata);
    expect(result.map(p => p.relative_path)).toEqual(["c.jpg", "b.jpg", "a.jpg"]);
  });

  it("sorts by OS date_modified ascending, nulls last", () => {
    const photos = [
      makePhoto({ relative_path: "c.jpg", date_modified: null }),
      makePhoto({ relative_path: "a.jpg", date_modified: 100 }),
      makePhoto({ relative_path: "b.jpg", date_modified: 50 }),
    ];
    const sort: SortConfig = {
      primary: { column: "date_modified", columnType: "os", direction: "asc" },
      secondary: null,
    };
    const result = sortPhotos(photos, sort, imageMetadata);
    expect(result.map(p => p.relative_path)).toEqual(["b.jpg", "a.jpg", "c.jpg"]);
  });

  it("sorts by image metadata value ascending, missing values last", () => {
    const store = new ImageMetadataStore();
    store.add("b.jpg"); store.set("b.jpg", { "IFD0:Model": "Canon" });
    store.add("a.jpg"); store.set("a.jpg", { "IFD0:Model": "Nikon" });
    store.add("c.jpg"); // still loading → sorts to end
    const photos = [
      makePhoto({ relative_path: "b.jpg" }),
      makePhoto({ relative_path: "a.jpg" }),
      makePhoto({ relative_path: "c.jpg" }),
    ];
    const sort: SortConfig = {
      primary: { column: "IFD0:Model", columnType: "image", direction: "asc" },
      secondary: null,
    };
    const result = sortPhotos(photos, sort, store);
    expect(result.map(p => p.relative_path)).toEqual(["b.jpg", "a.jpg", "c.jpg"]);
  });

  it("uses secondary sort to break ties in primary sort", () => {
    const photos = [
      makePhoto({ relative_path: "b.jpg", date_modified: 100, date_created: 2 }),
      makePhoto({ relative_path: "a.jpg", date_modified: 100, date_created: 1 }),
      makePhoto({ relative_path: "c.jpg", date_modified: 50, date_created: 3 }),
    ];
    const sort: SortConfig = {
      primary: { column: "date_modified", columnType: "os", direction: "asc" },
      secondary: { column: "date_created", columnType: "os", direction: "asc" },
    };
    const result = sortPhotos(photos, sort, imageMetadata);
    // c first (date_modified=50), then a (date_modified=100, date_created=1), then b
    expect(result.map(p => p.relative_path)).toEqual(["c.jpg", "a.jpg", "b.jpg"]);
  });

  it("does not mutate the original array", () => {
    const photos = [
      makePhoto({ relative_path: "b.jpg" }),
      makePhoto({ relative_path: "a.jpg" }),
    ];
    const original = [...photos];
    const sort: SortConfig = {
      primary: { column: "relative_path", columnType: "path", direction: "asc" },
      secondary: null,
    };
    sortPhotos(photos, sort, imageMetadata);
    expect(photos).toEqual(original);
  });
});

// ── PhotoList sort indicator UI tests ─────────────────────────────────────────

const mockPhotos: PhotoInfo[] = [
  { relative_path: "b.jpg", filename: "b.jpg", date_modified: 200, date_created: 200 },
  { relative_path: "a.jpg", filename: "a.jpg", date_modified: 100, date_created: 100 },
];

function makeSortStores() {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataStore();
  mockPhotos.forEach(p => { thumbnails.add(p.relative_path); imageMetadata.add(p.relative_path); });
  return { thumbnails, imageMetadata };
}

describe("PhotoList sort indicator", () => {
  it("shows no sort indicator by default", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector(".sort-indicator")).toBeNull();
  });

  it("shows primary sort indicator on sorted column", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={{ primary: { column: "date_modified", columnType: "os", direction: "asc" }, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    const indicator = document.querySelector(".sort-indicator--primary");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("▲");
  });

  it("shows desc indicator when sort direction is desc", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={{ primary: { column: "date_modified", columnType: "os", direction: "desc" }, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector(".sort-indicator--primary")?.textContent).toContain("▼");
  });

  it("calls onSortChange with ascending sort when a column header is clicked", async () => {
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={onSortChange}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    await userEvent.click(screen.getByText("Modified"));
    expect(onSortChange).toHaveBeenCalledWith({
      primary: { column: "date_modified", columnType: "os", direction: "asc" },
      secondary: null,
    });
  });

  it("calls onSortChange toggling to desc when the same sorted column is clicked again", async () => {
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={{ primary: { column: "date_modified", columnType: "os", direction: "asc" }, secondary: null }}
        onSortChange={onSortChange}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    await userEvent.click(screen.getByText("Modified"));
    expect(onSortChange).toHaveBeenCalledWith({
      primary: { column: "date_modified", columnType: "os", direction: "desc" },
      secondary: null,
    });
  });

  it("shows secondary sort indicator on secondary sorted column", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified", "date_created"]}
        sortConfig={{
          primary: { column: "date_modified", columnType: "os", direction: "asc" },
          secondary: { column: "date_created", columnType: "os", direction: "desc" },
        }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector(".sort-indicator--primary")?.textContent).toContain("▲");
    expect(document.querySelector(".sort-indicator--secondary")?.textContent).toContain("▼");
  });
});

describe("PhotoList sortingDisabled", () => {
  const sortConfig: SortConfig = {
    primary: { column: "date_modified", columnType: "os", direction: "asc" },
    secondary: null,
  };

  it("hides ▲/▼ indicators when sortingDisabled is true", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={sortConfig}
        onSortChange={() => {}}
        sortingDisabled
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    expect(document.querySelector(".sort-indicator--primary")).toBeNull();
    expect(document.querySelector(".sort-indicator--secondary")).toBeNull();
  });

  it("shows the indicators again once sortingDisabled flips back to false", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    const props = {
      photos: mockPhotos,
      thumbnails,
      imageMetadata,
      visibleColumns: [],
      visibleOSColumns: ["date_modified"],
      sortConfig,
      onSortChange: () => {},
      selectedIndex: null,
      onSelect: () => {},
      onShowInExplorer: () => {},
      onVisibilityChange: () => {},
      onPhotoOpen: () => {},
    };
    const { rerender } = render(<PhotoList {...props} sortingDisabled />);
    expect(document.querySelector(".sort-indicator--primary")).toBeNull();

    rerender(<PhotoList {...props} sortingDisabled={false} />);
    expect(document.querySelector(".sort-indicator--primary")?.textContent).toContain("▲");
  });

  it("ignores header clicks while sortingDisabled — onSortChange is not called", async () => {
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <PhotoList
        photos={mockPhotos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        visibleOSColumns={["date_modified"]}
        sortConfig={sortConfig}
        onSortChange={onSortChange}
        sortingDisabled
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
      />
    );
    await userEvent.click(screen.getByText("Modified"));
    expect(onSortChange).not.toHaveBeenCalled();
  });
});
