import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  imgCol,
  mockMetadata,
  mockTargetDraftsByFile,
  newPropertyTargetDraft,
  testId,
} from "./factories";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { FileList } from "../components/FileList";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";
import type { MetadataTargetDraftEntry, MetadataOccurrence } from "../types";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

import {
  occurrenceFromSchemaValue,
  occurrencesFromMetadataCollection,
} from "./occurrenceFixtures";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

function renderTargetDraftRow(
  occurrences: MetadataOccurrence[] | "loading",
  entries: MetadataTargetDraftEntry[],
) {
  const thumbnails = new ThumbnailStore();
  const metadata = new FileMetadataOccurrencesStore();
  thumbnails.set("1.jpg", "base64string");
  if (occurrences === "loading") metadata.add("1.jpg");
  else metadata.set("1.jpg", occurrences);

  render(
    <FileList
      targetDraftEdits={mockTargetDraftsByFile({ "1.jpg": entries })}
      files={[
        {
          relative_path: "1.jpg",
          filename: "1.jpg",
          media_kind: "image" as const,
          date_modified: null,
          date_created: null,
        },
      ]}
      thumbnails={thumbnails}
      fileMetadataOccurrences={metadata}
      visibleColumns={[imgCol("IFD0:Model")]}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedPath={null}
      onSelect={vi.fn()}
      onShowInExplorer={vi.fn()}
      onVisibilityChange={vi.fn()}
      onFileOpen={vi.fn()}
    />,
  );
}

describe("FileRow", () => {
  beforeEach(() => {
    _clearTagInfoCache();
    _setTagInfoCacheEntry("IFD0:Model", null);
    _setTagInfoCacheEntry("ExifIFD:DateTimeOriginal", null);
  });

  it("shows a metadata error icon instead of a loading spinner after failure", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();
    thumbnails.set("1.jpg", "base64string");
    metadata.add("1.jpg");
    metadata.setFailed("1.jpg", "File is empty");

    render(
      <FileList
        targetDraftEdits={{}}
        files={[
          {
            relative_path: "1.jpg",
            filename: "1.jpg",
            media_kind: "image" as const,
            date_modified: null,
            date_created: null,
          },
        ]}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[imgCol("IFD0:Model")]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("metadata-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("metadata-error")).toHaveAttribute(
      "title",
      "File is empty",
    );
  });

  it("renders FileList with files without crashing", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();

    // add some metadata
    thumbnails.set("1.jpg", "base64string");
    metadata.set(
      "1.jpg",
      occurrencesFromMetadataCollection(mockMetadata({ Model: "Nikon" })),
    );

    const files = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        media_kind: "image" as const,
        date_modified: null,
        date_created: null,
      },
    ];

    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("ExifIFD:DateTimeOriginal"),
          imgCol("IFD0:Model"),
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );
  });

  it("fits thumbnail images without cropping", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", []);

    render(
      <FileList
        targetDraftEdits={{}}
        files={[
          {
            relative_path: "1.jpg",
            filename: "1.jpg",
            media_kind: "image" as const,
            date_modified: null,
            date_created: null,
          },
        ]}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
      />,
    );

    expect(document.querySelector(".file-thumb-img")).not.toBeNull();
  });

  it("rows read gridTemplateColumns from a CSS custom property, not from props", () => {
    // Regression: gridColumns used to be a per-render string passed to every
    // memoised FileRow.  A column-resize drag (which fires setLiveWidths on
    // every pointermove) would change that string and re-render every visible
    // row.  The fix is to set --grid-columns on a parent and have rows read it
    // via var(--grid-columns) — a constant string that never changes per render.
    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();
    const files = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        media_kind: "image" as const,
        date_modified: null,
        date_created: null,
      },
    ];
    thumbnails.add("1.jpg");
    metadata.add("1.jpg");

    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          imgCol("IFD0:Model"),
        ]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    const row = screen.getByTestId("file-row") as HTMLElement;
    expect(row.style.gridTemplateColumns).toBe("var(--grid-columns)");

    // The grid container exposes the variable so descendants can resolve it.
    const grid = screen.getByTestId("file-list");
    expect(grid.style.getPropertyValue("--grid-columns")).not.toBe("");
  });

  it("displays em dash — for missing metadata and not mojibake â€”", () => {
    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();

    // We add metadata as empty object, so "IFD0:Model" will be missing/undefined.
    thumbnails.set("1.jpg", "base64string");
    metadata.set("1.jpg", []);

    const files = [
      {
        relative_path: "1.jpg",
        filename: "1.jpg",
        media_kind: "image" as const,
        date_modified: null,
        date_created: null,
      },
    ];

    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[imgCol("IFD0:Model")]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    expect(screen.queryByText("—")).not.toBeNull();
    expect(screen.queryByText("â€”")).toBeNull();
  });

  it("displays schema-backed enum labels for image metadata columns", () => {
    _setTagInfoCacheEntry("IFD0:Orientation", {
      group: "IFD0",
      name: "Orientation",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "Integer",
          options: [{ code: "6", label: "Rotate 90 CW" }],
        },
      },
      description: null,
    });

    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();
    thumbnails.set("1.jpg", "base64string");
    metadata.set(
      "1.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({ "IFD0:Orientation": 6 }),
      ),
    );

    render(
      <FileList
        targetDraftEdits={{}}
        files={[
          {
            relative_path: "1.jpg",
            filename: "1.jpg",
            media_kind: "image" as const,
            date_modified: null,
            date_created: null,
          },
        ]}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[imgCol("IFD0:Orientation")]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    const cell = document.querySelector(
      `[data-col='${schemaDefinitionIdToken(testId("IFD0:Orientation"))}']`,
    );
    expect(cell).not.toBeNull();
    expect(within(cell as HTMLElement).getByText("Rotate 90 CW")).toBeTruthy();
    expect(within(cell as HTMLElement).queryByText("6")).toBeNull();
  });

  it("falls back to generic image metadata display when schema is missing", () => {
    _setTagInfoCacheEntry("IFD0:Orientation", null);

    const thumbnails = new ThumbnailStore();
    const metadata = new FileMetadataOccurrencesStore();
    thumbnails.set("1.jpg", "base64string");
    metadata.set(
      "1.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({ "IFD0:Orientation": 6 }),
      ),
    );

    render(
      <FileList
        targetDraftEdits={{}}
        files={[
          {
            relative_path: "1.jpg",
            filename: "1.jpg",
            media_kind: "image" as const,
            date_modified: null,
            date_created: null,
          },
        ]}
        thumbnails={thumbnails}
        fileMetadataOccurrences={metadata}
        visibleColumns={[imgCol("IFD0:Orientation")]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={vi.fn()}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={vi.fn()}
        onSelectColumns={vi.fn()}
      />,
    );

    const cell = document.querySelector(
      `[data-col='${schemaDefinitionIdToken(testId("IFD0:Orientation"))}']`,
    );
    expect(cell).not.toBeNull();
    expect(within(cell as HTMLElement).getByText("6")).toBeTruthy();
    expect(within(cell as HTMLElement).queryByText("Rotate 90 CW")).toBeNull();
  });

  it("renders no staged value for an empty exact-target collection", () => {
    renderTargetDraftRow([], []);
    expect(screen.queryByText(/draft edit/)).toBeNull();
    expect(document.querySelector(".draft-new")).toBeNull();
  });

  it("renders a valid NewProperty target on an absent schema row", () => {
    renderTargetDraftRow(
      [],
      [
        newPropertyTargetDraft("IFD0:Model", {
          intent: "Set",
          value: { kind: "Text", value: "Canon R5" },
        }),
      ],
    );
    expect(screen.getByText("Canon R5")).toBeInTheDocument();
    expect(screen.getByText("1 draft edit")).toBeInTheDocument();
  });

  it("renders a valid ExistingOccurrence target on its ordinary row", () => {
    const occurrence = occurrenceFromSchemaValue(testId("IFD0:Model"), {
      kind: "Text",
      value: "Nikon Z8",
    });
    const resolved = existingOccurrenceTargetFromOccurrence(occurrence);
    if (resolved.kind !== "targetable") {
      throw new Error("Expected targetable occurrence fixture");
    }
    renderTargetDraftRow(
      [occurrence],
      [
        {
          target: resolved.target,
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "Canon R5" },
          },
        },
      ],
    );
    expect(screen.getByText("Nikon Z8")).toBeInTheDocument();
    expect(screen.getByText("Canon R5")).toBeInTheDocument();
  });

  it("does not render a stale ExistingOccurrence target", () => {
    const occurrence = occurrenceFromSchemaValue(testId("IFD0:Model"), {
      kind: "Text",
      value: "Nikon Z8",
    });
    const resolved = existingOccurrenceTargetFromOccurrence(occurrence);
    if (resolved.kind !== "targetable") {
      throw new Error("Expected targetable occurrence fixture");
    }
    renderTargetDraftRow(
      [occurrence],
      [
        {
          target: {
            ...resolved.target,
            write_target: { ...resolved.target.write_target, group1: "IFD1" },
          },
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "Canon R5" },
          },
        },
      ],
    );
    expect(screen.getByText("Nikon Z8")).toBeInTheDocument();
    expect(screen.queryByText("Canon R5")).toBeNull();
  });

  it("does not render target drafts while occurrences are loading", () => {
    renderTargetDraftRow("loading", [
      newPropertyTargetDraft("IFD0:Model", {
        intent: "Set",
        value: { kind: "Text", value: "Canon R5" },
      }),
    ]);
    expect(screen.getByTestId("metadata-loading")).toBeInTheDocument();
    expect(screen.queryByText("Canon R5")).toBeNull();
  });
});
