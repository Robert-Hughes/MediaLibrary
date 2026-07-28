import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileListContextMenu } from "../components/FileListContextMenu";
import { makeFiles, newPropertyTargetDraft } from "./factories";
import { FileMetadataOccurrencesStore } from "../types";

describe("FileListContextMenu bulk metadata entry", () => {
  it("passes the immutable effective selection to Bulk Edit", async () => {
    const onBulkEdit = vi.fn();
    render(
      <FileListContextMenu
        x={10}
        y={10}
        contextMenuIndex={1}
        selectedIndices={new Set([0, 2])}
        files={makeFiles(["one.jpg", "two.jpg", "three.jpg"])}
        targetDraftEdits={{}}
        onFileOpen={vi.fn()}
        onShowInExplorer={vi.fn()}
        onBulkEdit={onBulkEdit}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText("Bulk Edit (2 files)..."));

    expect(onBulkEdit).toHaveBeenCalledWith(["one.jpg", "three.jpg"]);
  });
  it("disables metadata-dependent actions when any selected file failed metadata loading", () => {
    const metadata = new FileMetadataOccurrencesStore();
    metadata.set("one.jpg", []);
    metadata.setFailed("two.jpg", "ExifTool could not read the file");

    render(
      <FileListContextMenu
        x={10}
        y={10}
        contextMenuIndex={0}
        selectedIndices={new Set([0, 1])}
        files={makeFiles(["one.jpg", "two.jpg"])}
        fileMetadataOccurrences={metadata}
        targetDraftEdits={{
          "one.jpg": {
            draft: newPropertyTargetDraft("Subject", "draft value"),
          },
        }}
        onFileOpen={vi.fn()}
        onShowInExplorer={vi.fn()}
        onCopyPaths={vi.fn()}
        onBulkEdit={vi.fn()}
        onShowOnMap={vi.fn()}
        onGenerateAiDescription={vi.fn()}
        onGeocode={vi.fn()}
        onNormalise={vi.fn()}
        onApplyEdits={vi.fn()}
        onDiscardAllEdits={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    for (const name of [
      /Bulk Edit/,
      /Show on Map/,
      /Generate AI Description/,
      /Reverse Geocode/,
      /Normalise Metadata/,
      /Apply edits/,
    ]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: /Copy Paths/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Discard all edits/ })).toBeEnabled();
  });

});
