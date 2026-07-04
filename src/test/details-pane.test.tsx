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
import {
  DetailsPane,
  groupImageMetadata,
  formatVariant,
  formatTimestamp,
  getOsEntries,
  extractPrefix,
} from "../components/DetailsPane";
import { makePhoto } from "./factories";
import type { DraftEdit, Variant } from "../types";
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

describe("formatVariant", () => {
  it("formats a string value", () => {
    expect(formatVariant("Canon")).toBe("Canon");
  });

  it("formats a numeric value", () => {
    expect(formatVariant(42)).toBe("42");
  });

  it("formats an array value as comma-separated", () => {
    expect(formatVariant(["landscape", "nature"])).toBe("landscape, nature");
  });

  it("formats nested arrays", () => {
    const nested: Variant = [["a", "b"], "c"];
    expect(formatVariant(nested)).toBe("a, b, c");
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
    const metadata: Record<string, Variant> = {
      "IFD0:Make": "Canon",
      "IFD0:Model": "EOS R5",
      "XMP-dc:Subject": ["landscape", "nature"],
      "ExifIFD:ISO": 100,
    };
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
    const metadata: Record<string, Variant> = {
      "IFD0:Make": "Canon",
      FileSize: "4.2 MB",
      FileName: "photo.jpg",
    };
    const groups = groupImageMetadata(metadata);

    expect(groups[groups.length - 1].prefix).toBe("Other");
    expect(groups[groups.length - 1].entries).toEqual([
      { label: "FileName", value: "photo.jpg", fullKey: "FileName" },
      { label: "FileSize", value: "4.2 MB", fullKey: "FileSize" },
    ]);
  });

  it("sorts groups alphabetically (Other last)", () => {
    const metadata: Record<string, Variant> = {
      "XMP-dc:Subject": "test",
      "IFD0:Make": "Canon",
      "ExifIFD:ISO": 100,
      NoPrefix: "value",
    };
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
    const metadata: Record<string, Variant> = {
      "IFD0:Make": "Canon",
      "IFD0:Model": "EOS R5",
      "ExifIFD:ISO": 100,
      "XMP-dc:Subject": ["landscape", "nature"],
    };

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
    const typedDraftEdits: Record<string, DraftEdit> = {
      "XMP-mlib:AIDescription": { value: "older description", intent: "Set" },
    };
    const user = userEvent.setup();
    render(
      <Fresh
        photo={photo}
        metadata={{} as Record<string, Variant>}
        typedDraftEdits={typedDraftEdits}
        draftEdits={{ "XMP-mlib:AIDescription": "older description" }}
        onGenerateAiDescription={onGenerate}
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
        metadata={{} as Record<string, Variant>}
        onGenerateAiDescription={onGenerate}
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
    const onSetDraftTyped = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        onSetDraftTyped={onSetDraftTyped}
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

    expect(onSetDraftTyped).toHaveBeenCalledTimes(1);
    const [keyArg, editArg] = onSetDraftTyped.mock.calls[0] as [
      string,
      DraftEdit,
    ];
    expect(keyArg).toBe("XMP-dc:Subject");
    expect(editArg.intent).toBe("Set");
    expect(editArg.value).toEqual(["landscape"]);
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
    const onSetDraftTyped = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        onSetDraftTyped={onSetDraftTyped}
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

  it("cancelling stage 2 closes the flow without calling onSetDraftTyped", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const onSetDraftTyped = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        onSetDraftTyped={onSetDraftTyped}
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
    expect(onSetDraftTyped).not.toHaveBeenCalled();
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
    const onSetDraftTyped = vi.fn();
    const onDiscardDraft = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{ "IFD0:Make": "Canon" }}
        onSetDraftTyped={onSetDraftTyped}
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
    expect(onSetDraftTyped).not.toHaveBeenCalled();
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
    const onSetDraftTyped = vi.fn();

    render(
      <DetailsPane
        photo={photo}
        metadata={{ "IFD0:Make": "Canon" }}
        onSetDraftTyped={onSetDraftTyped}
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
    expect(onSetDraftTyped).toHaveBeenCalledWith("IFD0:Make", {
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
        metadata={{ "IFD0:Make": "Canon" }}
        draftEdits={{ "IFD0:Make": "Nikon" }}
        onSetDraftTyped={vi.fn()}
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

    const typedDraftEdits: Record<string, DraftEdit> = {
      "IFD0:Orientation": { value: 8, intent: "Set", display: "Rotate 270 CW" },
    };

    render(
      <DetailsPane
        photo={photo}
        metadata={{ "IFD0:Orientation": 1 as Variant }}
        draftEdits={{ "IFD0:Orientation": "Rotate 270 CW" }}
        typedDraftEdits={typedDraftEdits}
        onSetDraftTyped={vi.fn()}
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

    const typedDraftEdits: Record<string, DraftEdit> = {
      "XMP-xmp:Rating": { value: 4, intent: "Set", display: "4" },
    };

    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-xmp:Rating": 2 as Variant }}
        draftEdits={{ "XMP-xmp:Rating": "4" }}
        typedDraftEdits={typedDraftEdits}
        onSetDraftTyped={vi.fn()}
      />,
    );

    openRowEdit("Rating");

    // The visible numeric input must be seeded with the draft "4", not "2".
    const input = (await screen.findByTestId(
      "numeric-editor-input",
    )) as HTMLInputElement;
    expect(input.value).toBe("4");
  });
});
