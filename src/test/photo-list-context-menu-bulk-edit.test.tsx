import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PhotoListContextMenu } from "../components/PhotoListContextMenu";
import { makePhotos } from "./factories";

describe("PhotoListContextMenu bulk metadata entry", () => {
  it("passes the immutable effective selection to Bulk Edit", async () => {
    const onBulkEdit = vi.fn();
    render(
      <PhotoListContextMenu
        x={10}
        y={10}
        contextMenuIndex={1}
        selectedIndices={new Set([0, 2])}
        photos={makePhotos(["one.jpg", "two.jpg", "three.jpg"])}
        targetDraftEdits={{}}
        onPhotoOpen={vi.fn()}
        onShowInExplorer={vi.fn()}
        onBulkEdit={onBulkEdit}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText("Bulk Edit (2 photos)..."));

    expect(onBulkEdit).toHaveBeenCalledWith(["one.jpg", "three.jpg"]);
  });
});
