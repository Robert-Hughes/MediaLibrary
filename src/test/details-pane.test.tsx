/**
 * DetailsPane component tests.
 *
 * Tests cover:
 * - Rendering OS metadata from PhotoInfo
 * - Rendering grouped image metadata by prefix
 * - Loading state display
 * - Empty metadata state display
 * - Utility function correctness (grouping, formatting)
 */
import {
  render,
  screen,
  within,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane as RealDetailsPane } from "../components/DetailsPane";

const DetailsPane = (props: any) => (
  <RealDetailsPane
    onSetMetadataDraftBatch={props.onSetMetadataDraftBatch ?? vi.fn()}
    onDiscardDraftBatch={props.onDiscardDraftBatch ?? vi.fn()}
    {...props}
  />
);
import {
  groupImageMetadata,
  formatMetadataValue,
  formatTimestamp,
  getOsEntries,
  extractPrefix,
} from "../utils/detailsPaneHelpers";
import { makePhoto, mockMetadata } from "./factories";
import type { MetadataDraftEdit, ImageMetadataEntry } from "../types";
import { _clearTagInfoCache, _setTagInfoCacheEntry } from "../hooks/useTagInfo";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

// ── Utility function tests ───────────────────────────────────────────────────

describe("extractPrefix", () => {
  it("extracts the prefix before the colon", () => {
    expect(extractPrefix("IFD0:Make")).toBe("IFD0");
    expect(extractPrefix("XMP-dc:Subject")).toBe("XMP-dc");
  });

  it('returns "Other" when there is no colon', () => {
    expect(extractPrefix("FileSize")).toBe("Other");
  });

  it('returns "Other" when the colon is at position 0', () => {
    expect(extractPrefix(":Something")).toBe("Other");
  });
});

describe("formatMetadataValue", () => {
  it("formats a string value", () => {
    expect(formatMetadataValue({ kind: "Text", value: "Canon" })).toBe("Canon");
  });

  it("formats a numeric value", () => {
    expect(formatMetadataValue({ kind: "Real", value: 42 })).toBe("42");
  });

  it("formats an array value as comma-separated", () => {
    expect(
      formatMetadataValue({
        kind: "List",
        value: {
          list_kind: "Unknown",
          items: [
            { kind: "Text", value: "landscape" },
            { kind: "Text", value: "nature" },
          ],
        },
      }),
    ).toBe("landscape, nature");
  });

  it("formats nested arrays", () => {
    expect(
      formatMetadataValue({
        kind: "List",
        value: {
          list_kind: "Unknown",
          items: [
            {
              kind: "List",
              value: {
                list_kind: "Unknown",
                items: [
                  { kind: "Text", value: "a" },
                  { kind: "Text", value: "b" },
                ],
              },
            },
            { kind: "Text", value: "c" },
          ],
        },
      }),
    ).toBe("a, b, c");
  });
});

describe("formatTimestamp", () => {
  it("returns a dash for null", () => {
    expect(formatTimestamp(null)).toBe("—");
  });

  it("returns a locale date string for a valid timestamp", () => {
    const ts = 1609459200; // 2021-01-01T00:00:00Z
    const result = formatTimestamp(ts);
    // Should contain year 2021 at minimum
    expect(result).toContain("2021");
  });
});

describe("getOsEntries", () => {
  it("returns entries for all OS metadata fields", () => {
    const photo = makePhoto({
      relative_path: "folder/photo.jpg",
      filename: "photo.jpg",
      date_modified: 1609459200,
      date_created: 1609459200,
    });
    const entries = getOsEntries(photo);
    expect(entries).toHaveLength(4);
    expect(entries.map(([key]) => key)).toEqual([
      "Filename",
      "Relative Path",
      "Date Modified",
      "Date Created",
    ]);
    expect(entries[0][1]).toBe("photo.jpg");
    expect(entries[1][1]).toBe("folder/photo.jpg");
  });
});

describe("groupImageMetadata", () => {
  it("groups entries by prefix and strips prefixes from labels", () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
      "IFD0:Model": "EOS R5",
      "XMP-dc:Subject": ["landscape", "nature"],
      "ExifIFD:ISO": 100,
    });
    const groups = groupImageMetadata(metadata);

    expect(groups).toHaveLength(3);

    const exifGroup = groups.find((g) => g.prefix === "ExifIFD");
    expect(exifGroup).toBeDefined();
    expect(exifGroup!.entries).toEqual([
      { label: "ISO", value: "100", fullKey: "ExifIFD:ISO" },
    ]);

    const ifdGroup = groups.find((g) => g.prefix === "IFD0");
    expect(ifdGroup).toBeDefined();
    expect(ifdGroup!.entries).toEqual([
      { label: "Make", value: "Canon", fullKey: "IFD0:Make" },
      { label: "Model", value: "EOS R5", fullKey: "IFD0:Model" },
    ]);

    const xmpGroup = groups.find((g) => g.prefix === "XMP-dc");
    expect(xmpGroup).toBeDefined();
    expect(xmpGroup!.entries).toEqual([
      {
        label: "Subject",
        value: "landscape, nature",
        fullKey: "XMP-dc:Subject",
      },
    ]);
  });

  it('places keys without a colon in "Other" group at the end', () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
      FileSize: "4.2 MB",
      FileName: "photo.jpg",
    });
    const groups = groupImageMetadata(metadata);

    expect(groups[groups.length - 1].prefix).toBe("Other");
    expect(groups[groups.length - 1].entries).toEqual([
      { label: "FileName", value: "photo.jpg", fullKey: "FileName" },
      { label: "FileSize", value: "4.2 MB", fullKey: "FileSize" },
    ]);
  });

  it("sorts groups alphabetically (Other last)", () => {
    const metadata = mockMetadata({
      "XMP-dc:Subject": "test",
      "IFD0:Make": "Canon",
      "ExifIFD:ISO": 100,
      NoPrefix: "value",
    });
    const groups = groupImageMetadata(metadata);
    const prefixes = groups.map((g) => g.prefix);
    expect(prefixes).toEqual(["ExifIFD", "IFD0", "XMP-dc", "Other"]);
  });

  it("returns empty array for empty metadata", () => {
    expect(groupImageMetadata({})).toEqual([]);
  });
});

// ── Component rendering tests ────────────────────────────────────────────────

describe("DetailsPane component", () => {
  const photo = makePhoto({
    relative_path: "2024/vacation/beach.jpg",
    filename: "beach.jpg",
    date_modified: 1609459200,
    date_created: 1609372800,
  });

  beforeEach(() => {
    _clearTagInfoCache();
    const commonTags = [
      "IFD0:Make",
      "IFD0:Model",
      "ExifIFD:ISO",
      "XMP-dc:Subject",
      "GPS:GPSLatitude",
      "GPS:GPSLongitude",
      "GPS:GPSLatitudeRef",
      "GPS:GPSLongitudeRef",
    ];
    for (const tag of commonTags) {
      _setTagInfoCacheEntry(tag, null);
    }
  });

  it("renders the OS metadata section with all photo properties", () => {
    render(<DetailsPane photo={photo} metadata="loading" />);

    const osSection = screen.getByTestId("details-section-os");
    expect(osSection).toBeInTheDocument();

    expect(within(osSection).getByText("OS Metadata")).toBeInTheDocument();
    expect(within(osSection).getByText("Filename")).toBeInTheDocument();
    expect(within(osSection).getByText("beach.jpg")).toBeInTheDocument();
    expect(within(osSection).getByText("Relative Path")).toBeInTheDocument();
    expect(
      within(osSection).getByText("2024/vacation/beach.jpg"),
    ).toBeInTheDocument();
  });

  it('shows a loading state when metadata is "loading"', () => {
    render(<DetailsPane photo={photo} metadata="loading" />);

    const loadingSection = screen.getByTestId("details-section-loading");
    expect(loadingSection).toBeInTheDocument();
    expect(
      within(loadingSection).getByText("Loading metadata…"),
    ).toBeInTheDocument();
  });

  it("shows empty state when metadata has no keys", () => {
    render(<DetailsPane photo={photo} metadata={{}} />);

    const emptySection = screen.getByTestId("details-section-empty");
    expect(emptySection).toBeInTheDocument();
    expect(
      within(emptySection).getByText("No image metadata available"),
    ).toBeInTheDocument();
  });

  it("renders grouped image metadata sections", () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
      "IFD0:Model": "EOS R5",
      "ExifIFD:ISO": 100,
      "XMP-dc:Subject": ["landscape", "nature"],
    });

    render(<DetailsPane photo={photo} metadata={metadata} />);

    // Check that group sections are rendered
    const ifdSection = screen.getByTestId("details-section-IFD0");
    expect(ifdSection).toBeInTheDocument();
    expect(within(ifdSection).getByText("IFD0")).toBeInTheDocument();
    expect(within(ifdSection).getByText("Make")).toBeInTheDocument();
    expect(within(ifdSection).getByText("Canon")).toBeInTheDocument();
    expect(within(ifdSection).getByText("Model")).toBeInTheDocument();
    expect(within(ifdSection).getByText("EOS R5")).toBeInTheDocument();

    const exifSection = screen.getByTestId("details-section-ExifIFD");
    expect(exifSection).toBeInTheDocument();
    expect(within(exifSection).getByText("ISO")).toBeInTheDocument();
    expect(within(exifSection).getByText("100")).toBeInTheDocument();

    const xmpSection = screen.getByTestId("details-section-XMP-dc");
    expect(xmpSection).toBeInTheDocument();
    expect(within(xmpSection).getByText("Subject")).toBeInTheDocument();
    expect(
      within(xmpSection).getByText("landscape, nature"),
    ).toBeInTheDocument();
  });

  it("renders schema-backed enum labels for canonical metadata values", () => {
    _clearTagInfoCache();
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

    render(
      <DetailsPane
        photo={photo}
        metadata={{
          "IFD0:Orientation": { kind: "Integer", value: 6 },
        }}
      />,
    );

    const row = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("Orientation") !== null);
    expect(row).toBeDefined();
    expect(within(row!).getByText("Rotate 90 CW")).toBeInTheDocument();
    expect(within(row!).queryByText("6")).toBeNull();
    _clearTagInfoCache();
  });

  it("has the Properties title", () => {
    render(<DetailsPane photo={photo} metadata="loading" />);
    expect(screen.getByText("Properties")).toBeInTheDocument();
  });

  it("renders the action buttons in a sticky footer outside the scrolling body", () => {
    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        onGenerateAiDescription={() => {}}
      />,
    );
    const footer = screen.getByTestId("details-pane-footer");
    expect(footer).toBeInTheDocument();
    // The footer must be a sibling of the scroll container, not nested in it.
    const body = footer.parentElement?.querySelector(".details-pane-body");
    expect(body).not.toBeNull();
    expect(body!.contains(footer)).toBe(false);

    // Both action buttons live in the sticky footer.
    expect(within(footer).getByText("+ Add Property…")).toBeInTheDocument();
    expect(
      within(footer).getByTestId("details-pane-generate-ai-btn"),
    ).toBeInTheDocument();
  });

  it("renders a Show in File Explorer button when the callback is wired, and fires it on click", async () => {
    const onShow = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane photo={photo} metadata={{}} onShowInFileExplorer={onShow} />,
    );
    const btn = screen.getByTestId("details-pane-show-in-explorer-btn");
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("omits the Show in File Explorer button when no callback is wired", () => {
    render(<DetailsPane photo={photo} metadata={{}} />);
    expect(
      screen.queryByTestId("details-pane-show-in-explorer-btn"),
    ).toBeNull();
  });
});

// ── Generate-AI overwrite confirmation ──────────────────────────────────────

describe("DetailsPane: Generate-AI button", () => {
  // The overwrite-warning now lives inside DescribeProgressDialog's
  // awaiting-confirm panel rather than in a pre-dialog `ask()`. The
  // button's only job is to invoke the callback — the dialog (driven by
  // App-level overwriteInfo) takes it from there.
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });
  beforeEach(() => {
    cleanup();
  });

  it("invokes onGenerateAiDescription directly (no pre-dialog ask)", async () => {
    const ask = vi.fn();
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ ask }));
    vi.resetModules();
    const { DetailsPane: Fresh } = await import("../components/DetailsPane");
    const onGenerate = vi.fn();
    const typedDraftEdits: Record<string, MetadataDraftEdit> = {
      "XMP-mlib:AIDescription": {
        value: { kind: "Text", value: "older description" },
        intent: "Set",
      },
    };
    const user = userEvent.setup();
    render(
      <Fresh
        photo={photo}
        metadata={{} as Record<string, ImageMetadataEntry>}
        typedDraftEdits={typedDraftEdits}
        draftEdits={{ "XMP-mlib:AIDescription": "older description" }}
        onGenerateAiDescription={onGenerate}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("details-pane-generate-ai-btn"));
    expect(ask).not.toHaveBeenCalled();
    expect(onGenerate).toHaveBeenCalledTimes(1);
    vi.doUnmock("@tauri-apps/plugin-dialog");
  });

  it("invokes onGenerateAiDescription with no existing description either", async () => {
    const ask = vi.fn();
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ ask }));
    vi.resetModules();
    const { DetailsPane: Fresh } = await import("../components/DetailsPane");
    const onGenerate = vi.fn();
    const user = userEvent.setup();
    render(
      <Fresh
        photo={photo}
        metadata={{} as Record<string, ImageMetadataEntry>}
        onGenerateAiDescription={onGenerate}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("details-pane-generate-ai-btn"));
    expect(ask).not.toHaveBeenCalled();
    expect(onGenerate).toHaveBeenCalledTimes(1);
    vi.doUnmock("@tauri-apps/plugin-dialog");
  });
});

// ── Two-step Add-Property flow ──────────────────────────────────────────────

describe("DetailsPane: Add-Property two-step flow", () => {
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
  });

  it("stage 2 routes to a kind-appropriate editor (Bag → chip editor)", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-dc:Subject", {
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Bag", data: { kind: "Text" } },
      description: null,
    });
    const onSetMetadataDraft = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        onSetMetadataDraft={onSetMetadataDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Subject" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));

    // Stage 1 dialog is gone; stage 2 is the Bag chip editor.
    expect(screen.queryByTestId("new-property-key")).toBeNull();
    expect(screen.getByTestId("bag-editor-overlay")).toBeInTheDocument();

    // Add a chip and save.
    const chipInput = screen.getByTestId("bag-editor-input");
    fireEvent.change(chipInput, { target: { value: "landscape" } });
    fireEvent.keyDown(chipInput, { key: "Enter" });
    await user.click(screen.getByTestId("bag-editor-save"));

    expect(onSetMetadataDraft).toHaveBeenCalledTimes(1);
    const [keyArg, editArg] = onSetMetadataDraft.mock.calls[0] as [
      string,
      MetadataDraftEdit,
    ];
    expect(keyArg).toBe("XMP-dc:Subject");
    expect(editArg.intent).toBe("Set");
    expect(editArg.value).toEqual({
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [{ kind: "Text", value: "landscape" }],
      },
    });
  });

  it("stage 2 routes Boolean tags to the Boolean editor (proves kind dispatch is not stringly typed)", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-foo:Bool", {
      group: "XMP-foo",
      name: "Bool",
      writable: true,
      kind: { kind: "Boolean" },
      description: null,
    });
    const onSetMetadataDraft = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        onSetMetadataDraft={onSetMetadataDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-foo:Bool" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));

    expect(screen.queryByTestId("new-property-key")).toBeNull();
    // BooleanEditor renders true/false radios — assert the dialog is not
    // a plain text input by checking for those radio inputs.
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThanOrEqual(2);
  });

  it("cancelling stage 2 closes the flow without calling onSetMetadataDraft", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const onSetMetadataDraft = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        onSetMetadataDraft={onSetMetadataDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Title" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));

    // Stage 2 should be a ValueEditDialog for Text — cancel it.
    await user.click(screen.getByText("Cancel"));
    expect(onSetMetadataDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId("value-edit-input")).toBeNull();
  });
});

// ── Read-only schema handling in the row context menu ─────────────────────

describe("DetailsPane: read-only row context menu", () => {
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
  });

  function openRowContextMenu() {
    const row = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("Make") !== null);
    expect(row).toBeDefined();
    fireEvent.contextMenu(row!);
  }

  it("renders no context menu at all for a read-only tag with no pending draft", async () => {
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });
    const onSetMetadataDraft = vi.fn();
    const onDiscardDraft = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "IFD0:Make": "Canon" })}
        onSetMetadataDraft={onSetMetadataDraft}
        onDiscardDraft={onDiscardDraft}
      />,
    );

    openRowContextMenu();

    // Wait a tick for useTagInfo + effect-driven close to settle.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
      expect(screen.queryByRole("button", { name: "View…" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Discard edit" })).toBeNull();
    });
    expect(onSetMetadataDraft).not.toHaveBeenCalled();
    expect(onDiscardDraft).not.toHaveBeenCalled();
  });

  it("keeps Edit + enabled Remove for a writable existing tag", async () => {
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const onSetMetadataDraft = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "IFD0:Make": "Canon" })}
        onSetMetadataDraft={onSetMetadataDraft}
      />,
    );

    openRowContextMenu();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "View…" })).toBeNull();

    const removeBtn = screen.getByRole("button", { name: "Remove" });
    expect(removeBtn).not.toBeDisabled();

    fireEvent.click(removeBtn);
    expect(onSetMetadataDraft).toHaveBeenCalledWith("IFD0:Make", {
      value: null,
      intent: "Delete",
    });
  });

  it("shows only Discard edit for a read-only tag that has a pending draft", async () => {
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });

    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "IFD0:Make": "Canon" })}
        draftEdits={{ "IFD0:Make": "Nikon" }}
        onSetMetadataDraft={vi.fn()}
      />,
    );

    openRowContextMenu();

    await screen.findByRole("button", { name: "Discard edit" });
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});

// ── Edit dialog seeds from the pending draft, not the on-disk value ─────────

describe("DetailsPane: Edit reopens with pending draft as the seed", () => {
  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
  });

  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  function openRowEdit(rowLabel: string) {
    const row = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText(rowLabel) !== null);
    expect(row).toBeDefined();
    fireEvent.contextMenu(row!);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
  }

  it("EnumEditor opens on the draft value, not the metadata value", async () => {
    _setTagInfoCacheEntry("IFD0:Orientation", {
      group: "IFD0",
      name: "Orientation",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "Integer",
          options: [
            { code: "1", label: "Horizontal (normal)" },
            { code: "6", label: "Rotate 90 CW" },
            { code: "8", label: "Rotate 270 CW" },
          ],
        },
      },
      description: null,
    });

    const typedDraftEdits: Record<string, MetadataDraftEdit> = {
      "IFD0:Orientation": {
        value: { kind: "Integer", value: 8 },
        intent: "Set",
        display: "Rotate 270 CW",
      },
    };

    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "IFD0:Orientation": 1 })}
        draftEdits={{ "IFD0:Orientation": "Rotate 270 CW" }}
        typedDraftEdits={typedDraftEdits}
        onSetMetadataDraft={vi.fn()}
      />,
    );

    openRowEdit("Orientation");

    // Editor must open in dropdown mode (not Custom) and have the draft
    // selection (8) pre-selected — not the on-disk value (1).
    const select = (await screen.findByTestId(
      "enum-editor-select",
    )) as HTMLSelectElement;
    expect(select.value).toBe("8");
  });

  it("NumericEditor seeds the input with the pending draft value", async () => {
    _setTagInfoCacheEntry("XMP-xmp:Rating", {
      group: "XMP-xmp",
      name: "Rating",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const typedDraftEdits: Record<string, MetadataDraftEdit> = {
      "XMP-xmp:Rating": {
        value: { kind: "Real", value: 4 },
        intent: "Set",
        display: "4",
      },
    };

    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "XMP-xmp:Rating": 2 })}
        draftEdits={{ "XMP-xmp:Rating": "4" }}
        typedDraftEdits={typedDraftEdits}
        onSetMetadataDraft={vi.fn()}
      />,
    );

    openRowEdit("Rating");

    const input = (await screen.findByTestId(
      "numeric-editor-input",
    )) as HTMLInputElement;
    expect(input.value).toBe("4");
  });
});

describe("DetailsPane: GPS Combined-Editor context-menu and routing", () => {
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();

    // Register all six GPS fields as writable
    const gpsFields = [
      { key: "GPS:GPSLatitude", kind: { kind: "Real" } },
      { key: "GPS:GPSLatitudeRef", kind: { kind: "Text" } },
      { key: "GPS:GPSLongitude", kind: { kind: "Real" } },
      { key: "GPS:GPSLongitudeRef", kind: { kind: "Text" } },
      { key: "GPS:GPSAltitude", kind: { kind: "Real" } },
      { key: "GPS:GPSAltitudeRef", kind: { kind: "Integer" } },
    ];
    for (const f of gpsFields) {
      _setTagInfoCacheEntry(f.key, {
        group: f.key.split(":")[0],
        name: f.key.split(":")[1],
        writable: true,
        kind: f.kind as any,
        description: null,
      });
    }

    // Register a non-GPS field
    _setTagInfoCacheEntry("XMP-dc:Subject", {
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
  });

  function openContextMenu(label: string) {
    const row = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText(label) !== null);
    expect(row).toBeDefined();
    fireEvent.contextMenu(row!);
  }

  it("shows both Edit... and Edit GPS... for all six GPS fields when batch save is available, and only Edit... for non-GPS field", async () => {
    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLatitudeRef": "N",
          "GPS:GPSLongitude": 0.12,
          "GPS:GPSLongitudeRef": "W",
          "GPS:GPSAltitude": 100,
          "GPS:GPSAltitudeRef": 0,
          "XMP-dc:Subject": "test",
        })}
        onSetMetadataDraftBatch={vi.fn()}
      />,
    );

    const gpsLabels = [
      "GPSLatitude",
      "GPSLatitudeRef",
      "GPSLongitude",
      "GPSLongitudeRef",
      "GPSAltitude",
      "GPSAltitudeRef",
    ];

    for (const label of gpsLabels) {
      openContextMenu(label);
      expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Edit GPS…" }),
      ).toBeInTheDocument();
      // Press Escape to dismiss context menu
      fireEvent.keyDown(document, { key: "Escape" });
    }

    // Check non-GPS field
    openContextMenu("Subject");
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit GPS…" })).toBeNull();
  });

  it("does not show edit actions for read-only GPS row", async () => {
    // Make GPSLatitude read-only
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: false,
      kind: { kind: "Real" },
      description: null,
    });

    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
        })}
      />,
    );

    openContextMenu("GPSLatitude");
    // Wait for context menu close logic if no options are available
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit GPS…" })).toBeNull();
    });
  });

  it("clicking Edit... on GPS field opens single-property editor, not GpsEditor", async () => {
    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
        })}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));

    // Should open the single property numeric editor (or ValueEditDialog if no tag info fallback matches)
    expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
    expect(
      screen.queryByTestId("numeric-editor-input") ||
        screen.queryByTestId("value-edit-input"),
    ).not.toBeNull();
  });

  it("clicking Edit GPS... opens GpsEditor on coordinate, ref, altitude, altitude ref fields", async () => {
    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLatitudeRef": "N",
          "GPS:GPSLongitude": 0.12,
          "GPS:GPSLongitudeRef": "W",
          "GPS:GPSAltitude": 100,
          "GPS:GPSAltitudeRef": 0,
        })}
        onSetMetadataDraftBatch={vi.fn()}
      />,
    );

    const testCases = [
      "GPSLatitude",
      "GPSLongitudeRef",
      "GPSAltitude",
      "GPSAltitudeRef",
    ];

    for (const label of testCases) {
      openContextMenu(label);
      fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));
      expect(
        await screen.findByTestId("gps-editor-overlay"),
      ).toBeInTheDocument();
      // Cancel the GpsEditor to clean up for next iteration
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
      });
    }
  });
});

describe("DetailsPane: Group context menu", () => {
  let askMock = vi.fn();

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
    askMock = vi.fn(() => Promise.resolve(true));
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ ask: askMock }));
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/plugin-dialog");
  });

  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  it("Shows remove count for writable fields only", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitude", {
      group: "GPS",
      name: "GPSLongitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSVersionID", {
      group: "GPS",
      name: "GPSVersionID",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });

    const onSetBatch = vi.fn();
    const onDiscardBatch = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLongitude": -0.1,
          "GPS:GPSVersionID": "2.2.0.0",
        })}
        onSetMetadataDraftBatch={onSetBatch}
        onDiscardDraftBatch={onDiscardBatch}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    await screen.findByRole("button", {
      name: "Remove all 2 writable GPS fields…",
    });
    expect(
      screen.queryByRole("button", {
        name: "Remove all 3 writable GPS fields…",
      }),
    ).toBeNull();
  });

  it("Does not show remove when all fields read-only and no edits", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSVersionID", {
      group: "GPS",
      name: "GPSVersionID",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSVersionID": "2.2.0.0",
        })}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    // Wait a tick for effects to close the menu
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    });
  });

  it("Shows discard count for pending edits", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    _setTagInfoCacheEntry("IFD0:Model", {
      group: "IFD0",
      name: "Model",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "IFD0:Make": "Canon",
          "IFD0:Model": "5D",
        })}
        draftEdits={{
          "IFD0:Make": "Nikon",
          "IFD0:Model": "D850",
        }}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-IFD0");
    const heading = within(section).getByRole("heading", {
      name: "IFD0",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    await screen.findByRole("button", {
      name: "Discard all 2 IFD0 edits…",
    });
  });

  it("Remove action stages deletes via batch", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitude", {
      group: "GPS",
      name: "GPSLongitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const onSetBatch = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLongitude": -0.1,
        })}
        onSetMetadataDraftBatch={onSetBatch}
        onDiscardDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    const removeBtn = await screen.findByRole("button", {
      name: "Remove all 2 writable GPS fields…",
    });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(1);
    });

    expect(onSetBatch).toHaveBeenCalledWith([
      { key: "GPS:GPSLatitude", edit: { value: null, intent: "Delete" } },
      { key: "GPS:GPSLongitude", edit: { value: null, intent: "Delete" } },
    ]);
  });

  it("Remove action discards draft-only fields", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSAltitude", {
      group: "GPS",
      name: "GPSAltitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const onSetBatch = vi.fn();
    const onDiscardBatch = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
        })}
        draftEdits={{
          "GPS:GPSAltitude": "100",
        }}
        onSetMetadataDraftBatch={onSetBatch}
        onDiscardDraftBatch={onDiscardBatch}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    const removeBtn = await screen.findByRole("button", {
      name: "Remove all 2 writable GPS fields…",
    });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(1);
    });

    expect(onSetBatch).toHaveBeenCalledWith([
      { key: "GPS:GPSLatitude", edit: { value: null, intent: "Delete" } },
    ]);
    expect(onDiscardBatch).toHaveBeenCalledWith(["GPS:GPSAltitude"]);
  });

  it("Discard action calls batch discard once", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitude", {
      group: "GPS",
      name: "GPSLongitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const onDiscardBatch = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLongitude": -0.1,
        })}
        draftEdits={{
          "GPS:GPSLatitude": "52.0",
          "GPS:GPSLongitude": "-0.2",
        }}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={onDiscardBatch}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    const discardBtn = await screen.findByRole("button", {
      name: "Discard all 2 GPS edits…",
    });
    fireEvent.click(discardBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(1);
    });

    expect(onDiscardBatch).toHaveBeenCalledWith([
      "GPS:GPSLatitude",
      "GPS:GPSLongitude",
    ]);
  });

  it("Confirmation false does not mutate", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    askMock.mockResolvedValue(false);

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const onSetBatch = vi.fn();
    const onDiscardBatch = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
        })}
        draftEdits={{
          "GPS:GPSLatitude": "52.0",
        }}
        onSetMetadataDraftBatch={onSetBatch}
        onDiscardDraftBatch={onDiscardBatch}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });

    // Test Remove cancellation
    fireEvent.contextMenu(heading);
    const removeBtn = await screen.findByRole("button", {
      name: "Remove 1 writable GPS field…",
    });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(1);
    });
    expect(onSetBatch).not.toHaveBeenCalled();
    expect(onDiscardBatch).not.toHaveBeenCalled();

    // Test Discard cancellation
    fireEvent.contextMenu(heading);
    const discardBtn = await screen.findByRole("button", {
      name: "Discard 1 GPS edit…",
    });
    fireEvent.click(discardBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(2);
    });
    expect(onDiscardBatch).not.toHaveBeenCalled();
  });

  it("uses the complete group when the details search filters out some rows", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitude", {
      group: "GPS",
      name: "GPSLongitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const onSetBatch = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLongitude": -0.1,
        })}
        onSetMetadataDraftBatch={onSetBatch}
        onDiscardDraftBatch={vi.fn()}
      />,
    );

    // Filter to only match GPSLatitude
    const searchInput = screen.getByTestId("details-search-input");
    await userEvent.type(searchInput, "Latitude");

    // Verify GPSLongitude is no longer visible
    expect(screen.queryByText("Longitude")).toBeNull();
    expect(screen.getByText("Latitude")).toBeInTheDocument();

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    // Expecting: "Remove all 2 writable GPS fields…" because search filter
    // does not reduce the group action scope.
    const removeBtn = await screen.findByRole("button", {
      name: "Remove all 2 writable GPS fields…",
    });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(1);
    });

    expect(onSetBatch).toHaveBeenCalledWith([
      { key: "GPS:GPSLatitude", edit: { value: null, intent: "Delete" } },
      { key: "GPS:GPSLongitude", edit: { value: null, intent: "Delete" } },
    ]);
  });

  it("handles singular/plural labels and formatting correctly (e.g. File group)", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("../hooks/useTagInfo");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    // Register exactly one tag in File group (e.g. File:FileSize)
    _setTagInfoCacheEntry("File:FileSize", {
      group: "File",
      name: "FileSize",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({
          "File:FileSize": "1 MB",
        })}
        draftEdits={{
          "File:FileSize": "2 MB",
        }}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-File");
    const heading = within(section).getByRole("heading", {
      name: "File",
      level: 3,
    });

    // Check singular remove label
    fireEvent.contextMenu(heading);
    await screen.findByRole("button", {
      name: "Remove 1 writable File field…",
    });

    // Check singular discard label
    await screen.findByRole("button", {
      name: "Discard 1 File edit…",
    });
  });
});
