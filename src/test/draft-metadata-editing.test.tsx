/**
 * Integration tests for Draft Metadata Editing
 */
import {
  render,
  screen,
  act,
  within,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto } from "./factories";
import { _clearTagInfoCache, _setTagInfoCacheEntry } from "../hooks/useTagInfo";
import {
  _resetWritableSchemaDefinitionsCache,
  _setWritableSchemaDefinitionsCache,
} from "../hooks/useWritableSchemaDefinitions";
import { testIdForFriendlyName } from "./testIds";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import type { MetadataOccurrence } from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

function makeOccurrence(value = "Canon"): MetadataOccurrence {
  const id = testIdForFriendlyName("IFD0:Make");
  return {
    id: {
      document: null,
      path: "JPEG-APP1-IFD0",
      runtime_tag_id: "Make",
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: "Make",
        index: null,
      },
      copy: 0,
    },
    schema_id: structuredClone(id),
    value: { kind: "Text", value },
    tag_info: {
      id,
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    },
    observed_selector: {
      group1: "IFD0",
      group7: "ID-Test",
      tag_name: "Make",
    },
    write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "Make" },
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    mockApiInstance.api.invoke(cmd, args),
  convertFileSrc: (path: string) => `data:image/jpeg;base64,FAKE_${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (evt: string, handler: (event: { payload: unknown }) => void) =>
    mockApiInstance.api.listen(evt, (payload: unknown) => handler({ payload })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

describe("Draft Metadata Editing Integration", () => {
  beforeEach(() => {
    mockApiInstance = createMockTauriApi();
    // In production the schema cache is populated at startup via a
    // blocking modal, so by the time the user opens any editor the
    // useTagInfo cache is already warm. Mirror that here: pre-seed the
    // keys these tests touch so editors render synchronously and the
    // suite doesn't drift past the 5s timeout on slower machines.
    const makeId = testIdForFriendlyName("IFD0:Make");
    const descriptionId = testIdForFriendlyName("XMP-dc:Description");
    _setTagInfoCacheEntry(makeId, {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    _setTagInfoCacheEntry(descriptionId, {
      group: "XMP-dc",
      name: "Description",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const descriptionInfo = {
      id: descriptionId,
      group: "XMP-dc",
      name: "Description",
      writable: true,
      kind: { kind: "Text" as const },
      description: "Description",
    };
    mockApiInstance.tagInfos = [descriptionInfo];
    _setWritableSchemaDefinitionsCache([descriptionInfo]);
  });

  afterEach(() => {
    _clearTagInfoCache();
    _resetWritableSchemaDefinitionsCache();
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
      await new Promise((r) => setTimeout(r, 50));
    });

    // Mock an explicit click to open folder
    const openBtn = screen.getByTestId("open-folder-btn");
    await user.click(openBtn);

    const photo = makePhoto({ relative_path: "test.jpg" });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo);
    });

    // We also need some metadata so we have a column to edit
    const metadata = { "IFD0:Make": { kind: "Text", value: "Canon" } } as const;
    await act(async () => {
      mockApiInstance.emitImageMetadataReady(
        photo.relative_path,
        metadata,
        undefined,
        [makeOccurrence()],
      );
    });

    // Wait for debounce and state
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
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
    await user.click(screen.getByText("Edit…"));

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

    // Click the draft badge in DetailsPane to filter to has:edits
    const detailsBadge = screen.getByTitle("Show only edited fields");
    await user.click(detailsBadge);

    // Details search input should have has:edits
    expect(screen.getByTestId("details-search-input")).toHaveValue("has:edits");

    // We should still see "IFD0:Make" but NOT "OS Metadata" (since OS metadata cannot be edited, so it has no edits)
    expect(screen.getByTestId("details-section-IFD0")).toBeInTheDocument();
    expect(screen.queryByTestId("details-section-os")).toBeNull();

    // Clear details search
    await user.clear(screen.getByTestId("details-search-input"));
    expect(screen.getByTestId("details-section-os")).toBeInTheDocument();

    // Close gallery
    await user.click(screen.getByTestId("gallery-close-btn"));

    // Check list view
    const newRows = screen.getAllByTestId("photo-row");
    // The list summary counts the exact target draft. Existing target values
    // are presented on their concrete Details Pane row, not schema-overlaid
    // into the compatibility list column.
    expect(within(newRows[0]).getByTitle("1 pending edit(s)")).toBeVisible();

    // Open gallery again.  GalleryView persists the info-toggle state to
    // localStorage so reopening restores details=visible without a second
    // click — mimicking the user behaviour the production app delivers.
    await user.dblClick(newRows[0]);

    // Click "Discard All" button at the top of the details pane
    const discardAllBtn = screen.getByTitle("Discard all edits for this photo");
    await user.click(discardAllBtn);

    // Details pane should show Canon again, no draft
    expect(
      within(screen.getByTestId("details-section-IFD0")).getByTitle("Canon"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sony")).toBeNull();

    // Close gallery and verify list view
    await user.click(screen.getByTestId("gallery-close-btn"));
    const finalRows = screen.getAllByTestId("photo-row");
    expect(within(finalRows[0]).getByText("Canon")).toBeInTheDocument();
    expect(screen.queryByText("Sony")).toBeNull();
  });

  it("removing a newly-added property drops the draft instead of leaving a delete-draft", async () => {
    const user = userEvent.setup();

    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await user.click(screen.getByTestId("open-folder-btn"));

    const photo = makePhoto({ relative_path: "test.jpg" });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo);
    });

    const metadata = { "IFD0:Make": { kind: "Text", value: "Canon" } } as const;
    await act(async () => {
      mockApiInstance.emitImageMetadataReady(
        photo.relative_path,
        metadata,
        undefined,
        [makeOccurrence()],
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    // Open gallery + info pane
    const rows = screen.getAllByTestId("photo-row");
    await user.dblClick(rows[0]);
    await user.click(screen.getByTestId("gallery-info-toggle"));

    // Click "+ Add Property" → stage 1 (key picker)
    await user.click(screen.getByText("+ Add Property…"));

    // Pick the key and advance to stage 2
    await user.type(
      screen.getByTestId("new-property-key"),
      "XMP-dc:Description",
    );
    await user.click(
      screen.getByTestId(
        `schema-option-${schemaDefinitionIdToken(testIdForFriendlyName("XMP-dc:Description"))}`,
      ),
    );
    await user.click(screen.getByTestId("new-property-next"));

    // Stage 2: TypedValueEditor for this key (Unknown → ValueEditDialog
    // fallback because the seeded cache entry is null).  Fill the value
    // and save.
    await user.type(screen.getByTestId("value-edit-input"), "Hello");
    await user.click(screen.getByTestId("value-edit-save"));

    // Draft badge present: 1 edit on this photo
    await waitFor(() => {
      expect(screen.getByTitle("Show only edited fields")).toBeInTheDocument();
    });

    // The new property row should now appear under XMP-dc
    const xmpSection = screen.getByTestId("details-section-XMP-dc");
    const newRow = within(xmpSection).getByText("Hello").closest("tr")!;
    expect(newRow).toBeInTheDocument();

    // Right-click the new row → Remove
    await user.pointer({ keys: "[MouseRight]", target: newRow });
    await user.click(screen.getByText("Remove"));

    // No draft should remain — badge gone, Apply gone, Discard All gone,
    // and the row itself should no longer be rendered.
    expect(screen.queryByTitle("Show only edited fields")).toBeNull();
    expect(screen.queryByTestId("details-pane-apply-btn")).toBeNull();
    expect(screen.queryByTitle("Discard all edits for this photo")).toBeNull();
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("can filter list view to has:edits via badge and discard all edits from context menu", async () => {
    const user = userEvent.setup();

    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);

    // Wait for App to load
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Open folder
    await user.click(screen.getByTestId("open-folder-btn"));

    // Emit two photos
    const photo1 = makePhoto({ relative_path: "edited.jpg" });
    const photo2 = makePhoto({ relative_path: "unedited.jpg" });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo1);
      mockApiInstance.emitPhotoFound(photo2);
    });

    const metadata = { "IFD0:Make": { kind: "Text", value: "Canon" } } as const;
    await act(async () => {
      mockApiInstance.emitImageMetadataReady(
        photo1.relative_path,
        metadata,
        undefined,
        [makeOccurrence()],
      );
      mockApiInstance.emitImageMetadataReady(
        photo2.relative_path,
        metadata,
        undefined,
        [makeOccurrence()],
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    let rows = screen.getAllByTestId("photo-row");
    expect(rows).toHaveLength(2);

    // Edit the first photo via gallery
    await user.dblClick(rows[0]);
    await user.click(screen.getByTestId("gallery-info-toggle"));

    const canonCell = within(
      screen.getByTestId("details-section-IFD0"),
    ).getByTitle("Canon");
    await user.pointer({ keys: "[MouseRight]", target: canonCell });
    await user.click(screen.getByText("Edit…"));

    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Sony");
    await user.click(screen.getByText("Save"));

    // Close gallery
    await user.click(screen.getByTestId("gallery-close-btn"));

    // Both rows still visible
    rows = screen.getAllByTestId("photo-row");
    expect(rows).toHaveLength(2);

    const draftBadge = screen.getByTitle("Show only photos with edits");
    await user.click(draftBadge);

    // List view should be filtered to just 1 photo.  Search runs off-thread
    // through the worker so the row count change is asynchronous.
    await waitFor(() => {
      const filtered = screen.getAllByTestId("photo-row");
      expect(filtered).toHaveLength(1);
    });
    rows = screen.getAllByTestId("photo-row");
    expect(within(rows[0]).getByText("edited.jpg")).toBeInTheDocument();

    // The search input should have "has:edits"
    expect(screen.getByTestId("list-search-input")).toHaveValue("has:edits");

    // Right click the row and discard all edits
    await user.pointer({ keys: "[MouseRight]", target: rows[0] });
    await user.click(screen.getByText("Discard all edits…"));

    // The list is now empty because no edits exist but filter is still has:edits
    await waitFor(() => {
      expect(screen.queryByTestId("photo-row")).toBeNull();
    });

    // Clear filter
    await user.clear(screen.getByTestId("list-search-input"));

    // Both rows back
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(2);
    });
  });

  it("can search for draft edited values in both list view and details pane", async () => {
    const user = userEvent.setup();

    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await user.click(screen.getByTestId("open-folder-btn"));

    const photo = makePhoto({ relative_path: "edited.jpg" });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo);
    });

    const metadata = { "IFD0:Make": { kind: "Text", value: "Canon" } } as const;
    await act(async () => {
      mockApiInstance.emitImageMetadataReady(
        photo.relative_path,
        metadata,
        undefined,
        [makeOccurrence()],
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    // Open gallery and edit value
    const rows = screen.getAllByTestId("photo-row");
    await user.dblClick(rows[0]);
    await user.click(screen.getByTestId("gallery-info-toggle"));

    const canonCell = within(
      screen.getByTestId("details-section-IFD0"),
    ).getByTitle("Canon");
    await user.pointer({ keys: "[MouseRight]", target: canonCell });
    await user.click(screen.getByText("Edit…"));

    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Nikon"); // new draft value
    await user.click(screen.getByText("Save"));

    // Verify Details table search matches "Nikon"
    const detailsSearch = screen.getByTestId("details-search-input");
    await user.clear(detailsSearch);
    await user.type(detailsSearch, "Nikon");

    // We should see IFD0 section
    expect(screen.getByTestId("details-section-IFD0")).toBeInTheDocument();
    expect(screen.queryByTestId("details-section-os")).toBeNull();

    // Close gallery
    await user.click(screen.getByTestId("gallery-close-btn"));

    // Verify List view search matches "Nikon"
    const listSearch = screen.getByTestId("list-search-input");
    await user.clear(listSearch);
    await user.type(listSearch, "Nikon");

    // The photo should still be visible because it matches.  Search is
    // off-thread, so the row count assertion needs to wait.
    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(1);
    });

    // If we search for something unrelated, it should disappear
    await user.clear(listSearch);
    await user.type(listSearch, "Panasonic");
    await waitFor(() => {
      expect(screen.queryByTestId("photo-row")).toBeNull();
    });
  });

  it("can discard all edits across all photos using the menu bar button", async () => {
    const user = userEvent.setup();

    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await user.click(screen.getByTestId("open-folder-btn"));

    const photo1 = makePhoto({ relative_path: "pic1.jpg" });
    const photo2 = makePhoto({ relative_path: "pic2.jpg" });
    await act(async () => {
      mockApiInstance.emitPhotoFound(photo1);
      mockApiInstance.emitPhotoFound(photo2);
    });

    const metadata = { "IFD0:Make": { kind: "Text", value: "Canon" } } as const;
    await act(async () => {
      mockApiInstance.emitImageMetadataReady(
        photo1.relative_path,
        metadata,
        undefined,
        [makeOccurrence()],
      );
      mockApiInstance.emitImageMetadataReady(
        photo2.relative_path,
        metadata,
        undefined,
        [makeOccurrence()],
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    let rows = screen.getAllByTestId("photo-row");

    // Edit first photo
    await user.dblClick(rows[0]);
    await user.click(screen.getByTestId("gallery-info-toggle"));
    let canonCell = within(
      screen.getByTestId("details-section-IFD0"),
    ).getByTitle("Canon");
    await user.pointer({ keys: "[MouseRight]", target: canonCell });
    await user.click(screen.getByText("Edit…"));
    let input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Nikon");
    await user.click(screen.getByText("Save"));
    await user.click(screen.getByTestId("gallery-close-btn"));

    // Edit second photo.  Same reasoning as above: GalleryView persists
    // detailsVisible across opens, so no second toggle click needed.
    rows = screen.getAllByTestId("photo-row");
    await user.dblClick(rows[1]);
    canonCell = within(screen.getByTestId("details-section-IFD0")).getByTitle(
      "Canon",
    );
    await user.pointer({ keys: "[MouseRight]", target: canonCell });
    await user.click(screen.getByText("Edit…"));
    input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Sony");
    await user.click(screen.getByText("Save"));
    await user.click(screen.getByTestId("gallery-close-btn"));

    // Verify header summary shows 2 edits across 2 files
    expect(
      screen.getByText(/2 draft edits across 2 files/),
    ).toBeInTheDocument();

    // Click global Discard All button
    const globalDiscardBtn = screen.getByTitle(
      "Discard all edits across all files",
    );
    await user.click(globalDiscardBtn);

    // Verify edits are gone (no draft badge in header)
    expect(screen.queryByText(/draft edit/)).toBeNull();
  });
  it("reacts to authoritative occurrence loading before presenting one safe exact target", async () => {
    const user = userEvent.setup();
    const schema = testIdForFriendlyName("XMP-dc:Description");
    const item: MetadataOccurrence = {
      id: {
        document: null,
        path: "JPEG-APP1-XMP",
        runtime_tag_id: schema.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: schema.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: structuredClone(schema),
      value: { kind: "Text", value: "Committed" },
      tag_info: {
        id: schema,
        group: "XMP-dc",
        name: "Description",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
      observed_selector: {
        group1: "XMP-dc",
        group7: "ID-Test",
        tag_name: "Description",
      },
      write_target: {
        group1: "XMP-dc",
        group7: "ID-Test",
        tag_name: "Description",
      },
    };
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(
      "test.jpg",
      {
        kind: "ExistingOccurrence",
        occurrence_id: item.id,
        schema_id: schema,
        write_target: item.write_target!,
      },
      { intent: "Set", value: { kind: "Text", value: "Pending" } },
    );
    mockApiInstance.targetDraftEditsByFolder["/photos"] =
      store.getAllMetadata();
    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await user.click(screen.getByTestId("open-folder-btn"));

    const photo = makePhoto({ relative_path: "test.jpg" });
    act(() => mockApiInstance.emitPhotoFound(photo));
    const row = await screen.findByTestId("photo-row");
    expect(row.querySelector(".draft-new")).toBeNull();

    act(() => {
      mockApiInstance.emitImageMetadataReady(
        photo.relative_path,
        { "XMP-dc:Description": { kind: "Text", value: "Committed" } },
        undefined,
        [item],
      );
    });
    await waitFor(() => {
      expect(row.querySelector(".draft-new")).toHaveTextContent("Pending");
    });
  });

  it("keeps same-schema exact target counts while suppressing ordinary-cell presentation", async () => {
    const user = userEvent.setup();
    const schema = testIdForFriendlyName("XMP-dc:Description");
    const occurrenceA: MetadataOccurrence = {
      id: {
        document: null,
        path: "JPEG-APP1-IFD0",
        runtime_tag_id: schema.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: schema.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: structuredClone(schema),
      value: { kind: "Text", value: "IFD0 value" },
      tag_info: {
        id: schema,
        group: "XMP-dc",
        name: "Description",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
      observed_selector: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "Description",
      },
      write_target: {
        group1: "IFD0",
        group7: "ID-Test",
        tag_name: "Description",
      },
    };
    const occurrenceB: MetadataOccurrence = {
      ...occurrenceA,
      id: { ...occurrenceA.id, path: "JPEG-APP1-IFD1", copy: 1 },
      value: { kind: "Text", value: "IFD1 value" },
      observed_selector: {
        group1: "IFD1",
        group7: "ID-Test",
        tag_name: "Description",
      },
      write_target: {
        group1: "IFD1",
        group7: "ID-Test",
        tag_name: "Description",
      },
    };
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(
      "test.jpg",
      {
        kind: "ExistingOccurrence",
        occurrence_id: occurrenceA.id,
        schema_id: schema,
        write_target: occurrenceA.write_target!,
      },
      { intent: "Set", value: { kind: "Text", value: "Pending IFD0" } },
    );
    store.setMetadataTarget(
      "test.jpg",
      {
        kind: "ExistingOccurrence",
        occurrence_id: occurrenceB.id,
        schema_id: schema,
        write_target: occurrenceB.write_target!,
      },
      { intent: "Set", value: { kind: "Text", value: "Pending IFD1" } },
    );

    mockApiInstance.targetDraftEditsByFolder["/photos"] =
      store.getAllMetadata();
    mockApiInstance.pickFolderResolves("/photos");
    render(<App />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await user.click(screen.getByTestId("open-folder-btn"));

    const photo = makePhoto({ relative_path: "test.jpg" });
    act(() => {
      mockApiInstance.emitPhotoFound(photo);
      mockApiInstance.emitImageMetadataReady(
        photo.relative_path,
        {
          "XMP-dc:Description": {
            kind: "Text",
            value: "Compatibility value",
          },
        },
        undefined,
        [occurrenceA, occurrenceB],
      );
    });

    const row = await screen.findByTestId("photo-row");
    await waitFor(() => {
      expect(within(row).getByText("2 draft edits")).toBeInTheDocument();
    });
    const token = schemaDefinitionIdToken(schema);
    const cell = Array.from(
      row.querySelectorAll<HTMLElement>(".grid-cell-metadata"),
    ).find((candidate) => candidate.getAttribute("data-col") === token);
    expect(cell).toHaveTextContent("—");
    expect(cell).not.toHaveTextContent("Compatibility value");
    expect(cell?.querySelector(".draft-new")).toBeNull();

    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockResolvedValue(false);
    fireEvent.contextMenu(row);
    await user.click(screen.getByText("Apply edits…"));
    expect(ask).toHaveBeenLastCalledWith(
      expect.stringContaining("Apply 2 edits"),
      expect.anything(),
    );
    fireEvent.contextMenu(row);
    await user.click(screen.getByText("Discard all edits…"));
    expect(ask).toHaveBeenLastCalledWith(
      expect.stringContaining("discard 2 edits"),
      expect.anything(),
    );
  });
});
