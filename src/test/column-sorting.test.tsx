import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import type { FileInfo, SortConfig } from "../types";
import {
  sortFiles,
  nextSortConfig,
  shouldSuspendSorting,
} from "../utils/sorting";
import {
  imageSort as imageSortKey,
  imgCol,
  makeFile,
  mockMetadata,
  osCol,
  osSort as osSortKey,
  pathSort as pathSortKey,
  testId,
} from "./factories";
import {
  occurrenceFromSchemaValue,
  occurrencesFromMetadataCollection,
} from "./occurrenceFixtures";

// ── shouldSuspendSorting ──────────────────────────────────────────────────────
// ── shouldSuspendSorting ──────────────────────────────────────────────────────

describe("shouldSuspendSorting", () => {
  const noSort: SortConfig = { primary: null, secondary: null };
  const pathSort: SortConfig = {
    primary: pathSortKey("asc"),
    secondary: null,
  };
  const osSort: SortConfig = {
    primary: osSortKey("date_modified", "asc"),
    secondary: null,
  };
  const imageSort: SortConfig = {
    primary: imageSortKey("IFD0:Model", "asc"),
    secondary: null,
  };
  const imageSecondary: SortConfig = {
    primary: pathSortKey("asc"),
    secondary: imageSortKey("IFD0:Model", "asc"),
  };

  it("suspends while scanning regardless of sort or metadata state", () => {
    expect(shouldSuspendSorting(true, noSort, 0)).toBe(true);
    expect(shouldSuspendSorting(true, pathSort, 0)).toBe(true);
    expect(shouldSuspendSorting(true, imageSort, 0)).toBe(true);
  });

  it("path/OS sorts work the moment scanning ends, even with metadata still pending", () => {
    expect(shouldSuspendSorting(false, pathSort, 5000)).toBe(false);
    expect(shouldSuspendSorting(false, osSort, 5000)).toBe(false);
  });

  it("image-column primary sort stays suspended until metadata is fully loaded", () => {
    expect(shouldSuspendSorting(false, imageSort, 1)).toBe(true);
    expect(shouldSuspendSorting(false, imageSort, 0)).toBe(false);
  });

  it("does NOT suspend when only the secondary is an image sort", () => {
    // Secondary sorts are tiebreakers; during metadata loading the primary
    // still applies fine and rows missing the secondary value just degrade
    // to the primary order.  Suspending on secondary alone would trap users
    // who promote an OS column to primary while an image sort was active —
    // the image sort gets demoted to secondary by nextSortConfig and would
    // otherwise keep the UI suspended.
    expect(shouldSuspendSorting(false, imageSecondary, 1)).toBe(false);
    expect(shouldSuspendSorting(false, imageSecondary, 0)).toBe(false);
  });

  it("no sort: never suspended once scanning ends", () => {
    expect(shouldSuspendSorting(false, noSort, 1000)).toBe(false);
    expect(shouldSuspendSorting(false, noSort, 0)).toBe(false);
  });
});

// ── sorting utility unit tests ─────────────────────────────────────────────────

describe("nextSortConfig", () => {
  const noSort: SortConfig = { primary: null, secondary: null };

  it("clicking a new column sets it as primary asc with no secondary", () => {
    const result = nextSortConfig(noSort, {
      kind: "os",
      key: "date_modified",
    });
    expect(result.primary).toEqual(osSortKey("date_modified", "asc"));
    expect(result.secondary).toBeNull();
  });

  it("clicking the current primary column toggles direction to desc", () => {
    const current: SortConfig = {
      primary: osSortKey("date_modified", "asc"),
      secondary: null,
    };
    const result = nextSortConfig(current, {
      kind: "os",
      key: "date_modified",
    });
    expect(result.primary?.direction).toBe("desc");
    expect(result.secondary).toBeNull();
  });

  it("clicking the current primary column (desc) toggles direction to asc", () => {
    const current: SortConfig = {
      primary: osSortKey("date_modified", "desc"),
      secondary: null,
    };
    const result = nextSortConfig(current, {
      kind: "os",
      key: "date_modified",
    });
    expect(result.primary?.direction).toBe("asc");
  });

  it("clicking a different column promotes old primary to secondary", () => {
    const current: SortConfig = {
      primary: osSortKey("date_modified", "desc"),
      secondary: null,
    };
    const result = nextSortConfig(current, { kind: "path" });
    expect(result.primary).toEqual(pathSortKey("asc"));
    expect(result.secondary).toEqual(osSortKey("date_modified", "desc"));
  });

  it("clicking a third column replaces secondary with old primary", () => {
    const current: SortConfig = {
      primary: osSortKey("date_modified", "asc"),
      secondary: osSortKey("date_created", "asc"),
    };
    const result = nextSortConfig(current, { kind: "path" });
    expect(result.primary).toEqual(pathSortKey("asc"));
    expect(result.secondary).toEqual(osSortKey("date_modified", "asc"));
  });
});

describe("sortFiles", () => {
  const imageMetadata = new ImageMetadataOccurrencesStore();

  it("returns the same order when no sort is configured", () => {
    const files = [
      makeFile({ relative_path: "b.jpg" }),
      makeFile({ relative_path: "a.jpg" }),
    ];
    const noSort: SortConfig = { primary: null, secondary: null };
    const result = sortFiles(files, noSort, imageMetadata);
    expect(result.map((p) => p.relative_path)).toEqual(["b.jpg", "a.jpg"]);
  });

  it("sorts by path ascending", () => {
    const files = [
      makeFile({ relative_path: "c.jpg" }),
      makeFile({ relative_path: "a.jpg" }),
      makeFile({ relative_path: "b.jpg" }),
    ];
    const sort: SortConfig = {
      primary: pathSortKey("asc"),
      secondary: null,
    };
    const result = sortFiles(files, sort, imageMetadata);
    expect(result.map((p) => p.relative_path)).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
    ]);
  });

  it("sorts by path descending", () => {
    const files = [
      makeFile({ relative_path: "a.jpg" }),
      makeFile({ relative_path: "c.jpg" }),
      makeFile({ relative_path: "b.jpg" }),
    ];
    const sort: SortConfig = {
      primary: pathSortKey("desc"),
      secondary: null,
    };
    const result = sortFiles(files, sort, imageMetadata);
    expect(result.map((p) => p.relative_path)).toEqual([
      "c.jpg",
      "b.jpg",
      "a.jpg",
    ]);
  });

  it("sorts by OS date_modified ascending, nulls last", () => {
    const files = [
      makeFile({ relative_path: "c.jpg", date_modified: null }),
      makeFile({ relative_path: "a.jpg", date_modified: 100 }),
      makeFile({ relative_path: "b.jpg", date_modified: 50 }),
    ];
    const sort: SortConfig = {
      primary: osSortKey("date_modified", "asc"),
      secondary: null,
    };
    const result = sortFiles(files, sort, imageMetadata);
    expect(result.map((p) => p.relative_path)).toEqual([
      "b.jpg",
      "a.jpg",
      "c.jpg",
    ]);
  });

  it("sorts by image metadata value ascending, missing values last", () => {
    const store = new ImageMetadataOccurrencesStore();
    store.add("b.jpg");
    store.set(
      "b.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({ "IFD0:Model": "Canon" }),
      ),
    );
    store.add("a.jpg");
    store.set(
      "a.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({ "IFD0:Model": "Nikon" }),
      ),
    );
    store.add("c.jpg"); // still loading → sorts to end
    const files = [
      makeFile({ relative_path: "b.jpg" }),
      makeFile({ relative_path: "a.jpg" }),
      makeFile({ relative_path: "c.jpg" }),
    ];
    const sort: SortConfig = {
      primary: imageSortKey("IFD0:Model", "asc"),
      secondary: null,
    };
    const result = sortFiles(files, sort, store);
    expect(result.map((p) => p.relative_path)).toEqual([
      "b.jpg",
      "a.jpg",
      "c.jpg",
    ]);
  });

  it("uses secondary sort to break ties in primary sort", () => {
    const files = [
      makeFile({
        relative_path: "b.jpg",
        media_kind: "image" as const,
        date_modified: 100,
        date_created: 2,
      }),
      makeFile({
        relative_path: "a.jpg",
        media_kind: "image" as const,
        date_modified: 100,
        date_created: 1,
      }),
      makeFile({ relative_path: "c.jpg", date_modified: 50, date_created: 3 }),
    ];
    const sort: SortConfig = {
      primary: osSortKey("date_modified", "asc"),
      secondary: osSortKey("date_created", "asc"),
    };
    const result = sortFiles(files, sort, imageMetadata);
    // c first (date_modified=50), then a (date_modified=100, date_created=1), then b
    expect(result.map((p) => p.relative_path)).toEqual([
      "c.jpg",
      "a.jpg",
      "b.jpg",
    ]);
  });

  it("does not mutate the original array", () => {
    const files = [
      makeFile({ relative_path: "b.jpg" }),
      makeFile({ relative_path: "a.jpg" }),
    ];
    const original = [...files];
    const sort: SortConfig = {
      primary: pathSortKey("asc"),
      secondary: null,
    };
    sortFiles(files, sort, imageMetadata);
    expect(files).toEqual(original);
  });
  it("sorts identical same-schema occurrences and leaves conflicts last", () => {
    const id = testId("IFD0:Model");
    const store = new ImageMetadataOccurrencesStore();
    const identical = occurrenceFromSchemaValue(id, {
      kind: "Text",
      value: "Nikon",
    });
    const identicalSibling = structuredClone(identical);
    identicalSibling.id.path = "IFD1";
    identicalSibling.id.copy = 1;
    store.set("a.jpg", [identical, identicalSibling]);
    store.set("b.jpg", [
      occurrenceFromSchemaValue(id, { kind: "Text", value: "Canon" }),
    ]);
    const conflict = occurrenceFromSchemaValue(id, {
      kind: "Text",
      value: "Fuji",
    });
    const conflictSibling = structuredClone(conflict);
    conflictSibling.id.path = "IFD1";
    conflictSibling.id.copy = 1;
    conflictSibling.value = { kind: "Text", value: "Sony" };
    store.set("c.jpg", [conflict, conflictSibling]);

    const files = ["c.jpg", "a.jpg", "b.jpg"].map((relative_path) =>
      makeFile({ relative_path }),
    );
    const ascending = sortFiles(
      files,
      {
        primary: imageSortKey("IFD0:Model", "asc"),
        secondary: null,
      },
      store,
    );
    const descending = sortFiles(
      files,
      {
        primary: imageSortKey("IFD0:Model", "desc"),
        secondary: null,
      },
      store,
    );

    expect(ascending.map((file) => file.relative_path)).toEqual([
      "b.jpg",
      "a.jpg",
      "c.jpg",
    ]);
    expect(descending.map((file) => file.relative_path)).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
    ]);
  });

  it("sorts absent schema index and index zero independently", () => {
    const absent = testId("IFD0:Model");
    const zero = { ...absent, index: 0 };
    const store = new ImageMetadataOccurrencesStore();
    store.set("absent.jpg", [
      occurrenceFromSchemaValue(absent, { kind: "Text", value: "A" }),
    ]);
    store.set("zero.jpg", [
      occurrenceFromSchemaValue(zero, { kind: "Text", value: "B" }),
    ]);
    const files = ["zero.jpg", "absent.jpg"].map((relative_path) =>
      makeFile({ relative_path }),
    );

    expect(
      sortFiles(
        files,
        {
          primary: { kind: "image", id: absent, direction: "asc" },
          secondary: null,
        },
        store,
      ).map((file) => file.relative_path),
    ).toEqual(["absent.jpg", "zero.jpg"]);
    expect(
      sortFiles(
        files,
        {
          primary: { kind: "image", id: zero, direction: "asc" },
          secondary: null,
        },
        store,
      ).map((file) => file.relative_path),
    ).toEqual(["zero.jpg", "absent.jpg"]);
  });
});
// ── FileList sort indicator UI tests ─────────────────────────────────────────

const mockFiles: FileInfo[] = [
  {
    relative_path: "b.jpg",
    filename: "b.jpg",
    media_kind: "image" as const,
    date_modified: 200,
    date_created: 200,
  },
  {
    relative_path: "a.jpg",
    filename: "a.jpg",
    media_kind: "image" as const,
    date_modified: 100,
    date_created: 100,
  },
];

function makeSortStores() {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataOccurrencesStore();
  mockFiles.forEach((p) => {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  });
  return { thumbnails, imageMetadata };
}

describe("FileList sort indicator", () => {
  it("shows no sort indicator by default", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(document.querySelector(".sort-indicator")).toBeNull();
  });

  it("shows primary sort indicator on sorted column", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        sortConfig={{
          primary: osSortKey("date_modified", "asc"),
          secondary: null,
        }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    const indicator = document.querySelector(".sort-indicator--primary");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("▲");
  });

  it("shows desc indicator when sort direction is desc", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        sortConfig={{
          primary: osSortKey("date_modified", "desc"),
          secondary: null,
        }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(
      document.querySelector(".sort-indicator--primary")?.textContent,
    ).toContain("▼");
  });

  it("calls onSortChange with ascending sort when a column header is clicked", async () => {
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={onSortChange}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    await userEvent.click(screen.getByText("Modified"));
    expect(onSortChange).toHaveBeenCalledWith({
      primary: osSortKey("date_modified", "asc"),
      secondary: null,
    });
  });

  it("calls onSortChange toggling to desc when the same sorted column is clicked again", async () => {
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        sortConfig={{
          primary: osSortKey("date_modified", "asc"),
          secondary: null,
        }}
        onSortChange={onSortChange}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    await userEvent.click(screen.getByText("Modified"));
    expect(onSortChange).toHaveBeenCalledWith({
      primary: osSortKey("date_modified", "desc"),
      secondary: null,
    });
  });

  it("shows secondary sort indicator on secondary sorted column", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
        ]}
        sortConfig={{
          primary: osSortKey("date_modified", "asc"),
          secondary: osSortKey("date_created", "desc"),
        }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(
      document.querySelector(".sort-indicator--primary")?.textContent,
    ).toContain("▲");
    expect(
      document.querySelector(".sort-indicator--secondary")?.textContent,
    ).toContain("▼");
  });
});

describe("FileList sortingDisabled", () => {
  const sortConfig: SortConfig = {
    primary: osSortKey("date_modified", "asc"),
    secondary: null,
  };

  it("hides ▲/▼ indicators when sortingDisabled is true", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        sortConfig={sortConfig}
        onSortChange={() => {}}
        sortingDisabled
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(document.querySelector(".sort-indicator--primary")).toBeNull();
    expect(document.querySelector(".sort-indicator--secondary")).toBeNull();
  });

  it("shows the indicators again once sortingDisabled flips back to false", () => {
    const { thumbnails, imageMetadata } = makeSortStores();
    const props = {
      files: mockFiles,
      thumbnails,
      imageMetadataOccurrences: imageMetadata,
      visibleColumns: [osCol("date_modified")],
      sortConfig,
      onSortChange: () => {},
      selectedIndex: null,
      onSelect: () => {},
      onShowInExplorer: () => {},
      onVisibilityChange: () => {},
      onFileOpen: () => {},
      targetDraftEdits: {},
    };
    const { rerender } = render(<FileList {...props} sortingDisabled />);
    expect(document.querySelector(".sort-indicator--primary")).toBeNull();

    rerender(<FileList {...props} sortingDisabled={false} />);
    expect(
      document.querySelector(".sort-indicator--primary")?.textContent,
    ).toContain("▲");
  });

  it("still honours header clicks while sortingDisabled (so users can change the sort)", async () => {
    // Regression: previously the click handler short-circuited on
    // sortingDisabled, which meant once the user landed in a suspended
    // state (image sort + metadata pending), they couldn't click an OS
    // column to switch to a sort that *would* apply.
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeSortStores();
    const imagePrimary: SortConfig = {
      primary: imageSortKey("IFD0:Model", "asc"),
      secondary: null,
    };
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          imgCol("IFD0:Model"),
        ]}
        sortConfig={imagePrimary}
        onSortChange={onSortChange}
        sortingDisabled
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    await userEvent.click(screen.getByText("Modified"));
    expect(onSortChange).toHaveBeenCalledWith({
      primary: osSortKey("date_modified", "asc"),
      secondary: imageSortKey("IFD0:Model", "asc"),
    });
  });
});
