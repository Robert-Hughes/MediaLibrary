/**
 * Integration tests for Draft Metadata Editing
 */
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto } from "./factories";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: any) => mockApiInstance.api.invoke(cmd, args),
  convertFileSrc: (path: string) => `data:image/jpeg;base64,FAKE_${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (evt: string, handler: any) => mockApiInstance.api.listen(evt, (payload: any) => handler({ payload })),
}));

describe("Draft Metadata Editing Integration", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("can edit and discard draft metadata values via DetailsPane context menu", async () => {
    const user = userEvent.setup();

    // Given a folder with 1 photo
    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);

    // Wait for App to load
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    // Mock an explicit click to open folder
    const openBtn = screen.getByTestId("open-folder-btn");
    await user.click(openBtn);

    const photo = makePhoto({ relative_path: "test.jpg" });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo);
    });

    // We also need some metadata so we have a column to edit
    const metadata = { "IFD0:Make": "Canon" };
    await act(async () => {
      mockApiInstance.emitImageMetadataReady(photo.relative_path, metadata);
    });

    // Wait for debounce and state
    await act(async () => {
      await new Promise(r => setTimeout(r, 250));
    });

    // Open column dialog and enable IFD0:Make column
    const columnsBtn = screen.getByTestId("menu-bar-columns-btn");
    await user.click(columnsBtn);
    const cb = screen.getByLabelText(/IFD0:Make/);
    await user.click(cb);
    await user.click(screen.getByText("Save Changes"));

    // Ensure list view renders the metadata
    const rows = screen.getAllByTestId("photo-row");
    expect(rows[0]).toHaveTextContent("Canon");

    // Double click to open gallery
    await user.dblClick(rows[0]);
    
    // Open info pane
    await user.click(screen.getByTestId("gallery-info-toggle"));

    // Find "Canon" in details pane
    const ifd0Section = screen.getByTestId("details-section-IFD0");
    const canonCell = within(ifd0Section).getByTitle("Canon");

    // Right click Canon to edit
    await user.pointer({ keys: "[MouseRight]", target: canonCell });

    // Click "Edit" in context menu
    await user.click(screen.getByText("Edit"));

    // Edit dialog appears
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Sony");
    await user.click(screen.getByText("Save"));

    // Details pane should now show Sony as draft (bold)
    // The strong tag has class "draft-new"
    const draftNewSpanInDetails = within(ifd0Section).getByText("Sony");
    const draftNewInDetails = draftNewSpanInDetails.closest("strong")!;
    expect(draftNewInDetails).toBeInTheDocument();
    expect(draftNewInDetails).toHaveClass("draft-new");

    // Close gallery
    await user.click(screen.getByTestId("gallery-close-btn"));

    // Check list view
    const newRows = screen.getAllByTestId("photo-row");
    // List view should also show "Sony" in a bold draft element
    const draftNewSpanInList = within(newRows[0]).getByText("Sony");
    const draftNewInList = draftNewSpanInList.closest("strong")!;
    expect(draftNewInList).toBeInTheDocument();
    expect(draftNewInList).toHaveClass("draft-new");

    // Open gallery again
    await user.dblClick(newRows[0]);
    await user.click(screen.getByTestId("gallery-info-toggle"));

    // Right click Sony to discard
    const newSonyCell = within(screen.getByTestId("details-section-IFD0")).getAllByRole("cell")[1];
    await user.pointer({ keys: "[MouseRight]", target: newSonyCell });
    
    // Click "Discard"
    await user.click(screen.getByText("Discard"));

    // Details pane should show Canon again, no draft
    expect(within(screen.getByTestId("details-section-IFD0")).getByTitle("Canon")).toBeInTheDocument();
    expect(screen.queryByText("Sony")).toBeNull();

    // Close gallery and verify list view
    await user.click(screen.getByTestId("gallery-close-btn"));
    const finalRows = screen.getAllByTestId("photo-row");
    expect(within(finalRows[0]).getByText("Canon")).toBeInTheDocument();
    expect(screen.queryByText("Sony")).toBeNull();
  });
});
