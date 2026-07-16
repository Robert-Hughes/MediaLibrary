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
import { useState } from "react";
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
import { DetailsPane } from "../components/DetailsPane";
import {
  TargetDraftEditsStore,
  type TargetDraftCollection,
} from "../targetDraftEdits";
import { planGpsTargetDraftBatchV5 } from "../gpsTargetDrafts";

import {
  groupImageMetadata as exactGroupImageMetadata,
  formatMetadataValue,
  formatTimestamp,
  getOsEntries,
} from "../utils/detailsPaneHelpers";
import { makePhoto, mockMetadata, testFriendlyName, testId } from "./factories";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import {
  _resetWritableSchemaDefinitionsCache as _resetSchemaTagNamesCache,
  _setWritableSchemaDefinitionsCache as _setSchemaTagNamesCache,
} from "../hooks/useWritableSchemaDefinitions";
import type {
  MetadataDraftEdit,
  ImageMetadataEntry,
  MetadataOccurrence,
  PhotoInfo,
  SchemaDefinitionId,
} from "../types";

function mockOccurrences(
  values: Parameters<typeof mockMetadata>[0],
  readOnly: string[] = [],
): MetadataOccurrence[] {
  return Object.values(mockMetadata(values)).map((entry, index) => {
    const friendly = testFriendlyName(entry.id);
    const separator = friendly.indexOf(":");
    const group = separator < 0 ? "Other" : friendly.slice(0, separator);
    const name = separator < 0 ? friendly : friendly.slice(separator + 1);
    const value = { ...entry } as Record<string, unknown>;
    delete value.id;
    return {
      id: {
        document: null,
        path: `TEST-${group}-${index}`,
        tag_id: entry.id.tag_id,
        copy: 0,
      },
      value: value as MetadataOccurrence["value"],
      tag_info: {
        id: structuredClone(entry.id),
        group,
        name,
        writable: !readOnly.includes(friendly),
        kind: { kind: "Text" },
        description: null,
      },
      write_target: readOnly.includes(friendly)
        ? null
        : { group1: group, tag_name: name },
    };
  });
}

const groupImageMetadata = (metadata: Record<string, ImageMetadataEntry>) => {
  const infos = Object.fromEntries(
    Object.values(metadata).map((entry) => {
      const friendly = testFriendlyName(entry.id);
      const colon = friendly.indexOf(":");
      return [
        schemaDefinitionIdToken(entry.id),
        {
          id: entry.id,
          group: colon > 0 ? friendly.slice(0, colon) : "Other",
          name: colon > 0 ? friendly.slice(colon + 1) : friendly,
          writable: true,
          kind: { kind: "Text" as const },
          description: null,
        },
      ];
    }),
  );
  return exactGroupImageMetadata(metadata, infos).map((group) => ({
    ...group,
    entries: group.entries.map(({ id, label, value }) => ({
      label,
      value,
      fullKey: testFriendlyName(id),
    })),
  }));
};
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

// ── Utility function tests ───────────────────────────────────────────────────

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
      const colon = tag.indexOf(":");
      _setTagInfoCacheEntry(tag, {
        group: tag.slice(0, colon),
        name: tag.slice(colon + 1),
        writable: true,
        kind: { kind: "Text" },
        description: null,
      });
    }
  });

  it("renders the OS metadata section with all photo properties", () => {
    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata="loading"
      />,
    );

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
    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata="loading"
      />,
    );

    const loadingSection = screen.getByTestId("details-section-loading");
    expect(loadingSection).toBeInTheDocument();
    expect(
      within(loadingSection).getByText("Loading metadata…"),
    ).toBeInTheDocument();
  });

  it("shows empty state when metadata has no keys", () => {
    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={{}}
      />,
    );

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

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
      />,
    );

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
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={mockMetadata({ "IFD0:Orientation": 6 })}
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
    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata="loading"
      />,
    );
    expect(screen.getByText("Properties")).toBeInTheDocument();
  });

  it("renders the action buttons in a sticky footer outside the scrolling body", () => {
    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
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
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={{}}
        onShowInFileExplorer={onShow}
      />,
    );
    const btn = screen.getByTestId("details-pane-show-in-explorer-btn");
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("omits the Show in File Explorer button when no callback is wired", () => {
    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={{}}
      />,
    );
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
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
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
    _resetSchemaTagNamesCache();
    _setSchemaTagNamesCache([]);
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
    _setSchemaTagNamesCache([
      {
        id: testId("XMP-dc:Subject"),
        group: "XMP-dc",
        name: "Subject",
        writable: true,
        kind: { kind: "Bag", data: { kind: "Text" } },
        description: null,
      },
    ]);
    const onSetNewPropertyDraft = vi.fn();
    const onSetExistingOccurrenceDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={{}}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onSetNewPropertyDraft={onSetNewPropertyDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Subject" },
    });
    await user.click(screen.getByRole("button", { name: /XMP-dc:Subject/ }));
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

    expect(onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
    expect(onSetNewPropertyDraft).toHaveBeenCalledTimes(1);
    const [idArg, editArg] = onSetNewPropertyDraft.mock.calls[0] as [
      SchemaDefinitionId,
      MetadataDraftEdit,
    ];
    expect(idArg).toEqual(testId("XMP-dc:Subject"));
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
    _setSchemaTagNamesCache([
      {
        id: testId("XMP-foo:Bool"),
        group: "XMP-foo",
        name: "Bool",
        writable: true,
        kind: { kind: "Boolean" },
        description: null,
      },
    ]);
    const onSetExistingOccurrenceDraft = vi.fn();
    const onSetNewPropertyDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={{}}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onSetNewPropertyDraft={onSetNewPropertyDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-foo:Bool" },
    });
    await user.click(screen.getByRole("button", { name: /XMP-foo:Bool/ }));
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

  it("cancelling stage 2 closes the flow without creating either draft kind", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    _setSchemaTagNamesCache([
      {
        id: testId("XMP-dc:Title"),
        group: "XMP-dc",
        name: "Title",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
    ]);
    const onSetExistingOccurrenceDraft = vi.fn();
    const onSetNewPropertyDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={{}}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onSetNewPropertyDraft={onSetNewPropertyDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Title" },
    });
    await user.click(screen.getByRole("button", { name: /XMP-dc:Title/ }));
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));

    // Stage 2 should be a ValueEditDialog for Text — cancel it.
    await user.click(screen.getByText("Cancel"));
    expect(onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
    expect(onSetNewPropertyDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId("value-edit-input")).toBeNull();
  });
});

describe("DetailsPane: target-aware Add Property drafts", () => {
  const photo = makePhoto({ relative_path: "target.jpg" });
  const id = testId("XMP-dc:Subject");
  const target = {
    kind: "ExistingOccurrence" as const,
    occurrence_id: {
      document: null,
      path: "JPEG-APP1-XMP",
      tag_id: "subject",
      copy: 0,
    },
    schema_id: id,
    write_target: { group1: "XMP-dc", tag_name: "Subject" },
  };

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
    _setTagInfoCacheEntry("XMP-dc:Subject", {
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
  });

  it("enables Add Property when v5 persistence is ready", async () => {
    const user = userEvent.setup();
    _setSchemaTagNamesCache([]);
    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        targetDraftPersistence={{ status: "ready" }}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    const button = screen.getByTestId("details-pane-add-property-btn");
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(
      screen.getByRole("dialog", { name: "Add new property" }),
    ).toBeInTheDocument();
  });

  it("disables Add Property and existing-row editing after a failed v5 load", async () => {
    const user = userEvent.setup();
    const titleId = testId("XMP-dc:Title");
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(
      <DetailsPane
        photo={photo}
        metadata={{
          [schemaDefinitionIdToken(titleId)]: {
            id: titleId,
            kind: "Text",
            value: "existing",
          },
        }}
        targetDraftPersistence={{
          status: "load-failed",
          error: "malformed file",
        }}
        onSetExistingOccurrenceDraft={vi.fn()}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    const button = screen.getByTestId("details-pane-add-property-btn");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/reopen/i));
    await user.click(button);
    expect(
      screen.queryByRole("dialog", { name: "Add new property" }),
    ).toBeNull();
    expect(screen.queryByTestId("value-edit-overlay")).toBeNull();

    const row = screen.getByText("Title").closest("tr")!;
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(row).toHaveAttribute("data-readonly", "true");
  });

  it("marks every ambiguous target-owned exact schema unavailable in the picker while a distinct schema remains selectable", async () => {
    const user = userEvent.setup();
    const distinct = testId("XMP-dc:Title");
    _setSchemaTagNamesCache([
      {
        id,
        group: "XMP-dc",
        name: "Subject",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
      {
        id: distinct,
        group: "XMP-dc",
        name: "Title",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
    ]);
    const store = new TargetDraftEditsStore();
    for (const copy of [0, 1]) {
      store.setMetadataTarget(
        "target.jpg",
        {
          ...target,
          occurrence_id: { ...target.occurrence_id, copy },
          write_target: { group1: "XMP-dc", tag_name: `Subject-${copy}` },
        },
        { intent: "Set", value: { kind: "Text", value: `${copy}` } },
      );
    }
    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "XMP-dc:Subject": "original" })}
        occurrences={[
          {
            id: target.occurrence_id,
            value: { kind: "Text", value: "original" },
            tag_info: {
              id,
              group: "XMP-dc",
              name: "Subject",
              writable: true,
              kind: { kind: "Text" },
              description: null,
            },
            write_target: target.write_target,
          },
        ]}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        targetDraftPersistence={{ status: "ready" }}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("details-pane-add-property-btn"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc" },
    });

    await user.click(
      screen.getByTestId(`schema-option-${schemaDefinitionIdToken(id)}`),
    );
    expect(
      screen.getByTestId("new-property-duplicate-warning"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("new-property-next")).toBeDisabled();

    await user.click(
      screen.getByTestId(`schema-option-${schemaDefinitionIdToken(distinct)}`),
    );
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
  });

  it("displays, edits and discards a reconciled draft through its exact target", async () => {
    const user = userEvent.setup();
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("target.jpg", target, {
      intent: "Set",
      value: { kind: "Text", value: "reconciled value" },
    });
    const onSetExistingOccurrenceDraft = vi.fn();
    const onDiscardTargetPropertyDraft = vi.fn();
    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "XMP-dc:Subject": "original" })}
        occurrences={[
          {
            id: target.occurrence_id,
            value: { kind: "Text", value: "original" },
            tag_info: {
              id,
              group: "XMP-dc",
              name: "Subject",
              writable: true,
              kind: { kind: "Text" },
              description: null,
            },
            write_target: target.write_target,
          },
        ]}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        onDiscardTargetPropertyDraft={onDiscardTargetPropertyDraft}
      />,
    );

    expect(screen.getByText("reconciled value")).toBeInTheDocument();
    const row = screen.getByText("reconciled value").closest("tr")!;
    fireEvent.contextMenu(row);
    await user.click(screen.getByText("Edit…"));
    const input = screen.getByTestId("value-edit-input");
    expect(input).toHaveValue("reconciled value");
    await user.clear(input);
    await user.type(input, "updated");
    await user.click(screen.getByText("Save"));
    expect(onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      target.occurrence_id,
      expect.objectContaining({
        intent: "Set",
        value: { kind: "Text", value: "updated" },
      }),
    );

    fireEvent.contextMenu(row);
    await user.click(screen.getByText("Discard edit"));
    expect(onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
  });

  it("never first-selects multiple existing targets sharing one schema", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("target.jpg", target, {
      intent: "Set",
      value: { kind: "Text", value: "first" },
    });
    store.setMetadataTarget(
      "target.jpg",
      {
        ...target,
        occurrence_id: { ...target.occurrence_id, copy: 1 },
        write_target: { group1: "XMP-dc", tag_name: "Subject-2" },
      },
      { intent: "Set", value: { kind: "Text", value: "second" } },
    );
    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("details-target-drafts-ambiguous"),
    ).toBeInTheDocument();
    expect(screen.queryByText("first")).not.toBeInTheDocument();
    expect(screen.queryByText("second")).not.toBeInTheDocument();
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
    const onSetExistingOccurrenceDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={mockMetadata({ "IFD0:Make": "Canon" })}
        occurrences={[
          {
            id: {
              document: null,
              path: "JPEG-APP1-IFD0",
              tag_id: "Make",
              copy: 0,
            },
            value: { kind: "Text", value: "Canon" },
            tag_info: {
              id: testId("IFD0:Make"),
              group: "IFD0",
              name: "Make",
              writable: false,
              kind: { kind: "Text" },
              description: null,
            },
            write_target: { group1: "IFD0", tag_name: "Make" },
          },
        ]}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
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
    expect(onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
  });

  it("keeps Edit + enabled Remove for a writable existing tag", async () => {
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const onSetExistingOccurrenceDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={mockMetadata({ "IFD0:Make": "Canon" })}
        occurrences={[
          {
            id: {
              document: null,
              path: "JPEG-APP1-IFD0",
              tag_id: "Make",
              copy: 0,
            },
            value: { kind: "Text", value: "Canon" },
            tag_info: {
              id: testId("IFD0:Make"),
              group: "IFD0",
              name: "Make",
              writable: true,
              kind: { kind: "Text" },
              description: null,
            },
            write_target: { group1: "IFD0", tag_name: "Make" },
          },
        ]}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
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
    expect(onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      expect.objectContaining({ path: "JPEG-APP1-IFD0" }),
      { value: null, intent: "Delete" },
    );
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

  function occurrencesFor(
    metadata: ReturnType<typeof mockMetadata>,
  ): MetadataOccurrence[] {
    return Object.values(metadata).map((entry, index) => {
      const { id, ...value } = entry;
      const friendly = testFriendlyName(id);
      const separator = friendly.indexOf(":");
      const group = friendly.slice(0, separator);
      const name = friendly.slice(separator + 1);
      return {
        id: {
          document: null,
          path: `JPEG-APP1-GPS-${id.tag_id}`,
          tag_id: id.tag_id,
          copy: index,
        },
        value,
        tag_info: {
          id,
          group,
          name,
          writable: true,
          kind: { kind: value.kind } as any,
          description: null,
        },
        write_target: { group1: group, tag_name: name },
      };
    });
  }

  function expectZeroSouthWestEdits(
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
  ) {
    const editFor = (id: SchemaDefinitionId) =>
      edits.find(
        (entry) =>
          schemaDefinitionIdToken(entry.id) === schemaDefinitionIdToken(id),
      )?.edit;

    expect(editFor(testId("GPS:GPSLatitude"))).toMatchObject({
      intent: "Set",
      value: { kind: "Real", value: 0 },
    });
    expect(editFor(testId("GPS:GPSLatitudeRef"))).toMatchObject({
      intent: "Set",
      value: { kind: "Text", value: "S" },
    });
    expect(editFor(testId("GPS:GPSLongitude"))).toMatchObject({
      intent: "Set",
      value: { kind: "Real", value: 0 },
    });
    expect(editFor(testId("GPS:GPSLongitudeRef"))).toMatchObject({
      intent: "Set",
      value: { kind: "Text", value: "W" },
    });
  }

  it("shows both GPS edit actions while an unresolved non-GPS row stays read-only", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
      "GPS:GPSAltitude": 100,
      "GPS:GPSAltitudeRef": 0,
      "XMP-dc:Subject": "test",
    });
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        occurrences={occurrencesFor(metadata).filter(
          (occurrence) => occurrence.tag_info?.id.table === "GPS::Main",
        )}
        onRemoveMetadataFieldsV5={vi.fn()}
        onSetGpsTargetDraftBatch={vi.fn(() => true)}
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
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
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
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
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

  it("generic Edit uses semantic GPS latitude instead of the degree-formatted row", async () => {
    const metadata = mockMetadata({ "GPS:GPSLatitude": 53.983856 });
    render(
      <DetailsPane
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        occurrences={occurrencesFor(metadata)}
        onSetGpsTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));

    // The row renders as `53.983856°`; the generic editor must receive the
    // semantic Real and therefore keep the unformatted numeric value.
    expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(53.983856);
  });

  it("clicking Edit GPS... opens GpsEditor on coordinate, ref, altitude, altitude ref fields", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
      "GPS:GPSAltitude": 100,
      "GPS:GPSAltitudeRef": 0,
    });
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        occurrences={occurrencesFor(metadata)}
        onRemoveMetadataFieldsV5={vi.fn()}
        onSetGpsTargetDraftBatch={vi.fn(() => true)}
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

  it("preserves authoritative S/W references when zero GPS is opened and saved unchanged", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 0,
      "GPS:GPSLatitudeRef": "S",
      "GPS:GPSLongitude": 0,
      "GPS:GPSLongitudeRef": "W",
    });
    const onRemoveMetadataFieldsV5 = vi.fn();
    const onSetGpsTargetDraftBatch = vi.fn(
      (_edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>) =>
        true,
    );
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        occurrences={occurrencesFor(metadata)}
        onRemoveMetadataFieldsV5={onRemoveMetadataFieldsV5}
        onSetGpsTargetDraftBatch={onSetGpsTargetDraftBatch}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));

    expect(await screen.findByTestId("gps-editor-lat-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");

    fireEvent.click(screen.getByTestId("gps-editor-save"));

    expect(onRemoveMetadataFieldsV5).not.toHaveBeenCalled();
    expect(onSetGpsTargetDraftBatch).toHaveBeenCalledOnce();
    expectZeroSouthWestEdits(onSetGpsTargetDraftBatch.mock.calls[0][0]);
  });

  it("preserves staged schema-v5 S/W references when zero GPS is opened and saved unchanged", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 0,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0,
      "GPS:GPSLongitudeRef": "E",
    });
    const occurrences = occurrencesFor(metadata);
    const planned = planGpsTargetDraftBatchV5(
      [
        {
          id: testId("GPS:GPSLatitudeRef"),
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "S" },
          },
        },
        {
          id: testId("GPS:GPSLongitudeRef"),
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "W" },
          },
        },
      ],
      occurrences,
      undefined,
    );
    const targetDraftEdits: TargetDraftCollection = Object.fromEntries(
      planned.map(({ target, edit }, index) => [
        String(index),
        { target, edit },
      ]),
    );
    const onRemoveMetadataFieldsV5 = vi.fn();
    const onSetGpsTargetDraftBatch = vi.fn(
      (_edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>) =>
        true,
    );
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        metadata={metadata}
        occurrences={occurrences}
        targetDraftEdits={targetDraftEdits}
        onRemoveMetadataFieldsV5={onRemoveMetadataFieldsV5}
        onSetGpsTargetDraftBatch={onSetGpsTargetDraftBatch}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));

    expect(await screen.findByTestId("gps-editor-lat-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");

    fireEvent.click(screen.getByTestId("gps-editor-save"));

    expect(onRemoveMetadataFieldsV5).not.toHaveBeenCalled();
    expect(onSetGpsTargetDraftBatch).toHaveBeenCalledOnce();
    expectZeroSouthWestEdits(onSetGpsTargetDraftBatch.mock.calls[0][0]);
  });

  it("keeps the composite editor open and saves nothing when a captured selector changes", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
    });
    const occurrences = occurrencesFor(metadata);
    const onSetGpsTargetDraftBatch = vi.fn(() => true);
    const props = {
      onDiscardTargetDraftBatch: vi.fn(),
      photo,
      metadata,
      onRemoveMetadataFieldsV5: vi.fn(),
      onSetGpsTargetDraftBatch,
    };
    const rendered = render(
      <DetailsPane {...props} occurrences={occurrences} />,
    );
    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));
    expect(await screen.findByTestId("gps-editor-overlay")).toBeInTheDocument();

    const changed = occurrences.map((occurrence) =>
      occurrence.tag_info?.name === "GPSLongitude"
        ? {
            ...occurrence,
            write_target: {
              ...occurrence.write_target!,
              tag_name: "GPSLongitudeChanged",
            },
          }
        : occurrence,
    );
    rendered.rerender(<DetailsPane {...props} occurrences={changed} />);
    fireEvent.click(screen.getByTestId("gps-editor-save"));

    expect(onSetGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("gps-editor-overlay")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /destination changed.*nothing was saved/i,
    );
  });

  // Stateful wrapper harness to simulate real DetailsPane parent
  function DetailsPaneStateHarness({
    initialMetadata,
    photo,
  }: {
    initialMetadata: Record<string, unknown>;
    photo: PhotoInfo;
  }) {
    const [drafts, setDrafts] = useState<TargetDraftCollection>({});
    const metadata = mockMetadata(initialMetadata);
    const occurrences = occurrencesFor(metadata);

    return (
      <>
        <div data-testid="drafts-debug" style={{ display: "none" }}>
          {JSON.stringify(drafts)}
        </div>
        <DetailsPane
          photo={photo}
          metadata={metadata}
          occurrences={occurrences}
          targetDraftEdits={drafts}
          onRemoveMetadataFieldsV5={vi.fn()}
          onSetGpsTargetDraftBatch={(
            edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
          ) => {
            const planned = planGpsTargetDraftBatchV5(
              edits,
              occurrences,
              drafts,
            );
            const store = new TargetDraftEditsStore();
            if (Object.keys(drafts).length > 0) {
              store.resetMetadata({ [photo.relative_path]: drafts });
            }
            store.setMetadataBatch(
              photo.relative_path,
              planned.map(({ target, edit }) => ({ target, edit })),
            );
            setDrafts(store.getMetadataFile(photo.relative_path) ?? {});
            return true;
          }}
          onDiscardTargetPropertyDraft={(target) => {
            const store = new TargetDraftEditsStore();
            store.resetMetadata({ [photo.relative_path]: drafts });
            store.deleteTarget(photo.relative_path, target);
            setDrafts(store.getMetadataFile(photo.relative_path) ?? {});
          }}
          onDiscardTargetDraftBatch={vi.fn()}
        />
      </>
    );
  }

  it("composite GPS save, rerender and reopen workflow", async () => {
    // Seed schema cache with string enum options
    _setTagInfoCacheEntry("GPS:GPSLatitudeRef", {
      group: "GPS",
      name: "GPSLatitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "N", label: "North" },
            { code: "S", label: "South" },
          ],
        },
      },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitudeRef", {
      group: "GPS",
      name: "GPSLongitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "E", label: "East" },
            { code: "W", label: "West" },
          ],
        },
      },
      description: null,
    });

    const user = userEvent.setup();

    render(
      <DetailsPaneStateHarness
        photo={photo}
        initialMetadata={{
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLatitudeRef": "N",
          "GPS:GPSLongitude": 0.12,
          "GPS:GPSLongitudeRef": "E",
        }}
      />,
    );

    // Open "Edit GPS..."
    openContextMenu("GPSLatitude");
    await user.click(screen.getByRole("button", { name: "Edit GPS…" }));

    // Change latitude ref to S
    const latRefSelect = await screen.findByTestId("gps-editor-lat-ref");
    await user.selectOptions(latRefSelect, "S");

    // Change longitude ref to W
    const lonRefSelect = screen.getByTestId("gps-editor-lon-ref");
    await user.selectOptions(lonRefSelect, "W");

    // Save the composite editor
    await user.click(screen.getByTestId("gps-editor-save"));

    // Confirm that the dialog closed
    await waitFor(() => {
      expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
    });

    // Confirm the pending row displays use schema labels
    const rowLatRef = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("GPSLatitudeRef") !== null);
    expect(rowLatRef).toBeDefined();
    expect(within(rowLatRef!).getByText("South")).toBeInTheDocument();

    const rowLonRef = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("GPSLongitudeRef") !== null);
    expect(rowLonRef).toBeDefined();
    expect(within(rowLonRef!).getByText("West")).toBeInTheDocument();

    // Reopen "Edit GPS..." without applying drafts
    openContextMenu("GPSLatitude");
    await user.click(screen.getByRole("button", { name: "Edit GPS…" }));

    // Assert latitude select is S and longitude select is W, and not N/E
    expect(await screen.findByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");

    // Cancel the editor
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Inspect the emitted drafts and confirm
    const draftsJson = JSON.parse(
      screen.getByTestId("drafts-debug").textContent || "{}",
    );
    const draftFor = (id: SchemaDefinitionId) =>
      Object.values(draftsJson).find(
        (entry: any) =>
          schemaDefinitionIdToken(entry.target.schema_id) ===
          schemaDefinitionIdToken(id),
      ) as any;
    expect(draftFor(testId("GPS:GPSLatitudeRef"))).toMatchObject({
      target: { schema_id: testId("GPS:GPSLatitudeRef") },
      edit: {
        value: { kind: "Text", value: "S" },
        intent: "Set",
        display: "South",
      },
    });
    expect(draftFor(testId("GPS:GPSLongitudeRef"))).toMatchObject({
      target: { schema_id: testId("GPS:GPSLongitudeRef") },
      edit: {
        value: { kind: "Text", value: "W" },
        intent: "Set",
        display: "West",
      },
    });
  });

  it("individual enum edit followed by composite GPS edit", async () => {
    // Seed schema cache with string enum options for LatitudeRef
    _setTagInfoCacheEntry("GPS:GPSLatitudeRef", {
      group: "GPS",
      name: "GPSLatitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "N", label: "North" },
            { code: "S", label: "South" },
          ],
        },
      },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitudeRef", {
      group: "GPS",
      name: "GPSLongitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "E", label: "East" },
            { code: "W", label: "West" },
          ],
        },
      },
      description: null,
    });

    const user = userEvent.setup();

    render(
      <DetailsPaneStateHarness
        photo={photo}
        initialMetadata={{
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLatitudeRef": "N",
          "GPS:GPSLongitude": 0.12,
          "GPS:GPSLongitudeRef": "E",
        }}
      />,
    );

    // Open the ordinary individual "Edit..." action for GPSLatitudeRef
    const rowLatRef = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("GPSLatitudeRef") !== null);
    expect(rowLatRef).toBeDefined();
    fireEvent.contextMenu(rowLatRef!);
    await user.click(screen.getByRole("button", { name: "Edit…" }));

    // Select South
    const select = (await screen.findByTestId(
      "enum-editor-select",
    )) as HTMLSelectElement;
    await user.selectOptions(select, "S");

    // Save individual EnumEditor
    await user.click(screen.getByTestId("enum-editor-save"));

    // Confirm the dialog closed
    await waitFor(() => {
      expect(screen.queryByTestId("enum-editor-overlay")).toBeNull();
    });

    // Confirm resulting draft is semantic Text("S") and display "South"
    const draftsJson = JSON.parse(
      screen.getByTestId("drafts-debug").textContent || "{}",
    );
    const latitudeRefDraft = Object.values(draftsJson).find(
      (entry: any) =>
        schemaDefinitionIdToken(entry.target.schema_id) ===
        schemaDefinitionIdToken(testId("GPS:GPSLatitudeRef")),
    );
    expect(latitudeRefDraft).toMatchObject({
      target: { schema_id: testId("GPS:GPSLatitudeRef") },
      edit: {
        value: { kind: "Text", value: "S" },
        intent: "Set",
        display: "South",
      },
    });

    // Open "Edit GPS..." for any member of that GPS group (e.g. GPSLatitude)
    openContextMenu("GPSLatitude");
    await user.click(screen.getByRole("button", { name: "Edit GPS…" }));

    // Assert that the composite latitude-ref select opens as S
    expect(await screen.findByTestId("gps-editor-lat-ref")).toHaveValue("S");

    // Cancel the editor
    await user.click(screen.getByRole("button", { name: "Cancel" }));
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
      await import("./tagInfoTestHelpers");
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
        occurrences={mockOccurrences(
          {
            "GPS:GPSLatitude": 51.5,
            "GPS:GPSLongitude": -0.1,
            "GPS:GPSVersionID": "2.2.0.0",
          },
          ["GPS:GPSVersionID"],
        )}
        onRemoveMetadataFieldsV5={onSetBatch}
        onDiscardTargetDraftBatch={onDiscardBatch}
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
      await import("./tagInfoTestHelpers");
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
        occurrences={mockOccurrences({ "GPS:GPSVersionID": "2.2.0.0" }, [
          "GPS:GPSVersionID",
        ])}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
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

  it("Remove action stages deletes via batch", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
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
        occurrences={mockOccurrences({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLongitude": -0.1,
        })}
        onRemoveMetadataFieldsV5={onSetBatch}
        onDiscardTargetDraftBatch={vi.fn()}
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

    expect(askMock.mock.calls[0][0]).toContain(
      "2 existing fields will receive pending delete edits.",
    );
    expect(askMock.mock.calls[0][0]).not.toContain("delete edits only");

    expect(onSetBatch).toHaveBeenCalledWith([
      testId("GPS:GPSLatitude"),
      testId("GPS:GPSLongitude"),
    ]);
  });

  it("multiple exact occurrences block group Remove while retaining target Discard", async () => {
    vi.resetModules();
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");
    const id = testId("XMP-dc:Title");
    const first = mockOccurrences({ "XMP-dc:Title": "first" })[0];
    const second = structuredClone(first);
    second.id.path = "TEST-XMP-dc-duplicate";
    second.id.copy = 1;
    second.value = { kind: "Text", value: "second" };
    const targetStore = new TargetDraftEditsStore();
    targetStore.setMetadataTarget(
      "p.jpg",
      {
        kind: "ExistingOccurrence",
        occurrence_id: first.id,
        schema_id: id,
        write_target: first.write_target!,
      },
      { intent: "Set", value: { kind: "Text", value: "edited" } },
    );

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({ "XMP-dc:Title": "first" })}
        occurrences={[first, second]}
        targetDraftEdits={targetStore.getMetadataFile("p.jpg")}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    const section = screen.getByTestId("details-section-XMP::dc");
    fireEvent.contextMenu(
      within(section).getByRole("heading", { name: "XMP::dc", level: 3 }),
    );
    const remove = await screen.findByRole("button", {
      name: "Remove writable XMP::dc fields…",
    });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", expect.stringMatching(/Several/));
    expect(
      screen.getByRole("button", { name: "Discard 1 XMP::dc edit…" }),
    ).toBeInTheDocument();
  });

  it("routes staged NewProperty removal only through the v5 group callback", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");
    _clearTagInfoCache();
    const id = testId("XMP-dc:Title");
    _setTagInfoCacheEntry(id, {
      id,
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const targetStore = new TargetDraftEditsStore();
    targetStore.setMetadataTarget(
      "p.jpg",
      { kind: "NewProperty", schema_id: id },
      { intent: "Set", value: { kind: "Text", value: "new" } },
    );
    const remove = vi.fn(() => true);
    const discardTargets = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={{}}
        occurrences={[]}
        targetDraftEdits={targetStore.getMetadataFile("p.jpg")}
        onRemoveMetadataFieldsV5={remove}
        onDiscardTargetDraftBatch={discardTargets}
      />,
    );
    const section = screen.getByTestId("details-section-XMP-dc");
    fireEvent.contextMenu(
      within(section).getByRole("heading", { name: "XMP-dc", level: 3 }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove 1 writable XMP-dc field…",
      }),
    );
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(askMock.mock.calls[0][0]).toContain(
      "1 staged new-property addition will be cancelled.",
    );
    expect(askMock.mock.calls[0][0]).not.toContain("delete edits only");
    expect(remove).toHaveBeenCalledWith([id]);
    expect(discardTargets).not.toHaveBeenCalled();
  });

  it("hides group Remove for an already staged exact Delete while retaining Discard", async () => {
    vi.resetModules();
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");
    const id = testId("XMP-dc:Title");
    const occurrences = mockOccurrences({ "XMP-dc:Title": "current" });
    const exactTarget = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: occurrences[0].id,
      schema_id: id,
      write_target: occurrences[0].write_target!,
    };
    const targetStore = new TargetDraftEditsStore();
    targetStore.setMetadataTarget("p.jpg", exactTarget, {
      intent: "Delete",
      value: null,
    });

    render(
      <FreshDetailsPane
        photo={photo}
        metadata={mockMetadata({ "XMP-dc:Title": "current" })}
        occurrences={occurrences}
        targetDraftEdits={targetStore.getMetadataFile("p.jpg")}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    const section = screen.getByTestId("details-section-XMP-dc");
    fireEvent.contextMenu(
      within(section).getByRole("heading", { name: "XMP-dc", level: 3 }),
    );
    expect(
      await screen.findByRole("button", { name: "Discard 1 XMP-dc edit…" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("uses the complete group when the details search filters out some rows", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
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
        occurrences={mockOccurrences({
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLongitude": -0.1,
        })}
        onRemoveMetadataFieldsV5={onSetBatch}
        onDiscardTargetDraftBatch={vi.fn()}
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
      testId("GPS:GPSLatitude"),
      testId("GPS:GPSLongitude"),
    ]);
  });

  it("handles singular/plural labels and formatting correctly (e.g. File group)", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
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
        occurrences={mockOccurrences({ "File:FileSize": "1 MB" })}
        onRemoveMetadataFieldsV5={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
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
  });
});
