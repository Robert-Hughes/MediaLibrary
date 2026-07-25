import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { FileList } from "../components/FileList";
import { imgCol, testId } from "./factories";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import type { FileInfo } from "../types";

const mockFiles: FileInfo[] = [
  {
    relative_path: "a.jpg",
    filename: "a.jpg",
    date_modified: 100,
    date_created: 100,
  },
];

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

function makeStores() {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataOccurrencesStore();
  mockFiles.forEach((p) => {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  });
  return { thumbnails, imageMetadata };
}

describe("column resize handles", () => {
  it("renders a resize handle for the Preview column", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(
      document.querySelector('[data-testid="resize-handle-preview"]'),
    ).not.toBeNull();
  });

  it("renders a resize handle for the Path column", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(
      document.querySelector('[data-testid="resize-handle-relative_path"]'),
    ).not.toBeNull();
  });

  it("renders resize handles for OS metadata columns", () => {
    const { thumbnails, imageMetadata } = makeStores();
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
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(
      document.querySelector('[data-testid="resize-handle-date_modified"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="resize-handle-date_created"]'),
    ).not.toBeNull();
  });

  it("renders resize handle for image metadata columns", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[imgCol("IFD0:Model")]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(
      document.querySelector(
        `[data-testid='resize-handle-${schemaDefinitionIdToken(testId("IFD0:Model"))}']`,
      ),
    ).not.toBeNull();
  });

  it("calls onColumnWidthChange when a resize drag completes", () => {
    const onColumnWidthChange = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        columnWidths={{}}
        onColumnWidthChange={onColumnWidthChange}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );

    const handle = document.querySelector(
      '[data-testid="resize-handle-date_modified"]',
    )!;

    // Simulate a drag: pointerdown at x=200, pointermove to x=250 (50px wider), pointerup
    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 250, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 250, pointerId: 1 });

    expect(onColumnWidthChange).toHaveBeenCalledWith(
      "date_modified",
      expect.any(Number),
    );
  });

  it("calls onColumnWidthChange for preview when its resize drag completes", () => {
    const onColumnWidthChange = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        columnWidths={{ preview: 52 }}
        onColumnWidthChange={onColumnWidthChange}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );

    const handle = document.querySelector(
      '[data-testid="resize-handle-preview"]',
    )!;
    vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 52,
    } as DOMRect);
    fireEvent.pointerDown(handle, { clientX: 52, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 82, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 82, pointerId: 1 });

    expect(onColumnWidthChange).toHaveBeenCalledWith("preview", 82);
  });

  it("auto-sizes from intrinsic content and does not grow on repeated double-clicks", () => {
    const onColumnWidthChange = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
    let selectedRangeNode: Node | null = null;
    const range = {
      selectNodeContents: vi.fn((node: Node) => {
        selectedRangeNode = node;
      }),
      setStart: vi.fn((node: Node) => {
        selectedRangeNode = node;
      }),
      setEndBefore: vi.fn(),
      getBoundingClientRect: vi.fn(() => {
        const el = selectedRangeNode as HTMLElement | null;
        if (el?.classList?.contains("grid-header-kind"))
          return { width: 12 } as DOMRect;
        if (el?.classList?.contains("grid-header-label"))
          return { width: 44 } as DOMRect;
        if (el?.dataset?.col === "date_modified")
          return { width: 80 } as DOMRect;
        return { width: 300 } as DOMRect;
      }),
    } as unknown as Range;
    const createRangeSpy = vi
      .spyOn(document, "createRange")
      .mockReturnValue(range);
    const getComputedStyleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({
        paddingLeft: "8px",
        paddingRight: "8px",
      } as CSSStyleDeclaration);

    function StatefulFileList() {
      const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
        date_modified: 300,
      });
      return (
        <FileList
          targetDraftEdits={{}}
          files={mockFiles}
          thumbnails={thumbnails}
          imageMetadataOccurrences={imageMetadata}
          visibleColumns={[{ key: "date_modified", kind: "os" }]}
          columnWidths={columnWidths}
          onColumnWidthChange={(col, width) => {
            onColumnWidthChange(col, width);
            setColumnWidths({ [col]: width });
          }}
          {...defaultSortProps}
          selectedIndex={null}
          onSelect={() => {}}
          onShowInExplorer={() => {}}
          onVisibilityChange={() => {}}
          onFileOpen={() => {}}
        />
      );
    }

    render(<StatefulFileList />);

    const handle = document.querySelector(
      '[data-testid="resize-handle-date_modified"]',
    )!;
    fireEvent.dblClick(handle);
    fireEvent.dblClick(handle);

    expect(onColumnWidthChange).toHaveBeenNthCalledWith(
      1,
      "date_modified",
      100,
    );
    expect(onColumnWidthChange).toHaveBeenNthCalledWith(
      2,
      "date_modified",
      100,
    );
    expect(range.selectNodeContents).toHaveBeenCalledWith(
      expect.objectContaining({
        className: expect.stringContaining("grid-header-label"),
      }),
    );

    createRangeSpy.mockRestore();
    getComputedStyleSpy.mockRestore();
  });

  it("clicking resize handle does not trigger column sort", () => {
    const onSortChange = vi.fn();
    const { thumbnails, imageMetadata } = makeStores();
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

    const handle = document.querySelector(
      '[data-testid="resize-handle-date_modified"]',
    )!;
    fireEvent.click(handle);

    expect(onSortChange).not.toHaveBeenCalled();
  });

  it("renders resize handles on empty-state (zero files) headers too", () => {
    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataOccurrencesStore();
    render(
      <FileList
        targetDraftEdits={{}}
        files={[]}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    expect(
      document.querySelector('[data-testid="resize-handle-preview"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="resize-handle-relative_path"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="resize-handle-date_modified"]'),
    ).not.toBeNull();
  });
});

describe("buildGridTemplate (via rendered styles)", () => {
  it("applies saved column widths as pixel values in grid template", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        columnWidths={{ preview: 84, relative_path: 350, date_modified: 140 }}
        onColumnWidthChange={() => {}}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    const grid = document.querySelector(".file-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("84px");
    expect(grid.style.gridTemplateColumns).toContain("350px");
    expect(grid.style.gridTemplateColumns).toContain("140px");
  });

  it("scales row and thumbnail height from preview column width using 4:3", () => {
    const { thumbnails, imageMetadata } = makeStores();
    const files = [
      mockFiles[0],
      { ...mockFiles[0], relative_path: "b.jpg", filename: "b.jpg" },
    ];
    thumbnails.add("b.jpg");
    imageMetadata.add("b.jpg");

    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        columnWidths={{ preview: 84 }}
        onColumnWidthChange={() => {}}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );

    // CSS custom properties are the authoritative contract between FileList
    // and its CSS.  Exact translateY offsets and body height are internal to
    // the TanStack virtualizer (which can't measure real DOM in JSDOM) so we
    // don't assert on those.
    const grid = document.querySelector(".file-grid") as HTMLElement;
    expect(grid.style.getPropertyValue("--row-height")).toBe("65px");
    expect(grid.style.getPropertyValue("--thumb-height")).toBe("57px");
  });

  it("uses minmax defaults when no column widths are provided", () => {
    const { thumbnails, imageMetadata } = makeStores();
    render(
      <FileList
        targetDraftEdits={{}}
        files={mockFiles}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    const grid = document.querySelector(".file-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("minmax(");
  });
});
