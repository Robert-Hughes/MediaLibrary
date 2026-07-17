import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PhotoInfo, VisibleColumn } from "../types";
import {
  ImageMetadataOccurrencesStore,
  ThumbnailStore,
  type MetadataDraftTarget,
} from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import { makePhotos } from "./factories";

const rowObservations = vi.hoisted(() => ({
  renderCounts: new Map<string, number>(),
  draftReferences: new Map<string, TargetDraftCollection[]>(),
}));

vi.mock("../components/PhotoRow", async () => {
  const React = await import("react");

  interface ObservedPhotoRowProps {
    photo: PhotoInfo;
    targetDraftEdits: TargetDraftCollection;
  }

  const ObservedPhotoRow = React.memo(function ObservedPhotoRow({
    photo,
    targetDraftEdits,
  }: ObservedPhotoRowProps) {
    const path = photo.relative_path;
    rowObservations.renderCounts.set(
      path,
      (rowObservations.renderCounts.get(path) ?? 0) + 1,
    );
    const references = rowObservations.draftReferences.get(path) ?? [];
    references.push(targetDraftEdits);
    rowObservations.draftReferences.set(path, references);

    return React.createElement(
      "div",
      { "data-testid": `photo-row-${path}` },
      Object.keys(targetDraftEdits).length > 0
        ? React.createElement(
            "span",
            { "data-testid": `draft-badge-${path}` },
            "Draft",
          )
        : null,
    );
  });

  return { PhotoRow: ObservedPhotoRow };
});

import { PhotoList } from "../components/PhotoList";

const photos: PhotoInfo[] = makePhotos(["one.jpg", "two.jpg"]);
const thumbnails = new ThumbnailStore();
const imageMetadataOccurrences = new ImageMetadataOccurrencesStore();
const visibleColumns: VisibleColumn[] = [];
const sortConfig = { primary: null, secondary: null } as const;
const onSortChange = vi.fn();
const onSelect = vi.fn();
const onShowInExplorer = vi.fn();
const onVisibilityChange = vi.fn();
const onPhotoOpen = vi.fn();

function photoList(
  targetDraftEdits: Record<string, TargetDraftCollection>,
  sortingDisabled = false,
) {
  return (
    <PhotoList
      photos={photos}
      thumbnails={thumbnails}
      imageMetadataOccurrences={imageMetadataOccurrences}
      targetDraftEdits={targetDraftEdits}
      visibleColumns={visibleColumns}
      sortConfig={sortConfig}
      onSortChange={onSortChange}
      selectedIndex={null}
      onSelect={onSelect}
      onShowInExplorer={onShowInExplorer}
      onVisibilityChange={onVisibilityChange}
      onPhotoOpen={onPhotoOpen}
      sortingDisabled={sortingDisabled}
    />
  );
}
function latestDraftReference(path: string): TargetDraftCollection {
  const references = rowObservations.draftReferences.get(path);
  if (!references || references.length === 0) {
    throw new Error(`No PhotoRow draft reference observed for '${path}'`);
  }
  return references[references.length - 1];
}

describe("PhotoList draft-free row memoisation", () => {
  it("reuses one empty fallback while preserving real target collections", () => {
    rowObservations.renderCounts.clear();
    rowObservations.draftReferences.clear();

    const { rerender } = render(photoList({}));

    const initialOneRenders = rowObservations.renderCounts.get("one.jpg") ?? 0;
    const initialTwoRenders = rowObservations.renderCounts.get("two.jpg") ?? 0;
    expect(initialOneRenders).toBeGreaterThan(0);
    expect(initialTwoRenders).toBeGreaterThan(0);

    const stableEmptyReference = latestDraftReference("one.jpg");
    expect(latestDraftReference("two.jpg")).toBe(stableEmptyReference);

    rerender(photoList({}, true));

    expect(rowObservations.renderCounts.get("one.jpg")).toBe(initialOneRenders);
    expect(rowObservations.renderCounts.get("two.jpg")).toBe(initialTwoRenders);

    const target: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: { table: "XMP::Main", tag_id: "title" },
    };
    const realCollection: TargetDraftCollection = {
      [metadataDraftTargetSlotToken(target)]: {
        target,
        edit: {
          intent: "Set",
          value: { kind: "Text", value: "Draft title" },
        },
      },
    };

    rerender(photoList({ "one.jpg": realCollection }, true));

    expect(rowObservations.renderCounts.get("one.jpg")).toBe(
      initialOneRenders + 1,
    );
    expect(rowObservations.renderCounts.get("two.jpg")).toBe(initialTwoRenders);
    expect(latestDraftReference("one.jpg")).toBe(realCollection);
    expect(screen.getByTestId("draft-badge-one.jpg")).toHaveTextContent(
      "Draft",
    );

    rerender(photoList({}, true));

    expect(rowObservations.renderCounts.get("one.jpg")).toBe(
      initialOneRenders + 2,
    );
    expect(rowObservations.renderCounts.get("two.jpg")).toBe(initialTwoRenders);
    expect(latestDraftReference("one.jpg")).toBe(stableEmptyReference);
    expect(screen.queryByTestId("draft-badge-one.jpg")).not.toBeInTheDocument();
  });
});
