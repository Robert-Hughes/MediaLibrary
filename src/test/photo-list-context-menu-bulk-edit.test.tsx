import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileListContextMenu } from "../components/FileListContextMenu";
import { makeFiles } from "./factories";

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
});
